/**
 * QuotedReply — the Telegram-style quoted-reply card in our design language.
 *
 * Two uses, one look: (1) above the composer while you're drafting a reply (pass `onClose` for the
 * ✕ to cancel), and (2) inside a sent message, above its body (pass `onPress` to jump to the
 * original). An accent left bar + the quoted author's name (accent) + a one-line snippet.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import {paragraphAlign} from '../../../ui/textDirection';
import {colors, ctType, ctWeight, DENSE_MAX_FONT_SCALE} from '../../tokens';

export function QuotedReply({
  name,
  text,
  onPress,
  onClose,
  /** `onAccent` tints for use inside your own (accent-filled) bubble. */
  tone = 'default',
}: {
  name: string;
  text: string;
  onPress?: () => void;
  onClose?: () => void;
  tone?: 'default' | 'onAccent';
}): React.JSX.Element {
  const onAccent = tone === 'onAccent';
  return (
    <View style={[s.wrap, onAccent && s.wrapOnAccent]}>
      <Press variant="row" style={s.inner} onPress={onPress} disabled={!onPress} accessibilityLabel="quoted message">
        <View style={[s.bar, onAccent && s.barOnAccent]} />
        <View style={s.body}>
          <Text style={[s.name, onAccent && s.textOnAccent]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
          {/* The quoted SNIPPET is user content → align it to its first-strong direction. */}
          <Text style={[s.snippet, onAccent && s.snippetOnAccent, paragraphAlign(text)]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{text || 'Message'}</Text>
        </View>
      </Press>
      {onClose && (
        <Press style={s.close} onPress={onClose} accessibilityLabel="cancel reply">
          <Text style={[s.closeText, onAccent && s.textOnAccent]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕</Text>
        </Press>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 8,
    paddingRight: 8,
  },
  wrapOnAccent: {backgroundColor: 'rgba(255,255,255,0.16)'},
  inner: {flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0, paddingVertical: 5, paddingLeft: 0},
  bar: {alignSelf: 'stretch', width: 3, borderRadius: 2, backgroundColor: colors.accent, marginRight: 8},
  barOnAccent: {backgroundColor: colors.onAccent},
  body: {flex: 1, minWidth: 0},
  name: {color: colors.accent, fontSize: ctType.authorName.fontSize, fontWeight: ctWeight.semibold, lineHeight: 15},
  snippet: {color: colors.textSecondary, fontSize: ctType.authorNpub.fontSize + 1.5, lineHeight: 16},
  snippetOnAccent: {color: colors.onAccent, opacity: 0.85},
  textOnAccent: {color: colors.onAccent},
  close: {paddingHorizontal: 4, paddingVertical: 4},
  closeText: {color: colors.textMuted, fontSize: 13},
});
