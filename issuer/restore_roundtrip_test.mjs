/**
 * Community-archive export -> restore round-trip (T16-S6).
 *
 * Pins the restore side of the disaster-recovery path (issuer/restore-archive.mjs), the inverse of the
 * T16-S5 export (issuer/archive.mjs):
 *   1. Build a fake "box" (issuer keys + sidecars + purpose keys + relay config + membership + a badger
 *      DataDir tree), collectArtifactPaths -> buildArchive, then restoreArchive into a SEPARATE fresh
 *      layout, and assert EVERY artifact is reproduced byte-for-byte (labels + bytes) — a re-collect of
 *      the restored box yields the identical set.
 *   2. Secret files (*_private.pem, community_key.b64, organizer_nostr.json, relay config + membership)
 *      are restored 0600 (POSIX only — chmod is a no-op on win32, so the mode check is skipped there).
 *   3. A wrong passphrase aborts with NO partial writes (fails closed before touching disk).
 *   4. Restore refuses to clobber a non-empty target unless force=true.
 *
 * Plain-node assertions, matching the existing *_test.mjs style. Run: from issuer/, `node restore_roundtrip_test.mjs`.
 */
import assert from 'assert';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {collectArtifactPaths, buildArchive} from './archive.mjs';
import {restoreArchive} from './restore-archive.mjs';

const POSIX = process.platform !== 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'stiq-restore-test-'));

// Recursively read every file under a dir into a Map<relpath('/'-joined), Buffer>.
function readTree(root) {
  const out = new Map();
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out.set(rel, readFileSync(full));
    }
  };
  if (existsSync(root)) walk(root, '');
  return out;
}

try {
  const PASS = 'operator-passphrase-correct-horse';

  // ── Build a fake box: issuer artifacts + relay config + membership + badger DataDir ───────────────
  const srcIssuer = join(scratch, 'src', 'issuer');
  const srcRelay = join(scratch, 'src', 'relay');   // holds config.json + membership.json
  const srcData = join(scratch, 'src', 'badger');   // relay DataDir
  mkdirSync(srcIssuer, {recursive: true});
  mkdirSync(srcRelay, {recursive: true});
  mkdirSync(join(srcData, 'sub'), {recursive: true});

  // Issuer keys + identity (secret + public), a purpose keypair, and a spread of config sidecars.
  writeFileSync(join(srcIssuer, 'issuer_private.pem'), '-----BEGIN PRIVATE KEY-----\nMOCKISSUER\n-----END PRIVATE KEY-----\n');
  writeFileSync(join(srcIssuer, 'issuer_public.b64'), 'aXNzdWVyLXB1YmxpYw==\n');
  writeFileSync(join(srcIssuer, 'community_key.b64'), 'Y29tbXVuaXR5LWtleS1ieXRlcw==\n');
  writeFileSync(join(srcIssuer, 'organizer_nostr.json'), JSON.stringify({sk: 'deadbeef'.repeat(8), npub: 'npub1mock'}));
  writeFileSync(join(srcIssuer, 'post_token_key_private.pem'), '-----BEGIN PRIVATE KEY-----\nPOSTKEY\n-----END PRIVATE KEY-----\n');
  writeFileSync(join(srcIssuer, 'post_token_key_public.b64'), 'cG9zdC10b2tlbi1wdWJsaWM=\n');
  writeFileSync(join(srcIssuer, 'limits.json'), JSON.stringify({posts: {daily: 20}}));
  writeFileSync(join(srcIssuer, 'storage.json'), JSON.stringify({rc: 5000, tc: 200}));
  writeFileSync(join(srcIssuer, 'invites.json'), JSON.stringify({minted: 3, spent: ['a', 'b']}));
  writeFileSync(join(srcIssuer, 'draws.json'), JSON.stringify({seen: ['x', 'y', 'z']}));
  // A binary sidecar with the full byte range to prove byte-exactness through gzip+GCM.
  const binary = Buffer.from(Array.from({length: 256}, (_, i) => i));
  writeFileSync(join(srcIssuer, 'moderators.json'), binary);

  // Relay config + membership (double-spend state) next to it.
  const srcRelayConfig = join(srcRelay, 'config.json');
  writeFileSync(srcRelayConfig, JSON.stringify({data_dir: '/var/lib/stiq-relay', port: 3334}));
  writeFileSync(join(srcRelay, 'membership.json'), JSON.stringify({spent: ['tok1', 'tok2'], bound: {npub1: 'x'}}));

  // Badger DataDir tree (recursively captured by the export walk).
  writeFileSync(join(srcData, '000001.vlog'), Buffer.alloc(1024, 0xAB));
  writeFileSync(join(srcData, 'MANIFEST'), 'badger-manifest');
  writeFileSync(join(srcData, 'KEYREGISTRY'), Buffer.from([0, 255, 128, 64, 32]));
  writeFileSync(join(srcData, 'sub', '000002.sst'), Buffer.alloc(512, 0x5A));

  // ── Export ────────────────────────────────────────────────────────────────────────────────────
  const entries = collectArtifactPaths(srcIssuer, srcRelayConfig, srcData);
  const blob = await buildArchive(entries, PASS);

  // ── 3. Wrong passphrase aborts with NO partial writes ──────────────────────────────────────────
  {
    const badIssuer = join(scratch, 'wrongpass', 'issuer');
    const badRelayConfig = join(scratch, 'wrongpass', 'relay', 'config.json');
    const badData = join(scratch, 'wrongpass', 'badger');
    await assert.rejects(
      () => restoreArchive(blob, 'the-WRONG-passphrase', {issuerDir: badIssuer, relayConfigPath: badRelayConfig, relayDataDir: badData}),
      /decryption failed|wrong passphrase|tampered/i,
      'a wrong passphrase aborts',
    );
    // Fail-closed: nothing was written (readArchive throws before any mkdir/write).
    assert.ok(!existsSync(badIssuer), 'no issuer files written on a failed decrypt');
    assert.ok(!existsSync(badData), 'no DataDir written on a failed decrypt');
    console.log('ok 3 — wrong passphrase aborts with no partial writes of secrets');
  }

  // ── 1. Restore into a fresh layout; assert every artifact byte-identical ────────────────────────
  const dstIssuer = join(scratch, 'dst', 'issuer');
  const dstRelay = join(scratch, 'dst', 'relay');
  const dstRelayConfig = join(dstRelay, 'config.json');
  const dstData = join(scratch, 'dst', 'badger');

  const {restored} = await restoreArchive(blob, PASS, {
    issuerDir: dstIssuer, relayConfigPath: dstRelayConfig, relayDataDir: dstData,
  });
  assert.strictEqual(restored.length, entries.length, 'restored the same number of artifacts that were collected');

  // Re-collect the restored box and compare label->bytes maps against the source, byte-for-byte.
  const srcMap = new Map(entries.map(e => [e.label, readFileSync(e.path)]));
  const dstEntries = collectArtifactPaths(dstIssuer, dstRelayConfig, dstData);
  const dstMap = new Map(dstEntries.map(e => [e.label, readFileSync(e.path)]));

  assert.deepStrictEqual([...dstMap.keys()].sort(), [...srcMap.keys()].sort(),
    're-collecting the restored box yields the identical label set');
  for (const [label, srcBytes] of srcMap) {
    const dstBytes = dstMap.get(label);
    assert.ok(dstBytes && Buffer.compare(srcBytes, dstBytes) === 0, `artifact ${label} restored byte-for-byte`);
  }
  // Spot-check the trickiest artifacts explicitly.
  assert.ok(Buffer.compare(readFileSync(join(dstIssuer, 'moderators.json')), binary) === 0, 'full-byte-range binary sidecar intact');
  assert.ok(existsSync(join(dstRelay, 'membership.json')), 'membership.json landed next to the relay config');
  assert.ok(existsSync(join(dstData, 'sub', '000002.sst')), 'nested badger DataDir file restored');
  console.log('ok 1 — export -> restore reproduces every artifact byte-for-byte (' + restored.length + ' entries)');

  // ── 2. Secret files restored 0600 (POSIX only) ─────────────────────────────────────────────────
  {
    const secrets = [
      join(dstIssuer, 'issuer_private.pem'),
      join(dstIssuer, 'post_token_key_private.pem'),
      join(dstIssuer, 'community_key.b64'),
      join(dstIssuer, 'organizer_nostr.json'),
      dstRelayConfig,
      join(dstRelay, 'membership.json'),
    ];
    if (POSIX) {
      for (const p of secrets) {
        const mode = statSync(p).mode & 0o777;
        assert.strictEqual(mode, 0o600, `secret ${p} restored with mode 0600 (got ${mode.toString(8)})`);
      }
      // A non-secret sidecar keeps default perms (not force-locked to 0600).
      const pub = statSync(join(dstIssuer, 'issuer_public.b64')).mode & 0o777;
      assert.notStrictEqual(pub, 0o600, 'public artifact is NOT force-narrowed to 0600');
      console.log('ok 2 — secret files restored 0600, public artifacts left readable');
    } else {
      // win32: chmod is a no-op; assert the files at least exist (mode is not enforceable here).
      for (const p of secrets) assert.ok(existsSync(p), `secret ${p} restored (mode check skipped on win32)`);
      console.log('ok 2 — secret files restored (mode check skipped on non-POSIX platform)');
    }
  }

  // ── 4. Refuse to clobber a non-empty target unless force ────────────────────────────────────────
  {
    // dstIssuer is now populated. A second restore into the SAME layout must refuse without force.
    await assert.rejects(
      () => restoreArchive(blob, PASS, {issuerDir: dstIssuer, relayConfigPath: dstRelayConfig, relayDataDir: dstData}),
      /refusing to clobber|already exist/i,
      'restore refuses to overwrite a non-empty target without force',
    );
    // With force, it succeeds (adopting a partially-provisioned box on purpose).
    const forced = await restoreArchive(blob, PASS, {issuerDir: dstIssuer, relayConfigPath: dstRelayConfig, relayDataDir: dstData, force: true});
    assert.strictEqual(forced.restored.length, entries.length, 'force overwrite restores the full set');
    console.log('ok 4 — refuses to clobber a live box without force; --force overwrites');
  }

  console.log('\nall restore round-trip invariants hold.');
} finally {
  try { rmSync(scratch, {recursive: true, force: true}); } catch { /* best-effort cleanup */ }
}
