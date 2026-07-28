/**
 * ProgressBar — a thin determinate progress line.
 *
 * Built for the Tor-connect banner: the daemon's bootstrap percent arrives in coarse ~1 Hz jumps,
 * so the fill EASES to each new value (RN Animated) instead of snapping, turning a 30–90s cold
 * connect into visible forward motion rather than a surface that looks hung. Renders nothing when
 * `percent` is null/≤0, so a genuinely dead circuit — App.tsx clears the percent when Tor gives up —
 * never shows a frozen bar that would read as "still making progress".
 *
 * The fill runs on the NATIVE driver: layout `width` can't be native-driven, but a fixed-width bar
 * scaled with `transform: scaleX` (anchored to the left edge via `transformOrigin`) produces the
 * identical growing-from-left fill and moves the whole animation off the JS thread. This is also why
 * `isInteraction: false` matters here specifically: every ticking Animated.timing that does NOT opt
 * out holds an InteractionManager handle for its duration, and this bar can run for most of a
 * 30–80s Tor connect — exactly when AppRuntime's deferred state-snapshot flush
 * (InteractionManager.runAfterInteractions) most needs to land, not queue behind a decorative
 * animation. useNativeDriver's default already implies isInteraction:false (isInteraction defaults
 * to `!useNativeDriver`), but it's set explicitly so this stays correct even if the driver choice
 * ever changes back.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {colors} from './theme';

export interface ProgressBarProps {
  /** 0–100. Null/undefined or ≤0 renders nothing. Values are clamped to the range. */
  percent: number | null | undefined;
  height?: number;
  color?: string;
  trackColor?: string;
  style?: StyleProp<ViewStyle>;
}

export function ProgressBar({
  percent,
  height = 2,
  color = colors.accent,
  trackColor = 'rgba(255,255,255,0.12)',
  style,
}: ProgressBarProps): React.JSX.Element | null {
  const visible = typeof percent === 'number' && percent > 0;
  const pct = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0;
  // Hook order stays constant (the early return is BELOW): the animated value always exists, it just
  // isn't painted while the bar is hidden.
  const w = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    // Only animate while the bar is actually shown. A hidden bar starting a timer is pure churn —
    // and in tests it becomes an async task that can outlive the test — so skip it, and stop any
    // in-flight animation on unmount so no callback fires after the component is gone.
    if (!visible) { return; }
    const anim = Animated.timing(w, {
      toValue: pct,
      duration: 300,
      useNativeDriver: true,
      isInteraction: false,
    });
    anim.start();
    return () => anim.stop();
  }, [pct, visible, w]);

  if (!visible) { return null; }
  return (
    <View style={[s.track, {height, backgroundColor: trackColor}, style]} pointerEvents="none">
      <Animated.View
        style={[
          s.fill,
          {
            height,
            backgroundColor: color,
            transform: [{scaleX: w.interpolate({inputRange: [0, 100], outputRange: [0, 1]})}],
          },
        ]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  track: {width: '100%', overflow: 'hidden'},
  fill: {width: '100%', transformOrigin: 'left'},
});
