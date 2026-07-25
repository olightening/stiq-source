/**
 * Censorable-reads reader-auth invariant (#4).
 *
 * To let the organizer stop a SPECIFIC member from reading (while posting stays blind + uncensorable),
 * a read-token draw under read-auth enforcement carries a member-signed reader-auth event, and the
 * organizer refuses the draw when that npub is read-revoked. The load-bearing crypto property is that
 * `verifyReaderAuth` returns the signer's REAL pubkey and cannot be forged for someone else's npub —
 * otherwise a revoked member could dodge revocation by claiming a non-revoked npub. This pins that.
 *
 * (The revocation set itself is plain hex-pubkey membership; the HTTP /api/read-access round-trip is
 * covered separately. This test targets the identification crypto the gate stands on.)
 */
import {pathToFileURL} from 'url';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import assert from 'assert';
import {verifyReaderAuth} from './organizer-nostr.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nt = await import(pathToFileURL(join(__dirname, '../client/node_modules/nostr-tools/lib/esm/index.js')).href);
const {finalizeEvent, generateSecretKey, getPublicKey} = nt;

const KIND_READ_AUTH = 9028;

const memberSk = generateSecretKey();
const memberPk = getPublicKey(memberSk);
const otherSk = generateSecretKey();
const otherPk = getPublicKey(otherSk);

const auth = finalizeEvent(
  {kind: KIND_READ_AUTH, created_at: Math.floor(Date.now() / 1000), tags: [['epoch', '20000']], content: ''},
  memberSk,
);

// ── 1. a correctly-signed reader-auth yields the signer's pubkey ─────────────────
assert.strictEqual(verifyReaderAuth(auth, KIND_READ_AUTH), memberPk, 'valid reader-auth returns the signer pubkey');
console.log('ok 1 — a valid reader-auth identifies the reader by their real pubkey');

// ── 2. epoch binding (optional) is enforced when requested ───────────────────────
assert.strictEqual(verifyReaderAuth(auth, KIND_READ_AUTH, 20000), memberPk, 'matching epoch passes');
assert.strictEqual(verifyReaderAuth(auth, KIND_READ_AUTH, 20001), null, 'mismatched epoch is rejected');
console.log('ok 2 — epoch binding is enforced when the organizer requests it');

// ── 3. wrong kind is rejected (a stray signed event can't pose as a reader-auth) ──
const wrongKind = finalizeEvent({kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'hi'}, memberSk);
assert.strictEqual(verifyReaderAuth(wrongKind, KIND_READ_AUTH), null, 'wrong kind is rejected');
console.log('ok 3 — an event of the wrong kind is not accepted as reader-auth');

// ── 4. IMPERSONATION is impossible: a member cannot forge a reader-auth for another npub ──
// finalizeEvent binds pubkey = getPublicKey(sk) and verifyEvent checks the schnorr sig, so re-labeling
// the pubkey to a non-revoked member's key invalidates the signature → null. This is what makes
// revocation-by-npub sound: you can only ever authenticate as yourself.
// JSON-clone to drop nostr-tools' cached "verified" symbol, so verifyEvent actually re-checks — this
// is what an attacker's hand-built event looks like (no memo to piggyback on).
const forged = {...JSON.parse(JSON.stringify(auth)), pubkey: otherPk};
assert.strictEqual(verifyReaderAuth(forged, KIND_READ_AUTH), null, 'a re-labeled pubkey fails verification');
assert.notStrictEqual(memberPk, otherPk, 'sanity: the two keys differ');
console.log('ok 4 — a member cannot forge a reader-auth for someone else (no revocation dodge)');

// ── 5. malformed inputs never throw, just return null ────────────────────────────
for (const bad of [null, undefined, {}, {kind: KIND_READ_AUTH}, {kind: KIND_READ_AUTH, pubkey: 'zz', sig: 'x'}]) {
  assert.strictEqual(verifyReaderAuth(bad, KIND_READ_AUTH), null);
}
console.log('ok 5 — malformed reader-auth inputs are rejected without throwing');

console.log('\nall reader-auth (censorable-reads) invariants hold.');
