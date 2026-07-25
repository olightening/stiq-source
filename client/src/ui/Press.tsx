/**
 * Press — the app's single interaction primitive (UI smoothness overhaul, Phase 1;
 * PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md).
 *
 * Bare RN `Pressable` has NO built-in feedback, and ~55 of the 72 files using it never opted
 * into any pressed state — which is exactly why "every button is stale and weak". Press wraps
 * Pressable and drives feedback with reanimated shared values, so once the touch lands the
 * animation itself runs on the UI thread, immune to JS-driven re-render jank.
 *
 * Variants (locked user decision: scale ~0.97 spring + opacity/colour dim; no ripple, no haptics):
 * - `button` (default): touch-down → scale to 0.97 (fast ~80ms ease-out) + dim to 0.75 opacity;
 *   release → spring back. For pills, chips, icon buttons, CTAs, dock tabs.
 * - `row`: background highlight only (a soft light tint painted UNDER the content, no scale) —
 *   for full-width list rows, sheet/menu items, chat bubbles. The highlight picks up the row's
 *   own borderRadius so rounded rows stay rounded while pressed.
 * - `bare`: no feedback. Escape hatch for call sites that draw their own pressed state a
 *   different way — must be justified at the call site.
 *
 * Press-in delay (2026-07-23, retuned): inside a scroll/swipe region a parent sets PressDelayContext,
 * and Press holds the pressed feedback for a SHORT beat (SCROLL_PRESS_DELAY_MS) so a starting scroll or
 * tab-swipe cancels the highlight before it shows — like a native scroll view suppressing the highlight
 * while you scroll (delaysContentTouches). RN's own `unstable_pressDelay` does the cancelling: if the
 * touch is terminated (the tab-swipe claims it) or moves off before the delay elapses, onPressIn never
 * fires. The delay is a knife-edge: too long and a *tap* feels dead, because RN only fires onPressIn at
 * RELEASE for a sub-delay tap (so the button reacts after your finger has already lifted) and onPressIn
 * not at all until the delay elapses on a press-and-hold. So this is tuned SNAPPY — just long enough to
 * swallow the first ~40ms of a real drag, short enough that a tap still feels immediate. Outside such a
 * region the context is 0, so standalone buttons (the dock, dialog CTAs) stay instant. A caller's
 * explicit `unstable_pressDelay` always wins.
 *
 * Defaults baked in so migration is subtraction, not addition:
 * - `hitSlop` 8 on `button` unless the caller passes one (most small targets in the audit
 *   lacked it). Rows/bare get none by default — full-width rows sit flush against their
 *   neighbours, so a default slop would make adjacent rows fight over edge touches.
 * - `disabled` → opacity 0.45 and feedback suppressed (one consistent disabled look).
 * - `accessibilityRole="button"` unless overridden.
 *
 * Migration note: unlike Pressable, `style` here is a plain StyleProp (no `({pressed}) => …`
 * function form). Sites that changed styles while pressed pass those extras via `pressedStyle`;
 * Press applies them while the finger is down. Everything else passes through untouched.
 */
import React, {useContext, useMemo, useState} from 'react';
import {
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Soft light tint painted under row content while pressed (dark-only palette — see theme.ts). */
const ROW_HIGHLIGHT = 'rgba(255,255,255,0.07)';

const PRESS_IN_MS = 80;
const DIM_OPACITY = 0.75;
const PRESSED_SCALE = 0.97;
const DISABLED_OPACITY = 0.45;
/** Light-damping spring for the release bounce-back. */
const RELEASE_SPRING = {damping: 14, stiffness: 220, mass: 0.6} as const;

/** How long a scroll/swipe region asks its descendant Press-es to hold the pressed feedback, so a
 *  drag that turns into a scroll or a tab-swipe cancels the highlight before it shows. Deliberately
 *  SNAPPY: a real drag crosses the tab-swipe's 12px claim (or the native scroll slop) within a few
 *  tens of ms, so ~40ms is enough to swallow the flash on all but the slowest crawl of a drag, while
 *  keeping a genuine tap feeling immediate. The old native-scroll figure (~130ms, iOS
 *  delaysContentTouches ≈ 0.15s) was too long here — it made every button in the tabs feel dead,
 *  because RN fires onPressIn only at RELEASE for a sub-delay tap and not until the delay elapses on a
 *  hold. If a slow drag ever flashes the thing under the thumb, nudge this up a little. */
export const SCROLL_PRESS_DELAY_MS = 40;

/** Press-in delay for descendant Press-es. 0 (the default, outside any provider) = instant, for
 *  standalone buttons that have no competing scroll/swipe. A scroll/swipe region provides
 *  SCROLL_PRESS_DELAY_MS so the highlight is suppressed when the touch turns into a drag. */
export const PressDelayContext = React.createContext(0);

export interface PressProps extends Omit<PressableProps, 'style' | 'children'> {
  variant?: 'button' | 'row' | 'bare';
  /** Plain style only (no Pressable function form — see migration note above). */
  style?: StyleProp<ViewStyle>;
  /** Extra style merged while pressed (replaces the old `({pressed}) => …` pattern). */
  pressedStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode | ((state: {pressed: boolean}) => React.ReactNode);
}

export function Press({
  variant = 'button',
  style,
  pressedStyle,
  disabled,
  hitSlop,
  onPressIn,
  onPressOut,
  accessibilityRole,
  children,
  ...rest
}: PressProps): React.JSX.Element {
  const scale = useSharedValue(1);
  const dim = useSharedValue(1);
  const highlight = useSharedValue(0);
  // JS-side pressed state is only tracked when a caller actually needs it (pressedStyle or a
  // render-prop child) — the core feedback never re-renders, it lives in the shared values.
  const needsPressedState = pressedStyle != null || typeof children === 'function';
  const [pressed, setPressed] = useState(false);

  const feedback = disabled ? 'none' : variant;

  // Inside a scroll/swipe region, hold the pressed feedback for a beat so a starting scroll or
  // tab-swipe cancels it before it shows (see the header). A caller's explicit delay still wins.
  const scrollPressDelay = useContext(PressDelayContext);
  const pressDelay = rest.unstable_pressDelay ?? scrollPressDelay;

  const buttonAnim = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
    opacity: dim.value,
  }));
  const highlightAnim = useAnimatedStyle(() => ({opacity: highlight.value}));

  const handlePressIn = (e: GestureResponderEvent) => {
    if (feedback === 'button') {
      scale.value = withTiming(PRESSED_SCALE, {
        duration: PRESS_IN_MS,
        easing: Easing.out(Easing.quad),
      });
      dim.value = withTiming(DIM_OPACITY, {duration: PRESS_IN_MS});
    } else if (feedback === 'row') {
      highlight.value = withTiming(1, {duration: 60});
    }
    if (needsPressedState) setPressed(true);
    onPressIn?.(e);
  };

  const handlePressOut = (e: GestureResponderEvent) => {
    if (feedback === 'button') {
      scale.value = withSpring(1, RELEASE_SPRING);
      dim.value = withTiming(1, {duration: 140});
    } else if (feedback === 'row') {
      highlight.value = withTiming(0, {duration: 180});
    }
    if (needsPressedState) setPressed(false);
    onPressOut?.(e);
  };

  // Row highlight adopts the row's own rounding so pressed corners match the row's corners.
  const highlightRadius = useMemo(() => {
    if (variant !== 'row') return null;
    const flat = StyleSheet.flatten(style) || {};
    return {
      borderRadius: flat.borderRadius,
      borderTopLeftRadius: flat.borderTopLeftRadius,
      borderTopRightRadius: flat.borderTopRightRadius,
      borderBottomLeftRadius: flat.borderBottomLeftRadius,
      borderBottomRightRadius: flat.borderBottomRightRadius,
    };
  }, [variant, style]);

  const composedStyle: StyleProp<ViewStyle> = [
    style,
    disabled ? s.disabled : null,
    pressed && pressedStyle ? pressedStyle : null,
  ];

  const content =
    typeof children === 'function' ? children({pressed}) : children;

  if (variant === 'button') {
    return (
      <AnimatedPressable
        {...rest}
        unstable_pressDelay={pressDelay}
        disabled={disabled}
        hitSlop={hitSlop ?? 8}
        accessibilityRole={accessibilityRole ?? 'button'}
        accessibilityState={{disabled: !!disabled, ...rest.accessibilityState}}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        // Animated opacity would override the static disabled treatment (it merges last),
        // so the animated style is dropped entirely while disabled — feedback is off anyway.
        style={disabled ? composedStyle : [composedStyle, buttonAnim]}>
        {content}
      </AnimatedPressable>
    );
  }

  return (
    <Pressable
      {...rest}
      unstable_pressDelay={pressDelay}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityState={{disabled: !!disabled, ...rest.accessibilityState}}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={composedStyle}>
      {variant === 'row' ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, s.rowHighlight, highlightRadius, highlightAnim]}
        />
      ) : null}
      {content}
    </Pressable>
  );
}

const s = StyleSheet.create({
  disabled: {opacity: DISABLED_OPACITY},
  rowHighlight: {backgroundColor: ROW_HIGHLIGHT},
});
