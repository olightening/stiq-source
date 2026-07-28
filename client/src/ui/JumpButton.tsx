/**
 * JumpButton — floating circular button anchored at the BOTTOM-RIGHT, that jumps a list to its
 * edge. Used as "scroll to top" in the feed and "scroll to latest" in channels/DMs/groups (newest
 * at the bottom), so the chevron direction is configurable.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
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
  /** Messages that arrived past the reader while they were scrolled away (see useNewWhileAway).
   *  0/undefined renders no badge. */
  count?: number;
}

export function JumpButton({visible, direction, onPress, bottom, count}: JumpButtonProps): React.JSX.Element | null {
  if (!visible) return null;
  const label = direction === 'up' ? 'scroll to top' : 'scroll to latest';
  return (
    <Press
      style={[s.btn, bottom !== undefined && {bottom}]}
      onPress={onPress}
      accessibilityLabel={count && count > 0 ? `${label}, ${count} new` : label}>
      <Text style={[s.chevron, direction === 'up' ? s.up : s.down]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⌄</Text>
      {!!count && count > 0 && (
        <View style={s.badge}>
          <Text style={s.badgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      )}
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
  // "N new" badge on the FAB's corner — BottomDock.jumpBadge's treatment, for the same reason it
  // inverts there: the button IS the accent fill, so the badge goes white-on-accent-ring rather
  // than the bell badge's accent-on-neutral, which would vanish against the button.
  badge: {
    position: 'absolute', top: -3, right: -3,
    minWidth: 17, height: 17, borderRadius: 8.5,
    paddingHorizontal: 3,
    backgroundColor: colors.onAccent,
    borderWidth: 2, borderColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeText: {fontSize: 9, fontWeight: '700', color: colors.accent, lineHeight: 11},
});
