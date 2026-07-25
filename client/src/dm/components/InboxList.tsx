/**
 * InboxList — conversations overview (PLAN.md §3 / Step 17 + Phase 6 restyle).
 * Includes a "Start new conversation" affordance (UI only; no DM backend changes).
 */
import React, {useState} from 'react';
import {FlatList, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {useBackDismiss} from '../../ui/back';
import type {Conversation} from '../conversations';
import {colors, space, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {EmptyState} from '../../ui/EmptyState';
import type {GradientSpec} from '../../media/gradient';
import {shortenNpub} from '../../util/npub';

function shortNpub(npub: string): string {
  return shortenNpub(npub, {lead: 12, tail: 4, minLen: 24});
}

export interface InboxListProps {
  conversations: Conversation[];
  onOpen: (peer: string) => void;
  /** Called with the hex pubkey to start a new conversation. Absent = button hidden. */
  onNewConversation?: (peerPubkey: string) => void;
  /** Resolve a peer's display name (shown above their npub when known). */
  getPeerName?: (peerPubkey: string) => string | undefined;
  /** Resolve a peer's identity gradient (else derived from their npub). */
  getPeerGradient?: (peerPubkey: string) => GradientSpec | undefined;
}

export function InboxList({conversations, onOpen, onNewConversation, getPeerName, getPeerGradient}: InboxListProps): React.JSX.Element {
  const [newPeerModal, setNewPeerModal] = useState(false);
  const [npubDraft, setNpubDraft] = useState('');

  const startNew = (): void => {
    const trimmed = npubDraft.trim();
    if (!trimmed) return;
    onNewConversation?.(trimmed);
    setNpubDraft('');
    setNewPeerModal(false);
  };
  // This dialog had NO onRequestClose, which on Android makes BACK a dead key inside it — the one
  // modal in the app where the system's own navigation gesture did nothing at all. Cancel and BACK
  // are now the same function, and a pasted-but-unsent key asks before it is thrown away (a pasted
  // npub is genuinely tedious to reproduce). See ui/back.tsx.
  const dismiss = useBackDismiss(
    npubDraft.trim().length > 0,
    () => {
      setNpubDraft('');
      setNewPeerModal(false);
    },
    {title: 'Discard this key?', discardLabel: 'Discard'},
  );

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.heading} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Messages</Text>
        {onNewConversation && (
          <Press style={s.newBtn} onPress={() => setNewPeerModal(true)}>
            <Text style={s.newBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️ New</Text>
          </Press>
        )}
      </View>

      {conversations.length === 0 ? (
        <EmptyState
          icon="✏️"
          title="No messages yet"
          subtitle="Start a private conversation — paste someone's npub to begin."
          action={onNewConversation ? {label: 'New message', onPress: () => setNewPeerModal(true)} : undefined}
        />
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={c => c.peer}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={5}
          renderItem={({item}) => {
            const name = getPeerName?.(item.peer)?.trim();
            return (
              <Press variant="row" style={s.row} onPress={() => onOpen(item.peer)}>
                <GradientAvatar gradient={getPeerGradient?.(item.peer)} seed={item.peerNpub} size={42} />
                <View style={s.rowText}>
                  {name ? (
                    <>
                      <Text style={s.peer} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
                      <Text style={s.peerNpub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(item.peerNpub)}</Text>
                    </>
                  ) : (
                    <Text style={s.peer} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(item.peerNpub)}</Text>
                  )}
                  <Text style={s.preview} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.preview}</Text>
                </View>
              </Press>
            );
          }}
        />
      )}

      {/* New conversation modal */}
      <Modal
        visible={newPeerModal}
        animationType="slide"
        transparent
        presentationStyle="overFullScreen"
        onRequestClose={dismiss}>
        <View style={s.modalOverlay}>
          <KeyboardAvoidingView
            style={s.modalCard}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
            <Text style={s.modalTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>New conversation</Text>
            <TextInput
              style={s.modalInput}
              placeholder="Paste npub or hex pubkey…"
              placeholderTextColor={colors.textMuted}
              value={npubDraft}
              onChangeText={setNpubDraft}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={s.modalActions}>
              <Press style={s.modalCancel} onPress={dismiss}>
                <Text style={s.modalCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
              </Press>
              <Press style={s.modalConfirm} onPress={startNew}>
                <Text style={s.modalConfirmText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Start</Text>
              </Press>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  heading: {fontSize: typeScale.subheading, fontWeight: weight.bold, color: colors.textPrimary},
  newBtn: {backgroundColor: colors.tagBg, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6},
  newBtnText: {fontSize: typeScale.label, color: colors.accent, fontWeight: weight.semibold},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: {flex: 1, minWidth: 0},
  peer: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  peerNpub: {color: colors.textMuted, fontSize: typeScale.micro, fontFamily: 'monospace'},
  preview: {color: colors.textSecondary, fontSize: typeScale.label, marginTop: 2},

  // Modal
  modalOverlay: {flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end'},
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
  },
  modalTitle: {fontSize: typeScale.subheading, fontWeight: weight.bold, color: colors.textPrimary, marginBottom: space.md},
  modalInput: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
  },
  modalActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: space.md},
  modalCancel: {paddingHorizontal: space.md, paddingVertical: space.sm},
  modalCancelText: {color: colors.textSecondary, fontSize: typeScale.body},
  modalConfirm: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  modalConfirmText: {color: colors.onAccent, fontWeight: weight.bold, fontSize: typeScale.body},
});
