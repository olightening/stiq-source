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
 */
import React, {useEffect} from 'react';
import {StyleSheet, type StyleProp, type ViewStyle} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {colors} from './theme';

/**
 * The shared drill-in entrance: a ~120 ms 12 px slide-up at full opacity.
 *
 * Driven by a `useAnimatedStyle` transform, NOT reanimated's `entering` layout-animation prop.
 * On iOS an `entering` animation applied to a `position: absolute` overlay silently breaks the
 * whole subtree's touch handling — the drill-in renders correctly but is completely tap-dead (a
 * channel opened from the Updates tab, for instance, could not be backed out of or interacted with
 * at all). A plain animated-style transform reproduces the exact same motion on the UI thread while
 * the view stays a normal, fully-interactive `Animated.View`. Also applied to the bespoke overlays
 * (thread / DM / profile) that keep their own styles but move the same way every other drill-in does.
 */
export function useSubScreenSlideIn(): ReturnType<typeof useAnimatedStyle> {
  const translateY = useSharedValue(12);
  useEffect(() => {
    translateY.value = withTiming(0, {duration: 120, easing: Easing.out(Easing.quad)});
  }, [translateY]);
  return useAnimatedStyle(() => ({transform: [{translateY: translateY.value}]}));
}

export interface SubScreenProps {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export function SubScreen({style, children}: SubScreenProps): React.JSX.Element {
  const slideIn = useSubScreenSlideIn();
  return (
    <Animated.View style={[styles.overlay, slideIn, style]}>
      {children}
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
