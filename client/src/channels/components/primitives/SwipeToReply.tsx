/**
 * SwipeToReply — wrap a message row to make it swipe-to-reply, Telegram-style.
 *
 * Dragging anywhere in the row to the RIGHT past a small threshold reveals a ↩ glyph in the left
 * gutter and, on release, fires `onReply()`. The row springs back either way. Built on the RN
 * `PanResponder` (no gesture-handler dependency). The whole row is the hit target (full width,
 * including the empty space beside the bubble), and a clearly-horizontal drag is claimed even in
 * the capture phase — so a swipe that starts ON the bubble (over the ⋯/reaction chips) still
 * triggers a reply — while a tap or a vertical scroll is left untouched. Works identically whether
 * the soft keyboard is up or down (the transcript list sets keyboardShouldPersistTaps="handled").
 */
import React, {useRef} from 'react';
import {Animated, PanResponder, StyleSheet, Text, View} from 'react-native';
import {colors} from '../../tokens';

const TRIGGER = 40; // px of pull that commits the reply (forgiving — a short flick is enough)
const MAX_PULL = 88; // px the row can travel
// A drag is "clearly horizontal" once it moves this many px sideways while staying dominantly
// horizontal. Used both to start the pan in the empty gutter and to CAPTURE it over child
// Pressables (the bubble's ⋯ / reaction chips) so a swipe-on-the-bubble isn't swallowed by them.
const isHorizontal = (dx: number, dy: number, min: number): boolean =>
  dx > min && dx > Math.abs(dy) * 1.2;

export function SwipeToReply({
  onReply,
  enabled = true,
  children,
}: {
  onReply: () => void;
  enabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const translateX = useRef(new Animated.Value(0)).current;
  // Tracks whether the current drag has passed the trigger, so release knows to fire.
  const armed = useRef(false);

  const responder = useRef(
    PanResponder.create({
      // Start the pan in the empty part of the row (low threshold — feels responsive).
      onMoveShouldSetPanResponder: (_e, g) => enabled && isHorizontal(g.dx, g.dy, 4),
      // Claim a clearly-horizontal drag in the CAPTURE phase so a swipe that begins ON the bubble
      // (over the ⋯ button / reaction chips) still starts a reply instead of being eaten by them.
      // The slightly higher threshold keeps taps and vertical scrolls with their normal targets.
      onMoveShouldSetPanResponderCapture: (_e, g) => enabled && isHorizontal(g.dx, g.dy, 10),
      onPanResponderMove: (_e, g) => {
        const dx = Math.max(0, Math.min(g.dx, MAX_PULL));
        translateX.setValue(dx);
        armed.current = dx >= TRIGGER;
      },
      // Once a clearly-horizontal drag has been claimed (above), don't let an ancestor (the
      // transcript FlatList) steal it back mid-gesture — a vertical wobble partway through a
      // deliberate right-swipe must not cancel the reply. Vertical scrolling is unaffected: the
      // FlatList only ever gets a scroll gesture in the first place when ITS OWN capture check
      // (dominant vertical movement) wins before this responder is granted.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: () => {
        const fire = armed.current;
        armed.current = false;
        // Fire onReply (which focuses the composer input and pops the keyboard) only once the
        // row has finished springing back — starting the keyboard's layout transition while the
        // row is still animating back to rest made the spring look interrupted/janky.
        Animated.spring(translateX, {toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18}).start(() => {
          if (fire) onReply();
        });
      },
      onPanResponderTerminate: () => {
        armed.current = false;
        Animated.spring(translateX, {toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18}).start();
      },
    }),
  ).current;

  if (!enabled) return <>{children}</>;

  // ↩ glyph fades/scales in as the row is pulled; it sits in the left gutter, behind the row.
  const iconOpacity = translateX.interpolate({inputRange: [0, TRIGGER], outputRange: [0, 1], extrapolate: 'clamp'});
  const iconScale = translateX.interpolate({inputRange: [0, TRIGGER], outputRange: [0.6, 1], extrapolate: 'clamp'});

  return (
    <View style={s.root}>
      <Animated.View style={[s.gutter, {opacity: iconOpacity, transform: [{scale: iconScale}]}]} pointerEvents="none">
        <View style={s.iconCircle}><Text style={s.icon}>↩</Text></View>
      </Animated.View>
      {/* Full-width pannable layer: the touch target is the whole row, not just the narrow bubble. */}
      <Animated.View style={[s.pan, {transform: [{translateX}]}]} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {width: '100%'},
  pan: {width: '100%'},
  gutter: {position: 'absolute', left: 14, top: 0, bottom: 0, justifyContent: 'center'},
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {color: colors.accent, fontSize: 16, lineHeight: 18},
});
