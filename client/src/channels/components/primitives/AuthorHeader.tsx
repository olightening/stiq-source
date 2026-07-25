/**
 * AuthorHeader — avatar + display name + npub, shown atop authored cards and (smaller) above
 * incoming chat bubbles. The single author-row visual for the whole Channels area.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {GradientSpec} from '../../../media/gradient';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import {colors, ctType, ctWeight, DENSE_MAX_FONT_SCALE} from '../../tokens';
import {shortNpub} from './format';

export function AuthorHeader({
  npub,
  name,
  gradient,
  size = 22,
  /** Optional trailing element (e.g. an ADMIN badge). */
  trailing,
}: {
  npub: string;
  name?: string;
  gradient?: GradientSpec;
  size?: number;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  // Mockup: avatar + name + short npub all on ONE row (name 12.5/600/secondary, npub 10.5/muted/mono).
  return (
    <View style={s.row}>
      <GradientAvatar gradient={gradient} seed={npub} size={size} />
      {name ? <Text style={s.name} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text> : null}
      <Text style={s.npub} numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub)}</Text>
      {trailing ? <View style={s.trailing}>{trailing}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 9},
  name: {color: colors.textSecondary, fontSize: ctType.authorName.fontSize, fontWeight: ctWeight.semibold, flexShrink: 0},
  npub: {color: colors.textMuted, fontSize: ctType.authorNpub.fontSize, fontFamily: 'monospace', flexShrink: 1, minWidth: 0},
  trailing: {marginLeft: 'auto', paddingLeft: 6},
});
