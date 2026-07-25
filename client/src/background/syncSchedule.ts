/**
 * Pure timing policy for the background sync (T15 timing-correlation defense). Randomizes both
 * the WorkManager period and the in-task network start so the observable relay/onion activity
 * does not fall on a fixed cadence an adversary can lock onto. Like `sendJitter.ts` and
 * `reconnectBackoff.ts` these helpers take an injectable rng and read no feature flag — the
 * caller (App.tsx background handler / syncTask) owns the TIMING_JITTER gate.
 */

/** Low end of the randomized period band, minutes. Android coerces PeriodicWork below 15 min. */
export const SYNC_PERIOD_MIN_MINUTES = 15;
/** High end of the randomized period band, minutes. */
export const SYNC_PERIOD_MAX_MINUTES = 26;
/** WorkManager flex window, minutes (unchanged from today's `scheduleSync(15, 5)`). */
export const SYNC_FLEX_MINUTES = 5;

/**
 * Integer minutes uniform in [SYNC_PERIOD_MIN_MINUTES, SYNC_PERIOD_MAX_MINUTES]. Kept >= 15 because
 * Android enforces a 15-minute PeriodicWork floor (a smaller value is silently coerced up).
 */
export function randomizedSyncPeriodMinutes(rng: () => number = Math.random): number {
  const span = SYNC_PERIOD_MAX_MINUTES - SYNC_PERIOD_MIN_MINUTES;
  return SYNC_PERIOD_MIN_MINUTES + Math.floor(rng() * (span + 1));
}

/**
 * Max in-task startup delay, ms. 20s is safely under the 85s HARD_TIMEOUT_MS headless wall, and
 * the caller further clamps this to the remaining time budget before Tor bootstrap.
 */
export const SYNC_STARTUP_JITTER_MAX_MS = 20_000;

/**
 * Uniform 0..SYNC_STARTUP_JITTER_MAX_MS ms delay applied inside the headless task before Tor
 * bootstrap, to decorrelate the actual relay/onion network activity from the WorkManager alarm fire.
 */
export function syncStartupJitterMs(rng: () => number = Math.random): number {
  return Math.round(rng() * SYNC_STARTUP_JITTER_MAX_MS);
}
