/**
 * SwipeToReply — direction-inversion coverage (leftward claims/fires; rightward never does), plus
 * the TRIGGER threshold and enabled=false contracts.
 *
 * SwipeToReply hand-builds its own PanResponder and keeps its decision logic (isHorizontal, the
 * pull clamp, the trigger arm/disarm) inline inside the PanResponder config rather than as exported
 * pure functions — unlike useTabSwipe's nextAxis/readCommit, there is no pure function to import
 * and unit test directly. So this suite drives the actual wrapped handlers RN's Responder System
 * calls (`on{Move}ShouldSet{Responder,ResponderCapture}`, `onResponder{Move,Release}` — see
 * `panHandlers` in react-native's PanResponder.js), with a hand-built minimal touchHistory fixture
 * standing in for a real touch stream. That pins a slice of RN's own plumbing (gestureState.dx/dy
 * are derived from touch centroids, not read off the event directly) that a pure-function test
 * wouldn't need to — but there is no seam to test the direction inversion any other way without
 * refactoring the primitive, which this change intentionally left alone.
 *
 * One rule keeps the touchHistory fixture honest: RN's PanResponder ACCUMULATES dx/dy across every
 * call that updates gestureState (onMoveShouldSetResponderCapture and onResponderMove both do — see
 * TouchHistoryMath's centroid math), so reusing an event across two such calls on the same instance
 * would double-count the pull. Every test below mounts its OWN tree and makes at most one
 * gestureState-updating call, so the dx/dy passed in is exactly the dx/dy the component's callback
 * sees.
 */
import React from 'react';
import {Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {SwipeToReply} from './SwipeToReply';

/**
 * The minimal touchHistory-shaped fixture PanResponder's own math (TouchHistoryMath) needs to
 * derive gestureState.dx/dy for a single-touch drag: one active touch whose current-vs-previous
 * page position is exactly (dx, dy), starting from a fresh gesture (gestureState.dx/dy at 0).
 */
function moveEvent(dx: number, dy: number) {
  return {
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          startPageX: 0,
          startPageY: 0,
          previousPageX: 0,
          previousPageY: 0,
          currentPageX: dx,
          currentPageY: dy,
          startTimeStamp: 0,
          previousTimeStamp: 0,
          currentTimeStamp: 10,
        },
      ],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 10,
    },
  };
}

/** The Animated.View SwipeToReply spreads {...responder.panHandlers} onto — the only node in the
 *  tree carrying the raw responder callbacks under test. */
function panNode(tree: ReactTestRenderer) {
  const node = tree.root.findAll(n => typeof n.props?.onResponderMove === 'function')[0];
  if (!node) throw new Error('no pan-responder node found — is SwipeToReply enabled?');
  return node;
}

/** Capture-phase should-set (threshold 10 — claims a swipe that starts ON the bubble's ⋯/reaction
 *  chips). Also primes gestureState.dx/dy for a same-instance bubbleClaims() call afterward. */
function captureClaims(tree: ReactTestRenderer, dx: number, dy: number): boolean {
  const fn = panNode(tree).props.onMoveShouldSetResponderCapture as (e: unknown) => boolean;
  return fn(moveEvent(dx, dy));
}

/** Bubble-phase should-set (threshold 4 — claims a swipe over the empty gutter). Reads whatever
 *  gestureState a prior captureClaims() call on the SAME tree already primed; it doesn't update it,
 *  so it's safe to call afterward without disturbing the fixture's one-mutating-call invariant. */
function bubbleClaims(tree: ReactTestRenderer): boolean {
  const fn = panNode(tree).props.onMoveShouldSetResponder as (e: unknown) => boolean;
  return fn({});
}

function move(tree: ReactTestRenderer, dx: number, dy: number): void {
  const fn = panNode(tree).props.onResponderMove as (e: unknown) => void;
  fn(moveEvent(dx, dy));
}

function release(tree: ReactTestRenderer): void {
  // SwipeToReply's own release handler takes no arguments (it reads only its `armed` ref), so the
  // event value passed through here is never inspected.
  const fn = panNode(tree).props.onResponderRelease as (e: unknown) => void;
  fn({});
}

/** Every tree mounted by the running test, unmounted in afterEach — several tests mount more than
 *  one instance (one to probe should-set claims, another to drive move+release), and a settled
 *  Animated.spring can still leave its final requestAnimationFrame tick pending when a test ends. */
let liveTrees: ReactTestRenderer[] = [];

function mount(enabled = true): {tree: ReactTestRenderer; onReply: jest.Mock} {
  const onReply = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SwipeToReply onReply={onReply} enabled={enabled}>
        <Text>row</Text>
      </SwipeToReply>,
    );
  });
  liveTrees.push(tree);
  return {tree, onReply};
}

afterEach(() => {
  const trees = liveTrees;
  liveTrees = [];
  for (const t of trees) act(() => t.unmount());
});

/** The release handler fires onReply only once the spring-back settles (see the component's own
 *  comment on why) — a real, non-native-driven Animated.spring under Jest (no NativeAnimatedModule,
 *  so `useNativeDriver: true` falls back to the JS timing loop — react-native's own
 *  shouldUseNativeDriver), exactly the mechanism LogScreen.modal.test.tsx flushes with a real-timer
 *  wait for its Animated.timing. speed:18/bounciness:0 is a fast, ~critically-damped spring that
 *  settles well under a second in practice; 1.5s leaves comfortable margin. */
async function flushSpring(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
  });
}

describe('SwipeToReply — inverted to leftward', () => {
  it('a leftward drag past TRIGGER claims the responder (both call sites) and fires onReply once the spring settles', async () => {
    // Claim: -50px clears both the bubbling empty-gutter threshold (4) and the stricter
    // capture-phase threshold (10) used over the bubble's own ⋯/reaction-chip Pressables.
    const {tree: claimTree} = mount();
    expect(captureClaims(claimTree, -50, 5)).toBe(true);
    expect(bubbleClaims(claimTree)).toBe(true);

    // Fire: committing past TRIGGER (40) then releasing fires onReply — but not before the spring
    // that snaps the row back to rest has finished (the janky-keyboard fix this component documents).
    const {tree, onReply} = mount();
    act(() => move(tree, -50, 5));
    act(() => release(tree));
    expect(onReply).not.toHaveBeenCalled();
    await flushSpring();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('a leftward drag that stops short of TRIGGER does not fire', async () => {
    const {tree, onReply} = mount();
    act(() => move(tree, -20, 2)); // |dx| 20 < TRIGGER (40)
    act(() => release(tree));
    await flushSpring();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('a rightward drag never claims the responder (both call sites) and never fires', async () => {
    // Rightward is now the app-wide "go back" gesture — SwipeToReply must vacate it entirely.
    const {tree: claimTree} = mount();
    expect(captureClaims(claimTree, 50, 5)).toBe(false);
    expect(bubbleClaims(claimTree)).toBe(false);

    // Defense in depth: even if the responder were somehow granted anyway, the move handler's own
    // clamp (`Math.min(0, ...)`) refuses to arm on a positive dx, so release still can't fire.
    const {tree, onReply} = mount();
    act(() => move(tree, 50, 5));
    act(() => release(tree));
    await flushSpring();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('a dominantly-vertical drag never claims, at either call site', () => {
    // |dx|=20 alone clears both the 4px and 10px minimums, but dy=40 is well past the 1.2x
    // horizontal-dominance requirement (20 > 40*1.2 is false) — a scroll must win.
    const {tree: claimTree} = mount();
    expect(captureClaims(claimTree, -20, 40)).toBe(false);
    expect(bubbleClaims(claimTree)).toBe(false);
  });

  it('enabled: false renders children bare — no gutter, no pan responder', () => {
    const {tree} = mount(false);
    expect(tree.root.findAll(n => typeof n.props?.onResponderMove === 'function')).toHaveLength(0);
    const text = tree.root.findAllByType(Text);
    expect(text).toHaveLength(1);
    expect(text[0]!.props.children).toBe('row');
  });
});
