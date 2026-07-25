/**
 * EmptyState — the app's single "nothing here yet" surface.
 *
 * A quiet bordered badge (an emoji Icon in the house style), a one-line title, a supporting line,
 * and an OPTIONAL primary action. Extracted verbatim from the notifications center's empty block —
 * the one surface that already did this right (a badge + "You're all caught up" + a subline) — so
 * every empty list in the app speaks the same way instead of a bare grey sentence. The frontend
 * rule it encodes: an empty screen is an invitation to act, not a dead end.
 *
 * Emoji-only badge on purpose: emoji ARE the app's icon language (see ui/icons), so the glyph
 * carries the on-brand touch with none of the async-measure flash a gradient <Svg> disc would add
 * at this small a size. The action, when given, is the one accent control the surface offers
 * (compose, new message, create) — omitted where the surface already pins that action elsewhere
 * (e.g. the feed's always-present composer header).
 */
import React from 'react';
import {StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';
import {Press} from './Press';
import {Icon} from './icons';
import {colors, radius, weight, DENSE_MAX_FONT_SCALE} from './theme';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
}

export interface EmptyStateProps {
  /** Emoji glyph for the badge (house icon style, e.g. '💬', '✉️', '📡'). */
  icon: string;
  /** One-line headline — the primary message. Sentence case, interface voice. */
  title: string;
  /** Supporting line under the title. Keep it to one sentence. */
  subtitle?: string;
  /** The single accent action this surface offers. Omit where the action lives elsewhere. */
  action?: EmptyStateAction;
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({icon, title, subtitle, action, style}: EmptyStateProps): React.JSX.Element {
  return (
    <View style={[s.wrap, style]}>
      <View style={s.badge}>
        <Icon name={icon} size={22} />
      </View>
      <Text style={s.title} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{title}</Text>
      {subtitle ? (
        <Text style={s.sub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{subtitle}</Text>
      ) : null}
      {action ? (
        <Press style={s.action} onPress={action.onPress} accessibilityLabel={action.label}>
          <Text style={s.actionText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{action.label}</Text>
        </Press>
      ) : null}
    </View>
  );
}

const BADGE = 52;
const s = StyleSheet.create({
  // Mirrors the notifications center's empty block: centred column, generous vertical air.
  wrap: {alignItems: 'center', gap: 10, paddingVertical: 64, paddingHorizontal: 40},
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {fontSize: 15, fontWeight: weight.semibold, color: colors.textPrimary, textAlign: 'center'},
  sub: {fontSize: 13, lineHeight: 19, color: colors.textMuted, textAlign: 'center', maxWidth: 280},
  // The one accent control the surface offers — spaced a touch below the copy.
  action: {
    marginTop: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  actionText: {fontSize: 14, fontWeight: weight.semibold, color: colors.onAccent},
});
