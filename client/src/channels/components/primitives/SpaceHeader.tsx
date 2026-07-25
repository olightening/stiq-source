/**
 * SpaceHeader — the channel/group detail header: optional leading (back), identity avatar, name +
 * accent subtitle (tap to open details/info), and a trailing slot (Owner/Joined pill, Sub/Join
 * button). One header visual for every space type; the avatar shape encodes the social type.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import type {GradientSpec} from '../../../media/gradient';
import {GradientAvatar, type AvatarShape} from '../../../ui/GradientAvatar';
import {colors, ctType, ctRadius, ctAvatar, ctWeight, DENSE_MAX_FONT_SCALE} from '../../tokens';

export function SpaceHeader({
  leading,
  gradient,
  seed,
  shape,
  avatarSize = ctAvatar.header,
  name,
  subtitle,
  onPressBody,
  bodyAccessibilityLabel,
  trailing,
}: {
  leading?: React.ReactNode;
  gradient?: GradientSpec;
  seed: string;
  shape?: AvatarShape;
  avatarSize?: number;
  name: string;
  subtitle: string;
  onPressBody?: () => void;
  bodyAccessibilityLabel?: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={s.row}>
      {leading}
      <Press
        style={s.body}
        onPress={onPressBody}
        disabled={!onPressBody}
        accessibilityLabel={bodyAccessibilityLabel}>
        <GradientAvatar gradient={gradient} seed={seed} size={avatarSize} shape={shape} radius={ctRadius.avatarMd} />
        <View style={s.text}>
          <Text style={s.name} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
          <Text style={s.sub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{subtitle}</Text>
        </View>
      </Press>
      {trailing}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  body: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0},
  text: {flex: 1, minWidth: 0},
  name: {color: colors.textPrimary, fontSize: ctType.name.fontSize, fontWeight: ctWeight.bold},
  sub: {color: colors.accent, fontSize: ctType.subtitle.fontSize, marginTop: 2},
});

/**
 * The merged back control for a space header's `leading` slot (Channels 2.0 §9). A large `‹`
 * hit-target that spans the full header height — the negative vertical margin cancels the row's
 * padding so the touch area fills the bar, easy to hit without a separate "‹ Channels" back row.
 */
export function SpaceBackButton({onPress}: {onPress: () => void}): React.JSX.Element {
  return (
    <Press onPress={onPress} accessibilityLabel="back" style={back.btn}>
      <Text style={back.glyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>‹</Text>
    </Press>
  );
}

const back = StyleSheet.create({
  btn: {
    width: 40,
    alignSelf: 'stretch',
    marginVertical: -12,
    marginLeft: -4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {color: colors.accent, fontSize: 30, marginTop: -2},
});

/** The grey pill used for the "Owner" / "Joined" status badge in a header's trailing slot. */
export function StatusPill({label}: {label: string}): React.JSX.Element {
  return (
    <View style={pill.badge}><Text style={pill.text} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{label}</Text></View>
  );
}

const pill = StyleSheet.create({
  badge: {
    backgroundColor: colors.surface,
    borderRadius: ctRadius.pill,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 11,
    paddingVertical: 5,
    alignSelf: 'center',
  },
  text: {color: colors.textSecondary, fontSize: ctType.time.fontSize, fontWeight: ctWeight.semibold},
});
