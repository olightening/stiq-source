/**
 * GroupView — NIP-29 relay-managed group screen.
 *
 * Full membership + moderation: join/leave, kick, promote/demote, add member, edit metadata
 * (incl. private/closed), approve/deny pending join requests, owner delete + ownership transfer.
 * Chat is rich (timestamps + Markdown via RichText) and supports threaded replies (kind 12).
 * All authority is relay-enforced; this UI is a thin reflection of relay-enforced state.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import Clipboard from '@react-native-clipboard/clipboard';
import {copySensitive} from '../../util/clipboard';
import type {Event} from 'nostr-tools/pure';
import type {GroupMeta} from '../groups';
import type {LogOffer} from '../logOffer';
import type {PostInteractions} from '../interactions';
import type {SendStatus} from '../../nostr/outbox';
import {calmRejection} from '../../feed/rejectionMessages';
import type {GradientSpec} from '../../media/gradient';
import {colors, space, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import {JumpButton} from '../../ui/JumpButton';
import {BACK_PRIORITY, useBackAction} from '../../ui/back';
import {useReturnToLatest} from '../../ui/useReturnToLatest';
import {useNewWhileAway} from '../../ui/useNewWhileAway';
import {useSwipeOptOut} from '../../ui/swipeOptOut';
import {isSourceMuted, toggleMute} from '../../notifications/notifications';
import {SpaceHeader, SpaceBackButton, StatusPill, ChatBubble, ChannelComposer, QuotedReply, SwipeToReply, npubFor, shortNpub} from './primitives';
import {shortenNpub} from '../../util/npub';
import {relTimeShort} from '../../ui/relTime';
import type {Contact} from './NewMessageScreen';
import {BroadcastCard} from './BroadcastCard';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {EditChannelModal} from './EditChannelModal';
import {ensureSavedEmbedsLoaded, listSavedEmbeds, saveMessageEmbed, removeEmbed, nostrLinkForEvent, savedEmbedUri, savedEmbedIsPrivate, toSavedEmbedRow, type SavedEmbed, type SavedEmbedRow} from '../savedEmbeds';
import {encodeMsgEmbed} from '../msgEmbed';

/** Stable empty tally array (mirrors ChannelView) so a message with no reactions doesn't hand
 * MessageItem a fresh `[]` every render — that would defeat its React.memo below. */
const EMPTY_TALLIES: EmojiTally[] = [];
/** Stable no-op — swapped in for the composer's `onSend` while the space key hasn't hydrated yet,
 * so the send button visibly does nothing rather than round-tripping through a doomed throw. */
const NOOP = (): void => {};
import {promotedFeedId} from '../promote';
import {groupReplyParentId} from '../groups';
import {tallyEmojiReactions, tallyAllReactions, type EmojiTally} from '../reactions';
import {ReactionBar} from './ReactionPicker';
import {resolveReactionPalette} from '../spaceRules';
import {decodeNameHeader} from '../../profile/displayName';
import type {CommentNode} from '../../feed/thread';
import {type NostrEventSummary} from '../../ui/NostrLinkPreview';
import {VoiceComposer} from '../../feed/components/VoiceComposer';
import {encodeInlineVoice} from '../../feed/voice';
import {inlineMediaSummary} from '../../feed/inlineMedia';
import {PictureComposer} from '../../feed/components/PictureComposer';
import {extractInlinePictures} from '../../feed/picture';
import {DEFAULT_PICTURE_RULES, type PictureRules} from '../../feed/pictureRules';
import type {PostRules} from '../../feed/postRules';
import type {DraftStoreApi, DraftLocation} from '../../feed/drafts';
import {useInProgressDraft} from '../../feed/useInProgressDraft';

export interface GroupViewProps {
  groupId: string;
  name: string;
  about?: string;
  closed?: boolean;
  isPrivate?: boolean;
  /** Identity gradient for this group (from its relay metadata); falls back to a seeded one. */
  gradient?: GradientSpec;
  /** Whether this group is a broadcast channel (only admins post top-level; others are audience). */
  broadcast?: boolean;
  /** Admin-configured reaction emojis for this group's posts (from its parsed GroupMeta). When
   * omitted/empty the view falls back to {@link GROUP_REACTION_EMOJIS}. */
  reactions?: string[];
  members: string[];
  admins: string[];
  pending?: string[];
  /** Phase 5 stale-first: the group's scoped history fetch hasn't settled yet (no EOSE/CLOSED),
   * so an empty `messages` means "still loading over Tor" — the "No messages yet." empty state is
   * suppressed rather than flashing a false claim. Omitted → empty state shows as before.
   * (Distinct from `pending`, which is the pending JOIN REQUEST pubkeys.) */
  historyPending?: boolean;
  messages: Event[]; // kind-9 group chat, oldest first
  repliesByParent?: Map<string, Event[]>; // kind-12 replies keyed by parent message id
  currentUserPubkey?: string;
  isMember: boolean;
  isAdmin: boolean;
  isOwner?: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onKick: (pubkey: string) => void;
  /**
   * ROLE CHANGES on existing members only (promote asAdmin=true / demote asAdmin=false). There is
   * deliberately NO direct-add UI any more (membership handoff): new people are only ever INVITED
   * (accept-first, via onInvitePeople) or approved off the request queue.
   */
  onAddMember?: (pubkey: string, asAdmin: boolean) => void;
  onEditGroup?: (meta: GroupMeta) => void;
  // ── Membership handoff (Manage page: review queue + invited strip + add people) ──
  /** Review queue: relay pending pubkeys joined with their unsealed intro notes. */
  joinQueue?: {pubkey: string; at?: number; name?: string; note?: string; invited: boolean}[];
  /** Outstanding accept-first invites (the Invited strip). */
  invited?: {p: string; by: string; at: number}[];
  /** Send accept-first invites to the selected people (DM frame + shared invited-set doc). */
  onInvitePeople?: (pubkeys: string[]) => void;
  /** Revoke an outstanding invite (any admin may revoke any inviter's). */
  onRevokeInvite?: (pubkey: string) => void;
  /** Precomputed `stiq:space:` share token for this space (quick sheet's Share row copies it). */
  shareToken?: string;
  /** Admin-pinned message id for this space (from the shared space-settings doc). */
  pinnedMessageId?: string;
  /** Admin action: pin/unpin a broadcast post (null = unpin). Parity with channels. */
  onSetPinned?: (messageId: string | null) => void;
  /** Admin: persist the reaction set to the space-settings doc (PRIVATE CHANNEL only — the relay
   * drops reactions from NIP-29 metadata, so channels ride the client doc; groups use ⋯ any-emoji). */
  onSaveReactions?: (reactions: string[]) => void;
  onApprove?: (pubkey: string) => void;
  onDeny?: (pubkey: string) => void;
  /** Outcome of the most recent approve/deny publish for a pending pubkey (AppRuntime.
   *  getRosterActionStatus) — lets a resolved request card notice its own publish bounced instead of
   *  freezing on a false "✓ Approved"/"Declined" forever. Undefined = nothing bounced (or unknown). */
  onGetRosterActionStatus?: (pubkey: string) => {status?: SendStatus; reason?: string} | undefined;
  onDelete?: () => void;
  onTransfer?: (pubkey: string) => void;
  /** Owner-only: this group's current log offer (the community log picker's consent gate), or null/
   *  undefined when none is live. Drives the Manage page's "Offer to community log" Switch. */
  logOffer?: LogOffer | null;
  /** Owner action: publish a live log offer built from this group's current name/gradient/flags. */
  onSetLogOffer?: () => void;
  /** Owner action: revoke this group's log offer (delists it from the community log picker). */
  onRevokeLogOffer?: () => void;
  /**
   * Send a group chat message; `replyTo` quotes a parent message (swipe-to-reply). May return a
   * promise so the composer can await the outcome — a rejection restores the draft + reply target
   * (see `sendText`) instead of silently discarding a message the relay never took.
   */
  onPostChat: (text: string, replyTo?: string) => Promise<void> | void;
  onReply?: (parentId: string, text: string) => void;
  /** Optimistic send status for broadcast/private-channel posts (parity with ChannelView). */
  sendStatus?: ReadonlyMap<string, SendStatus>;
  /** Relay's rejection reason per message id (shown as muted subtext under "failed"). */
  sendReasons?: ReadonlyMap<string, string>;
  onRetry?: (eventId: string) => void;
  onCancel?: (eventId: string) => void;
  /** Open a member's profile (tapping a member in the info sheet). */
  onOpenMember?: (pubkey: string) => void;
  /** Resolve a member's display name (else a shortened npub is shown). */
  onGetDisplayName?: (pubkey: string) => string | undefined;
  /** Per-post interaction state for a broadcast-channel admin post (comments/reactions open?). */
  getMessageInteractions?: (messageId: string) => PostInteractions;
  /** Admin-only: open/close comments+reactions on a broadcast-channel post. */
  onSetMessageInteractions?: (messageId: string, perm: PostInteractions) => void;
  /** React to a broadcast-channel post (allowed when reactions are open, or for admins). */
  onReactToMessage?: (messageId: string, messagePubkey: string) => void;
  // ── private/broadcast channel parity (cards identical to public channels) ──
  /** Comment thread (kind-1111) under a channel post, keyed by message id. */
  onGetChannelThread?: (messageId: string) => CommentNode[];
  /** Post a comment (kind-1111) on a channel post. */
  onPostChannelComment?: (messageId: string, messagePubkey: string, messageKind: number, content: string) => void;
  /** All kind-7 reactions bucketed by target id (for emoji-chip tallies). */
  onGetReactionsByTarget?: () => ReadonlyMap<string, import('nostr-tools/pure').Event[]>;
  /** Reaction emoji set for channel posts (defaults to a standard set when omitted). */
  reactionEmojis?: string[];
  /** React to a channel post with a specific emoji. */
  onReactWithEmoji?: (messageId: string, messagePubkey: string, emoji: string) => void;
  /** Resolve an author's identity gradient (card + comment authors). */
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  /** Author edit of one of your channel posts (position-preserving). May return a promise; a
   *  rejection restores the edit-in-progress draft (see `sendText`). */
  onEditGroupMessage?: (messageId: string, content: string) => Promise<void> | void;
  /** Whether this space's outgoing sends are blocked for lack of a space key — drives the
   *  composer's "Unlocking this space…" banner and disables the send button while true. */
  onIsSpaceKeyMissing?: (groupId: string) => boolean;
  /** Author (No.5): promote a private/broadcast post into a feed thread ("enable replies"). */
  onEnableReplies?: (message: Event) => void;
  /** Open the feed thread a promoted post points to. */
  onOpenPromoted?: (feedId: string) => void;
  /** No.3: reply count of a promoted post's feed thread (mirrored on the promoted card). */
  getFeedReplyCount?: (feedId: string) => number;
  /** Organizer allows voice — shows the 🎙️ in the composer to embed a clip inline (No.9). */
  allowVoice?: boolean;
  /** Organizer picture limits — gates the "Add picture" option + enforces size/allowance in the UI. */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has already spent this period (for the allowance gate). */
  picturesSpentBytes?: number;
  /** Organizer post rules — supplies the expanded editor's universal long-body caps (words + media).
   *  Absent ⇒ unbounded, which is also the relay's default. */
  postRules?: PostRules;
  /** Resolve a referenced nostr: event for inline REFERENCED cards. */
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  /** Tap a REFERENCED card → open that event. */
  onOpenRef?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card in a message body → run the in-app accept-invite flow. */
  onOpenInviteLink?: (url: string) => void;
  /** Resolve the phone book (contacts) for the "add member" ✏️ picker; omit to hide the picker. */
  onGetPhonebook?: () => Contact[];
  /** Persists the in-progress message so an unsent draft is restored on reopen (No.7). */
  draftStore?: DraftStoreApi;
  /** Open the unified Drafts list from the expanded editor's byline. */
  onOpenDrafts?: () => void;
  /** Scroll-back pagination: fetch older messages (fires near the top/oldest end of the list). */
  onLoadOlder?: () => void;
  /** Which internal screen to open on mount (seeds the chat/manage/addpeople state). Only read at
   *  mount — MainScreen renders `<GroupView key={openGroupId}>` so a fresh open remounts and re-seeds.
   *  A join-request notification tap passes 'manage' to land straight on the review queue. */
  initialScreen?: 'chat' | 'manage';
  onBack: () => void;
  /** Swipe-back (PLAN_SWIPE_BACK_GESTURE_2026-07-27.md, task 3): MainScreen wraps this component in a
   *  <SubScreen> whose swipe-to-dismiss must stay inert while `screen` is 'manage' or 'addpeople' —
   *  those hold forms, and the swipe must always be the thing that unmounts (never fire past an inner
   *  page the way a bare BACK press could). MainScreen can't see `screen` directly, so this lifts a
   *  single "am I at the swipeable root" boolean; called from an effect on every `screen` change. */
  onAtRootChange?: (atRoot: boolean) => void;
  /**
   * Stable React list key for an event id (AppRuntime.stableListKey). Our own optimistic
   * post/reply's `local-…` placeholder id is swapped for the real event id when it signs — keying
   * rows through this keeps ONE key across that swap so the just-sent message never
   * unmounts/remounts (FeedList.feedItemKey's cure, applied here). Omitted → raw id.
   */
  listKeyFor?: (id: string) => string;
}

function short(pubkey: string): string {
  return shortenNpub(pubkey, {lead: 8, tail: 4});
}

// ── Add people (membership handoff) — full-page phonebook MULTI-SELECT, invite-to-accept ──────
// Replaces the old direct "Add member by npub" modal + single-pick contact sheet: there is no
// direct add any more. Each selected person gets an accept-first DM invite; already-invited
// contacts render dimmed with the INVITED tag and are not selectable.
function AddPeopleScreen({
  spaceName,
  onGetPhonebook,
  existingMembers,
  invitedPubkeys,
  onSend,
  onBack,
}: {
  spaceName: string;
  onGetPhonebook?: () => Contact[];
  /** Pubkeys already in the space — excluded from the list entirely. */
  existingMembers: string[];
  /** Pubkeys with an outstanding invite — rendered dimmed + INVITED, unselectable. */
  invitedPubkeys: string[];
  onSend: (pubkeys: string[]) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // AddPeopleScreen only renders while GroupView's own swipe-back is already disabled (see
  // `onAtRootChange` elsewhere in this file) — opted out anyway for the search field below so the
  // same protection holds even if that gating ever changes.
  const optOut = useSwipeOptOut();
  // Snapshot the phone book once per mount (the screen is short-lived).
  const [contacts] = useState<Contact[]>(() => {
    const exclude = new Set(existingMembers);
    return (onGetPhonebook?.() ?? []).filter(c => !exclude.has(c.pubkey));
  });
  const invitedSet = useMemo(() => new Set(invitedPubkeys), [invitedPubkeys]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      c => (c.name?.toLowerCase().includes(q) ?? false) || c.npub.toLowerCase().includes(q),
    );
  }, [contacts, query]);
  const picked = Object.keys(selected).filter(pk => selected[pk]);
  return (
    <View style={s.root}>
      <View style={s.apHeaderRow}>
        <Press onPress={onBack} accessibilityLabel="addpeople-back">
          <Text style={s.apBack}>‹ Manage</Text>
        </Press>
      </View>
      <View style={s.apIntro}>
        <Text style={s.apTitle}>Add people</Text>
        <Text style={s.apSub}>
          {`Each person gets an invite to ${spaceName} — nobody joins until they accept.`}
        </Text>
        <View style={s.apSearch}>
          <Text style={s.apSearchIcon}>🔍</Text>
          {/* A TextInput's own selection-handle drag doesn't join JS PanResponder negotiation, so
              without this opt-out a live page-level swipe-back would win a rightward drag started
              inside the field instead of moving the cursor (see `optOut`'s own comment above). */}
          <TextInput
            style={s.apSearchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search names or npubs…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="add-people-search"
            {...optOut}
          />
        </View>
      </View>
      <Text style={s.apListLabel}>PHONE BOOK</Text>
      <FlatList
        style={s.apList}
        data={filtered}
        keyExtractor={c => c.pubkey}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={s.pickEmpty}>No contacts match your search.</Text>}
        renderItem={({item}) => {
          const isInvited = invitedSet.has(item.pubkey);
          if (isInvited) {
            return (
              <View style={[s.apRow, s.apRowInvited]}>
                <View style={s.apCheckSpacer} />
                <GradientAvatar gradient={item.gradient} seed={item.npub} size={36} shape="circle" />
                <View style={s.pickRowBody}>
                  <Text style={s.pickName} numberOfLines={1}>{item.name?.trim() || shortNpub(item.npub)}</Text>
                </View>
                <Text style={s.invitedTag}>INVITED</Text>
              </View>
            );
          }
          const isSel = !!selected[item.pubkey];
          return (
            <Press
              variant="row"
              style={s.apRow}
              onPress={() => setSelected(sel => ({...sel, [item.pubkey]: !sel[item.pubkey]}))}
              accessibilityLabel={`invite-pick-${item.pubkey}`}>
              {isSel ? (
                <View style={s.apCheckOn}><Text style={s.apCheckOnText}>✓</Text></View>
              ) : (
                <View style={s.apCheckOff} />
              )}
              <GradientAvatar gradient={item.gradient} seed={item.npub} size={36} shape="circle" />
              <View style={s.pickRowBody}>
                <Text style={s.pickName} numberOfLines={1}>{item.name?.trim() || shortNpub(item.npub)}</Text>
                <Text style={s.pickNpub} numberOfLines={1}>{shortNpub(item.npub)}</Text>
              </View>
            </Press>
          );
        }}
      />
      <View style={s.apFooter}>
        {picked.length > 0 ? (
          <Press
            style={s.apSendBtn}
            onPress={() => { onSend(picked); onBack(); }}
            accessibilityLabel="send-invites">
            <Text style={s.apSendBtnText}>
              {`Send ${picked.length} ${picked.length === 1 ? 'invite' : 'invites'}`}
            </Text>
          </Press>
        ) : (
          <View style={s.apSendDisabled}>
            <Text style={s.apSendDisabledText}>Select people to invite</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// Edit-group sheet is now the SHARED EditChannelModal (variant="group") — see the render below.
// This removes the near-duplicate group editor so channels and groups edit through one component.

// ── A single chat message + its threaded replies ──────────────────────────────────────────────
// React.memo'd (parity with BroadcastCard/ChannelView) with a custom comparator: several props here
// (reactions/bubbleReactions arrays, the `interactions` object) are rebuilt fresh by the parent on
// every render even when their CONTENT is unchanged, and a default shallow-compare memo would be
// defeated by that alone. Compare the underlying values instead — see the comparator below.
const MessageItem = React.memo(function MessageItem({
  item,
  currentUserPubkey,
  authored = false,
  isAdmin = false,
  interactions,
  reactionEmojis,
  reactions,
  onReactEmoji,
  commentCount,
  onGetThread,
  onPostComment,
  getAuthorName,
  getAuthorGradient,
  onOpenMember,
  onLookupEvent,
  onOpenRef,
  onOpenInviteLink,
  onStartEdit,
  canEdit,
  quote,
  firstInRun = true,
  onReply,
  onEnableReplies,
  onOpenPromoted,
  promotedReplyCount,
  onSaveToEmbed,
  bubbleReactions,
  onShowReactors,
  isPinned,
  onTogglePin,
  pinnedExpanded,
  onTogglePinExpand,
  status,
  reason,
  onRetry,
  onCancel,
}: {
  item: Event;
  currentUserPubkey?: string;
  /** Authored-card layout (broadcast / private channels) vs chat bubbles (group chats). */
  authored?: boolean;
  /** Quoted-reply card rendered inside the bubble when this message replies to another. */
  quote?: React.ReactNode;
  /** Group chat: whether this is the FIRST message of a consecutive same-sender run — gates the
   *  sender avatar + name label so a run shows them once (normal-chat grouping). Default true. */
  firstInRun?: boolean;
  /** Swipe-to-reply trigger (group chat bubbles only). */
  onReply?: () => void;
  isAdmin?: boolean;
  /** Current open/closed state of this post's comments. */
  interactions?: PostInteractions;
  /** Admin-only toggle of this post's replies. */
  onSetInteractions?: (perm: PostInteractions) => void;
  reactionEmojis: string[];
  reactions: EmojiTally[];
  onReactEmoji?: (messageId: string, messagePubkey: string, emoji: string) => void;
  commentCount: number;
  onGetThread?: (messageId: string) => CommentNode[];
  onPostComment?: (messageId: string, messagePubkey: string, messageKind: number, content: string) => void;
  getAuthorName?: (pubkey: string) => string | undefined;
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  /** Open a member's profile — reused for the broadcast card footer's author-avatar tap target. */
  onOpenMember?: (pubkey: string) => void;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenRef?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card in a message body → run the in-app accept-invite flow. */
  onOpenInviteLink?: (url: string) => void;
  onStartEdit?: (id: string, content: string) => void;
  canEdit?: boolean;
  /** Author (No.5): promote this post into a feed thread ("enable replies"). */
  onEnableReplies?: (message: Event) => void;
  /** Open the feed thread a promoted post points to. */
  onOpenPromoted?: (feedId: string) => void;
  /** No.3: reply count of this post's feed thread when promoted. */
  promotedReplyCount?: number;
  /** ⋯ → Save to embed later — bookmark this post to reference in a future post. */
  onSaveToEmbed?: () => void;
  /** Any-emoji reaction tallies for a group-chat bubble (non-broadcast). */
  bubbleReactions?: EmojiTally[];
  /** Long-press a reaction chip → open the "who reacted" list. */
  onShowReactors?: () => void;
  /** Whether this post is the space's pinned message. */
  isPinned?: boolean;
  /** Admin action: pin/unpin this post (shown on broadcast/private cards). */
  onTogglePin?: () => void;
  /** Whether the pinned bar is expanded. */
  pinnedExpanded?: boolean;
  /** Toggle the pinned-bar expand/collapse. */
  onTogglePinExpand?: () => void;
  /** Optimistic send status — broadcast/private-channel posts (BroadcastCard's SendProgress) AND
   *  plain group-chat bubbles (T0.4: the ✕/reason/Retry/Cancel block below). */
  status?: SendStatus;
  /** Relay rejection reason, or (T0.3) the calm exhaustion reason from a sign-time compose placeholder
   *  — shown as muted subtext under "failed" on both surfaces above. */
  reason?: string;
  onRetry?: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const author = (pk: string): string =>
    pk === currentUserPubkey ? 'You' : (getAuthorName?.(pk)?.trim() || short(pk));
  const npub = npubFor(item.pubkey);
  const name = author(item.pubkey);
  const isMine = item.pubkey === currentUserPubkey;
  const it = interactions ?? {comments: false, reactions: false};

  // Private/broadcast channel posts render the shared BroadcastCard — pixel-identical to a public
  // channel post (no author header; same reaction chips / comment counter / tap-to-comment / edit),
  // with ONE addition: a clickable author gradient circle in the footer (private spaces only), since
  // there's no header here to carry identity and members still need to tell posts apart / open a
  // profile.
  if (authored) {
    return (
      <View style={s.msg}>
        <BroadcastCard
          event={item}
          showAuthor={false}
          author={{
            seed: npub,
            gradient: getAuthorGradient?.(item.pubkey),
            onPress: onOpenMember ? () => onOpenMember(item.pubkey) : undefined,
          }}
          status={status}
          reason={reason}
          onRetry={onRetry}
          onCancel={onCancel}
          reactionEmojis={reactionEmojis}
          reactions={reactions}
          onReact={onReactEmoji ? emoji => onReactEmoji(item.id, item.pubkey, emoji) : undefined}
          commentsEnabled={it.comments || isAdmin}
          commentCount={commentCount}
          onGetThread={onGetThread}
          onPostComment={onPostComment ? c => onPostComment(item.id, item.pubkey, item.kind, c) : undefined}
          getCommentAuthorName={getAuthorName}
          getCommentAuthorGradient={getAuthorGradient}
          onLookupEvent={onLookupEvent}
          onOpenRef={onOpenRef}
          onOpenInviteLink={onOpenInviteLink}
          isMine={isMine}
          edited={item.tags.some(t => t[0] === 'edited')}
          onEdit={canEdit && onStartEdit ? () => onStartEdit(item.id, decodeNameHeader(item.content).text) : undefined}
          onEnableReplies={onEnableReplies && isMine ? () => onEnableReplies(item) : undefined}
          onOpenPromoted={onOpenPromoted}
          promotedReplyCount={promotedReplyCount}
          onSaveToEmbed={onSaveToEmbed}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          pinnedExpanded={pinnedExpanded}
          onTogglePinExpand={onTogglePinExpand}
        />
      </View>
    );
  }

  // Group chat: a left/right bubble with a minimal ⋯ — historically copy-link only, no replies.
  // Surface audit (T4.4): promoteChannelPost accepts ANY GroupKind.Chat message, broadcast or not, so
  // a plain multi-author chat message is just as promotable as a private-channel broadcast card — the
  // affordance was simply missing here. Author-only (isMine), hidden once already promoted.
  const promoted = promotedFeedId(item);
  const copyLink = (): void => {
    Clipboard.setString(nostrLinkForEvent({id: item.id, author: item.pubkey}));
    Alert.alert('Link copied');
    setMenuOpen(false);
  };
  // A continuation bubble (same sender as the message above) drops the avatar + name label and
  // tucks up under the run's first bubble — the standard chat grouping.
  const continuation = !firstInRun;
  // Minimal delivery glyph on the user's OWN messages, mirroring the DM bubble (·/✓/✕) so a group
  // send has the same at-a-glance confirmation and a failed one isn't silent. Only present while the
  // outbox is tracking this message (the sender's fresh optimistic write); relay history has none.
  const statusIcon =
    status === 'sending' || status === 'accepted' ? '·' :
    status === 'confirmed' ? '✓' : '';
  // T0.4: a failed/rejected group send now shows WHY + Retry/Cancel (copies DmBubble's pattern) —
  // previously this bubble rendered only a bare, unexplained "✕" with no tap target at all, so a
  // relay-rejected or token-exhausted message was stuck forever with a fully-capable backend retry
  // (AppRuntime.retry) sitting unreachable. The raw reason is mapped to calm copy at render time
  // (calmRejection), matching how SendProgress/DmBubble surface Outbox.reasons()/the awaitingSign
  // reason (T0.3). Retry is offered only for 'failed' (a permanent 'rejected' re-earns the same "no" —
  // see SendProgress's doc); Cancel is offered for either, mirroring BroadcastCard's authored-card path.
  const failed = status === 'failed' || status === 'rejected';
  const failReason = (() => {
    if (!failed || !reason) return '';
    const calm = calmRejection(reason);
    return [calm.text, calm.nextStep].filter(Boolean).join(' ');
  })();
  return (
    <SwipeToReply onReply={onReply ?? (() => {})} enabled={!!onReply}>
    <View style={s.msgBubble}>
      <ChatBubble
        mine={isMine}
        content={decodeNameHeader(item.content).text}
        senderName={isMine || continuation ? undefined : name}
        senderSeed={npub}
        continuation={continuation}
        quote={quote}
        onMenu={() => setMenuOpen(true)}
        reactions={bubbleReactions}
        onReactEmoji={onReactEmoji ? emoji => onReactEmoji(item.id, item.pubkey, emoji) : undefined}
        onShowReactors={onShowReactors}
        onLookupEvent={onLookupEvent}
        onOpenNostrPost={onOpenRef}
        onOpenInviteLink={onOpenInviteLink}
      />
      {isMine && failed ? (
        <View style={s.failedBlock}>
          <View style={s.failedRow}>
            <Text style={s.msgStatusFailed} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕ failed</Text>
            {status === 'failed' && onRetry ? (
              <Press onPress={onRetry} accessibilityLabel="retry-message">
                <Text style={s.retryLink} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Retry</Text>
              </Press>
            ) : null}
            {onCancel ? (
              <Press onPress={onCancel} accessibilityLabel="cancel-message">
                <Text style={s.cancelLink} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
              </Press>
            ) : null}
          </View>
          {failReason ? (
            <Text style={s.failReason} numberOfLines={2} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{failReason}</Text>
          ) : null}
        </View>
      ) : isMine && statusIcon ? (
        <Text style={s.msgStatus}>{statusIcon}</Text>
      ) : null}
      {promoted && onOpenPromoted && (
        // Mirrors BroadcastCard's "✦ On the feed" footer for a promoted PLAIN chat message — this
        // surface has no card frame to accent, so a small tappable row under the bubble carries the
        // same signal + tap-through to the feed thread (clickability, T4.4).
        <Press
          variant="row"
          style={[s.promotedRow, isMine && s.promotedRowMine]}
          onPress={() => onOpenPromoted(promoted)}
          accessibilityLabel={`open-promoted-${item.id}`}>
          <Text style={s.promotedRowText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ✦ On the feed · 💬 {promotedReplyCount ?? 0} · view discussion ›
          </Text>
        </Press>
      )}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.actionBackdrop} onPress={() => setMenuOpen(false)} accessibilityRole="none" />
        <View style={s.actionWrap}>
          {onReactEmoji && (
            <View style={s.reactBarCard}>
              <ReactionBar onPick={emoji => { onReactEmoji(item.id, item.pubkey, emoji); setMenuOpen(false); }} />
            </View>
          )}
          <View style={s.actionCard}>
            <Press
              variant="row"
              style={[s.actionRow, !(isMine && onEnableReplies && !promoted) && s.actionRowLast]}
              onPress={copyLink}
              accessibilityLabel={`copy-link-${item.id}`}>
              <Text style={s.actionIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔗</Text>
              <Text style={s.actionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Copy link</Text>
            </Press>
            {isMine && onEnableReplies && !promoted && (
              <Press
                variant="row"
                style={[s.actionRow, s.actionRowLast]}
                onPress={() => { setMenuOpen(false); onEnableReplies(item); }}
                accessibilityLabel={`enable-replies-${item.id}`}>
                <Text style={s.actionIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>💬</Text>
                <Text style={s.actionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Turn on replies</Text>
              </Press>
            )}
          </View>
          <Press style={s.actionCancel} onPress={() => setMenuOpen(false)}>
            <Text style={s.actionCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
          </Press>
        </View>
      </Modal>
    </View>
    </SwipeToReply>
  );
}, (prev, next) => {
  const sameTallies = (a: EmojiTally[], b: EmojiTally[]): boolean =>
    a.length === b.length && a.every((r, i) => {
      const n = b[i];
      return !!n && r.emoji === n.emoji && r.count === n.count && r.mine === n.mine;
    });
  return (
    prev.item.id === next.item.id &&
    prev.item.content === next.item.content &&
    prev.item.pubkey === next.item.pubkey &&
    prev.item.tags.some(t => t[0] === 'edited') === next.item.tags.some(t => t[0] === 'edited') &&
    promotedFeedId(prev.item) === promotedFeedId(next.item) &&
    prev.authored === next.authored &&
    prev.isAdmin === next.isAdmin &&
    prev.currentUserPubkey === next.currentUserPubkey &&
    prev.canEdit === next.canEdit &&
    prev.commentCount === next.commentCount &&
    prev.promotedReplyCount === next.promotedReplyCount &&
    prev.isPinned === next.isPinned &&
    prev.pinnedExpanded === next.pinnedExpanded &&
    prev.status === next.status &&
    prev.reason === next.reason &&
    prev.onRetry === next.onRetry &&
    prev.onCancel === next.onCancel &&
    (prev.interactions?.comments ?? false) === (next.interactions?.comments ?? false) &&
    (prev.interactions?.reactions ?? false) === (next.interactions?.reactions ?? false) &&
    prev.quote === next.quote &&
    prev.firstInRun === next.firstInRun &&
    prev.onReply === next.onReply &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onEnableReplies === next.onEnableReplies &&
    prev.onStartEdit === next.onStartEdit &&
    prev.onSaveToEmbed === next.onSaveToEmbed &&
    prev.onShowReactors === next.onShowReactors &&
    prev.onReactEmoji === next.onReactEmoji &&
    prev.getAuthorName === next.getAuthorName &&
    prev.getAuthorGradient === next.getAuthorGradient &&
    prev.onOpenMember === next.onOpenMember &&
    prev.onGetThread === next.onGetThread &&
    prev.onPostComment === next.onPostComment &&
    prev.onLookupEvent === next.onLookupEvent &&
    prev.onOpenRef === next.onOpenRef &&
    prev.onOpenInviteLink === next.onOpenInviteLink &&
    prev.onOpenPromoted === next.onOpenPromoted &&
    sameTallies(prev.reactions, next.reactions) &&
    sameTallies(prev.bubbleReactions ?? EMPTY_TALLIES, next.bubbleReactions ?? EMPTY_TALLIES)
  );
});

// ── main component ────────────────────────────────────────────────────────────────────────────
export function GroupView(props: GroupViewProps): React.JSX.Element {
  const {
    groupId, name, about, closed, isPrivate, gradient, broadcast = false, members, admins,
    pending = [], messages, historyPending, currentUserPubkey, isMember, isAdmin, isOwner,
    onJoin, onLeave, onKick, onAddMember, onEditGroup, onApprove, onDeny, onGetRosterActionStatus,
    onDelete, onTransfer,
    logOffer, onSetLogOffer, onRevokeLogOffer,
    joinQueue, invited = [], onInvitePeople, onRevokeInvite, shareToken,
    onPostChat, getMessageInteractions, onSetMessageInteractions, onBack,
    onOpenMember, onGetDisplayName,
    onGetChannelThread, onPostChannelComment, onGetReactionsByTarget, onReactWithEmoji,
    getAuthorGradient, onEditGroupMessage, onIsSpaceKeyMissing, onLookupEvent, onOpenRef, onOpenInviteLink, onEnableReplies, onOpenPromoted,
    getFeedReplyCount, allowVoice, pictureRules, picturesSpentBytes, postRules, pinnedMessageId, onSetPinned, onSaveReactions,
    sendStatus, sendReasons, onRetry, onCancel, draftStore, onOpenDrafts, onLoadOlder, onGetPhonebook,
    initialScreen, listKeyFor, onAtRootChange,
  } = props;
  // Stands this page's own swipe-back down for touches beginning on the chat composer below —
  // spread onto its wrapper View; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();
  // Type is fixed at creation. Derive the human label, avatar shape, and join model from the flags:
  //   private + broadcast  = Private channel (members read, admins post; join by invite OR request)
  //   private + !broadcast = Private group   (members read+write; INVITE-ONLY, no request)
  //   !private (+/- bcast) = Group chat / Broadcast (open join)
  const spaceLabel = broadcast && isPrivate ? 'Private channel' : isPrivate ? 'Private group' : broadcast ? 'Broadcast' : 'Group chat';
  const inviteOnly = !!isPrivate && !broadcast; // private group: an admin must add each member
  // A BROADCAST space (private channel / public broadcast) reads like a feed of authored cards
  // (NEWEST FIRST, top-anchored); everything else — a group chat OR a private GROUP (members
  // read+write) — is a bottom-anchored conversation of bubbles. `messages` arrives oldest-first.
  const channelFeed = broadcast;
  const orderedMessages = useMemo(
    () => (channelFeed ? messages.slice().reverse() : messages),
    [messages, channelFeed],
  );
  // Prefer the group's admin-configured reaction set (parsed GroupMeta.reactions), else an explicit
  // reactionEmojis prop — and for a space that configured NEITHER, an EMPTY palette: no chips at all
  // (resolveReactionPalette, spaceRules.ts). Reaction emojis are an owner's choice; a space that never
  // made one doesn't get a set invented for it. Only matters for a BROADCAST-type space (channelFeed
  // below): a plain group chat's bubbles react with any emoji via bubbleTallies instead and never read
  // this. Real reactions people actually sent still render via tallyEmojiReactions' off-palette union
  // regardless of what the configured set is.
  const configuredReactions = props.reactions && props.reactions.length > 0 ? props.reactions : undefined;
  const reactionEmojis = resolveReactionPalette(configuredReactions ?? props.reactionEmojis);
  // Comment counts + reaction tallies for the channel-card path, computed once per snapshot (mirrors
  // ChannelView). Cheap no-ops for plain group chats (channelFeed false → BroadcastCard not used).
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (channelFeed && onGetChannelThread) {
      for (const m of messages) counts.set(m.id, onGetChannelThread(m.id)?.length ?? 0);
    }
    return counts;
  }, [channelFeed, messages, onGetChannelThread]);
  const reactionTallies = useMemo(() => {
    const map = new Map<string, EmojiTally[]>();
    if (!channelFeed) return map;
    const byTarget = onGetReactionsByTarget?.() ?? new Map<string, import('nostr-tools/pure').Event[]>();
    for (const m of messages) {
      map.set(m.id, tallyEmojiReactions(byTarget.get(m.id) ?? [], reactionEmojis, currentUserPubkey));
    }
    return map;
  }, [channelFeed, messages, onGetReactionsByTarget, reactionEmojis, currentUserPubkey]);
  // Group-chat bubbles react with ANY emoji (no configured set) — tally every emoji present.
  const bubbleTallies = useMemo(() => {
    const map = new Map<string, EmojiTally[]>();
    if (channelFeed) return map; // authored cards use the configured-set tallies instead
    const byTarget = onGetReactionsByTarget?.() ?? new Map<string, import('nostr-tools/pure').Event[]>();
    for (const m of messages) {
      const t = tallyAllReactions(byTarget.get(m.id) ?? [], currentUserPubkey);
      if (t.length) map.set(m.id, t);
    }
    return map;
  }, [channelFeed, messages, onGetReactionsByTarget, currentUserPubkey]);
  // Group-chat sender grouping: an incoming bubble shows the sender's avatar + name only on the
  // FIRST message of a consecutive run by the same author (normal-chat convention); continuation
  // bubbles omit both and align underneath. `messages` is oldest-first and the chat FlatList is NOT
  // inverted, so array order === visual top-to-bottom order. Empty (every row defaults to first) for
  // broadcast/authored cards — those always render their own author header.
  const firstInRun = useMemo(() => {
    const map = new Map<string, boolean>();
    if (channelFeed) return map;
    let prevPubkey: string | undefined;
    for (const m of messages) {
      map.set(m.id, m.pubkey !== prevPubkey);
      prevPubkey = m.pubkey;
    }
    return map;
  }, [channelFeed, messages]);
  // No.3: reply count of each promoted post's feed thread (mirrors the feed post's own count).
  // NOT gated on channelFeed — promoteChannelPost accepts a plain (non-broadcast) group chat message
  // just as readily as a broadcast one (surface audit, T4.4), so a promoted PLAIN chat bubble needs
  // its reply count too, not just the BroadcastCard path.
  const promotedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (getFeedReplyCount) {
      for (const m of messages) {
        const fid = promotedFeedId(m);
        if (fid) counts.set(m.id, getFeedReplyCount(fid));
      }
    }
    return counts;
  }, [messages, getFeedReplyCount]);
  const memberName = (pk: string): string =>
    pk === currentUserPubkey ? 'You' : (onGetDisplayName?.(pk)?.trim() || short(pk));
  const npubShort = (pk: string): string => shortenNpub(npubFor(pk), {lead: 11, tail: 3});
  const [draft, setDraft] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  /** No.8: the full-screen WYSIWYG editor (opened by the composer's ⤢ expand button). */
  const [editorOpen, setEditorOpen] = useState(false);
  /** When set, the composer is editing this channel post (its raw text loaded into the draft). */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** When set, the composer is replying to this message (swipe-to-reply, group chats only). */
  const [replyingTo, setReplyingTo] = useState<{id: string; name: string; text: string} | null>(null);
  // Messages by id so a reply can resolve its quoted parent's author + snippet.
  const byId = useMemo(() => {
    const m = new Map<string, Event>();
    for (const ev of messages) m.set(ev.id, ev);
    return m;
  }, [messages]);
  const beginReply = (ev: Event): void => {
    setEditingId(null);
    setReplyingTo({
      id: ev.id,
      name: memberName(ev.pubkey),
      text: inlineMediaSummary(decodeNameHeader(ev.content).text),
    });
  };
  // No.13b (group parity): swipe-to-reply sets `replyingTo` but nothing opened the keyboard —
  // focus the composer's input imperatively whenever a reply target is set, mirroring
  // ConversationView's Composer (MessageComposer is forwardRef precisely for this).
  const composerInputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (replyingTo) composerInputRef.current?.focus();
  }, [replyingTo]);
  const jumpTo = (id: string): void => {
    const idx = orderedMessages.findIndex(m => m.id === id);
    if (idx >= 0) {
      try { listRef.current?.scrollToIndex({index: idx, viewPosition: 0.5, animated: true}); } catch { /* unmeasured */ }
    }
  };
  const [infoOpen, setInfoOpen] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [reactorsSheet, setReactorsSheet] = useState<EmojiTally[] | null>(null);
  // Membership handoff screens: the quick sheet's ⚙️ Manage row opens the full Manage page; its
  // "+ Add people" chip opens the invite multi-select. Plain view state, chat renders underneath.
  // Seeded from initialScreen (a join-request notification opens straight on 'manage'); read once at
  // mount — a fresh group open remounts this component (keyed on openGroupId) and re-seeds.
  const [screen, setScreen] = useState<'chat' | 'manage' | 'addpeople'>(initialScreen ?? 'chat');
  // Hardware BACK peels exactly ONE of those levels, mirroring the ‹ buttons below (the
  // "addpeople-back" press returns to Manage, "manage-back" returns to chat) — contract rule 2 in
  // ui/back.tsx: the key and the button are the same function, so they cannot drift.
  //
  // BACK_PRIORITY.page puts this ahead of MainScreen's root ladder, whose closeOpenGroupView would
  // otherwise close the WHOLE space from two levels deep — the bug this fixes. On 'chat' the action
  // is disabled and that ladder gets the press, which is what closes the space. The sheets layered
  // over these pages (member ⋯, info, reactors, saved embeds, edit) are all native <Modal>s, so each
  // already consumes BACK in its own onRequestClose and none of them needs an entry here.
  useBackAction(
    () => {
      setScreen(screen === 'addpeople' ? 'manage' : 'chat');
      return true;
    },
    {enabled: screen !== 'chat', priority: BACK_PRIORITY.page},
  );
  // Swipe-back (2026-07-27): mirror `screen` out to MainScreen (see onAtRootChange's doc above) so
  // the <SubScreen> wrapping this component can disable its swipe-to-dismiss on manage/add-people —
  // a swipe there must stay inert, same as it is for the BACK_PRIORITY.page peel just above, or it
  // would fire the SubScreen's own onSwipeBack (closeOpenGroupView) and close the WHOLE space from
  // two levels deep.
  useEffect(() => {
    onAtRootChange?.(screen === 'chat');
  }, [screen, onAtRootChange]);
  // Resolved request cards stay visible for the session after the live pending entry vanishes
  // ("✓ Approved — added to members" / "Declined quietly…"), exactly like the prototype. Keyed by
  // pubkey; also drives the members list's NEW tag (approved this session).
  const [resolvedReqs, setResolvedReqs] = useState<
    Record<string, {state: 'approved' | 'declined'; name?: string; note?: string; at?: number}>
  >({});
  /** Which member's row ⋯ menu is open on the Manage page (null = none) — one shared bottom sheet
   *  rather than up to 4 inline per-row buttons. */
  const [memberMenuFor, setMemberMenuFor] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Saved embeds (composer's 🔖 picker) — the same self-contained module ChannelView uses, so
  // groups/broadcasts get the identical "save to embed later" + reference-insert affordance.
  const [savedSheetOpen, setSavedSheetOpen] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  useEffect(() => { void ensureSavedEmbedsLoaded().then(() => setSavedVersion(v => v + 1)); }, []);
  // savedVersion is a deliberate invalidation counter, not a data dependency: the callback reads
  // the module-level saved-embeds cache synchronously, and the bump forces a re-read after load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const savedEmbeds: SavedEmbed[] = useMemo(() => listSavedEmbeds().slice(), [savedVersion]);
  // One shared row builder (toSavedEmbedRow) shapes every saved embed — post, public channel post,
  // space, event, private-space post, and draft — so a new embed kind is handled identically here and
  // in the feed/DM/comment composers. A self-contained embed carries its own token; a plain post
  // resolves its name/snippet via onLookupEvent (which keys on post ids, not coordinates/tokens).
  const editorEmbeds: SavedEmbedRow[] = useMemo(
    () =>
      savedEmbeds.map(it => {
        const selfContained =
          it.kind === 30311 || it.kind === 39000 || it.kind === 31923 || !!it.draftToken || !!it.msgToken;
        return toSavedEmbedRow(it, selfContained ? undefined : onLookupEvent?.(it.id));
      }),
    [savedEmbeds, onLookupEvent],
  );
  const handleSaveEmbed = (id: string, pubkey: string, kind: number, content: string): void => {
    // NIP-29 group content is scope-gated (a non-member can't fetch it by id) and, in a private space,
    // stored encrypted — so a bare `nostr:nevent` embed would render blank for exactly the audience the
    // author wants to show it to. Carry a SELF-CONTAINED `stiq:msg:` token built from the decrypted
    // snapshot instead. `private` flags a private-space source so the composer confirms before inserting.
    const decoded = decodeNameHeader(content);
    const token = encodeMsgEmbed({author: pubkey, name: decoded.name ?? memberName(pubkey), body: decoded.text, kind, spaceName: name});
    void saveMessageEmbed({id, token, author: pubkey, kind, name: decoded.name, private: !!isPrivate}, Math.floor(Date.now() / 1000))
      .then(added => {
        setSavedVersion(v => v + 1);
        Alert.alert(added ? 'Saved to embed later' : 'Already saved');
      })
      .catch(() => {
        // saveMessageEmbed already reverted its in-memory list on a failed write — just surface it.
        Alert.alert('Could not save', 'Please try again.');
      });
  };
  const handleRemoveEmbed = (id: string): void => {
    void removeEmbed(id)
      .then(() => setSavedVersion(v => v + 1))
      .catch(() => {
        Alert.alert('Could not remove', 'Please try again.');
      });
  };
  // Tap a saved item → append its embed token to the draft. savedEmbedUri branches on the item's kind/
  // token so this is correct for a post, space, event, private-space post, or draft. A private-content
  // embed (a post from a private space) confirms first — its content travels wherever it's posted.
  const embedSaved = (it: SavedEmbed): void => {
    const uri = savedEmbedUri(it);
    setSavedSheetOpen(false);
    const append = (): void => setDraft(prev => (prev.trim() ? `${prev.trimEnd()}\n${uri}` : uri));
    if (savedEmbedIsPrivate(it)) {
      Alert.alert(
        'Embed from a private space?',
        'This post is from a private space. Its content travels inside the embed — anyone who can see where you post it will be able to read it.',
        [{text: 'Cancel', style: 'cancel'}, {text: 'Insert anyway', style: 'destructive', onPress: append}],
      );
      return;
    }
    append();
  };
  const listRef = useRef<FlatList<Event>>(null);
  // Return-to-latest: a channelFeed puts newest at the TOP (offset 0); a chat puts it at the
  // BOTTOM (scrollToEnd). The button anchors + points accordingly.
  const jump = useReturnToLatest(channelFeed ? 'top' : 'bottom');
  // "N new" on the FAB while the reader is away in history — the per-space sibling of the feed pill.
  const newWhileAway = useNewWhileAway(messages, m => m.created_at, jump.showJump);
  const scrollToLatest = (): void => {
    if (channelFeed) listRef.current?.scrollToOffset({offset: 0, animated: true});
    else listRef.current?.scrollToEnd({animated: true});
  };
  const startEdit = (id: string, content: string): void => { setEditingId(id); setDraft(decodeNameHeader(content).text); };
  const cancelEdit = (): void => { setEditingId(null); setDraft(''); };

  // Scroll-back pagination (No.3): fire onLoadOlder near the list's older end, with a simple
  // re-entrancy guard — don't refire within 1.5s of the last call UNLESS the message count has
  // since grown (a page actually landed), so a fling doesn't spam repeated fetches for one gesture.
  const loadOlderGuardRef = useRef({lastCalledAt: 0, lastLength: messages.length});
  const handleEndReached = useCallback(() => {
    if (!onLoadOlder) return;
    const guard = loadOlderGuardRef.current;
    const now = Date.now();
    if (now - guard.lastCalledAt < 1500 && messages.length === guard.lastLength) return;
    guard.lastCalledAt = now;
    guard.lastLength = messages.length;
    onLoadOlder();
  }, [onLoadOlder, messages.length]);

  // In-progress message autosave (No.7): an unsent draft persists per group/broadcast and is restored
  // on reopen. The slot holds only the NEW message — never an edit-in-progress (gated on !editingId).
  // Phase 4: the full editor (ComposerScreen, below) now self-persists into this SAME location's
  // slot via its own `draftStore`/`draftLocation` props — `slot` here is only still needed for what
  // ComposerScreen can't reach: the compact `ChannelComposer`'s own keystrokes (typed without ever
  // opening the full editor), the load-on-mount hydration, and the send-time clear.
  const draftLoc = useMemo<DraftLocation>(
    () => ({kind: 'channel', channelId: groupId, channelType: broadcast ? 'broadcast' : 'private', channelName: name}),
    [groupId, broadcast, name],
  );
  const slot = useInProgressDraft(draftStore, draftLoc);
  useEffect(() => {
    void slot.load().then(c => { if (c != null) setDraft(c); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adminSet = useMemo(() => new Set(admins), [admins]);
  // Shape encodes the type (Channels 2.0): private channel = diamond, a public broadcast reads like an
  // open community = octagon, and everything else (group chat / private group) is a hexagon "group".
  const avatarShape: AvatarShape = broadcast && isPrivate ? 'diamond' : broadcast ? 'octagon' : 'hexagon';

  // Group notification mute (info sheet toggle).
  const muteId = `grp:${groupId}`;
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

  // Whether this private space's outgoing sends are currently blocked for lack of the space key
  // (AppRuntime.isSpaceKeyMissing — the same fail-closed condition postToGroup/editGroupMessage
  // throw SPACE_KEY_UNAVAILABLE for). Drives the composer's proactive "Unlocking…" banner so a
  // member sees the reason BEFORE tapping send, not only after the throw.
  const isSpaceKeyMissing = onIsSpaceKeyMissing?.(groupId) ?? false;

  /** True when `v` looks like a promise (duck-typed — avoids importing a Promise type guard). */
  const isThenable = (v: unknown): v is Promise<void> =>
    !!v && typeof (v as {catch?: unknown}).catch === 'function';

  const sendText = (raw: string): void => {
    const text = raw.trim();
    if (!text) return;
    if (editingId) {
      // Capture what's being replaced BEFORE the optimistic clear, so a rejection (e.g. the space's
      // key isn't hydrated yet) can put the in-progress edit back instead of silently losing it.
      const id = editingId;
      const result = onEditGroupMessage?.(id, text);
      setEditingId(null);
      setDraft('');
      setEditorOpen(false);
      if (isThenable(result)) {
        result.catch(() => {
          setEditingId(id);
          setDraft(text);
        });
      }
      return;
    }
    // Capture the draft + reply target BEFORE the optimistic clear (same reasoning as above) so a
    // failed send (SPACE_KEY_UNAVAILABLE, offline, relay rejection) restores both — never a silent
    // "the message just vanished" for the author.
    const replyTarget = replyingTo;
    const result = onPostChat(text, replyTarget?.id);
    setReplyingTo(null);
    slot.clear();
    setDraft('');
    setEditorOpen(false);
    if (isThenable(result)) {
      result.catch(() => {
        setDraft(text);
        setReplyingTo(replyTarget);
        // Re-fill the autosave slot too (mirrors the composer input restore above) — a rejected
        // send must not also lose the unsent-draft safety net a reload would otherwise restore from.
        slot.persist(text);
      });
    }
  };
  const send = (): void => sendText(draft);

  // Chat FlatList windowing + a stable renderItem (parity with ChannelView's renderCard): an inline
  // renderItem re-created every render (e.g. on every composer keystroke, since `draft` lives at
  // this component's root) forces VirtualizedList to rebuild every visible row's props, and MessageItem
  // (React.memo'd above) got fresh per-row closures every time regardless. `msgHandlersRef` carries
  // the volatile pieces (startEdit/beginReply/handleSaveEmbed/bubbleTallies/…) so renderRow's own
  // useCallback identity only changes when something it actually reads changes — NOT on a keystroke —
  // and `rowHandlersRef` caches one closure bundle per message id so a renderRow call only allocates
  // for ids it has never seen. Every cached closure dereferences the ref at CALL time, so nothing here
  // goes stale even though the closures themselves are never recreated for a row's lifetime.
  const msgHandlersRef = useRef({
    byId, beginReply, handleSaveEmbed, bubbleTallies, setReactorsSheet,
    onSetPinned, pinnedMessageId, startEdit, onRetry, onCancel,
  });
  msgHandlersRef.current = {
    byId, beginReply, handleSaveEmbed, bubbleTallies, setReactorsSheet,
    onSetPinned, pinnedMessageId, startEdit, onRetry, onCancel,
  };
  // `onStartEdit` is shared by every row (not per-message), so it gets one permanently-stable
  // wrapper instead of a per-row cache entry — it always calls through to the current `startEdit`.
  const stableStartEdit = useCallback(
    (id: string, content: string) => msgHandlersRef.current.startEdit(id, content),
    [],
  );
  // Likewise `onTogglePinExpand` flips one piece of top-level state shared by every row.
  const togglePinExpand = useCallback(() => setPinnedExpanded(e => !e), []);

  interface RowHandlers {
    onReply: () => void;
    onSaveToEmbed: () => void;
    onShowReactors: () => void;
    onTogglePin: () => void;
    onRetryMessage: () => void;
    onCancelMessage: () => void;
  }
  const rowHandlersRef = useRef(new Map<string, RowHandlers>());
  // useCallback (empty deps) so getRowHandlers itself has a permanently-stable identity — it's a
  // dependency of renderRow below, and everything it touches is reached via refs.
  const getRowHandlers = useCallback((id: string): RowHandlers => {
    const existing = rowHandlersRef.current.get(id);
    if (existing) return existing;
    const row: RowHandlers = {
      onReply: () => {
        const h = msgHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.beginReply(ev);
      },
      onSaveToEmbed: () => {
        const h = msgHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.handleSaveEmbed(ev.id, ev.pubkey, ev.kind, ev.content);
      },
      onShowReactors: () => {
        const h = msgHandlersRef.current;
        const t = h.bubbleTallies.get(id);
        if (t && t.length) h.setReactorsSheet(t);
      },
      onTogglePin: () => {
        const h = msgHandlersRef.current;
        h.onSetPinned?.(id === h.pinnedMessageId ? null : id);
      },
      onRetryMessage: () => msgHandlersRef.current.onRetry?.(id),
      onCancelMessage: () => msgHandlersRef.current.onCancel?.(id),
    };
    rowHandlersRef.current.set(id, row);
    return row;
  }, []);
  // Bounded cache — same pattern as feed's `_itemCache`: once it outgrows the live message set, drop
  // entries for ids no longer present so a long session can't grow it without bound.
  if (rowHandlersRef.current.size > messages.length * 2 + 64) {
    const live = new Set(messages.map(m => m.id));
    for (const id of rowHandlersRef.current.keys()) {
      if (!live.has(id)) rowHandlersRef.current.delete(id);
    }
  }

  const renderRow = useCallback(
    ({item}: {item: Event}) => {
      // Group-chat bubbles support swipe-to-reply with an in-bubble quote; the parent is resolved
      // from the in-memory map (a generic placeholder when it hasn't loaded yet). `memberName` and
      // `jumpTo` are read directly (not as deps below) — both only depend on values already tracked
      // (currentUserPubkey/onGetDisplayName, byId/orderedMessages), so a stale closure reference to
      // either produces identical output as long as those tracked deps haven't changed.
      let quote: React.ReactNode;
      if (!channelFeed) {
        const parentId = groupReplyParentId(item);
        if (parentId) {
          const parent = byId.get(parentId);
          quote = (
            <QuotedReply
              tone={item.pubkey === currentUserPubkey ? 'onAccent' : 'default'}
              name={parent ? memberName(parent.pubkey) : 'Message'}
              text={parent ? inlineMediaSummary(decodeNameHeader(parent.content).text) : ''}
              onPress={() => jumpTo(parentId)}
            />
          );
        }
      }
      const row = getRowHandlers(item.id);
      return (
        <MessageItem
          item={item}
          currentUserPubkey={currentUserPubkey}
          authored={channelFeed}
          isAdmin={isAdmin}
          interactions={getMessageInteractions?.(item.id)}
          onSetInteractions={
            onSetMessageInteractions ? perm => onSetMessageInteractions(item.id, perm) : undefined
          }
          reactionEmojis={reactionEmojis}
          reactions={reactionTallies.get(item.id) ?? EMPTY_TALLIES}
          onReactEmoji={onReactWithEmoji}
          bubbleReactions={bubbleTallies.get(item.id)}
          onShowReactors={row.onShowReactors}
          commentCount={commentCounts.get(item.id) ?? 0}
          onGetThread={onGetChannelThread}
          onPostComment={onPostChannelComment}
          getAuthorName={onGetDisplayName ?? undefined}
          getAuthorGradient={getAuthorGradient}
          onOpenMember={onOpenMember}
          onLookupEvent={onLookupEvent}
          onOpenRef={onOpenRef}
          onOpenInviteLink={onOpenInviteLink}
          onStartEdit={stableStartEdit}
          canEdit={!!currentUserPubkey && item.pubkey === currentUserPubkey && !!onEditGroupMessage}
          quote={quote}
          firstInRun={firstInRun.get(item.id) ?? true}
          onReply={!channelFeed && isMember ? row.onReply : undefined}
          // Promote ("Turn on replies") publishes the message to the PUBLIC feed. Offered in
          // private spaces too — the card's isMine gate keeps it AUTHOR-only, and publishing your
          // OWN words publicly is the author's deliberate choice (same display + mechanism as a
          // public channel, per design). The edit-back re-seals under the space key (AppRuntime).
          onEnableReplies={onEnableReplies}
          onOpenPromoted={onOpenPromoted}
          promotedReplyCount={promotedCounts.get(item.id)}
          onSaveToEmbed={row.onSaveToEmbed}
          isPinned={item.id === pinnedMessageId}
          onTogglePin={isAdmin && onSetPinned ? row.onTogglePin : undefined}
          pinnedExpanded={pinnedExpanded}
          onTogglePinExpand={togglePinExpand}
          status={sendStatus?.get(item.id)}
          reason={sendReasons?.get(item.id)}
          onRetry={onRetry ? row.onRetryMessage : undefined}
          onCancel={onCancel ? row.onCancelMessage : undefined}
        />
      );
    },
    // NOTE: `draft`/typing state is deliberately NOT a dependency — a keystroke must not re-create
    // renderRow and churn every visible row. `memberName`/`jumpTo` are deliberately omitted too (see
    // the comment inside): their real inputs (currentUserPubkey, byId) are already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      channelFeed, byId, currentUserPubkey, isAdmin, getMessageInteractions,
      onSetMessageInteractions, reactionEmojis, reactionTallies, onReactWithEmoji, bubbleTallies,
      commentCounts, onGetChannelThread, onPostChannelComment, onGetDisplayName, getAuthorGradient,
      onOpenMember, onLookupEvent, onOpenRef, stableStartEdit, onEditGroupMessage, isMember, isPrivate,
      onEnableReplies, onOpenPromoted, promotedCounts, pinnedMessageId, onSetPinned, pinnedExpanded,
      togglePinExpand, getRowHandlers, sendStatus, sendReasons, onRetry, onCancel, firstInRun,
    ],
  );

  // ── Membership handoff: derived review-queue / invited-strip / manage-page values ────────────
  // Queue = live pending entries plus this session's resolved cards, which outlive their pending
  // entry. An invited+pending entry — someone `autoApproveInvited`'s background sweep SHOULD have
  // silently promoted — used to be unconditionally dropped here on the assumption the sweep always
  // catches it. It doesn't always (a private space's key not hydrated yet, a bounced publish, …:
  // see AppRuntime.sweepInvitedAfterKeys's doc — this is the exact stuck state Olene's field incident
  // traced to), so it renders as its own distinct, still-actionable row instead — a missed auto-
  // approve must always be human-recoverable.
  const queueSource: {pubkey: string; at?: number; name?: string; note?: string; invited: boolean}[] =
    joinQueue ?? pending.map(pk => ({pubkey: pk, invited: false}));
  // A resolved (approved/declined) entry whose publish actually bounced (the relay terminally
  // rejected it — see AppRuntime.getRosterActionStatus) must not keep claiming success forever: a
  // silently-bounced approve is exactly what stranded Olene invisibly. Re-derived every render (no
  // effect/setState needed) — once the publish is confirmed rejected, the row simply falls back OUT
  // of "resolved" and re-enters its live list with working Approve/Decline again.
  const bounced = (pk: string): boolean => onGetRosterActionStatus?.(pk)?.status === 'rejected';
  const isResolved = (pk: string): boolean => !!resolvedReqs[pk] && !bounced(pk);
  const liveQueue = queueSource.filter(rq => !rq.invited && !isResolved(rq.pubkey));
  const invitedPendingQueue = queueSource.filter(rq => rq.invited && !isResolved(rq.pubkey));
  const resolvedCards = Object.entries(resolvedReqs)
    .filter(([pk]) => isResolved(pk))
    .map(([pk, r]) => ({pubkey: pk, ...r}));
  const pendingReqCount = liveQueue.length + invitedPendingQueue.length;
  // Requests exist only for CLOSED spaces; reviewing needs relay admin rights (a non-admin's 9000
  // would be rejected), so the section renders for admins only.
  const showRequests = isAdmin && !!closed;
  // Design: admins can add people; in a group chat (non-broadcast) anyone can.
  const canAdd = (isAdmin || !broadcast) && !!onInvitePeople;
  const canManage = isAdmin || !broadcast;
  const manageLabel = isAdmin ? (broadcast ? 'Manage channel' : 'Manage group') : 'Members & settings';
  const resolveReq = (rq: {pubkey: string; at?: number; name?: string; note?: string}, state: 'approved' | 'declined'): void => {
    setResolvedReqs(r => ({...r, [rq.pubkey]: {state, name: rq.name, note: rq.note, at: rq.at}}));
    if (state === 'approved') onApprove?.(rq.pubkey);
    else onDeny?.(rq.pubkey);
  };
  // Members list: freshly-approved (this session) members sort first and carry the NEW tag.
  const approvedNow = new Set(resolvedCards.filter(r => r.state === 'approved').map(r => r.pubkey));
  const orderedMembers = [...members].sort((a, b) => Number(approvedNow.has(b)) - Number(approvedNow.has(a)));
  const MEMBER_PREVIEW_COUNT = 8;
  const visibleMembers = membersExpanded ? orderedMembers : orderedMembers.slice(0, MEMBER_PREVIEW_COUNT);
  const hiddenMemberCount = orderedMembers.length - visibleMembers.length;
  const requestCard = (
    rq: {pubkey: string; at?: number; name?: string; note?: string},
    resolved?: 'approved' | 'declined',
    invitedPending?: boolean,
  ): React.JSX.Element => {
    // A row still sitting in resolvedReqs but excluded from `resolved` (isResolved() said no, because
    // bounced() said yes) is a request we thought we'd handled — it needs a visible "that didn't
    // work" hint, not a silent, unexplained reappearance in the live list.
    const justBounced = !resolved && !!resolvedReqs[rq.pubkey];
    return (
    <View key={rq.pubkey} style={s.reqCard}>
      <View style={s.reqHead}>
        <GradientAvatar seed={npubFor(rq.pubkey)} size={34} radius={17} />
        <View style={s.reqHeadText}>
          <Text style={s.reqName} numberOfLines={1}>{rq.name?.trim() || memberName(rq.pubkey)}</Text>
          <Text style={s.reqNpub} numberOfLines={1}>{npubShort(rq.pubkey)}</Text>
        </View>
        {rq.at ? <Text style={s.reqWhen}>{relTimeShort(rq.at)}</Text> : null}
      </View>
      {invitedPending && (
        <Text style={s.reqInvitedNote}>
          ✉️ Invited · waiting to be let in — the auto-approve may have missed them.
        </Text>
      )}
      {rq.note ? <Text style={s.reqNote}>{rq.note}</Text> : null}
      {justBounced && (
        <Text style={s.reqBounced} accessibilityLabel={`bounced-${rq.pubkey}`}>
          Didn't go through last time — try again.
        </Text>
      )}
      {!resolved ? (
        <View style={s.reqActions}>
          <Press style={s.reqApprove} onPress={() => resolveReq(rq, 'approved')} accessibilityLabel={`approve-${rq.pubkey}`}>
            <Text style={s.reqApproveText}>Approve</Text>
          </Press>
          <Press style={s.reqDecline} onPress={() => resolveReq(rq, 'declined')} accessibilityLabel={`deny-${rq.pubkey}`}>
            <Text style={s.reqDeclineText}>Decline</Text>
          </Press>
        </View>
      ) : resolved === 'approved' ? (
        <Text style={s.reqApproved}>✓ Approved — added to members</Text>
      ) : (
        <Text style={s.reqDeclined}>Declined quietly — they'll keep seeing "pending".</Text>
      )}
    </View>
    );
  };

  // Member ⋯ menu (Manage page): every action closes the sheet first, then runs — mirrors the
  // `act()` close-then-run idiom the message-row ⋯ menus use (BroadcastCard / MessageItem above).
  const closeMemberMenu = (fn: () => void) => () => { setMemberMenuFor(null); fn(); };
  // Ownership transfer is irreversible (and NOT optimistic, unlike promote/demote/kick) — confirm
  // before firing onTransfer. Only the confirm button's onPress reaches onTransfer.
  const confirmTransfer = (pk: string): void => {
    Alert.alert(
      'Transfer ownership?',
      `${memberName(pk)} becomes the owner — this can't be undone by you.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Transfer', style: 'destructive', onPress: () => onTransfer?.(pk)},
      ],
    );
  };

  // ── ADD PEOPLE (full page, multi-select, invite-to-accept) ───────────────────────────────────
  if (screen === 'addpeople') {
    return (
      <AddPeopleScreen
        spaceName={name}
        onGetPhonebook={onGetPhonebook}
        existingMembers={[...members, ...(currentUserPubkey ? [currentUserPubkey] : [])]}
        invitedPubkeys={invited.map(i => i.p)}
        onSend={pks => onInvitePeople?.(pks)}
        onBack={() => setScreen('manage')}
      />
    );
  }

  // ── MANAGE (full page: join requests → members incl. invited strip → edit → leave) ──────────
  if (screen === 'manage') {
    return (
      <View style={s.root}>
        <View style={s.apHeaderRow}>
          <Press onPress={() => setScreen('chat')} accessibilityLabel="manage-back">
            <Text style={s.apBack}>‹ {name}</Text>
          </Press>
        </View>
        <ScrollView contentContainerStyle={s.mgScroll} keyboardShouldPersistTaps="handled">
          <View style={s.mgHead}>
            <GradientAvatar gradient={gradient} seed={groupId} size={46} shape={avatarShape} />
            <View style={s.mgHeadText}>
              <Text style={s.mgName} numberOfLines={1}>{name}</Text>
              <Text style={s.mgSub}>{spaceLabel} · {members.length} member{members.length === 1 ? '' : 's'}</Text>
            </View>
          </View>

          {showRequests && (
            <>
              <View style={s.mgLabelRow}>
                <Text style={s.mgLabel}>JOIN REQUESTS</Text>
                {pendingReqCount > 0 && (
                  <View style={s.reqBadge}><Text style={s.reqBadgeText}>{pendingReqCount}</Text></View>
                )}
              </View>
              {liveQueue.length === 0 && invitedPendingQueue.length === 0 && resolvedCards.length === 0 ? (
                <View style={s.reqEmpty}><Text style={s.reqEmptyText}>No pending requests.</Text></View>
              ) : (
                <>
                  {liveQueue.map(rq => requestCard(rq))}
                  {invitedPendingQueue.map(rq => requestCard(rq, undefined, true))}
                  {resolvedCards.map(rq => requestCard(rq, rq.state))}
                  <Text style={s.reqFooter}>
                    Any admin can approve. Declining is silent — the requester is never shown a rejection.
                  </Text>
                </>
              )}
            </>
          )}

          <View style={s.mgLabelRow}>
            <Text style={s.mgLabel}>MEMBERS · {members.length}</Text>
            <View style={s.mgLabelSpacer} />
            {canAdd && (
              <Press style={s.addPeopleChip} onPress={() => setScreen('addpeople')} accessibilityLabel="add-people">
                <Text style={s.addPeopleChipText}>+ Add people</Text>
              </Press>
            )}
          </View>
          <View style={s.memberCard}>
            {canAdd && invited.length > 0 && (
              <View style={s.invitedStrip}>
                {invited.map(iv => (
                  <View key={iv.p} style={s.invitedRow}>
                    <View style={s.invitedAvatar}>
                      <GradientAvatar seed={npubFor(iv.p)} size={32} radius={16} />
                    </View>
                    <View style={s.memberText}>
                      <Text style={s.invitedName} numberOfLines={1}>{memberName(iv.p)}</Text>
                      <Text style={s.invitedNpub} numberOfLines={1}>{npubShort(iv.p)}</Text>
                    </View>
                    <Text style={s.invitedTag}>INVITED</Text>
                    {onRevokeInvite && (
                      <Press onPress={() => onRevokeInvite(iv.p)} accessibilityLabel={`revoke-invite-${iv.p}`}>
                        <Text style={s.invitedRevoke}>✕</Text>
                      </Press>
                    )}
                  </View>
                ))}
                <Text style={s.invitedCaption}>Waiting for them to accept — they're not in the space yet.</Text>
              </View>
            )}
            {visibleMembers.map(pk => {
              const isThisAdmin = adminSet.has(pk);
              const isThisOwner = false; // owner pk isn't threaded today; ADMIN covers the tag
              const isMe = pk === currentUserPubkey;
              return (
                <Press
                  variant="row"
                  key={pk}
                  style={s.memberRow2}
                  disabled={!onOpenMember || isMe}
                  onPress={() => onOpenMember?.(pk)}
                  accessibilityLabel={`member-${pk}`}>
                  <GradientAvatar seed={npubFor(pk)} size={32} radius={16} />
                  <View style={s.memberText}>
                    <Text style={s.memberName} numberOfLines={1}>{memberName(pk)}</Text>
                    <Text style={s.memberNpub} numberOfLines={1}>{npubShort(pk)}</Text>
                  </View>
                  {isMe && <Text style={s.memberYou}>you</Text>}
                  {approvedNow.has(pk) && <Text style={s.memberNew}>NEW</Text>}
                  {(isThisAdmin || isThisOwner) && <Text style={s.memberAdmin}>ADMIN</Text>}
                  {isAdmin && !isMe && (
                    <Press onPress={() => setMemberMenuFor(pk)} accessibilityLabel={`member-menu-${pk}`}>
                      <Text style={s.memberMenuDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
                    </Press>
                  )}
                </Press>
              );
            })}
            {members.length === 0 && <Text style={s.empty}>No members loaded yet.</Text>}
            {hiddenMemberCount > 0 && (
              <Press style={s.moreMembers} onPress={() => setMembersExpanded(true)} accessibilityLabel="more-members">
                <Text style={s.moreMembersText}>+ {hiddenMemberCount} more member{hiddenMemberCount === 1 ? '' : 's'}</Text>
              </Press>
            )}
          </View>

          {isAdmin && onEditGroup && (
            <Press variant="row" style={s.sheetEditBtn} onPress={() => setEditOpen(true)} accessibilityLabel="edit-group">
              <Text style={s.sheetEditText}>Edit {broadcast ? 'channel' : 'group'}</Text>
            </Press>
          )}
          {isOwner && isPrivate && onSetLogOffer && (
            <View style={s.logOfferBlock}>
              <View style={s.muteRow}>
                <Text style={s.muteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Offer to community log</Text>
                <Switch
                  value={!!logOffer}
                  onValueChange={on => (on ? onSetLogOffer() : onRevokeLogOffer?.())}
                  trackColor={{true: colors.accent, false: colors.borderLight}}
                  thumbColor={colors.onAccent}
                  accessibilityLabel="log-offer-toggle"
                />
              </View>
              <Text style={s.switchHint}>Lets the organizer feature this space in the community log.</Text>
            </View>
          )}
          {isOwner && onDelete ? (
            <Press variant="row" style={s.leaveBtn} onPress={onDelete}>
              <Text style={s.leaveBtnText}>Delete {broadcast ? 'channel' : 'group'}</Text>
            </Press>
          ) : isMember ? (
            <Press variant="row" style={s.leaveBtn} onPress={() => { setScreen('chat'); onLeave(); }}>
              <Text style={s.leaveBtnText}>Leave {broadcast ? 'channel' : 'group'}</Text>
            </Press>
          ) : null}
        </ScrollView>

        {/* Member ⋯ menu — one shared bottom sheet for the row Promote/Demote/Transfer/Kick actions
            (replaces up to 4 inline per-row buttons). Gated per role; Kick is always offered (matches
            today's optimistic+revertable behavior) and Transfer is owner-only + confirmed (irreversible,
            not optimistic). */}
        <Modal transparent animationType="fade" visible={!!memberMenuFor} onRequestClose={() => setMemberMenuFor(null)}>
          {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
          <Press variant="bare" style={s.actionBackdrop} onPress={() => setMemberMenuFor(null)} accessibilityRole="none" />
          <View style={s.actionWrap}>
            <View style={s.actionCard}>
              <Text style={s.memberMenuTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {memberMenuFor ? memberName(memberMenuFor) : ''}
              </Text>
              {memberMenuFor && !adminSet.has(memberMenuFor) && onAddMember && (
                <Press
                  variant="row"
                  style={s.actionRow}
                  onPress={closeMemberMenu(() => onAddMember(memberMenuFor, true))}
                  accessibilityLabel={`promote-${memberMenuFor}`}>
                  <Text style={s.actionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Promote to admin</Text>
                </Press>
              )}
              {memberMenuFor && adminSet.has(memberMenuFor) && onAddMember && (
                <Press
                  variant="row"
                  style={s.actionRow}
                  onPress={closeMemberMenu(() => onAddMember(memberMenuFor, false))}
                  accessibilityLabel={`demote-${memberMenuFor}`}>
                  <Text style={s.actionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Demote to member</Text>
                </Press>
              )}
              {memberMenuFor && isOwner && onTransfer && (
                <Press
                  variant="row"
                  style={s.actionRow}
                  onPress={closeMemberMenu(() => confirmTransfer(memberMenuFor))}
                  accessibilityLabel={`transfer-${memberMenuFor}`}>
                  <Text style={s.actionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Transfer ownership</Text>
                </Press>
              )}
              {memberMenuFor && (
                <Press
                  variant="row"
                  style={[s.actionRow, s.actionRowLast]}
                  onPress={closeMemberMenu(() => onKick(memberMenuFor))}
                  accessibilityLabel={`kick-${memberMenuFor}`}>
                  <Text style={[s.actionLabel, s.actionLabelDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Kick</Text>
                </Press>
              )}
            </View>
            <Press style={s.actionCancel} onPress={() => setMemberMenuFor(null)} accessibilityLabel="member-menu-cancel">
              <Text style={s.actionCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
            </Press>
          </View>
        </Modal>

        {onEditGroup && (
          <EditChannelModal
            visible={editOpen}
            variant="group"
            noun={broadcast ? 'channel' : 'group'}
            showReactions={broadcast}
            initial={{name, about, closed, isPrivate, gradient, reactions: configuredReactions, seed: groupId}}
            isOwner={isOwner}
            onClose={() => setEditOpen(false)}
            onSave={v => {
              // Type/privacy are immutable — preserve the created closed/private/broadcast flags.
              onEditGroup({
                name: v.name,
                about: v.about,
                closed: v.closed,
                private: v.private,
                gradient: v.gradient,
                broadcast,
              });
              // Private-channel reactions ride the client settings doc (the relay drops them from 9002).
              if (broadcast) onSaveReactions?.(v.reactions);
            }}
            onDelete={onDelete}
          />
        )}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
      {/* Header */}
      <SpaceHeader
        leading={<SpaceBackButton onPress={onBack} />}
        gradient={gradient}
        seed={groupId}
        shape={avatarShape}
        avatarSize={40}
        name={name}
        subtitle={`${spaceLabel} · ${members.length} member${members.length === 1 ? '' : 's'} ›`}
        onPressBody={() => setInfoOpen(true)}
        bodyAccessibilityLabel="group-info"
        trailing={
          isMember ? (
            <StatusPill label="Joined" />
          ) : inviteOnly ? (
            <StatusPill label="Invite only" />
          ) : (
            <Press style={[s.pill, s.join]} onPress={onJoin} accessibilityLabel="join-group">
              <Text style={s.pillText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{closed ? 'Request' : 'Join'}</Text>
            </Press>
          )
        }
      />

      {/* Join requests live on the MANAGE page now (quick sheet → ⚙️ Manage, badge = pending
          count) — the old inline approve/deny panel is gone (membership handoff). */}

      {/* QUICK-ACTIONS sheet (tap header) — membership handoff: quick actions ONLY. Members,
          requests, invites and editing all live on the full Manage page (⚙️ row below, which
          carries the pending-request count badge). */}
      <Modal visible={infoOpen} transparent animationType="slide" onRequestClose={() => setInfoOpen(false)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setInfoOpen(false)} accessibilityRole="none" />
        <View style={s.infoSheet}>
          <View style={s.sheetHandle} />
          <ScrollView contentContainerStyle={s.sheetContent}>
            <View style={s.sheetHead}>
              <GradientAvatar gradient={gradient} seed={groupId} size={72} shape={avatarShape} radius={radius.lg} />
              <Text style={s.sheetName} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
              <Text style={s.sheetSub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {spaceLabel} · {members.length} member{members.length === 1 ? '' : 's'}
              </Text>
              {about ? <Text style={s.sheetAbout}>{about}</Text> : null}
            </View>

            {canManage && (
              <Press
                variant="row"
                style={s.quickRow}
                onPress={() => { setInfoOpen(false); setScreen('manage'); }}
                accessibilityLabel="open-manage">
                <Text style={s.quickRowText}>⚙️ {manageLabel}</Text>
                <View style={s.quickRowSpacer} />
                {showRequests && pendingReqCount > 0 && (
                  <View style={s.reqBadge} accessibilityLabel="pending-requests-badge">
                    <Text style={s.reqBadgeText}>{pendingReqCount}</Text>
                  </View>
                )}
                <Text style={s.quickRowChevron}>›</Text>
              </Press>
            )}
            {shareToken ? (
              <Press
                variant="row"
                style={s.quickRow}
                onPress={() => {
                  // Invite secret — local-only + 2-min expiring pasteboard on iOS (see util/clipboard).
                  copySensitive(shareToken);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 1800);
                }}
                accessibilityLabel="share-space">
                <Text style={s.quickRowText}>
                  {shareCopied ? '✓ Link copied — paste it in any chat or post' : `🔗 Share ${broadcast ? 'channel' : 'group'}`}
                </Text>
              </Press>
            ) : null}
            <Press variant="row" style={s.muteRow} onPress={handleMuteToggle}>
              <Text style={s.muteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔕 Mute notifications</Text>
              <Switch value={muted} onValueChange={handleMuteToggle} trackColor={{true: colors.accent, false: colors.borderLight}} thumbColor={colors.onAccent} />
            </Press>
            {isOwner && onDelete ? (
              <Press variant="row" style={s.leaveBtn} onPress={() => { setInfoOpen(false); onDelete(); }}>
                <Text style={s.leaveBtnText}>Delete {broadcast ? 'channel' : 'group'}</Text>
              </Press>
            ) : isMember ? (
              <Press variant="row" style={s.leaveBtn} onPress={() => { setInfoOpen(false); onLeave(); }}>
                <Text style={s.leaveBtnText}>Leave {broadcast ? 'channel' : 'group'}</Text>
              </Press>
            ) : null}
          </ScrollView>
        </View>
      </Modal>

      {/* Chat */}
      <View style={s.chatWrap}>
      <FlatList
        ref={listRef}
        style={s.chat}
        data={orderedMessages}
        keyExtractor={m => (listKeyFor ? listKeyFor(m.id) : m.id)}
        // orderedMessages PREPENDS at index 0 for a channelFeed (newest-first, see above) and
        // APPENDS at the end for a plain chat (oldest-first) — either way, existing items never
        // reorder relative to each other, only RN's own documented precondition for this prop (see
        // ChannelView's identical comment). Covers both a channelFeed reader scrolled into older
        // broadcasts (a prepend above them would otherwise shift their view) and a plain-chat reader
        // scrolled up into history when a paginated older page lands.
        maintainVisibleContentPosition={{minIndexForVisible: 0}}
        onScroll={jump.onScroll}
        onMomentumScrollEnd={jump.onScroll}
        onScrollEndDrag={jump.onScroll}
        scrollEventThrottle={16}
        // Windowing parity with ChannelView's broadcast feed — this chat can grow just as long, and
        // had no windowing props at all before (every message stayed mounted forever).
        //
        // removeClippedSubviews is deliberately OFF (unlike ChannelView, which has no
        // maintainVisibleContentPosition to fight with): on Android it detaches off-screen CHILD
        // VIEWS from the same ScrollView content ViewGroup that MaintainVisibleScrollPositionHelper
        // walks by index to find/track its anchor (see ThreadView.tsx's identical note). A view
        // clipped away mid-update can vanish out from under the anchor the helper is tracking,
        // defeating the very position-stability this list pairs mVCP in for. windowSize/
        // maxToRenderPerBatch/initialNumToRender already bound what's mounted.
        removeClippedSubviews={false}
        maxToRenderPerBatch={6}
        windowSize={11}
        initialNumToRender={10}
        // Auto-follow to the newest message ONLY while the reader hasn't scrolled away to read
        // history. onContentSizeChange fires on EVERY content-size change — not just a new message,
        // also a row's height settling (an image/gradient finishing layout) — so an unconditional
        // scrollToEnd here was yanking a reader back to the bottom mid-history read on any of those,
        // not only on a genuine new arrival. jump.showJump is already exactly "has the reader
        // scrolled far enough from the newest edge to care" (the SAME 'bottom'-anchored signal the
        // return-to-latest button below reads), so reusing it needs no new state. Combined with
        // maintainVisibleContentPosition above: that prop keeps a scrolled-away reader's view stable
        // when new content lands; this condition stops the imperative scrollToEnd from overriding it.
        onContentSizeChange={() => { if (!channelFeed && !jump.showJump) listRef.current?.scrollToEnd({animated: false}); }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        // A tap on a link chip / REFERENCED card must register even while the composer keyboard is
        // still up (parity with the DM chat list) — without this the first tap only dismisses it.
        keyboardShouldPersistTaps="handled"
        // Stale-first: while the scoped history fetch is still replaying (historyPending), claim
        // nothing — a group with real history must never flash "No messages yet." mid-load.
        ListEmptyComponent={historyPending ? null : <Text style={s.empty} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>No messages yet.</Text>}
        renderItem={renderRow}
      />
        <JumpButton visible={jump.showJump} direction={channelFeed ? 'up' : 'down'} onPress={scrollToLatest} count={newWhileAway} />
      </View>

      {/* Composer — only members may post (relay enforces this too). In a broadcast channel,
          only admins post top-level; everyone else is a read-only audience. */}
      {broadcast && !isAdmin ? (
        <Text style={s.joinHint} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {isMember
            ? 'Audience — only admins can post here.'
            : (closed ? 'Request to join — an admin must approve you.' : 'Join to follow this broadcast channel.')}
        </Text>
      ) : isMember ? (
        <>
          {editingId && (
            <View style={s.editingBar}>
              <Text style={s.editingText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️ Editing message</Text>
              <Press onPress={cancelEdit}>
                <Text style={s.editingCancel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
              </Press>
            </View>
          )}
          {replyingTo && !editingId && (
            <View style={s.replyBar}>
              <QuotedReply name={replyingTo.name} text={replyingTo.text} onClose={() => setReplyingTo(null)} />
            </View>
          )}
          {isSpaceKeyMissing && (
            <View style={s.keyMissingBanner}>
              <Text style={s.keyMissingText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Unlocking this space…
              </Text>
            </View>
          )}
          {/* Wrapped in a plain View (ChannelComposer's own props don't forward touch handlers) so
              the swipe-back drag stands down for any touch landing on it: the composer's TextInput
              does its own selection-handle drag, which never joins JS responder negotiation, so
              without this the page swipe would win that drag instead. */}
          <View {...optOut}>
            <ChannelComposer
              ref={composerInputRef}
              value={draft}
              onChangeText={v => { setDraft(v); if (!editingId) slot.persist(v); }}
              placeholder={editingId ? 'Edit your message…' : 'Message'}
              // No key means every send would immediately fail closed — disable the button rather
              // than let the tap round-trip through a throw the user can't do anything about yet.
              onSend={isSpaceKeyMissing ? NOOP : send}
              onEmbed={() => setSavedSheetOpen(true)}
              onExpand={() => setEditorOpen(true)}
              onRecordVoice={allowVoice ? () => setVoiceOpen(true) : undefined}
              onAddPicture={pictureRules?.allow ? () => setPictureOpen(true) : undefined}
              accessibilityInput="group-composer"
              accessibilitySend="group-send"
            />
          </View>
          {allowVoice && (
            <VoiceComposer
              visible={voiceOpen}
              onClose={() => setVoiceOpen(false)}
              onSend={voice => {
                setDraft(d => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${encodeInlineVoice(voice)} `);
                setVoiceOpen(false);
              }}
            />
          )}
          <PictureComposer
            visible={pictureOpen}
            onClose={() => setPictureOpen(false)}
            rules={pictureRules ?? DEFAULT_PICTURE_RULES}
            // Include pictures already staged in this draft so one message can't exceed the allowance.
            spentBytes={(picturesSpentBytes ?? 0) + extractInlinePictures(draft).reduce((n, p) => n + p.weightBytes, 0)}
            onAdd={token => setDraft(d => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${token} `)}
          />
        </>
      ) : (
        <Text style={s.joinHint} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {inviteOnly
            ? '🔒 Invite only — an admin must add you to this group.'
            : closed
              ? 'Request to join — an admin must approve you.'
              : 'Join this group to send messages.'}
        </Text>
      )}

      {/* Modals */}
      {onEditGroup && (
        <EditChannelModal
          visible={editOpen}
          variant="group"
          noun={broadcast ? 'channel' : 'group'}
          showReactions={broadcast}
          initial={{name, about, closed, isPrivate, gradient, reactions: configuredReactions, seed: groupId}}
          isOwner={isOwner}
          onClose={() => setEditOpen(false)}
          onSave={v => {
            // Type/privacy are immutable — preserve the created closed/private/broadcast flags.
            onEditGroup({
              name: v.name,
              about: v.about,
              closed: v.closed,
              private: v.private,
              gradient: v.gradient,
              broadcast,
            });
            // Private-channel reactions ride the client settings doc (the relay drops them from 9002).
            if (broadcast) onSaveReactions?.(v.reactions);
          }}
          onDelete={onDelete}
        />
      )}

      {/* No.8: the ⤢ expand button opens the full Post Editor v2 engine, message-mode, over the same
          draft — the same rich body/Aa-blocks/insert-bar/byline the feed uses, minus title/tags/
          label/CW/Details (a group message stays a message; see ComposerScreen's messageMode doc).
          It does NOT send: its pill is Done, which closes with the draft synced back through
          onChangeDraft, and the message goes out via the composer bubble's ↑ above (`send`) — the
          same one path whether or not the writer ever opened the editor, editing included.
          Phase 4: `draftStore`/`draftLocation` make the editor itself the DraftStore participant
          (autosave, long-press "Saved ✓", keyed by the SAME stable `inProgressDraftId` the compact
          `ChannelComposer` above already writes to via `slot`) — both composers converge on one row.
          Withheld while editing an EXISTING message (`editingId`): the slot is for the next NEW
          message only, never an edit-in-progress (matches the compact composer's own
          `if (!editingId)` guard on `slot.persist` above). */}
      <ComposerScreen
        visible={editorOpen}
        onClose={() => setEditorOpen(false)}
        messageMode
        headerTitle={editingId ? 'Edit message' : name}
        value={draft}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        pictureSpentBytes={picturesSpentBytes}
        postRules={postRules}
        onChangeDraft={v => setDraft(v)}
        savedEmbedTokens={editorEmbeds}
        onRemoveSavedToken={handleRemoveEmbed}
        space={{name, gradient, shape: avatarShape}}
        onOpenDrafts={onOpenDrafts}
        draftStore={editingId ? undefined : draftStore}
        draftLocation={editingId ? undefined : draftLoc}
      />

      {/* Who reacted — long-press a reaction chip on a group-chat bubble. */}
      <Modal visible={!!reactorsSheet} transparent animationType="fade" onRequestClose={() => setReactorsSheet(null)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setReactorsSheet(null)} accessibilityRole="none" />
        <View style={s.savedSheetWrap}>
          <View style={s.savedCard}>
            <View style={s.savedHeader}>
              <Text style={s.savedHeaderLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>WHO REACTED</Text>
              <Text style={s.savedHeaderCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{reactorsSheet?.reduce((n, t) => n + t.count, 0) ?? 0}</Text>
            </View>
            <ScrollView style={s.savedList}>
              {(reactorsSheet ?? []).flatMap(t =>
                t.pubkeys.map(pk => (
                  <View key={`${t.emoji}:${pk}`} style={s.reactorRow}>
                    <GradientAvatar gradient={getAuthorGradient?.(pk)} seed={npubFor(pk)} size={28} radius={14} />
                    <Text style={s.reactorName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{memberName(pk)}</Text>
                    <Text style={s.reactorEmoji} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t.emoji}</Text>
                  </View>
                )),
              )}
            </ScrollView>
          </View>
          <Press style={s.savedDoneBtn} onPress={() => setReactorsSheet(null)}>
            <Text style={s.savedDoneText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
          </Press>
        </View>
      </Modal>

      {/* SAVED · TAP TO EMBED sheet — the composer's 🔖 embed picker (parity with channels). */}
      <Modal visible={savedSheetOpen} transparent animationType="slide" onRequestClose={() => setSavedSheetOpen(false)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setSavedSheetOpen(false)} accessibilityRole="none" />
        <View style={s.savedSheetWrap}>
          <View style={s.savedCard}>
            <View style={s.savedHeader}>
              <Text style={s.savedHeaderLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>SAVED · TAP TO EMBED</Text>
              <Text style={s.savedHeaderCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{savedEmbeds.length} saved</Text>
            </View>
            {savedEmbeds.length === 0 ? (
              <Text style={s.savedEmpty} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Nothing saved yet. Use a post's ⋯ → “Save to embed later”.</Text>
            ) : (
              <ScrollView style={s.savedList}>
                {savedEmbeds.map(it => {
                  const selfContained =
                    it.kind === 30311 || it.kind === 39000 || it.kind === 31923 || !!it.draftToken || !!it.msgToken;
                  const row = toSavedEmbedRow(it, selfContained ? undefined : onLookupEvent?.(it.id));
                  return (
                    <View key={it.id} style={s.savedRow}>
                      <Press variant="row" style={s.savedRowBody} onPress={() => embedSaved(it)}>
                        <Text style={s.savedRowLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.label}</Text>
                        <Text style={s.savedRowTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.title}</Text>
                        {row.snippet ? <Text style={s.savedRowSnippet} numberOfLines={2}>{row.snippet}</Text> : null}
                      </Press>
                      <Press onPress={() => handleRemoveEmbed(it.id)}>
                        <Text style={s.savedRemove} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕</Text>
                      </Press>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
          <Press style={s.savedDoneBtn} onPress={() => setSavedSheetOpen(false)}>
            <Text style={s.savedDoneText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
          </Press>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  back: {color: colors.accent, fontSize: 22, paddingRight: 4},
  pill: {borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6},
  join: {backgroundColor: colors.accent},
  pillText: {color: '#fff', fontWeight: weight.semibold, fontSize: typeScale.caption},
  pendingPanel: {backgroundColor: '#1b2233', marginHorizontal: space.md, borderRadius: radius.md, padding: space.sm, marginBottom: space.sm},
  pendingTitle: {color: colors.accent, fontSize: typeScale.caption, fontWeight: weight.bold, marginBottom: 4},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6},
  avatar: {width: 24, height: 24, borderRadius: 12, flexShrink: 0},
  avatarXs: {width: 14, height: 14, borderRadius: 7, flexShrink: 0},
  memberId: {color: colors.textPrimary, fontSize: typeScale.label, flex: 1},
  // Per-row ⋯ trigger (Manage page member rows) — mirrors MessageFooter's menuDots.
  memberMenuDots: {fontSize: 18, color: colors.textMuted},
  approveBtn: {backgroundColor: colors.success, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3},
  approveText: {color: '#fff', fontSize: typeScale.micro, fontWeight: weight.bold},
  denyBtn: {backgroundColor: '#2a2a2a', borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3},
  denyText: {color: colors.textSecondary, fontSize: typeScale.micro, fontWeight: weight.bold},
  addMemberBtn: {marginTop: space.sm, paddingVertical: 8, alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border},
  addMemberText: {color: colors.accent, fontSize: typeScale.label, fontWeight: weight.semibold},
  // Wraps the message list so the return-to-latest button floats bottom-right, above the composer.
  chatWrap: {flex: 1},
  // No horizontal padding here (RC-fix: this used to double up with the broadcast/private card's own
  // 12dp `marginHorizontal`, insetting private cards 24dp/side vs public channels' 12dp). The
  // ChatBubble (group-chat) row supplies its own equivalent inset via `msgBubble` below so its
  // visual inset is unchanged.
  chat: {flex: 1},
  // ── Group info bottom sheet ──
  sheetBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  infoSheet: {position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8},
  sheetHandle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderLight, marginBottom: 4},
  sheetContent: {padding: 16, paddingBottom: space.xl, gap: 12},
  sheetHead: {alignItems: 'center', gap: 6, marginBottom: 4},
  sheetName: {color: colors.textPrimary, fontSize: 22, fontWeight: weight.bold, marginTop: 6},
  sheetSub: {color: colors.textMuted, fontSize: typeScale.label},
  sheetAbout: {color: colors.textSecondary, fontSize: typeScale.label, textAlign: 'center', marginTop: 4},
  memberCard: {backgroundColor: colors.surface, borderRadius: radius.lg, padding: 14, gap: 2},
  memberCardLabel: {color: colors.textMuted, fontSize: 11, fontWeight: weight.bold, letterSpacing: 0.8, marginBottom: 8},
  inviteHint: {color: colors.textMuted, fontSize: 11.5, lineHeight: 16, marginBottom: 10},
  inviteRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  inviteInput: {flex: 1, minWidth: 0, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9, color: colors.textPrimary, fontSize: 14, fontFamily: 'monospace'},
  inviteBtn: {backgroundColor: colors.accent, borderRadius: 9, paddingHorizontal: 14, paddingVertical: 10, flexShrink: 0},
  inviteBtnText: {color: colors.onAccent, fontSize: 13, fontWeight: weight.bold},
  copyInviteBtn: {marginTop: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 9, paddingVertical: 10},
  copyInviteText: {color: colors.textPrimary, fontSize: 13, fontWeight: weight.semibold},
  memberRow2: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8},
  memberText: {flex: 1, minWidth: 0},
  memberName: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  memberNpub: {color: colors.link, fontSize: typeScale.caption, fontFamily: 'monospace', marginTop: 1},
  memberAdmin: {color: colors.accent, fontSize: typeScale.micro, fontWeight: weight.bold, backgroundColor: colors.accentSoft, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, overflow: 'hidden'},
  memberYou: {color: colors.textMuted, fontSize: typeScale.caption},
  memberNew: {color: colors.accent, fontSize: typeScale.micro, fontWeight: weight.bold, backgroundColor: colors.accentSoft, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, overflow: 'hidden'},
  // ── Membership handoff: quick sheet rows / Manage page / Add people ──
  quickRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, gap: 8},
  quickRowText: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold, flexShrink: 1},
  quickRowSpacer: {flex: 1},
  quickRowChevron: {color: colors.textMuted, fontSize: typeScale.body},
  reqBadge: {backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, minWidth: 20, alignItems: 'center'},
  reqBadgeText: {color: colors.onAccent, fontSize: 11, fontWeight: weight.bold},
  apHeaderRow: {borderBottomWidth: 1, borderBottomColor: colors.border},
  apBack: {color: colors.accent, fontSize: 14, fontWeight: weight.semibold, paddingHorizontal: 12, paddingVertical: 9},
  apIntro: {paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8},
  apTitle: {color: colors.textPrimary, fontSize: 19, fontWeight: weight.bold},
  apSub: {color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4},
  apSearch: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, marginTop: 11},
  apSearchIcon: {fontSize: 14, opacity: 0.7},
  apSearchInput: {flex: 1, color: colors.textPrimary, fontSize: 14, paddingVertical: 9},
  apListLabel: {color: colors.textMuted, fontSize: 11, fontWeight: weight.bold, letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4},
  apList: {flex: 1},
  apRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border},
  apRowInvited: {opacity: 0.6},
  apCheckSpacer: {width: 22, height: 22},
  apCheckOn: {width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center'},
  apCheckOnText: {color: colors.onAccent, fontSize: 12, fontWeight: weight.bold},
  apCheckOff: {width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.borderLight},
  apFooter: {padding: 10, borderTopWidth: 1, borderTopColor: colors.border},
  apSendBtn: {backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 13, alignItems: 'center'},
  apSendBtnText: {color: colors.onAccent, fontSize: 15, fontWeight: weight.semibold},
  apSendDisabled: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingVertical: 13, alignItems: 'center'},
  apSendDisabledText: {color: colors.textMuted, fontSize: 15, fontWeight: weight.semibold},
  mgScroll: {padding: 16, paddingBottom: space.xl, gap: 0},
  mgHead: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18},
  mgHeadText: {flex: 1, minWidth: 0},
  mgName: {color: colors.textPrimary, fontSize: 19, fontWeight: weight.bold},
  mgSub: {color: colors.textMuted, fontSize: 12.5, marginTop: 2},
  mgLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 4},
  mgLabel: {color: colors.textMuted, fontSize: 11, fontWeight: weight.bold, letterSpacing: 0.8},
  mgLabelSpacer: {flex: 1},
  addPeopleChip: {backgroundColor: colors.tagBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6},
  addPeopleChipText: {color: colors.accent, fontSize: 12.5, fontWeight: weight.semibold},
  reqCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 8},
  reqHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  reqHeadText: {flex: 1, minWidth: 0},
  reqName: {color: colors.textPrimary, fontSize: 14.5, fontWeight: weight.semibold},
  reqNpub: {color: colors.link, fontSize: 11, fontFamily: 'monospace', marginTop: 1},
  reqWhen: {color: colors.textMuted, fontSize: 11.5},
  reqNote: {backgroundColor: colors.surfaceAlt, borderLeftWidth: 2, borderLeftColor: colors.borderLight, borderTopRightRadius: 8, borderBottomRightRadius: 8, paddingHorizontal: 11, paddingVertical: 8, color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 9},
  reqInvitedNote: {color: colors.textSecondary, fontSize: 12, lineHeight: 17, fontWeight: weight.semibold, marginTop: 8},
  reqBounced: {color: colors.danger, fontSize: 12, fontWeight: weight.semibold, marginTop: 8},
  reqActions: {flexDirection: 'row', gap: 8, marginTop: 11},
  reqApprove: {flex: 1, backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 8, alignItems: 'center'},
  reqApproveText: {color: colors.onAccent, fontSize: 13, fontWeight: weight.semibold},
  reqDecline: {flex: 1, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 999, paddingVertical: 8, alignItems: 'center'},
  reqDeclineText: {color: colors.textSecondary, fontSize: 13, fontWeight: weight.semibold},
  reqApproved: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold, marginTop: 10},
  reqDeclined: {color: colors.textMuted, fontSize: 12.5, marginTop: 10},
  reqFooter: {color: colors.textMuted, fontSize: 11.5, lineHeight: 17, marginBottom: 18},
  reqEmpty: {backgroundColor: colors.surface, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderLight, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 18},
  reqEmptyText: {color: colors.textMuted, fontSize: 13},
  invitedStrip: {paddingBottom: 12, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 11},
  invitedRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  invitedAvatar: {opacity: 0.65},
  invitedName: {color: colors.textSecondary, fontSize: typeScale.body, fontWeight: weight.semibold},
  invitedNpub: {color: colors.textMuted, fontSize: typeScale.caption, fontFamily: 'monospace', marginTop: 1},
  invitedTag: {color: colors.textMuted, fontSize: typeScale.micro, fontWeight: weight.bold, letterSpacing: 0.4, borderWidth: 1, borderColor: colors.borderLight, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, overflow: 'hidden'},
  invitedRevoke: {color: colors.textMuted, fontSize: 13, paddingHorizontal: 4},
  invitedCaption: {color: colors.textMuted, fontSize: 11.5, lineHeight: 16},
  moreMembers: {marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.border},
  moreMembersText: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold},
  muteRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12},
  muteLabel: {color: colors.textPrimary, fontSize: typeScale.body},
  logOfferBlock: {marginTop: space.md, marginBottom: space.md},
  sheetEditBtn: {backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border},
  sheetEditText: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  leaveBtn: {backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border},
  leaveBtnText: {color: colors.danger, fontSize: typeScale.body, fontWeight: weight.semibold},
  editingBar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surfaceAlt, borderTopWidth: 1, borderTopColor: colors.border},
  editingText: {fontSize: 13, color: colors.textSecondary, fontWeight: weight.semibold},
  editingCancel: {fontSize: 13, color: colors.accent, fontWeight: weight.semibold},
  replyBar: {paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2, backgroundColor: colors.surfaceAlt, borderTopWidth: 1, borderTopColor: colors.border},
  // Proactive "the space isn't unlocked yet" notice — thin, muted, hairline-top, shown above the
  // composer while `isSpaceKeyMissing` (mirrors editingBar's shape, quieter tone: no action to take).
  keyMissingBanner: {paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surfaceAlt, borderTopWidth: 1, borderTopColor: colors.border},
  keyMissingText: {fontSize: 12.5, color: colors.textMuted, fontWeight: weight.semibold},
  // Broadcast/private-card row: NO horizontal padding here — the card supplies its own 12dp
  // `marginHorizontal` (public-channel parity; see `chat` above).
  msg: {marginVertical: 4},
  // Plain group-chat (ChatBubble) row: `chat` no longer carries horizontal padding, so this row
  // supplies the same 12dp (`space.md`) inset ChatBubble always relied on — pixel-identical to before.
  msgBubble: {marginVertical: 4, paddingHorizontal: space.md},
  // Delivery glyph under the user's own group-chat bubble — mirrors the DM bubble's status style.
  msgStatus: {alignSelf: 'flex-end', fontSize: 10, color: colors.textMuted, marginTop: 1, marginRight: 2},
  // T0.4: failed/rejected block — "✕ failed" + Retry/Cancel + calm reason, mirroring DmBubble's
  // failedBlock/failedRow/statusFailed/retryLink/failReason exactly (+ a Cancel link DmBubble has no
  // equivalent for, styled like SendProgress's muted Cancel).
  msgStatusFailed: {color: colors.danger, fontSize: 11, fontWeight: weight.bold},
  failedBlock: {alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '82%', marginTop: 1, marginRight: 2},
  failedRow: {flexDirection: 'row', alignItems: 'center'},
  retryLink: {color: colors.accent, fontSize: 11, fontWeight: weight.bold, marginLeft: 10},
  cancelLink: {color: colors.textMuted, fontSize: 11, fontWeight: weight.semibold, marginLeft: 10},
  failReason: {color: colors.textMuted, fontSize: 10, textAlign: 'right', marginTop: 1},
  // Promoted-chat-bubble tap-through row (T4.4) — the plain-chat mirror of BroadcastCard's "✦ On the
  // feed" eyebrow/footer, since a bare ChatBubble has no card frame to accent.
  promotedRow: {alignSelf: 'flex-start', marginTop: 2},
  promotedRowMine: {alignSelf: 'flex-end'},
  promotedRowText: {color: colors.accent, fontSize: 11.5, fontWeight: weight.semibold},
  // Reply rows (kept lightweight; the card/bubble visuals come from the shared primitives).
  msgHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginLeft: 2},
  msgTime: {color: colors.textMuted, fontSize: typeScale.micro, marginLeft: 'auto'},
  reply: {marginTop: 6, marginLeft: space.md, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: colors.border},
  replyAuthor: {color: colors.textSecondary, fontSize: typeScale.micro},
  replyBody: {color: colors.textPrimary, fontSize: typeScale.label, lineHeight: 18},
  replyLink: {color: colors.accent, fontSize: typeScale.micro, fontWeight: weight.semibold, marginTop: 4},
  replyComposer: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6},
  replyInput: {flex: 1, color: colors.textPrimary, backgroundColor: colors.surfaceHover, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4, fontSize: typeScale.label},
  replySend: {backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4},
  replySendText: {color: '#fff', fontSize: typeScale.micro, fontWeight: weight.bold},
  // ⋯ action sheet (broadcast admin gating) — two cards over a scrim, 16px radius.
  actionBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)'},
  actionWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  actionCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  reactBarCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8},
  actionRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.border},
  actionRowLast: {borderBottomWidth: 0},
  actionIcon: {fontSize: 16, width: 22, textAlign: 'center'},
  actionLabel: {fontSize: 16, color: colors.textPrimary},
  actionLabelDanger: {color: colors.danger},
  actionCancel: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  actionCancelText: {fontSize: 16, color: colors.accent, fontWeight: weight.semibold},
  // Member ⋯ menu title (Manage page) — the tapped member's display name atop the sheet's rows.
  memberMenuTitle: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted, letterSpacing: 0.6, paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  reactBtn: {alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, backgroundColor: colors.surfaceHover},
  reactText: {color: colors.textSecondary, fontSize: typeScale.micro, fontWeight: weight.semibold},
  empty: {color: colors.textMuted, fontSize: typeScale.label, textAlign: 'center', padding: space.lg},
  joinHint: {color: colors.textMuted, fontSize: typeScale.label, textAlign: 'center', padding: space.md},
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center'},
  sheet: {backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, width: '88%'},
  sheetTitle: {color: colors.textPrimary, fontSize: typeScale.subheading, fontWeight: weight.bold, marginBottom: space.md},
  sheetInput: {color: colors.textPrimary, backgroundColor: colors.surfaceHover, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: typeScale.body},
  sheetInputRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  sheetInputFlex: {flex: 1},
  pickBtn: {padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surfaceHover, alignItems: 'center', justifyContent: 'center'},
  // Contact-picker sheet (phone book) — mirrors NewMessageScreen's search + avatar/name/npub rows.
  pickSearch: {flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.surfaceHover, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, marginTop: space.md},
  pickSearchIcon: {fontSize: 13, opacity: 0.7},
  pickSearchInput: {flex: 1, color: colors.textPrimary, fontSize: typeScale.body, padding: 0},
  pickList: {maxHeight: 320, marginTop: space.sm},
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm},
  pickRowBody: {flex: 1, minWidth: 0},
  pickName: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  pickNpub: {color: colors.link, fontSize: typeScale.micro, fontFamily: 'monospace', marginTop: 1},
  pickEmpty: {color: colors.textMuted, fontSize: typeScale.label, textAlign: 'center', paddingVertical: space.lg},
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
  sheetConfirmText: {color: '#fff', fontWeight: weight.bold},
  deleteBtn: {marginTop: space.md, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.danger},
  deleteText: {color: colors.danger, fontWeight: weight.bold},
  deleteConfirm: {marginTop: space.md, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.danger},
  deleteConfirmText: {color: '#fff', fontWeight: weight.bold, fontSize: typeScale.caption, textAlign: 'center'},
  // ── SAVED · TAP TO EMBED sheet (composer 🔖 picker), parity with ChannelView ──
  savedSheetWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  savedCard: {maxHeight: '70%', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  savedHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  savedHeaderLabel: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted, letterSpacing: 0.6},
  savedHeaderCount: {fontSize: typeScale.caption, color: colors.textMuted},
  savedEmpty: {color: colors.textMuted, fontSize: typeScale.label, padding: 18, textAlign: 'center'},
  savedList: {maxHeight: 360},
  savedRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  savedRowBody: {flex: 1, minWidth: 0},
  savedRowLabel: {fontSize: 10, fontWeight: weight.bold, color: colors.accent, letterSpacing: 0.4, marginBottom: 3},
  savedRowTitle: {fontSize: typeScale.label, color: colors.textPrimary, fontWeight: weight.semibold},
  savedRowSnippet: {fontSize: typeScale.caption, color: colors.textSecondary, marginTop: 2},
  savedRemove: {fontSize: 16, color: colors.textMuted, paddingHorizontal: 6},
  savedDoneBtn: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  savedDoneText: {fontSize: 16, color: colors.accent, fontWeight: weight.semibold},
  reactorRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border},
  reactorName: {flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.body},
  reactorEmoji: {fontSize: 18},
});
