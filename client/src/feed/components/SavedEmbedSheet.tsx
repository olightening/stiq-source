/**
 * SavedEmbedSheet — the "SAVED · TAP TO EMBED" bottom sheet behind a composer's `+` → Embed action.
 *
 * It self-loads the local saved-embed bookmarks and renders them as tappable REFERENCED rows; picking
 * one fires `onPick(item)` (the caller appends `savedEmbedUri(item)` to its draft). Shared by every
 * surface — channels, DMs, and comments — so "embed a post" looks and behaves identically. Pass
 * `getSummary` to show the referenced post's name/snippet; without it, rows show a generic title.
 */
import React, {useEffect, useState} from 'react';
import {Alert, Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, weight} from '../../ui/theme';
import {decodeNameHeader} from '../../profile/displayName';
import {
  ensureSavedEmbedsLoaded,
  listSavedEmbeds,
  savedEmbedIsPrivate,
  savedEmbedRowLabel,
  type SavedEmbed,
} from '../../channels/savedEmbeds';

export function SavedEmbedSheet({
  visible,
  onClose,
  onPick,
  getSummary,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (item: SavedEmbed) => void;
  /** Looks up the referenced event for the row's name/snippet. Omit for generic titles. */
  getSummary?: (id: string) => {name?: string; content?: string} | null | undefined;
}): React.JSX.Element {
  // Bump a version counter once the async load finishes so the synchronously-read list re-renders.
  const [, setVer] = useState(0);
  useEffect(() => { void ensureSavedEmbedsLoaded().then(() => setVer(v => v + 1)); }, []);
  const saved: SavedEmbed[] = listSavedEmbeds().slice();

  // A private-sourced embed (a post from a private space) carries its content wherever it's inserted —
  // confirm before handing it to the composer, so private content is never leaked by a stray tap.
  const pick = (item: SavedEmbed): void => {
    if (savedEmbedIsPrivate(item)) {
      Alert.alert(
        'Embed from a private space?',
        'This post is from a private space. Its content travels inside the embed — anyone who can see where you post it will be able to read it.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Insert anyway', style: 'destructive', onPress: () => onPick(item)},
        ],
      );
      return;
    }
    onPick(item);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" />
      <View style={s.wrap}>
        <View style={s.card}>
          <View style={s.header}>
            <Text style={s.headerLabel}>SAVED · TAP TO EMBED</Text>
            <Text style={s.headerCount}>{saved.length} saved</Text>
          </View>
          {saved.length === 0 ? (
            <Text style={s.empty}>Nothing saved yet. Use a post's ⋯ → “Save to embed later”.</Text>
          ) : (
            <ScrollView style={s.list}>
              {saved.map(item => {
                // SPACE (channel/private group), EVENT, DRAFT, and PRIVATE-POST embeds are all
                // self-contained rows (label + carried name) — getSummary resolves post ids, not
                // coordinates/tokens, so it only enriches a plain referenced post.
                const isSelfContained =
                  item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
                const summary = isSelfContained ? undefined : getSummary?.(item.id);
                const label = savedEmbedRowLabel(item);
                const title = item.draftToken
                  ? item.name?.trim() || 'Untitled draft'
                  : item.msgToken
                  ? item.name?.trim() || 'Private post'
                  : item.kind === 30311 || item.kind === 39000
                  ? item.name?.trim() || 'Saved space'
                  : item.kind === 31923
                  ? item.name?.trim() || 'Saved event'
                  : summary?.name?.trim() || 'Saved post';
                const snippet = isSelfContained ? '' : decodeNameHeader(summary?.content ?? '').text.replace(/\s+/g, ' ').trim();
                return (
                  <Press key={item.id} variant="row" style={s.row} onPress={() => pick(item)}>
                    <Text style={s.rowLabel}>{label}</Text>
                    <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
                    {snippet ? <Text style={s.rowSnippet} numberOfLines={2}>{snippet}</Text> : null}
                  </Press>
                );
              })}
            </ScrollView>
          )}
        </View>
        <Press style={s.done} onPress={onClose}>
          <Text style={s.doneText}>Done</Text>
        </Press>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)'},
  wrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  card: {maxHeight: '70%', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  headerLabel: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted, letterSpacing: 0.6},
  headerCount: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted},
  empty: {color: colors.textMuted, fontSize: 14, padding: 18, textAlign: 'center'},
  list: {maxHeight: 320},
  row: {paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  rowLabel: {fontSize: 10, fontWeight: weight.bold, color: colors.accent, letterSpacing: 0.4, marginBottom: 3},
  rowTitle: {fontSize: 15, color: colors.textPrimary, fontWeight: weight.semibold},
  rowSnippet: {fontSize: 13, color: colors.textSecondary, marginTop: 2},
  done: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  doneText: {fontSize: 16, color: colors.accent, fontWeight: weight.semibold},
});
