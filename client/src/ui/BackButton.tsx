/**
 * BackButton — the app's standard "go back" affordance.
 *
 * A crisp, rounded chevron with an optional label, vertically centred so the glyph and text always
 * sit on the same line. It replaces the assorted ← / ‹ glyphs that were sized, weighted and aligned
 * differently on every screen (the arrow often riding a few pixels off the label's centre).
 *
 * The chevron is drawn from two borders on a rotated square rather than a font glyph: a self-
 * contained box has a predictable width, so it aligns cleanly next to the label at any size — unlike
 * a wide arrow glyph whose advance width left an uneven gap and whose baseline drifted per font.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';
import {colors} from './theme';

export interface BackButtonProps {
  onPress: () => void;
  /** Text shown after the chevron (e.g. "Back", "Channels"). Omit for an icon-only button. */
  label?: string;
  /** 'md' for post/profile headers, 'sm' for compact section headers. */
  size?: 'md' | 'sm';
  /** Glyph + label colour. Defaults to the accent blue. */
  tint?: string;
  /** Extra container style (e.g. to match a specific header's padding). */
  style?: StyleProp<ViewStyle>;
}

const SIZES = {
  md: {box: 11, thick: 2.2, radius: 1.5, label: 17, gap: 7},
  sm: {box: 9, thick: 2, radius: 1.25, label: 14, gap: 6},
} as const;

export function BackButton({
  onPress,
  label,
  size = 'md',
  tint = colors.accent,
  style,
}: BackButtonProps): React.JSX.Element {
  const z = SIZES[size];
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label ? `Back to ${label}` : 'Back'}
      style={({pressed}) => [s.row, {gap: z.gap}, style, pressed && s.pressed]}>
      {/* Rounded chevron: a square with only its top + left borders, rotated -45° so the corner
          points left. Small, fixed box → tight, reliable alignment beside the label. */}
      <View
        style={{
          width: z.box,
          height: z.box,
          borderTopWidth: z.thick,
          borderLeftWidth: z.thick,
          borderColor: tint,
          borderTopLeftRadius: z.radius,
          transform: [{rotate: '-45deg'}],
        }}
      />
      {label ? (
        <Text style={[s.label, {fontSize: z.label, color: tint}]} numberOfLines={1} allowFontScaling={false}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', paddingVertical: 4},
  pressed: {opacity: 0.55},
  label: {fontWeight: '600', includeFontPadding: false},
});
