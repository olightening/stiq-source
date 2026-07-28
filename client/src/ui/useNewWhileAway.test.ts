/**
 * useNewWhileAway — the "N new while scrolled away" counter behind the JumpButton badge in
 * channels/groups/DMs. The cases pin the contract's three load-bearing choices: the floor is
 * snapshotted exactly once per away-episode, the comparison is by createdAt (so paged-in older
 * history never counts), and returning to the edge resets everything.
 */
import React from 'react';
import {create, act, type ReactTestRenderer} from 'react-test-renderer';
import {useNewWhileAway} from './useNewWhileAway';

interface Msg {
  id: string;
  createdAt: number;
}

const msg = (id: string, createdAt: number): Msg => ({id, createdAt});
const at = (m: Msg): number => m.createdAt;

/** Mount the hook behind a probe component and drive it via re-renders. */
function mount(items: readonly Msg[], away: boolean): {
  count: () => number;
  update: (items: readonly Msg[], away: boolean) => void;
  unmount: () => void;
} {
  let latest = 0;
  function Probe({items: it, away: aw}: {items: readonly Msg[]; away: boolean}): null {
    latest = useNewWhileAway(it, at, aw);
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(React.createElement(Probe, {items, away}));
  });
  return {
    count: () => latest,
    update: (it, aw) => {
      act(() => {
        tree.update(React.createElement(Probe, {items: it, away: aw}));
      });
    },
    unmount: () => act(() => tree.unmount()),
  };
}

describe('useNewWhileAway', () => {
  const base = [msg('a', 100), msg('b', 200), msg('c', 300)];

  it('reads 0 while at the latest edge, even as messages arrive', () => {
    const h = mount(base, false);
    expect(h.count()).toBe(0);
    h.update([...base, msg('d', 400)], false);
    expect(h.count()).toBe(0);
    h.unmount();
  });

  it('counts only messages newer than the moment of scrolling away', () => {
    const h = mount(base, false);
    h.update(base, true); // scroll away — floor snapshots at 300
    expect(h.count()).toBe(0);
    h.update([...base, msg('d', 400)], true);
    expect(h.count()).toBe(1);
    h.update([...base, msg('d', 400), msg('e', 500)], true);
    expect(h.count()).toBe(2);
    h.unmount();
  });

  it('does NOT count older history paged in while away (createdAt floor, not position)', () => {
    const h = mount(base, false);
    h.update(base, true);
    // Load-older prepends history from before the floor; one live message also lands.
    h.update([msg('old1', 10), msg('old2', 20), ...base, msg('d', 400)], true);
    expect(h.count()).toBe(1);
    h.unmount();
  });

  it('keeps the first floor for the whole away-episode (no re-snapshot on arrivals)', () => {
    const h = mount(base, false);
    h.update(base, true);
    h.update([...base, msg('d', 400)], true);
    expect(h.count()).toBe(1);
    // Scrolling further while still away must not re-baseline: d stays counted.
    h.update([...base, msg('d', 400), msg('e', 500)], true);
    expect(h.count()).toBe(2);
    h.unmount();
  });

  it('resets on return to the edge, and a new away-episode starts a fresh floor', () => {
    const withNew = [...base, msg('d', 400)];
    const h = mount(base, false);
    h.update(base, true);
    h.update(withNew, true);
    expect(h.count()).toBe(1);
    h.update(withNew, false); // back at the edge — d has been seen
    expect(h.count()).toBe(0);
    h.update(withNew, true); // away again — floor is now 400
    expect(h.count()).toBe(0);
    h.update([...withNew, msg('e', 500)], true);
    expect(h.count()).toBe(1);
    h.unmount();
  });

  it('an empty transcript snapshots a zero floor without crashing', () => {
    const h = mount([], false);
    h.update([], true);
    expect(h.count()).toBe(0);
    h.update([msg('a', 100)], true);
    expect(h.count()).toBe(1);
    h.unmount();
  });
});
