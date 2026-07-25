/**
 * Content-epoch announcement activation gate (2026-07-22 incident): the organizer must stop
 * announcing a real content epoch while content encryption is inactive, because an OLD field client
 * (pre-dating the client-side relay-flag gate) has NO signal other than this doc that encryption is
 * off — it will keep provisioning + sealing under whatever epoch is announced. Pins:
 *
 *   1. active=true  → the doc is BYTE-IDENTICAL to before this fix: {epoch:<int>, rotateEvery:<int>},
 *      no `active` key — turning encryption back on must not perturb an already-compliant client.
 *   2. active=false → a DEACTIVATION body: {epoch:null, rotateEvery:<int>, active:false}.
 *   3. The deactivation body is safe against client/src/blind/contentKey.ts's real parser predicate
 *      (mirrored here verbatim — see the cited lines): `epoch` must be a non-negative integer or the
 *      whole doc is treated as "no epoch". `null` fails that check, `undefined` (a missing field)
 *      fails it too — proving either omitting `epoch` or nulling it would have worked equally safely,
 *      which is why `null` was chosen: it's the explicit, self-documenting form of "no current epoch".
 *   4. The active body's `epoch`/`rotateEvery` still pass the same predicate (unchanged behavior).
 *
 * Pure — no fs, no relay, no organizer identity/keys.
 */
import assert from 'assert';
import {buildContentEpochDoc, createContentKeyCustody} from './contentEpochKeys.mjs';

let failures = 0;
function check(label, cond) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failures += 1;
}

// Verbatim mirror of client/src/blind/contentKey.ts's parseContentEpochDoc (lines 50-59): returns
// {epoch} only for a non-negative integer `epoch`, else null. Kept in lockstep with that file — if it
// changes, this must be re-checked against the real source.
function parseContentEpochDocMirror(content) {
  try {
    const raw = JSON.parse(content);
    const epoch = raw?.epoch;
    if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) return {epoch};
  } catch { /* malformed → ignore, leave state untouched */ }
  return null;
}

// ── 1. active=true is byte-identical to the pre-fix shape ──────────────────────────
{
  const doc = buildContentEpochDoc(true, 3, 500);
  assert.deepStrictEqual(doc, {epoch: 3, rotateEvery: 500});
  check('active doc is exactly {epoch, rotateEvery} — no active key, no shape drift', true);
}

// ── 2. active=false is a deactivation body ──────────────────────────────────────────
{
  const doc = buildContentEpochDoc(false, 3, 500);
  assert.deepStrictEqual(doc, {epoch: null, rotateEvery: 500, active: false});
  check('inactive doc announces epoch:null + active:false (never the real integer)', true);
}

// ── 3. the deactivation body parses as "no epoch" under the REAL client predicate ──
{
  const doc = buildContentEpochDoc(false, 7, 500);
  const parsed = parseContentEpochDocMirror(JSON.stringify(doc));
  check('a client parses the deactivation doc as null (no epoch), never epoch 7', parsed === null);
}

// ── 4. an omitted epoch field would have parsed identically (documents the choice) ──
{
  const parsed = parseContentEpochDocMirror(JSON.stringify({rotateEvery: 500, active: false}));
  check('an omitted epoch field ALSO parses as null (epoch:null is a stylistic choice, not required)', parsed === null);
}

// ── 5. the active body still parses to the real epoch (unchanged behavior) ─────────
{
  const doc = buildContentEpochDoc(true, 12, 500);
  const parsed = parseContentEpochDocMirror(JSON.stringify(doc));
  assert.deepStrictEqual(parsed, {epoch: 12});
  check('active doc still parses to the announced epoch', true);
}

// ── 6. epoch 0 (the common real case — a fresh community) round-trips correctly ────
{
  const doc = buildContentEpochDoc(true, 0, 500);
  const parsed = parseContentEpochDocMirror(JSON.stringify(doc));
  assert.deepStrictEqual(parsed, {epoch: 0}, 'epoch 0 is a valid announced epoch, not falsy-confused with "none"');
  check('epoch 0 (falsy but valid) is announced/parsed correctly, not confused with deactivation', true);
}

// ── 7. the UNLOCK responder stays fully alive regardless of activation state ───────
// organizer-server.mjs wires `unlockEpoch: contentCustody.unlockEpoch` into the mailbox unconditionally
// (never gated on READ_AUTH) — this pins that unlockEpoch itself has no activation-state coupling at
// all: a member spending a valid read token for an OLD epoch (e.g. epoch 0, the epoch 11 posts sealed
// under before this incident) must keep succeeding — and idempotently retry-succeed — even while the
// organizer is announcing the deactivation doc for NEW writes.
{
  const memStore = () => { let s = null; return {load: () => s, save: v => { s = JSON.parse(JSON.stringify(v)); }}; };
  const store = memStore();
  const custody = createContentKeyCustody({
    rotateEvery: 500, load: store.load, save: store.save, verifyToken: async () => true,
  });
  // The organizer is announcing the deactivation doc (content encryption OFF) for this epoch...
  const announcement = buildContentEpochDoc(false, custody.currentEpoch(), 500);
  assert.strictEqual(announcement.epoch, null, 'sanity: the organizer is indeed announcing "no epoch"');

  // ...but a member unlocking epoch 0 to read one of the already-sealed posts must still succeed.
  const token = Buffer.from('field-member-tok').toString('base64');
  const first = await custody.unlockEpoch({token, sig: 'AA', epoch: 0});
  assert.ok(first.key, 'unlock succeeds for an old epoch even while the organizer announces deactivation');
  check('unlockEpoch succeeds while content encryption is deactivated (reads stay serviceable)', !!first.key);

  // ...and a lost-reply retry (the ae7b076 idempotency fix) still re-delivers, unaffected by activation.
  const retry = await custody.unlockEpoch({token, sig: 'AA', epoch: 0});
  check('a retry of that same spend idempotently re-delivers regardless of activation state',
    retry.key === first.key && !retry.error);
}

console.log(failures === 0
  ? '\nall content-epoch activation-gate invariants hold'
  : `\n${failures} content-epoch activation-gate test(s) FAILED`);
if (failures > 0) process.exit(1);
