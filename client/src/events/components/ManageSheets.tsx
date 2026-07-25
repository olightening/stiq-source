/**
 * Manage sheets — the two bottom sheets the organizer's Manage screen opens (A7).
 *
 * Ported pixel-for-pixel from EventsOrganizer.dc.html (cancel sheet lines 502–514, message sheet
 * lines 517–534) + REDLINES §2.2/§5 + COPY.md (Organizer — Manage). Both are ALWAYS-MOUNTED
 * Modals (Android RN 0.76 law): only `visible` toggles, never the Modal element. Confirmations are
 * inline label swaps, never toasts. Strings are verbatim from COPY.md.
 *
 * The parent (ManageScreen) owns each sheet's open/close (`visible` + `onClose`); the message
 * sheet owns its own draft-text + "sent" swap internally and resets both when it (re)opens.
 */
import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors} from '../../ui/theme';

// ── Cancel confirm sheet (org-10) ──────────────────────────────────────────────────────────────

export interface CancelSheetProps {
  visible: boolean;
  /** Auto-add group label (e.g. "#backups-crew") — the group that STAYS after cancellation. */
  groupLabel?: string;
  onClose: () => void;
  /** Confirm cancellation. The parent closes the sheet + reflects `cancelled` via the VM. */
  onConfirm: () => void;
}

export function CancelSheet({visible, groupLabel, onClose, onConfirm}: CancelSheetProps): React.JSX.Element {
  // The #backups-crew group survives cancellation — name it when we know it, else drop the clause.
  const body = groupLabel
    ? `Everyone who’s interested, applied, or going will be notified. The ${groupLabel} group stays. This can’t be undone.`
    : 'Everyone who’s interested, applied, or going will be notified. This can’t be undone.';
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close">
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
          <View style={s.grab} />
          <Text style={s.title}>Cancel this event?</Text>
          <Text style={s.cancelBody}>{body}</Text>
          <Press
            style={s.dangerBtn}
            onPress={onConfirm}
            accessibilityLabel="Cancel event and notify everyone">
            <Text style={s.dangerBtnText}>Cancel event &amp; notify everyone</Text>
          </Press>
          <Press style={s.ghostBtn} onPress={onClose}>
            <Text style={s.ghostBtnText}>Keep it</Text>
          </Press>
        </Press>
      </Press>
    </Modal>
  );
}

// ── Message-everyone sheet (org-11) ─────────────────────────────────────────────────────────────

export interface MessageSheetProps {
  visible: boolean;
  /** Recipient count — "all N approved guests" / "Sent to N guests". */
  recipients: number;
  onClose: () => void;
  /** Deliver the update. Fire-and-forget; the sheet swaps to its "Sent to N" state locally. */
  onSend: (message: string) => void;
}

export function MessageSheet({visible, recipients, onClose, onSend}: MessageSheetProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);

  // Reset the draft + "sent" swap every time the sheet (re)opens (DC openMsg: msgText/msgSent cleared).
  useEffect(() => {
    if (visible) {
      setText('');
      setSent(false);
    }
  }, [visible]);

  const send = (): void => {
    onSend(text.trim());
    setSent(true); // inline label swap → "Sent to N guests" (no auto-close, matches the DC)
  };

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close">
        {/* iOS doesn't resize for the keyboard (Android's adjustResize does) — lift the sheet. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
          <View style={s.grab} />
          <Text style={s.title}>Message everyone going</Text>
          <Text style={s.msgBody}>Sent as a notification to all {recipients} approved guests.</Text>
          {sent ? (
            <View style={s.sentRow} accessibilityLiveRegion="polite">
              <Text style={s.sentCheck}>✓</Text>
              <Text style={s.sentText}>Sent to {recipients} guests</Text>
            </View>
          ) : (
            <>
              <TextInput
                style={s.input}
                value={text}
                onChangeText={setText}
                placeholder="e.g. Door code is 4821 — see you at 7."
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
                accessibilityLabel="Message to everyone going"
              />
              <Press style={s.accentBtn} onPress={send}>
                <Text style={s.accentBtnText}>Send update</Text>
              </Press>
            </>
          )}
          <Press style={s.ghostBtn} onPress={onClose}>
            <Text style={s.ghostBtnText}>Close</Text>
          </Press>
        </Press>
        </KeyboardAvoidingView>
      </Press>
    </Modal>
  );
}

// ── Shared sheet chrome (REDLINES §2.2 — matches ComposerScreen blockSheet) ──────────────────────

const s = StyleSheet.create({
  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 18,
    paddingTop: 9,
    paddingBottom: 20,
  },
  grab: {width: 38, height: 5, borderRadius: 3, backgroundColor: colors.borderLight, alignSelf: 'center', marginBottom: 6},
  title: {fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginTop: 8},

  // cancel
  cancelBody: {fontSize: 13.5, color: colors.textSecondary, marginTop: 8, lineHeight: 21},
  dangerBtn: {backgroundColor: colors.danger, borderRadius: 999, paddingVertical: 13, alignItems: 'center', marginTop: 16},
  dangerBtnText: {color: '#ffffff', fontSize: 15, fontWeight: '600'},

  // message
  msgBody: {fontSize: 13, color: colors.textSecondary, marginTop: 6, lineHeight: 19},
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.textPrimary,
    fontSize: 14.5,
    minHeight: 76,
    marginTop: 14,
  },
  accentBtn: {backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 13, alignItems: 'center', marginTop: 12},
  accentBtnText: {color: colors.onAccent, fontSize: 15, fontWeight: '600'},
  sentRow: {flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.successBg, borderRadius: 10, padding: 13, marginTop: 14},
  sentCheck: {fontSize: 14, color: colors.success},
  sentText: {fontSize: 13.5, color: colors.success, fontWeight: '600'},

  // shared ghost dismiss
  ghostBtn: {alignItems: 'center', marginTop: 6, paddingVertical: 8},
  ghostBtnText: {color: colors.textSecondary, fontSize: 14, fontWeight: '600'},
});
