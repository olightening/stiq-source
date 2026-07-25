/**
 * Toast — a brief, non-blocking confirmation that floats above the current screen and dismisses
 * itself. The app's ONLY transient-message surface; there is deliberately no second one.
 *
 * Why this exists next to StiqAlert rather than reusing it: StiqAlert is a MODAL (a backdrop, a
 * button, and a tap required to get rid of it). That is right for something the user must answer —
 * "Couldn't post right now" — and wrong for a confirmation, which must never interrupt. This is the
 * inverse in every respect: no backdrop, no buttons, `pointerEvents="none"` so it cannot swallow a
 * tap, and it disappears on its own.
 *
 * DECLARATIVE, not imperative — and that is the safety property, not a style preference. StiqAlert
 * exposes `stiqAlert(...)`, which any call site may fire for any reason; this component has exactly
 * one input (`nonce`) and can only ever say what its `text` already says. A caller cannot make it
 * announce something that did not happen; it can only be wired to a value that does not lie. Today
 * that value is AppSnapshot.postsDelivered, which AppRuntime.confirmDelivery increments only when
 * the relay has actually taken a post.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {colors, radius, space, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from './theme';
import {BOTTOM_DOCK_CLEARANCE} from './BottomDock';

const FADE_IN_MS = 160;
const FADE_OUT_MS = 220;
/** How long the toast sits fully opaque before it starts fading. Long enough to read two words. */
const DEFAULT_HOLD_MS = 1_800;
/** Distance (px) the toast rises as it fades in — a small settle, not a slide. */
const RISE_PX = 8;

export interface ToastProps {
  /** The whole message, rendered verbatim. Keep it to a few words — this is a confirmation, not prose. */
  text: string;
  /**
   * The trigger. The toast appears when this value INCREASES, and only then — mounting does not show
   * it, and a re-render with an unchanged value does not either.
   *
   * A strict increase (rather than any change) is what makes a reset safe: the counter behind this
   * lives on an AppRuntime instance, so a value going BACKWARDS means a new/reloaded source, not a
   * new event to announce. Firing on that would show a confirmation nobody earned.
   */
  nonce: number;
  /** Override the visible hold. The fade in/out around it is fixed. */
  holdMs?: number;
}

export function Toast({text, nonce, holdMs = DEFAULT_HOLD_MS}: ToastProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(RISE_PX)).current;
  // Last nonce acted on. Seeded from the FIRST render so a mount (or a remount carrying an already-
  // advanced counter) is silent: only movement observed while mounted is news.
  const seen = useRef(nonce);

  useEffect(() => {
    const advanced = nonce > seen.current;
    seen.current = nonce;
    if (advanced) setVisible(true);
  }, [nonce]);

  // Show → hold → fade → unmount. `nonce` is a dependency on purpose: a second confirmation arriving
  // while one is still up RESTARTS this single toast instead of stacking a second one on top of it
  // (two posts can land within the same second — a burst, or a reconnect flushing a queue).
  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    rise.setValue(RISE_PX);
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: FADE_IN_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(rise, {
          toValue: 0,
          duration: FADE_IN_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_OUT_MS,
        delay: holdMs,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }),
    ]);
    anim.start(({finished}) => {
      if (finished) setVisible(false);
    });
    return () => anim.stop();
  }, [visible, nonce, holdMs, opacity, rise]);

  if (!visible) return null;
  return (
    // pointerEvents="none" on the full-screen wrapper: the toast is a message, never a target. It
    // covers the whole screen while up, so without this it would eat every tap underneath it — a
    // confirmation that blocks the app is worse than no confirmation. Returning null when idle means
    // it isn't even mounted the rest of the time.
    <View pointerEvents="none" style={s.wrap}>
      <Animated.View style={[s.toast, {opacity, transform: [{translateY: rise}]}]}>
        <Text style={s.text} accessibilityLiveRegion="polite" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    // Floats above the centred bottom nav dock (BottomDock). The dock lives inside the screen's
    // SafeAreaView, so on iOS it sits a home-indicator inset higher than this full-screen wrapper's
    // own bottom edge; the margin over BOTTOM_DOCK_CLEARANCE covers that inset so the toast clears the
    // dock on both platforms. (The right-side JumpButton is a different column and pointerEvents:none
    // means the toast never blocks a tap regardless.)
    paddingBottom: BOTTOM_DOCK_CLEARANCE + space.xl,
  },
  toast: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: {width: 0, height: 8},
    elevation: 12,
  },
  text: {
    fontSize: typeScale.label,
    color: colors.textPrimary,
    fontWeight: weight.semibold,
  },
});
