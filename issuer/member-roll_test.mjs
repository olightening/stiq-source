/**
 * Member-roll builder invariants (ban-evasion fix, 2026-07-29).
 *
 * Pins the properties clients depend on for the stiq:member-roll doc:
 *   1. parseBoundSet unions the `bound` array with `bound_at` keys (mirrors the relay MemStore's
 *      loadFrom: a timestamped pubkey is bound even if absent from the legacy slice), sorted+deduped.
 *   2. Non-64-hex entries are dropped, never published.
 *   3. Malformed JSON / non-object / EMPTY result throw — an empty or unparseable roll must never
 *      be published (publishing an empty roll would hide every member's posts fleet-wide).
 *   4. rollFingerprint is order-insensitive on input, changes when membership changes.
 *   5. buildRollPayload emits exactly {v:1, members, updated_at} (wire contract with the client's
 *      currentMemberRoll parser).
 *   6. encryptRoll produces NIP-44 v2 ciphertext under the RAW 32-byte community key — decryptable
 *      by the client's decryptForSpace (same primitive), rejected under a different key, and
 *      refused outright for a malformed key.
 *
 * Plain-node assertions, matching the existing *_test.mjs style. Run: from issuer/, `node member-roll_test.mjs`.
 */
import assert from 'assert';
import {mkdtempSync, writeFileSync, rmSync} from 'fs';
import {join, dirname} from 'path';
import {tmpdir} from 'os';
import {fileURLToPath, pathToFileURL} from 'url';
import {parseBoundSet, readBoundSet, rollFingerprint, buildRollPayload, encryptRoll} from './member-roll.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nip44 = (await import(pathToFileURL(join(__dirname, '../client/node_modules/nostr-tools/lib/esm/nip44.js')).href)).v2;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

// ── 1+2. union, sort, dedupe, drop junk ───────────────────────────────────────────
{
  const members = parseBoundSet(JSON.stringify({
    bound: [B, A, B, 'not-hex', 'ff'],
    bound_at: {[C]: 1721000000, [A]: 1721000001},
  }));
  assert.deepStrictEqual(members, [A, B, C], 'union of bound[] + bound_at keys, sorted, deduped, junk dropped');
}
{
  // map-form tolerance: {"bound": {"<pk>": true}} parses too (defensive against a future shape).
  const members = parseBoundSet(JSON.stringify({bound: {[B]: true, [A]: true}}));
  assert.deepStrictEqual(members, [A, B], 'map-form bound parses');
}

// ── 3. fail-closed on malformed / empty ───────────────────────────────────────────
assert.throws(() => parseBoundSet('{nope'), /member-roll/i, 'malformed JSON throws');
assert.throws(() => parseBoundSet('[]'), /member-roll/i, 'non-object throws');
assert.throws(() => parseBoundSet(JSON.stringify({bound: ['junk']})), /empty/i, 'all-junk (empty result) throws');
assert.throws(() => parseBoundSet(JSON.stringify({bound: []})), /empty/i, 'empty bound set throws');
{
  const scratch = mkdtempSync(join(tmpdir(), 'stiq-member-roll-test-'));
  try {
    assert.throws(() => readBoundSet(join(scratch, 'missing.json')), /member-roll/i, 'missing file throws');
    const p = join(scratch, 'membership.json');
    writeFileSync(p, JSON.stringify({bound: [A], bound_at: {[A]: 1}}));
    assert.deepStrictEqual(readBoundSet(p), [A], 'readBoundSet reads + parses');
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

// ── 4. fingerprint semantics ──────────────────────────────────────────────────────
assert.strictEqual(rollFingerprint([A, B]), rollFingerprint([A, B]), 'stable');
assert.notStrictEqual(rollFingerprint([A, B]), rollFingerprint([A, B, C]), 'changes with membership');
assert.strictEqual(rollFingerprint([B, A]), rollFingerprint([A, B]), 'order-insensitive');

// ── 5. payload wire contract ──────────────────────────────────────────────────────
{
  const payload = JSON.parse(buildRollPayload([A, B], 1721999999));
  assert.deepStrictEqual(payload, {v: 1, members: [A, B], updated_at: 1721999999}, 'exact payload shape');
}

// ── 6. encryption: round-trips under the community key, fails under another ───────
{
  const key = Buffer.alloc(32, 7);
  const wrong = Buffer.alloc(32, 9);
  const payload = buildRollPayload([A], 1721999999);
  const ciphertext = encryptRoll(payload, key.toString('base64'), nip44);
  assert.notStrictEqual(ciphertext, payload, 'ciphertext, not plaintext');
  assert.strictEqual(nip44.decrypt(ciphertext, new Uint8Array(key)), payload, 'decrypts under the community key');
  assert.throws(() => nip44.decrypt(ciphertext, new Uint8Array(wrong)), /./, 'wrong key rejected');
  assert.throws(() => encryptRoll(payload, Buffer.alloc(16, 1).toString('base64'), nip44), /32/, 'malformed key refused');
}

console.log('member-roll_test: all assertions passed');
