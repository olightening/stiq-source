/**
 * SwipeBackView — end-to-end wiring test: does the rendered PanResponder actually drive `onBack`
 * through the reducers pinned separately (and exhaustively) in SwipeBack.test.ts? react-test-renderer
 * has no real touch dispatch, so the gesture is driven the same way Press.test.tsx drives
 * `onPressIn`/`onPressOut` and PictureChip.transition.test.tsx drives its animation — by calling
 * handler props straight off the rendered node, inside `act()`.
 *
 * ONE NON-OBVIOUS THING THIS FILE HAS TO WORK AROUND: `PanResponder.create(config).panHandlers` (see
 * node_modules/react-native/Libraries/Interaction/PanResponder.js) does NOT expose the config's own
 * key names on the object it spreads onto the view — `onMoveShouldSetPanResponder` becomes
 * `onMoveShouldSetResponder`, `onPanResponderMove`/`onPanResponderRelease` become
 * `onResponderMove`/`onResponderRelease`, etc. — and the raw handlers read gesture geometry (dx/dy/vx)
 * out of `event.touchHistory` themselves rather than accepting a gestureState argument, because on a
 * real device that history is populated by the native responder system, not by the caller. There is
 * no shortcut around this: to genuinely exercise `useSwipeBack`'s wired-up handlers (as opposed to
 * re-testing the pure reducers, already covered), this file builds one minimal, honest touch-history
 * fake — see `moveEvent` below — rather than calling the config-named methods that simply don't exist
 * on the rendered node.
 *
 * Reanimated runs its REAL module under jest (see jest.setup.js's `setUpTests()`), so the commit
 * path's `withTiming(..., finished => runOnJS(onBack)())` genuinely needs the fake-timer clock
 * advanced before its completion callback fires — same `advanceTimersByTime` idiom
 * PictureChip.transition.test.tsx uses for its own withTiming callbacks.
 *
 * Commits are driven by VELOCITY (dx small enough that only vx decides) rather than by screen-width
 * fraction, so these tests don't depend on the jest environment's mocked window width (750, per
 * react-native's own jest preset) — the width-relative distance branch is already pinned directly in
 * SwipeBack.test.ts.
 */
import 'react-native';
import React from 'react';
import {Text, type GestureResponderEvent} from 'react-native';
import renderer, {act, type ReactTestInstance, type ReactTestRenderer} from 'react-test-renderer';
import {SwipeBackView, SWIPE_BACK} from './SwipeBack';

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

/** The host node carrying the RAW responder handlers — found structurally (by a prop `useSwipeBack`
 *  actually produces on the rendered tree, per the file header), not by a test-only label, so a
 *  refactor of SwipeBackView's tree can't quietly satisfy this by relabelling something else (same
 *  rationale as PictureChip's `frame()` helper and Press.test.tsx's `findPressRoot`). SwipeBackView
 *  renders exactly one Reanimated.View with panHandlers spread onto it, so exactly one hit is right. */
function panRoot(tree: ReactTestRenderer): ReactTestInstance {
  const hits = tree.root.findAll(
    n => typeof n.type === 'string' && typeof n.props?.onMoveShouldSetResponder === 'function',
  );
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

/** Only what `onStartShouldSetResponderCapture` itself reads (see PanResponder.js) — a single active
 *  touch. Our own config's `onStartShouldSetPanResponderCapture` takes no arguments at all (it only
 *  resets refs), so nothing beyond this is required. */
const startEvent = {
  nativeEvent: {touches: [{}]},
  touchHistory: {numberActiveTouches: 1},
} as unknown as GestureResponderEvent;

/** Neither the raw `onResponderRelease` nor our own `onPanResponderRelease` handler reads the event
 *  itself (release uses whatever gestureState the prior move left behind) — an empty object is honest. */
const releaseEvent = {} as unknown as GestureResponderEvent;

/**
 * One touch, one hop: starts at (0, 0), reports itself at `(x, y)` `ts` milliseconds later. Fed
 * through `TouchHistoryMath`'s centroid math (see TouchHistoryMath.js), this produces EXACTLY
 * `gestureState.dx === x`, `dy === y`, `vx === x / ts` on a gestureState that started at `{dx: 0, dy:
 * 0}` — i.e. immediately after the touch-start reset `onStartShouldSetResponderCapture` performs —
 * because a single move-should-set-CAPTURE dispatch (always run, whether or not a config supplies
 * that key — see PanResponder.js's `onMoveShouldSetResponderCapture`) is enough to update the
 * internal gestureState once, before the bubbling `onMoveShouldSetResponder` reads it back out.
 */
function moveEvent(x: number, y: number, ts: number): GestureResponderEvent {
  return {
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          previousPageX: 0,
          previousPageY: 0,
          currentPageX: x,
          currentPageY: y,
          previousTimeStamp: 0,
          currentTimeStamp: ts,
        },
      ],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ts,
    },
  } as unknown as GestureResponderEvent;
}

/**
 * Drive one full touch — start, a claim-checking move, then (only if claimed) a release — through the
 * found node's RAW handler props, in the same order RN's real responder system calls them for a
 * single move dispatch that is never granted to any OTHER view first.
 */
function drag(tree: ReactTestRenderer, to: {x: number; y: number; ts: number}): {claimed: boolean} {
  const node = panRoot(tree);
  act(() => {
    node.props.onStartShouldSetResponderCapture(startEvent);
  });
  const evt = moveEvent(to.x, to.y, to.ts);
  act(() => {
    node.props.onMoveShouldSetResponderCapture(evt); // unconditionally updates gestureState from touchHistory
  });
  let claimed = false;
  act(() => {
    claimed = node.props.onMoveShouldSetResponder(evt) as boolean; // this is where useSwipeBack's own handler runs
  });
  if (claimed) {
    act(() => {
      node.props.onResponderRelease(releaseEvent);
    });
  }
  return {claimed};
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('SwipeBackView', () => {
  it('a committed rightward drag fires onBack once the exit tween settles — not a frame before', () => {
    const onBack = jest.fn();
    const tree = render(
      <SwipeBackView onBack={onBack}>
        <Text>body</Text>
      </SwipeBackView>,
    );

    // dx=60 over 16ms: clearly rightward (claims), and fast enough to commit on velocity alone
    // (60/16 ≈ 3.75 ≥ COMMIT_VX) while staying far short of width*COMMIT_FRACTION (750*0.28=210) — so
    // this pins the WIRING through the velocity branch without depending on the mocked window width.
    const {claimed} = drag(tree, {x: 60, y: 2, ts: 16});
    expect(claimed).toBe(true);
    expect(onBack).not.toHaveBeenCalled(); // the page is still sliding — onBack fires on settle, not release

    act(() => {
      jest.advanceTimersByTime(SWIPE_BACK.OUT_MS + 50);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('an aborted drag — claimed, but released short and slow — springs back and never calls onBack', () => {
    const onBack = jest.fn();
    const tree = render(
      <SwipeBackView onBack={onBack}>
        <Text>body</Text>
      </SwipeBackView>,
    );

    // dx=20 over 300ms: clearly rightward enough to CLAIM (>=CLAIM_DX), but well under COMMIT_MIN_DX
    // (40) and a low vx (20/300 ≈ 0.067 < COMMIT_VX) — short AND slow, so it can commit neither way.
    const {claimed} = drag(tree, {x: 20, y: 2, ts: 300});
    expect(claimed).toBe(true); // claimed as a swipe-back...

    act(() => {
      jest.advanceTimersByTime(2000); // ...but never committed, however long the spring is given to settle
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('enabled: false never claims the drag, however far or fast it moves — so it can never commit', () => {
    const onBack = jest.fn();
    const tree = render(
      <SwipeBackView enabled={false} onBack={onBack}>
        <Text>body</Text>
      </SwipeBackView>,
    );

    // Same shape as the committed case above — would have claimed and committed if enabled.
    const {claimed} = drag(tree, {x: 200, y: 0, ts: 16});
    expect(claimed).toBe(false);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onBack).not.toHaveBeenCalled();
  });
});
