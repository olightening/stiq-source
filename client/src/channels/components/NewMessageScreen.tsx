/**
 * NewMessageScreen — the "New message" phone book (Channels 2.0 §6). Reached from the inbox ✏️
 * button. A **People / Public channels** segmented toggle at the top switches the search scope:
 *   • People         — the contact book (circle avatars + npubs); tap opens/starts a DM.
 *   • Public channels — discoverable channels + open communities (their identity shape + a subtitle);
 *                       tap opens the channel.
 */
import React, {useMemo, useState} from 'react';
import {FlatList, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import type {GradientSpec} from '../../media/gradient';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {BackButton} from '../../ui/BackButton';
import {BACK_PRIORITY, useBackAction} from '../../ui/back';
import {colors, ctType, ctRadius, ctWeight} from '../tokens';
import {shortNpub} from './primitives';

export interface Contact {
  /** Hex pubkey — passed back to onSelect. */
  pubkey: string;
  /** npub (display + gradient seed). */
  npub: string;
  /** Display name; falls back to a shortened npub when absent. */
  name?: string;
  gradient?: GradientSpec | null;
}

/** A discoverable channel row in the "Public channels" scope. */
export interface ChannelPick {
  /** Channel coordinate — passed back to onSelectChannel. */
  id: string;
  name: string;
  gradient?: GradientSpec | null;
  /** Open community → octagon + "Open …" subtitle; else a public channel → square + "Public …". */
  openCommunity?: boolean;
  /** About text, appended to the type subtitle when present. */
  about?: string;
}

export function NewMessageScreen({
  contacts,
  channels = [],
  onSelect,
  onSelectChannel,
  onBack,
}: {
  contacts: Contact[];
  /** Discoverable public channels + open communities for the "Public channels" scope. */
  channels?: ChannelPick[];
  onSelect: (pubkey: string) => void;
  onSelectChannel?: (id: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [scope, setScope] = useState<'people' | 'channels'>('people');
  const [query, setQuery] = useState('');

  // Hardware BACK == the ‹ Channels button. No discard confirm here on purpose: the only state this
  // screen holds is a search filter, which is a way of LOOKING at the list rather than authored
  // work, so prompting about it would be noise. (ui/back.tsx contract rule 5 — guard typed work,
  // not every keystroke.)
  useBackAction(() => { onBack(); return true; }, {priority: BACK_PRIORITY.host});

  const filteredPeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      c => (c.name?.toLowerCase().includes(q) ?? false) || c.npub.toLowerCase().includes(q),
    );
  }, [contacts, query]);

  const filteredChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      c => c.name.toLowerCase().includes(q) || (c.about?.toLowerCase().includes(q) ?? false),
    );
  }, [channels, query]);

  return (
    <View style={s.root}>
      <View style={s.backBar}>
        <BackButton label="Channels" onPress={onBack} size="sm" style={s.backNav} />
      </View>

      <View style={s.head}>
        <Text style={s.title}>New message</Text>

        {/* People / Public channels segmented toggle (§6) */}
        <View style={s.segment}>
          <Press
            style={[s.segBtn, scope === 'people' && s.segBtnActive]}
            onPress={() => setScope('people')}
            accessibilityLabel="scope-people">
            <Text style={[s.segText, scope === 'people' && s.segTextActive]}>People</Text>
          </Press>
          <Press
            style={[s.segBtn, scope === 'channels' && s.segBtnActive]}
            onPress={() => setScope('channels')}
            accessibilityLabel="scope-channels">
            <Text style={[s.segText, scope === 'channels' && s.segTextActive]}>Public channels</Text>
          </Press>
        </View>

        <View style={s.search}>
          <Text style={s.searchIcon}>🔍</Text>
          <TextInput
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={scope === 'people' ? 'Search names or npubs…' : 'Search public channels…'}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="new-message-search"
          />
        </View>
      </View>

      {scope === 'people' ? (
        <>
          <Text style={s.eyebrow}>PHONE BOOK</Text>
          <FlatList
            style={s.flex}
            data={filteredPeople}
            keyExtractor={c => c.pubkey}
            ListEmptyComponent={<Text style={s.empty}>No contacts match your search.</Text>}
            renderItem={({item}) => (
              <Press variant="row" style={s.row} onPress={() => onSelect(item.pubkey)} accessibilityLabel={`contact-${item.pubkey}`}>
                <GradientAvatar gradient={item.gradient} seed={item.npub} size={38} shape="circle" />
                <View style={s.rowBody}>
                  <Text style={s.name} numberOfLines={1}>{item.name?.trim() || shortNpub(item.npub)}</Text>
                  <Text style={s.npub} numberOfLines={1}>{shortNpub(item.npub)}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </Press>
            )}
          />
        </>
      ) : (
        <>
          <Text style={s.eyebrow}>PUBLIC CHANNELS</Text>
          <FlatList
            style={s.flex}
            data={filteredChannels}
            keyExtractor={c => c.id}
            ListEmptyComponent={<Text style={s.empty}>No public channels match your search.</Text>}
            renderItem={({item}) => (
              <Press
                variant="row"
                style={s.row}
                onPress={() => onSelectChannel?.(item.id)}
                accessibilityLabel={`channel-${item.id}`}>
                <GradientAvatar
                  gradient={item.gradient}
                  seed={item.id}
                  size={38}
                  shape={item.openCommunity ? 'octagon' : 'square'}
                />
                <View style={s.rowBody}>
                  <Text style={s.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={s.sub} numberOfLines={1}>
                    {item.openCommunity ? 'Open · anyone can join' : 'Public'}
                    {item.about ? ` · ${item.about}` : ''}
                  </Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </Press>
            )}
          />
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex: {flex: 1},
  backBar: {borderBottomWidth: 1, borderBottomColor: colors.border},
  backNav: {paddingHorizontal: 12, paddingVertical: 8},
  head: {paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6},
  title: {fontSize: 19, fontWeight: ctWeight.bold, color: colors.textPrimary, marginBottom: 10},
  // Segmented toggle
  segment: {flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 3, marginBottom: 10},
  segBtn: {flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8},
  segBtnActive: {backgroundColor: colors.accent},
  segText: {fontSize: 13.5, fontWeight: ctWeight.semibold, color: colors.textSecondary},
  segTextActive: {color: colors.onAccent},
  search: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: ctRadius.ref, paddingHorizontal: 12, paddingVertical: 9},
  searchIcon: {fontSize: 14, opacity: 0.7},
  searchInput: {flex: 1, color: colors.textPrimary, fontSize: 14, padding: 0},
  eyebrow: {fontSize: ctType.microLabel.fontSize, color: colors.textMuted, fontWeight: ctWeight.bold, letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border},
  rowBody: {flex: 1, minWidth: 0},
  name: {fontSize: 15, fontWeight: ctWeight.semibold, color: colors.textPrimary},
  npub: {fontSize: 11.5, color: colors.link, fontFamily: 'monospace', marginTop: 1},
  sub: {fontSize: 12, color: colors.textSecondary, marginTop: 1},
  chevron: {color: colors.textMuted, fontSize: 18},
  empty: {textAlign: 'center', color: colors.textMuted, fontSize: 14, paddingVertical: 30, paddingHorizontal: 24},
});
