/**
 * Onion-key disaster-recovery export/import (B4).
 *
 * The Tor v3 onion service secret key (hs_ed25519_secret_key) IS the community's .onion identity.
 * Lose the box (disk failure, hardware loss) without a backup of this key and the community loses
 * its address: every member's saved link, every already-issued join code, and every bookmarked
 * mirror dies, and a fresh .onion must be minted and pushed out-of-band to every member. This tool
 * takes an encrypted, offline backup of just the onion identity (hs_ed25519_secret_key,
 * hs_ed25519_public_key, hostname) and restores it onto replacement hardware, so a box swap can
 * keep the SAME .onion address.
 *
 * This is DELIBERATELY a separate tool from issuer/archive.mjs (the community-archive export used
 * by restore-archive.mjs / `deploy/stiq-up.sh --restore`):
 *   - A community archive NEVER carries the onion key by design — restoring one always mints a
 *     fresh .onion, so a leaked archive doesn't also hand over the onion identity.
 *   - This tool is the exact inverse: ONLY the onion identity, nothing else — so a leaked onion-key
 *     export doesn't also hand over the issuer/organizer/community secrets.
 *   Because the two blobs protect different assets, they use a DISTINCT container magic
 *   (OKEY_MAGIC = 'STIQOKEY1' vs. archive.mjs's ARCHIVE_MAGIC = 'STIQARCH1'), and the framing/crypto
 *   here is a small, self-contained re-implementation (not an import from archive.mjs) so the two
 *   tools stay fully independent — one can never be fed into the other by mistake, and a future edit
 *   to the community-archive format can't accidentally change what this recovery tool produces.
 *   readOnionKeyArchive fails closed (bad magic / wrong passphrase / tamper), same as readArchive.
 *
 * Container layout mirrors archive.mjs exactly (self-describing, all lengths big-endian):
 *
 *   OKEY_MAGIC(9) || salt(16) || iv(12) || authTag(16) || ciphertext
 *   ciphertext = AES-256-GCM( gzip( framed-entries ), key, iv )
 *   framed-entries = concat of, per entry: uint32 labelLen | label(utf8) | uint32 dataLen | data
 *
 * Same KDF cost parameters as archive.mjs (scrypt, N=2^15 r=8 p=1, AES-256-GCM) — kept numerically
 * in sync on purpose (an offline brute-force costs the same against either blob), but NOT imported;
 * see above for why.
 *
 * Passphrase discipline matches restore-archive.mjs: read from STDIN, NEVER on argv, NEVER logged.
 * Use a DIFFERENT passphrase than any community (.stiqarch) archive — mixing them means one leaked
 * passphrase could be tried against both blobs.
 *
 * CLI:
 *   node export-onion-key.mjs --export --hs-dir <torHiddenServiceDir> --out <file>   < passphrase
 *   node export-onion-key.mjs --import --hs-dir <torHiddenServiceDir> --in <file>    < passphrase
 *
 * Node builtins only — runs on the offline, framework-free issuer/relay box.
 */
import {readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync} from 'fs';
import {join, resolve} from 'path';
import {fileURLToPath} from 'url';
import {scryptSync, randomBytes, createCipheriv, createDecipheriv} from 'crypto';
import {gzipSync, gunzipSync} from 'zlib';

export const OKEY_MAGIC = 'STIQOKEY1';
const MAGIC = Buffer.from(OKEY_MAGIC, 'utf8'); // 9 bytes — distinct from archive.mjs's ARCHIVE_MAGIC
const SALT_LEN = 16;
const IV_LEN = 12;   // 96-bit GCM nonce
const TAG_LEN = 16;  // 128-bit GCM auth tag
const KEY_LEN = 32;  // AES-256
// Same scrypt cost parameters as issuer/archive.mjs (numerically in sync, not imported — see the
// header comment for why this container is a separate, distinctly-magic'd tool).
const SCRYPT = {N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024};

// The three files that make up a Tor v3 onion service identity, in the HiddenServiceDir.
const FILES = ['hs_ed25519_secret_key', 'hs_ed25519_public_key', 'hostname'];

function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, KEY_LEN, SCRYPT);
}

function frame(entries) {
  const chunks = [];
  for (const {label, bytes} of entries) {
    const labelBuf = Buffer.from(String(label), 'utf8');
    const lh = Buffer.alloc(4); lh.writeUInt32BE(labelBuf.length, 0);
    const dh = Buffer.alloc(4); dh.writeUInt32BE(bytes.length, 0);
    chunks.push(lh, labelBuf, dh, bytes);
  }
  return Buffer.concat(chunks);
}

function unframe(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('onion-key: truncated (label length)');
    const labelLen = buf.readUInt32BE(off); off += 4;
    if (off + labelLen > buf.length) throw new Error('onion-key: truncated (label)');
    const label = buf.slice(off, off + labelLen).toString('utf8'); off += labelLen;
    if (off + 4 > buf.length) throw new Error('onion-key: truncated (data length)');
    const dataLen = buf.readUInt32BE(off); off += 4;
    if (off + dataLen > buf.length) throw new Error('onion-key: truncated (data)');
    out.push({label, bytes: buf.slice(off, off + dataLen)}); off += dataLen;
  }
  return out;
}

/** Build the encrypted onion-key container from a list of {label, bytes} entries. */
export function buildOnionKeyArchive(entries, passphrase) {
  if (!passphrase || String(passphrase).length < 1) {
    throw new Error('onion-key: passphrase required (refusing to export an unencrypted onion key)');
  }
  const plain = gzipSync(frame(entries || []));
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

/** Decrypt + unframe a container built by buildOnionKeyArchive. Fails closed. */
export function readOnionKeyArchive(buf, passphrase) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const header = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (buf.length < header) throw new Error('onion-key: too short to be a stiqokey container');
  if (!buf.slice(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('onion-key: bad magic (not a stiqokey file — is this a community .stiqarch archive instead?)');
  }
  let off = MAGIC.length;
  const salt = buf.slice(off, off += SALT_LEN);
  const iv = buf.slice(off, off += IV_LEN);
  const tag = buf.slice(off, off += TAG_LEN);
  const ct = buf.slice(off);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([decipher.update(ct), decipher.final()]); }
  catch { throw new Error('onion-key: decryption failed (wrong passphrase or tampered file)'); }
  return unframe(gunzipSync(plain));
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {mode: null, hsDir: null, out: null, in: null, help: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') out.mode = 'export';
    else if (a === '--import') out.mode = 'import';
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--hs-dir') out.hsDir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--in') out.in = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE =
  'Usage:\n' +
  '  node export-onion-key.mjs --export --hs-dir <torHiddenServiceDir> --out <file>   < passphrase\n' +
  '  node export-onion-key.mjs --import --hs-dir <torHiddenServiceDir> --in <file>    < passphrase\n' +
  '\n' +
  '  The passphrase is read from STDIN — never argv, never printed/logged. Use a DIFFERENT\n' +
  '  passphrase than any community (.stiqarch) archive.';

/** Reads the whole of stdin synchronously and returns it as a passphrase (trailing newline stripped). */
function readStdinPassphrase() {
  let buf;
  try { buf = readFileSync(0); } catch { buf = Buffer.alloc(0); } // fd 0 = stdin
  return buf.toString('utf8').replace(/\r?\n$/, '');
}

function doExport(args, passphrase) {
  if (!args.out) { console.error('--out is required for --export.\n\n' + USAGE); process.exit(2); }
  const secretPath = join(args.hsDir, 'hs_ed25519_secret_key');
  if (!existsSync(secretPath) || !statSync(secretPath).isFile()) {
    console.error(`onion-key export: no onion secret key found at ${secretPath} — nothing to export.`);
    process.exit(1);
  }
  const entries = [];
  for (const name of FILES) {
    const p = join(args.hsDir, name);
    if (existsSync(p) && statSync(p).isFile()) entries.push({label: name, bytes: readFileSync(p)});
  }
  try {
    const blob = buildOnionKeyArchive(entries, passphrase);
    writeFileSync(args.out, blob, {mode: 0o600});
    console.log(`onion-key export: OK — wrote ${entries.length} file(s) (${entries.map(e => e.label).join(', ')}) to ${args.out}`);
    process.exit(0);
  } catch (e) {
    console.error(`onion-key export: FAILED — ${e.message}`);
    process.exit(1);
  }
}

function doImport(args, passphrase) {
  if (!args.in) { console.error('--in is required for --import.\n\n' + USAGE); process.exit(2); }
  if (!existsSync(args.in)) { console.error(`onion-key import: archive not found: ${args.in}`); process.exit(2); }
  try {
    const buf = readFileSync(args.in);
    const entries = readOnionKeyArchive(buf, passphrase);
    mkdirSync(args.hsDir, {recursive: true});
    const restored = [];
    for (const {label, bytes} of entries) {
      if (!FILES.includes(label)) continue; // ignore anything unexpected — defense in depth
      const target = join(args.hsDir, label);
      writeFileSync(target, bytes);
      if (label === 'hs_ed25519_secret_key') {
        try { chmodSync(target, 0o600); } catch { /* best-effort on non-POSIX */ }
      }
      restored.push(label);
    }
    console.log(`onion-key import: OK — restored ${restored.length} file(s) (${restored.join(', ')}) into ${args.hsDir}`);
    process.exit(0);
  } catch (e) {
    // e.message never contains the passphrase or key bytes.
    console.error(`onion-key import: FAILED — ${e.message}`);
    process.exit(1);
  }
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message + '\n\n' + USAGE); process.exit(2); }

  if (args.help || !args.mode) { console.log(USAGE); process.exit(args.help ? 0 : 2); }
  if (!args.hsDir) { console.error('--hs-dir is required.\n\n' + USAGE); process.exit(2); }

  const passphrase = readStdinPassphrase();
  if (!passphrase) {
    console.error('onion-key: empty passphrase read from stdin — refusing.');
    process.exit(2);
  }

  if (args.mode === 'export') doExport(args, passphrase);
  else doImport(args, passphrase);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
