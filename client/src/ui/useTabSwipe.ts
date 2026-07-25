/**
 * useTabSwipe — sideways flick navigation between the top-level tabs (Current · Spaces · Updates).
 *
 * Attach the returned `panHandlers` to the tab stage: a clearly-horizontal drag across the content
 * moves one tab along the dock's fixed order — left for the next tab, right for the previous one.
 * Built on the RN `PanResponder`, the same no-gesture-handler idiom as SwipeToReply (this app has no
 * react-native-gesture-handler dependency).
 *
 * WHY A FLICK AND NOT A DRAGGED PAGER: the three tab bodies are absolutely-stacked, lazily-mounted
 * TabLayers (only one is visible; the others are frozen and may never have mounted at all). Making
 * the content follow the finger would mean un-hiding — and, on a first swipe, MOUNTING — a whole tab
 * body mid-gesture, which is exactly the stutter the UI-smoothness work removed. So the gesture is
 * resolved on RELEASE and the switch is carried by the stage's existing transition, which slides in
 * from the side the finger swept away.
 *
 * DIRECTIONAL LOCK (why a sideways swipe no longer fights the up/down scroll). This is the standard
 * react-native-gesture-handler idiom — `activeOffsetX` + `failOffsetY` — hand-built on PanResponder:
 * within a single touch the gesture commits to ONE axis and never switches (see `nextAxis`).
 *  - The horizontal swipe CLAIMS once the finger has travelled CLAIM_DX sideways AND is clearly more
 *    horizontal than vertical (CLAIM_DOMINANCE).  →  a tab swipe.
 *  - It FAILS the instant the finger has travelled FAIL_DY vertically first — the whole gesture is
 *    then handed to the vertical scroll underneath and can NEVER be reclaimed as a swipe, however far
 *    sideways it later drifts.  →  a scroll.
 * The lock is the whole fix for "the left/right swipe interferes with the up/down scroll": a
 * stateless per-frame ratio test (what this used to be) let a drag that began as a vertical scroll
 * cross the horizontal ratio later in its arc and yank the reader to another tab. FAIL_DY is set
 * BELOW CLAIM_DX so an up/down scroll — which always leads vertically — locks to scrolling before a
 * stray sideways wobble can ever claim it. The per-gesture state is reset at every touch start by
 * `onStartShouldSetPanResponderCapture` (fires ancestor-first for every touch, even one a child ends
 * up handling; it returns false, so it only observes — it never actually captures the touch).
 *
 * RESPONDER NEGOTIATION (why this coexists with everything already on screen). Verified on-device
 * 2026-07-23; the non-obvious things that had to be true before a swipe over the feed body worked:
 *  - The stage must NOT be `pointerEvents:"box-none"`. A box-none view can never become the touch
 *    responder, so its should-set handlers never even fire — the flick was silently dead. The stage
 *    is now default ("auto") and its TabLayer children still take every tap/scroll (see MainScreen).
 *  - The RELEASE check must not re-require a single active touch — at release the finger is already
 *    up (numberActiveTouches === 0), so gating the commit on `=== 1` claimed every swipe and then
 *    committed to nothing. `nextAxis` keeps the single-finger gate on the CLAIM (mid-drag) only, and
 *    `readCommit` (at release) never looks at the live touch count.
 *  - It claims in the BUBBLING phase (`onMoveShouldSetPanResponder`), not capture. The tab's FlatList
 *    is a VERTICAL list, so it ignores a horizontal drag natively and the move bubbles up to the
 *    stage uncontested; bubbling also means any DEEPER JS responder (e.g. a SwipeToReply row) still
 *    wins first, which capture would have steamrolled.
 *  - Vertical scrolling is untouched: a vertical drag trips FAIL_DY, the gesture locks to `vertical`,
 *    the stage declines, and the move stays with the FlatList. A single finger only — a pinch is
 *    never navigation.
 *
 * FLASH: because the gesture is caught this early, the tap-highlight flash on whatever sat under the
 * thumb is killed separately by a short press-in delay inside scroll regions (Press + PressDelayContext),
 * not here.
 *
 *  - CHIP RAILS opt OUT: a horizontal chip rail (feed sort/tag row, Spaces filter, the hearth's
 *    people rail) scrolls NATIVELY and would otherwise be stolen by this swipe — a native horizontal
 *    ScrollView doesn't join JS responder negotiation, so the stage's grant would win and the tab
 *    would switch instead of the rail scrubbing. Each rail spreads TabRailTouchContext's handlers
 *    onto its scroller, flipping a shared flag while the rail is touched; `isExcluded` then makes the
 *    stage stand down for that one touch, so the rail scrolls under the finger and only non-rail
 *    drags switch tab. Chips stay tappable either way (a tap never claims).
 */
import {createContext, useRef} from 'react';
import {PanResponder, type GestureResponderHandlers, type PanResponderGestureState} from 'react-native';

/** activeOffsetX — sideways travel (px) at which the stage CLAIMS the drag as a tab swipe. Kept low
 *  so a deliberate horizontal flick is caught before the feed's native vertical scroll can grab a
 *  diagonal, but above the horizontal wobble inside a vertical scroll or a tap. */
const CLAIM_DX = 12;
/** How much more horizontal than vertical the drag must be to CLAIM it. A real swipe arcs, so this is
 *  deliberately forgiving (~40° off horizontal still counts) — the old value of 1.8 only caught an
 *  almost-perfectly-flat drag, which is why the swipe felt like it "only worked when perfectly
 *  horizontal". It also breaks the tie when a fast flick crosses CLAIM_DX and FAIL_DY in one coarse
 *  frame: requiring ax ≥ ay·1.2 means such a frame only claims when it genuinely led horizontally. */
const CLAIM_DOMINANCE = 1.2;
/** failOffsetY — vertical travel (px) that permanently DISQUALIFIES the drag from being a tab swipe,
 *  handing the whole gesture to the scroll underneath. Set BELOW CLAIM_DX so an up/down scroll (which
 *  leads vertically) locks to scrolling before a stray sideways wobble can claim it — this asymmetry
 *  is what stops the left/right swipe from interfering with the up/down scroll. 12 : 10 (CLAIM_DX :
 *  FAIL_DY) splits the two axes at ~40° off horizontal, biased to protect the scroll. */
const FAIL_DY = 10;
/** Travel (px) that COMMITS the switch on release — a claimed drag that stops short simply does
 *  nothing, so the reader can always back out of a gesture they didn't mean. */
const COMMIT_DX = 45;
/** …or a shorter but decisive flick, measured in px/ms at release. */
const COMMIT_VX = 0.25;
/** Once claimed, COMMIT tolerates a lower horizontal ratio than the claim did: the gesture was
 *  already won as horizontal, so a normal downward arc at the end should still switch — only a drag
 *  that genuinely curved into a mostly-vertical sweep (dy well past dx) reads as an abort. */
const COMMIT_DOMINANCE = 0.75;

/** +1 = next tab (the finger swept LEFT), -1 = previous tab (the finger swept RIGHT). */
export type SwipeDirection = 1 | -1;

/**
 * Handlers a horizontal chip rail spreads onto its scroller so a sideways drag scrolls the rail
 * instead of switching tab. The rail flips a shared flag while it is being touched; the stage's
 * swipe reads that flag (via `isExcluded`) and stands down. Empty outside a provider — a safe no-op,
 * so a rail that spreads these without a provider above it simply behaves as before.
 */
export type RailTouchHandlers = {
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  onTouchCancel?: () => void;
};
export const TabRailTouchContext = createContext<RailTouchHandlers>({});

/**
 * Which axis a single touch has committed to. A gesture starts `pending` and locks to the FIRST axis
 * to cross its threshold — `horizontal` (a tab swipe) or `vertical` (yield to the scroll) — and never
 * switches for the rest of that touch. That one-way lock is the whole fix for the swipe-vs-scroll
 * conflict; see the DIRECTIONAL LOCK note in the header.
 */
export type Axis = 'pending' | 'horizontal' | 'vertical';

/**
 * The per-frame axis decision as a pure reducer (prev-axis → next-axis), so the thresholds are
 * covered by unit tests rather than only by hand on a device. The responder calls this on every move
 * and stores the result, honouring the lock: once `horizontal` or `vertical`, it stays.
 *
 * Order matters: the horizontal claim is checked FIRST, and its dominance test (CLAIM_DOMINANCE) is
 * what resolves a fast flick that crosses BOTH thresholds inside one coarse move event — such a frame
 * only claims horizontal when the drag genuinely led sideways; otherwise it falls through to the
 * vertical fail and yields to the scroll.
 */
export function nextAxis(prev: Axis, g: PanResponderGestureState): Axis {
  if (prev !== 'pending') return prev; // locked — decided once, honoured for the whole gesture
  if (g.numberActiveTouches !== 1) return 'pending'; // wait for single-finger clarity (a pinch is not a swipe)
  const ax = Math.abs(g.dx);
  const ay = Math.abs(g.dy);
  // activeOffsetX + dominance → a clearly-sideways drag claims the gesture as a tab swipe.
  if (ax >= CLAIM_DX && ax >= ay * CLAIM_DOMINANCE) return 'horizontal';
  // failOffsetY → any drag that has travelled far enough vertically yields to the scroll, for good.
  if (ay >= FAIL_DY) return 'vertical';
  return 'pending';
}

/**
 * The release decision: given a gesture that CLAIMED (so it was horizontal), was it decisive enough
 * to actually change tab? Far enough sideways, or a short flick thrown fast enough. Null means "let
 * go without moving anywhere" — a claimed drag is always abortable. Never re-checks the touch count:
 * at release the finger is already up (numberActiveTouches === 0).
 */
export function readCommit(g: PanResponderGestureState): SwipeDirection | null {
  const ax = Math.abs(g.dx);
  const ay = Math.abs(g.dy);
  const farEnough = ax >= CLAIM_DX;
  const decisive = ax >= COMMIT_DX || Math.abs(g.vx) >= COMMIT_VX;
  return farEnough && ax >= ay * COMMIT_DOMINANCE && decisive ? (g.dx < 0 ? 1 : -1) : null;
}

export function useTabSwipe({
  enabled,
  onSwipe,
  isExcluded,
}: {
  /** False while an opaque surface covers the stage (a drill-in sub-screen, a full-screen modal) —
   *  a swipe under an open post must not teleport the reader to another tab. */
  enabled: boolean;
  onSwipe: (direction: SwipeDirection) => void;
  /** Returns true while the current touch sits on an opted-out horizontal scroller (a chip rail),
   *  so the stage stands down and the rail scrolls itself. Read LIVE inside the responder, so pass a
   *  getter over a ref, never a plain boolean captured at render time. */
  isExcluded?: () => boolean;
}): GestureResponderHandlers {
  // PanResponder.create captures its callbacks ONCE (the responder must survive a whole gesture, so
  // it cannot be rebuilt per render). Live values therefore go through refs, or the handlers would
  // forever see the props from first mount.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;
  const isExcludedRef = useRef(isExcluded);
  isExcludedRef.current = isExcluded;
  // The directional lock's per-gesture state (see `nextAxis`). Reset at every touch start below.
  const axisRef = useRef<Axis>('pending');

  const responder = useRef(
    PanResponder.create({
      // Fires at the very START of every touch (capture phase, ancestor-first), even one that a child
      // ends up handling — the reliable "new gesture began" signal. We only use it to reset the axis
      // lock; returning false means we decline to capture, so the touch proceeds to its real target.
      onStartShouldSetPanResponderCapture: () => {
        axisRef.current = 'pending';
        return false;
      },
      // Bubbling claim: the tab's vertical FlatList ignores a horizontal drag, so the move bubbles up
      // to the stage. The axis lock decides — we take the gesture only once it has locked `horizontal`
      // (and never when disabled, or when the touch began on an opted-out chip rail).
      onMoveShouldSetPanResponder: (_e, g) => {
        if (!enabledRef.current || (isExcludedRef.current?.() ?? false)) return false;
        axisRef.current = nextAxis(axisRef.current, g);
        return axisRef.current === 'horizontal';
      },
      // Nothing above the stage wants this gesture, and letting an ancestor reclaim it mid-drag
      // would silently drop the swipe — but yielding is the safe default if one ever does.
      onPanResponderTerminationRequest: () => true,
      onPanResponderRelease: (_e, g) => {
        // Release only fires if we became the responder — i.e. the gesture locked `horizontal`. Ask
        // whether it was decisive enough to actually switch; a claimed-but-short drag changes nothing.
        const direction = enabledRef.current ? readCommit(g) : null;
        if (direction) onSwipeRef.current(direction);
      },
    }),
  ).current;

  return responder.panHandlers;
}
