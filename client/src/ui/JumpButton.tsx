/**
 * JumpButton — floating circular button anchored at the BOTTOM-RIGHT, that jumps a list to its
 * edge. Used as "scroll to top" in the feed and "scroll to latest" in channels/DMs/groups (newest
 * at the bottom), so the chevron direction is configurable.
 */
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {Press} from './Press';
import {colors, radius, DENSE_MAX_FONT_SCALE} from './theme';

const BTN_SIZE = 42;

export interface JumpButtonProps {
  visible: boolean;
  direction: 'up' | 'down';
  onPress: () => void;
  /** Override the default bottom offset (30). The Feed tab raises it so the FAB clears the floating
   *  bottom nav dock; the channel/group/DM sub-screens (where no dock shows) keep the default. */
  bottom?: number;
}

export function JumpButton({visible, direction, onPress, bottom}: JumpButtonProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Press style={[s.btn, bottom !== undefined && {bottom}]} onPress={onPress} accessibilityLabel={direction === 'up' ? 'scroll to top' : 'scroll to latest'}>
      <Text style={[s.chevron, direction === 'up' ? s.up : s.down]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⌄</Text>
    </Press>
  );
}

const s = StyleSheet.create({
  btn: {
    position: 'absolute',
    // Anchored bottom-right — floats over the trailing edge of the list, clear of content.
    right: 16,
    bottom: 30,
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: {width: 0, height: 8},
    elevation: 12,
  },
  // A clean chevron caret (▾) rotated per direction, rather than the thin arrow glyph.
  chevron: {
    color: colors.onAccent,
    fontSize: 18,
    lineHeight: 18,
    fontWeight: '800',
    textAlign: 'center',
    includeFontPadding: false,
  },
  up: {transform: [{rotate: '180deg'}], marginTop: -1},
  down: {marginTop: 1},
});
