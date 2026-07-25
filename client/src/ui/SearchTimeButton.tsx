/**
 * Compact "time frame" control that sits inside a search bar. Shows the current selection
 * (📅 + a short label) and tints to the accent when a range is active. Tapping opens the
 * {@link TimeFrameSheet}. Shared by the feed / channels / groups bar and the DM bar so every
 * surface's time filter looks and behaves identically.
 */
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {Press} from './Press';
import {colors, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from './theme';
import {isActive, selectionLabel, type TimeSelection} from './timeframe';

export interface SearchTimeButtonProps {
  selection: TimeSelection;
  onPress: () => void;
}

export function SearchTimeButton({selection, onPress}: SearchTimeButtonProps): React.JSX.Element {
  const active = isActive(selection);
  return (
    <Press
      onPress={onPress}
      accessibilityLabel="search-time-frame"
      style={[s.btn, active && s.btnActive]}>
      <Text style={[s.icon, active && s.textActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>📅</Text>
      <Text style={[s.label, active && s.textActive]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {selectionLabel(selection)}
      </Text>
    </Press>
  );
}

const s = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 150,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  btnActive: {backgroundColor: colors.accentSoft, borderColor: colors.accentTint},
  icon: {fontSize: 13},
  label: {color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: weight.semibold, flexShrink: 1},
  textActive: {color: colors.accent},
});
