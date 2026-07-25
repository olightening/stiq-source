/**
 * Draw idempotency + per-purpose bucketing invariants (T2.1/F9, plus the original reliability fix for
 * the epoch-token mint).
 *
 * A member's client retries a draw over Tor until a response lands, resending the SAME blinded
 * batch each time. The organizer must (a) return the identical tokens on a repeat, and (b) charge
 * the per-epoch quota exactly once — else a few dropped round-trips would silently drain a member's
 * daily allowance for zero usable tokens. Sections 1-2b pin that (kept from the pre-T2.1 test).
 *
 * F9: the organizer used to key draw accounting by (credId, epoch) ONLY, sharing one TOKENS_PER_EPOCH
 * budget across all 7 purposes — heavy feed posting could brick a member's next channel/DM draw even
 * though they never sent a space message. Sections 3+ mirror organizer-server.mjs's fix: bucket by the
 * RESOLVED SIGNING-KEY fingerprint (purposeKeyFingerprint), not the raw purpose string — the PINNED
 * GATE (Fable round-2 B4): with TOKEN_DOMAIN_SEP off (default) all 7 purposes alias the SAME issuer
 * key, so bucketing by raw purpose would 7x the mintable post-token supply; bucketing by resolved key
 * identity collapses aliased purposes onto ONE bucket automatically, with no TOKEN_DOMAIN_SEP branch
 * needed in the accounting code itself.
 */
import {RSABSSA} from '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js';
import {readFileSync, existsSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import {createHash} from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const suite = RSABSSA.SHA384.PSS.Deterministic();

// ── 1. blindSign is deterministic (the whole re-sign-on-retry premise) ──────────
// Needs the gitignored issuer_private.pem, so it only runs from a checkout that holds the keys
// (e.g. the deployed organizer). In a worktree without them, skip THIS check and still run the pure
// accounting/collision invariants below (sections 2–3), which is where the draw logic lives.
const PEM_PATH = `${__dirname}/issuer_private.pem`;
if (existsSync(PEM_PATH)) {
  const pubB64 = readFileSync(`${__dirname}/issuer_public.b64`, 'utf8').trim();
  const publicKey = await crypto.subtle.importKey(
    'spki', Buffer.from(pubB64, 'base64'), {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['verify'],
  );
  const pem = readFileSync(PEM_PATH, 'utf8')
    .replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', Buffer.from(pem, 'base64'), {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['sign'],
  );

  const token = crypto.getRandomValues(new Uint8Array(32));
  const {blindedMsg} = await suite.blind(publicKey, suite.prepare(token));
  const sigA = Buffer.from(await suite.blindSign(privateKey, blindedMsg));
  const sigB = Buffer.from(await suite.blindSign(privateKey, blindedMsg));
  assert.ok(sigA.equals(sigB), 'blindSign must be deterministic so a retry re-issues identical tokens');
  console.log('✓ blindSign is deterministic (retry re-issues identical tokens)');
} else {
  console.log('· blindSign determinism SKIPPED (no issuer_private.pem — run from a keyed checkout)');
}

// ── 2. seen-hash accounting: count once per distinct request, cap, prune ────────
// Mirror of organizer-server.mjs epState/drawTokensForMember accounting (kept in lockstep).
function epState(v) {
  if (typeof v === 'number') return {used: v, seen: []};
  return v && typeof v.used === 'number' ? {used: v.used, seen: Array.isArray(v.seen) ? v.seen : []} : {used: 0, seen: []};
}
function draw(perCred, epoch, blinded, cap) {
  const ep = String(epoch);
  // Unambiguous encoding — a delimiter join would let ['a','b'] and ['a\nb'] collide (see below).
  const reqHash = createHash('sha256').update(JSON.stringify(blinded)).digest('hex');
  const state = epState(perCred[ep]);
  const already = state.seen.includes(reqHash);
  // Mirror organizer-server.mjs: an over-quota draw reports how many tokens the credential may STILL
  // draw this epoch, so a cap-aware client re-draws the remaining allowance instead of bricking.
  if (!already && state.used + blinded.length > cap) {
    return {error: 'cap', cap: Math.max(0, cap - state.used)};
  }
  if (!already) {
    state.used += blinded.length;
    state.seen.push(reqHash);
    perCred[ep] = state;
    for (const k of Object.keys(perCred)) { if (Number(k) < epoch - 1) delete perCred[k]; }
  }
  return {used: state.used, charged: !already};
}

const CAP = 100;
const perCred = {};
const batch = Array.from({length: 20}, (_, i) => `blinded-${i}`);

const first = draw(perCred, 20637, batch, CAP);
assert.deepStrictEqual([first.used, first.charged], [20, true], 'first draw charges 20');

// Same batch again (a retry) — identical request, must NOT re-charge.
const retry = draw(perCred, 20637, batch, CAP);
assert.deepStrictEqual([retry.used, retry.charged], [20, false], 'retry of the same batch charges nothing');

// A genuinely new batch this epoch — charges again.
const batch2 = Array.from({length: 20}, (_, i) => `other-${i}`);
const second = draw(perCred, 20637, batch2, CAP);
assert.deepStrictEqual([second.used, second.charged], [40, true], 'a distinct batch charges again');

// Legacy numeric epoch state migrates in place and still de-dupes/charges correctly.
const legacy = {'20637': 90};
const overCap = draw(legacy, 20637, batch, CAP); // 90 + 20 > 100
assert.deepStrictEqual(overCap, {error: 'cap', cap: 10}, 'over-quota reports the remaining allowance (100 - 90), not a bare error');
// A cap-aware client re-draws exactly the reported allowance — which tops the credential up to the
// quota (the fix for lowering TOKENS_PER_EPOCH below the client draw batch, which used to brick draws).
const topUp = draw(legacy, 20637, batch.slice(0, overCap.cap), CAP);
assert.deepStrictEqual([topUp.used, topUp.charged], [100, true], 're-drawing the reported cap fills to the quota');

// Stale epochs prune when a newer epoch is touched.
const aged = {'20000': {used: 5, seen: ['x']}, '20637': {used: 5, seen: ['y']}};
draw(aged, 20638, batch, CAP);
assert.ok(!('20000' in aged), 'stale epoch pruned');
assert.ok('20637' in aged && '20638' in aged, 'current + previous epoch kept');
console.log('✓ draw accounting: retry once, distinct re-charges, cap enforced, stale epochs pruned');

// ── 2b. per-credential request-count cap (mailbox flood defence) ─────────────────
// Mirror of the maxDrawsPerEpoch gate in drawTokensForMember: it bounds the number of DISTINCT
// draw requests a credential may make per epoch (on top of the token quota), while a RETRY of an
// already-seen request is idempotent and never counts. Over the cap it returns cap:0 so a cap-aware
// client stops (empty draw) instead of issuing yet another request. 0 = unlimited.
function drawCapped(perCred, epoch, blinded, tokenCap, maxDraws) {
  const ep = String(epoch);
  const reqHash = createHash('sha256').update(JSON.stringify(blinded)).digest('hex');
  const state = epState(perCred[ep]);
  const already = state.seen.includes(reqHash);
  if (!already && maxDraws > 0 && state.seen.length >= maxDraws) {
    return {error: 'request-cap', cap: 0};
  }
  if (!already && state.used + blinded.length > tokenCap) {
    return {error: 'token-cap', cap: Math.max(0, tokenCap - state.used)};
  }
  if (!already) { state.used += blinded.length; state.seen.push(reqHash); perCred[ep] = state; }
  return {used: state.used, requests: state.seen.length, charged: !already};
}

const MAX_DRAWS = 2;
const rc = {};
const b1 = ['r1-a', 'r1-b'], b2 = ['r2-a', 'r2-b'], b3 = ['r3-a', 'r3-b'];
assert.strictEqual(drawCapped(rc, 20637, b1, 1000, MAX_DRAWS).charged, true, '1st distinct request allowed');
// Retrying the 1st request does NOT consume a request slot.
assert.strictEqual(drawCapped(rc, 20637, b1, 1000, MAX_DRAWS).charged, false, 'retry of request 1 is idempotent');
assert.strictEqual(drawCapped(rc, 20637, b2, 1000, MAX_DRAWS).charged, true, '2nd distinct request allowed');
// The 3rd distinct request exceeds the cap → cap:0 (client stops), and it is NOT recorded.
assert.deepStrictEqual(drawCapped(rc, 20637, b3, 1000, MAX_DRAWS), {error: 'request-cap', cap: 0}, '3rd distinct request hits the request cap with cap:0');
// A retry of an ALREADY-seen request still succeeds even at the cap (idempotent, no new work).
assert.strictEqual(drawCapped(rc, 20637, b1, 1000, MAX_DRAWS).charged, false, 'a seen request still re-issues at the cap');
// Next epoch starts fresh.
assert.strictEqual(drawCapped(rc, 20638, b3, 1000, MAX_DRAWS).charged, true, 'the cap resets each epoch');
console.log('✓ per-credential request-count cap: distinct requests bounded, retries exempt, resets per epoch');

// ── 3. no delimiter-injection collision, and base64 validation rejects the vector ──
// ['ab','cd'] and ['ab\ncd'] both join to "ab\ncd"; JSON.stringify keeps them distinct.
const hJoin = a => createHash('sha256').update(a.join('\n')).digest('hex');
const hJson = a => createHash('sha256').update(JSON.stringify(a)).digest('hex');
assert.strictEqual(hJoin(['ab', 'cd']), hJoin(['ab\ncd']), 'the OLD join hash collides (why it was unsafe)');
assert.notStrictEqual(hJson(['ab', 'cd']), hJson(['ab\ncd']), 'JSON.stringify does NOT collide');
// And the injection vector never reaches the hash: a blinded entry with a newline is rejected.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
assert.ok(!BASE64_RE.test('ab\ncd'), 'a blinded entry containing a delimiter is rejected as malformed');
assert.ok(BASE64_RE.test('YWJjZA=='), 'clean base64 is accepted');
console.log('✓ idempotency hash is collision-safe (JSON) and malformed base64 is rejected');

// ══════════════════════════════════════════════════════════════════════════════════
// T2.1/F9 — per-purpose draw-budget bucketing (mirrors organizer-server.mjs verbatim)
// ══════════════════════════════════════════════════════════════════════════════════

// The closed 7-value purpose set (Appendix A) — organizer-server.mjs's PURPOSE_ORDER/ALL_PURPOSES.
const PURPOSE_ORDER = ['post', 'read', 'picture-write', 'picture-read', 'audio-write', 'audio-read', 'space-write'];
const ALL_PURPOSES = new Set(PURPOSE_ORDER);

// Resolved-signing-key fingerprint per purpose — mirror of organizer-server.mjs's purposeKeyFingerprint
// (the PINNED GATE, Fable round-2 B4). domainSep=false collapses every purpose onto the SAME
// fingerprint, exactly like every purpose var aliasing the shared `privateKey` when TOKEN_DOMAIN_SEP is
// off; domainSep=true gives each purpose its own, like loadOrMintPurposeKey minting a distinct keypair.
function purposeKeyFingerprints(domainSep) {
  const fp = {};
  for (const p of PURPOSE_ORDER) fp[p] = domainSep ? `fp:${p}` : 'fp:shared-issuer-key';
  return fp;
}

// bucketsOf — mirror of organizer-server.mjs's migration helper: folds a pre-T2.1 record (bare number,
// or single {used,seen}) into the bucket for `postFp` (purposeKeyFingerprint.post in the real code —
// post is the fallback/anchor purpose everywhere), and passes an already-migrated {buckets:{...}}
// record through untouched.
function bucketsOf(perEpochRecord, postFp) {
  if (perEpochRecord && typeof perEpochRecord === 'object' &&
      perEpochRecord.buckets && typeof perEpochRecord.buckets === 'object') {
    return perEpochRecord.buckets;
  }
  const legacy = epState(perEpochRecord);
  if (legacy.used === 0 && legacy.seen.length === 0) return {};
  return {[postFp]: legacy};
}

// Canonical purpose for a fingerprint: the FIRST purpose in PURPOSE_ORDER resolving to it (post is
// always first). Mirror of organizer-server.mjs's purposeForFingerprint — when several purposes alias
// one fingerprint (domain-sep off) this deterministically picks ONE owner for quota-lookup, so a
// shared bucket's cap can never depend on which purpose happened to draw first at runtime.
function purposeForFingerprint(purposeFp, fp) {
  return PURPOSE_ORDER.find(p => purposeFp[p] === fp) || 'post';
}
function quotaForBucket(purposeFp, overrides, globalQuota, fp) {
  const override = overrides[purposeForFingerprint(purposeFp, fp)];
  return Number.isInteger(override) && override > 0 ? override : globalQuota;
}
function maxDrawsForBucket(purposeFp, overrides, globalMaxDraws, fp) {
  const override = overrides[purposeForFingerprint(purposeFp, fp)];
  return Number.isInteger(override) && override >= 0 ? override : globalMaxDraws;
}

// draw() — mirror of drawTokensForMember's purpose-bucketed accounting core: closed-set validate +
// fold-absent-to-post, resolve the bucket via the RESOLVED KEY fingerprint (not the raw purpose
// string), then the same per-bucket request-cap / token-cap / charge sequence as before, scoped to
// `buckets[fp]` instead of one flat per-credential-per-epoch counter.
function drawBucketed({perCred, epoch, purpose, blinded, purposeFp, quotaOverrides = {}, globalQuota,
                maxDrawsOverrides = {}, globalMaxDraws = 0}) {
  const resolvedPurpose = purpose === undefined ? 'post' : purpose;
  if (!ALL_PURPOSES.has(resolvedPurpose)) return {error: 'unknown-purpose'};
  const fp = purposeFp[resolvedPurpose];
  const quota = quotaForBucket(purposeFp, quotaOverrides, globalQuota, fp);
  const maxDraws = maxDrawsForBucket(purposeFp, maxDrawsOverrides, globalMaxDraws, fp);
  const ep = String(epoch);
  const reqHash = createHash('sha256').update(JSON.stringify(blinded)).digest('hex');
  const buckets = bucketsOf(perCred[ep], purposeFp.post);
  const state = epState(buckets[fp]);
  const already = state.seen.includes(reqHash);
  if (!already && maxDraws > 0 && state.seen.length >= maxDraws) {
    return {error: 'request-cap', cap: 0};
  }
  if (!already && state.used + blinded.length > quota) {
    return {error: 'token-cap', cap: Math.max(0, quota - state.used)};
  }
  if (!already) {
    state.used += blinded.length;
    state.seen.push(reqHash);
    buckets[fp] = state;
    perCred[ep] = {buckets};
  }
  return {used: state.used, charged: !already, fp, purpose: resolvedPurpose};
}

// ── 4. unknown purpose rejected — no bucket created, nothing charged ────────────
{
  const purposeFp = purposeKeyFingerprints(false);
  const perCred = {};
  const r = drawBucketed({perCred, epoch: 30000, purpose: 'made-up-purpose', blinded: ['x'], purposeFp, globalQuota: 100});
  assert.deepStrictEqual(r, {error: 'unknown-purpose'}, 'a purpose outside the closed 7-value set is rejected');
  assert.deepStrictEqual(perCred, {}, 'an unknown purpose must not create or charge any bucket');
  console.log('✓ unknown draw purpose rejected (no bucket touched, no token minted)');
}

// ── 5. absent purpose folds to post's bucket (today's implicit default, preserved exactly) ──
{
  const purposeFp = purposeKeyFingerprints(true);
  const perCred = {};
  const r1 = drawBucketed({perCred, epoch: 30001, purpose: undefined, blinded: ['a', 'b'], purposeFp, globalQuota: 100});
  assert.strictEqual(r1.purpose, 'post', 'an absent purpose resolves to post');
  const r2 = drawBucketed({perCred, epoch: 30001, purpose: 'post', blinded: ['c'], purposeFp, globalQuota: 100});
  assert.strictEqual(r2.used, 3, 'an absent purpose shares the SAME bucket as an explicit "post" (2 + 1 = 3)');
  console.log('✓ absent purpose folds to the post bucket exactly (not a separate/untracked bucket)');
}

// ── 6. domain-sep ON: exhausting `post` does NOT affect `space-write` (the F9 misattributed brick) ──
{
  const purposeFp = purposeKeyFingerprints(true); // each purpose has its OWN key/fingerprint
  const perCred = {};
  const CAP = 50;
  const postBatch = Array.from({length: CAP}, (_, i) => `post-${i}`);
  const r1 = drawBucketed({perCred, epoch: 30002, purpose: 'post', blinded: postBatch, purposeFp, globalQuota: CAP});
  assert.deepStrictEqual([r1.used, r1.charged], [CAP, true], 'post bucket fills to its own cap');
  const r2 = drawBucketed({perCred, epoch: 30002, purpose: 'post', blinded: ['post-extra'], purposeFp, globalQuota: CAP});
  assert.strictEqual(r2.error, 'token-cap', 'a further post draw is correctly rejected once post is exhausted');
  // A heavy feed-posting day must never brick the next channel/DM (space-write) draw — the F9 bug.
  const r3 = drawBucketed({perCred, epoch: 30002, purpose: 'space-write', blinded: ['sw-1', 'sw-2'], purposeFp, globalQuota: CAP});
  assert.deepStrictEqual([r3.used, r3.charged], [2, true],
    'space-write draws fine even though post is fully exhausted — independent buckets close the misattributed-brick bug (F9)');
  console.log('✓ domain-sep ON: exhausting post does not affect space-write (independent buckets)');
}

// ── 7. domain-sep OFF: all 7 purposes share ONE budget — no 7x multiplication (the PINNED GATE) ──
{
  const purposeFp = purposeKeyFingerprints(false); // every purpose resolves to the SAME fingerprint
  const perCred = {};
  const CAP = 100;
  let totalCharged = 0;
  let anyRejected = false;
  for (const p of PURPOSE_ORDER) {
    const batch = Array.from({length: 20}, (_, i) => `${p}-${i}`); // 7 * 20 = 140 if independent
    const r = drawBucketed({perCred, epoch: 30003, purpose: p, blinded: batch, purposeFp, globalQuota: CAP});
    if (r.charged) totalCharged += batch.length; else anyRejected = true;
  }
  assert.strictEqual(totalCharged, CAP, `domain-sep OFF must cap the AGGREGATE across all 7 purposes at ${CAP} (got ${totalCharged}) — not 7x it`);
  assert.ok(anyRejected, 'at least one purpose must have been turned away once the shared cap was hit (proves the cap was actually exercised)');
  const finalBuckets = bucketsOf(perCred['30003'], purposeFp.post);
  assert.strictEqual(Object.keys(finalBuckets).length, 1, 'exactly ONE bucket exists for all 7 purposes — no 7x multiplication');
  console.log(`✓ domain-sep OFF: all 7 purposes collapse onto ONE shared ${CAP}-token budget (charged=${totalCharged}, not 140)`);

  // Contrast: bucketing by the RAW PURPOSE STRING (the naive "fix" the PINNED GATE explicitly rejects)
  // would NOT collapse under domain-sep off, and WOULD 7x the mintable supply. This demonstrates the
  // fp-indirection above is load-bearing, not redundant.
  const perCredNaive = {};
  let totalNaive = 0;
  for (const p of PURPOSE_ORDER) {
    const batch = Array.from({length: 20}, (_, i) => `${p}-${i}`);
    const bucket = perCredNaive['30003'] || {};
    const state = epState(bucket[p]); // keyed by RAW purpose, not the resolved key fingerprint
    if (state.used + batch.length <= CAP) {
      state.used += batch.length;
      bucket[p] = state;
      perCredNaive['30003'] = bucket;
      totalNaive += batch.length;
    }
  }
  assert.strictEqual(totalNaive, 140,
    'sanity check: naive raw-purpose-string bucketing DOES mint 7x under domain-sep off — proves fingerprint-based bucketing is the load-bearing fix, not a redundant precaution');
}

// ── 8. per-bucket idempotent retry (extends section 2/2b to the bucketed shape) ──
{
  const purposeFp = purposeKeyFingerprints(true);
  const perCred = {};
  const batch = ['same-1', 'same-2'];
  const r1 = drawBucketed({perCred, epoch: 30004, purpose: 'audio-write', blinded: batch, purposeFp, globalQuota: 100});
  const r2 = drawBucketed({perCred, epoch: 30004, purpose: 'audio-write', blinded: batch, purposeFp, globalQuota: 100});
  assert.deepStrictEqual([r1.charged, r2.charged], [true, false], 'a retry within the same bucket is idempotent');
  assert.strictEqual(r2.used, 2, 'used count is unchanged by the retry');
  console.log('✓ idempotent retry dedupes correctly within a single bucket');
}

// ── 9. identical reqHash in TWO DIFFERENT buckets does NOT cross-dedupe ──────────
// A property of per-bucket `seen` arrays: even if two distinct purposes happened to submit
// byte-identical blinded content (same reqHash), each bucket tracks it independently.
{
  const purposeFp = purposeKeyFingerprints(true);
  const perCred = {};
  const batch = ['identical-content'];
  const r1 = drawBucketed({perCred, epoch: 30005, purpose: 'post', blinded: batch, purposeFp, globalQuota: 100});
  const r2 = drawBucketed({perCred, epoch: 30005, purpose: 'space-write', blinded: batch, purposeFp, globalQuota: 100});
  assert.deepStrictEqual([r1.charged, r2.charged], [true, true],
    'the SAME reqHash landing in two DIFFERENT buckets charges each independently — no cross-bucket false idempotency');
  console.log('✓ identical reqHash in two different buckets does not cross-dedupe');
}

// ── 10. migration: a pre-T2.1 record preserves its mid-epoch count ──────────────
{
  const purposeFp = purposeKeyFingerprints(false); // domain-sep off ⇒ post anchors the shared bucket
  const CAP = 100;
  // Pre-T2.1 single-bucket shape: every purpose pooled into one flat {used, seen}.
  const perCred = {'30006': {used: 80, seen: ['old-req-hash']}};
  const r = drawBucketed({perCred, epoch: 30006, purpose: 'space-write', blinded: Array(15).fill('t'), purposeFp, globalQuota: CAP});
  assert.deepStrictEqual([r.used, r.charged], [95, true], 'the historical 80 carries forward (80 + 15 = 95), not reset to 0');
  const buckets = bucketsOf(perCred['30006'], purposeFp.post);
  assert.strictEqual(Object.keys(buckets).length, 1, 'migrates into exactly one bucket');
  assert.ok(buckets[purposeFp.post].seen.includes('old-req-hash'), 'the pre-migration reqHash is preserved (still idempotent for a late retry)');

  // Confirm the migrated count is actually ENFORCED, not just carried as inert metadata.
  const perCred2 = {'30006': {used: 80, seen: []}};
  const r2 = drawBucketed({perCred: perCred2, epoch: 30006, purpose: 'post', blinded: Array(30).fill('u'), purposeFp, globalQuota: CAP});
  assert.deepStrictEqual(r2, {error: 'token-cap', cap: 20}, 'an over-cap draw against the migrated 80 reports the correct remaining 20, not a fresh 100');

  // The OLDEST legacy shape (bare number epoch, pre-dating even {used,seen}) migrates too.
  const perCred3 = {'30006': 42};
  const r3 = drawBucketed({perCred: perCred3, epoch: 30006, purpose: 'read', blinded: ['x'], purposeFp, globalQuota: CAP});
  assert.strictEqual(r3.used, 43, 'the oldest bare-number legacy shape also migrates its count forward (42 + 1 = 43)');
  console.log('✓ migration: pre-T2.1 records (both {used,seen} and bare-number) preserve mid-epoch counts, and the carried count is enforced');
}

// ── 11. per-purpose maxDrawsPerEpoch override independence ───────────────────────
{
  const purposeFp = purposeKeyFingerprints(true);
  const perCred = {};
  const maxDrawsOverrides = {post: 1, 'space-write': 5};
  const r1 = drawBucketed({perCred, epoch: 30007, purpose: 'post', blinded: ['p1'], purposeFp, globalQuota: 1000, maxDrawsOverrides, globalMaxDraws: 16});
  assert.strictEqual(r1.charged, true);
  const r2 = drawBucketed({perCred, epoch: 30007, purpose: 'post', blinded: ['p2'], purposeFp, globalQuota: 1000, maxDrawsOverrides, globalMaxDraws: 16});
  assert.deepStrictEqual(r2, {error: 'request-cap', cap: 0}, 'post is capped at its OWN override (1 distinct request)');
  for (let i = 0; i < 5; i++) {
    const r = drawBucketed({perCred, epoch: 30007, purpose: 'space-write', blinded: [`sw-${i}`], purposeFp, globalQuota: 1000, maxDrawsOverrides, globalMaxDraws: 16});
    assert.strictEqual(r.charged, true, `space-write request ${i} allowed under its own higher override`);
  }
  const rOver = drawBucketed({perCred, epoch: 30007, purpose: 'space-write', blinded: ['sw-over'], purposeFp, globalQuota: 1000, maxDrawsOverrides, globalMaxDraws: 16});
  assert.deepStrictEqual(rOver, {error: 'request-cap', cap: 0}, 'space-write hits ITS OWN override (5) — unaffected by post being capped at 1');
  console.log('✓ per-purpose maxDrawsPerEpoch overrides are independent (post capped at 1 does not cap space-write at 1)');
}

// ── 12. quota-override anchor rule: an aliased (domain-sep-off) bucket is governed by the FIRST
// purpose in canonical order (post), never by whichever purpose happens to be drawing ─────────────
{
  const purposeFp = purposeKeyFingerprints(false); // OFF: every purpose aliases one bucket
  const perCred = {};
  const quotaOverrides = {post: 10, 'space-write': 500}; // deliberately divergent overrides
  const r1 = drawBucketed({perCred, epoch: 30008, purpose: 'space-write', blinded: Array(8).fill('x'), purposeFp, quotaOverrides, globalQuota: 1000});
  assert.strictEqual(r1.charged, true);
  const r2 = drawBucketed({perCred, epoch: 30008, purpose: 'space-write', blinded: Array(5).fill('y'), purposeFp, quotaOverrides, globalQuota: 1000});
  // 8 + 5 = 13 > 10 (post's override, the anchor for the shared bucket) — rejected even though
  // space-write's OWN override (500) would allow it. This is the documented aliasing tie-break.
  assert.deepStrictEqual(r2, {error: 'token-cap', cap: 2},
    'a shared (domain-sep-off) bucket is governed by the FIRST purpose in canonical order (post), not by whichever purpose is drawing — prevents a divergent override from silently reopening the 7x hole');
  console.log('✓ a shared bucket under diverging per-purpose overrides is governed deterministically by the anchor purpose (post)');
}

console.log('\nAll draw-idempotency + per-purpose-bucketing invariants hold.');
