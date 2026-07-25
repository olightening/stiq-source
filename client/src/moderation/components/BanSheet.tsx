/**
 * BanSheet — a moderator bans a user with a fixed message and an optional duration. While the
 * ban is active the user's posts are auto-hidden everywhere and logged with the message. The ban
 * is reversible (a later unban lifts it).
 */
import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, space, type as typeScale} from '../../ui/theme';

const DURATIONS: {label: string; days: number | null}[] = [
  {label: 'Permanent', days: null},
  {label: '1 day', days: 1},
  {label: '7 days', days: 7},
  {label: '30 days', days: 30},
];

export interface BanSheetProps {
  visible: boolean;
  onConfirm: (message: string, untilSec?: number) => void;
  onCancel: () => void;
}

export function BanSheet({visible, onConfirm, onCancel}: BanSheetProps): React.JSX.Element {
  const [message, setMessage] = useState('');
  const [days, setDays] = useState<number | null>(null);

  useEffect(() => {
    if (visible) {
      setMessage('');
      setDays(null);
    }
  }, [visible]);

  const confirm = (): void => {
    const untilSec = days ? Math.floor(Date.now() / 1000) + days * 86400 : undefined;
    onConfirm(message.trim() || 'Removed by a moderator.', untilSec);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Press variant="bare" style={s.backdrop} onPress={onCancel} accessibilityRole="none">
        {/* iOS doesn't resize for the keyboard (Android's adjustResize does) — lift the sheet. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
          <Text style={s.title}>Ban user</Text>
          <Text style={s.hint}>Their posts are hidden and logged with your message while the ban is active.</Text>
          <TextInput
            style={s.note}
            placeholder="Message shown in the log (e.g. repeated spam)…"
            placeholderTextColor={colors.textMuted}
            value={message}
            onChangeText={setMessage}
            multiline
          />
          <Text style={s.label}>Duration</Text>
          <View style={s.chips}>
            {DURATIONS.map(d => {
              const active = days === d.days;
              return (
                <Press key={d.label} onPress={() => setDays(d.days)} style={[s.chip, active && s.chipActive]}>
                  <Text style={[s.chipText, active && s.chipTextActive]}>{d.label}</Text>
                </Press>
              );
            })}
          </View>
          <View style={s.actions}>
            <Press style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelText}>Cancel</Text>
            </Press>
            <Press style={s.banBtn} onPress={confirm}>
              <Text style={s.banText}>Ban</Text>
            </Press>
          </View>
        </Press>
        </KeyboardAvoidingView>
      </Press>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  title: {fontSize: typeScale.subheading, fontWeight: '700', color: colors.textPrimary},
  hint: {fontSize: typeScale.caption, color: colors.textMuted, marginBottom: space.xs},
  label: {fontSize: typeScale.caption, color: colors.textMuted, marginTop: space.sm},
  note: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.sm,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    textAlignVertical: 'top',
  },
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
  chip: {borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingVertical: 7, paddingHorizontal: 14},
  chipActive: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  chipText: {fontSize: typeScale.caption, color: colors.textSecondary, fontWeight: '500'},
  chipTextActive: {color: colors.accent},
  actions: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.md, marginTop: space.sm},
  cancelBtn: {paddingVertical: 8, paddingHorizontal: 14},
  cancelText: {fontSize: typeScale.body, color: colors.textMuted, fontWeight: '600'},
  banBtn: {backgroundColor: colors.danger ?? '#b5563f', borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 18},
  banText: {fontSize: typeScale.body, color: '#fff', fontWeight: '700'},
});
