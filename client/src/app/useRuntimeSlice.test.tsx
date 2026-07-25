/**
 * useRuntimeSlice (Phase 6.1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — the contract that cuts
 * the emit amplifier: a component re-renders ONLY when its selected slice changes under isEqual,
 * never merely because the runtime emitted a fresh full snapshot.
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

/** Minimal store honouring AppRuntime.subscribe's contract (immediate replay on subscribe). */
function makeStore(initial: FakeSnapshot): SliceStore<FakeSnapshot> & {
  set(next: Partial<FakeSnapshot>): void;
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
    set(next) {
      snapshot = {...snapshot, ...next};
      for (const l of listeners) l(snapshot, true);
    },
    listenerCount: () => listeners.size,
  };
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
