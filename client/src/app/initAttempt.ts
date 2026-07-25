/**
 * Init-attempt generation guard (App.tsx's `attemptInit`). Pure so it is unit-testable without the
 * native deps `App.tsx` pulls in.
 *
 * `attemptInit()` races `runtime.init()` against a timeout, and a Retry from the recovery screen
 * re-invokes it — so at any moment there can be an abandoned OLDER attempt whose `init()` promise
 * (or timeout) is still going to settle after a NEWER attempt has already started. Both the timeout
 * callback and the init().finally() handler must treat a stale attempt's settlement as a no-op —
 * otherwise a late resolution of the abandoned attempt would apply its side effects (deep-link
 * replay, `setHydrated`/`setInitTimedOut`) on top of whatever the current attempt already did, a
 * reentrancy hazard on the shared `runtime` instance.
 */
export function isCurrentInitAttempt(
  attempt: number,
  latestAttempt: number,
  disposed: boolean,
): boolean {
  return !disposed && attempt === latestAttempt;
}
