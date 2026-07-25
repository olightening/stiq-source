/**
 * Draw concurrency invariant (finding #15 — TOCTOU race in drawTokensForMember), extended for T2.1/F9
 * per-purpose bucketing.
 *
 * The draw critical section is: loadDraws() (reads the WHOLE draws.json) → bucketsOf (per-purpose
 * bucket, T2.1) → check the per-bucket quota → blind-sign (an await) → saveDraws() (overwrites the
 * WHOLE draws.json). The mailbox runs handlers concurrently (maxConcurrent), so the section must be
 * serialized. A PER-CREDENTIAL (or, post-T2.1, per-BUCKET) lock is NOT enough: because the file is
 * read and rewritten whole, two concurrent draws touching different credentials — or different
 * buckets of the SAME credential — each load a snapshot and both write it back, and the earlier
 * committer's record is silently clobbered.
 *
 * This test exercises the REAL whole-file load/save path against a scratch draws.json (not an in-place
 * store[credId].used++), so the cross-credential / cross-bucket lost update actually reproduces. It pins:
 *   1. WITHOUT a lock, two DIFFERENT credentials racing lose an update (a record vanishes / resets).
 *   2. WITHOUT a lock, two SAME-credential draws over-mint past the cap.
 *   3. WITH the global lock, two different credentials BOTH persist their full record — no lost update.
 *   4. WITH the global lock, the per-epoch quota holds for same-credential concurrency (charged once).
 *   5. WITH the global lock, a repeated request (same reqHash) is charged exactly once (idempotent).
 *   6. WITH the global lock, concurrent draws for the SAME credential but DIFFERENT purpose buckets
 *      (T2.1) both persist side by side — no lost update ACROSS buckets either.
 *   7. WITHOUT a lock, that same cross-bucket race loses an update — the bucket refactor moves the
 *      whole-record-overwrite hazard one level deeper, it does not remove it, so the global lock is
 *      still mandatory after T2.1.
 *   8. WITH the global lock, concurrent draws that all resolve to the SAME fingerprint (domain-sep
 *      off — the PINNED GATE) still enforce ONE shared cap — no 7x/Nx multiplication under a race.
 */
import assert from 'assert';
import {readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

const CAP = 20;
const EP = '0'; // one fixed epoch bucket for the whole test

// ── The REAL persistence path (byte-for-byte mirror of organizer-server.mjs loadDraws/saveDraws) ──
// loadDraws reads the ENTIRE file; saveDraws rewrites the ENTIRE file. That whole-file rewrite is
// exactly what makes a per-credId (or per-bucket) lock insufficient and a cross-credential/cross-bucket
// draw lose updates.
const DRAWS_PATH = join(mkdtempSync(join(tmpdir(), 'stiq-draws-')), 'draws.json');
function loadDraws() {
  try { return existsSync(DRAWS_PATH) ? JSON.parse(readFileSync(DRAWS_PATH, 'utf8')) : {}; }
  catch { return {}; }
}
function saveDraws(d) { try { writeFileSync(DRAWS_PATH, JSON.stringify(d, null, 2) + '\n'); } catch {} }
function resetDraws() { try { rmSync(DRAWS_PATH); } catch { /* absent */ } }

// epState mirror (tolerates the legacy numeric shape, like organizer-server.mjs).
function epState(v) {
  if (typeof v === 'number') return {used: v, seen: []};
  return v && typeof v.used === 'number' ? {used: v.used, seen: Array.isArray(v.seen) ? v.seen : []} : {used: 0, seen: []};
}

// bucketsOf mirror (T2.1/F9): per-epoch state is now {buckets: {<fp>: {used, seen}}}, keyed by the
// resolved signing-key fingerprint rather than the raw purpose string (the PINNED GATE — see
// draw_idempotency_test.mjs for the full rationale). A pre-T2.1 flat {used,seen} (or bare-number)
// record migrates into the bucket for `postFp` on first read.
function bucketsOf(perEpochRecord, postFp) {
  if (perEpochRecord && typeof perEpochRecord === 'object' &&
      perEpochRecord.buckets && typeof perEpochRecord.buckets === 'object') {
    return perEpochRecord.buckets;
  }
  const legacy = epState(perEpochRecord);
  if (legacy.used === 0 && legacy.seen.length === 0) return {};
  return {[postFp]: legacy};
}
// Stand-in fingerprints for these tests — POST_FP doubles as the migration anchor.
const POST_FP = 'fp:post';
const SPACE_WRITE_FP = 'fp:space-write';
const SHARED_FP = 'fp:shared-issuer-key'; // what EVERY purpose resolves to when domain-sep is off

// The GLOBAL draw mutex — the exact shape now used in organizer-server.mjs (withDrawLock). Still
// global post-T2.1: loadDraws/saveDraws round-trip the whole file regardless of how many
// credentials/buckets it holds, so ANY two concurrent draws anywhere in it must serialize.
function makeGlobalLock() {
  let chain = Promise.resolve();
  return function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}

// The draw critical section against the real file, with an await between the whole-file load and the
// whole-file save to model the blind-sign round-trip that opens the race window. This is the core of
// drawTokensForMember post-T2.1: load → bucketsOf → per-bucket quota-check → (sign) → mutate → save.
async function drawCore(credId, fp, reqHash, n) {
  const draws = loadDraws();
  const perCred = draws[credId] || {};
  const buckets = bucketsOf(perCred[EP], POST_FP);
  const state = epState(buckets[fp]);
  const already = state.seen.includes(reqHash);
  if (!already && state.used + n > CAP) {
    return {error: 'cap', cap: Math.max(0, CAP - state.used), charged: false};
  }
  await new Promise(r => setTimeout(r, 20)); // ← blind-sign await: the race window
  if (!already) {
    state.used += n;
    state.seen.push(reqHash);
    buckets[fp] = state;
    perCred[EP] = {buckets}; // ← whole-record overwrite (buckets nested one level deeper post-T2.1)
    draws[credId] = perCred;
    saveDraws(draws); // ← whole-file overwrite
  }
  return {used: state.used, charged: !already};
}

function used(credId, fp) {
  const v = loadDraws()[credId];
  if (!v) return 0;
  return epState(bucketsOf(v[EP], POST_FP)[fp]).used;
}
function bucketCount(credId) {
  const v = loadDraws()[credId];
  return v ? Object.keys(bucketsOf(v[EP], POST_FP)).length : 0;
}

// ── 1. WITHOUT the lock, concurrent DIFFERENT-credential draws LOSE an update (the cross-cred bug) ──
{
  resetDraws();
  const draw = (credId, reqHash, n) => drawCore(credId, POST_FP, reqHash, n); // no lock
  await Promise.all([
    draw('credA', 'reqA', CAP),
    draw('credB', 'reqB', CAP),
  ]);
  const persisted = Object.keys(loadDraws());
  // Both loaded {} before either wrote, then each rewrote the whole file with only its own record →
  // the second writer's snapshot (lacking the first's record) wins, so ONE credential's draw is lost.
  assert.ok(persisted.length < 2,
    'unsynchronized cross-credential draws lose a record via whole-file overwrite (demonstrates #15)');
  console.log('ok 1 — unsynchronized cross-cred draws lose an update (persisted ' +
    JSON.stringify(persisted) + ', expected 2 records)');
}

// ── 2. WITHOUT the lock, concurrent SAME-credential draws over-mint past the cap ─────────────────
// With the whole-file path the over-mint hides in the persisted `used` (last-write-wins records only
// CAP), but each racing handler independently passed the quota check and SIGNED a full CAP batch, so
// the member actually receives charged×CAP tokens — well past the epoch quota.
{
  resetDraws();
  const draw = (credId, reqHash, n) => drawCore(credId, POST_FP, reqHash, n); // no lock
  // 4 DISTINCT batches of the full cap, fired concurrently for one credential.
  const results = await Promise.all([0, 1, 2, 3].map(i => draw('cred', 'req-' + i, CAP)));
  const charged = results.filter(r => r.charged).length;
  const tokensSigned = charged * CAP;
  assert.ok(charged > 1 && tokensSigned > CAP,
    'unsynchronized same-credential draws sign more than the cap (demonstrates #15), signed=' + tokensSigned);
  console.log('ok 2 — unsynchronized same-cred draws over-mint (batches charged=' + charged +
    ' → ' + tokensSigned + ' tokens signed > cap=' + CAP + ', persisted used=' + used('cred', POST_FP) + ')');
}

// ── 3. WITH the global lock, two DIFFERENT credentials BOTH persist — no lost update ─────────────
{
  resetDraws();
  const withLock = makeGlobalLock();
  const draw = (credId, reqHash, n) => withLock(() => drawCore(credId, POST_FP, reqHash, n));
  await Promise.all([
    draw('credA', 'reqA', CAP),
    draw('credB', 'reqB', CAP),
  ]);
  const persisted = loadDraws();
  assert.strictEqual(Object.keys(persisted).length, 2, 'both credentials persist under the global lock');
  assert.strictEqual(used('credA', POST_FP), CAP, 'credA keeps its full drawn quota');
  assert.strictEqual(used('credB', POST_FP), CAP, 'credB keeps its full drawn quota');
  console.log('ok 3 — global lock preserves BOTH cross-cred records (credA=' + used('credA', POST_FP) +
    ', credB=' + used('credB', POST_FP) + ')');
}

// ── 4. WITH the global lock, the per-epoch quota holds under same-credential concurrency ─────────
{
  resetDraws();
  const withLock = makeGlobalLock();
  const draw = (credId, reqHash, n) => withLock(() => drawCore(credId, POST_FP, reqHash, n));
  const results = await Promise.all([0, 1, 2, 3].map(i => draw('cred', 'req-' + i, CAP)));
  assert.strictEqual(used('cred', POST_FP), CAP, 'serialized draws never exceed the cap');
  const charged = results.filter(r => r.charged).length;
  assert.strictEqual(charged, 1, 'exactly one full-cap batch is charged; the rest hit the cap');
  console.log('ok 4 — global lock holds the quota (used=' + used('cred', POST_FP) + ', charged=' + charged + ')');
}

// ── 5. WITH the global lock, a repeated request (same reqHash) is still charged once ─────────────
{
  resetDraws();
  const withLock = makeGlobalLock();
  const draw = (credId, reqHash, n) => withLock(() => drawCore(credId, POST_FP, reqHash, n));
  const results = await Promise.all([
    draw('cred', 'same', 5),
    draw('cred', 'same', 5),
    draw('cred', 'same', 5),
  ]);
  assert.strictEqual(used('cred', POST_FP), 5, 'a repeated request charges the quota exactly once');
  assert.strictEqual(results.filter(r => r.charged).length, 1, 'only the first of the identical requests is charged');
  console.log('ok 5 — idempotent retry charges once under the lock');
}

// ── 6. WITH the global lock, concurrent draws for the SAME credential but DIFFERENT purpose
// buckets (T2.1) both persist — no lost update ACROSS buckets either ───────────────────────────
{
  resetDraws();
  const withLock = makeGlobalLock();
  const draw = (fp, reqHash, n) => withLock(() => drawCore('cred', fp, reqHash, n));
  await Promise.all([
    draw(POST_FP, 'reqPost', CAP),
    draw(SPACE_WRITE_FP, 'reqSpace', CAP),
  ]);
  assert.strictEqual(used('cred', POST_FP), CAP, 'post bucket keeps its full draw');
  assert.strictEqual(used('cred', SPACE_WRITE_FP), CAP,
    'space-write bucket keeps its full draw — unaffected by post drawing concurrently (F9 fix holds under a race too)');
  assert.strictEqual(bucketCount('cred'), 2, 'both buckets persist side by side — no lost update across buckets');
  console.log('ok 6 — global lock preserves BOTH buckets for one credential (post=' + used('cred', POST_FP) +
    ', space-write=' + used('cred', SPACE_WRITE_FP) + ')');
}

// ── 7. WITHOUT the lock, that SAME cross-bucket race loses an update — proves the T2.1 bucket
// refactor didn't remove the whole-record-overwrite hazard, just moved it one level deeper ───────
{
  resetDraws();
  const draw = (fp, reqHash, n) => drawCore('cred', fp, reqHash, n); // no lock
  await Promise.all([
    draw(POST_FP, 'reqPost', CAP),
    draw(SPACE_WRITE_FP, 'reqSpace', CAP),
  ]);
  assert.ok(bucketCount('cred') < 2,
    'unsynchronized cross-BUCKET draws (same credential) lose a bucket via whole-record overwrite — the global lock is still required after T2.1, a per-bucket lock would NOT have been enough');
  console.log('ok 7 — unsynchronized cross-bucket draws lose an update (bucket count=' + bucketCount('cred') + ', expected 2)');
}

// ── 8. WITH the global lock, draws that all resolve to the SAME fingerprint (domain-sep off — the
// PINNED GATE) still enforce ONE shared cap under concurrency — no multiplication even under a race ──
{
  resetDraws();
  const withLock = makeGlobalLock();
  const draw = (reqHash, n) => withLock(() => drawCore('cred', SHARED_FP, reqHash, n));
  // Simulate several DIFFERENT purposes racing concurrently, all resolving to the one shared fp.
  const results = await Promise.all([0, 1, 2, 3].map(i => draw('req-' + i, CAP)));
  assert.strictEqual(used('cred', SHARED_FP), CAP, 'the shared bucket never exceeds the cap under concurrent same-fingerprint draws');
  assert.strictEqual(results.filter(r => r.charged).length, 1, 'exactly one batch is charged — no Nx multiplication even under a concurrency race');
  console.log('ok 8 — domain-sep-off aliasing holds ONE shared cap under concurrency (used=' + used('cred', SHARED_FP) + ')');
}

resetDraws();
console.log('\nall draw-concurrency invariants hold (including the T2.1 per-purpose-bucket cases).');
