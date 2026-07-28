/**
 * useScrollChrome — the show/hide animation must not survive unmount.
 *
 * Regression coverage for a real leak: `setChrome`'s hide branch calls `Animated.timing(...)
 * .start(callback)`, and nothing stopped that animation (or guarded its callback) on unmount. An
 * animation still in flight when the owning screen unmounted just kept running on its own timers,
 * disconnected from React's lifecycle, and its callback (`setChromeMounted(false)`) fired whenever
 * it eventually settled — touching state for a component nobody is showing anymore.
 *
 * Under Jest specifically this is worse than a quiet warning: `useNativeDriver: true` silently
 * falls back to the JS-driven timing path (there is no native animated module registered under
 * test — see `NativeAnimatedHelper.shouldUseNativeDriver`), so the hide animation runs on ordinary
 * JS timers exactly like any other leaked interval/timeout. A straggler like that can fire after
 * the module registry is torn down between test files, re-entering this hook with `Animated`
 * itself gone: "TypeError: TaskQueue: Error with task : Cannot read properties of undefined
 * (reading 'Value')" via InteractionManager's TaskQueue — which kills the whole worker process
 * mid-run, not just one test.
 *
 * Fake timers throughout (this codebase's established idiom for animation tests — see
 * SendProgress.test.tsx) so none of this depends on real wall-clock time.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {useScrollChrome, JUMP_AFTER, type ScrollChrome} from './useScrollChrome';

// Mirrors the hook's own (non-exported) HIDE_AFTER threshold.
const HIDE_AFTER = 80;

function scrollTo(chrome: ScrollChrome, y: number): void {
  (chrome.onScroll as unknown as (e: unknown) => void)({nativeEvent: {contentOffset: {y}}});
}

/** Mount a bare harness and capture the hook's live return value + a render counter. */
function mountChrome(): {
  tree: renderer.ReactTestRenderer;
  get current(): ScrollChrome;
  renderCount: () => number;
} {
  let captured!: ScrollChrome;
  let renders = 0;
  function Harness(): null {
    captured = useScrollChrome();
    renders += 1;
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness />);
  });
  return {
    tree,
    get current() {
      return captured;
    },
    renderCount: () => renders,
  };
}

describe('useScrollChrome', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('starts visible and mounted', () => {
    const h = mountChrome();
    expect(h.current.chromeMounted).toBe(true);
    expect(h.current.showJump).toBe(false);
    act(() => h.tree.unmount());
  });

  it('onScroll: hides only once the 220ms fade-out settles, not the instant the threshold is crossed', () => {
    const h = mountChrome();

    act(() => scrollTo(h.current, HIDE_AFTER + 20));
    // Still mounted — the hide sequence is fade-out THEN unmount, per the file's own doc comment.
    expect(h.current.chromeMounted).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(h.current.chromeMounted).toBe(false);

    act(() => h.tree.unmount());
  });

  it('onScroll: showJump flips at JUMP_AFTER independently of the hide threshold', () => {
    const h = mountChrome();

    act(() => scrollTo(h.current, JUMP_AFTER + 10));
    expect(h.current.showJump).toBe(true);

    act(() => scrollTo(h.current, 0));
    expect(h.current.showJump).toBe(false);
    expect(h.current.chromeMounted).toBe(true); // y<=0 also re-shows instantly (mount step of show)

    act(() => h.tree.unmount());
  });

  it('syncOffset (the programmatic-restore path) applies INSTANTLY — no timer advance needed', () => {
    const h = mountChrome();

    act(() => h.current.syncOffset(JUMP_AFTER + 60));
    // No jest.advanceTimersByTime call above: syncOffset must not depend on the animation clock.
    expect(h.current.chromeMounted).toBe(false);
    expect(h.current.showJump).toBe(true);

    act(() => h.current.syncOffset(0));
    expect(h.current.chromeMounted).toBe(true);
    expect(h.current.showJump).toBe(false);

    act(() => h.tree.unmount());
  });

  it('unmounting mid-hide stops the animation and never calls back into state (the fixed leak)', () => {
    const h = mountChrome();

    // Observe the live animated value independently of React state entirely — this is what proves
    // the ANIMATION itself was stopped, not merely that its completion callback got silenced.
    let liveValue = 1;
    const sub = h.current.chromeAnim.addListener(({value}) => {
      liveValue = value;
    });

    act(() => scrollTo(h.current, HIDE_AFTER + 20)); // starts the 220ms hide (chromeAnim: 1 -> 0)
    expect(liveValue).toBe(1); // scheduled, not yet ticked — nothing has advanced the clock yet

    const rendersBeforeUnmount = h.renderCount();

    act(() => h.tree.unmount()); // MID-ANIMATION — well before the 220ms duration elapses

    // Advance well past the animation's full duration — enough to flush the entire chain of ticks
    // it would need to reach completion (confirmed 220 ticks of 1ms complete a 220ms animation).
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(1000);
      });
    }).not.toThrow();

    // The animation was actually stopped on unmount: its value is frozen wherever it was and never
    // reaches the hide target (0). Before the fix, the leaked animation kept running on its own
    // timers — unrelated to React's tree — and reached 0 regardless of the unmount.
    expect(liveValue).toBe(1);

    // And no post-unmount callback re-entered this hook: unmounting produced no further render.
    expect(h.renderCount()).toBe(rendersBeforeUnmount);

    h.current.chromeAnim.removeListener(sub);
  });
});
