/**
 * Pure, unit-testable send-jitter timing policy (mirrors the style of
 * `client/src/nostr/reconnectBackoff.ts`: takes an injectable rng, returns ms, reads no flag —
 * the caller owns the feature gate).
 *
 * Purpose (T15 timing-correlation defense): defer only the NETWORK send of an outbound write by a
 * small bounded random delay so an adversary observing Tor traffic timing cannot align the wire
 * send with the user action that triggered it. It is invisible by construction — the optimistic UI
 * render already happened in `AppRuntime.publishOptimistic` before delivery is scheduled, so this
 * delay never affects perceived latency.
 */

/**
 * Lower bound of the send delay, ms. A non-zero floor guarantees every send carries at least this
 * much jitter (a zero-floor would leave near-instant sends still correlatable).
 */
export const SEND_JITTER_MIN_MS = 150;

/**
 * Upper bound of the send delay, ms. Kept <= 2.5s because the post/DM is already rendered
 * optimistically, so the user perceives no lag; larger values would start to slow DM/reconnect
 * catch-up without a meaningful anonymity gain.
 */
export const SEND_JITTER_MAX_MS = 2500;

/**
 * Uniform random delay in [SEND_JITTER_MIN_MS, SEND_JITTER_MAX_MS], ms. `rng` defaults to
 * Math.random for production and is injectable for deterministic tests.
 */
export function sendJitterMs(rng: () => number = Math.random): number {
  const span = SEND_JITTER_MAX_MS - SEND_JITTER_MIN_MS;
  return Math.round(SEND_JITTER_MIN_MS + span * rng());
}
