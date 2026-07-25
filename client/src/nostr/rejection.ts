/**
 * Relay OK-frame rejection parsing (T12) — the pure, framework-free substrate that both the outbox
 * retry policy ({@link import('./RelayClient').classifyRejection}) and the calm-message UI layer
 * ({@link import('../feed/rejectionMessages').calmRejection}) build on.
 *
 * The relay formats every rejection reason as `"[code] human prose"` — a leading, bracketed MACHINE
 * code followed by the same human text a user used to see. This module makes that machine code the
 * authoritative signal: {@link parseRejection} strips the bracket, keeps the remaining prose, and
 * scrapes any embedded numbers (limits, token balances, retry-after seconds). {@link RETRYABLE_CODES}
 * plus {@link isRetryable} then decide — from the code alone, when the relay is trusted — whether
 * re-sending the SAME signed event could ever land.
 *
 * Two invariants make this safe to ship AHEAD of a relay that guarantees the codes:
 *   • parseRejection NEVER throws and always returns a well-formed result (unknown → empty code,
 *     prose = the raw message), so an unrecognised reason degrades to today's raw-prose behaviour.
 *   • {@link legacyRetryable} reproduces the pre-T12 prose heuristic BYTE-FOR-BYTE, so the untrusted
 *     path (relay hasn't advertised the machine-code version yet, or the kill-switch is off) behaves
 *     exactly as it does today — nothing regresses before the coordinated flip.
 *
 * LEAF module: imports nothing from app state, Tor, or React — trivially unit-testable.
 */

/** Numbers scraped out of a rejection's human prose (all optional; absent when not present/parseable). */
export interface RejectParams {
  /** The community/relay limit the event exceeded (characters, tags, media items, or bytes). */
  max?: number;
  /** The event's actual measured value against `max`. */
  actual?: number;
  /** Tokens the event needs (token_insufficient). */
  need?: number;
  /** Tokens the author currently holds (token_insufficient). */
  have?: number;
  /** The reset window a per-author rate limit is keyed to. */
  period?: 'daily' | 'weekly' | 'monthly';
  /** Seconds until a bounded rate-limit window reopens (from the `retry_after=<sec>` suffix). */
  retryAfterSec?: number;
}

/** A relay rejection reason split into its machine code, human prose, and scraped params. */
export interface ParsedRejection {
  /** The authoritative bracket code (`token_required`, `rate_limited_dm`, …); '' when none/unknown. */
  code: string;
  /** The human-readable text: the prose after the `[code]` bracket, else the whole message. */
  prose: string;
  /** Numbers extracted from the prose (see {@link RejectParams}). */
  params: RejectParams;
}

/** `[code] prose` — the relay's authoritative wire shape. Codes are lowercase snake_case. */
const BRACKET_RE = /^\[([a-z0-9_]+)\]\s*(.*)$/;
/** Legacy bare `code:` prose prefix (`blocked:`/`invalid:`/`auth-required:`/`rate-limited:`/…). */
const LEGACY_PREFIX_RE = /^([a-z][a-z-]*):\s*(.*)$/;

/**
 * Parse a relay OK-frame rejection `message` into `{code, prose, params}` (T12). The leading `[code]`
 * bracket is AUTHORITATIVE: when present, `code` is its contents and `prose` is the text after it.
 * With no bracket, fall back to the legacy bare `code:` prose prefix (lowercased) for `code`, keeping
 * the WHOLE message as `prose` (byte-identical to what the user sees today). Never throws.
 */
export function parseRejection(message: string): ParsedRejection {
  const msg = (message ?? '').trim();
  const bracket = BRACKET_RE.exec(msg);
  if (bracket) {
    const prose = bracket[2] ?? '';
    return {code: bracket[1]!, prose, params: extractParams(prose)};
  }
  const legacy = LEGACY_PREFIX_RE.exec(msg.toLowerCase());
  return {code: legacy ? legacy[1]! : '', prose: msg, params: extractParams(msg)};
}

/** Scrape the known numeric/period params out of a reason's prose. Ignores anything non-finite. */
function extractParams(prose: string): RejectParams {
  const p = prose.toLowerCase();
  const params: RejectParams = {};
  const set = (key: 'max' | 'actual' | 'need' | 'have' | 'retryAfterSec', raw: string | undefined) => {
    const n = Number(raw);
    if (Number.isFinite(n)) params[key] = n;
  };

  // Byte size: "(500000 bytes, max 262144)" (event_too_large). Checked before the plain "(n, max n)".
  let m = /\((\d+) bytes, max (\d+)\)/.exec(p);
  if (m) {
    set('actual', m[1]);
    set('max', m[2]);
  } else if ((m = /\((\d+), max (\d+)\)/.exec(p))) {
    // Count vs cap: "(3, max 2)" (too_many_tags / too_many_tokens).
    set('actual', m[1]);
    set('max', m[2]);
  }

  // Token balance: "needs 3 tokens, has 1" (token_insufficient).
  if ((m = /needs (\d+) tokens, has (\d+)/.exec(p))) {
    set('need', m[1]);
    set('have', m[2]);
  }

  // Length: "is 500 characters; this community allows at most 280" (content/author-note/article).
  if ((m = /is (\d+) [a-z]+; this community allows at most (\d+)/.exec(p))) {
    set('actual', m[1]);
    set('max', m[2]);
  } else if ((m = /(\d+) media items; this community allows at most (\d+)/.exec(p))) {
    // Media count: "5 media items; this community allows at most 4".
    set('actual', m[1]);
    set('max', m[2]);
  }

  const period = /\b(daily|weekly|monthly)\b/.exec(p);
  if (period) params.period = period[1] as 'daily' | 'weekly' | 'monthly';

  const retry = /retry_after=(\d+)/.exec(p);
  if (retry) set('retryAfterSec', retry[1]);

  return params;
}

/**
 * Relay reject codes that are genuinely TRANSIENT for the SAME signed event — re-sending it may well
 * land once a momentary condition clears:
 *   • `rate_limited_dm` / `rate_limited_mailbox` — the community is busy right now; the bounded window
 *     reopens shortly (the reason carries a `retry_after`).
 *   • `record_token_error` / `record_membership_error` — a transient relay-side storage hiccup writing
 *     the blind-token / membership row.
 * EVERYTHING ELSE is terminal for the same event: token codes (`token_required`/`token_invalid`/…),
 * length/media caps, tag scopes, permission denials, pow codes, per-author `rate_limited`
 * (daily/weekly/monthly), not_a_member, kind_not_permitted, group codes — the same signed bytes just
 * earn the same "no". `space_token_required` (T0.5, RejectCodesVersion 4 — tokens-everywhere) belongs
 * in this terminal bucket too, deliberately NOT listed below: the client always attaches a space-write
 * token proof when the relay requires one (spendSpaceTokens's caller, AppRuntime), so a same-event
 * retry without one would just repeat the rejection — same as its posting-token siblings.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'rate_limited_dm',
  'rate_limited_mailbox',
  'record_token_error',
  'record_membership_error',
]);

// ── Legacy prose heuristic (pre-T12) — preserved BYTE-FOR-BYTE for the untrusted path ────────────
//
// These reproduce the exact sets the old RelayClient.classifyRejection used, so a relay that hasn't
// advertised reject_codes_version>=3 (or the kill-switch being off) classifies retryability precisely
// as it does today. Do NOT fold these into RETRYABLE_CODES: that set is the TRUSTED code-table (which
// newly adds the rate-limit codes); this heuristic must not shift pre-flip.

/** Prose prefixes whose rejection is PERMANENT (same signed event → same "no"). */
const LEGACY_NON_RETRYABLE: ReadonlySet<string> = new Set([
  'blocked',
  'invalid',
  'auth-required',
  'restricted',
  'pow',
]);

/** Substrings marking a momentary "not now" refusal (load / rate / an event the relay already holds). */
const LEGACY_TRANSIENT_SUBSTRINGS: readonly string[] = [
  'rate-limit',
  'too many',
  'slow down',
  'try again',
  'temporarily',
  'duplicate',
  'could not record',
];

/** Codes the pre-T12 heuristic treated as transient despite not matching the substrings above. */
const LEGACY_RETRYABLE: ReadonlySet<string> = new Set(['record_token_error', 'record_membership_error']);

/**
 * The pre-T12 prose heuristic, verbatim: strip a leading `[code]` bracket, take the bare `code:`
 * prefix of what remains, then decide — permanent prefix → false, a known-transient code/substring →
 * true, otherwise false (an unclassified reason stays terminal, the B1 win). Kept as the untrusted
 * fallback so nothing regresses before the machine-code flip.
 */
export function legacyRetryable(message: string): boolean {
  const lower = (message ?? '').trim().toLowerCase();
  const bracketMatch = /^\[([a-z][a-z0-9_-]*)\]\s*/.exec(lower);
  const rest = bracketMatch ? lower.slice(bracketMatch[0].length) : lower;
  const barePrefixMatch = /^([a-z][a-z-]*):/.exec(rest);
  const barePrefixCode = barePrefixMatch ? barePrefixMatch[1]! : '';
  const code = bracketMatch ? bracketMatch[1]! : barePrefixCode;

  if (LEGACY_NON_RETRYABLE.has(code) || LEGACY_NON_RETRYABLE.has(barePrefixCode)) return false;
  if (
    LEGACY_RETRYABLE.has(code) ||
    LEGACY_RETRYABLE.has(barePrefixCode) ||
    LEGACY_TRANSIENT_SUBSTRINGS.some(t => rest.includes(t))
  ) {
    return true;
  }
  return false;
}

/**
 * Decide whether re-sending the SAME signed event could land. When `trustCodes` is true AND the relay
 * gave us a machine code, the authoritative {@link RETRYABLE_CODES} table decides. Otherwise fall back
 * to the {@link legacyRetryable} prose heuristic — today's exact behaviour, so the pre-flip path never
 * regresses. Callers gate `trustCodes` on both the kill-switch (`TRUST_RELAY_REJECT_CODES`) and the
 * relay advertising `reject_codes_version >= CAPS_REJECT_CODES_MACHINE_MIN`.
 */
export function isRetryable(p: ParsedRejection, opts: {trustCodes: boolean}): boolean {
  if (opts.trustCodes && p.code) return RETRYABLE_CODES.has(p.code);
  return legacyRetryable(p.prose);
}
