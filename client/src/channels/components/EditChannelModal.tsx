/**
 * EditChannelModal — the shared "Edit channel" sheet used by BOTH public NIP-53 channels
 * and private/broadcast NIP-29 groups (which the app surfaces to users as private "channels").
 *
 * The edit experience is identical across channel kinds: same chrome, same name/about fields,
 * same identity-gradient editor. The only difference is the membership controls — a private
 * group additionally exposes the closed/private toggles and the owner's delete action (the
 * `group` variant). The `channel` variant drops those, since a public NIP-53 channel has no
 * membership model. This is the "+/- the feature differences" the two share.
 */
import React, {useRef, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {GradientMaker} from '../../ui/GradientMaker';
import {ReactionSlots} from './ReactionPicker';
import {gradientFromSeed, type GradientSpec} from '../../media/gradient';
import {useBackDismiss} from '../../ui/back';
import {colors, space, radius, type as typeScale, weight} from '../../ui/theme';

/** The values handed back on Save. Callers pick the fields that apply to their channel kind. */
export interface EditChannelValues {
  name: string;
  about?: string;
  closed: boolean;
  private: boolean;
  gradient: GradientSpec;
  /** Allowed one-tap reaction emojis (empty = none). */
  reactions: string[];
}

export interface EditChannelModalProps {
  visible: boolean;
  /** Retained for labelling; type/privacy is immutable so no membership toggles are shown. */
  variant: 'group' | 'channel';
  /** Space noun used in labels ("Edit {noun}", "Delete {noun}"). Defaults to 'channel'. */
  noun?: string;
  /** Show the reaction text field. CHANNELS only (public + private channel); groups/DMs react via
   * the ⋯ any-emoji menu, so they hide it. Defaults to the channel variant. */
  showReactions?: boolean;
  initial: {
    name: string;
    about?: string;
    closed?: boolean;
    isPrivate?: boolean;
    gradient?: GradientSpec;
    /** Currently-configured reaction emojis (pre-populates the picker). */
    reactions?: string[];
    /** Seed for the fallback gradient when none is set yet. */
    seed: string;
  };
  /** When true (and onDelete is provided) the owner's delete action is shown. */
  isOwner?: boolean;
  onClose: () => void;
  onSave: (values: EditChannelValues) => void;
  /** Owner-only permanent delete. Omitted → the delete action is hidden. */
  onDelete?: () => void;
}

export function EditChannelModal({
  visible,
  variant,
  noun = 'channel',
  showReactions = variant === 'channel',
  initial,
  isOwner,
  onClose,
  onSave,
  onDelete,
}: EditChannelModalProps): React.JSX.Element {
  const [name, setName] = useState(initial.name);
  const [about, setAbout] = useState(initial.about ?? '');
  const [grad, setGrad] = useState<GradientSpec>(initial.gradient ?? gradientFromSeed(initial.seed));
  const [reactions, setReactions] = useState<string[]>(initial.reactions ?? []);
  const [gradOpen, setGradOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  // Dirty == anything the admin actually changed, compared against what the sheet opened with.
  // BACK, the Cancel button and a tap on the scrim are all the same dismiss, so edits can only be
  // lost after an explicit answer (ui/back.tsx contract rule 5).
  //
  // The gradient is compared BY VALUE, not by identity: when the space has no gradient of its own
  // the field seeds from gradientFromSeed(), which returns a fresh (equal but distinct) object on
  // every call — an identity check would report "dirty" the instant the sheet opened.
  const pristineGrad = useRef(JSON.stringify(initial.gradient ?? gradientFromSeed(initial.seed))).current;
  const dirty =
    name !== initial.name ||
    about !== (initial.about ?? '') ||
    JSON.stringify(grad) !== pristineGrad ||
    reactions.join(',') !== (initial.reactions ?? []).join(',');
  const dismiss = useBackDismiss(dirty, onClose, {
    title: `Discard ${noun} changes?`,
    message: 'Your edits will not be saved.',
  });
  const save = (): void => {
    if (!name.trim()) return;
    // Type/privacy are immutable after creation — pass initial closed/private straight through.
    onSave({
      name: name.trim(),
      about: about.trim() || undefined,
      closed: initial.closed ?? false,
      private: initial.isPrivate ?? false,
      gradient: grad,
      reactions,
    });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
      <Press variant="bare" style={s.overlay} onPress={dismiss} accessibilityRole="none">
        {/* Inner event-swallowing wrapper — stops a tap on the sheet body from bubbling to the scrim. */}
        <KeyboardAvoidingView
          style={{width: '100%', alignItems: 'center'}}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
          <Press variant="bare" style={s.sheet} onPress={e => e.stopPropagation()} accessibilityRole="none">
            <Text style={s.sheetTitle}>Edit {noun}</Text>
            <TextInput
              style={s.sheetInput}
              value={name}
              onChangeText={setName}
              placeholder={`${Noun} name`}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="edit-channel-name"
            />
            <TextInput
              style={[s.sheetInput, {marginTop: 8}]}
              value={about}
              onChangeText={setAbout}
              placeholder="About (optional)"
              placeholderTextColor={colors.textMuted}
              multiline
            />

            {/* Type & privacy are fixed at creation and cannot be changed — no membership toggles here. */}

            {/* Identity gradient editor (mirrors ProfileScreen). */}
            {gradOpen ? (
              <View style={s.gradEditor}>
                <View style={s.gradEditorHeader}>
                  <Text style={s.switchLabel}>Identity gradient</Text>
                  <Press onPress={() => setGradOpen(false)} accessibilityLabel="gradient-done">
                    <Text style={s.gradDone}>Done</Text>
                  </Press>
                </View>
                <ScrollView style={{maxHeight: 360}} nestedScrollEnabled>
                  <GradientMaker value={grad} onChange={setGrad} previewSize={96} />
                </ScrollView>
              </View>
            ) : (
              <Press variant="row" style={s.gradRow} onPress={() => setGradOpen(true)} accessibilityLabel="edit-gradient">
                <GradientAvatar gradient={grad} size={36} radius={radius.md} />
                <View style={{flex: 1}}>
                  <Text style={s.switchLabel}>Identity gradient</Text>
                  <Text style={s.switchHint}>Tap to edit how the community recognizes this {noun}</Text>
                </View>
                <Text style={s.gradChevron}>›</Text>
              </Press>
            )}

            {/* Reactions — CHANNELS only: the admin fills the emoji slots. Groups/DMs react via the ⋯
                any-emoji menu, so the field is hidden for them. */}
            {showReactions && (
            <View style={s.reactionBlock}>
              <Text style={s.switchLabel}>Reactions</Text>
              <Text style={s.switchHint}>Fill a slot with any emoji to use as a one-tap reaction on every post.</Text>
              <View style={s.reactionPicker}>
                <ReactionSlots value={reactions} onChange={setReactions} />
              </View>
            </View>
            )}

            <View style={s.sheetBtns}>
              <Press style={s.sheetCancel} onPress={dismiss}>
                <Text style={s.sheetCancelText}>Cancel</Text>
              </Press>
              <Press style={s.sheetConfirm} onPress={save} accessibilityLabel="save-channel">
                <Text style={s.sheetConfirmText}>Save</Text>
              </Press>
            </View>
            {isOwner && onDelete && (
              confirmDelete ? (
                <Press
                  style={s.deleteConfirm}
                  onPress={() => { onDelete(); onClose(); }}
                  accessibilityLabel="confirm-delete-channel">
                  <Text style={s.deleteConfirmText}>Tap again to permanently delete this {noun}</Text>
                </Press>
              ) : (
                <Press style={s.deleteBtn} onPress={() => setConfirmDelete(true)} accessibilityLabel="delete-channel">
                  <Text style={s.deleteText}>Delete {noun}</Text>
                </Press>
              )
            )}
          </Press>
        </KeyboardAvoidingView>
      </Press>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center'},
  sheet: {backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, width: '88%'},
  sheetTitle: {color: colors.textPrimary, fontSize: typeScale.subheading, fontWeight: weight.bold, marginBottom: space.md},
  sheetInput: {color: colors.textPrimary, backgroundColor: colors.surfaceHover, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: typeScale.body},
  switchRow: {flexDirection: 'row', alignItems: 'center', marginTop: space.md, gap: space.sm},
  switchLabel: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  switchHint: {color: colors.textMuted, fontSize: typeScale.caption, marginTop: 2},
  reactionBlock: {marginTop: space.md},
  reactionPicker: {marginTop: space.sm},
  gradRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md},
  gradChevron: {color: colors.textMuted, fontSize: 22, flexShrink: 0},
  gradEditor: {marginTop: space.md},
  gradEditorHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm},
  gradDone: {color: colors.accent, fontSize: typeScale.caption, fontWeight: weight.bold},
  sheetBtns: {flexDirection: 'row', gap: space.sm, marginTop: space.lg},
  sheetCancel: {flex: 1, backgroundColor: colors.surfaceHover, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center'},
  sheetCancelText: {color: colors.textSecondary, fontWeight: weight.semibold},
  sheetConfirm: {flex: 1, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center'},
  sheetConfirmText: {color: colors.onAccent, fontWeight: weight.bold},
  deleteBtn: {marginTop: space.md, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.danger},
  deleteText: {color: colors.danger, fontWeight: weight.bold},
  deleteConfirm: {marginTop: space.md, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.danger},
  deleteConfirmText: {color: colors.onAccent, fontWeight: weight.bold, fontSize: typeScale.caption, textAlign: 'center'},
});
