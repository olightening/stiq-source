/**
 * LinkChip — a distinct, self-contained link pill (🔗 domain ▶).
 *
 * Rounded, bordered, subtly-filled chip with a link glyph, the domain (or a title), and an
 * open affordance. Rendered as its own element (not inline text) so it reads as a clear, tappable
 * object. Tapping hands the URL to the app-root link dialog ([[./LinkDialog]]), which owns every
 * decision about where a link actually goes — this chip only decides how a link LOOKS.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from './Press';
import {colors, DENSE_MAX_FONT_SCALE} from './theme';
import {fonts} from './typography';
import {openLinkDialog} from './openLink';
import {Icon} from './icons';
import {prettyDomain, stripTrackingParams} from '../util/url';

export interface LinkChipProps {
  url: string;
  /** Label override (e.g. a markdown link title); defaults to the domain. */
  label?: string;
}

export function LinkChip({url, label}: LinkChipProps): React.JSX.Element {
  // Show the cleaned host (tracking params stripped — the dialog strips them again before opening).
  const cleaned = stripTrackingParams(url);
  const text = label?.trim() || prettyDomain(url);

  return (
    <Press
      variant="row"
      style={s.bubble}
      pressedStyle={s.bubblePressed}
      onPress={() => openLinkDialog({url, title: label})}
      accessibilityLabel={`link ${text}`}>
      <View style={s.icTile}><Icon name="🔗" size={15}/></View>
      <View style={s.bubbleId}>
        <Text style={s.bubbleTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{text}</Text>
        <Text style={s.bubbleHost} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{prettyDomain(cleaned)}</Text>
      </View>
      <Text style={s.chevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
    </Press>
  );
}

const s = StyleSheet.create({
  // Link bubble (design `.link-bubble`): a block card with an icon tile, title, host, and ›.
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    width: '100%',
    paddingVertical: 11,
    paddingHorizontal: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    marginTop: 12,
  },
  bubblePressed: {backgroundColor: colors.surfaceHover, borderColor: colors.borderLight},
  icTile: {
    width: 33,
    height: 33,
    borderRadius: 9,
    backgroundColor: colors.tagBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {fontSize: 16, color: colors.textMuted},
  bubbleId: {flex: 1, minWidth: 0},
  bubbleTitle: {fontSize: 14, fontWeight: '600', color: colors.textPrimary},
  bubbleHost: {fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 2},
});
