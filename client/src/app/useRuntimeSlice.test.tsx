/**
 * useRuntimeSlice (Phase 6.1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — the contract that cuts
 * the emit amplifier: a component re-renders ONLY when its selected slice changes under isEqual,
 * never merely because the runtime emitted a fresh full snapshot.
 *
 * The 'adaptive emit pipeline' describe block below (instant-refresh overhaul) pins the urgent/
 * non-urgent contract added on top of that: an urgent notification still applies synchronously
 * (every test above this point passes urgent=true and already covers that path unchanged), while a
 * non-urgent one is deferred through InteractionManager.runAfterInteractions rather than applied
 * inline — see the module doc for why (startTransition is verified inert for this app).
 */
import React from 'react';
import {Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {sliceArrayEqual, useRuntimeSlice, type SliceStore} from './useRuntimeSlice';

interface FakeSnapshot {
  count: number;
  name: string;
  items: string[];
}

/** Minimal store honouring AppRuntime.subscribe's contract (immediate replay on subscribe).
 *  `set`'s urgent defaults to true so every pre-existing call site above is unaffected. */
function makeStore(initial: FakeSnapshot): SliceStore<FakeSnapshot> & {
  set(next: Partial<FakeSnapshot>, urgent?: boolean): void;
  listenerCount(): number;
} {
  let snapshot = initial;
  const listeners = new Set<(s: FakeSnapshot, urgent: boolean) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot, true);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    set(next, urgent = true) {
      snapshot = {...snapshot, ...next};
      for (const l of listeners) l(snapshot, urgent);
    },
    listenerCount: () => listeners.size,
  };
}

/** Flushes a pending InteractionManager.runAfterInteractions task — same idiom as MainScreen's test
 *  suites (e.g. MainScreen.notificationsLive.test.tsx's flush()): the real (unmocked) InteractionManager
 *  resolves its queue via setImmediate, so one hop wrapped in act() is enough to settle it. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

let renders = 0;

function Probe({
  store,
  selector,
  isEqual,
}: {
  store: SliceStore<FakeSnapshot>;
  selector: (s: FakeSnapshot) => unknown;
  isEqual?: (a: unknown, b: unknown) => boolean;
}): React.JSX.Element {
  renders += 1;
  const slice = useRuntimeSlice(store, selector, isEqual);
  return <Text>{JSON.stringify(slice)}</Text>;
}

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

beforeEach(() => {
  renders = 0;
});

describe('useRuntimeSlice', () => {
  it('renders the selected slice and follows changes to it', () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);
    expect(tree.root.findByType(Text).props.children).toBe('1');

    act(() => store.set({count: 2}));
    expect(tree.root.findByType(Text).props.children).toBe('2');
  });

  it('does NOT re-render when an emit changes only fields outside the slice', () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    render(<Probe store={store} selector={s => s.count} />);
    const after = renders;

    act(() => store.set({name: 'b'}));
    act(() => store.set({name: 'c'}));
    act(() => store.set({items: ['x']}));
    expect(renders).toBe(after); // three full-snapshot emits, zero re-renders

    act(() => store.set({count: 5}));
    expect(renders).toBe(after + 1); // the slice change is the only thing that re-renders
  });

  it('sliceArrayEqual keeps tuple selectors stable across irrelevant emits', () => {
    const store = makeStore({count: 3, name: 'a', items: ['p']});
    // A fresh tuple every call — without the equality fn this would re-render on every emit.
    render(<Probe store={store} selector={s => [s.count, s.items.length]} isEqual={sliceArrayEqual} />);
    const after = renders;

    act(() => store.set({name: 'z'}));
    expect(renders).toBe(after);

    act(() => store.set({items: ['p', 'q']}));
    expect(renders).toBe(after + 1);
  });

  it('unsubscribes from the store on unmount', () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);
    expect(store.listenerCount()).toBe(1);
    act(() => tree.unmount());
    expect(store.listenerCount()).toBe(0);
  });
});

describe('useRuntimeSlice — adaptive emit pipeline (urgent vs. non-urgent)', () => {
  it('does not apply a non-urgent change until interactions flush', async () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);

    act(() => store.set({count: 2}, false));
    // Still the OLD value — the notification is queued behind InteractionManager, not applied
    // inline the way an urgent one is (see the very first test in this file).
    expect(tree.root.findByType(Text).props.children).toBe('1');

    await flush();
    expect(tree.root.findByType(Text).props.children).toBe('2');
  });

  it('coalesces a burst of non-urgent changes into a single deferred re-render at the latest value', async () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);
    const before = renders;

    act(() => {
      store.set({count: 2}, false);
      store.set({count: 3}, false);
      store.set({count: 4}, false);
    });
    expect(renders).toBe(before); // nothing applied synchronously yet

    await flush();
    expect(renders).toBe(before + 1); // ONE re-render, not three
    expect(tree.root.findByType(Text).props.children).toBe('4'); // the latest value, not the first queued one
  });

  it('an urgent change supersedes a still-pending non-urgent flush rather than being overwritten by it', async () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);

    act(() => store.set({count: 2}, false)); // queues a deferred flush for 2
    act(() => store.set({count: 5}, true)); // user-initiated — applies immediately
    expect(tree.root.findByType(Text).props.children).toBe('5');

    // If the earlier non-urgent flush were still live, it would now stomp 5 back down to 2 — it
    // must not: the urgent path cancels it.
    await flush();
    expect(tree.root.findByType(Text).props.children).toBe('5');
  });

  it('cancels a pending non-urgent flush on unmount instead of calling onStoreChange afterward', async () => {
    const store = makeStore({count: 1, name: 'a', items: []});
    const tree = render(<Probe store={store} selector={s => s.count} />);

    act(() => store.set({count: 2}, false)); // queues a flush
    act(() => tree.unmount());
    expect(store.listenerCount()).toBe(0);

    // Flushing after unmount must not throw / warn — the pending InteractionManager task was
    // cancelled by the subscribe cleanup, not left to fire against a torn-down subscription.
    await expect(flush()).resolves.toBeUndefined();
  });
});
