/**
 * ProgressBar — a thin determinate progress line.
 *
 * Built for the Tor-connect banner: the daemon's bootstrap percent arrives in coarse ~1 Hz jumps,
 * so the fill EASES to each new value (RN Animated on the layout width) instead of snapping, turning
 * a 30–90s cold connect into visible forward motion rather than a surface that looks hung. Renders
 * nothing when `percent` is null/≤0, so a genuinely dead circuit — App.tsx clears the percent when
 * Tor gives up — never shows a frozen bar that would read as "still making progress".
 *
 * Width animation runs off the native driver by necessity (layout width isn't a transform); it's a
 * single 2px bar, so the cost is negligible.
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
    const anim = Animated.timing(w, {toValue: pct, duration: 300, useNativeDriver: false});
    anim.start();
    return () => anim.stop();
  }, [pct, visible, w]);

  if (!visible) { return null; }
  return (
    <View style={[s.track, {height, backgroundColor: trackColor}, style]} pointerEvents="none">
      <Animated.View
        style={{
          height,
          backgroundColor: color,
          width: w.interpolate({inputRange: [0, 100], outputRange: ['0%', '100%']}),
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  track: {width: '100%', overflow: 'hidden'},
});
