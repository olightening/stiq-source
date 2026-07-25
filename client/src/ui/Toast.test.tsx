/**
 * Toast — the app's brief, non-blocking confirmation surface.
 *
 * What these pin, in order of how badly they'd bite:
 *  - it says NOTHING on mount, and nothing on a re-render — only a genuine advance of `nonce` speaks
 *    (the trigger is a count of relay-confirmed posts; see AppRuntime.postsDelivered);
 *  - a nonce going BACKWARDS is a reset, not news (the counter lives on an AppRuntime instance);
 *  - a burst shows ONE toast, not a stack;
 *  - it dismisses itself, and it can never swallow a tap.
 */
import 'react-native';
import React from 'react';
import {Text, View} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {Toast} from './Toast';

// The toast is an Animated sequence on timers; fake timers + an explicit unmount keep a live
// animation from leaking past the test (the SendProgress.test.tsx pattern).
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

const shown = (tree: renderer.ReactTestRenderer): boolean => tree.toJSON() !== null;

/** Concatenated visible text (Text nodes render their children as props, not instances). */
const textOf = (tree: renderer.ReactTestRenderer): string =>
  tree.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .filter((c): c is string => typeof c === 'string')
    .join('');

/** Run the animation forward far enough for a shown toast to have fully faded out. */
function runOut(): void {
  act(() => {
    jest.advanceTimersByTime(5_000);
  });
}

describe('Toast trigger discipline', () => {
  it('shows nothing on mount, however high the nonce already is', () => {
    // A remount (screen swap, hot reload) must not replay a confirmation the user already had.
    const tree = render(<Toast text="✓ Posted" nonce={7} />);
    expect(shown(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('shows nothing when re-rendered with an UNCHANGED nonce', () => {
    // The snapshot behind this re-renders constantly (every emit); only a real landing is news.
    const tree = render(<Toast text="✓ Posted" nonce={3} />);
    act(() => tree.update(<Toast text="✓ Posted" nonce={3} />));
    act(() => tree.update(<Toast text="✓ Posted" nonce={3} />));
    expect(shown(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('shows exactly once when the nonce advances, with the text it was given', () => {
    const tree = render(<Toast text="✓ Posted" nonce={0} />);
    expect(shown(tree)).toBe(false);

    act(() => tree.update(<Toast text="✓ Posted" nonce={1} />));
    expect(shown(tree)).toBe(true);
    expect(textOf(tree)).toContain('Posted');
    act(() => tree.unmount());
  });

  it('stays silent when the nonce goes BACKWARDS (a reset is not a confirmation)', () => {
    // postsDelivered is per-AppRuntime-instance, so a swapped runtime restarts it at 0. Treating any
    // CHANGE as a trigger would fire a "Posted" for a post nobody just made.
    const tree = render(<Toast text="✓ Posted" nonce={5} />);
    act(() => tree.update(<Toast text="✓ Posted" nonce={0} />));
    expect(shown(tree)).toBe(false);

    // …and the reset is adopted, so the NEXT real post still confirms (silence must not be sticky).
    act(() => tree.update(<Toast text="✓ Posted" nonce={1} />));
    expect(shown(tree)).toBe(true);
    act(() => tree.unmount());
  });
});

describe('Toast behaviour', () => {
  it('auto-dismisses without any interaction', () => {
    const tree = render(<Toast text="✓ Posted" nonce={0} />);
    act(() => tree.update(<Toast text="✓ Posted" nonce={1} />));
    expect(shown(tree)).toBe(true);

    runOut();
    expect(shown(tree)).toBe(false); // gone on its own — no button, no tap, no dismissal
    act(() => tree.unmount());
  });

  it('never blocks interaction while it is up', () => {
    // It covers the whole screen to float above every layout; without pointerEvents="none" it would
    // eat every tap underneath. A confirmation that freezes the app is worse than no confirmation.
    const tree = render(<Toast text="✓ Posted" nonce={0} />);
    act(() => tree.update(<Toast text="✓ Posted" nonce={1} />));

    const wrap = tree.root.findAllByType(View)[0]!;
    expect(wrap.props.pointerEvents).toBe('none');
    act(() => tree.unmount());
  });

  it('coalesces a burst into ONE toast and restarts its timer, never a stack', () => {
    // Two posts landing together (a burst, or a reconnect flushing the queue) advance the counter
    // twice within a second. Two overlapping toasts would sit on top of each other.
    //
    // The timings below are load-bearing, not padding: a toast's full life is FADE_IN(160) +
    // hold(1800) + FADE_OUT(220) = 2180ms. Toast #1 starts at t=0 and would therefore be gone by
    // t=2180 if the second landing did NOT restart it. So the assertion has to straddle that
    // instant — an earlier check passes whether or not the restart happened and proves nothing.
    const LIFE_MS = 160 + 1_800 + 220;
    const tree = render(<Toast text="✓ Posted" nonce={0} />);
    act(() => tree.update(<Toast text="✓ Posted" nonce={1} />)); // toast #1 starts at t=0
    act(() => jest.advanceTimersByTime(1_000)); // t=1000
    act(() => tree.update(<Toast text="✓ Posted" nonce={2} />)); // second landing → restart

    // Still exactly one toast node, not two.
    expect(tree.root.findAllByType(Text)).toHaveLength(1);
    expect(shown(tree)).toBe(true);

    // Past the point where toast #1 would have expired on its own — still up, because the second
    // landing restarted it rather than queueing behind it.
    act(() => jest.advanceTimersByTime(LIFE_MS - 1_000 + 200)); // t ≈ 2380 > 2180
    expect(shown(tree)).toBe(true);
    expect(tree.root.findAllByType(Text)).toHaveLength(1);

    // …and the restarted toast still dismisses itself on its own schedule (t=1000+2180).
    runOut();
    expect(shown(tree)).toBe(false);
    act(() => tree.unmount());
  });
});
