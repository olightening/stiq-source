/**
 * SwipeBack — drag a full-screen pushed page to the RIGHT to dismiss it, Telegram/WhatsApp-style.
 * PLAN_SWIPE_BACK_GESTURE_2026-07-27.md is the full design; this is the one gesture engine both of
 * that plan's consumers (the sub-screen transition hook, and modal-hosted pages via `SwipeBackView`)
 * are built on.
 *
 * `onBack` MUST be the exact same identifier the page's own header `‹` calls (the plan's "ownership
 * rule" — whoever owns the back affordance owns the swipe). This is what keeps the gesture from being
 * a second, divergent exit path alongside the button and the Android BACK key.
 *
 * Built on the RN `PanResponder` driving a reanimated shared value — this app has no
 * react-native-gesture-handler (adding it would rewrite touch handling under ~570 Pressables), so the
 * drag samples on the JS thread same as `SwipeToReply` and `useTabSwipe` already do, but the *settle*
 * animations (the exit slide, the abort spring) run on the UI thread regardless of what the JS thread
 * is doing at release — the same JS-samples/UI-settles split `SwipeToReply` shipped on chat rows.
 *
 * THE THREE-WAY PHASE, not the tab swipe's two-way axis lock: `useTabSwipe`'s `nextAxis` only ever
 * needs `horizontal` vs `vertical`, because EITHER horizontal direction is a valid tab swipe. Swipe-
 * back only owns the RIGHTWARD half of the horizontal axis — `SwipeToReply` on chat rows owns the
 * LEFTWARD half (drag a row left to reply) — so a leftward-leading drag has to be permanently
 * disqualified rather than simply not-yet-claimed, or a reply drag that overshoots left-then-right
 * would be free to un-decline itself into a swipe-back mid-gesture. That third outcome is `declined`;
 * see `nextSwipeBackPhase`.
 *
 * RESPONDER NEGOTIATION — same shape as `useTabSwipe`, restated here because getting any one of these
 * backwards is silent (the gesture just never fires, or fires on top of something that should have
 * won first):
 *  - `onStartShouldSetPanResponderCapture` returns FALSE. It exists only to reset per-gesture state at
 *    the instant a new touch begins (fires ancestor-first, even for a touch a child ends up handling).
 *  - The actual claim happens in `onMoveShouldSetPanResponder`, which is BUBBLING — never capture. A
 *    deeper JS responder (a `SwipeToReply` row inside the very page this hook wraps) must get first
 *    refusal; capture would steamroll it. This is also why the two gestures are safe layered on the
 *    same screen: SwipeToReply's own claim only ever fires on a leftward lead, and by the time a
 *    rightward drag would reach this hook's ancestor, SwipeToReply has already declined it.
 *  - `onPanResponderTerminationRequest` returns FALSE once granted: a transcript FlatList (or any
 *    other scroller inside the page) must not steal a drag already committed to a swipe-back mid-arc.
 *  - `onPanResponderTerminate` (something ELSE forcibly took the responder away, e.g. an incoming
 *    system dialog) still springs the page back — the finger's intent is unknowable at that point, so
 *    treat it exactly like an aborted release rather than leaving the page hanging mid-drag.
 *
 * THE PAN LAYER MUST NOT BE `pointerEvents: 'box-none'`. A box-none view can never become the touch
 * responder — its should-set handlers never even fire — which is exactly how the tab swipe was
 * silently dead before 2026-07-23 (see `useTabSwipe.ts`). `SwipeBackView` deliberately leaves
 * `pointerEvents` unset (the RN default, "auto") for the same reason.
 *
 * Width comes from `useWindowDimensions()`, never a module-scope `Dimensions.get` — the device can
 * rotate (or, on some Android builds, enter split-screen) between mount and gesture, and a stale
 * width would make COMMIT_FRACTION's threshold wrong in exactly the cases most likely to catch a user
 * by surprise.
 */
import {useMemo, useRef} from 'react';
import {
  PanResponder,
  StyleSheet,
  useWindowDimensions,
  type GestureResponderHandlers,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {SwipeOptOutContext, type SwipeOptOutHandlers} from './swipeOptOut';

/**
 * Tunable thresholds, gathered into one object (unlike `useTabSwipe`'s individual consts) so every
 * call site and every test-table row reads unambiguously as "swipe-back's own number" — this file's
 * constants and `useTabSwipe`'s otherwise look interchangeable at a glance despite meaning different
 * things (a tab swipe's CLAIM_DX guards BOTH directions; this one guards only the rightward half).
 *
 *  - `CLAIM_DX` / `CLAIM_DOMINANCE` / `FAIL_DY` — copied verbatim from `useTabSwipe`'s activeOffsetX /
 *    dominance / failOffsetY (device-tuned 2026-07-23). Swipe-back's CLAIM is the same directional
 *    lock shape, just one-sided; see `nextSwipeBackPhase` for the sidedness itself.
 *  - `COMMIT_FRACTION` / `COMMIT_VX` / `COMMIT_MIN_DX` — the release decision (`readSwipeBackCommit`):
 *    either the page has travelled a substantial fraction of the screen, or a short drag was thrown
 *    fast enough to read as a decisive flick. Both are abortable right up to the finger lifting.
 *  - `OUT_MS` — the exit tween's duration once committed; see `useSwipeBack`'s release handler.
 */
export const SWIPE_BACK = {
  CLAIM_DX: 12,
  CLAIM_DOMINANCE: 1.2,
  FAIL_DY: 10,
  COMMIT_FRACTION: 0.28,
  COMMIT_VX: 0.3,
  COMMIT_MIN_DX: 40,
  OUT_MS: 180,
} as const;

/**
 * 'pending' = undecided; 'back' = claimed as a swipe-back; 'declined' = permanently disqualified for
 * the rest of this touch (a leftward lead, or a vertical lead — see `nextSwipeBackPhase`).
 */
export type SwipeBackPhase = 'pending' | 'back' | 'declined';

/**
 * The per-frame phase decision as a pure reducer (prev-phase → next-phase), same contract as
 * `useTabSwipe`'s `nextAxis`: once the result is not `'pending'` it is LOCKED — the responder stores
 * it and this function returns it unchanged for the rest of the gesture, however far the finger later
 * travels. That lock is what keeps a drag that curves hard right after leading left from suddenly
 * becoming a swipe-back mid-arc (and, symmetrically, what keeps a genuinely-claimed swipe-back from
 * being un-claimed by a later vertical wobble).
 *
 * Order matters, and is checked in exactly this sequence:
 *  1. `numberActiveTouches !== 1` → stays `'pending'`. A pinch is never navigation; wait for
 *     single-finger clarity before deciding anything (checked first and every frame, not just once,
 *     since a second finger can land mid-drag).
 *  2. `dx <= -CLAIM_DX` → `'declined'`. A leftward-LEADING drag can never become a swipe-back. This is
 *     the whole fix for coexisting with `SwipeToReply` (which drags chat rows LEFT to reply): the two
 *     gestures are disjoint by SIGN, not merely by a threshold, so there is no drag angle that could
 *     satisfy both at once. Checked before the rightward claim so a drag that starts left and only
 *     later swings right stays declined — it already showed its intent.
 *  3. `dx >= CLAIM_DX && dx >= |dy| * CLAIM_DOMINANCE` → `'back'`. A clearly-rightward, clearly-
 *     horizontal drag claims. Same dominance shape as `useTabSwipe`'s claim (a real thumb swipe arcs,
 *     so ~40° off horizontal still counts).
 *  4. `|dy| >= FAIL_DY` → `'declined'`. A vertical lead locks the touch away from swipe-back for good,
 *     handing it to whatever scroll is underneath (a transcript FlatList, a settings list). Set BELOW
 *     CLAIM_DX, same asymmetry `useTabSwipe` uses, so an up/down scroll — which always leads vertically
 *     — locks out before a stray sideways wobble could ever claim it.
 *  5. Otherwise `'pending'` — not enough travel yet in any direction to decide.
 */
export function nextSwipeBackPhase(prev: SwipeBackPhase, g: PanResponderGestureState): SwipeBackPhase {
  if (prev !== 'pending') return prev; // locked — decided once, honoured for the whole gesture
  if (g.numberActiveTouches !== 1) return 'pending'; // a pinch is never navigation
  if (g.dx <= -SWIPE_BACK.CLAIM_DX) return 'declined'; // leftward-leading — SwipeToReply's lane, never ours
  if (g.dx >= SWIPE_BACK.CLAIM_DX && g.dx >= Math.abs(g.dy) * SWIPE_BACK.CLAIM_DOMINANCE) return 'back';
  if (Math.abs(g.dy) >= SWIPE_BACK.FAIL_DY) return 'declined'; // vertical lead — hand off to the scroll
  return 'pending';
}

/**
 * The release decision: given a gesture that CLAIMED (phase `'back'`), was it decisive enough to
 * actually dismiss the page? A long, deliberate drag past `COMMIT_FRACTION` of the screen, OR a short
 * drag thrown fast enough (`COMMIT_VX`) to clear a minimum distance (`COMMIT_MIN_DX`, so a barely-
 * moved but fast-measured jitter can't commit). False means "let go without committing" — a claimed
 * drag is always abortable, same as the tab swipe's `readCommit`.
 */
export function readSwipeBackCommit(g: PanResponderGestureState, width: number): boolean {
  return g.dx >= width * SWIPE_BACK.COMMIT_FRACTION || (g.vx >= SWIPE_BACK.COMMIT_VX && g.dx >= SWIPE_BACK.COMMIT_MIN_DX);
}

export function useSwipeBack({
  enabled,
  onBack,
  isExcluded,
}: {
  /** False when this page/mode must not be swiped away right now (an editor, a covered surface). */
  enabled: boolean;
  /** The SAME function the page's own `‹` header button calls — see the module doc's ownership rule. */
  onBack: () => void;
  /** Returns true while the current touch sits on an opted-out region (a composer input, a rail) not
   *  wrapped in this page's own `SwipeOptOutContext.Provider` — read LIVE inside the responder, so
   *  pass a getter over a ref/boolean, never a value captured at render time. */
  isExcluded?: () => boolean;
}): {
  panHandlers: GestureResponderHandlers;
  /** Ready-made {transform:[{translateX}]}; compose with your own transforms via `translateX` instead. */
  style: ReturnType<typeof useAnimatedStyle>;
  translateX: SharedValue<number>;
  /** Provide this through SwipeOptOutContext so nested rails/inputs can stand the gesture down. */
  optOut: SwipeOptOutHandlers;
} {
  // PanResponder.create captures its callbacks ONCE (built inside useRef's initializer — the
  // responder must survive a whole gesture, so it cannot be rebuilt per render; React re-evaluates
  // this expression on every render regardless, but useRef discards every result after the first).
  // Live values therefore go through refs, refreshed on every render — the exact idiom `useTabSwipe`
  // uses and for the identical reason: without it, the handlers would forever see first-mount props.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const isExcludedRef = useRef(isExcluded);
  isExcludedRef.current = isExcluded;

  // Rotation/split-screen can change this between mount and gesture, so it is read fresh every
  // render into a ref the responder (built once) can still see live — see the module doc.
  const {width} = useWindowDimensions();
  const widthRef = useRef(width);
  widthRef.current = width;

  // The directional lock's per-gesture state (see `nextSwipeBackPhase`). Reset at every touch start.
  const phaseRef = useRef<SwipeBackPhase>('pending');

  // Flipped by `optOut`'s handlers below while a nested rail/input is itself being touched, and
  // consulted by the responder ALONGSIDE the caller's own `isExcluded` — so a nested opt-out works
  // even when the caller wired none of its own. Reset at every touch start, same as `phaseRef`.
  const nestedOptOutRef = useRef(false);

  const translateX = useSharedValue(0);

  // The abort/terminate settle: a non-bouncing spring back to 0. Params match what `SwipeToReply`
  // already ships for its own release-without-reply — one consistent "I let go and it's not
  // happening" feel across every drag-to-navigate gesture in the app. `overshootClamping` is the
  // point: the page must not spring PAST its own resting edge and briefly reveal false travel the
  // finger never asked for.
  const springBack = (): void => {
    translateX.value = withSpring(0, {damping: 20, stiffness: 220, mass: 0.6, overshootClamping: true});
  };

  const responder = useRef(
    PanResponder.create({
      // Fires at the very START of every touch (capture phase, ancestor-first), even one a child ends
      // up handling. Used only to reset the per-gesture locks; returning false means we decline to
      // capture, so the touch proceeds to its real target uncontested.
      onStartShouldSetPanResponderCapture: () => {
        phaseRef.current = 'pending';
        nestedOptOutRef.current = false;
        return false;
      },
      // Bubbling claim — see the module doc's RESPONDER NEGOTIATION note for why this must never be
      // capture. Stands down when disabled, or when the touch began on a nested opt-out (either the
      // caller's own `isExcluded`, or a descendant that stood itself down via `optOut`).
      onMoveShouldSetPanResponder: (_e, g) => {
        if (!enabledRef.current || nestedOptOutRef.current || (isExcludedRef.current?.() ?? false)) {
          return false;
        }
        phaseRef.current = nextSwipeBackPhase(phaseRef.current, g);
        return phaseRef.current === 'back';
      },
      onPanResponderMove: (_e, g) => {
        translateX.value = Math.max(0, Math.min(g.dx, widthRef.current));
      },
      // Once granted, a transcript FlatList (or any other scroller inside the page) must not steal a
      // committed drag mid-arc — mirrors SwipeToReply's identical guard on chat rows.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        if (readSwipeBackCommit(g, widthRef.current)) {
          // Slide the rest of the way off, THEN unmount via onBack — never the reverse order, or the
          // page would vanish out from under a still-animating frame.
          translateX.value = withTiming(
            widthRef.current,
            {duration: SWIPE_BACK.OUT_MS, easing: Easing.out(Easing.cubic)},
            finished => {
              if (finished) runOnJS(onBackRef.current)();
            },
          );
        } else {
          springBack();
        }
      },
      // Something else forcibly took the responder away mid-drag (e.g. a system dialog). The
      // finger's intent is unknowable at that point, so treat it exactly like an aborted release.
      onPanResponderTerminate: () => {
        springBack();
      },
    }),
  ).current;

  const style = useAnimatedStyle(() => ({transform: [{translateX: translateX.value}]}));

  // Handlers a nested rail/input spreads onto itself to stand THIS gesture down for its own touches —
  // see swipeOptOut.ts for the full mechanism. Stable identity (empty deps): the handlers only ever
  // flip a ref, never close over anything that changes.
  const optOut = useMemo<SwipeOptOutHandlers>(
    () => ({
      onTouchStart: () => {
        nestedOptOutRef.current = true;
      },
      onTouchEnd: () => {
        nestedOptOutRef.current = false;
      },
      onTouchCancel: () => {
        nestedOptOutRef.current = false;
      },
    }),
    [],
  );

  return {panHandlers: responder.panHandlers, style, translateX, optOut};
}

/**
 * Drop-in wrapper for modal-hosted pages (Settings, Notifications, Log, …): each such page is an
 * opaque Android `<Modal>` whose root `SafeAreaView` is already the backdrop, so `SwipeBackView` wraps
 * just the page's own content and reveals that same backdrop as it slides away — no window
 * transparency surgery needed. In-window pages don't use this component at all; they get the same
 * translateX through `useSubScreenTransition` composed onto their own existing entrance transform
 * (see SubScreen.tsx) because THEIR opaque layer already carries a transform of its own, and two
 * animation systems cannot share one view's `transform` prop.
 *
 * Deliberately does NOT set `pointerEvents`. A `box-none` view can never become the touch responder —
 * see the module doc's note on `useTabSwipe`'s identical, silently-dead-until-2026-07-23 bug. Leaving
 * it unset (RN's default, "auto") is what lets this view actually claim the drag while its own
 * children still receive every tap and scroll natively.
 */
export function SwipeBackView({
  enabled = true,
  onBack,
  style,
  children,
}: {
  enabled?: boolean;
  onBack: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}): React.JSX.Element {
  const swipe = useSwipeBack({enabled, onBack});
  return (
    <Reanimated.View style={[styles.fill, style, swipe.style]} {...swipe.panHandlers}>
      <SwipeOptOutContext.Provider value={swipe.optOut}>{children}</SwipeOptOutContext.Provider>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({fill: {flex: 1}});
