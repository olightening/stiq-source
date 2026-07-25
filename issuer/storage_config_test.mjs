/**
 * Storage / retention policy invariants (T16-S4).
 *
 * The dashboard's /api/storage route sanitizes an organizer-supplied retention policy, persists it to
 * storage.json, and signs+publishes a kind-30078 d=stiq:storage event whose COMPACT content
 * {rc,tc,ma,cr} the client parses in client/src/moderation/organizerConfig.ts currentStoragePolicy
 * (T16-S2). Two properties are load-bearing and pinned here:
 *   1. sanitizeStorage clamps out-of-range / garbage input to the safe low-storage-phone defaults, so
 *      a published event can never set a pathological cap (0 rows ⇒ always-empty feed; millions ⇒ OOM).
 *   2. signConfig('stiq:storage', …) yields a kind-30078 event with a d=stiq:storage tag whose content
 *      is exactly the {rc,tc,ma,cr} compact wire — the cross-layer contract with the client parser.
 *
 * sanitizeStorage is mirrored below (kept in lockstep with organizer-server.mjs, exactly as
 * origin_csrf_test.mjs mirrors originMatchesHost) — organizer-server.mjs can't be imported without
 * booting the whole dashboard. signConfig IS imported from organizer-nostr.mjs (the real signer).
 */
import assert from 'assert';
import {signConfig} from './organizer-nostr.mjs';

// ── Mirror of organizer-server.mjs sanitizeStorage (kept in lockstep) ────────────
const DEFAULT_STORAGE = {reactionCap: 8000, timelineCap: 3000, maxAgeDays: 0, collapseReplaceable: true};
function sanitizeStorage(p) {
  const toInt = v => (Number.isFinite(v) ? Math.floor(v) : (/^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN));
  const clamp = (v, min, max, d) => { const n = toInt(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const age = toInt(p?.maxAgeDays);
  return {
    reactionCap: clamp(p?.reactionCap, 200, 100000, DEFAULT_STORAGE.reactionCap),
    timelineCap: clamp(p?.timelineCap, 200, 100000, DEFAULT_STORAGE.timelineCap),
    maxAgeDays: Number.isFinite(age) && age >= 0 ? age : DEFAULT_STORAGE.maxAgeDays,
    collapseReplaceable: p?.collapseReplaceable !== false,
  };
}

// ── 1. absent / empty / non-object input → defaults (ship-dark) ──────────────────
{
  for (const empty of [undefined, null, {}, 'not-an-object', 42]) {
    assert.deepStrictEqual(sanitizeStorage(empty), DEFAULT_STORAGE,
      'empty/garbage input (' + JSON.stringify(empty) + ') sanitizes to the safe defaults');
  }
  console.log('ok 1 — absent/empty input falls back to the low-storage-phone defaults');
}

// ── 2. caps below the floor clamp UP to 200 ──────────────────────────────────────
{
  const s = sanitizeStorage({reactionCap: 0, timelineCap: 199, maxAgeDays: 0, collapseReplaceable: true});
  assert.strictEqual(s.reactionCap, 200, 'reactionCap 0 clamps up to the 200 floor (never an empty feed)');
  assert.strictEqual(s.timelineCap, 200, 'timelineCap 199 clamps up to the 200 floor');
  // negatives are garbage, not just below-floor
  const neg = sanitizeStorage({reactionCap: -5000, timelineCap: -1});
  assert.strictEqual(neg.reactionCap, 200, 'negative reactionCap clamps up to 200');
  assert.strictEqual(neg.timelineCap, 200, 'negative timelineCap clamps up to 200');
  console.log('ok 2 — sub-floor / negative caps clamp up to 200');
}

// ── 3. caps above the ceiling clamp DOWN to 100000 ───────────────────────────────
{
  const s = sanitizeStorage({reactionCap: 5_000_000, timelineCap: 100001, maxAgeDays: 3650, collapseReplaceable: false});
  assert.strictEqual(s.reactionCap, 100000, 'reactionCap 5M clamps down to the 100000 ceiling (no OOM)');
  assert.strictEqual(s.timelineCap, 100000, 'timelineCap 100001 clamps down to the 100000 ceiling');
  assert.strictEqual(s.maxAgeDays, 3650, 'an in-range maxAgeDays is preserved');
  assert.strictEqual(s.collapseReplaceable, false, 'collapseReplaceable:false is honored');
  console.log('ok 3 — over-ceiling caps clamp down to 100000');
}

// ── 4. maxAgeDays: >=0 integer only; garbage/negative → default 0 (off) ──────────
{
  assert.strictEqual(sanitizeStorage({maxAgeDays: -7}).maxAgeDays, 0, 'negative maxAgeDays → 0 (expiry off)');
  assert.strictEqual(sanitizeStorage({maxAgeDays: 'soon'}).maxAgeDays, 0, 'non-numeric maxAgeDays → 0');
  assert.strictEqual(sanitizeStorage({maxAgeDays: 30.9}).maxAgeDays, 30, 'fractional maxAgeDays floors to an integer');
  assert.strictEqual(sanitizeStorage({maxAgeDays: 14}).maxAgeDays, 14, 'a valid maxAgeDays is kept');
  console.log('ok 4 — maxAgeDays is a non-negative integer, garbage → 0');
}

// ── 5. numeric-string inputs (the UI posts <input> values) are accepted ──────────
{
  const s = sanitizeStorage({reactionCap: '9000', timelineCap: '2500', maxAgeDays: '5', collapseReplaceable: true});
  assert.strictEqual(s.reactionCap, 9000, 'numeric-string reactionCap is parsed');
  assert.strictEqual(s.timelineCap, 2500, 'numeric-string timelineCap is parsed');
  assert.strictEqual(s.maxAgeDays, 5, 'numeric-string maxAgeDays is parsed');
  // a non-numeric string is garbage → default
  assert.strictEqual(sanitizeStorage({reactionCap: '9000x'}).reactionCap, DEFAULT_STORAGE.reactionCap,
    'a non-numeric string falls back to the default cap');
  console.log('ok 5 — numeric-string inputs parse; non-numeric strings fall back');
}

// ── 6. collapseReplaceable defaults ON; only an explicit false turns it off ──────
{
  assert.strictEqual(sanitizeStorage({}).collapseReplaceable, true, 'absent collapseReplaceable defaults to true');
  assert.strictEqual(sanitizeStorage({collapseReplaceable: false}).collapseReplaceable, false, 'explicit false honored');
  assert.strictEqual(sanitizeStorage({collapseReplaceable: 0}).collapseReplaceable, true,
    'a non-false falsy value still defaults ON (only strict false disables)');
  console.log('ok 6 — collapseReplaceable defaults on, only explicit false disables');
}

// ── 7. signed event: kind-30078, d=stiq:storage, content == {rc,tc,ma,cr} ────────
// This pins the cross-layer wire contract with client/src/moderation/organizerConfig.ts.
{
  const s = sanitizeStorage({reactionCap: 4000, timelineCap: 1500, maxAgeDays: 21, collapseReplaceable: false});
  const wire = {rc: s.reactionCap, tc: s.timelineCap, ma: s.maxAgeDays, cr: s.collapseReplaceable};
  const event = signConfig('stiq:storage', [], JSON.stringify(wire));
  assert.strictEqual(event.kind, 30078, 'organizer config event is kind-30078 (NIP-78 app data)');
  const dTag = event.tags.find(t => t[0] === 'd');
  assert.ok(dTag && dTag[1] === 'stiq:storage', 'the addressable d-tag is exactly "stiq:storage"');
  assert.deepStrictEqual(JSON.parse(event.content), {rc: 4000, tc: 1500, ma: 21, cr: false},
    'content is the compact {rc,tc,ma,cr} wire the client parser reads');
  assert.ok(typeof event.sig === 'string' && event.sig.length === 128, 'event carries a schnorr signature');
  console.log('ok 7 — signed kind-30078 d=stiq:storage with the {rc,tc,ma,cr} compact content');
}

console.log('\nall storage-policy invariants hold.');
