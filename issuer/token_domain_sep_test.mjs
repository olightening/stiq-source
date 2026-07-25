/**
 * Token domain-separation invariant (findings #3 / #4 / #29).
 *
 * The fix for the token-mint amplification is a DISTINCT issuer keypair per token PURPOSE, so that a
 * drawn posting token can never be replayed as a draw/membership credential (and a posting token /
 * membership credential can never satisfy the read meter). This test pins the load-bearing crypto
 * property the organizer relies on: an RFC-9474 blind signature minted under one issuer key does NOT
 * verify under a different issuer key — exactly what makes the purpose keys non-interchangeable.
 *
 * It mirrors the organizer verifier: RSA-PSS / SHA-384 / salt length 48 (the #79 salt), the same
 * `crypto.subtle.verify(...)` shape drawTokensForMember → verifyCredential and unlockEpoch use.
 */
import {RSABSSA} from '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js';
import assert from 'assert';

const suite = RSABSSA.SHA384.PSS.Deterministic();

async function mintKey() {
  return crypto.subtle.generateKey(
    {name: 'RSA-PSS', hash: 'SHA-384', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1])},
    true, ['sign', 'verify'],
  );
}

// Run the full client↔issuer blind flow: the client blinds a random 32-byte token, the issuer
// blind-signs under `signerPriv`, the client finalizes to an unblinded (token, sig) pair.
async function issue(signerPub, signerPriv) {
  const token = crypto.getRandomValues(new Uint8Array(32));
  const prepared = suite.prepare(token); // deterministic ⇒ prepared === token
  const {blindedMsg, inv} = await suite.blind(signerPub, prepared);
  const blindSig = await suite.blindSign(signerPriv, blindedMsg);
  const sig = await suite.finalize(signerPub, prepared, blindSig, inv);
  return {token: Buffer.from(prepared), sig: Buffer.from(sig)};
}

// The organizer's verifier (verifyCredential / verifyReadToken): salt length 48 ONLY (#79).
async function verify(pub, tokenBuf, sigBuf) {
  try {
    return await crypto.subtle.verify({name: 'RSA-PSS', saltLength: 48}, pub, sigBuf, tokenBuf);
  } catch { return false; }
}

const enroll = await mintKey(); // K_enroll — membership credentials
const post   = await mintKey(); // K_post   — posting tokens
const read   = await mintKey(); // K_read   — read tokens

const membership = await issue(enroll.publicKey, enroll.privateKey);
const postTok    = await issue(post.publicKey,   post.privateKey);
const readTok    = await issue(read.publicKey,   read.privateKey);

// ── 1. each token verifies under its OWN purpose key ─────────────────────────────
assert.ok(await verify(enroll.publicKey, membership.token, membership.sig), 'membership verifies under K_enroll');
assert.ok(await verify(post.publicKey,   postTok.token,    postTok.sig),    'posting token verifies under K_post');
assert.ok(await verify(read.publicKey,   readTok.token,    readTok.sig),    'read token verifies under K_read');
console.log('ok 1 — each token verifies under its own purpose key');

// ── 2. #3/#4: a drawn POSTING token is NOT a valid draw credential ───────────────
// The draw handler verifies the presented credential against K_enroll (verifyCredential). A posting
// token was signed under K_post, so it fails there — it cannot be re-fed as a credential to mint more.
assert.strictEqual(await verify(enroll.publicKey, postTok.token, postTok.sig), false,
  'a posting token must NOT verify under K_enroll (else it is a free draw credential — #3/#4)');
console.log('ok 2 — posting token cannot be replayed as a draw credential');

// ── 3. #29: read meter is independent of the posting budget ──────────────────────
// unlockEpoch verifies read tokens against K_read. A posting token (K_post) and a membership
// credential (K_enroll) must both fail there, so neither doubles as a free read token.
assert.strictEqual(await verify(read.publicKey, postTok.token,     postTok.sig),     false,
  'a posting token must NOT verify under K_read (double-spend post→unlock — #29)');
assert.strictEqual(await verify(read.publicKey, membership.token,  membership.sig),  false,
  'a membership credential must NOT verify under K_read (free read token — #29)');
console.log('ok 3 — read meter is an independent budget');

// ── 4. and the reverse: a membership credential cannot be used to POST ───────────
assert.strictEqual(await verify(post.publicKey, membership.token, membership.sig), false,
  'a membership credential must NOT verify under K_post');
console.log('ok 4 — membership credential cannot post');

console.log('\nall token domain-separation invariants hold.');
