/**
 * ChannelDetail — the channel detail bottom-sheet content, reached by tapping the channel title.
 *
 * Re-skinned to the Stiq "Channel detail sheet" handoff (Overlay A): a centered header
 * (72px identity avatar shaped by channel type, name, "{Type} · {members}", about), an
 * owner/admin-only "Edit channel" card (name / colour / reactions), a groups-only Members
 * roster card, and an actions block (mute toggle + a relationship-dependent destructive
 * button). The slide-up scrim + grabber handle are supplied by the parent Modal.
 *
 * All existing props and behaviors are preserved (edit name/about/gradient/reactions, mute,
 * delete, open owner). New optional props (channelType, members, relationship, onLeave/onFollow,
 * canEdit, onSaveToEmbed) are backward-compatible and default to the prior behavior.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Alert, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {chMuteId, isSourceMuted, toggleMute} from '../../notifications/notifications';
import * as nip19 from 'nostr-tools/nip19';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import type {Channel, ChannelMetadata} from '../channels';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import {GradientMaker} from '../../ui/GradientMaker';
import {ReactionSlots} from './ReactionPicker';
import {gradientFromSeed, type GradientSpec} from '../../media/gradient';
import {colors, DENSE_MAX_FONT_SCALE} from '../../ui/theme';

/** The viewer's relationship to the channel — drives the destructive action's label. */
export type ChannelRelationship = 'owner' | 'group' | 'following' | 'none';

/** A member shown in the groups-only roster. */
export interface ChannelMember {
  pubkey: string;
  /** Display name (falls back to a short npub when absent). */
  name?: string;
  gradient?: GradientSpec;
  /** Role pill text: "Owner" / "Admin". Absent = no pill. */
  role?: string;
}

export interface ChannelDetailProps {
  channel: Channel;
  /** Open the owner's profile. */
  onOpenOwner?: (pubkey: string) => void;
  /** Whether the viewer owns this channel (unlocks the editable settings). */
  isOwner?: boolean;
  /**
   * Whether the viewer may edit channel settings (name/colour/reactions). Owner or admin.
   * Defaults to `isOwner` for backward compatibility.
   */
  canEdit?: boolean;
  /** Persist edited channel metadata (republishes the 30311 definition). */
  onSaveChannel?: (meta: ChannelMetadata) => void;
  /** Owner action: delete this channel (NIP-09). Absent hides the button. */
  onDeleteChannel?: () => void;
  /**
   * Channel kind — drives the avatar shape and the "{Type}" sub-line.
   * 'public' → rounded square, 'private' → diamond, 'open' → octagon, 'group' → hexagon.
   * Defaults to 'public'.
   */
  channelType?: 'public' | 'private' | 'open' | 'group';
  /** Member roster — shown only for groups. */
  members?: ChannelMember[];
  /** Total member count for the header sub-line and the "Members · N" eyebrow. */
  memberCount?: number;
  /**
   * The viewer's relationship — picks the destructive button label:
   * 'owner' → Delete channel · 'group' → Leave group · 'following' → Leave channel · 'none' → Follow channel.
   * Defaults to 'owner' when `isOwner`, else 'none'.
   */
  relationship?: ChannelRelationship;
  /** Leave a group / unfollow a channel. */
  onLeave?: () => void;
  /** Follow a channel you don't yet follow. */
  onFollow?: () => void;
  /** Save this channel as an embeddable reference (e.g. to paste into a post). Absent hides the row. */
  onSaveToEmbed?: () => void;
}

function shortNpub(pubkey: string): string {
  try {
    return shortenNpub(nip19.npubEncode(pubkey), {lead: 12, tail: 4});
  } catch {
    return pubkey.slice(0, 12);
  }
}

/** Accept an npub OR a raw 64-hex pubkey; returns the hex pubkey, or null if unparseable. */
function decodePubkey(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const d = nip19.decode(s);
    if (d.type === 'npub') return d.data as string;
  } catch { /* invalid */ }
  return null;
}

const SHAPE_BY_TYPE: Record<NonNullable<ChannelDetailProps['channelType']>, AvatarShape> = {
  public: 'square',
  private: 'diamond',
  open: 'octagon',
  group: 'hexagon',
};

const TYPE_LABEL: Record<NonNullable<ChannelDetailProps['channelType']>, string> = {
  public: 'Public',
  private: 'Private',
  open: 'Open community',
  group: 'Group chat',
};

const LEAVE_LABEL: Record<ChannelRelationship, string> = {
  owner: 'Delete channel',
  group: 'Leave group',
  following: 'Leave channel',
  none: 'Follow channel',
};

export function ChannelDetail({
  channel,
  onOpenOwner,
  isOwner,
  canEdit,
  onSaveChannel,
  onDeleteChannel,
  channelType = 'public',
  members = [],
  memberCount,
  relationship,
  onLeave,
  onFollow,
  onSaveToEmbed,
}: ChannelDetailProps): React.JSX.Element {
  const muteId = chMuteId(channel.id);
  const [muted, setMuted] = useState(false);
  useEffect(() => { void isSourceMuted(muteId).then(setMuted); }, [muteId]);
  const handleMuteToggle = (): void => {
    void toggleMute(muteId)
      .then(setMuted)
      .catch(() => {
        // toggleMute already reverted its in-memory mute-set on a failed write, and `muted` was
        // never optimistically flipped here — just tell the user it didn't take.
        Alert.alert('Could not update mute setting', 'Please try again.');
      });
  };

  // Editable fields (owner/admin only). Seeded from the (possibly stale) channel prop.
  const [name, setName] = useState(channel.name);
  const [grad, setGrad] = useState<GradientSpec>(channel.gradient ?? gradientFromSeed(channel.id));
  const [reactions, setReactions] = useState<string[]>(channel.reactions ?? []);
  const [admins, setAdmins] = useState<string[]>(channel.admins ?? []);
  const [adminDraft, setAdminDraft] = useState('');
  // Locally-tracked saved gradient so the header preview updates immediately on edit — the
  // `channel` prop stays stale until the republished 30311 round-trips back through the relay.
  const [savedGradient, setSavedGradient] = useState<GradientSpec | undefined>(channel.gradient);

  const editable = canEdit ?? !!isOwner;
  const showEdit = editable && !!onSaveChannel;
  // Owner-only admin management (the admin roster lives on the owner-signed 30311, so only the owner
  // can change it). Shown for channels — most useful for an open community where admins also post.
  const showAdmins = !!isOwner && !!onSaveChannel && channelType !== 'group';
  // The edit form (name + colour picker + reactions) is tall, so it collapses by default to keep
  // the detail sheet compact — tap the eyebrow to expand. Available for every editable channel type.
  const [editExpanded, setEditExpanded] = useState(false);
  const showMembers = channelType === 'group';
  const rel: ChannelRelationship = relationship ?? (isOwner ? 'owner' : 'none');

  const headerGradient = savedGradient ?? channel.gradient;
  const shape = SHAPE_BY_TYPE[channelType];
  const count = memberCount ?? (members.length || undefined);
  const headerSub = count != null ? `${TYPE_LABEL[channelType]} · ${count} members` : TYPE_LABEL[channelType];

  // Edits are live overrides (no Save button) — but republishing the 30311 on EVERY keystroke floods
  // the relay with a signed publish per character (laggy + racy: "not responding properly"). So
  // coalesce: `draftRef` always holds the latest metadata (updated synchronously per change) and a
  // single debounced commit republishes ~500ms after the last edit. `admins`/`openCommunity` aren't
  // in the draft — AppRuntime.editChannel preserves them — except when the admin roster is edited,
  // which sets draftRef.admins explicitly so it round-trips.
  const draftRef = useRef<ChannelMetadata>({
    name: channel.name,
    about: channel.about,
    gradient: channel.gradient ?? grad,
    reactions: channel.reactions ?? [],
  });
  const saveRef = useRef(onSaveChannel);
  saveRef.current = onSaveChannel;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const commitNow = (): void => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (dirtyRef.current) { dirtyRef.current = false; saveRef.current?.({...draftRef.current}); }
  };
  const schedule = (): void => {
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(commitNow, 500);
  };
  // Flush any pending edit when the sheet unmounts (closes) so a just-typed change isn't dropped.
  useEffect(() => () => { commitNow(); }, []);

  const onNameChange = (v: string): void => { setName(v); draftRef.current.name = v.trim() || channel.name; schedule(); };
  const onGradChange = (g: GradientSpec): void => { setGrad(g); setSavedGradient(g); draftRef.current.gradient = g; schedule(); };
  const onReactionsChange = (next: string[]): void => { setReactions(next); draftRef.current.reactions = next; schedule(); };
  const commitAdmins = (next: string[]): void => { setAdmins(next); draftRef.current.admins = next; schedule(); };
  const addAdmin = (): void => {
    const hex = decodePubkey(adminDraft);
    setAdminDraft('');
    if (!hex || hex === channel.owner || admins.includes(hex)) return;
    commitAdmins([...admins, hex]);
  };
  const removeAdmin = (pk: string): void => commitAdmins(admins.filter(a => a !== pk));

  const confirmDelete = (): void => {
    Alert.alert('Delete channel?', 'This removes the channel for everyone. It can\'t be undone.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress: () => onDeleteChannel?.()},
    ]);
  };

  const handleLeavePress = (): void => {
    if (rel === 'owner') confirmDelete();
    else if (rel === 'none') onFollow?.();
    else onLeave?.();
  };

  // The destructive/relationship button is shown when its action is actually wired.
  const hasLeaveAction =
    (rel === 'owner' && !!onDeleteChannel) ||
    (rel === 'none' && !!onFollow) ||
    ((rel === 'group' || rel === 'following') && !!onLeave);

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
      {/* ── Header ── */}
      <View style={s.header}>
        <GradientAvatar gradient={headerGradient} seed={channel.id} size={72} shape={shape} style={s.headerAvatar} />
        <Text style={s.name} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{channel.name}</Text>
        <Text style={s.headerSub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{headerSub}</Text>
        {!!channel.about && <Text style={s.about}>{channel.about}</Text>}
      </View>

      {/* ── Edit channel (owner / admin) — collapsible ── */}
      {showEdit && (
        <View style={s.card}>
          <Press
            variant="row"
            style={s.collapseHead}
            onPress={() => setEditExpanded(e => !e)}
            accessibilityLabel={editExpanded ? 'collapse edit channel' : 'expand edit channel'}>
            <Text style={s.eyebrowFlush} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>EDIT CHANNEL</Text>
            <Text style={s.collapseChevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{editExpanded ? '▴' : '▾'}</Text>
          </Press>

          {editExpanded && (
            <View style={s.collapseBody}>
              <Text style={s.fieldLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Name</Text>
              <TextInput
                style={s.input}
                value={name}
                onChangeText={onNameChange}
                placeholder="Channel name"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={[s.fieldLabel, s.fieldLabelGap]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Colour</Text>
              <GradientMaker value={grad} onChange={onGradChange} previewSize={76} />

              <Text style={[s.fieldLabel, s.fieldLabelGap]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Reactions</Text>
              <ReactionSlots value={reactions} onChange={onReactionsChange} />
              <Text style={s.helper} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Fill a slot with any emoji to offer it as a one-tap reaction on every post in this channel. Empty slots = no reaction.
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── Admins (owner-only; channels) — promote by npub / demote with ✕ ── */}
      {showAdmins && (
        <View style={s.card}>
          <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>ADMINS · {admins.length + 1}</Text>
          <Text style={s.helper} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {channelType === 'open'
              ? 'Admins post to this community and help moderate it. Add one by npub; ✕ to remove.'
              : 'Admins help moderate this channel. Add one by npub; ✕ to remove.'}
          </Text>
          <View style={[s.roster, s.adminRoster]}>
            <View style={s.memberRow}>
              <GradientAvatar gradient={channel.gradient} seed={safeNpubEncode(channel.owner)} size={32} shape="circle" style={s.memberAvatar} />
              <View style={s.memberText}>
                <Text style={s.memberName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(channel.owner)}</Text>
              </View>
              <Text style={s.rolePill} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Owner</Text>
            </View>
            {admins.map(pk => (
              <View key={pk} style={s.memberRow}>
                <GradientAvatar seed={safeNpubEncode(pk)} size={32} shape="circle" style={s.memberAvatar} />
                <View style={s.memberText}>
                  <Text style={s.memberName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(pk)}</Text>
                </View>
                <Text style={s.rolePill} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Admin</Text>
                <Press onPress={() => removeAdmin(pk)} accessibilityLabel={`demote-admin-${pk}`}>
                  <Text style={s.adminRemove} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕</Text>
                </Press>
              </View>
            ))}
          </View>
          <View style={s.adminAddRow}>
            <TextInput
              style={[s.input, s.adminAddInput]}
              value={adminDraft}
              onChangeText={setAdminDraft}
              placeholder="npub1… to promote"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="add-admin-npub"
            />
            <Press style={s.adminAddBtn} onPress={addAdmin} accessibilityLabel="add-admin">
              <Text style={s.adminAddBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Add</Text>
            </Press>
          </View>
        </View>
      )}

      {/* ── Members (groups only) ── */}
      {showMembers && (
        <View style={s.card}>
          <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>MEMBERS · {count ?? members.length}</Text>
          <View style={s.roster}>
            {members.map(mb => {
              const isYou = !!isOwner && mb.pubkey === channel.owner;
              return (
                <Press
                  variant="row"
                  key={mb.pubkey}
                  style={s.memberRow}
                  onPress={onOpenOwner ? () => onOpenOwner(mb.pubkey) : undefined}>
                  <GradientAvatar gradient={mb.gradient} seed={safeNpubEncode(mb.pubkey)} size={32} shape="circle" style={s.memberAvatar} />
                  <View style={s.memberText}>
                    <Text style={s.memberName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{mb.name || shortNpub(mb.pubkey)}</Text>
                    <Text style={s.memberNpub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(mb.pubkey)}</Text>
                  </View>
                  {isYou && <Text style={s.youTag} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>you</Text>}
                  {!!mb.role && <Text style={s.rolePill} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{mb.role}</Text>}
                </Press>
              );
            })}
          </View>
          {count != null && count > members.length && (
            <Text style={s.moreLink} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>+ {count - members.length} more members</Text>
          )}
        </View>
      )}

      {/* ── Owner profile (preserved behavior — broadcast channels are owner-voiced) ── */}
      {!showMembers && onOpenOwner && (
        <Press variant="row" style={s.linkRow} onPress={() => onOpenOwner(channel.owner)}>
          <Text style={s.linkRowLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(channel.owner)}</Text>
          <Text style={s.linkRowAction} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>View profile ›</Text>
        </Press>
      )}

      {/* ── Save to embed ── */}
      {onSaveToEmbed && (
        <Press variant="row" style={s.saveEmbedRow} onPress={onSaveToEmbed} accessibilityLabel="save channel to embed">
          <Text style={s.saveEmbedLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Save channel to embed</Text>
          <Text style={s.saveEmbedAction} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Save ›</Text>
        </Press>
      )}

      {/* ── Actions ── */}
      <View style={s.actions}>
        <Press variant="row" style={s.muteRow} onPress={handleMuteToggle}>
          <Text style={s.muteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔕 Mute notifications</Text>
          <Switch
            value={muted}
            onValueChange={handleMuteToggle}
            trackColor={{true: colors.accent, false: colors.borderLight}}
            thumbColor={colors.onAccent}
          />
        </Press>

        {hasLeaveAction && (
          <Press variant="row" style={s.leaveBtn} onPress={handleLeavePress}>
            <Text style={s.leaveBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{LEAVE_LABEL[rel]}</Text>
          </Press>
        )}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: {backgroundColor: colors.surface},
  content: {paddingTop: 4, paddingBottom: 18},

  // Header
  header: {alignItems: 'center', paddingHorizontal: 20, paddingBottom: 14},
  headerAvatar: {marginBottom: 12},
  name: {color: colors.textPrimary, fontSize: 21, fontWeight: '700', lineHeight: 26, textAlign: 'center'},
  headerSub: {color: colors.textMuted, fontSize: 13, marginTop: 4, textAlign: 'center'},
  about: {color: colors.textSecondary, fontSize: 14, lineHeight: 21, marginTop: 12, textAlign: 'center'},

  // surface-alt card (Edit / Members / Invite)
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: 9,
  },
  // Collapsible "EDIT CHANNEL" header: eyebrow flush (no bottom margin) + a chevron, tappable row.
  collapseHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  eyebrowFlush: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  collapseChevron: {color: colors.textMuted, fontSize: 13},
  collapseBody: {marginTop: 11},

  // Edit fields
  fieldLabel: {color: colors.textMuted, fontSize: 12, marginBottom: 6},
  fieldLabelGap: {marginTop: 14},
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 15,
  },
  emojiInput: {fontSize: 16, paddingVertical: 9},
  helper: {color: colors.textMuted, fontSize: 11.5, lineHeight: 17, marginTop: 6},

  // Members roster
  roster: {gap: 12},
  adminRoster: {marginTop: 10},
  adminRemove: {color: colors.danger, fontSize: 16, fontWeight: '700', paddingHorizontal: 4, flexShrink: 0},
  adminAddRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12},
  adminAddInput: {flex: 1, fontFamily: 'monospace', fontSize: 13},
  adminAddBtn: {backgroundColor: colors.accent, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 10, flexShrink: 0},
  adminAddBtnText: {color: colors.onAccent, fontWeight: '700', fontSize: 14},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  memberAvatar: {flexShrink: 0},
  memberText: {flex: 1, minWidth: 0},
  memberName: {color: colors.textPrimary, fontSize: 14, fontWeight: '600', lineHeight: 17},
  memberNpub: {color: colors.link, fontSize: 11, fontFamily: 'monospace', lineHeight: 15},
  youTag: {color: colors.textMuted, fontSize: 11, flexShrink: 0},
  rolePill: {
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: 'hidden',
    flexShrink: 0,
  },
  moreLink: {
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },

  // Owner profile link row
  linkRow: {
    marginHorizontal: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  linkRowLabel: {color: colors.textPrimary, fontSize: 14, fontFamily: 'monospace'},
  linkRowAction: {color: colors.accent, fontSize: 13, fontWeight: '600'},

  // Save channel to embed
  saveEmbedRow: {
    marginHorizontal: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  saveEmbedLabel: {color: colors.textPrimary, fontSize: 14, fontWeight: '600'},
  saveEmbedAction: {color: colors.accent, fontSize: 13, fontWeight: '600'},

  // Actions
  actions: {marginHorizontal: 16, gap: 8},
  muteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  muteLabel: {color: colors.textPrimary, fontSize: 14},
  leaveBtn: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  leaveBtnText: {color: colors.danger, fontSize: 14, fontWeight: '600', textAlign: 'left'},
});
