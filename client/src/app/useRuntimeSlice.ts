/**
 * useRuntimeSlice — subscribe a component to a SLICE of the AppRuntime snapshot instead of the
 * whole thing (UI smoothness overhaul Phase 6.1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md).
 *
 * The systemic re-render amplifier: `AppRuntime.emit()` pushes a fresh full snapshot to App.tsx's
 * single `setSnapshot` subscriber, so the entire component tree re-executes on EVERY vote /
 * comment / DM / firehose flush — exactly while the JS thread is driving that tap's UI response.
 * This hook is the escape valve: a subtree calls `useRuntimeSlice(runtime, selector, isEqual)`
 * and re-renders only when ITS slice actually changes.
 *
 * Built on React 18's `useSyncExternalStore`, so reads are tear-free during concurrent renders.
 * The selector result is cached and re-used (same reference) while `isEqual` says it hasn't
 * changed — that reference stability is what stops the re-render.
 *
 * Adoption note (Phase 6.2): today MainScreen receives everything through App-built props, so the
 * three tab bodies still ride App's full-snapshot subscription; TabLayer's freeze (Phase 4.1)
 * already shields the two HIDDEN tabs from every emit. Moving the ACTIVE tab body, dock badges and
 * header onto this hook requires the App.tsx prop-flow to hand subtrees the runtime itself — do
 * that surface by surface, hottest first, in follow-up rounds.
 *
 * ── Adaptive emit pipeline (urgent vs. non-urgent) ──────────────────────────────────────────
 * AppRuntime.subscribe's listener now carries an `urgent` flag: user-initiated changes (post/vote/
 * lock/nav) emit synchronously, and throttled background relay churn emits with `urgent: false`.
 * This hook defers the LATTER off the interaction path via InteractionManager.runAfterInteractions
 * rather than `startTransition` — verified, not assumed, because the naive approach silently does
 * nothing here:
 *   1. useSyncExternalStore's OWN change-detection handler (`forceStoreRerender` in React's
 *      reconciler — see node_modules/react-native/Libraries/Renderer/implementations/
 *      ReactNativeRenderer-dev.js) hardcodes `SyncLane` for the re-render it schedules when the
 *      store notifies a change, REGARDLESS of whether that notification happened inside a
 *      `startTransition` callback. This is deliberate upstream (avoids tearing between an external
 *      store's mutable reads and a deferred render), not a bug — but it means wrapping the
 *      `onStoreChange()` call below in `startTransition` would be a complete no-op.
 *   2. Independent of (1): this app runs WITHOUT a concurrent React root at all.
 *      react-native/Libraries/ReactNative/renderApplication.js sets `useConcurrentRoot: fabric` —
 *      concurrent rendering is wired up ONLY on Fabric. android/gradle.properties has
 *      `newArchEnabled=false` (Paper), so every fiber's `mode` lacks `ConcurrentMode`, and
 *      `requestUpdateLane` (same renderer bundle) returns `SyncLane` for every update in the WHOLE
 *      tree before it ever consults `ReactCurrentBatchConfig.transition` — `startTransition` is
 *      inert here for any update, not just this hook's.
 * InteractionManager.runAfterInteractions is this codebase's existing, load-bearing answer to "run
 * this off an in-flight gesture/animation" (App.tsx's maybeDrawTokens/startColdCascade,
 * MainScreen's threadNodes/notifItems passes) — reused here instead of inventing a second idiom.
 * Coalescing (at most one pending flush per subscription) mirrors AppRuntime's own emitDeferred: a
 * burst of non-urgent notifications collapses to ONE onStoreChange() call, which re-reads
 * getSnapshot() fresh at flush time, so it's automatically the latest regardless of how many
 * notifications arrived while the flush was pending.
 */
import {useCallback, useRef, useSyncExternalStore} from 'react';
import {InteractionManager} from 'react-native';

/** The two members of AppRuntime this hook relies on (structural, so tests can fake it and so the
 * hook never imports the 11k-line runtime module). */
export interface SliceStore<S> {
  subscribe(listener: (snapshot: S, urgent: boolean) => void): () => void;
  getSnapshot(): S;
}

const shallowEqualArrays = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((v, i) => Object.is(v, b[i]));

/** Convenience equality for selectors returning small tuples/arrays of primitives
 * (e.g. `[unreadCount, syncing]`). */
export const sliceArrayEqual = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) || shallowEqualArrays(a, b);

export function useRuntimeSlice<S, T>(
  store: SliceStore<S>,
  selector: (snapshot: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // Latest selector/isEqual without re-subscribing (their identities routinely change per render).
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  const cache = useRef<{has: boolean; value: T}>({has: false, value: undefined as T});

  const getSlice = useCallback((): T => {
    const next = selectorRef.current(store.getSnapshot());
    if (cache.current.has && isEqualRef.current(cache.current.value, next)) {
      // Unchanged under isEqual → return the CACHED reference; useSyncExternalStore then bails out
      // of the re-render entirely.
      return cache.current.value;
    }
    cache.current = {has: true, value: next};
    return next;
  }, [store]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // Handle to the currently-queued deferred flush, if any — cancelled (not just left to fire)
      // on an urgent supersede or on unsubscribe, so a stale flush can never call onStoreChange()
      // after either has happened. See the module doc for why this is InteractionManager rather
      // than startTransition.
      let pendingFlush: {cancel: () => void} | null = null;
      const unsubscribe = store.subscribe((_snapshot, urgent) => {
        if (urgent) {
          // A fresher urgent notification always supersedes a still-pending non-urgent flush —
          // getSlice() is about to read the latest snapshot anyway, so the queued flush would at
          // best be redundant (isEqual bails it out) and at worst fire needlessly later.
          if (pendingFlush) {
            pendingFlush.cancel();
            pendingFlush = null;
          }
          onStoreChange();
          return;
        }
        if (pendingFlush) return; // already coalescing — the eventual flush reads getSnapshot() fresh
        pendingFlush = InteractionManager.runAfterInteractions(() => {
          pendingFlush = null;
          onStoreChange();
        });
      });
      return () => {
        if (pendingFlush) {
          pendingFlush.cancel();
          pendingFlush = null;
        }
        unsubscribe();
      };
    },
    [store],
  );

  return useSyncExternalStore(subscribe, getSlice);
}
