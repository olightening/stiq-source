/**
 * ReactionChips — the channel's owner-configured emoji set rendered as one-tap chips under a message.
 * Count shows when >0; the viewer's own reaction is highlighted in accent. Shared by every card
 * layout (public channel, private/broadcast channel) so the chips are identical everywhere (RC-1).
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import type {EmojiTally} from '../../reactions';
import {colors, ctType, ctRadius, ctSpace, ctWeight, DENSE_MAX_FONT_SCALE} from '../../tokens';

export function ReactionChips({
  reactions,
  onReact,
  /** Render compact (no top margin, single line) so the chips sit inline in the message footer row. */
  inline,
}: {
  reactions: EmojiTally[];
  onReact?: (emoji: string) => void;
  inline?: boolean;
}): React.JSX.Element | null {
  if (reactions.length === 0) return null;
  return (
    <View style={[s.row, inline && s.rowInline]}>
      {reactions.map(r => (
        <Press
          key={r.emoji}
          style={[s.chip, inline && s.chipInline, r.mine && s.chipMine]}
          disabled={!onReact}
          onPress={() => onReact?.(r.emoji)}
          accessibilityLabel={`react ${r.emoji}`}>
          <Text style={s.emoji} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{r.emoji}</Text>
          {r.count > 0 && <Text style={[s.count, r.mine && s.countMine]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{r.count}</Text>}
        </Press>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: ctSpace.chipGap, marginTop: ctSpace.chipRowTop},
  // Inline (footer) variant: no top margin, single line, tighter gap so it shares the meta row.
  rowInline: {flexWrap: 'nowrap', marginTop: 0, gap: 6},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: ctRadius.chip,
    paddingHorizontal: ctSpace.chipPadX,
    paddingVertical: ctSpace.chipPadY,
  },
  // Slightly tighter padding inline so a chip + count reads as a compact pill in the footer.
  chipInline: {gap: 4, paddingHorizontal: 8, paddingVertical: 3},
  chipMine: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  emoji: {fontSize: 14},
  count: {fontSize: ctType.chipCount.fontSize, color: colors.textSecondary, fontWeight: ctWeight.regular},
  countMine: {color: colors.accent},
});
