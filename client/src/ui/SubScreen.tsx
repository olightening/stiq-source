/**
 * SubScreen — full-screen drill-in overlay root (UI smoothness overhaul Phase 4.3,
 * PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md).
 *
 * Sub-screens (channel view, group view, create/new-message, …) used to render as `flex: 1`
 * siblings that replaced the tab body in normal layout flow — they teleported in with no
 * transition, and they fought the always-mounted tab stage (Phase 4.1) for flex space. This
 * wrapper renders them the way the codebase's proven overlays already work (threadOverlay /
 * dmOverlay: absolute inset-0 over the root SafeAreaView, opaque background, explicit top inset)
 * and adds a light reanimated entrance: a ~120 ms 12 px slide-up at FULL opacity, on the UI thread.
 *
 * Why no fade: the entrance must never start transparent. A sub-screen can open over a surface
 * that is NOT the one the user was looking at — a cross-tab deep link (Updates → channel) lands
 * over the target tab's bare list, and even a same-tab open reflows the underlay (the header/dock
 * unmount when `onSubScreen` flips). An opacity-0 start lets all of that show through for the
 * fade's whole duration, which reads as "flickered to another screen, then the real one opened".
 * Opaque-from-frame-one means the destination is present and readable in the very commit the tap
 * lands — the slide alone supplies the motion.
 *
 * Exit is deliberately instant (no `exiting`): reanimated exit animations keep an unmounting
 * subtree alive while the chrome (header/dock) is already remounting underneath, and that
 * interplay can't be device-verified this round — entering alone delivers the perceived-smoothness
 * win with none of that risk.
 *
 * SWIPE-BACK (2026-07-27, PLAN_SWIPE_BACK_GESTURE_2026-07-27.md): this is the view that carries
 * `colors.bg` — the opaque background a sub-screen needs so the tab body underneath never shows
 * through (see `styles.overlay` below) — which is exactly why the swipe-back drag translates THIS
 * view specifically: sliding the one opaque layer to the right is what reveals the genuine screen
 * behind, for free, with no parallax or dim layer of its own. `useSubScreenTransition` (below) owns
 * both this entrance and that drag as ONE `useAnimatedStyle` transform, because a view has exactly
 * one `transform` prop and two independent reanimated tweens cannot both drive it without one
 * silently stomping the other's writes.
 */
import React, {useEffect} from 'react';
import {StyleSheet, type GestureResponderHandlers, type StyleProp, type ViewStyle} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {colors} from './theme';
import {useSwipeBack} from './SwipeBack';
import {SwipeOptOutContext, type SwipeOptOutHandlers} from './swipeOptOut';

/**
 * The shared drill-in motion: a ~120 ms 12 px entrance slide-up at full opacity, PLUS (2026-07-27)
 * swipe-back's translateX, composed onto the same view as ONE transform — see the module doc's
 * SWIPE-BACK paragraph for why this cannot be two separate `useAnimatedStyle` calls.
 *
 * The entrance is driven by a `useAnimatedStyle` transform, NOT reanimated's `entering` layout-
 * animation prop. On iOS an `entering` animation applied to a `position: absolute` overlay silently
 * breaks the whole subtree's touch handling — the drill-in renders correctly but is completely
 * tap-dead (a channel opened from the Updates tab, for instance, could not be backed out of or
 * interacted with at all). A plain animated-style transform reproduces the exact same motion on the
 * UI thread while the view stays a normal, fully-interactive `Animated.View`. Also used by the
 * bespoke overlays (thread / channel-post / DM / profile) that keep their own absolute-positioning
 * styles but move the same way every other drill-in does — via MainScreen's `SwipeBackOverlay`.
 *
 * Pass `onSwipeBack` to opt this sub-screen into the drag; omitted (or `swipeEnabled: false`), the
 * returned `panHandlers` is `{}` and the returned `style` is pixel-identical to the plain entrance —
 * a caller that passes no options gets exactly the motion that shipped before the swipe existed.
 *
 * `onBack` MUST be the same identifier the page's own header `‹` button calls (SwipeBack.tsx's
 * ownership rule) — where a page has inner pages (GroupView's manage/chat, NotificationsScreen's
 * settings/list), that identifier already peels one level, so the swipe and the button can never
 * drift apart.
 */
export function useSubScreenTransition(opts?: {
  onSwipeBack?: () => void;
  swipeEnabled?: boolean;
}): {
  /** ONE transform array: entrance translateY composed with swipe translateX. */
  style: ReturnType<typeof useAnimatedStyle>;
  /** `{}` when `onSwipeBack` is omitted — spreading it is then a true no-op, not merely a disabled
   *  responder, so a non-swiping caller ends up with exactly the props it shipped with before. */
  panHandlers: GestureResponderHandlers;
  optOut: SwipeOptOutHandlers;
} {
  const translateY = useSharedValue(12);
  useEffect(() => {
    translateY.value = withTiming(0, {duration: 120, easing: Easing.out(Easing.quad)});
  }, [translateY]);

  const onSwipeBack = opts?.onSwipeBack;
  // useSwipeBack is called UNCONDITIONALLY (rules of hooks) even for a sub-screen that never swipes —
  // `enabled: false` there means its responder never claims and its translateX never leaves 0, so
  // composing it into the transform below is always safe, never just conditionally correct.
  const swipe = useSwipeBack({
    enabled: !!onSwipeBack && (opts?.swipeEnabled ?? true),
    onBack: onSwipeBack ?? NOOP,
  });

  const style = useAnimatedStyle(() => ({
    transform: [{translateX: swipe.translateX.value}, {translateY: translateY.value}],
  }));

  return {
    style,
    panHandlers: onSwipeBack ? swipe.panHandlers : EMPTY_PAN_HANDLERS,
    optOut: swipe.optOut,
  };
}

/** Stable no-op so a non-swiping `useSwipeBack` call never has a fresh `onBack` identity to ignore. */
const NOOP = (): void => {};
/** Module-scope so a caller that never opts in spreads the exact same empty object every render. */
const EMPTY_PAN_HANDLERS: GestureResponderHandlers = {};

export interface SubScreenProps {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /** Wire this to the SAME function the screen's own header `‹` calls to enable swipe-to-dismiss.
   *  Omitted entirely (not passed as a no-op) on the pages the plan excludes — editors, LockScreen,
   *  the three tab roots, every sheet/dialog/picker. */
  onSwipeBack?: () => void;
  /** Withhold just the drag while still expecting to pass `onSwipeBack` — e.g. a mode within an
   *  otherwise-swipeable page that must temporarily behave like an editor. Defaults true. */
  swipeEnabled?: boolean;
}

export function SubScreen({style, children, onSwipeBack, swipeEnabled}: SubScreenProps): React.JSX.Element {
  const transition = useSubScreenTransition({onSwipeBack, swipeEnabled});
  return (
    <Animated.View style={[styles.overlay, transition.style, style]} {...transition.panHandlers}>
      <SwipeOptOutContext.Provider value={transition.optOut}>{children}</SwipeOptOutContext.Provider>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Mirrors MainScreen's threadOverlay: cover the whole stage (whose origin already clears the iOS
  // notch — the header unmounts while any sub-screen is open, so the stage spans the root), opaque
  // so the tab body underneath never shows through, above the tab layers' z=0. The DM overlay
  // (z=15) and profile overlay (z=20) deliberately stack higher.
  overlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, zIndex: 10},
});
