/**
 * Content epoch key custody invariants (lever 1 read meter, organizer side).
 *
 * Pins: (1) volume-based rotation mints a fresh key every `rotateEvery` posts and advances the
 * write epoch; (2) unlockEpoch returns the requested K_E only for a token that verifies and hasn't
 * been spent; (3) the spent-set enforces one epoch unlock per token; (4) state round-trips through
 * the injected persistence (a restart keeps keys, counter, and spent-set). Pure — no fs, no relay.
 */
import assert from 'assert';
import {createHash} from 'crypto';
import {createContentKeyCustody, ANSWERED_UNLOCK_LIMIT} from './contentEpochKeys.mjs';

// In-memory persistence so the test never touches disk; deep-clone on save to mimic a real reload.
function memStore() {
  let saved = null;
  return {
    load: () => (saved ? JSON.parse(saved) : null),
    save: s => {
      saved = JSON.stringify(s);
    },
    raw: () => (saved ? JSON.parse(saved) : null),
  };
}

const alwaysValid = async () => true;
const neverValid = async () => false;

// ── 1. volume rotation ───────────────────────────────────────────────────────────
{
  const store = memStore();
  const c = createContentKeyCustody({rotateEvery: 3, load: store.load, save: store.save, verifyToken: alwaysValid});
  assert.strictEqual(c.currentEpoch(), 0, 'starts at epoch 0');
  const k0 = c.currentKey();
  assert.ok(k0 && Buffer.from(k0, 'base64').length === 32, 'epoch 0 key is 32 bytes');

  assert.deepStrictEqual(c.recordPost(), {epoch: 0, rotated: false});
  assert.deepStrictEqual(c.recordPost(), {epoch: 0, rotated: false});
  const r = c.recordPost(); // 3rd post → rotate
  assert.deepStrictEqual(r, {epoch: 1, rotated: true}, 'rotates after rotateEvery posts');
  assert.notStrictEqual(c.currentKey(), k0, 'a fresh key is minted on rotation');
  assert.strictEqual(c.keyFor(0), k0, 'the old epoch key is still custodied (past posts stay unlockable)');
  console.log('ok 1 — volume rotation');
}

// ── 2. unlock: valid token → K_E; wrong token → refused ────────────────────────────
{
  const store = memStore();
  const c = createContentKeyCustody({rotateEvery: 100, load: store.load, save: store.save, verifyToken: alwaysValid});
  const epoch = c.currentEpoch();
  const good = await c.unlockEpoch({token: Buffer.from('tok-A').toString('base64'), sig: Buffer.from('sig').toString('base64'), epoch});
  assert.strictEqual(good.key, c.currentKey(), 'valid token unlocks the current epoch key');
  assert.strictEqual(good.epoch, epoch);

  const unknown = await c.unlockEpoch({token: Buffer.from('tok-B').toString('base64'), sig: 'AA', epoch: 999});
  assert.ok(unknown.error && /unknown/.test(unknown.error), 'unknown epoch is refused');

  const cBad = createContentKeyCustody({rotateEvery: 100, load: memStore().load, save: () => {}, verifyToken: neverValid});
  const bad = await cBad.unlockEpoch({token: Buffer.from('x').toString('base64'), sig: 'AA', epoch: 0});
  assert.ok(bad.error && /invalid/.test(bad.error), 'a token that fails verification is refused');
  console.log('ok 2 — unlock verification');
}

// ── 3. spent-set: one SPEND per token (retries idempotently re-deliver, never double-count) ────────
// Presenting the same token again does NOT mint a second spend (spentCount stays 1) — it idempotently
// re-delivers the answer already given (test 6 below covers this path in depth; this test pins the
// underlying accounting invariant the idempotency fix must preserve).
{
  const store = memStore();
  const c = createContentKeyCustody({rotateEvery: 100, load: store.load, save: store.save, verifyToken: alwaysValid});
  const token = Buffer.from('tok-reuse').toString('base64');
  const first = await c.unlockEpoch({token, sig: 'AA', epoch: 0});
  assert.ok(first.key, 'first redemption succeeds');
  const second = await c.unlockEpoch({token, sig: 'AA', epoch: 0});
  assert.strictEqual(second.key, first.key, 'redeeming the same token again re-delivers the same key (idempotent), not an error');
  assert.strictEqual(c.spentCount(), 1, 'the retry does not count as a second spend');
  console.log('ok 3 — one unlock per token (idempotent retry never double-spends)');
}

// ── 4. persistence round-trips (restart keeps keys, counter, spent-set) ─────────────
{
  const store = memStore();
  const c1 = createContentKeyCustody({rotateEvery: 5, load: store.load, save: store.save, verifyToken: alwaysValid});
  c1.recordPost();
  c1.recordPost();
  const token = Buffer.from('tok-persist').toString('base64');
  await c1.unlockEpoch({token, sig: 'AA', epoch: 0});
  const keyBefore = c1.currentKey();

  // "Restart": a new custody instance loading the same persisted state.
  const c2 = createContentKeyCustody({rotateEvery: 5, load: store.load, save: store.save, verifyToken: alwaysValid});
  assert.strictEqual(c2.currentKey(), keyBefore, 'the current key survives a restart');
  const replay = await c2.unlockEpoch({token, sig: 'AA', epoch: 0});
  assert.ok(!replay.error, 'the spent-set (and its answered-unlock memory) survives a restart, so the retry is not an error');
  assert.strictEqual(replay.key, keyBefore, 'and re-delivers the same key that was already given out');
  // c1 recorded 2 posts (counter persisted); rotateEvery=5, so posts 3 and 4 don't rotate but the
  // 5th does — proving the counter carried across the restart boundary.
  assert.strictEqual(c2.recordPost().rotated, false, 'post 3 (across restart) does not rotate');
  assert.strictEqual(c2.recordPost().rotated, false, 'post 4 does not rotate');
  assert.strictEqual(c2.recordPost().rotated, true, 'post 5 rotates (counter persisted across restart)');
  console.log('ok 4 — persistence round-trips');
}

// ── 5. drop-on-invalid: junk unlock requests are silently dropped (#31) ─────────────
// When dropInvalid() is true, invalid/absent/malformed requests resolve with {drop:true} so the
// mailbox skips the mined+signed 9027 reply (anti-amplification). A VALID-but-refused request
// (already-spent token) is authenticated and must NOT be dropped — the member still hears why.
{
  const c = createContentKeyCustody({
    rotateEvery: 100, load: memStore().load, save: () => {},
    verifyToken: neverValid, dropInvalid: () => true,
  });
  const invalid = await c.unlockEpoch({token: Buffer.from('x').toString('base64'), sig: 'AA', epoch: 0});
  assert.strictEqual(invalid.drop, true, 'an invalid read-token is dropped when dropInvalid is on');
  const badEpoch = await c.unlockEpoch({token: Buffer.from('x').toString('base64'), sig: 'AA', epoch: 999});
  assert.strictEqual(badEpoch.drop, true, 'an unknown epoch is dropped when dropInvalid is on');
  const missing = await c.unlockEpoch({epoch: 0});
  assert.strictEqual(missing.drop, true, 'a missing read-token is dropped when dropInvalid is on');

  // dropInvalid off ⇒ never dropped (the client hears the error).
  const cKeep = createContentKeyCustody({
    rotateEvery: 100, load: memStore().load, save: () => {},
    verifyToken: neverValid, dropInvalid: () => false,
  });
  const kept = await cKeep.unlockEpoch({token: Buffer.from('x').toString('base64'), sig: 'AA', epoch: 0});
  assert.ok(kept.error && !kept.drop, 'with dropInvalid off, an invalid request still gets an error reply');

  // A retry of an already-ANSWERED spend is authenticated ⇒ never dropped, and — per the idempotency
  // fix (test 6 below) — re-delivers the same key rather than erroring. Still proves "never dropped".
  const cSpent = createContentKeyCustody({
    rotateEvery: 100, load: memStore().load, save: () => {},
    verifyToken: alwaysValid, dropInvalid: () => true,
  });
  const tok = Buffer.from('spent-tok').toString('base64');
  const spend = await cSpent.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  const reuse = await cSpent.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  assert.ok(reuse.key && !reuse.drop && !reuse.error,
    'a retry of an already-answered (authenticated) spend gets a reply, never dropped');
  assert.strictEqual(reuse.key, spend.key, 'and it is the SAME key, not an error');
  console.log('ok 5 — drop-on-invalid for junk unlock requests, reply for authenticated refusals');
}

// ── 6. idempotent unlock retries (2026-07-21 incident) ──────────────────────────────
// The mailbox spends the token in unlockEpoch BEFORE the 9027 reply is actually confirmed delivered
// (mailbox.mjs awaits the relay's OK frame afterward) — so a dropped socket / relay hiccup between
// "we spent it" and "they got it" must not strand the member on "already spent" forever. A retry
// presenting the SAME token the mailbox already answered re-delivers that SAME {key, epoch}.
{
  const store = memStore();
  const c = createContentKeyCustody({rotateEvery: 100, load: store.load, save: store.save, verifyToken: alwaysValid});
  const tok = Buffer.from('idempotent-tok').toString('base64');
  const first = await c.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  assert.ok(first.key, 'first spend succeeds');

  // "Reply lost, client retries" == the exact same request landing again on the SAME custody instance
  // (the mailbox's retry resends byte-identical token/sig/epoch).
  const retry = await c.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  assert.ok(!retry.error, 'the retry is not an error');
  assert.strictEqual(retry.key, first.key, 'the retry re-delivers the SAME key');
  assert.strictEqual(retry.epoch, first.epoch);

  // Survives a restart too — the answered-map is persisted in the same sidecar as the spent-set.
  const c2 = createContentKeyCustody({rotateEvery: 100, load: store.load, save: store.save, verifyToken: alwaysValid});
  const retryAfterRestart = await c2.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  assert.strictEqual(retryAfterRestart.key, first.key, 'the idempotent retry survives an organizer restart');

  // A token spent WITHOUT ever being answered (e.g. `spent` mutated by some other path, or an entry
  // that predates this fix) has nothing to replay, so it still hard-errors — guessing would be wrong.
  const unansweredTokenBuf = Buffer.from('spent-but-unanswered', 'utf8');
  const unansweredId = createHash('sha256').update(unansweredTokenBuf).digest('hex');
  const preSpentStore = memStore();
  preSpentStore.save({current: 0, postsInEpoch: 0, keys: {0: 'YQ=='}, spent: [unansweredId], answered: []});
  const c3 = createContentKeyCustody({rotateEvery: 100, load: preSpentStore.load, save: preSpentStore.save, verifyToken: alwaysValid});
  const stillErrors = await c3.unlockEpoch({token: unansweredTokenBuf.toString('base64'), sig: 'AA', epoch: 0});
  assert.ok(stillErrors.error && /already spent/.test(stillErrors.error),
    'a spent-but-never-answered token still errors — there is no remembered answer to replay');
  console.log('ok 6 — idempotent unlock retries re-deliver the same key; an unanswered spend still errors');
}

// ── 7. answered-unlock memory is bounded ─────────────────────────────────────────────
// Unbounded growth would make content_epochs.json grow forever over months of uptime. The bound keeps
// only the most-recently-answered ANSWERED_UNLOCK_LIMIT unlocks retryable; older ones fall back to a
// hard error on retry (spend accounting itself, the `spent` set, is untouched/still bounded elsewhere).
{
  const store = memStore();
  const c = createContentKeyCustody({rotateEvery: 100, load: store.load, save: store.save, verifyToken: alwaysValid});
  const tokens = [];
  for (let i = 0; i <= ANSWERED_UNLOCK_LIMIT; i++) {
    const tok = Buffer.from('bound-tok-' + i).toString('base64');
    tokens.push(tok);
    await c.unlockEpoch({token: tok, sig: 'AA', epoch: 0});
  }
  // One MORE than the limit was spent, so the very first (oldest) entry was pushed out.
  const oldestRetry = await c.unlockEpoch({token: tokens[0], sig: 'AA', epoch: 0});
  assert.ok(oldestRetry.error && /already spent/.test(oldestRetry.error),
    'the oldest answered-unlock entry is pruned once over the bound, so its retry hard-errors');
  const newestRetry = await c.unlockEpoch({token: tokens[tokens.length - 1], sig: 'AA', epoch: 0});
  assert.ok(newestRetry.key, 'the newest entry is still within the bound and idempotently retryable');
  console.log('ok 7 — answered-unlock memory is bounded to the most recent ' + ANSWERED_UNLOCK_LIMIT + ' entries');
}

console.log('\nall contentEpochKeys invariants passed');
