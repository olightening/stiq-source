/**
 * EventSheets — the Apply-to-attend and Share bottom sheets for the event detail screen.
 *
 * Rendered by EventDetail (A3) as siblings of the screen — sheet and screen build independently
 * against the frozen `ApplySheetProps` / `ShareSheetProps` contracts in `events/types.ts`. Both
 * sheets follow the house bottom-sheet chrome (ComposerScreen's `blockSheet`/`blockGrab` idiom +
 * REDLINES §2.2): RN `Modal` transparent, ALWAYS MOUNTED — only `visible` toggles (Android RN
 * 0.76 project law, never `{open && <Modal>}`) — scrim press-to-close, bottom card with 22px top
 * radius and a centered grabber.
 *
 * Copy is COPY.md verbatim. The two dynamic spots (the apply-sheet subcopy names the host —
 * "Quiet Harbor reviews each request…" — and the reveal hint names the auto-add group —
 * "…join the #backups-crew group chat.") interpolate the optional `hostName`/`autoAddLabel`
 * props and fall back to the generic phrasing when the host has neither.
 */
import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, space, type as typeScale, weight} from '../../ui/theme';
import type {ApplySheetProps, ShareSheetProps} from '../types';

function Grabber(): React.JSX.Element {
  return <View style={s.grab} />;
}

export function ApplySheet({visible, onClose, onSend, hostName, autoAddLabel}: ApplySheetProps): React.JSX.Element {
  const [note, setNote] = useState('');

  // The note is a fresh field per application — drop any leftover text once the sheet is
  // dismissed (send or cancel) so a later re-open never shows a stale draft.
  useEffect(() => {
    if (!visible) setNote('');
  }, [visible]);

  const send = (): void => {
    onSend(note.trim());
    setNote('');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close">
        {/* iOS doesn't resize for the keyboard (Android's adjustResize does) — lift the card. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Press variant="bare" style={s.card} onPress={() => {}} accessibilityRole="none">
          <Grabber />
          <Text style={s.title} accessibilityRole="header">
            Apply to attend
          </Text>
          <Text style={s.subcopy}>
            {`${hostName || 'The host'} reviews each request. Your display name and npub go with it — nothing else.`}
          </Text>

          <Text style={s.eyebrow}>ADD A NOTE · OPTIONAL</Text>
          <TextInput
            style={s.note}
            value={note}
            onChangeText={setNote}
            placeholder="Anything the host should know? (skill level, +1, questions…)"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />

          <View style={[s.hintBox, s.hintBoxApply]}>
            <Text style={s.hintGlyph}>🔐</Text>
            <Text style={s.hintText}>
              {autoAddLabel ? (
                <>
                  {'If approved, you’ll get the exact address and join the '}
                  <Text style={s.hintStrong}>{autoAddLabel}</Text>
                  {' group chat.'}
                </>
              ) : (
                'If approved, you’ll get the exact address and join the private group chat.'
              )}
            </Text>
          </View>

          <Press style={s.primaryBtn} onPress={send} accessibilityLabel="Send application">
            <Text style={s.primaryBtnText}>Send application</Text>
          </Press>
          <Press style={s.cancelBtn} onPress={onClose} accessibilityLabel="Cancel">
            <Text style={s.cancelText}>Cancel</Text>
          </Press>
        </Press>
        </KeyboardAvoidingView>
      </Press>
    </Modal>
  );
}

export function ShareSheet({visible, onClose, onAddToEmbeds, onForward}: ShareSheetProps): React.JSX.Element {
  const [added, setAdded] = useState(false);

  // Mirrors the DC: the added confirmation doesn't persist across a close/reopen.
  useEffect(() => {
    if (!visible) setAdded(false);
  }, [visible]);

  const addEmbed = (): void => {
    onAddToEmbeds();
    setAdded(true);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close">
        <Press variant="bare" style={s.card} onPress={() => {}} accessibilityRole="none">
          <Grabber />
          <Text style={s.title} accessibilityRole="header">
            Share this event
          </Text>
          <Text style={s.subcopy}>
            Anyone can share this — you don’t have to be the host. Add it to your embeds and drop it into any post,
            channel or DM from the composer’s 🔖 Embed button; it travels as a live, tappable event.
          </Text>

          <View style={[s.hintBox, s.hintBoxShare]}>
            <Text style={s.hintGlyph}>🔒</Text>
            <Text style={s.hintText}>
              Sharing never reveals the guest list or the exact address — those stay private until the host approves
              someone.
            </Text>
          </View>

          {added ? (
            <View style={[s.primaryBtn, s.copiedBtn]} accessibilityRole="text">
              <Text style={s.copiedText}>✓ Added — insert it from any composer’s 🔖</Text>
            </View>
          ) : (
            <Press style={s.primaryBtn} onPress={addEmbed} accessibilityLabel="Add this event card to your embeds">
              <Text style={s.primaryGlyph}>🔖</Text>
              <Text style={s.primaryBtnText}>Add to my embeds</Text>
            </Press>
          )}

          <Press style={s.forwardBtn} onPress={onForward} accessibilityLabel="Forward to a channel or DM">
            <Text style={s.forwardGlyph}>➦</Text>
            <Text style={s.forwardText}>Forward to a channel or DM</Text>
          </Press>

          <Press style={s.cancelBtn} onPress={onClose} accessibilityLabel="Cancel">
            <Text style={s.cancelText}>Cancel</Text>
          </Press>
        </Press>
      </Press>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  card: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.borderLight,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 9,
    paddingHorizontal: 18,
    paddingBottom: 20,
  },
  grab: {width: 38, height: 5, borderRadius: 3, backgroundColor: colors.borderLight, alignSelf: 'center', marginBottom: 6},

  title: {fontSize: typeScale.subheading, fontWeight: weight.bold, color: colors.textPrimary, marginTop: 8},
  subcopy: {fontSize: typeScale.caption, fontWeight: weight.regular, color: colors.textSecondary, lineHeight: 19.5, marginTop: 6},

  eyebrow: {
    fontSize: typeScale.micro,
    fontWeight: weight.bold,
    color: colors.textMuted,
    letterSpacing: 0.9,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  note: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.textPrimary,
    fontSize: 14.5,
    minHeight: 72,
    textAlignVertical: 'top',
  },

  hintBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  hintBoxApply: {marginTop: 12},
  hintBoxShare: {marginTop: 14},
  hintGlyph: {fontSize: 14},
  hintText: {flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18.75},
  hintStrong: {color: colors.textPrimary, fontWeight: weight.bold},

  primaryBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    marginTop: 14,
  },
  // Glyphs live in their own Text with a pinned lineHeight — mixed-font glyphs otherwise inflate
  // the line box and shove the latin label off the button's visual centre (PostCard vglyph idiom).
  primaryGlyph: {fontSize: typeScale.label, lineHeight: 18, fontWeight: weight.semibold, color: colors.onAccent},
  primaryBtnText: {fontSize: typeScale.label, lineHeight: 18, fontWeight: weight.semibold, color: colors.onAccent},

  copiedBtn: {backgroundColor: colors.successBg},
  copiedText: {fontSize: typeScale.label, lineHeight: 18, fontWeight: weight.semibold, color: colors.success},

  forwardBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 12,
    marginTop: space.sm,
  },
  forwardGlyph: {fontSize: 14, lineHeight: 18, fontWeight: weight.semibold, color: colors.textPrimary},
  forwardText: {fontSize: 14, lineHeight: 18, fontWeight: weight.semibold, color: colors.textPrimary},

  cancelBtn: {width: '100%', alignItems: 'center', paddingVertical: 8, marginTop: 6},
  cancelText: {fontSize: 14, fontWeight: weight.semibold, color: colors.textSecondary},
});
