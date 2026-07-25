/**
 * Encrypted community-archive invariants (T16-S5).
 *
 * Pins the security-critical properties of issuer/archive.mjs:
 *   1. buildArchive → readArchive round-trips every entry byte-for-byte with the correct passphrase.
 *   2. A wrong passphrase throws (scrypt-derived key mismatch ⇒ GCM auth failure) — never returns garbage.
 *   3. A single flipped ciphertext byte throws (GCM tamper detection) — the archive fails closed.
 *   4. buildArchive refuses to run without a passphrase (no unencrypted archive of these secrets).
 *   5. The container starts with ARCHIVE_MAGIC and a non-magic buffer is rejected.
 *   6. collectArtifactPaths returns only existing files and includes storage.json + relay config +
 *      membership.json when present, skipping absent paths.
 *
 * Plain-node assertions, matching the existing *_test.mjs style. Run: from issuer/, `node archive_test.mjs`.
 */
import assert from 'assert';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {ARCHIVE_MAGIC, buildArchive, readArchive, collectArtifactPaths} from './archive.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'stiq-archive-test-'));

try {
  // ── 1. round-trip byte-for-byte ────────────────────────────────────────────────
  {
    const entries = [
      {label: 'issuer_private.pem', bytes: Buffer.from('-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n')},
      {label: 'community_key.b64', bytes: Buffer.from('c29tZS1jb21tdW5pdHkta2V5\n')},
      {label: 'binary', bytes: Buffer.from([0, 1, 2, 253, 254, 255, 0, 42])},
      {label: 'relay/data/000001.vlog', bytes: Buffer.alloc(4096, 7)},
    ];
    const pass = 'correct horse battery staple';
    const blob = await buildArchive(entries, pass);
    const back = await readArchive(blob, pass);
    assert.strictEqual(back.length, entries.length, 'same number of entries survive the round-trip');
    for (let i = 0; i < entries.length; i++) {
      assert.strictEqual(back[i].label, entries[i].label, 'label[' + i + '] preserved');
      assert.ok(Buffer.compare(back[i].bytes, entries[i].bytes) === 0, 'bytes[' + i + '] (' + entries[i].label + ') preserved byte-for-byte');
    }
    console.log('ok 1 — buildArchive → readArchive round-trips every entry byte-for-byte');
  }

  // ── 2. wrong passphrase throws ─────────────────────────────────────────────────
  {
    const blob = await buildArchive([{label: 'x', bytes: Buffer.from('secret')}], 'the-right-passphrase');
    await assert.rejects(() => readArchive(blob, 'the-WRONG-passphrase'), /decryption failed/, 'a wrong passphrase throws (no silent garbage)');
    console.log('ok 2 — a wrong passphrase throws (GCM auth failure)');
  }

  // ── 3. a flipped ciphertext byte throws ────────────────────────────────────────
  {
    const pass = 'tamper-evidence-please';
    const blob = await buildArchive([{label: 'x', bytes: Buffer.from('the payload bytes here')}], pass);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01; // flip the last ciphertext byte
    await assert.rejects(() => readArchive(tampered, pass), /decryption failed/, 'a single flipped byte throws');
    // flipping a byte inside the salt/iv also fails closed (derives a different key / nonce)
    const t2 = Buffer.from(blob);
    t2[ARCHIVE_MAGIC.length] ^= 0x01; // first salt byte
    await assert.rejects(() => readArchive(t2, pass), /decryption failed/, 'a flipped salt byte fails closed too');
    console.log('ok 3 — any tampering (ciphertext or salt) fails closed');
  }

  // ── 4. buildArchive refuses no passphrase ──────────────────────────────────────
  {
    await assert.rejects(() => buildArchive([{label: 'x', bytes: Buffer.from('y')}], ''), /passphrase required/, 'empty passphrase is refused');
    await assert.rejects(() => buildArchive([{label: 'x', bytes: Buffer.from('y')}], undefined), /passphrase required/, 'missing passphrase is refused');
    console.log('ok 4 — buildArchive refuses to produce an unencrypted archive');
  }

  // ── 5. magic prefix + bad-magic rejection ──────────────────────────────────────
  {
    const blob = await buildArchive([{label: 'x', bytes: Buffer.from('y')}], 'passphrase-here');
    assert.strictEqual(blob.slice(0, ARCHIVE_MAGIC.length).toString('utf8'), ARCHIVE_MAGIC, 'container starts with ARCHIVE_MAGIC');
    await assert.rejects(() => readArchive(Buffer.from('NOTASTIQARCHIVEATALLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), 'p'), /bad magic|too short/, 'a non-magic buffer is rejected');
    console.log('ok 5 — container is magic-prefixed and bad magic is rejected');
  }

  // ── 6. collectArtifactPaths: only existing files, includes storage/relay/membership ──
  {
    const issuerDir = join(scratch, 'issuer');
    mkdirSync(issuerDir, {recursive: true});
    // present artifacts
    writeFileSync(join(issuerDir, 'issuer_private.pem'), 'k');
    writeFileSync(join(issuerDir, 'community_key.b64'), 'k');
    writeFileSync(join(issuerDir, 'organizer_nostr.json'), '{}');
    writeFileSync(join(issuerDir, 'storage.json'), '{}');
    writeFileSync(join(issuerDir, 'invites.json'), '{}');
    // NOTE: bridges.json, ranking.json, the purpose keys, etc. are intentionally ABSENT here.

    const relayDir = join(scratch, 'relay');
    mkdirSync(relayDir, {recursive: true});
    const relayConfigPath = join(relayDir, 'config.json');
    writeFileSync(relayConfigPath, '{"data_dir":"/x"}');
    writeFileSync(join(relayDir, 'membership.json'), '{"spent":[]}'); // sits next to the relay config

    const dataDir = join(scratch, 'badger');
    mkdirSync(join(dataDir, 'sub'), {recursive: true});
    writeFileSync(join(dataDir, '000001.vlog'), 'vlog');
    writeFileSync(join(dataDir, 'sub', 'MANIFEST'), 'manifest');

    const entries = collectArtifactPaths(issuerDir, relayConfigPath, dataDir);
    const labels = entries.map(e => e.label);

    // every returned path must exist as a file
    for (const e of entries) {
      const {existsSync, statSync} = await import('fs');
      assert.ok(existsSync(e.path) && statSync(e.path).isFile(), 'returned path exists as a file: ' + e.label);
    }
    // present artifacts are included
    for (const want of ['issuer_private.pem', 'community_key.b64', 'organizer_nostr.json', 'storage.json',
                        'invites.json', 'relay/config.json', 'relay/membership.json']) {
      assert.ok(labels.includes(want), 'collectArtifactPaths includes ' + want);
    }
    // the recursive badger walk captured both files
    assert.ok(labels.includes('relay/data/000001.vlog'), 'DataDir vlog captured');
    assert.ok(labels.includes('relay/data/sub/MANIFEST'), 'DataDir nested file captured');
    // absent artifacts are skipped (never fabricated)
    for (const absent of ['bridges.json', 'ranking.json', 'post_token_key_private.pem', 'draws.json']) {
      assert.ok(!labels.includes(absent), 'absent artifact ' + absent + ' is skipped, not fabricated');
    }
    // and the whole set encrypts + decrypts through the real container
    const blob = await buildArchive(entries, 'end-to-end-passphrase');
    const back = await readArchive(blob, 'end-to-end-passphrase');
    assert.strictEqual(back.length, entries.length, 'collected artifacts round-trip through the encrypted container');
    console.log('ok 6 — collectArtifactPaths returns only existing files (storage + relay config + membership + DataDir)');
  }

  console.log('\nall community-archive invariants hold.');
} finally {
  try { rmSync(scratch, {recursive: true, force: true}); } catch { /* best-effort cleanup */ }
}
