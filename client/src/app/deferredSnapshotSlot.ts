/**
 * A one-slot coalescing buffer for deferred state application.
 *
 * App.tsx applies AppRuntime snapshots two ways: URGENT ones (the user's own post/vote/lock/nav)
 * land synchronously, and NON-URGENT ones (throttled relay churn) are deferred off the interaction
 * path via InteractionManager.runAfterInteractions so a full-tree re-render never lands mid-gesture.
 * Deferral needs exactly two guards, and getting either wrong is silent:
 *
 *   1. COALESCE — at most one queued flush, ever. A burst of relay events must collapse into ONE
 *      apply, not N queued applies, and the queued flush must carry the LATEST value rather than the
 *      one that happened to arm it.
 *   2. SUPERSEDE — any fresher value applied outside this path must both clear the queued value AND
 *      cancel its scheduled callback. A queued flush holds an OLDER snapshot, so leaving it to fire
 *      rolls the UI backwards to state the user already moved past.
 *
 * Guard 2 is why this is a standalone object rather than a pair of `let`s inside App's mount effect,
 * which is where this logic used to live. Trapped in that closure it was unreachable from the
 * component body, so App's direct-apply path (handleMarkFeedSeen, which reads the runtime and
 * setSnapshot()s straight from it) could not cancel a pending flush: tapping the "N new posts" pill
 * cleared the count, then the queued older snapshot landed and brought it back. Being trapped there
 * also meant no test could reach it — the reason the defect shipped at all. Both problems are the
 * same problem, and this file is the fix for both.
 *
 * Deliberately generic over the scheduler rather than importing InteractionManager: that keeps this
 * unit synchronously testable with a fake scheduler, and lets the caller pick the right deferral
 * primitive for its situation. See deferredSnapshotSlot.test.ts.
 */

/** The subset of InteractionManager.runAfterInteractions' return value this needs. */
export interface Cancellable {
  cancel: () => void;
}

/** Schedules `callback` to run later, returning a handle that can cancel it before it fires. */
export type DeferScheduler = (callback: () => void) => Cancellable;

export interface DeferredSlot<T> {
  /**
   * Queue `value` for deferred application. If a flush is already queued this only replaces the
   * pending value — the existing flush reads the slot fresh when it fires, so it will carry `value`
   * without a second callback being scheduled.
   */
  defer(value: T): void;
  /**
   * Drop any queued value and cancel its scheduled callback. Call this immediately BEFORE applying a
   * fresher value by any other route (an urgent emit, a direct read), and on teardown. Idempotent.
   */
  cancel(): void;
  /** Whether a flush is currently queued. Test/diagnostic affordance; not needed to use the slot. */
  isPending(): boolean;
}

/**
 * Build a coalescing slot that applies at most one deferred value per scheduled flush.
 *
 * @param apply     Receives the latest deferred value when the flush fires. Not called if the slot
 *                  was cancelled first, and never called with a value that a later `defer` replaced.
 * @param schedule  Defers a callback (e.g. `InteractionManager.runAfterInteractions`).
 */
export function createDeferredSlot<T>(apply: (value: T) => void, schedule: DeferScheduler): DeferredSlot<T> {
  // `has` is tracked separately from `value` so a legitimately nullish/undefined T is still a real
  // queued value rather than reading as "nothing queued".
  let has = false;
  let value: T | undefined;
  let handle: Cancellable | null = null;

  const flush = (): void => {
    handle = null; // this callback IS the handle firing — there is nothing left to cancel
    if (!has) return;
    const next = value as T;
    has = false;
    value = undefined;
    apply(next);
  };

  return {
    defer(next: T): void {
      has = true;
      value = next;
      if (!handle) handle = schedule(flush);
    },
    cancel(): void {
      has = false;
      value = undefined;
      if (handle) {
        handle.cancel();
        handle = null;
      }
    },
    isPending(): boolean {
      return handle !== null;
    },
  };
}
