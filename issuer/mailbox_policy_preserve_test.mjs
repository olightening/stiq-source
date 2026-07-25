/**
 * Mailbox-policy perPurposeMaxDraws preserve invariant (fault F-C).
 *
 * BUG: the `/api/mailbox-policy` POST handler in organizer-server.mjs did a wholesale
 * `mailboxPolicy = sanitizeMailboxPolicy(body)`. The dashboard's saveMailboxPolicy() (organizer-ui.js)
 * only ever POSTs {maxDrawsPerEpoch, maxConcurrent, dropInvalid} — it has no UI for
 * perPurposeMaxDraws (T2.1/F9 item 5) — so every save from the ordinary Draw Protection panel
 * silently reset any perPurposeMaxDraws override (configured via the API or mailbox_policy.json
 * directly) back to {}.
 *
 * FIX: the handler now preserves the current perPurposeMaxDraws when `body.perPurposeMaxDraws` is
 * `undefined`, exactly mirroring the /api/token-policy handler's existing
 * `if (body.perPurpose !== undefined) { ... } else { overrides = TOKENS_PER_EPOCH_OVERRIDES; }`
 * preserve pattern. Sending `perPurposeMaxDraws: {}` (or any object) explicitly still replaces it —
 * only an absent field is treated as "leave it alone".
 *
 * sanitizeMailboxPolicy/sanitizePerPurposeInts/ALL_PURPOSES are mirrored below (kept in lockstep with
 * organizer-server.mjs, exactly as origin_csrf_test.mjs mirrors originMatchesHost and
 * storage_config_test.mjs mirrors sanitizeStorage) — organizer-server.mjs can't be imported without
 * booting the whole dashboard + minting keys. applyMailboxPolicyUpdate mirrors the FIXED POST handler
 * body itself (the preserve-merge + sanitize), so this test fails if that merge is ever removed/
 * reverted to the old wholesale-replace behavior.
 */
import assert from 'assert';

// ── Mirror of organizer-server.mjs (kept in lockstep) ────────────────────────────
const PURPOSE_ORDER = ['post', 'read', 'picture-write', 'picture-read', 'audio-write', 'audio-read', 'space-write'];
const ALL_PURPOSES = new Set(PURPOSE_ORDER);

function sanitizePerPurposeInts(raw, {allowZero}) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!ALL_PURPOSES.has(k)) continue;
      const n = Number.isInteger(v) ? v : parseInt(v, 10);
      if (Number.isInteger(n) && (allowZero ? n >= 0 : n > 0) && n <= 100000) out[k] = n;
    }
  }
  return out;
}

const DEFAULT_MAILBOX_POLICY = {maxDrawsPerEpoch: 16, dropInvalid: true, maxConcurrent: 4, perPurposeMaxDraws: {}};
function sanitizeMailboxPolicy(p) {
  const n = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  return {
    maxDrawsPerEpoch: n(p?.maxDrawsPerEpoch, DEFAULT_MAILBOX_POLICY.maxDrawsPerEpoch),
    dropInvalid: p?.dropInvalid !== false, // default true
    maxConcurrent: n(p?.maxConcurrent, DEFAULT_MAILBOX_POLICY.maxConcurrent),
    perPurposeMaxDraws: sanitizePerPurposeInts(p?.perPurposeMaxDraws, {allowZero: true}),
  };
}

// Mirror of the FIXED `/api/mailbox-policy` POST handler body (organizer-server.mjs ~:2373-2387):
// preserve the current perPurposeMaxDraws when the request body doesn't send one.
function applyMailboxPolicyUpdate(currentPolicy, body) {
  const next = {...body};
  if (next.perPurposeMaxDraws === undefined) {
    next.perPurposeMaxDraws = currentPolicy.perPurposeMaxDraws;
  }
  return sanitizeMailboxPolicy(next);
}

// The OLD (buggy) handler body, kept only to demonstrate the regression this test guards against.
function applyMailboxPolicyUpdate_OLD_BUGGY(_currentPolicy, body) {
  return sanitizeMailboxPolicy(body);
}

const CURRENT_WITH_OVERRIDE = {
  maxDrawsPerEpoch: 16,
  dropInvalid: true,
  maxConcurrent: 4,
  perPurposeMaxDraws: {read: 50, post: 200},
};

// The EXACT body organizer-ui.js's saveMailboxPolicy() sends (organizer-ui.js ~:1901-1908) — no
// perPurposeMaxDraws field at all, since the Draw Protection panel has no UI for it.
const DASHBOARD_SAVE_BODY = {maxDrawsPerEpoch: 32, maxConcurrent: 8, dropInvalid: true};

// ── 1. POST without perPurposeMaxDraws preserves the existing override (the fix) ─────────────────
{
  const result = applyMailboxPolicyUpdate(CURRENT_WITH_OVERRIDE, DASHBOARD_SAVE_BODY);
  assert.deepStrictEqual(result.perPurposeMaxDraws, {read: 50, post: 200},
    'a dashboard save without perPurposeMaxDraws preserves the previously-configured override');
  assert.strictEqual(result.maxDrawsPerEpoch, 32, 'the ordinary maxDrawsPerEpoch field still updates');
  assert.strictEqual(result.maxConcurrent, 8, 'the ordinary maxConcurrent field still updates');
  assert.strictEqual(result.dropInvalid, true, 'dropInvalid still updates');
  console.log('ok 1 — POST without perPurposeMaxDraws preserves the existing per-purpose override');
}

// ── 2. demonstrates the REGRESSION: the old wholesale-replace handler wipes the override ──────────
{
  const buggyResult = applyMailboxPolicyUpdate_OLD_BUGGY(CURRENT_WITH_OVERRIDE, DASHBOARD_SAVE_BODY);
  assert.deepStrictEqual(buggyResult.perPurposeMaxDraws, {},
    'the OLD handler (wholesale sanitizeMailboxPolicy(body)) silently wipes perPurposeMaxDraws — this is fault F-C');
  console.log('ok 2 — the pre-fix wholesale-replace handler reproduces F-C (override silently wiped)');
}

// ── 3. an explicit perPurposeMaxDraws: {} still clears it (intentional clear is unaffected) ───────
{
  const body = {...DASHBOARD_SAVE_BODY, perPurposeMaxDraws: {}};
  const result = applyMailboxPolicyUpdate(CURRENT_WITH_OVERRIDE, body);
  assert.deepStrictEqual(result.perPurposeMaxDraws, {}, 'an explicit {} still clears the override — only `undefined` preserves');
  console.log('ok 3 — an explicit perPurposeMaxDraws:{} still clears (preserve only triggers on undefined)');
}

// ── 4. an explicit perPurposeMaxDraws replaces the prior override entirely ────────────────────────
{
  const body = {...DASHBOARD_SAVE_BODY, perPurposeMaxDraws: {'space-write': 3}};
  const result = applyMailboxPolicyUpdate(CURRENT_WITH_OVERRIDE, body);
  assert.deepStrictEqual(result.perPurposeMaxDraws, {'space-write': 3},
    'an explicit perPurposeMaxDraws body replaces the prior override (not merged with it)');
  console.log('ok 4 — an explicit perPurposeMaxDraws body replaces the prior override');
}

// ── 5. starting from NO override ({}), a dashboard save still yields {} (byte-identical to before
// this existed for an organizer that never configured per-purpose overrides) ──────────────────────
{
  const currentNoOverride = {maxDrawsPerEpoch: 16, dropInvalid: true, maxConcurrent: 4, perPurposeMaxDraws: {}};
  const result = applyMailboxPolicyUpdate(currentNoOverride, DASHBOARD_SAVE_BODY);
  assert.deepStrictEqual(result.perPurposeMaxDraws, {}, 'no override configured -> preserve-of-empty stays empty');
  console.log('ok 5 — no prior override + a dashboard save yields {} (unaffected default path)');
}

// ── 6. malformed/unknown-purpose entries in an explicit perPurposeMaxDraws are still sanitized ────
{
  const body = {...DASHBOARD_SAVE_BODY, perPurposeMaxDraws: {read: 5, bogus: 9, post: -1, 'audio-write': 100001}};
  const result = applyMailboxPolicyUpdate(CURRENT_WITH_OVERRIDE, body);
  assert.deepStrictEqual(result.perPurposeMaxDraws, {read: 5},
    'unknown purposes and out-of-range values are dropped, even when replacing an existing override');
  console.log('ok 6 — sanitization still applies to an explicit replacement perPurposeMaxDraws body');
}

console.log('\nall mailbox-policy perPurposeMaxDraws preserve invariants hold.');
