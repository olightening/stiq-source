/**
 * RemovalSheet — the moderator's "why are you removing this?" bottom sheet.
 *
 * Shown when a moderator hides a feed post, comment, or channel message (and, for the channel
 * owner, their own channel). The organizer-defined reason buckets are required; an optional note
 * lets the moderator add detail. Both flow into the kind-1984 report (reason id = 3rd `e`-tag
 * element, note = content) and surface in the mod log + the "removed" banner.
 */
import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, space, type as typeScale} from '../../ui/theme';
import {DEFAULT_REASONS, type ReasonsConfig} from '../reasons';

export interface RemovalSheetProps {
  visible: boolean;
  /** Organizer-defined reason buckets. */
  reasons?: ReasonsConfig;
  /** Confirm removal with the chosen bucket id + optional note. */
  onConfirm: (reasonId: string, note?: string) => void;
  onCancel: () => void;
  /** Header label, e.g. "Remove post" / "Remove comment". */
  title?: string;
  /** Sub-header copy under the title. Defaults to the moderator-log hint. */
  hint?: string;
  /** Confirm-button label. Defaults to "Remove" (moderator); members pass "Report". */
  confirmLabel?: string;
}

export function RemovalSheet({
  visible,
  reasons = DEFAULT_REASONS,
  onConfirm,
  onCancel,
  title = 'Remove',
  hint = "Pick a reason — it's recorded in the mod log.",
  confirmLabel = 'Remove',
}: RemovalSheetProps): React.JSX.Element {
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  // Reset the selection each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setReasonId(null);
      setNote('');
    }
  }, [visible]);

  const confirm = (): void => {
    if (!reasonId) return;
    onConfirm(reasonId, note.trim() || undefined);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Press variant="bare" style={s.backdrop} onPress={onCancel} accessibilityRole="none">
        {/* iOS doesn't resize for the keyboard (Android's adjustResize does) — lift the sheet. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
          <Text style={s.title}>{title}</Text>
          <Text style={s.hint}>{hint}</Text>

          <View style={s.chips}>
            {reasons.buckets.map(b => {
              const active = reasonId === b.id;
              return (
                <Press
                  key={b.id}
                  onPress={() => setReasonId(b.id)}
                  style={[s.chip, {borderColor: b.color}, active && {backgroundColor: b.color + '26'}]}>
                  <View style={[s.dot, {backgroundColor: b.color}]} />
                  <Text style={[s.chipText, active && {color: b.color}]}>{b.name}</Text>
                </Press>
              );
            })}
          </View>

          <TextInput
            style={s.note}
            placeholder="Add a note (optional)…"
            placeholderTextColor={colors.textMuted}
            value={note}
            onChangeText={setNote}
            multiline
          />

          <View style={s.actions}>
            <Press style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelText}>Cancel</Text>
            </Press>
            <Press
              style={s.removeBtn}
              onPress={confirm}
              disabled={!reasonId}>
              <Text style={s.removeText}>{confirmLabel}</Text>
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
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill ?? 999,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  dot: {width: 8, height: 8, borderRadius: 4},
  chipText: {fontSize: typeScale.caption, color: colors.textPrimary, fontWeight: '500'},
  note: {
    marginTop: space.sm,
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.sm,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    textAlignVertical: 'top',
  },
  actions: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.md, marginTop: space.sm},
  cancelBtn: {paddingVertical: 8, paddingHorizontal: 14},
  cancelText: {fontSize: typeScale.body, color: colors.textMuted, fontWeight: '600'},
  removeBtn: {backgroundColor: colors.danger ?? '#b5563f', borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 18},
  removeBtnDisabled: {opacity: 0.45},
  removeText: {fontSize: typeScale.body, color: '#fff', fontWeight: '700'},
});
