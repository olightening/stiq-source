/**
 * Restore an encrypted community archive onto FRESH infrastructure (T16-S6).
 *
 * This is the inverse of the T16-S5 export (issuer/archive.mjs). It takes an encrypted `.stiqarch`
 * container plus the operator passphrase, decrypts + integrity-checks it via readArchive (AES-256-GCM,
 * scrypt KDF — fails closed on a wrong passphrase or a single flipped byte), and writes every entry
 * back to its target on a brand-new box:
 *
 *   - issuer artifacts (issuer_private.pem, issuer_public.b64, community_key.b64, organizer_nostr.json,
 *     the token-domain-separation purpose keys, and every config sidecar incl. invites.json / draws.json)
 *     → <issuerDir>/<name>
 *   - relay config           (label `relay/config.json`)      → <relayConfigPath>
 *   - relay membership state  (label `relay/membership.json`)  → <dirname(relayConfigPath)>/membership.json
 *   - relay badger DataDir     (labels `relay/data/<rel>`)      → <relayDataDir>/<rel>
 *
 * The label→target mapping is the EXACT inverse of collectArtifactPaths, so an export→restore round-trip
 * reproduces every artifact byte-for-byte and a subsequent re-export would collect the identical set.
 *
 * Fail-closed + do-no-harm:
 *   - readArchive throws BEFORE any write on a bad magic / wrong passphrase / tamper, so a failed decrypt
 *     never leaves partial secrets on disk (the whole container is decrypted into memory first).
 *   - Refuses to overwrite a non-empty existing target unless `--force`, so pointing this at a LIVE box by
 *     accident aborts instead of clobbering its keys/state. The clobber check runs across ALL targets
 *     up front, so a conflict aborts before any file is written.
 *   - Path-traversal guarded: a crafted label can never escape <issuerDir> / <relayDataDir>.
 *   - Secret files (`*_private.pem`, community_key.b64, organizer_nostr.json, relay config + membership)
 *     are written 0600. On non-POSIX platforms chmod is a best-effort no-op.
 *   - The passphrase is read from $STIQ_ARCHIVE_PASS and NEVER printed or logged; neither is any secret.
 *
 * CLI:
 *   STIQ_ARCHIVE_PASS='<operator passphrase>' \
 *     node restore-archive.mjs <archive.stiqarch> \
 *       --dir <issuerDir> --relay-config <path> --relay-data <dir> [--force]
 *
 *   --dir           issuer/ directory to restore into (default: this script's own directory)
 *   --relay-config  path to write the relay config.json (required only if the archive carries relay config)
 *   --relay-data    relay badger DataDir to restore into (required only if the archive carries DataDir files)
 *   --force         overwrite non-empty existing targets (adopt a partially-provisioned box)
 *
 * deploy/stiq-up.sh --restore wiring (handled by the deploy agent, documented here for reference):
 * with a `RESTORE_ARCHIVE=<path>` tunable set, the installer runs — BEFORE minting fresh keys / merging
 * config — as the stiq user, with stiq.target STOPPED:
 *
 *   STIQ_ARCHIVE_PASS=... node ${PREFIX}/issuer/restore-archive.mjs "$RESTORE_ARCHIVE" \
 *     --dir ${PREFIX}/issuer --relay-config /etc/stiq-relay/config.json --relay-data $DATA_DIR --force
 *
 * so the box adopts the archived issuer/organizer/community keys + relay state instead of generating new
 * ones. If the archive lacks an onion secret the installer falls back to generating one (the .onion
 * address changes — reissue join codes); after restore, start stiq.target and run
 * `node issuer/publish-config.mjs` once so the fresh relay re-ingests roster/limits/storage.
 *
 * Node builtins only (crypto/zlib/fs/path via archive.mjs) — runs on the offline, framework-free box.
 */
import {writeFileSync, mkdirSync, existsSync, statSync, chmodSync} from 'fs';
import {join, dirname, resolve, sep, basename} from 'path';
import {fileURLToPath} from 'url';
import {readArchive} from './archive.mjs';

const RELAY_CONFIG_LABEL = 'relay/config.json';
const RELAY_MEMBERSHIP_LABEL = 'relay/membership.json';
const RELAY_DATA_PREFIX = 'relay/data/';

/** A file is written 0600 when it holds (or sits with) community secrets. */
function isSecretLabel(label) {
  return label.endsWith('_private.pem') ||
         label === 'community_key.b64' ||
         label === 'organizer_nostr.json' ||
         label === RELAY_CONFIG_LABEL ||
         label === RELAY_MEMBERSHIP_LABEL;
}

/** Assert that `target` resolves inside `baseDir` (defense-in-depth against a crafted archive label). */
function assertWithin(baseDir, target, label) {
  const b = resolve(baseDir);
  const t = resolve(target);
  if (t !== b && !t.startsWith(b + sep)) {
    throw new Error(`restore: entry ${JSON.stringify(label)} escapes ${baseDir} — refusing (possible tampered archive)`);
  }
}

/**
 * Map an archive label back to its on-disk target — the exact inverse of collectArtifactPaths.
 * Throws if a relay entry is present but the corresponding target root was not supplied, or if a
 * non-relay (issuer) label is not a plain filename (path-traversal guard).
 *
 * @param {string} label
 * @param {{issuerDir:string, relayConfigPath?:string, relayDataDir?:string}} targets
 * @returns {string} absolute-or-relative target path
 */
export function targetPathForLabel(label, targets) {
  const {issuerDir, relayConfigPath, relayDataDir} = targets;

  if (label === RELAY_CONFIG_LABEL) {
    if (!relayConfigPath) throw new Error(`restore: archive carries ${RELAY_CONFIG_LABEL} but no --relay-config target was given`);
    return relayConfigPath;
  }
  if (label === RELAY_MEMBERSHIP_LABEL) {
    if (!relayConfigPath) throw new Error(`restore: archive carries ${RELAY_MEMBERSHIP_LABEL} but no --relay-config target was given`);
    return join(dirname(relayConfigPath), 'membership.json');
  }
  if (label.startsWith(RELAY_DATA_PREFIX)) {
    if (!relayDataDir) throw new Error(`restore: archive carries relay DataDir files but no --relay-data target was given`);
    const rel = label.slice(RELAY_DATA_PREFIX.length);
    const parts = rel.split('/');
    if (parts.some(p => p === '' || p === '.' || p === '..')) {
      throw new Error(`restore: unsafe DataDir entry ${JSON.stringify(label)} — refusing`);
    }
    const target = join(relayDataDir, ...parts);
    assertWithin(relayDataDir, target, label);
    return target;
  }

  // Issuer artifact: collectArtifactPaths only ever emits bare filenames here.
  if (!issuerDir) throw new Error(`restore: no --dir (issuer directory) target was given`);
  if (label !== basename(label) || label === '' || label === '.' || label === '..' || label.includes('\\')) {
    throw new Error(`restore: unexpected issuer entry ${JSON.stringify(label)} — refusing (possible tampered archive)`);
  }
  const target = join(issuerDir, label);
  assertWithin(issuerDir, target, label);
  return target;
}

/**
 * Decrypt an archive and write every entry to its target on fresh infrastructure.
 *
 * @param {Buffer} buf         the encrypted .stiqarch container
 * @param {string} passphrase  operator passphrase (never logged)
 * @param {{issuerDir:string, relayConfigPath?:string, relayDataDir?:string, force?:boolean}} targets
 * @returns {Promise<{restored: string[]}>} labels restored, in archive order
 */
export async function restoreArchive(buf, passphrase, targets) {
  if (!targets || !targets.issuerDir) throw new Error('restore: targets.issuerDir is required');
  const force = !!targets.force;

  // 1. Decrypt + integrity-check FIRST. Fails closed (throws) on bad magic / wrong passphrase / tamper,
  //    before a single byte is written — so a bad decrypt never leaves partial secrets on disk.
  const entries = await readArchive(buf, passphrase);

  // 2. Resolve every target up front (also validates traversal + that relay targets were supplied).
  const plan = entries.map(e => ({label: e.label, bytes: e.bytes, target: targetPathForLabel(e.label, targets)}));

  // 3. Clobber guard: refuse to overwrite any non-empty existing target unless --force. Checked across
  //    ALL targets before writing, so a live-box collision aborts before any write happens.
  if (!force) {
    const conflicts = [];
    for (const {label, target} of plan) {
      try {
        if (existsSync(target) && statSync(target).isFile() && statSync(target).size > 0) conflicts.push({label, target});
      } catch { /* unreadable target — treat as absent, the write below will surface real errors */ }
    }
    if (conflicts.length) {
      const list = conflicts.map(c => `  - ${c.label} -> ${c.target}`).join('\n');
      throw new Error(`restore: ${conflicts.length} target(s) already exist and are non-empty; refusing to clobber a live box (pass --force to override):\n${list}`);
    }
  }

  // 4. Write. mkdir -p the parent, write the bytes, tighten mode on secrets.
  const restored = [];
  for (const {label, bytes, target} of plan) {
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, bytes);
    if (isSecretLabel(label)) {
      try { chmodSync(target, 0o600); } catch { /* best-effort on non-POSIX */ }
    }
    restored.push(label);
  }
  return {restored};
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {archive: null, dir: null, relayConfig: null, relayData: null, force: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--relay-config') out.relayConfig = argv[++i];
    else if (a === '--relay-data') out.relayData = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else if (out.archive == null) out.archive = a;
    else throw new Error(`unexpected extra argument: ${a}`);
  }
  return out;
}

const USAGE =
  'Usage: STIQ_ARCHIVE_PASS=<passphrase> node restore-archive.mjs <archive.stiqarch> \\\n' +
  '         --dir <issuerDir> [--relay-config <path>] [--relay-data <dir>] [--force]\n' +
  '\n' +
  '  Restores an encrypted community archive onto fresh infrastructure. The passphrase is read\n' +
  '  from $STIQ_ARCHIVE_PASS (never passed on argv, never printed). --force overwrites non-empty\n' +
  '  existing targets. Exits non-zero on a wrong passphrase / tampered archive.';

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message + '\n\n' + USAGE); process.exit(2); }

  if (args.help || !args.archive) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  const passphrase = process.env.STIQ_ARCHIVE_PASS;
  if (!passphrase) {
    console.error('restore: set STIQ_ARCHIVE_PASS in the environment (the passphrase is never passed on argv).');
    process.exit(2);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const issuerDir = args.dir || __dirname;

  if (!existsSync(args.archive)) {
    console.error(`restore: archive not found: ${args.archive}`);
    process.exit(2);
  }
  const {readFileSync} = await import('fs');
  const buf = readFileSync(args.archive);

  try {
    const {restored} = await restoreArchive(buf, passphrase, {
      issuerDir,
      relayConfigPath: args.relayConfig || undefined,
      relayDataDir: args.relayData || undefined,
      force: args.force,
    });
    // Summary only — labels are safe to print (file names, never secret contents).
    const relayCount = restored.filter(l => l.startsWith('relay/')).length;
    const issuerCount = restored.length - relayCount;
    console.log(`restore: OK — ${restored.length} artifact(s) restored (${issuerCount} issuer, ${relayCount} relay).`);
    for (const l of restored) console.log(`  restored ${l}`);
    process.exit(0);
  } catch (e) {
    // e.message never contains the passphrase or secret bytes (archive.mjs is careful too).
    console.error(`restore: FAILED — ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
