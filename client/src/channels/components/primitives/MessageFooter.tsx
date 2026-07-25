/**
 * MessageFooter — the row under a post card's body. Per the handoff: the reaction chips + the
 * `💬 {replies}` button sit on the LEFT (all on ONE horizontal plane with the meta); the timestamp +
 * `⋯ More` sit on the RIGHT. The metrics (12px top margin, sizes) live here so every card footer is
 * identical. Reactions ride in via `leading` so a card shows reactions/replies/time/⋯ on one line.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import type {GradientSpec} from '../../../media/gradient';
import {colors, ctType, ctSpace, DENSE_MAX_FONT_SCALE} from '../../tokens';

export function MessageFooter({
  time,
  /** Comment affordance ("💬 9" / "💬 reply"). Shown on the left only when replies are enabled. */
  comment,
  /** Leading node on the LEFT, before the comment counter — e.g. the inline reaction chips. */
  leading,
  /** Extra trailing node, e.g. <SendProgress/>, placed left of the ⋯. */
  trailing,
  /** Private-channel-only: a small gradient-circle author avatar, rendered immediately left of the
   *  time text. Wrapped in a Pressable (with hitSlop) when `onPress` is given. Omit entirely for
   *  public cards — the footer then renders byte-identical to today's. */
  author,
  /** ⋯ overflow menu (right). */
  onMenu,
}: {
  time: string;
  comment?: {label: string; onPress: () => void};
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  author?: {seed: string; gradient?: GradientSpec; onPress?: () => void};
  onMenu?: () => void;
}): React.JSX.Element {
  return (
    <View style={s.row}>
      <View style={s.left}>
        {leading}
        {comment && (
          <Press onPress={comment.onPress}>
            <Text style={s.comment} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{comment.label}</Text>
          </Press>
        )}
      </View>
      <View style={s.right}>
        {trailing}
        {author ? (
          <View style={s.authorTimeGroup}>
            {author.onPress ? (
              <Press
                onPress={author.onPress}
                accessibilityLabel="Author">
                <GradientAvatar seed={author.seed} gradient={author.gradient} shape="circle" size={18} />
              </Press>
            ) : (
              <GradientAvatar seed={author.seed} gradient={author.gradient} shape="circle" size={18} />
            )}
            <Text style={s.time} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{time}</Text>
          </View>
        ) : (
          <Text style={s.time} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{time}</Text>
        )}
        {onMenu && (
          <Press onPress={onMenu} accessibilityLabel="message actions">
            <Text style={s.menuDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
          </Press>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: ctSpace.footerTop,
  },
  left: {flexDirection: 'row', alignItems: 'center', gap: ctSpace.chipGap, flexShrink: 1},
  right: {flexDirection: 'row', alignItems: 'center', gap: ctSpace.footerGap},
  /** Tighter gap (~7dp) between the author avatar and the time text, distinct from the wider gap
   *  the `right` row uses to separate its other clusters (trailing / this group / ⋯). */
  authorTimeGroup: {flexDirection: 'row', alignItems: 'center', gap: 7},
  time: {fontSize: 11.5, color: colors.textMuted},
  comment: {fontSize: ctType.chipCount.fontSize, color: colors.textSecondary},
  menuDots: {fontSize: 18, color: colors.textMuted},
});
