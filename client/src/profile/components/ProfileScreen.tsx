/**
 * ProfileScreen — redesigned with avatar, copyable npub chip, card posts,
 * pill channel badges, and a full-width blue Message button.
 */
import React, {useEffect, useState} from 'react';
import {
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import type {Profile, ProfileIdea} from '../profile';
import type {FeedItem} from '../../feed/feed';
import {MAX_DISPLAY_NAME} from '../displayName';
import {shortenNpub} from '../../util/npub';
import {copySensitive} from '../../util/clipboard';
import {gradientFromSeed, type GradientSpec} from '../../media/gradient';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {GradientMaker} from '../../ui/GradientMaker';
import {colors, space, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {useSwipeOptOut} from '../../ui/swipeOptOut';

export interface ProfileScreenProps {
  profile: Profile;
  onOpenChannel: (channelId: string) => void;
  onOpenPost?: (item: FeedItem) => void;
  onOpenDM?: (pubkey: string) => void;
  editable?: boolean;
  onSaveName?: (name: string) => void;
  /** Set or change the viewer's identity gradient. Provided only on the viewer's own profile. */
  onSetGradient?: (spec: GradientSpec) => void;
  /** Number of ideas (comments) posted by this user — shown in stats row. */
  ideaCount?: number;
}

function shortNpub(npub: string): string {
  return shortenNpub(npub, {lead: 10, tail: 8, minLen: 24});
}

function NpubChip({npub}: {npub: string}): React.JSX.Element {
  const copyNpub = (): void => {
    copySensitive(npub);
    Alert.alert('Copied!');
  };
  return (
    <Press style={s.npubChip} onPress={copyNpub}>
      <Text style={s.npubChipText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub)}</Text>
      <Text style={s.npubCopyIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}> ⎘</Text>
    </Press>
  );
}

type ListItem =
  | {_type: 'avatar-header'}
  | {_type: 'gradient-section'}
  | {_type: 'channel-section'}
  | {_type: 'tab-toggle'}
  | {_type: 'post'; item: FeedItem}
  | {_type: 'idea'; idea: ProfileIdea}
  | {_type: 'empty-tab'};

/**
 * The name-clash warning, shown ONLY on the viewer's own profile and ONLY once the clash is a
 * settled fact (`profile.nameConflict` — see displayName.ts `nameConflict`).
 *
 * Why here, and not at onboarding: at onboarding the phonebook is empty (nothing has synced yet),
 * so any "this name is taken / available" check there would be vacuous — and the "available" answer
 * would be an outright false guarantee. This is the first moment the answer is actually knowable,
 * and it is also where the fix lives: "Pick a different name" opens the same name editor the
 * Edit-profile button does, one tap away.
 *
 * The copy deliberately states the OBSERVABLE consequence ("shown as your npub") rather than a
 * scolding, and never claims a new name would be free — nothing local can know that.
 */
function NameConflictBanner({onRename}: {onRename: () => void}): React.JSX.Element {
  return (
    <View style={s.conflictCard}>
      <Text style={s.conflictTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⚠  Someone claimed this name first</Text>
      <Text style={s.conflictBody} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        Another member was already using this name before you, so to everyone else in the community
        you're shown as your npub, not your name. Picking a different one fixes it.
      </Text>
      <Press style={s.conflictBtn} onPress={onRename}>
        <Text style={s.conflictBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Pick a different name</Text>
      </Press>
    </View>
  );
}

export function ProfileScreen({
  profile,
  onOpenChannel,
  onOpenPost,
  onOpenDM,
  editable,
  onSaveName,
  onSetGradient,
  ideaCount,
}: ProfileScreenProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  // The gradient editor stays collapsed until the user taps to open it.
  const [gradOpen, setGradOpen] = useState(false);
  // Content tab: the user's own posts (default) vs their "ideas" (comments). Either/or, never mixed.
  const [profileTab, setProfileTab] = useState<'posts' | 'ideas'>('posts');
  const [nameDraft, setNameDraft] = useState(profile.name ?? '');
  // The name + gradient currently shown for this identity. On the viewer's OWN profile the captured
  // `profile` prop is a stale snapshot (the parent doesn't re-pass it when the runtime emits after a
  // Save), so both are echoed locally on save so the header reflects the change immediately — for
  // the own profile the echoed value equals what the runtime committed (self name/gradient are
  // never overridden by the longest-held-wins reconcile). See the sync effect below for reopen.
  const [savedName, setSavedName] = useState(profile.name ?? '');
  const [savedGradient, setSavedGradient] = useState<GradientSpec | undefined>(profile.gradient);
  // The name clash, echoed locally for the same stale-snapshot reason as savedName: the parent
  // doesn't re-pass `profile` after a save, so without this a member who had just renamed away from
  // the clash would keep staring at a warning about a name they no longer use.
  const [conflict, setConflict] = useState(profile.nameConflict);
  // The working copy being edited in the maker.
  const [gradDraft, setGradDraft] = useState<GradientSpec>(
    () => profile.gradient ?? gradientFromSeed(profile.npub),
  );

  // Re-derive the shown name/gradient from the incoming profile whenever it actually changes — a
  // fresh snapshot (reopen / navigating to another member / a parent that DOES re-pass live identity
  // on emit). Keyed on the concrete values, not object identity, so a stable same-identity re-render
  // never clobbers the just-saved local echo (those deps are unchanged until the prop truly updates).
  useEffect(() => {
    setSavedName(profile.name ?? '');
    setSavedGradient(profile.gradient);
    setConflict(profile.nameConflict);
  }, [profile.pubkey, profile.npub, profile.name, profile.gradient, profile.nameConflict]);

  // Stands this page's own swipe-back down for touches beginning on the display-name field or the
  // "ACTIVE IN" channel rail below — spread onto each; see the opt-outs there for what they protect.
  const optOut = useSwipeOptOut();

  const saveName = (): void => {
    const next = nameDraft.trim();
    onSaveName?.(next);
    setSavedName(next); // reflect immediately; the captured `profile` prop won't refresh on its own
    // Any clash we were warning about was against the OLD name. Whether the NEW one also clashes is
    // a question only the runtime can re-answer (it compares every claim we've synced) — so clear
    // the warning rather than assert either way; the next fresh snapshot restores it if it still
    // applies. Deliberately NOT replaced with a "name is free!" confirmation: nothing local knows.
    setConflict(undefined);
    setEditing(false);
  };

  const saveGradient = (): void => {
    onSetGradient?.(gradDraft);
    setSavedGradient(gradDraft);
    Alert.alert('Gradient saved');
  };

  // The gradient editor is shown only on the viewer's own profile.
  const showGradientSection = !!editable && !!onSetGradient;
  // What to paint for this identity: the saved gradient (own profile reflects edits immediately),
  // else undefined → the renderer derives one from the npub seed.
  const shownGradient = savedGradient;

  const activeCount = profileTab === 'posts' ? profile.posts.length : profile.ideas.length;
  const data: ListItem[] = [
    {_type: 'avatar-header'},
    ...(showGradientSection ? [{_type: 'gradient-section' as const}] : []),
    ...(profile.channels.length > 0 ? [{_type: 'channel-section' as const}] : []),
    {_type: 'tab-toggle'},
    ...(activeCount === 0
      ? [{_type: 'empty-tab' as const}]
      : profileTab === 'posts'
        ? profile.posts.map(p => ({_type: 'post' as const, item: p}))
        : profile.ideas.map(idea => ({_type: 'idea' as const, idea}))),
  ];

  return (
    // Plain View, not SafeAreaView: ProfileScreen only ever renders inside MainScreen's profile
    // overlay, whose SafeAreaView already supplies the top inset — a SafeAreaView here would
    // double-pad and push the content too far below the Dynamic Island.
    <View style={s.root}>
      <FlatList
        data={data}
        keyExtractor={(item, i) => {
          if (item._type === 'avatar-header') return 'avatar-header';
          if (item._type === 'gradient-section') return 'gradient-section';
          if (item._type === 'channel-section') return 'channel-section';
          if (item._type === 'tab-toggle') return 'tab-toggle';
          if (item._type === 'empty-tab') return 'empty-tab';
          if (item._type === 'idea') return `idea-${item.idea.id}-${i}`;
          return `post-${item.item.id}-${i}`;
        }}
        renderItem={({item}) => {
          if (item._type === 'avatar-header') {
            return (
              <View style={s.headerCard}>
                {/* Avatar (tappable on own profile → gradient editor) */}
                <Press
                  onPress={editable && onSetGradient ? () => { setGradDraft(savedGradient ?? gradientFromSeed(profile.npub)); setGradOpen(v => !v); } : undefined}
                  style={s.avatarWrap}>
                  <GradientAvatar gradient={shownGradient} seed={profile.npub} size={80} ring />
                  {editable && onSetGradient && (
                    <View style={s.editBadge}><Text style={s.editBadgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️</Text></View>
                  )}
                </Press>

                {/* Name */}
                {editing ? (
                  <View style={s.editRow}>
                    {/* A TextInput's own selection-handle drag doesn't join JS PanResponder
                        negotiation, so without this opt-out the page-level swipe-back would win a
                        rightward drag started inside the field instead of moving the cursor. */}
                    <TextInput
                      style={s.nameInput}
                      value={nameDraft}
                      onChangeText={setNameDraft}
                      placeholder="Your display name"
                      placeholderTextColor={colors.textMuted}
                      maxLength={MAX_DISPLAY_NAME}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={saveName}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                      {...optOut}
                    />
                    <Press style={s.nameSaveBtn} onPress={saveName}>
                      <Text style={s.nameSaveText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Save</Text>
                    </Press>
                  </View>
                ) : (
                  <View style={s.nameRow}>
                    <Text style={s.name} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{savedName.trim() || 'Anonymous member'}</Text>
                  </View>
                )}

                {/* npub */}
                <NpubChip npub={profile.npub} />

                {/* Name clash (own profile only, and only once it's a settled fact). Sits right
                    under the npub chip the warning refers to; hidden while the editor is open,
                    since the fix is already on screen at that point. */}
                {editable && conflict && !editing && (
                  <NameConflictBanner
                    onRename={() => { setNameDraft(savedName); setEditing(true); }}
                  />
                )}

                {/* Bio */}
                {profile.about ? <Text style={s.about}>{profile.about}</Text> : null}

                {/* Stats row */}
                <View style={s.statsCard}>
                  <View style={s.statCell}>
                    <Text style={s.statNum} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{profile.posts.length}</Text>
                    <Text style={s.statLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>POSTS</Text>
                  </View>
                  <View style={s.statDivider} />
                  <View style={s.statCell}>
                    <Text style={s.statNum} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{ideaCount ?? '—'}</Text>
                    <Text style={s.statLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>IDEAS</Text>
                  </View>
                  <View style={s.statDivider} />
                  <View style={s.statCell}>
                    <Text style={s.statNum} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{profile.channels.length}</Text>
                    <Text style={s.statLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>CHANNELS</Text>
                  </View>
                </View>

                {/* Action buttons */}
                {editable ? (
                  <View style={s.actionsRow}>
                    <Press
                      style={[s.actionBtn, s.actionBtnPrimary]}
                      onPress={() => { setNameDraft(savedName); setEditing(true); }}>
                      <Text style={s.actionBtnPrimaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Edit profile</Text>
                    </Press>
                    <Press style={[s.actionBtn, s.actionBtnSecondary]} onPress={() => {
                      copySensitive(profile.npub);
                      Alert.alert('Copied!');
                    }}>
                      <Text style={s.actionBtnSecondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Share npub</Text>
                    </Press>
                  </View>
                ) : (
                  <View style={s.actionsRow}>
                    {onOpenDM && (
                      <Press style={[s.actionBtn, s.actionBtnPrimary]} onPress={() => onOpenDM(profile.pubkey)}>
                        <Text style={s.actionBtnPrimaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Message</Text>
                      </Press>
                    )}
                    <Press style={[s.actionBtn, s.actionBtnSecondary]} onPress={() => {
                      copySensitive(profile.npub);
                      Alert.alert('Copied!');
                    }}>
                      <Text style={s.actionBtnSecondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Share npub</Text>
                    </Press>
                  </View>
                )}
              </View>
            );
          }

          if (item._type === 'gradient-section') {
            if (!gradOpen) return null;
            const dirty = JSON.stringify(gradDraft) !== JSON.stringify(savedGradient);
            return (
              <View style={s.gradientCard}>
                <View style={s.gradCardHeader}>
                  <Text style={s.sectionTitleInline} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>IDENTITY GRADIENT</Text>
                  <Press onPress={() => setGradOpen(false)}>
                    <Text style={s.gradCollapse} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
                  </Press>
                </View>
                <Text style={s.gradHelp} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  This gradient is how the community recognizes you — no name, no face. Make it
                  yours; change it whenever you like.
                </Text>
                <View style={s.gradMakerWrap}>
                  <GradientMaker value={gradDraft} onChange={setGradDraft} previewSize={120} />
                </View>
                <Press
                  style={[s.gradSetBtn, !dirty && s.gradSetBtnDisabled]}
                  onPress={dirty ? saveGradient : undefined}>
                  <Text style={s.gradSetBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{dirty ? 'Save gradient' : 'Saved'}</Text>
                </Press>
              </View>
            );
          }

          if (item._type === 'channel-section') {
            return (
              <View>
                <Text style={s.sectionTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>ACTIVE IN</Text>
                {/* A native horizontal ScrollView never joins JS PanResponder negotiation, so without
                    this opt-out the page-level swipe-back would win any rightward drag that starts on
                    the rail and it would never get to scroll itself. */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.channelScroll}
                  {...optOut}>
                  {profile.channels.map(ch => (
                    <Press
                      key={ch.id}
                      variant="row"
                      style={s.channelCard}
                      onPress={() => onOpenChannel(ch.id)}>
                      <GradientAvatar gradient={ch.gradient} seed={ch.id} size={40} radius={radius.md} />
                      <Text style={s.channelCardName} numberOfLines={2} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{ch.name}</Text>
                    </Press>
                  ))}
                </ScrollView>
              </View>
            );
          }

          if (item._type === 'tab-toggle') {
            return (
              <View style={s.tabRow}>
                {(['posts', 'ideas'] as const).map(t => (
                  <Press
                    key={t}
                    accessibilityLabel={t === 'posts' ? 'Show posts' : 'Show ideas'}
                    style={[s.tabChip, profileTab === t && s.tabChipActive]}
                    onPress={() => setProfileTab(t)}>
                    <Text style={[s.tabChipText, profileTab === t && s.tabChipTextActive]}>
                      {t === 'posts' ? 'Posts' : 'Ideas'}
                    </Text>
                  </Press>
                ))}
              </View>
            );
          }

          if (item._type === 'empty-tab') {
            return (
              <View style={s.empty}>
                <Text style={s.emptyText}>{profileTab === 'posts' ? 'No posts yet.' : 'No ideas yet.'}</Text>
              </View>
            );
          }

          if (item._type === 'idea') {
            const idea = item.idea;
            return (
              <Press
                variant="row"
                style={s.postCard}
                onPress={idea.rootPost && onOpenPost ? () => onOpenPost(idea.rootPost!) : undefined}>
                <Text style={s.postCardContentLead} numberOfLines={3}>
                  {idea.content || '(no text)'}
                </Text>
                <Text style={s.postCardMeta}>
                  {new Date(idea.createdAt * 1000).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric',
                  })}
                  {idea.rootTitle ? `  ·  on “${idea.rootTitle}”` : ''}
                </Text>
              </Press>
            );
          }

          // Post mini-card
          return (
            <Press
              variant="row"
              style={s.postCard}
              onPress={onOpenPost ? () => onOpenPost(item.item) : undefined}>
              {item.item.title ? (
                <Text style={s.postCardTitle}>{item.item.title}</Text>
              ) : null}
              <Text
                style={item.item.title ? s.postCardContent : s.postCardContentLead}
                numberOfLines={2}>
                {item.item.content}
              </Text>
              <Text style={s.postCardMeta} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {new Date(item.item.createdAt * 1000).toLocaleDateString(undefined, {
                  month: 'short', day: 'numeric',
                })}
                {item.item.score ? `  ·  ${item.item.score > 0 ? '+' : ''}${item.item.score}` : ''}
                {item.item.commentCount ? `  ·  💬 ${item.item.commentCount}` : ''}
              </Text>
            </Press>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},

  // Hero header card
  headerCard: {
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  avatarWrap: {marginBottom: 4, position: 'relative'},
  editBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  editBadgeText: {fontSize: 12},
  nameRow: {alignItems: 'center'},
  name: {fontSize: 22, fontWeight: weight.bold, color: colors.textPrimary},
  editRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, width: '100%'},
  nameInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: weight.bold,
    color: colors.textPrimary,
    borderBottomWidth: 1,
    borderBottomColor: colors.accent,
    paddingVertical: 2,
    textAlign: 'center',
  },
  nameSaveBtn: {backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6},
  nameSaveText: {color: colors.onAccent, fontSize: typeScale.label, fontWeight: weight.bold},

  // npub chip
  npubChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
  },
  npubChipText: {fontSize: 13, color: colors.link, fontFamily: 'monospace'},
  npubCopyIcon: {fontSize: 13, color: colors.accent},

  about: {fontSize: typeScale.body, color: colors.textSecondary, textAlign: 'center', lineHeight: 22},

  // Name-clash warning (own profile only)
  conflictCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: 8,
  },
  conflictTitle: {fontSize: typeScale.label, fontWeight: weight.bold, color: colors.warning},
  conflictBody: {fontSize: typeScale.caption, color: colors.textSecondary, lineHeight: 19},
  conflictBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  conflictBtnText: {fontSize: typeScale.label, fontWeight: weight.semibold, color: colors.textPrimary},

  // Stats row
  statsCard: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 4,
    overflow: 'hidden',
  },
  statCell: {flex: 1, alignItems: 'center', paddingVertical: 12},
  statNum: {fontSize: 19, fontWeight: weight.bold, color: colors.textPrimary},
  statLabel: {fontSize: 11, color: colors.textMuted, fontWeight: weight.semibold, letterSpacing: 0.5, marginTop: 2},
  statDivider: {width: 1, backgroundColor: colors.border, marginVertical: 10},

  // Action buttons row
  actionsRow: {flexDirection: 'row', gap: 10, alignSelf: 'stretch'},
  actionBtn: {flex: 1, borderRadius: radius.pill, paddingVertical: 11, alignItems: 'center'},
  actionBtnPrimary: {backgroundColor: colors.accent},
  actionBtnPrimaryText: {color: colors.onAccent, fontSize: typeScale.label, fontWeight: weight.semibold},
  actionBtnSecondary: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border},
  actionBtnSecondaryText: {color: colors.textPrimary, fontSize: typeScale.label, fontWeight: weight.semibold},

  // Gradient editor card
  gradCardHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  sectionTitleInline: {
    fontSize: typeScale.micro,
    color: colors.textMuted,
    fontWeight: weight.semibold,
    letterSpacing: 0.8,
  },
  gradCollapse: {fontSize: typeScale.label, color: colors.accent, fontWeight: weight.semibold},
  gradientCard: {
    marginHorizontal: space.md,
    marginTop: space.lg,
    padding: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.md,
  },
  gradHelp: {fontSize: typeScale.caption, color: colors.textSecondary, lineHeight: 19},
  gradMakerWrap: {marginTop: space.xs},
  gradSetBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: space.xs,
  },
  gradSetBtnDisabled: {backgroundColor: colors.surfaceHover},
  gradSetBtnText: {color: colors.onAccent, fontSize: typeScale.body, fontWeight: weight.bold},

  // Section headers
  sectionTitle: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: space.md,
    paddingTop: 20,
    paddingBottom: space.sm,
  },

  // Posts / Ideas tab toggle (matches the app's pill-chip filter pattern)
  tabRow: {flexDirection: 'row', gap: 8, paddingHorizontal: space.md, paddingTop: 20, paddingBottom: space.sm},
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabChipActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  tabChipText: {fontSize: 13, fontWeight: weight.semibold, color: colors.textSecondary},
  tabChipTextActive: {color: colors.onAccent},

  // Channel horizontal scroll cards
  channelScroll: {paddingHorizontal: space.md, paddingBottom: space.md, gap: 10},
  channelCard: {
    width: 118,
    backgroundColor: colors.surface,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    alignItems: 'flex-start',
    gap: 8,
  },
  channelCardName: {fontSize: typeScale.caption, color: colors.textPrimary, fontWeight: weight.semibold},

  // Post mini-cards
  postCard: {
    marginHorizontal: space.md,
    marginVertical: 4,
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  postCardTitle: {fontSize: typeScale.label, fontWeight: weight.bold, color: colors.textPrimary},
  postCardContent: {fontSize: typeScale.label, color: colors.textSecondary, lineHeight: 20},
  postCardContentLead: {fontSize: typeScale.body, color: colors.textPrimary, lineHeight: 22},
  postCardMeta: {fontSize: typeScale.micro, color: colors.textMuted, marginTop: 2},

  empty: {flex: 1, alignItems: 'center', paddingTop: space.xl},
  emptyText: {fontSize: typeScale.body, color: colors.textSecondary},
});
