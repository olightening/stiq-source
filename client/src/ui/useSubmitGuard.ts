/**
 * useSubmitGuard — a synchronous, re-entrant-safe "am I already submitting?" guard.
 *
 * Several PIN-submit screens (LockScreen, PasswordsScreen) used `if (busy) return;` followed by
 * `setBusy(true)` as their re-entrancy guard. That's unsafe: `busy` is a stale closure value and
 * `setState` is async, so a double-tap (or a ghost press right after a real one) can slip past the
 * check before the first render lands, running the guarded async submit twice — e.g. double-
 * counting a single wrong PIN against the lockout counter.
 *
 * This hook fixes that by keeping the "in flight" flag in a `useRef`, which is read AND written
 * synchronously before any `await` — no render round-trip involved. `guard(fn)` runs `fn` only if
 * no call is already in flight, and always releases the flag in a `finally` so a thrown/rejected
 * `fn` never wedges the guard open.
 */
import {useCallback, useRef} from 'react';

/** Runs `fn` unless a previous call is still in flight; returns its result, or `undefined` when
 *  the call was skipped because a guarded call was already running. */
export type SubmitGuard = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export function useSubmitGuard(): SubmitGuard {
  const inFlight = useRef(false);

  return useCallback(async fn => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    try {
      return await fn();
    } finally {
      inFlight.current = false;
    }
  }, []);
}
