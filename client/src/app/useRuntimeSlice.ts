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
 */
import {useCallback, useRef, useSyncExternalStore} from 'react';

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
    (onStoreChange: () => void) => store.subscribe(() => onStoreChange()),
    [store],
  );

  return useSyncExternalStore(subscribe, getSlice);
}
