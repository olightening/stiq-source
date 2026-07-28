/**
 * MainScreen — the enrolled, unlocked app (PLAN.md §2, §3.4, §3.7).
 *
 * Tabs: Feed | Channels | Messages | Moderation Log.
 * Feed: post composer, sort/tag controls, vote on posts, tap to open thread.
 * Channels: list channels, create new channel, open channel for reading/broadcasting.
 * Messages: DM inbox and conversation view.
 */
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TAGS_STORAGE_KEY = 'stiq_selected_tags';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  SafeAreaView,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import Reanimated, {
  Easing as ReEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {useScrollChrome, JUMP_AFTER} from '../../ui/useScrollChrome';
import {useLazyModalMount} from '../../ui/useLazyModalMount';
import {TabLayer} from '../../ui/TabLayer';
import {SubScreen, useSubScreenTransition} from '../../ui/SubScreen';
import {SwipeBackView} from '../../ui/SwipeBack';
import {SwipeOptOutContext} from '../../ui/swipeOptOut';
import {BACK_PRIORITY, useBackAction} from '../../ui/back';
import {Press, PressDelayContext, SCROLL_PRESS_DELAY_MS} from '../../ui/Press';
import {BackButton} from '../../ui/BackButton';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import {relTime, relTimeShort} from '../../ui/relTime';
import {colors, space, radius, type as typeScale, fontSerif, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {paragraphAlign, rtlVerticalFix} from '../../ui/textDirection';
import {Icon} from '../../ui/icons';
import {type NostrEventSummary} from '../../ui/NostrLinkPreview';
import Clipboard from '@react-native-clipboard/clipboard';
import {isOnline, phaseAwareLabel, type ConnectionState} from '../../connection';
import type {ConnectionPhase} from '../../tor/ladder';
import {GUIDED_AUTO_LADDER, AUTHOR_NOTE_ENABLED, SCOPED_CHANNEL_SYNC} from '../../config';
import type {Feed, FeedItem} from '../../feed/feed';
import {resolveAuthorPubkey} from '../../blind/identity';
import {arrangeFeed, feedTags, DEFAULT_RANKING, type SortMode, type RankingConfig} from '../../feed/sort';
import {FeedList} from '../../feed/components/FeedList';
import {BottomDock, BOTTOM_DOCK_CLEARANCE} from '../../ui/BottomDock';
import {EmptyState} from '../../ui/EmptyState';
import {ProgressBar} from '../../ui/ProgressBar';
import {TabRailTouchContext, useTabSwipe} from '../../ui/useTabSwipe';
import {dockDefaultTab, setDockDefaultTab} from '../dockPrefs';
import {feedSortPref, setFeedSortPref} from '../feedSortPrefs';
import {firstEnteredAt, wasFirstEntry} from '../communityEntry';
import {joinedAt} from '../spaceJoinedAt';
import {isTweetLike} from '../../feed/components/PostCard';
import {RichText} from '../../feed/components/RichText';
import {DEFAULT_SPACE_RULE_SET, resolveReactionPalette} from '../../channels/spaceRules';
import {promotedFeedId} from '../../channels/promote';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {DraftsScreen} from '../../feed/components/DraftsScreen';
import {DraftAccessScreen} from '../../feed/components/DraftAccessScreen';
import {limitsFromRules} from '../../feed/editorRules';
import {searchFeed} from '../../feed/search';
import {SearchTimeButton} from '../../ui/SearchTimeButton';
import {TimeFrameSheet} from '../../ui/TimeFrameSheet';
import {ALL_TIME, filterByTime, selectionToRange, type TimeSelection} from '../../ui/timeframe';
import {ThreadView} from '../../feed/components/ThreadView';
import {CommentComposer} from '../../feed/components/CommentComposer';
import {countComments, type CommentNode} from '../../feed/thread';
import type {VoteDirection} from '../../feed/voting';
import type {Conversation} from '../../dm/conversations';
import {InboxList} from '../../dm/components/InboxList';
import {ConversationView} from '../../dm/components/ConversationView';
import type {Channel, ChannelMetadata} from '../../channels/channels';
import {ChannelView} from '../../channels/components/ChannelView';
import {ChannelPostView} from '../../channels/components/ChannelPostView';
import {ChannelDetail} from '../../channels/components/ChannelDetail';
import {CreateChannel} from '../../channels/components/CreateChannel';
import {GroupView} from '../../channels/components/GroupView';
import {parseSpaceEmbed, encodeSpaceEmbed, sanitizeBody} from '../../channels/spaceEmbed';
import {parseMsgEmbed} from '../../channels/msgEmbed';
import {parseDraftEmbed, encodeDraftEmbed, draftExcerptWouldTrim, MAX_DRAFT_EXCERPT_LEN, type DraftRef} from '../../feed/draftEmbed';
import type {DraftDeliverySnapshot} from '../../feed/draftAccess';
import {
  ensureSavedEmbedsLoaded,
  isEmbedSaved,
  listSavedEmbeds,
  removeEmbed,
  saveChannelEmbed,
  saveDraftEmbed,
  savedEmbedIsPrivate,
  savedEmbedRowLabel,
  saveMessageEmbed,
  savedEmbedUri,
  saveSpaceEmbed,
} from '../../channels/savedEmbeds';
import {EmbedReader, type EmbedReaderTarget} from '../../feed/components/EmbedReader';
import {parseEventEmbed, type EventRef} from '../../events/eventEmbed';
import {EventDetailHost} from '../../events/components/EventDetailHost';
import {EventsOrganizerHost} from '../../events/components/EventsOrganizerHost';
import type {EventsApi} from '../../events/api';
import {NewMessageScreen, type Contact} from '../../channels/components/NewMessageScreen';
import type {GroupSummary, GroupState} from '../../channels/groups';
import type {SendStatus} from '../../nostr/outbox';
import type {Event} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type {Profile} from '../../profile/profile';
import {ProfileScreen} from '../../profile/components/ProfileScreen';
import {SettingsScreen} from './SettingsScreen';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import {
  ensureReadStateLoaded,
  markSeen,
  lastSeen,
  spaceBadge,
  chSeenId,
  grpSeenId,
  dmSeenId,
} from '../../notifications/readState';
import {decodeNameHeader} from '../../profile/displayName';
import {labelInlineMedia, inlineMediaSummary} from '../../feed/inlineMedia';
import type {GradientSpec} from '../../media/gradient';
import {LogScreen, type LogPostOpenInfo} from './LogScreen';
import {LogPostView} from './LogPostView';
import {ModeratorConsole} from '../../moderation/components/ModeratorConsole';
import {ErrorBoundary} from '../ErrorBoundary';
import type {ModScope} from '../../moderation/organizerConfig';
import type {PendingReport} from '../../moderation/queue';
import type {BannedMember} from '../../moderation/bans';
import type {LoggedAuthor} from '../../moderation/advisory';
import type {PinnedCommentHistory} from '../../feed/pinned';
import {type DraftStoreApi, type Draft, newDraftId, newShareId} from '../../feed/drafts';
import {labelMetaFor, DEFAULT_LABELS, type PostLabel, type LabelConfig} from '../../feed/labels';
import {DEFAULT_POST_RULES, type PostRules} from '../../feed/postRules';
import type {PostingGuidelines} from '../../feed/postingGuidelines';
import {NotificationsScreen} from '../../notifications/NotificationsScreen';
import type {NavTarget, NotifItem} from '../../notifications/notifications';
import {DEFAULT_PREFS, type NotificationPrefs} from '../../notifications/prefs';

type Tab = 'feed' | 'channels' | 'log';

/**
 * The dock's fixed left→right order — Current · Spaces · Updates — and, because the dock row IS the
 * mental model of the app's top level, the axis a sideways swipe across the stage travels along.
 * One source of truth: the dock renders these in order and never reshuffles them, and the swipe
 * steps between neighbours here. (Routing keys, not labels — see the dock's `items` below.)
 */
const TAB_ORDER = ['feed', 'channels', 'log'] as const satisfies readonly Tab[];

/** How far (px) the incoming stage slides on a SWIPE before settling. Short on purpose: a full-width
 *  slide would need the real screen width and reads as a heavy page turn, while this much travel is
 *  enough to say "you moved that way" under the crossfade. */
const STAGE_SLIDE = 48;

// ── Generic nav-origin stack (back always means "back") ─────────────────────────
// Replaces the old single-purpose logReturnRef / profileReturnRef: ANY surface that navigates AWAY
// from where the reader was (notifications → post, profile → DM, a Log pick → channel/group, a
// mod-log entry's author-tap → profile, an embedded reference tapped while something else was open,
// …) records where to come back to. `NavOrigin` is that "where to come back to"; `NavDestination` is
// the shape used to recognise WHICH on-screen surface a stack entry belongs to (so back closing a
// DIFFERENT surface than the one that was navigated-to never misfires a restore).
//
// Named `NavDestination` rather than `NavTarget` — `NavTarget` is already imported above from
// notifications.ts for a differently-shaped (notification-routing) purpose, and the name collision
// would either shadow that import or need it renamed at every notification call site.
//
// `tabRoot` is the one origin that is a TAB rather than a surface: it is pushed when a navigation
// crosses tabs from a bare root (an embed card tapped in the Current feed that lands in a Spaces
// channel, a Log pick, a notification). Without it, closing the destination left the reader stranded
// on a tab they never chose. Restoring it is also where back's hardest rule is enforced — see the
// `tabRoot` case in restoreNavOrigin: BACK is allowed AT MOST ONE tab hop, ever. Once it lands you
// on a bare tab root, the next press leaves the app; it never chains tab → tab → tab.
type NavOrigin =
  | {kind: 'notifications'}
  | {kind: 'profile'; pubkey: string; tab: Tab}
  | {kind: 'modConsole'}
  | {kind: 'tabRoot'; tab: Tab}
  | {kind: 'logPost'; info: LogPostOpenInfo; entryKey: string | null}
  | {kind: 'group'; groupId: string}
  | {kind: 'channel'; channelId: string}
  | {kind: 'post'; postId: string}
  // `tab` is OPTIONAL here, unlike on `profile`, because the DM overlay floats over any tab: most
  // pushes (a profile's Message button, a notification) open it without changing tabs, and those
  // must not force one on the way back. It is set only where the navigation AWAY from the DM
  // crossed tabs — otherwise closing the restored DM drops the reader on the destination's tab
  // rather than the one they started on, which is the same stranding `tabRoot` exists to prevent.
  | {kind: 'dm'; peer: string; tab?: Tab}
  | {kind: 'event'; coordinate: string};

type NavDestination =
  | {kind: 'notifications'}
  | {kind: 'profile'; pubkey: string}
  | {kind: 'channel'; channelId: string}
  | {kind: 'group'; groupId: string}
  | {kind: 'post'; postId: string}
  | {kind: 'dm'; peer: string}
  | {kind: 'channelPost'; postId: string}
  | {kind: 'event'; coordinate: string}
  // Phase 5§G notification targets (notifications.ts) — no dedicated "return to X on close" wiring
  // exists for these yet (that's the Phase 5§F Manage-access queue UI, a separate pass), so these
  // exist only to keep notifTargetToDestination/navDestinationsEqual exhaustive; a pushed origin of
  // either kind is simply never popped today.
  | {kind: 'draftReader'; draftId: string}
  | {kind: 'draftRequests'; draftId: string};

/** Structural equality for two `NavDestination`s — same kind AND same identifying field. */
function navDestinationsEqual(a: NavDestination, b: NavDestination): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'notifications': return true;
    case 'profile': return a.pubkey === (b as {pubkey: string}).pubkey;
    case 'channel': return a.channelId === (b as {channelId: string}).channelId;
    case 'group': return a.groupId === (b as {groupId: string}).groupId;
    case 'post': return a.postId === (b as {postId: string}).postId;
    case 'dm': return a.peer === (b as {peer: string}).peer;
    case 'channelPost': return a.postId === (b as {postId: string}).postId;
    case 'event': return a.coordinate === (b as {coordinate: string}).coordinate;
    case 'draftReader': return a.draftId === (b as {draftId: string}).draftId;
    case 'draftRequests': return a.draftId === (b as {draftId: string}).draftId;
  }
}

/**
 * Resolve a channel's own 30311 metadata by coordinate when `channels` doesn't hold it yet —
 * purely for VIEWING (a tap must never silently mutate the user's subscriptions/auto-follow).
 * Reuses the same naddr filter-fetch path getEvent() already runs for an unresolved embed
 * (AppRuntime.fetchNaddr, de-duped per coordinate) rather than adding new plumbing. Shared by
 * every entry point that can hand `openChannelId` a coordinate not yet in `channels`
 * (openEmbedTarget's spaceRef branch, a profile's "message channel" link, a resumed channel
 * draft) so none of them leave the "Opening channel…" placeholder with nothing ever requesting
 * the metadata (incidental finding: those call sites used to set openChannelId with no fallback
 * at all, worse than a Tor-timing-dependent hang — a GUARANTEED one).
 */
function fetchChannelIfUnknown(
  channelId: string,
  channels: readonly {id: string}[],
  onGetEvent?: (ref: string) => NostrEventSummary | null,
): void {
  if (channels.some(c => c.id === channelId)) return;
  // coord = 30311:<owner>:<d> (see channels.ts channelCoord) — owner is a fixed-length hex
  // pubkey, so parts[1] is always the owner even if the identifier itself contains a colon.
  const parts = channelId.split(':');
  const owner = parts[1];
  const identifier = parts.slice(2).join(':');
  if (!owner || !identifier) return;
  try {
    const naddr = nip19.naddrEncode({kind: 30311, pubkey: owner, identifier});
    onGetEvent?.(naddr);
  } catch {
    /* malformed coordinate — nothing to fetch */
  }
}

const NAV_STACK_DEPTH = 5;

export interface MainScreenProps {
  feed: Feed;
  /**
   * Scoped invalidation counters (bug #6) — `feed`'s identity deliberately never changes for
   * channel/group-only writes (LiveChat/LiveActivity/GroupChat are excluded from the feed cache), so
   * memos that read channel/group/identity data key on these instead. See AppSnapshot.storeVersions.
   */
  storeVersions?: {channels: number; groups: number; identity: number; thread?: number; config?: number; draftAccess?: number};
  inbox: Conversation[];
  channels: Channel[];
  currentUserPubkey: string | null;
  isModerator: boolean;
  /** The current user's organizer-granted moderator scopes (gates console actions). */
  modScopes?: readonly ModScope[];
  /** Member reports awaiting moderator review (moderator console). */
  onGetPendingReports?: () => PendingReport[];
  /** Currently-banned members (moderator console). */
  onGetBannedMembers?: () => BannedMember[];
  /** Authors under a standing advisory rule — their posts render in the mod log (moderator console). */
  onGetLoggedAuthors?: () => LoggedAuthor[];
  /** Lift a ban on a user (moderator console). */
  onModeratorUnban?: (pubkey: string) => void;
  /** Advisory: send an author to the mod log (standing rule); `includePast` also pulls past posts. */
  onModeratorLogAuthor?: (pubkey: string, includePast: boolean) => void;
  /** Advisory: reverse a standing rule — the author's posts return to the feed. */
  onModeratorRestoreAuthor?: (pubkey: string) => void;
  /** Advisory: send a single post/comment to the mod log (reversible). */
  onModeratorLogPost?: (eventId: string, authorPubkey?: string) => void;
  /** Per-action moderator rate-limit pre-check (null = free to act). */
  onCheckModLimit?: (action: string) => string | null;
  sendStatus: ReadonlyMap<string, SendStatus>;
  /** Per-event relay rejection reason (only rejected ids) — shown next to "failed". */
  sendReasons?: ReadonlyMap<string, string>;
  /** Ids whose 'sending' status is a pre-connect queue (relay/Tor not up yet) rather than an active
   *  in-flight publish — drives "Queued — connecting…" vs "Sending…" on a post's send indicator (M7). */
  sendQueuedOffline?: ReadonlySet<string>;
  /** True while a relay sync round is in progress — shows a quiet "Syncing…" pill by the wordmark,
   *  so the widened 1 Hz emit cadence during a backlog reads as intentional, not laggy (M7). */
  syncing?: boolean;
  connection: ConnectionState;
  /** Live Tor bootstrap progress (real percent), so the offline banner can show forward progress. */
  torBootstrap?: import('../../tor/types').BootstrapProgress | null;
  /**
   * Guided-ladder plain-language phase (T2, GUIDED_AUTO_LADDER). When the auto-fallback ladder is
   * on, App.tsx passes the live {@link ConnectionPhase} so the offline banner narrates the real rung
   * ("Trying obfs4 bridges…") instead of the generic state label. Null when the flag is off — the
   * banner then reads exactly as today (connectionLabel with the bootstrap percent).
   */
  torPhase?: ConnectionPhase | null;
  onUserActivity?: () => void;
  /** M5: feed list drag/fling start-stop (AppRuntime.setScrolling) — parks deferred relay-driven
   *  re-renders for the duration so a sync burst can't jump the list under the user's finger. */
  onSetScrolling?: (scrolling: boolean) => void;
  onRetry?: (eventId: string) => void;
  onCancelSend?: (eventId: string) => void;
  onSubmit: (content: string, tags: string[], title?: string, label?: PostLabel, contentWarning?: string) => void;
  /** No.5: promote a channel post into a feed thread (publishes a feed post + marks the channel message). */
  onPromoteChannelPost?: (message: Event, content: string, tags: string[], title?: string, label?: PostLabel, contentWarning?: string) => void;
  onSendDm: (peer: string, text: string, replyTo?: string) => void;
  /** React to a DM message (by its shared rumor id) with an emoji. */
  onReactDm?: (peer: string, targetRumorId: string, emoji: string) => void;
  /** Retry a failed ('✕') DM by its echo id. */
  onRetryDm?: (peer: string, echoId: string) => void;
  onVote: (postId: string, authorPubkey: string, direction: VoteDirection) => void;
  /** Create a channel; returns its coordinate so the create flow can navigate straight into it. */
  onCreateChannel: (meta: ChannelMetadata) => Promise<string | null> | void;
  /** Resolves false (never rejects) on a failed send — ChannelView's composer awaits it to restore
   *  a failed draft rather than silently discarding it. */
  onPostToChannel: (channelId: string, content: string) => Promise<boolean> | void;
  /** Author: edit one of your broadcasts in place (position-preserving). Same resolves-false shape. */
  onEditChannelMessage?: (channelId: string, originalId: string, content: string) => Promise<boolean> | void;
  /** Owner: edit a channel's metadata (name/about/gradient). */
  onEditChannel?: (channelId: string, meta: ChannelMetadata) => void;
  onDeleteChannel?: (channelId: string) => void;
  /** Owner: pin/unpin a broadcast (null unpins) — surfaces in the channel's PINNED bar. */
  onSetChannelPinned?: (channelId: string, messageId: string | null) => void;
  /** Owner: open/close comments & reactions on a channel broadcast message. */
  onSetChannelInteractions?: (messageId: string, perm: import('../../channels/interactions').PostInteractions) => void;
  /** React to a channel broadcast message with one of the channel's configured emojis. */
  onReactToChannelMessage?: (messageId: string, messagePubkey: string, emoji: string) => void;
  /** All kind-7 reactions bucketed by target message id, for per-broadcast emoji tallies. */
  onGetReactionsByTarget?: () => Map<string, Event[]>;
  /** Read the interaction state (comments/reactions) of a channel broadcast message. */
  getChannelMessageInteractions?: (channelId: string, messageId: string) => import('../../channels/interactions').PostInteractions;
  /** Whether the organizer allows NIP-A0 voice messages (gates the mic button). */
  allowVoice?: boolean;
  /** Organizer picture limits (gates + enforces the "Add picture" option build-wide). */
  pictureRules?: import('../../feed/pictureRules').PictureRules;
  /** Picture token bytes the member has spent this period (allowance gate). */
  picturesSpentBytes?: number;
  /** Channel ids the user subscribes to (NIP-51). */
  subscribedChannelIds?: string[];
  onSubscribeChannel?: (channelId: string) => void;
  onUnsubscribeChannel?: (channelId: string) => void;
  onGetThread: (postId: string) => CommentNode[];
  /**
   * Stable React list key for an event id (AppRuntime.stableListKey): the `local-…` placeholder id
   * an optimistic write rendered under, carried across the placeholder→real-id swap. Threaded to
   * every message list (thread comments, channel broadcasts, group chat) so a just-sent row never
   * unmounts/remounts when its id swaps (Phase 3.2). Omitted → lists key on raw event ids.
   */
  listKeyFor?: (id: string) => string;
  /**
   * Has the scoped sub `channel:<id>` / `group:<id>` settled its stored-history replay this
   * session (EOSE or CLOSED)? Phase 5 stale-first: until it settles, an empty message list means
   * "still loading over Tor", so ChannelView/GroupView suppress their "No broadcasts/messages
   * yet." empty states instead of flashing a false claim. Omitted → empty states show as before.
   */
  onIsSpaceSynced?: (subKey: string) => boolean;
  onGetChannelMessages: (channelId: string) => Event[];
  onComment?: (content: string, rootId: string, rootPubkey: string, rootKind: number, parentId: string, parentPubkey: string, parentKind: number) => void;
  onSetPinnedComment?: (postId: string, postAuthorPubkey: string, postKind: number, content: string) => void;
  onGetProfile?: (pubkey: string) => Profile;
  /** The Events surface's one runtime seam (detail overlay + organizer flow; events/api.ts). */
  events?: EventsApi;
  /** Look up a learned display name for a peer's hex pubkey (federation notifications path). */
  onGetDisplayName?: (pubkey: string) => string | undefined;
  onGetPinnedHistory?: (postId: string, postAuthor: string) => PinnedCommentHistory;
  /** The Log tab's organizer-controlled hearth (kind-30078 stiq:log-page, resolved live). */
  onGetLogPage?: () => import('../../channels/logPage').LogHearthData | null;
  onGetModLog?: () => import('../../moderation/modlog').ModLogEntry[];
  /** Resolve the original post + thread behind a mod-log entry (for the Log's full-post view). */
  onGetLogPost?: (targetId: string) => {item: import('../../feed/feed').FeedItem | null; thread: CommentNode[]};
  /** Resolve any post id to a FeedItem straight from the store (incl. auto-hidden / logged posts),
   *  so a saved log post can appear in the embed picker even though it's not in the visible feed. */
  onGetPostItem?: (id: string) => FeedItem | null;
  /** The shared attribution resolver (profile/resolveDisplayIdentity.ts), by event id — attestation
   *  first, then the learned phonebook, then npub+seed. The ONE source every attribution surface
   *  (post-detail header, comments, LogPostView) should read through so a post can never render
   *  anonymous while a comment by the same member, resolved another way, shows their name. */
  onResolveIdentity?: (id: string) => {name?: string; gradient?: GradientSpec} | null;
  /** Moderator action on a feed post (hide it, or hide its author globally). */
  onModeratePost?: (postId: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  /** Block / unblock a DM peer LOCALLY (device-only; nothing published to the relay), and query the
   *  effective block state (local decision layered over any moderator removal). */
  onBlockUser?: (pubkey: string) => void;
  onUnblockUser?: (pubkey: string) => void;
  isUserBlocked?: (pubkey: string) => boolean;
  /** Channel-owner action: hide a message/comment within the owner's own channel. */
  onChannelOwnerHide?: (targetId: string, authorPubkey?: string) => void;
  /** Moderator: restore a hidden post/comment, or unhide a user, from the mod log. */
  onModerationRestore?: (
    targetId: string,
    targetType: import('../../moderation/modlog').ModTargetType,
    authorPubkey?: string,
  ) => void;
  draftStore?: DraftStoreApi;
  // ── Draft access control (Phase 5§D/E) — mirror the like-named AppRuntime methods 1:1; forwarded
  // straight through to EmbedReader, which is the sole consumer. See feed/draftAccess.ts's module
  // doc for the request → approve → deliver model these read/drive.
  onGetDraftAccessState?: (draftId: string) => Promise<'owner' | 'none' | 'pending' | 'approved'>;
  onGetMyDraftDelivery?: (draftId: string, ownerPubkey?: string) => Promise<DraftDeliverySnapshot | null>;
  onRequestDraftAccess?: (draftId: string, ownerPubkey: string) => Promise<void>;
  /** A draft's synthetic comment thread (Phase 7§A), keyed by its stable `shareId`. */
  onGetDraftThread?: (shareId: string) => CommentNode[];
  onGetDraftCommentCount?: (shareId: string) => number;
  // ── Owner-side "Manage access" (Phase 5§F) — mirrors the like-named AppRuntime methods 1:1;
  // forwarded straight through to DraftAccessScreen, the sole consumer.
  onGetDraftAccessQueue?: (draftId: string) => {pubkey: string; reqId: string; at: number; name?: string}[];
  onGetDraftAccessGranted?: (draftId: string) => {pubkey: string; at: number; name?: string}[];
  onApproveDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onDenyDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onRevokeDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onSetDisplayName?: (name: string) => void;
  /** Set or change the viewer's identity gradient. */
  onSetGradient?: (spec: import('../../media/gradient').GradientSpec) => void;
  /** The viewer's crafted gradient, read straight off the runtime's identity store. Authoritative
   *  the moment a Profile save lands — unlike the feed-item fallback below, which goes stale for a
   *  viewer with no visible self-authored items (the "edited my gradient, header never changed"
   *  field bug). */
  myCraftedGradient?: import('../../media/gradient').GradientSpec;
  /** Look up a single cached event for Nostr link preview / reference embed cards. */
  onGetEvent?: (id: string) => NostrEventSummary | null;
  /** Aggregate reaction score + the viewer's vote for an event (drives the ✦ like on comments). */
  onGetEventScore?: (id: string) => {score: number; myVote: VoteDirection | null};
  /** Thread of kind-1111 comments under a channel broadcast message. */
  onGetChannelThread?: (messageId: string) => import('../../feed/thread').CommentNode[];
  /** Post a signed comment on a channel broadcast message. */
  onPostChannelComment?: (messageId: string, messagePubkey: string, messageKind: number, content: string) => void;
  /** Whether the PIN lock screen is currently enabled. */
  pinEnabled?: boolean;
  /** Toggle the PIN lock screen on/off. */
  onSetPinEnabled?: (enabled: boolean) => void;
  /** Verify that a PIN string matches the standard slot. */
  onVerifyPin?: (pin: string) => Promise<boolean>;
  /** Emergency wipe — destroys all local data. */
  onWipe?: () => void;
  /** Load the list of enrolled communities for the Settings community switcher. */
  onLoadCommunities?: () => Promise<{list: import('../../communities/communityStore').EnrolledCommunity[]; activeId: string | null}>;
  /** Switch the active community (triggers relay reconnect). */
  onSwitchCommunity?: (id: string) => void;
  /** Leave a community — wipes its identity + cached data on-device (irreversible). */
  onRemoveCommunity?: (id: string) => void;
  /** Start onboarding in ADD mode to join ANOTHER community (additive). */
  onJoinAnotherCommunity?: () => void;
  /** Load the multi-identity key ring for the Settings identity switcher. */
  onLoadKeySlots?: () => Promise<{slots: import('../../keys/keyRing').KeySlot[]; activeId: string | null}>;
  /** Switch the active identity by key-ring slot id. */
  onSwitchIdentity?: (slotId: string) => void;
  /** Leave a single identity (key-ring slot) — wipes that identity (drops the community only when
   *  it was the last identity in it). */
  onRemoveIdentity?: (slotId: string) => void;
  /** Start onboarding to add a new identity. */
  onAddIdentity?: () => void;
  /** Read the user's configured Blossom upload endpoint ('' = disabled). */
  onGetBlossomEndpoint?: () => string;
  /** Persist a new Blossom upload endpoint. */
  onSetBlossomEndpoint?: (url: string) => void;
  /** Read the user's preferred external browser launch id ('' = none chosen). */
  onGetPreferredBrowser?: () => string;
  /** Persist the preferred external browser (package/scheme id; '' clears it). */
  onSetPreferredBrowser?: (id: string) => void;
  /** List installed browsers (for the Settings picker). */
  onListBrowsers?: () => Promise<import('../../browser/browserData').InstalledBrowser[]>;
  /** Clear the rendered-media cache (decoded pictures + Tor-fetched images). */
  onClearMediaCache?: () => void;
  /** Quick action: clear cached feed events older than the default window. */
  onClearEventCache?: () => void;
  /** Preview count of cached deletable events older than `olderThanSeconds` (all ages when omitted). */
  onCountCachedEvents?: (olderThanSeconds?: number) => number;
  /** Fine-grained delete: purge the selected type(s) of cached data within the chosen date range.
   *  Returns the actual counts removed. */
  onDeleteCachedData?: (opts: {media: boolean; events: boolean; olderThanSeconds?: number}) => {events: number; media: number};
  /** Read the user's Tor connection preferences (mode + advanced). */
  onGetConnectionPrefs?: () => import('../../tor/torSettings').TorConnectionPrefs;
  /** Persist new Tor connection prefs AND reconnect under them. */
  onApplyConnectionPrefs?: (prefs: import('../../tor/torSettings').TorConnectionPrefs) => void;
  /** Relays management (Settings → Relays) — forwarded to SettingsScreen. */
  onGetRelaySnapshot?: () => import('../../communities/communityStore').RelaysSnapshot | null;
  onAddRelay?: (url: string, onionAuthKey: string | null) => Promise<void>;
  onRemoveRelay?: (host: string) => Promise<void>;
  onMuteRelay?: (spec: {url: string; onionAuthKey?: string | null}) => Promise<void>;
  onUnmuteRelay?: (host: string) => Promise<void>;
  /** T9 (APK_UPDATES): whether signed in-app updates are enabled AND the active community ships a
   *  signed repo. Forwarded to SettingsScreen, which hides its "App updates" section when false. */
  apkUpdatesEnabled?: boolean;
  /** Fetch+verify the community's signed F-Droid index over Tor; resolves an offer or null. */
  onCheckForUpdate?: () => Promise<import('../../update/updater').UpdateInfo | null>;
  /** Download the offered APK over Tor, verify its signer/version, and launch the OS install prompt. */
  onInstallUpdate?: (info: import('../../update/updater').UpdateInfo) => Promise<void>;
  /** Token/economy status (T5.1/F18) — forwarded to the `__DEV__`-gated Settings → Diagnostics →
   *  Token status screen. See AppRuntime.ts's AppSnapshot.tokenStatus doc. */
  tokenStatus?: import('../tokenEconomyStatus').TokenEconomyStatus;
  /** Force-refresh the per-purpose wallet counts backing tokenStatus (an async SecureStorage read). */
  onRefreshTokenStatus?: () => void;
  /** Active community's tag policy (organizer-defined). */
  tagPolicy?: import('../../feed/tagPolicy').TagPolicy;
  /** Organizer-defined post labels (composer picker + feed/detail chips). */
  labels?: LabelConfig;
  /** Organizer-defined per-post-type rules (composer guardrail). */
  postRules?: PostRules;
  /** Organizer posting guidelines (composer rules banner + covenant sheet); null/absent = none. */
  postingGuidelines?: PostingGuidelines | null;
  /** The active community's display name, for the composer byline ("Posting to <b>{name}</b>"). */
  communityName?: string | null;
  /** The active community id — a change means a community switch; a fresh join lands on Updates. */
  communityCid?: string | null;
  /** Organizer-tuned Rising ranking parameters (feed "Rising" sort). */
  ranking?: RankingConfig;

  // ── NIP-29 managed groups ──
  /** Groups the user is a member of (from cached relay state). */
  groups?: GroupSummary[];
  /** Whether the relay supports NIP-29 (shows the "Managed group" create option). */
  relaySupportsNip29?: boolean;
  /** Create a NIP-29 group/private channel; returns its group id for optimistic navigation. */
  onCreateGroup?: (meta: ChannelMetadata, closed?: boolean, isPrivate?: boolean, broadcast?: boolean) => Promise<string | null> | void;
  onJoinGroup?: (groupId: string) => void;
  /** Accept a `stiq://channel/<id>` invite link tapped as an embed card in a message body (in-app join). */
  onAcceptInviteLink?: (url: string) => void;
  onLeaveGroup?: (groupId: string) => void;
  onKickGroupMember?: (groupId: string, pubkey: string) => void;
  /** Role changes on existing members (promote/demote); direct adds are gone — invites only. */
  onAddGroupMember?: (groupId: string, pubkey: string, asAdmin: boolean) => void;
  /** Admin action: edit a group's name/about/access (kind 9002). */
  onEditGroup?: (groupId: string, meta: import('../../channels/groups').GroupMeta) => void;
  /** Read a space's settings doc (rules + reactions/pinned) — used for group pinned + rules. */
  onGetSpaceSettings?: (
    spaceId: string,
    kind: 'channel' | 'group',
  ) => {settings: import('../../channels/spaceRules').SpaceSettings; at: number} | null;
  /** Admin: publish a space's settings doc (rules + reactions/pinned). */
  onSetSpaceSettings?: (spaceId: string, settings: import('../../channels/spaceRules').SpaceSettings) => void;
  /** Owner-only: a group's current log offer (the community log picker's consent gate), or null. */
  onGetLogOffer?: (groupId: string) => import('../../channels/logOffer').LogOffer | null;
  /** Owner action: publish a live log offer for a group (built from its current name/gradient/flags). */
  onSetLogOffer?: (groupId: string) => void;
  /** Owner action: revoke a group's log offer. */
  onRevokeLogOffer?: (groupId: string) => void;
  /** Admin: approve / deny a pending join request. */
  onApproveJoin?: (groupId: string, pubkey: string) => void;
  onDenyJoin?: (groupId: string, pubkey: string) => void;

  // ── Membership handoff (locked preview / review queue / accept-first invites) ──
  /** Request to join a private space, with the optional sealed intro note. */
  onRequestToJoin?: (groupId: string, note?: string) => void;
  /** Withdraw an outstanding join request (back to 'none'; relay Pending entry cleared). */
  onWithdrawJoinRequest?: (groupId: string) => void;
  /** The viewer's relationship to a space ('member' | 'pending' | 'none'). Decline is invisible. */
  onGetJoinState?: (groupId: string) => 'member' | 'pending' | 'none';
  /** Fire the one-shot 39000/39001/39002 fetch that hydrates a locked preview. */
  onPreviewSpace?: (groupId: string) => void;
  /** Cached locked-preview data (name/about/kind/counts/gradient), or null until fetched. */
  onGetSpacePreview?: (groupId: string) => {
    name: string;
    about?: string;
    kindWord: 'Private channel' | 'Group chat';
    memberCount: number;
    adminCount: number;
    gradient?: GradientSpec;
  } | null;
  /** Admin review queue: pending pubkeys joined with their unsealed intro notes. */
  onGetJoinRequestQueue?: (groupId: string) => {
    pubkey: string;
    at?: number;
    name?: string;
    note?: string;
    invited: boolean;
  }[];
  /** Outcome of the most recent approve/deny publish for a pending pubkey — see
   *  AppRuntime.getRosterActionStatus's doc. */
  onGetRosterActionStatus?: (groupId: string, pubkey: string) => {status?: SendStatus; reason?: string} | undefined;
  /** Send accept-first invites (DM frame + shared invited-set doc) — never a direct add. */
  onInvitePeople?: (groupId: string, pubkeys: string[]) => void;
  /** Revoke an outstanding invite (any admin may revoke any inviter's). */
  onRevokeInvite?: (groupId: string, pubkey: string) => void;
  /** The space's folded outstanding-invite set (the Invited strip). */
  onGetInvited?: (groupId: string) => {p: string; by: string; at: number}[];
  /** Incoming invitation cards for the top of the Channels inbox. */
  spaceInvites?: import('../AppRuntime').IncomingSpaceInvite[];
  /** Spaces the viewer asked to join (accepted invite or manual request) but isn't a MEMBER of yet.
   *  No longer rendered here (the "Joining…" row was removed) — kept on the prop surface because
   *  the pending state still drives the space-embed CTA elsewhere. */
  joiningSpaces?: import('../AppRuntime').JoiningSpace[];
  /** Accept an incoming invite (consent moment — membership only lands on the admin's approve). */
  onAcceptSpaceInvite?: (groupId: string) => void;
  /** "Not now" — local dismissal; the space is never told. */
  onDismissSpaceInvite?: (groupId: string) => void;
  /** Owner: delete the group / transfer ownership. */
  onDeleteGroup?: (groupId: string) => void;
  onTransferGroupOwner?: (groupId: string, pubkey: string) => void;
  /** Admin: open/close comments & reactions on a broadcast-group post. */
  onSetGroupInteractions?: (groupId: string, messageId: string, perm: import('../../channels/interactions').PostInteractions) => void;
  /** React to a private/broadcast-channel post with a specific emoji. */
  onReactToGroupMessage?: (groupId: string, messageId: string, messagePubkey: string, emoji?: string) => void;
  /** Read the interaction state (comments/reactions) of a broadcast-group post. */
  getGroupPostInteractions?: (groupId: string, messageId: string) => import('../../channels/interactions').PostInteractions;
  /** Resolves false (never rejects) on a failed send — GroupView's composer awaits it to restore a
   *  failed draft + reply target rather than silently discarding them. */
  onPostToGroup?: (groupId: string, content: string, replyTo?: string) => Promise<boolean> | void;
  /** Author edit of one of your private/broadcast-channel posts (position-preserving). Same
   *  resolves-false shape. */
  onEditGroupMessage?: (groupId: string, messageId: string, content: string) => Promise<boolean> | void;
  /** Post a threaded reply (kind 12) to a parent message. */
  onReplyToGroup?: (groupId: string, parentId: string, content: string) => void;
  /** Whether GROUP's outgoing sends are blocked for lack of a space key (drives GroupView's
   *  "Unlocking this space…" composer banner). */
  onIsSpaceKeyMissing?: (groupId: string) => boolean;
  onGetGroupState?: (groupId: string) => GroupState | null;
  onGetGroupMembers?: (groupId: string) => string[];
  onGetGroupAdmins?: (groupId: string) => string[];
  onGetGroupPending?: (groupId: string) => string[];
  onGetGroupMessages?: (groupId: string) => Event[];
  onGetGroupReplies?: (groupId: string) => Map<string, Event[]>;
  /** Open/close the group-scoped relay subscription as the group view mounts/unmounts. */
  onOpenGroup?: (groupId: string) => void;
  onCloseGroup?: (groupId: string) => void;
  /**
   * Open/close the channel-scoped relay subscription as the channel view mounts/unmounts — the exact
   * twin of onOpenGroup/onCloseGroup (bug 8; config's SCOPED_CHANNEL_SYNC). Undefined and inert while
   * the flag is off, when kind-1311 rides the firehose and no per-view sub is needed.
   */
  onOpenChannel?: (channelId: string) => void;
  onCloseChannel?: (channelId: string) => void;
  /** NIP-51 kind-10003 bookmarked post ids. */
  bookmarkedPostIds?: readonly string[];
  /** Toggle bookmark state for a post (adds if not bookmarked, removes if already bookmarked). */
  onToggleBookmark?: (postId: string) => void;
  /** Submit a user report (kind-1984) for a post to the relay/organizers. Shows reason prompt. */
  onReportPost?: (postId: string, authorPubkey: string) => void;
  /** Mute an author locally (device-only; filters their content, publishes nothing). */
  onMuteAuthor?: (authorPubkey: string) => void;
  /** Spend a read-token to unlock a locked post's content epoch (C7 content-encryption meter; ships
   *  dark — no feed item is ever locked until content encryption is live). */
  onUnlockContent?: (epoch: number) => void;
  /** Moderator: lock/unlock a thread (no new comments while locked). */
  onModeratorLock?: (postId: string, authorPubkey: string, lock: boolean) => void;
  /** Moderator: re-tag a post's type label. */
  onModeratorRetag?: (postId: string, authorPubkey: string, label: PostLabel) => void;
  /** Moderator: pin/unpin a post to the top of the feed. */
  onModeratorPin?: (postId: string, authorPubkey: string, pin: boolean) => void;
  /** Post ids a moderator has locked (their comment composer is closed). */
  lockedPostIds?: readonly string[];
  /** Post ids a moderator has pinned to the top of the feed. */
  pinnedPostIds?: readonly string[];
  /** Pull-to-refresh: re-run the NIP-77 feed reconciliation against the relay. Resolves when done. */
  onRefreshFeed?: () => Promise<void>;
  /**
   * Count of feed items newer than the reader's last {@link onMarkFeedSeen} mark — the "N new
   * posts" pill (AppRuntime.markFeedSeen/AppSnapshot.newFeedItemCount's doc has the full contract).
   * Surfaced on the feed's existing return-to-top bubble (BottomDock's `jump.count`) rather than a
   * new floating element. Defaults to 0 so a caller that hasn't wired this yet renders identically
   * to before this prop existed.
   */
  newFeedItemCount?: number;
  /**
   * Advance the "seen" baseline the pill counts forward from. Called by MainScreen itself (never
   * by a caller) at the moments AppRuntime.markFeedSeen's doc calls out: the feed tab first showing
   * real content, the reader scrolling back to the top, and an explicit pill tap. Omitted in tests
   * that don't care about the pill — every call site below is optional-chained.
   */
  onMarkFeedSeen?: () => void;
  /** Scroll-back pagination (bug #3): stream in older feed history from the relay past the cached slice. */
  onLoadOlderFeed?: (until: number) => void;
  /** Scroll-back pagination for an open channel — fires past the locally-cached message history. */
  onLoadOlderChannelPage?: (channelId: string, until: number) => void;
  /** Scroll-back pagination for an open group — fires past the locally-cached message history. */
  onLoadOlderGroupPage?: (groupId: string, until: number) => void;

  // ── Notifications (bell + tap navigation) ──
  /** A tap-through navigation target queued by the notification layer (cold-start / background tap),
   *  or null when nothing is pending. Mirrors the incomingJoinCode/onJoinCodeConsumed handoff. */
  pendingNav?: NavTarget | null;
  /** Acknowledges pendingNav has been consumed so it isn't re-applied on the next render. */
  onPendingNavHandled?: () => void;
  /** Count of unread derived notifications — the number on the bell's badge (0 = no badge). */
  notifUnreadCount?: number;
  /** Live-derived notification list, built fresh from cached data on demand (no persisted log). */
  onGetNotifications?: () => NotifItem[];
  onGetNotificationPrefs?: () => NotificationPrefs;
  onSetNotificationPrefs?: (prefs: NotificationPrefs) => void;
  /** Mark one notification read (center row tap) — persists + drops the badge count. */
  onMarkNotificationRead?: (id: string) => void;
  /** Mark every notification read (center ✓✓) — persists + clears the badge. */
  onMarkAllNotificationsRead?: () => void;
}

/**
 * Adapts a write handler's `Promise<boolean> | void` result (runWrite's shape in App.tsx — resolves
 * `false` rather than rejecting, so the many fire-and-forget `runWrite(...)` call sites never see an
 * unhandled rejection) to the `Promise<void> | void` shape GroupView/ChannelView's composers expect,
 * where a REJECTION is the signal their `sendText` restores a failed draft on.
 */
function toVoidPromise(p: Promise<boolean> | void): Promise<void> | void {
  if (!p) return undefined;
  return p.then(ok => { if (!ok) throw new Error('SEND_FAILED'); });
}

/**
 * The feed HOLD (instant-refresh Gap 1) — buffer arrivals, don't inject them.
 *
 * Given `held` (the feed order captured the last time the reader was inside the top band) and `live`
 * (the order right now), returns what the list should render while the reader sits still, scrolled
 * away. Freezes the reader's *page* — which rows, in which order — while letting each row's CONTENT
 * flow through live. Splicing a row in, or out, is what shifts everything below it; changing what a
 * row SAYS does not.
 *
 * Three things are never held, because none of them can move a row the reader is looking at:
 *
 *  - **The reader's own new post.** The urgent path. It is the only kind of item that carries
 *    `sortAt` (AppRuntime._ownPostOrder's local publish-order key — see feedItemKey), so it needs no
 *    new plumbing to recognise, and it goes to the FRONT where the author expects to find it.
 *  - **Older history.** That is what `onLoadOlderFeed` streams in. Appending below the last held row
 *    shifts nothing above it, so "Load more" keeps working while held instead of silently returning
 *    nothing. "Older" is decided TWO ways, and it needs both: live places it past the held tail, OR
 *    it is no newer than the oldest held row. The positional test alone is not enough — it silently
 *    assumes the live order is chronological, which is only true under `sort: 'new'`. Under the
 *    app's persisted default 'hot' (and under Rising), rank comes from vote/comment velocity and
 *    all-time score, so a backfilled month-old post can legitimately out-rank a decaying held row
 *    and land ABOVE the tail. Such an item used to match neither branch and was therefore DROPPED,
 *    not deferred: `displayArranged` never grew, `hasMoreFeed` stayed false, the "Load more" footer
 *    never came back, and every further scroll to the bottom fired another `onLoadOlderFeed` for
 *    ever-older history that the list could never show. `createdAt` is the sort-independent test,
 *    and it is exactly the axis `loadMore` requests on (`until: oldest`), so it catches precisely
 *    what a backfill can return. A non-backfill arrival that happens to be older than the whole
 *    held page appends too — harmless, since appending below the tail moves nothing either way.
 *  - **A row's own contents.** buildFeed hands back identity-stable FeedItem objects (feed.ts's
 *    `_itemCache` reuses the same reference until a post's rendered inputs actually change), so a
 *    background arrival leaves every held row `===` what it was and this returns the very SAME array
 *    reference — no reflow, no cell re-render, FlatList skips the update entirely. The reader's own
 *    vote rebuilds exactly one item, so that one card updates in place with nothing moving.
 *
 * A held row that has VANISHED from `live` (muted, hidden, evicted) keeps its last-known object
 * rather than being dropped: splicing it out reflows exactly as visibly as splicing one in, and the
 * removal lands the moment the hold releases.
 */
export function holdFeedComposition(held: readonly FeedItem[], live: readonly FeedItem[]): FeedItem[] {
  // A feed that has gone empty is a replacement (community switch, cache wipe), not an arrival to
  // buffer — there is no page left to protect, so hold nothing.
  if (live.length === 0) return live as FeedItem[];
  const liveById = new Map<string, FeedItem>();
  const liveIndex = new Map<string, number>();
  live.forEach((it, i) => { liveById.set(it.id, it); liveIndex.set(it.id, i); });
  const heldIds = new Set<string>();
  let tailIndex = -1;
  // The held page's chronological floor. Anything at or below it is history, wherever the active
  // sort ranks it. Infinity when nothing is held, which keeps the empty-held case appending
  // everything exactly as the positional test already did.
  let heldOldest = Number.POSITIVE_INFINITY;
  for (const it of held) {
    heldIds.add(it.id);
    if (it.createdAt < heldOldest) heldOldest = it.createdAt;
    const i = liveIndex.get(it.id);
    if (i !== undefined && i > tailIndex) tailIndex = i;
  }
  let contentChanged = false;
  const rows = held.map(it => {
    const fresh = liveById.get(it.id);
    if (fresh !== undefined && fresh !== it) contentChanged = true;
    return fresh ?? it;
  });
  const ownNew: FeedItem[] = [];
  const olderTail: FeedItem[] = [];
  live.forEach((it, i) => {
    if (heldIds.has(it.id)) return;
    if (it.sortAt !== undefined) ownNew.push(it);
    // `<=` because loadMore requests `until: oldest` and nostr's `until` is inclusive, so a page of
    // backfill can come back carrying the boundary timestamp itself.
    else if (i > tailIndex || it.createdAt <= heldOldest) olderTail.push(it);
  });
  if (ownNew.length === 0 && olderTail.length === 0) {
    // Identity, not just equality: an unchanged page must hand FlatList the exact same `data`.
    return contentChanged ? rows : (held as FeedItem[]);
  }
  return [...ownNew, ...rows, ...olderTail];
}

export function MainScreen({
  torBootstrap,
  torPhase,
  feed,
  storeVersions = {channels: 0, groups: 0, identity: 0, thread: 0, config: 0, draftAccess: 0},
  inbox,
  channels,
  currentUserPubkey,
  isModerator,
  modScopes = [],
  onGetPendingReports,
  onGetBannedMembers,
  onGetLoggedAuthors,
  onModeratorUnban,
  onModeratorLogAuthor,
  onModeratorRestoreAuthor,
  onModeratorLogPost,
  onCheckModLimit,
  sendStatus,
  sendReasons,
  sendQueuedOffline,
  syncing,
  connection,
  onUserActivity,
  onSetScrolling,
  onRetry,
  onCancelSend,
  onSubmit,
  onPromoteChannelPost,
  onSendDm,
  onReactDm,
  onRetryDm,
  onVote,
  onCreateChannel,
  onPostToChannel,
  onEditChannelMessage,
  onEditGroupMessage,
  onEditChannel,
  onDeleteChannel,
  onSetChannelPinned,
  onSetChannelInteractions,
  onReactToChannelMessage,
  onGetReactionsByTarget,
  getChannelMessageInteractions,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  subscribedChannelIds,
  onSubscribeChannel,
  onUnsubscribeChannel,
  onGetThread,
  listKeyFor,
  onIsSpaceSynced,
  onGetChannelMessages,
  onComment,
  onSetPinnedComment,
  onGetProfile,
  events,
  onGetDisplayName,
  onGetPinnedHistory,
  onGetLogPage,
  onGetModLog,
  onGetLogPost,
  onGetPostItem,
  onResolveIdentity,
  onModeratePost,
  onBlockUser,
  onUnblockUser,
  isUserBlocked,
  onChannelOwnerHide,
  onModerationRestore,
  draftStore,
  onGetDraftAccessState,
  onGetMyDraftDelivery,
  onRequestDraftAccess,
  onGetDraftThread,
  onGetDraftCommentCount,
  onGetDraftAccessQueue,
  onGetDraftAccessGranted,
  onApproveDraftAccess,
  onDenyDraftAccess,
  onRevokeDraftAccess,
  onSetDisplayName,
  onSetGradient,
  myCraftedGradient,
  pinEnabled,
  onSetPinEnabled,
  onVerifyPin,
  onWipe,
  onGetEvent,
  onGetEventScore,
  onGetChannelThread,
  onPostChannelComment,
  onLoadCommunities,
  onSwitchCommunity,
  onRemoveCommunity,
  onJoinAnotherCommunity,
  onLoadKeySlots,
  onSwitchIdentity,
  onRemoveIdentity,
  onAddIdentity,
  onGetBlossomEndpoint,
  onSetBlossomEndpoint,
  onGetPreferredBrowser,
  onSetPreferredBrowser,
  onListBrowsers,
  onClearMediaCache,
  onClearEventCache,
  onCountCachedEvents,
  onDeleteCachedData,
  onGetConnectionPrefs,
  onApplyConnectionPrefs,
  onGetRelaySnapshot,
  onAddRelay,
  onRemoveRelay,
  onMuteRelay,
  onUnmuteRelay,
  apkUpdatesEnabled,
  onCheckForUpdate,
  onInstallUpdate,
  tokenStatus,
  onRefreshTokenStatus,
  tagPolicy,
  labels = DEFAULT_LABELS,
  postRules = DEFAULT_POST_RULES,
  postingGuidelines = null,
  communityName = null,
  communityCid = null,
  ranking = DEFAULT_RANKING,
  groups = [],
  relaySupportsNip29 = false,
  onCreateGroup,
  onJoinGroup,
  onAcceptInviteLink,
  onLeaveGroup,
  onKickGroupMember,
  onAddGroupMember,
  onEditGroup,
  onGetSpaceSettings,
  onSetSpaceSettings,
  onGetLogOffer,
  onSetLogOffer,
  onRevokeLogOffer,
  onApproveJoin,
  onDenyJoin,
  onRequestToJoin,
  onWithdrawJoinRequest,
  onGetJoinState,
  onPreviewSpace,
  onGetSpacePreview,
  onGetJoinRequestQueue,
  onGetRosterActionStatus,
  onInvitePeople,
  onRevokeInvite,
  onGetInvited,
  spaceInvites = [],
  onAcceptSpaceInvite,
  onDismissSpaceInvite,
  onDeleteGroup,
  onTransferGroupOwner,
  onSetGroupInteractions,
  onReactToGroupMessage,
  getGroupPostInteractions,
  onPostToGroup,
  onReplyToGroup,
  onIsSpaceKeyMissing,
  onGetGroupState,
  onGetGroupMembers,
  onGetGroupAdmins,
  onGetGroupPending,
  onGetGroupMessages,
  onGetGroupReplies,
  onOpenGroup,
  onCloseGroup,
  onOpenChannel,
  onCloseChannel,
  bookmarkedPostIds = [],
  onToggleBookmark,
  onReportPost,
  onMuteAuthor,
  onUnlockContent,
  onModeratorLock,
  onModeratorRetag,
  onModeratorPin,
  lockedPostIds = [],
  pinnedPostIds = [],
  onRefreshFeed,
  newFeedItemCount = 0,
  onMarkFeedSeen,
  onLoadOlderFeed,
  onLoadOlderChannelPage,
  onLoadOlderGroupPage,
  pendingNav,
  onPendingNavHandled,
  notifUnreadCount = 0,
  onGetNotifications,
  onGetNotificationPrefs,
  onSetNotificationPrefs,
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
}: MainScreenProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // (The old measured-topInset hook is gone: full-screen overlays are now absolute children of the
  // tab stage, a flow child of the root SafeAreaView whose origin already sits below the iOS
  // notch/Dynamic Island — so no manual status-bar padding is needed on any overlay.)
  // The app opens on the user's persisted default tab (the last dock item they chose — see
  // BottomDock/dockPrefs). The prefs mirror is eager-loaded during loadWorkspaceState (splash-
  // gated), so this lazy initializer reads the hydrated value on first mount; a fresh install
  // (or tests with empty storage) falls back to 'feed'.
  // First-ever entry into a community lands on Updates — the only time Stiq overrides the member's
  // last tab (Point 1); every later launch/switch restores whatever they left on. communityEntry is
  // eager-loaded in loadWorkspaceState, so this synchronous read is accurate at mount.
  const [tab, setTab] = useState<Tab>(() => (wasFirstEntry() ? 'log' : dockDefaultTab()));
  const feedListRef = useRef<FlatList<FeedItem>>(null);
  const feedScroll = useScrollChrome();
  // FIX 2 (tab-switch scroll restore), post-Phase 4.1: the tab bodies now stay MOUNTED across dock
  // presses (TabLayer stage below), so native scroll positions survive on their own and the
  // restoreOffset plumbing is ordinarily a mount-time no-op (offset 0). These refs still matter:
  // feedScrollYRef drives FIX 3 (the pre-paint jump-bubble re-derivation on tab return), and the
  // one-shot restores (FeedList/ChannelList/LogScreen restoreHearthOffset) remain the safety net
  // for the rare REAL remounts — an ErrorBoundary reset re-mounting a surface mid-session.
  const feedScrollYRef = useRef(0);
  const channelsScrollYRef = useRef(0);
  const logHearthScrollYRef = useRef(0);
  // Whether the reader was within the jump-bubble's own JUMP_AFTER band of the top as of the last
  // check — backs the "N new posts" pill's auto-clear (Task: instant-refresh overhaul), edge-
  // triggered so a bounce/rubber-band at the top can't turn a per-frame onScroll callback into a
  // repeated O(feed-size) scan (AppRuntime.markFeedSeen walks every visible item — see its doc).
  // Starts `false` (not "already caught up") so the very first check — mount, or the first switch
  // into the feed tab — always fires once real content exists, matching markFeedSeen's own "call it
  // once the feed first shows real content" contract. A plain ref, never state: it must not itself
  // cause a render (see handleFeedScroll below, which runs on every scroll frame).
  const feedCaughtUpRef = useRef(false);

  // ── The feed HOLD (instant-refresh Gap 1) ──────────────────────────────────────────────────────
  // True while the reader is resting OUTSIDE the top band — the SAME `y <= JUMP_AFTER` band
  // feedCaughtUpRef above tracks and the jump bubble itself uses. Deliberately one predicate, never a
  // second threshold that could drift away from the pill's own notion of "at top".
  //
  // While it is true the feed renders the composition captured the last time the reader WAS inside
  // that band (see displayArranged below), so a post arriving from someone else cannot splice itself
  // into the array under their eyes and shift every card beneath it. That shift is real and
  // uncompensated: `maintainVisibleContentPosition` is deliberately unusable here (a continuously
  // re-scored Hot/Rising order defeats it — see ChannelView.tsx's note where it IS used), and the
  // "N new posts" pill only ever COUNTED arrivals; it never held them back. Now it does: the count
  // keeps climbing, nothing reflows, and returning to the top band (or tapping the pill) releases.
  //
  // Mirrored in a ref and written ONLY through setFeedHeld so a transition can never be dispatched
  // redundantly. Its writers are a per-scroll-frame callback and an effect keyed on feed.items, and
  // this exact boundary has already shipped one silent infinite render loop (see the regression
  // describe in MainScreen.newPostsPill.test.tsx) — a self-guarding setter is cheap insurance.
  const feedHeldRef = useRef(false);
  const [feedHeld, setFeedHeldState] = useState(false);
  const setFeedHeld = useCallback((next: boolean): void => {
    if (feedHeldRef.current === next) return;
    feedHeldRef.current = next;
    setFeedHeldState(next);
  }, []);

  // A horizontal chip rail (feed sort/tag row, Spaces filter, hearth people rail) scrolls natively
  // and would otherwise be stolen by the stage swipe — a native horizontal ScrollView doesn't join
  // JS responder negotiation, so the stage's grant would win and switch tab instead of the rail
  // scrubbing. While a finger is down on such a rail this flag is set (each rail spreads
  // railTouchHandlers directly, or reads them from TabRailTouchContext when it lives in a child
  // component); the stage swipe reads it via isExcluded and stands down so the rail scrolls instead.
  // Declared up here with the other scroll refs because renderQuietBar (built into feedChrome above
  // the swipe hook) closes over it — a later declaration would be a temporal-dead-zone ReferenceError.
  const railTouchRef = useRef(false);
  const railTouchHandlers = useMemo(
    () => ({
      onTouchStart: () => { railTouchRef.current = true; },
      onTouchEnd: () => { railTouchRef.current = false; },
      onTouchCancel: () => { railTouchRef.current = false; },
    }),
    [],
  );
  // Hold the latest mark-seen callback in a ref and reach it through a STABLE wrapper — the same
  // load-bearing idiom (and for the identical documented reason) as onOpenGroupRef/onOpenChannelRef
  // below. App.tsx hands this down as a fresh inline arrow on every render, AND the handler itself
  // writes App state back (markFeedSeen + setSnapshot), so listing the raw prop in a dependency
  // array closes a render→effect→setState→render cycle with nothing to terminate it.
  //
  // That is not hypothetical: it shipped in release APK vc9 and pegged mqt_js at 100% CPU with RES
  // climbing past 1 GB, permanently, the moment the app settled on the feed tab with cached content
  // at the top — see MainScreen.newPostsPill.test.tsx's regression describe for the full chain and
  // for why React's "Maximum update depth exceeded" guard never fires on this app's legacy root.
  // Everything below therefore depends on markFeedSeen (stable, []) and never on onMarkFeedSeen.
  const onMarkFeedSeenRef = useRef(onMarkFeedSeen);
  onMarkFeedSeenRef.current = onMarkFeedSeen;
  const markFeedSeen = useCallback((): void => {
    onMarkFeedSeenRef.current?.();
  }, []);
  // Edge-triggers the mark the moment a LIVE scroll gesture crosses BACK into the "caught up"
  // band — the only place that needs edge-guarding (a per-frame onScroll callback resting inside the
  // band would otherwise re-scan the whole feed on every frame; see feedCaughtUpRef's doc). The
  // tab-switch/content-arrival effect below reads the ref this maintains but never edge-guards
  // itself — see its own comment for why that's correct there.
  const syncFeedCaughtUp = useCallback((y: number): void => {
    const caughtUp = y <= JUMP_AFTER;
    if (caughtUp && !feedCaughtUpRef.current) markFeedSeen();
    feedCaughtUpRef.current = caughtUp;
    // Arm/release the hold on the SAME edge and from the SAME predicate as the mark above. setFeedHeld
    // self-guards, so a reader resting anywhere (inside or outside the band) dispatches nothing at all
    // from this per-frame callback — only a genuine crossing costs a render.
    setFeedHeld(!caughtUp);
  }, [markFeedSeen, setFeedHeld]);
  const handleFeedScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    feedScrollYRef.current = e.nativeEvent.contentOffset.y;
    feedScroll.onScroll(e);
    syncFeedCaughtUp(e.nativeEvent.contentOffset.y);
  }, [feedScroll, syncFeedCaughtUp]);
  // FIX 3 (stale jump bubble): re-derive chrome visibility + the jump-to-top bubble from the known
  // restore offset the instant the feed tab becomes current, BEFORE paint — mirrors the
  // tabContentFade pre-paint pattern below. Correct under FIX 2 by construction: the same ref
  // drives the FlatList's own restore, so a restored offset > 240 legitimately shows the bubble
  // and a fresh top hides it.
  useLayoutEffect(() => {
    if (tab === 'feed') feedScroll.syncOffset(feedScrollYRef.current);
  }, [tab, feedScroll]);
  // Marks the feed seen (clearing/advancing the "N new posts" pill's baseline) both when the feed
  // tab becomes current AND whenever the feed's content actually changes — as long as the reader is
  // AT the top either way. Deliberately keyed on `tab` too (not just feed.items) so switching INTO
  // the feed tab while the remembered offset (feedScrollYRef survives the tab staying mounted, Phase
  // 4.1) is already within the band clears the pill immediately, without waiting for a live scroll
  // event that may never come if they don't touch the list again. Deliberately NOT edge-guarded via
  // feedCaughtUpRef the way the scroll handler is: unlike a per-frame onScroll callback, this only
  // runs when `tab` or `feed.items` actually changes — already infrequent — and it must keep firing
  // on EVERY content change while the reader stays at the top, or a reader who never scrolls away
  // would stay marked "caught up" as of whenever they FIRST arrived, so once they eventually do
  // scroll away the pill would wrongly claim everything that arrived while they were actually
  // watching it live. (On the very first mount both this effect and nothing else can fire the mark,
  // so there is no double-count to worry about — the scroll handler's edge guard exists solely to
  // stop ITS OWN high-frequency callback from re-scanning, not to coordinate with this effect.)
  // Keyed on feed.items (not pagedItems/arranged) so a sort or tag-filter change alone can never
  // re-mark anything — only a genuine content change does. Skipped while the feed is still empty
  // (cold start / pre-sync) so the very first backlog to arrive can never read as "seen" against a
  // same-instant mark of nothing, which would make everything that follows look "new".
  // Depends on `markFeedSeen` (stable, []) rather than the raw `onMarkFeedSeen` prop — see that
  // wrapper's doc above: the prop's identity changes on every host render and the handler re-renders
  // the host, so depending on it here is an unterminated loop, not a redundant re-run.
  // Also the one place that arms the hold WITHOUT a scroll gesture: switching into the feed tab while
  // the remembered offset (feedScrollYRef, which survives because the tab body stays mounted) is
  // already outside the band must start holding, or the first arrival after the switch would reflow
  // the exact page the reader left. setFeedHeld self-guards, so re-running this on every feed.items
  // change while they stay away dispatches nothing.
  useEffect(() => {
    if (tab !== 'feed' || feed.items.length === 0) return;
    if (feedScrollYRef.current > JUMP_AFTER) { setFeedHeld(true); return; }
    feedCaughtUpRef.current = true;
    setFeedHeld(false);
    markFeedSeen();
  }, [tab, feed.items, markFeedSeen, setFeedHeld]);
  // Feed sort (Rising/New). The remembered choice is hydrated synchronously from feedSortPrefs —
  // AppRuntime.loadWorkspaceState eager-loads it before the splash lifts — so the lazy initializer
  // reads it on the very first render. No async in-component load, so no flash of the default 'new'
  // before the stored 'hot' arrives (the bug that read as "the app forgot my sort" on a cold start).
  const [sort, setSort] = useState<SortMode>(() => feedSortPref());
  const changeSort = useCallback((m: SortMode) => {
    setSort(m);
    // Only 'hot'/'new' are ever passed here (the feed bar); 'top' is search-only and never persisted.
    if (m === 'hot' || m === 'new') setFeedSortPref(m);
  }, []);
  // 'Top' is a SEARCH-ONLY sort: it lives in its own (non-persisted) state so it can never leak into
  // the feed sort, which is constrained to New/Rising and remembered across restarts.
  const [searchSort, setSearchSort] = useState<SortMode>('top');
  const [feedLimit, setFeedLimit] = useState(25);
  // Pull-to-refresh spinner state: true while a manual NIP-77 feed resync is in flight.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        await onRefreshFeed?.();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [onRefreshFeed]);
  // Multi-select tag filter (OR/union). Selected tags are kept in selection order and rendered first.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Persist tag selection across restarts
  useEffect(() => {
    void AsyncStorage.getItem(TAGS_STORAGE_KEY).then(stored => {
      if (stored) {
        try { setSelectedTags(JSON.parse(stored) as string[]); } catch { /* ignore */ }
      }
    });
  }, []);
  const toggleTag = (t: string): void =>
    setSelectedTags(prev => {
      const next = prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t];
      void AsyncStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  // Reset feed pagination whenever the sort / search / tags change — during render (the prev-value
  // pattern) rather than in an effect, so the fresh 25-item window is sliced in the SAME commit. The
  // effect version first committed the previous (larger) window against the newly-sorted feed and only
  // then re-rendered down to 25 — an extra render pass this avoids.
  const feedPageKey = JSON.stringify([sort, searchActive, searchQuery, selectedTags]);
  const [prevFeedPageKey, setPrevFeedPageKey] = useState(feedPageKey);
  if (feedPageKey !== prevFeedPageKey) {
    setPrevFeedPageKey(feedPageKey);
    setFeedLimit(25);
  }
  // Search time-frame: one selection drives filtering on the feed, channels and groups. The sheet
  // (opened from the search bar) edits it; `searchTimeRange` is the concrete window it resolves to.
  const [timeSel, setTimeSel] = useState<TimeSelection>(ALL_TIME);
  const [timeSheetOpen, setTimeSheetOpen] = useState(false);
  const searchTimeRange = useMemo(() => selectionToRange(timeSel), [timeSel]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<Draft | undefined>(undefined);
  /** No.5: the channel post being promoted into a feed thread ("enable replies"), or null. */
  const [promoteTarget, setPromoteTarget] = useState<Event | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftList, setDraftList] = useState<Draft[]>([]);
  /** The owner's "Manage access" queue (Phase 5§F) — open when non-null. `title` is best-effort (the
   *  owner's own local `draftList` echo has it; a bare notification tap only carries the shareId, so
   *  this is left undefined rather than faked). */
  const [manageAccessTarget, setManageAccessTarget] = useState<{shareId: string; title?: string} | null>(null);
  const [replyTarget, setReplyTarget] = useState<CommentNode | null>(null);
  /** The mod-log entry whose full-post view (Overlay B) is open, or null. */
  const [logPostInfo, setLogPostInfo] = useState<LogPostOpenInfo | null>(null);
  /** Whether the Log tab's full-screen community-log view is open (hides the chrome like any
   *  sub-screen; the hearth is the tab's base). */
  const [communityLogOpen, setCommunityLogOpen] = useState(false);
  /** The open mod-log detail-sheet entry key. Lifted here so the full-post modal can orchestrate
   *  with the sheet (author taps close both; closing the post returns to the still-open sheet). */
  const [openLogEntryKey, setOpenLogEntryKey] = useState<string | null>(null);
  // The channel/group-opened-from-a-Log-pick and profile-opened-from-a-drill-in return points used
  // to be tracked here by two single-purpose refs (logReturnRef / profileReturnRef). Both are now
  // just entries on the generic nav-origin stack (see navStackRef near openEmbedTarget) — a
  // {kind:'tabRoot'}/{kind:'profile'} origin pushed at the same arm sites, popped+restored by the
  // same closeOpenChannelView/closeOpenGroupView/closeOpenPostView/closeProfileView helpers below.
  /** Whether the moderator console (reports queue + bans) is open — moderators only. */
  const [modConsoleOpen, setModConsoleOpen] = useState(false);
  /** The open event detail's 31923 coordinate (embed tap / reminder tap / organizer preview). */
  const [openEventCoord, setOpenEventCoord] = useState<string | null>(null);
  /** The decoded `stiq:event:` token behind the open coordinate, when this open came from one — lets
   * EventDetailHost render a degraded VM (title/date/cover/host + `de` snippet) immediately instead
   * of a bare skeleton while the real doc's lazy fetch is still in flight. Null for opens that never
   * had a token (reminder tap, organizer preview, nav-origin restore). */
  const [openEventRef, setOpenEventRef] = useState<EventRef | null>(null);
  // The open read-only embed (a draft or a private-space post shared as an embed). Opened by
  // openEmbedTarget when its card is tapped; `readerSavedToken` reflects a just-saved onward-copy so
  // the reader's action can flip to "Saved ✓" without a store re-read.
  const [embedReader, setEmbedReader] = useState<EmbedReaderTarget | null>(null);
  const [readerSavedToken, setReaderSavedToken] = useState<string | null>(null);
  /** The Events — Organizer flow (reached from Settings). */
  const [eventsOrgOpen, setEventsOrgOpen] = useState(false);
  /** The live-derived notification center (bell). Items are snapshotted at open time. */
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<NotifItem[]>([]);

  // Lazy-mount the heavy modal sub-screens. Each renders a large Modal subtree (Settings ~1.1k LOC,
  // Composer ~1.2k LOC incl. a RichEditor WEBVIEW, ModeratorConsole/Drafts/KeyBackup/TimeFrameSheet)
  // that stays closed on the very first feed paint and during early scrolling — yet React still
  // executes each body + builds its (discarded) element tree on every MainScreen render. Gate the
  // MOUNT on "has this ever been opened": until first open the tree is never constructed; after first
  // open the component STAYS mounted so its Modal still plays the normal slide/fade EXIT animation on
  // close (unmounting on close would make it vanish instantly).
  //
  // Phase 3.4 (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md): the old `mounted.current ||= open` ref
  // idiom set mount + visible in the SAME render on first open — the exact Android RN 0.76
  // mount-already-visible failure mode the app-wide "always-mount + toggle visible" rule exists to
  // avoid (LogScreen.tsx DetailSheet, StiqAlert.tsx). useLazyModalMount keeps the lazy mount but
  // sequences first open as mount-hidden → flip-visible-next-commit; each sub-screen's `visible`
  // prop now comes from the hook, NOT from the raw open state.
  const settingsModal = useLazyModalMount(settingsOpen);
  const modConsoleModal = useLazyModalMount(modConsoleOpen && isModerator);
  const timeSheetModal = useLazyModalMount(timeSheetOpen);
  const draftsModal = useLazyModalMount(draftsOpen);
  const draftAccessModal = useLazyModalMount(!!manageAccessTarget);
  const composerModal = useLazyModalMount(composerOpen);
  const notifModal = useLazyModalMount(notifOpen);
  const eventsOrgModal = useLazyModalMount(eventsOrgOpen);

  const openDrafts = async (): Promise<void> => {
    if (!draftStore) return;
    setDraftList(await draftStore.all());
    setDraftsOpen(true);
  };
  const startNewPost = (): void => {
    setResumeDraft(undefined);
    setComposerOpen(true);
  };
  // Opening the center does NOT mark anything read — the badge count clears per row tap or via
  // the center's ✓✓ Mark-all-read (design behavior). The derive itself no longer lives here: this
  // used to snapshot onGetNotifications() ONCE, right at this call site, which meant anything that
  // arrived while the screen stayed open was invisible until the user closed and reopened it — the
  // one surface in the app that wasn't live. See the notifLiveRecompute effect below (next to
  // threadNodes): it fires the instant notifOpen flips true — same open-modal-first,
  // derive-after-the-animation sequencing as before — and again on every relevant store change for
  // as long as the center stays open.
  const openNotifications = (): void => {
    setNotifOpen(true);
  };
  const resume = (d: Draft): void => {
    setDraftsOpen(false);
    const loc = d.location;
    // A comment draft resumes by REOPENING ITS THREAD — the composer there re-loads the slot keyed
    // on this same rootId. Same lookup the nav-origin stack uses to restore an open post, so a root
    // that has since fallen out of the feed cache still resolves via onGetPostItem. If it resolves
    // to nothing (the post is genuinely gone), fall through to the full-page composer rather than
    // silently doing nothing — the writing is still the user's, and it is never lost.
    if (loc && loc.kind === 'comment') {
      const item = feed.items.find(f => f.id === loc.rootId) ?? onGetPostItem?.(loc.rootId) ?? null;
      if (item) {
        setComposerOpen(false);
        setResumeDraft(undefined);
        setTab('feed');
        setOpenPost(item);
        return;
      }
    }
    // A channel/group/DM draft resumes IN its home surface — navigating there re-loads its
    // in-progress slot (No.5/No.7). Only feed drafts open the full-page composer.
    if (loc && loc.kind === 'channel') {
      setComposerOpen(false);
      setResumeDraft(undefined);
      if (loc.channelType === 'dm') {
        setTab('feed');
        setOpenPeer(loc.channelId);
        return;
      }
      setTab('channels');
      setChannelDetailOpen(false);
      if (loc.channelType === 'public') {
        setOpenGroupId(null);
        fetchChannelIfUnknown(loc.channelId, channels, onGetEvent);
        setOpenChannelId(loc.channelId);
      } else {
        setOpenChannelId(null);
        setOpenGroupId(loc.channelId);
      }
      return;
    }
    setResumeDraft(d);
    setComposerOpen(true);
  };

  // Feed: open post for thread view
  const [openPost, setOpenPost] = useState<FeedItem | null>(null);
  // Thread comments for the open post. Computed OFF the opening tap (A2): buildThread runs two full
  // sorted store queries + a moderation scan — far too heavy to run synchronously inside render on
  // the tap that opens the overlay. Held in state and filled by a deferred InteractionManager pass
  // (see below), mirroring openNotifications. Cleared in the same commit as a post switch/close (the
  // prev-id reset block) so a different post never briefly shows the previous post's thread.
  // `null` = not computed yet for the open post (render NOTHING in the empty slot — never the
  // "No comments yet." copy, which used to flash on every open of a commented post); `[]` =
  // computed and genuinely empty (Phase 3.1 null-vs-[] discipline / stale-first rule).
  const [threadNodes, setThreadNodes] = useState<CommentNode[] | null>(null);
  // Author's-note edit-history dialog (scrollable list of every prior version).
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  // Post detail: inline author's-note editor, the ⋯ action sheet, and the Comments/Post jump.
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [detailCopied, setDetailCopied] = useState(false);
  const [jumpDir, setJumpDir] = useState<'down' | 'up'>('down');
  const threadListRef = useRef<FlatList<CommentNode & {depth: number}>>(null);
  // FIX 2E: measured pixel height of the ThreadView list header (the rendered post body +
  // author's note + COMMENTS heading). Comments begin exactly at this offset, so the jump is a
  // deterministic scrollToOffset rather than a flaky scrollToIndex into not-yet-measured comments.
  const detailHeaderHeightRef = useRef(0);
  // Last known scroll offset of the thread list — drives the label so it stays correct even when
  // the user scrolls manually (not just via the button).
  const detailScrollYRef = useRef(0);
  // Reset the per-post detail UI whenever a different post opens — during render (the prev-value
  // pattern) rather than in an effect, so the reset lands in the SAME commit as the new post. The
  // effect version reset AFTER commit, causing an extra render pass that briefly showed the previous
  // post's inline editor / action-sheet / jump state under the new post.
  const [prevDetailPostId, setPrevDetailPostId] = useState<string | null>(openPost?.id ?? null);
  if ((openPost?.id ?? null) !== prevDetailPostId) {
    setPrevDetailPostId(openPost?.id ?? null);
    setNoteEditing(false);
    setDetailMenuOpen(false);
    setJumpDir('down');
    setHistoryModalOpen(false);
    detailHeaderHeightRef.current = 0;
    detailScrollYRef.current = 0;
    // Drop the previous post's thread in the SAME commit as the new/closed post — the deferred
    // compute below refills it for the new post; this prevents the old thread flashing under the
    // new header (and empties it on close). A stale deferred pass is guarded off by openPost.id.
    // `null`, NOT `[]`: not-yet-computed must be distinguishable from genuinely-empty so the
    // "No comments yet." empty state can't flash during the compute gap (Phase 3.1).
    setThreadNodes(null);
  }
  // Profile: open from tapped author
  const [openProfile, setOpenProfile] = useState<Profile | null>(null);

  // Messages: open DM conversation
  const [openPeer, setOpenPeer] = useState<string | null>(null);

  // Channels: open channel or show create form
  const [openChannelId, setOpenChannelId] = useState<string | null>(null);
  const [openChannelPostId, setOpenChannelPostId] = useState<string | null>(null);
  const [channelDetailOpen, setChannelDetailOpen] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [channelFilter, setChannelFilter] = useState<'all' | 'dms' | 'public' | 'private' | 'group'>('all');
  // LOCKED PREVIEW (membership handoff) for a `stiq:space:…` (kind 39000) token pointing at a
  // private group the viewer isn't a member of yet — full-screen: metadata + optional intro note +
  // "Request to join" / withdrawable pending card. Seeds from what the token itself carries (id,
  // name, gradient — never a key); onPreviewSpace() hydrates real counts/about from the relay.
  const [joinReq, setJoinReq] = useState<{groupId: string; name?: string; gradient?: GradientSpec} | null>(null);
  // Fallback sent-state for hosts that wire no onGetJoinState (tests / legacy callers).
  const [joinReqSent, setJoinReqSent] = useState(false);
  const [joinNote, setJoinNote] = useState('');
  // Unread badges: bump to force the channel list to recompute counts after a source is opened.
  const [readVersion, setReadVersion] = useState(0);
  useEffect(() => { void ensureReadStateLoaded().then(() => setReadVersion(v => v + 1)); }, []);
  // Mark a source seen up to its newest message, then refresh the unread badges if it advanced.
  // The watermark is floored at the community's first-entry timestamp (Point 7) so opening a space
  // clears its "1" newcomer nudge even when it has no messages yet (newest = 0).
  const markSourceSeen = useCallback((sourceId: string, msgs: Event[]): void => {
    const newest = msgs.reduce((max, m) => (m.created_at > max ? m.created_at : max), 0);
    const to = Math.max(newest, firstEnteredAt());
    if (to > 0) void markSeen(sourceId, to).then(adv => { if (adv) setReadVersion(v => v + 1); });
  }, []);
  // Groups (NIP-29): open group view; subscribes to the group's scoped events while mounted.
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  // Which internal screen the NEXT group open should land on. A join-request notification tap sets
  // this to 'manage' right before setOpenGroupId; every other open leaves it 'chat'. It is consumed
  // (reset to 'chat') by the open-group effect below once GroupView has mounted and read it — so the
  // Manage intent is one-shot and a later normal open defaults back to chat, without having to touch
  // the ~15 setOpenGroupId call sites.
  const [openGroupInitialScreen, setOpenGroupInitialScreen] = useState<'chat' | 'manage'>('chat');
  // Hold the latest open/close callbacks in refs so the effect depends ONLY on openGroupId. The
  // callbacks arrive as new inline arrows from App.tsx on every render, so depending on them made this
  // effect re-fire on every relay emit (close→open→hydrateSpaceKeys→emit→…), a loop that froze the app
  // for private (encrypted) spaces. Refs keep the subscribe/unsubscribe to exactly once per open.
  const onOpenGroupRef = useRef(onOpenGroup);
  onOpenGroupRef.current = onOpenGroup;
  const onCloseGroupRef = useRef(onCloseGroup);
  onCloseGroupRef.current = onCloseGroup;
  useEffect(() => {
    // Consume the one-shot Manage-screen intent (see openGroupInitialScreen). GroupView's useState
    // seeds from it during render — before this effect — so resetting here can't unseed the mount.
    // Runs on EVERY openGroupId change, including → null (a close), so a later reopen defaults to
    // chat. The functional no-op when already 'chat' lets React bail the re-render on normal opens.
    setOpenGroupInitialScreen(cur => (cur === 'manage' ? 'chat' : cur));
    if (!openGroupId) return;
    onOpenGroupRef.current?.(openGroupId);
    return () => onCloseGroupRef.current?.(openGroupId);
  }, [openGroupId]);
  // Swipe-back (2026-07-27): GroupView holds its 'chat' | 'manage' | 'addpeople' state internally, so
  // MainScreen can't see it directly — GroupView lifts a single "am I at the swipeable root" boolean
  // via onAtRootChange, and this is where it lands (see the <SubScreen swipeEnabled={groupAtRoot}>
  // site below). Initialised true so the very first group ever opened defaults swipeable.
  //
  // Deliberately NOT also reset by a `useEffect(() => setGroupAtRoot(true), [openGroupId])` here, even
  // though that reads like the obvious belt-and-suspenders addition: GroupView is keyed on openGroupId
  // (key={openGroupId} below), so every open is a genuine fresh mount, and a fresh mount's OWN
  // onAtRootChange effect always fires — unconditionally, regardless of deps — reporting the CORRECT
  // starting value (true for the normal chat-root open, false when a join-request notification seeds
  // initialScreen='manage'). A same-commit reset effect here would still run — React fires a newly-
  // mounted CHILD's effects before an already-mounted PARENT's changed-deps effects in the same commit
  // (verified empirically against this exact React/react-test-renderer pin) — so it would fire AFTER
  // GroupView's report and unconditionally stomp a correct `false` back to `true`, leaving a
  // notification-opened manage page wrongly swipeable until the next in-page navigation. Relying
  // solely on GroupView's own report avoids that ordering hazard entirely.
  const [groupAtRoot, setGroupAtRoot] = useState(true);

  // Channels (NIP-53), bug 8: subscribe to the open channel's kind-1311 chat while its view is
  // mounted. Structurally identical to the group effect above — including the refs, which are
  // load-bearing for the same documented reason: App.tsx hands these down as fresh inline arrows on
  // every render, so depending on the callbacks themselves would close+reopen the subscription on
  // every relay emit. Depends on openChannelId ALONE.
  //
  // Inert with SCOPED_CHANNEL_SYNC off: App.tsx leaves the underlying deps undefined, so
  // AppRuntime.openChannel/closeChannel do nothing and this effect is a pair of no-op calls.
  const onOpenChannelRef = useRef(onOpenChannel);
  onOpenChannelRef.current = onOpenChannel;
  const onCloseChannelRef = useRef(onCloseChannel);
  onCloseChannelRef.current = onCloseChannel;
  useEffect(() => {
    if (!openChannelId) return;
    onOpenChannelRef.current?.(openChannelId);
    return () => onCloseChannelRef.current?.(openChannelId);
  }, [openChannelId]);

  // Tag chips: selected → pinned community tags → rest by frequency.
  // Gated on the feed tab AND memoised so feedTags()/sort/search never run while the user is on the
  // Messages/Log/Settings tabs (where the feed isn't shown) — a relay snapshot there does no feed work.
  const onFeedTab = tab === 'feed';
  // The header search icon only appears where a search surface exists: the feed, the channel/DM list,
  // or an open channel/group. DMs carry their own in-overlay search; the Log tab and the create-channel
  // / new-message forms have nothing to search, so the icon is hidden there rather than dead-clicking.
  // The `!openChannelId || channels.some(...)` guard also excludes the degenerate case where an open
  // channel was just dropped from the relay snapshot (openChannelId set but no matching channel) — the
  // channels body renders blank there, so the icon would otherwise be a dead click.
  const searchAvailable =
    onFeedTab ||
    (tab === 'channels' && !showCreateChannel && !showNewMessage &&
      (!openChannelId || channels.some(c => c.id === openChannelId)));

  // ── Connection strip copy + severity ───────────────────────────────────────────────────────────
  // One plain-language line (the guided ladder's own wording when it's driving, else the state
  // label), and a single boolean for how loud the strip gets.
  //
  // "Stalled" mirrors the ProgressBar's own visibility rule exactly: App.tsx clears the bootstrap
  // percent when Tor genuinely gives up, so no percent + a terminal state = nothing is moving, and
  // that is the ONLY case that earns the red dot and the tinted surface. While the daemon is still
  // climbing — including the ladder's "taking too long" rungs, which are still actively retrying —
  // the strip stays neutral chrome with an amber dot, because it is working, just slowly.
  const connectionText = phaseAwareLabel(connection, GUIDED_AUTO_LADDER ? torPhase : null, torBootstrap?.percent);
  const connectionStalled =
    !(typeof torBootstrap?.percent === 'number' && torBootstrap.percent > 0) &&
    (connection === 'offline' || connection === 'disconnected');

  const allTagsWithCommunity = useMemo(() => {
    if (!onFeedTab) return {allTags: [] as {tag: string; count: number}[], communityTagSet: new Set<string>(), pinCommunity: true};
    const allTags = feedTags(feed.items);
    const communityTagSet = new Set(tagPolicy?.communityTags ?? []);
    const pinCommunity = tagPolicy?.pinCommunityTags !== false;
    const extraCommunityTags = (tagPolicy?.communityTags ?? [])
      .filter(t => !allTags.find(tc => tc.tag === t))
      .map(t => ({tag: t, count: 0}));
    return {allTags: [...allTags, ...extraCommunityTags], communityTagSet, pinCommunity};
  }, [onFeedTab, feed.items, tagPolicy]);
  const {allTags, communityTagSet, pinCommunity} = allTagsWithCommunity;
  const orderedTags = useMemo(() => [
    ...selectedTags.map(t => allTags.find(tc => tc.tag === t) ?? {tag: t, count: 0}),
    ...(pinCommunity
      ? allTags.filter(tc => !selectedTags.includes(tc.tag) && communityTagSet.has(tc.tag))
      : []),
    ...allTags.filter(tc => !selectedTags.includes(tc.tag) && (!pinCommunity || !communityTagSet.has(tc.tag))),
  ], [allTags, communityTagSet, pinCommunity, selectedTags]);

  // searched/arranged are memoised + feed-tab-gated: FlatList gets a stable `data` reference when
  // sort/tags/feed haven't changed, and no sort/search work runs on other tabs.
  // Locked/pinned id sets (stable per snapshot) — drive the feed pin-float, the moderator menu
  // toggle labels, and the locked-thread composer gate.
  const lockedSet = useMemo(() => new Set(lockedPostIds), [lockedPostIds]);
  const pinnedSet = useMemo(() => new Set(pinnedPostIds), [pinnedPostIds]);
  const bookmarkedSet = useMemo(() => new Set(bookmarkedPostIds), [bookmarkedPostIds]);
  const searched = useMemo(
    () => (!onFeedTab ? [] : searchActive ? searchFeed(feed.items, searchQuery, searchTimeRange) : feed.items),
    [onFeedTab, feed.items, searchActive, searchQuery, searchTimeRange],
  );
  const arranged = useMemo(() => {
    if (!onFeedTab) return searched;
    // Feed bar sorts by New/Rising; while searching, the search bar's own sort (which may be Top)
    // applies instead. Keeping them separate is what stops Top from leaking back into the feed.
    const activeSort = searchActive ? searchSort : sort;
    const base = arrangeFeed(searched, {tags: selectedTags, sort: activeSort}, undefined, ranking);
    // Moderator-pinned posts float to the top regardless of the active sort.
    if (!pinnedSet.size) return base;
    return [...base.filter(i => pinnedSet.has(i.id)), ...base.filter(i => !pinnedSet.has(i.id))];
  }, [onFeedTab, searched, selectedTags, sort, searchSort, searchActive, pinnedSet, ranking]);
  // ── What the list actually renders (the HOLD applied) ───────────────────────────────────────────
  // `arranged` above is the LIVE order. `displayArranged` is the live order while the reader is inside
  // the top band, and otherwise the order + membership captured the last time they were, with each
  // row's CONTENT still read live (holdFeedComposition). See feedHeldRef's doc for the why.
  //
  // The hold is dropped outright whenever `feedViewKey` changes: sort, search text, search sort, the
  // search time-frame, the tag filter, or the active community. Every one of those is the reader's own
  // action (or a wholesale content replacement), so it must recompose under their finger even while
  // they are scrolled away. Background content signals are deliberately NOT in the key — a moderator's
  // pin or an organizer's ranking change rides the hold like any other arrival.
  const feedViewKey =
    `${feedPageKey} ${searchSort} ${JSON.stringify(searchTimeRange ?? null)} ${communityCid ?? ''}`;
  const heldArrangedRef = useRef<FeedItem[] | null>(null);
  const heldViewKeyRef = useRef(feedViewKey);
  const displayArranged = useMemo(() => {
    // Off the feed tab `arranged` is `[]` by design (the memos above are tab-gated). Capturing THAT as
    // the composition would throw the reader's place away, so leave the hold untouched and let it
    // resume when they come back — which is also why the hold cannot leak across a tab switch: the
    // only thing that resumes it is the same still-matching feedViewKey check below.
    if (!onFeedTab) return arranged;
    const held = heldArrangedRef.current;
    if (!feedHeld || held === null || heldViewKeyRef.current !== feedViewKey) {
      heldViewKeyRef.current = feedViewKey;
      heldArrangedRef.current = arranged;
      return arranged;
    }
    return holdFeedComposition(held, arranged);
  }, [onFeedTab, arranged, feedHeld, feedViewKey]);
  // Paginated slice of the (possibly held) order — default 25 items, "Load more" adds 25 at a time.
  const pagedItems = useMemo(() => displayArranged.slice(0, feedLimit), [displayArranged, feedLimit]);
  const hasMoreFeed = onFeedTab && displayArranged.length > feedLimit;

  const openPostFromFeed = useCallback((item: FeedItem) => {
    setOpenPost(item);
  }, []);
  // Tapping a reference embed navigates to its target. A post opens directly; a referenced
  // comment opens the thread it lives under (its root post). Bug #12: an embed that resolves to
  // NEITHER (a channel broadcast, a group message, or a channel/LiveActivity definition) used to
  // silently do nothing — this is the ONE place that resolution lives; every embed-tap path (feed,
  // thread, channels, group, DM) routes through this same helper.
  // Refs holding the latest feed/channels/groups + their lookup callbacks so openEmbedTarget below
  // can carry a GENUINELY stable identity (empty deps) rather than merely being assumed stable.
  // It previously depended on [feed, channels, groups] — which change on virtually every relay
  // snapshot — so despite a comment elsewhere claiming its identity was stable, it churned on every
  // background update and defeated messagesContent's memo (the open DM re-rendered on unrelated
  // feed writes). Reading through refs keeps the callback's identity fixed while still resolving
  // against current data.
  const embedFeedRef = useRef(feed);
  embedFeedRef.current = feed;
  const embedChannelsRef = useRef(channels);
  embedChannelsRef.current = channels;
  const embedGroupsRef = useRef(groups);
  embedGroupsRef.current = groups;
  const embedGetEventRef = useRef(onGetEvent);
  embedGetEventRef.current = onGetEvent;
  const embedGetChannelMessagesRef = useRef(onGetChannelMessages);
  embedGetChannelMessagesRef.current = onGetChannelMessages;
  const embedGetGroupMessagesRef = useRef(onGetGroupMessages);
  embedGetGroupMessagesRef.current = onGetGroupMessages;
  const embedPreviewSpaceRef = useRef(onPreviewSpace);
  embedPreviewSpaceRef.current = onPreviewSpace;

  // ── Nav-origin stack (FIX 1) ────────────────────────────────────────────────
  // The single source of "where does back go" for every cross-surface navigation (notifications →
  // post, profile → DM, a Log pick → channel/group, a mod-log entry's author-tap → profile, an
  // embedded reference tapped while something else was open, …). Replaces the old single-purpose
  // logReturnRef / profileReturnRef, which each covered exactly one navigation shape.
  const navStackRef = useRef<{origin: NavOrigin; target: NavDestination}[]>([]);

  // ── Tab-visit back-stack ─────────────────────────────────────────────────────
  // Orthogonal to navStackRef above: that stack restores a SURFACE's origin (a post, a profile, a
  // group, …); this one remembers which TABS the reader actually chose to visit (dock press or stage
  // swipe), so hardware BACK on a bare tab root walks back through them instead of leaving the app
  // immediately. Only genuine forward tab-selections push (see selectTab's `viaBack` guard below) —
  // a BACK-driven pop must never re-push its own source tab, and cross-tab EMBED hops (openEmbedTarget
  // above, which calls setTab directly) are a different mechanism entirely and never touch this ref.
  const tabHistoryRef = useRef<Tab[]>([]);

  // Push a return point. "Same target from a different origin replaces" — filter out any existing
  // entry for this exact target first, so re-navigating to the same destination via a different
  // route always remembers the LATEST origin, never a stale earlier one.
  const pushNavOrigin = useCallback((origin: NavOrigin, target: NavDestination): void => {
    const stack = navStackRef.current.filter(e => !navDestinationsEqual(e.target, target));
    stack.push({origin, target});
    while (stack.length > NAV_STACK_DEPTH) stack.shift();
    navStackRef.current = stack;
  }, []);

  // Pop and return the origin ONLY when the TOP entry's target structurally matches — a close
  // action for a DIFFERENT surface than the one on top must never consume (or misfire) someone
  // else's return point.
  const popNavOriginIfMatches = useCallback((target: NavDestination): NavOrigin | null => {
    const stack = navStackRef.current;
    const top = stack[stack.length - 1];
    if (!top || !navDestinationsEqual(top.target, target)) return null;
    navStackRef.current = stack.slice(0, -1);
    return top.origin;
  }, []);

  // Apply a popped origin — the one place that knows how to reopen each kind of "where I came
  // from". `profile` re-resolves fresh via onGetProfile (never stores the Profile object itself —
  // it can go stale between push and pop); `post` mirrors navigateToNotification's own post branch
  // (feed.items first, onGetPostItem as the evicted-from-cache fallback).
  const restoreNavOrigin = useCallback((origin: NavOrigin): void => {
    switch (origin.kind) {
      case 'notifications':
        setNotifOpen(true);
        break;
      case 'profile': {
        const p = onGetProfile?.(origin.pubkey);
        if (p) setOpenProfile(p);
        setTab(origin.tab);
        break;
      }
      case 'modConsole':
        setModConsoleOpen(true);
        break;
      // Contract rule 3, and the ONLY place it is enforced: BACK gets AT MOST ONE tab hop. We are
      // landing the reader on a bare tab root, so everything still queued behind this entry is a
      // return point they navigated PAST, not one they can navigate back OUT of — clearing the stack
      // guarantees the very next BACK falls through to the OS default and backgrounds the app rather
      // than hopping to a third tab. (Equivalent to what the stack-GC effect below would do on the
      // next render, since none of those targets are on screen once we are at a root — but stated
      // here, where the rule lives, instead of left to a side effect.)
      case 'tabRoot':
        setTab(origin.tab);
        navStackRef.current = [];
        break;
      case 'logPost':
        setLogPostInfo(origin.info);
        setOpenLogEntryKey(origin.entryKey);
        setTab('log');
        break;
      case 'group':
        setTab('channels');
        setOpenChannelId(null);
        setOpenGroupId(origin.groupId);
        break;
      case 'channel':
        setTab('channels');
        setOpenGroupId(null);
        setOpenChannelId(origin.channelId);
        break;
      case 'post': {
        setTab('feed');
        const item = feed.items.find(f => f.id === origin.postId) ?? onGetPostItem?.(origin.postId) ?? null;
        if (item) setOpenPost(item);
        break;
      }
      case 'dm':
        if (origin.tab) setTab(origin.tab);
        setOpenPeer(origin.peer);
        break;
      case 'event':
        setOpenEventRef(null);
        setOpenEventCoord(origin.coordinate);
        break;
    }
  }, [onGetProfile, feed.items, onGetPostItem]);

  // Sibling refs to the embed* block above, holding the latest tab/open-surface state so
  // openEmbedTarget (below) can capture "what was open before this tap" for the nav-origin stack
  // while keeping its own [] deps genuinely stable. Same reasoning as embedFeedRef etc.: reading
  // closed-over state directly would force openEmbedTarget to depend on it and churn its identity
  // on every navigation.
  const navTabRef = useRef(tab);
  navTabRef.current = tab;
  const navOpenPostRef = useRef(openPost);
  navOpenPostRef.current = openPost;
  const navOpenChannelIdRef = useRef(openChannelId);
  navOpenChannelIdRef.current = openChannelId;
  const navOpenGroupIdRef = useRef(openGroupId);
  navOpenGroupIdRef.current = openGroupId;
  const navOpenPeerRef = useRef(openPeer);
  navOpenPeerRef.current = openPeer;
  // pushNavOrigin's own identity is stable ([] deps — it only ever touches navStackRef), but
  // openEmbedTarget still reads it through a ref rather than closing over it directly: closing over
  // it would make openEmbedTarget's `[]` dep array lie to the exhaustive-deps lint rule (which has
  // no way to know pushNavOrigin never actually changes), the same reason the embed* refs exist.
  const pushNavOriginRef = useRef(pushNavOrigin);
  pushNavOriginRef.current = pushNavOrigin;

  /** How long a tapped-but-uncached embed target keeps trying to complete once its fetch lands. */
  const PENDING_EMBED_OPEN_MS = 15_000;
  const pendingEmbedOpenRef = useRef<{id: string; expiresAt: number; origin: string} | null>(null);
  /**
   * Where the reader is right now (tab + open surface). A pending embed-open is dropped the moment
   * this changes — the deferred navigation must never yank the screen away from somewhere the user
   * deliberately went after the tap.
   */
  const embedNavFingerprint = useCallback(
    (): string =>
      [
        navTabRef.current,
        navOpenPostRef.current?.id ?? '',
        navOpenChannelIdRef.current ?? '',
        navOpenGroupIdRef.current ?? '',
        navOpenPeerRef.current ?? '',
      ].join('|'),
    [],
  );

  const openEmbedTarget = useCallback((id: string, retryPass = false): boolean => {
    const feed = embedFeedRef.current;
    const channels = embedChannelsRef.current;
    const groups = embedGroupsRef.current;
    const onGetEvent = embedGetEventRef.current;
    const onGetChannelMessages = embedGetChannelMessagesRef.current;
    const onGetGroupMessages = embedGetGroupMessagesRef.current;

    // FIX 1: capture the currently-open surface (if any) as the return point for a possible push
    // below. Tab-gated for post/channel/group — `openPost`/`openChannelId`/`openGroupId` can hold a
    // stale non-null value left over from a tab the user has since navigated away from (e.g. the
    // Feed dock press doesn't clear openChannelId), which would otherwise be mistaken for "still
    // open". DM peer is NOT tab-gated: a DM can be the open surface on any tab (see the onSubScreen
    // fix below). No open surface at all → the reader is on a bare tab root, so there is nothing to
    // reopen — but if the tap is about to CROSS TABS there is still somewhere to come back to: the
    // tab itself. That is the `tabRoot` fallback below, and without it a card tapped on the Current
    // feed that lands in a Spaces channel stranded the reader on Spaces when they closed it (BACK
    // had no return point and simply fell through to "leave the app"). Same tab + nothing open needs
    // no push at all: closing the destination already lands back in the right place.
    const origin: NavOrigin | null =
      navTabRef.current === 'feed' && navOpenPostRef.current ? {kind: 'post', postId: navOpenPostRef.current.id} :
      navTabRef.current === 'channels' && navOpenChannelIdRef.current ? {kind: 'channel', channelId: navOpenChannelIdRef.current} :
      navTabRef.current === 'channels' && navOpenGroupIdRef.current ? {kind: 'group', groupId: navOpenGroupIdRef.current} :
      navOpenPeerRef.current ? {kind: 'dm', peer: navOpenPeerRef.current} :
      null;
    /** `destTab` is the tab this navigation lands on — omit it for destinations that change no tab
     *  (the event detail is a Modal over whatever is showing), since then there is no hop to undo. */
    const pushIfOrigin = (target: NavDestination, destTab?: Tab): void => {
      const from = navTabRef.current;
      const crossesTabs = !!destTab && destTab !== from;
      // A DM floats over any tab, so a dm origin only learns which tab to come back to here, where
      // we know the trip crossed one. Every other origin either carries its tab already (profile) or
      // implies it (post → Current, channel/group → Spaces).
      const withTab: NavOrigin | null =
        origin && origin.kind === 'dm' && crossesTabs ? {...origin, tab: from} : origin;
      const effective: NavOrigin | null =
        withTab ?? (crossesTabs ? {kind: 'tabRoot', tab: from} : null);
      if (effective) pushNavOriginRef.current(effective, target);
    };

    // Self-contained `stiq:draft:…` (unpublished writing) and `stiq:msg:…` (a decrypted snapshot of a
    // PRIVATE-space post) tokens resolve FIRST and open the read-only EmbedReader overlay — neither has
    // a published event to navigate to, so they can never be found by the store-scanning fallback below.
    const draftRef = parseDraftEmbed(id);
    if (draftRef) {
      setEmbedReader({token: id, draft: draftRef});
      return true;
    }
    const msgRef = parseMsgEmbed(id);
    if (msgRef) {
      setEmbedReader({token: id, msg: msgRef});
      return true;
    }

    // Self-contained `stiq:event:…` tokens (event cards) resolve FIRST for the same reason as
    // spaces below: they never appear in any store the fallback logic scans. A raw 31923
    // coordinate (a reminder tap, an organizer preview) opens the same overlay.
    const eventRef = parseEventEmbed(id);
    if (eventRef) {
      pushIfOrigin({kind: 'event', coordinate: eventRef.coordinate});
      setOpenEventRef(eventRef);
      setOpenEventCoord(eventRef.coordinate);
      return true;
    }
    if (/^31923:[0-9a-f]{64}:.+$/.test(id)) {
      pushIfOrigin({kind: 'event', coordinate: id});
      setOpenEventRef(null);
      setOpenEventCoord(id);
      return true;
    }

    // Self-contained `stiq:space:…` tokens (channel/private-group cards) resolve FIRST — they
    // never appear in the feed/channel-message/group-message stores the fallback logic below
    // scans, so letting them fall through would always miss.
    const spaceRef = parseSpaceEmbed(id);
    if (spaceRef) {
      if (spaceRef.kind === 30311) {
        // Public channel: coordinate === Channel.id. Joinable by anyone, no key required.
        // fetchChannelIfUnknown resolves the channel's own 30311 metadata by coordinate when it
        // isn't cached yet, purely for VIEWING (never auto-follows) — the fetched event lands in
        // the store and `channels` picks it up on the next relay snapshot; until then the
        // "channel not yet loaded" branch below shows a placeholder instead of a blank screen.
        pushIfOrigin({kind: 'channel', channelId: spaceRef.coordinate}, 'channels');
        setTab('channels');
        setOpenGroupId(null);
        setChannelDetailOpen(false);
        fetchChannelIfUnknown(spaceRef.coordinate, channels, onGetEvent);
        setOpenChannelId(spaceRef.coordinate);
        return true;
      }
      // Private group (kind 39000): identifier is the group's h/d id.
      const isMember = groups.some(g => g.id === spaceRef.identifier);
      if (isMember) {
        pushIfOrigin({kind: 'group', groupId: spaceRef.identifier}, 'channels');
        setTab('channels');
        setOpenChannelId(null);
        setChannelDetailOpen(false);
        setOpenGroupId(spaceRef.identifier);
      } else {
        // Non-member: opens the locked-preview join dialog, which has no NavDestination shape of
        // its own (it isn't a "surface" the stack tracks) — no push. The dialog itself (not this
        // call site) checks `spaceInvites` for an outstanding admin-signed invite to this exact
        // group and offers "Accept invite" (the grant-forwarding, admin-independent instant-admit
        // path) instead of a bare "Request to join" whenever one exists — a single check point that
        // also covers the Log-hearth featured-pick entry point below, not just this embed-card tap.
        // Without it, tapping the plain `stiq:space:` embed card in an invite DM's body (as opposed
        // to the invitation card itself) silently discarded the grant — Olene's field incident.
        setJoinReqSent(false);
        setJoinNote('');
        embedPreviewSpaceRef.current?.(spaceRef.identifier);
        setJoinReq({groupId: spaceRef.identifier, name: spaceRef.name, gradient: spaceRef.gradient});
      }
      return true;
    }

    const direct = feed.items.find(f => f.id === id);
    if (direct) { pushIfOrigin({kind: 'post', postId: direct.id}); setOpenPost(direct); return true; }
    const summary = onGetEvent?.(id);
    const root = summary?.rootId ? feed.items.find(f => f.id === summary.rootId) : undefined;
    if (root) { pushIfOrigin({kind: 'post', postId: root.id}); setOpenPost(root); return true; }

    // Not a feed post/comment — check whether `id` is a channel broadcast (kind 1311) already
    // cached in one of the user's channels, and land on it (channel + the single-post overlay).
    for (const ch of channels) {
      const msg = onGetChannelMessages(ch.id).find(m => m.id === id);
      if (msg) {
        pushIfOrigin({kind: 'channelPost', postId: id}, 'channels');
        setTab('channels');
        setOpenGroupId(null);
        setChannelDetailOpen(false);
        setOpenChannelId(ch.id);
        setOpenChannelPostId(id);
        return true;
      }
    }
    // Or a group chat/thread/reply message (kinds 9/11/12) — no single-message overlay exists for
    // groups, so opening the group itself is the best available landing.
    for (const g of groups) {
      const msgs = onGetGroupMessages?.(g.id);
      if (msgs?.some(m => m.id === id)) {
        pushIfOrigin({kind: 'group', groupId: g.id}, 'channels');
        setTab('channels');
        setOpenChannelId(null);
        setChannelDetailOpen(false);
        setOpenGroupId(g.id);
        return true;
      }
    }
    // Or the id IS already a channel/LiveActivity coordinate (`30311:<owner>:<d>`) — an unresolved
    // naddr embed decodes to exactly this shape (decodeNostrUri), which is also how Channel.id is
    // keyed (see channels.ts), so a direct id match opens that channel.
    const asChannel = channels.find(c => c.id === id);
    if (asChannel) {
      pushIfOrigin({kind: 'channel', channelId: asChannel.id}, 'channels');
      setTab('channels');
      setOpenGroupId(null);
      setChannelDetailOpen(false);
      setOpenChannelId(asChannel.id);
      return true;
    }
    // Nothing local matched. The onGetEvent lookup above already kicked the relay fetch for the
    // ref, so register a one-shot pending open and let the data-driven retry effect below complete
    // the navigation when the event lands — over Tor the fetch takes seconds, and without this the
    // FIRST tap on any not-yet-cached target reads as a dead button (the fetch succeeded, but
    // nothing ever re-ran the navigation). A retry pass never re-registers: one window per tap.
    if (!retryPass) {
      pendingEmbedOpenRef.current = {
        id,
        expiresAt: Date.now() + PENDING_EMBED_OPEN_MS,
        origin: embedNavFingerprint(),
      };
    }
    return false;
  }, []);

  // Completes a tapped embed whose target wasn't cached at tap time. Runs on every render on
  // purpose (no dep array): the store snapshots that can resolve the target — feed items, channel
  // and group message versions — all arrive via renders, and the null-check makes the idle cost
  // nil. Cleared on success, on expiry, or as soon as the reader navigates somewhere else.
  useEffect(() => {
    const p = pendingEmbedOpenRef.current;
    if (!p) return;
    if (Date.now() > p.expiresAt || embedNavFingerprint() !== p.origin) {
      pendingEmbedOpenRef.current = null;
      return;
    }
    if (openEmbedTarget(p.id, true)) pendingEmbedOpenRef.current = null;
  });

  // ── Close helpers (FIX 1) ────────────────────────────────────────────────────
  // Each closes exactly one overlay/surface and, if the nav-origin stack's TOP entry was pushed FOR
  // that exact surface, pops it and restores wherever the reader came from. Declared here (ahead of
  // messagesContent/logContent/profileContent below, which call them) rather than down by the
  // hardware-back ladder, so those useMemo factories — which run synchronously the first time this
  // function reaches their `useMemo(...)` call — never reference a not-yet-initialized const.
  const closeOpenChannelPostView = (): void => {
    const origin = openChannelPostId !== null ? popNavOriginIfMatches({kind: 'channelPost', postId: openChannelPostId}) : null;
    setOpenChannelPostId(null);
    if (origin) restoreNavOrigin(origin);
  };
  const closeOpenEventView = (): void => {
    const origin = openEventCoord !== null ? popNavOriginIfMatches({kind: 'event', coordinate: openEventCoord}) : null;
    setOpenEventCoord(null);
    setOpenEventRef(null);
    if (origin) restoreNavOrigin(origin);
  };
  // Closing a channel/group that was opened FROM a Log-tab hearth pick or a profile drill-in
  // restores that origin — back should unwind to where the reader actually came from, not strand
  // them on the Channels tab. If a channel-post overlay was ALSO open (openEmbedTarget can land on
  // both at once from a cross-surface tap), closing the whole channel discards that overlay too —
  // try popping its target first, since the channel view unmounting takes it down regardless of
  // whether the reader closed the post overlay first.
  const closeOpenChannelView = (): void => {
    const origin =
      (openChannelPostId !== null ? popNavOriginIfMatches({kind: 'channelPost', postId: openChannelPostId}) : null) ??
      (openChannelId !== null ? popNavOriginIfMatches({kind: 'channel', channelId: openChannelId}) : null);
    setOpenChannelId(null);
    setOpenChannelPostId(null);
    // Also drop the channel-detail sheet flag: leaving it latched meant the NEXT channel could
    // mount its detail Modal already-visible (the Android mount-visible failure) or open straight
    // into the detail sheet instead of the channel (Phase 3.6 reset gap).
    setChannelDetailOpen(false);
    if (origin) restoreNavOrigin(origin);
  };
  const closeOpenGroupView = (): void => {
    const origin = openGroupId !== null ? popNavOriginIfMatches({kind: 'group', groupId: openGroupId}) : null;
    setOpenGroupId(null);
    if (origin) restoreNavOrigin(origin);
  };
  // Close the feed thread-detail overlay. Factored out (from the inline hardware-back branch + the
  // on-screen back button, which must behave identically) so a post opened FROM a notification, a
  // profile, the moderator console, etc. returns to that origin — the openPost twin of
  // closeOpenChannelView's origin-return.
  const closeOpenPostView = (): void => {
    const origin = openPost !== null ? popNavOriginIfMatches({kind: 'post', postId: openPost.id}) : null;
    setOpenPost(null);
    setReplyTarget(null);
    if (origin) restoreNavOrigin(origin);
  };
  const closeOpenPeerView = (): void => {
    const origin = openPeer !== null ? popNavOriginIfMatches({kind: 'dm', peer: openPeer}) : null;
    setOpenPeer(null);
    if (origin) restoreNavOrigin(origin);
  };
  const closeProfileView = (): void => {
    const origin = openProfile !== null ? popNavOriginIfMatches({kind: 'profile', pubkey: openProfile.pubkey}) : null;
    setOpenProfile(null);
    if (origin) restoreNavOrigin(origin);
  };
  // Swipe-back (2026-07-27): NewMessageScreen's <SubScreen> needs the SAME identifier for its
  // onSwipeBack as the screen's own onBack prop (the plan's ownership rule), and that onBack used to
  // be an inline arrow — hoisted here, verbatim, so both call sites share one function instead of two
  // expressions that could drift.
  const closeNewMessageScreen = useCallback((): void => {
    setShowNewMessage(false);
  }, []);

  // No.5 "enable replies": promote the author's channel post into a feed thread. Open the composer
  // (which lives on the feed chrome) preloaded with the post's text; publishing routes to
  // onPromoteChannelPost. A promoted post's tap opens the feed thread via openPromotedFeed.
  const startEnableReplies = useCallback((message: Event): void => {
    setTab('feed');
    setOpenChannelId(null);
    setOpenGroupId(null);
    setChannelDetailOpen(false);
    setPromoteTarget(message);
    setResumeDraft({
      id: `promote:${message.id}`,
      title: '',
      content: decodeNameHeader(message.content).text,
      tags: [],
      savedAt: Date.now(),
    });
    setComposerOpen(true);
  }, []);
  const openPromotedFeed = useCallback((feedId: string): void => {
    setOpenChannelId(null);
    setOpenGroupId(null);
    setChannelDetailOpen(false);
    setTab('feed');
    openEmbedTarget(feedId);
  }, [openEmbedTarget]);
  // No.3: reply count of a promoted post's feed thread — mirrors the feed post's own comment count.
  // Stable per relay snapshot (keyed on `feed`) so the channel views' memoised counts don't churn.
  const getFeedReplyCount = useCallback(
    (feedId: string): number => countComments(onGetThread(feedId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed],
  );
  // BACK RESTORES THE SCROLL POSITION BY DOING NOTHING. There is deliberately no effect here.
  //
  // There used to be one: on Back it looked up the just-read post and called
  // `scrollToIndex({viewPosition: 0.5})`, re-centring that post, with rAF + 150ms + 400ms retries to
  // fight the relay re-render. It worked — and that was the bug. The feed is never unmounted while a
  // post is open (see the thread overlay below: FeedList stays mounted and laid out underneath it,
  // precisely so the native scroll offset survives), so the list is ALREADY at the exact offset the
  // reader left. Re-centring threw that away and moved them somewhere they had never been.
  //
  // Restoring the offset is also the only thing that can work reliably here: FeedList is virtualized
  // with variable item heights and no getItemLayout, so an index-based scroll has to guess an offset
  // and retry (FeedList's onScrollToIndexFailed). The native offset needs no guess and cannot be
  // invalidated by the feed changing underneath it — which is the requirement: leave the feed, come
  // back to the same place, under any circumstances.
  //
  // If a "return to the post you read" affordance is ever wanted again, it must be a visible control
  // the reader chooses, not a scroll that happens to them on Back.
  // ── Search helpers, shared across feed / channels / groups / DMs ──
  // The header search icon toggles `searchActive` in ANY context; each surface renders this same bar
  // and filters its own content by the query. Message bodies carry a name header, so we match on the
  // decoded (visible) text — the exact string shown in the bubble.
  const cancelSearch = useCallback(() => {
    setSearchActive(false);
    setSearchQuery('');
    setTimeSel(ALL_TIME);
  }, []);
  // `showTimeFrame` is off for the channel/people *list* search (rows have no single timestamp to
  // filter on); it's on for post/message searches (feed, open channel, open group). `embedded`
  // renders the bar as the header row's content (the expanding-search takeover) rather than as a
  // standalone hairline-bottomed row (the sub-screens' below-header placement).
  const openTimeSheet = useCallback(() => setTimeSheetOpen(true), []);
  const renderSearchBar = (placeholder: string, showTimeFrame = true, embedded = false): React.JSX.Element => (
    // Keyed on searchActive so a fresh open re-seeds the leaf's draft from the (empty) committed query.
    <SearchBar
      key={searchActive ? 'open' : 'closed'}
      placeholder={placeholder}
      showTimeFrame={showTimeFrame}
      embedded={embedded}
      initialQuery={searchQuery}
      timeSel={timeSel}
      onCommit={setSearchQuery}
      onOpenTimeSheet={openTimeSheet}
      onCancel={cancelSearch}
    />
  );
  // Filter cached messages by their decoded body text (empty query → unchanged). Works for channel
  // and group Events (via .content) and DM messages (via .text).
  const filterMessages = <T,>(
    items: readonly T[],
    getText: (item: T) => string,
    getSeconds?: (item: T) => number,
  ): T[] => {
    const timeFiltered = getSeconds ? filterByTime(items, getSeconds, searchTimeRange) : items;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return timeFiltered as T[];
    return timeFiltered.filter(m => decodeNameHeader(getText(m)).text.toLowerCase().includes(q));
  };
  // True when any of the given fields contains the query (empty query matches everything) — used to
  // filter the channel / group / DM list rows by name.
  const listMatches = (fields: (string | undefined | null)[]): boolean => {
    const q = searchQuery.trim().toLowerCase();
    return !q || fields.some(f => (f ?? '').toLowerCase().includes(q));
  };

  // Existing conversation, or a synthetic empty one when starting a brand-new DM from a profile.
  const openConversation =
    openPeer != null
      ? inbox.find(c => c.peer === openPeer) ?? {
          peer: openPeer,
          peerNpub: safeNpubEncode(openPeer),
          messages: [],
          lastAt: 0,
          preview: '',
        }
      : null;
  const openDM = (pubkey: string): void => {
    setOpenProfile(null);
    setOpenPeer(pubkey);
  };
  const openChannel = channels.find(c => c.id === openChannelId) ?? null;

  // UX safety net: an unresolved openChannelId (see fetchChannelIfUnknown) usually resolves within
  // a second or two, but a fetch that genuinely never lands (send raced a not-yet-open socket, a
  // slow/blocked circuit) must not leave the "Opening channel…" placeholder offering nothing but
  // Back. retryOpenChannel re-issues the metadata fetch on demand — see the placeholder below.
  const retryOpenChannel = (): void => {
    if (!openChannelId) return;
    fetchChannelIfUnknown(openChannelId, channels, onGetEvent);
  };

  // These delegate to the runtime and do full store scans producing fresh objects. Memoise them on
  // [open-id, storeVersions.*] — NOT `feed` (bug #6): channel/group content kinds (LiveChat/
  // LiveActivity/GroupChat/…) are deliberately excluded from the feed cache, so `feed`'s identity
  // never changes for a channel/group-only write and a memo keyed on it would go stale until the
  // user left and re-entered the surface. storeVersions.channels/groups are the scoped signals the
  // data layer itself invalidates on (see AppRuntime.CHANNEL_VIEW_KINDS/GROUP_VIEW_KINDS) — one
  // source of truth, so this can never drift from what onGetChannelMessages/onGetGroupMessages etc.
  // actually read. Recomputes only when the store actually changed — NOT on every local re-render
  // (composer keystrokes, expand/collapse). The callbacks are excluded from deps: they delegate to
  // the current runtime, and including their ever-changing identity would defeat the memo.
  /* eslint-disable react-hooks/exhaustive-deps */
  const channelMsgs = useMemo(
    () => (openChannelId ? onGetChannelMessages(openChannelId) : []),
    [openChannelId, storeVersions.channels],
  );
  // Phase 5 stale-first: an opened channel kicks off a scoped history fetch over Tor
  // (SCOPED_CHANNEL_SYNC → AppRuntime.openChannel), so an empty channelMsgs is "still loading"
  // until that sub settles (EOSE/CLOSED — onIsSpaceSynced) — ChannelView must not claim
  // "No broadcasts yet." in that window. Flag off → no scoped sub ever settles, so the gate
  // must stay open (never-pending) or an empty channel would suppress its empty state forever.
  const channelHistoryPending =
    SCOPED_CHANNEL_SYNC &&
    channelMsgs.length === 0 &&
    openChannelId !== null &&
    onIsSpaceSynced !== undefined &&
    !onIsSpaceSynced(`channel:${openChannelId}`);
  // Open-group prop cluster (finding #4). Each of these is a full store scan and, for a PRIVATE
  // group, a NIP-44 decrypt of the whole history — so computing them inline on every MainScreen
  // render (composer keystrokes, search keystrokes, expand/collapse) re-decrypted the group each
  // time. Memoise on [openGroupId, storeVersions.groups] exactly like channelMsgs so they recompute
  // only once per actual group-content change. groupState is read ~6× at the call site; resolve it
  // once here.
  const openGroupMsgs = useMemo(
    () => (openGroupId ? onGetGroupMessages?.(openGroupId) ?? [] : []),
    [openGroupId, storeVersions.groups],
  );
  // Phase 5 stale-first — GroupView twin of channelHistoryPending above (openGroup's scoped sub is
  // always wired, no flag): suppress "No messages yet." until the group's history replay settles.
  const groupHistoryPending =
    openGroupMsgs.length === 0 &&
    openGroupId !== null &&
    onIsSpaceSynced !== undefined &&
    !onIsSpaceSynced(`group:${openGroupId}`);
  const openGroupState = useMemo(
    () => (openGroupId ? onGetGroupState?.(openGroupId) ?? undefined : undefined),
    [openGroupId, storeVersions.groups],
  );
  const openGroupSettings = useMemo(
    () => (openGroupId ? onGetSpaceSettings?.(openGroupId, 'group')?.settings : undefined),
    [openGroupId, storeVersions.groups],
  );
  // Owner-only: whether this private group currently has a live log offer (community log picker's
  // consent gate) — same kind-30078 store bucket as space settings, so the same version key applies.
  const openLogOffer = useMemo(
    () => (openGroupId ? onGetLogOffer?.(openGroupId) ?? null : null),
    [openGroupId, storeVersions.groups],
  );
  // Self-contained share token for the open group (quick sheet's Share row) — same codec every
  // share-embed surface parses. Needs the owner from relay state; undefined until 39000 arrives.
  const openGroupShareToken = useMemo(() => {
    if (!openGroupId || !openGroupState?.owner) return undefined;
    return encodeSpaceEmbed({
      kind: 39000,
      owner: openGroupState.owner,
      identifier: openGroupId,
      name: openGroupState.name,
      private: !!openGroupState.private,
      gradient: openGroupState.gradient,
    });
  }, [openGroupId, openGroupState]);
  const openGroupMembers = useMemo(
    () => (openGroupId ? onGetGroupMembers?.(openGroupId) ?? [] : []),
    [openGroupId, storeVersions.groups],
  );
  const openGroupAdmins = useMemo(
    () => (openGroupId ? onGetGroupAdmins?.(openGroupId) ?? [] : []),
    [openGroupId, storeVersions.groups],
  );
  const openGroupPending = useMemo(
    () => (openGroupId ? onGetGroupPending?.(openGroupId) ?? [] : []),
    [openGroupId, storeVersions.groups],
  );
  const openGroupReplies = useMemo(
    () => (openGroupId ? onGetGroupReplies?.(openGroupId) : undefined),
    [openGroupId, storeVersions.groups],
  );
  // "Save to embed later" for the currently-open SPACE itself (channel or private group) — the
  // ChannelDetail sheet's pinned onSaveToEmbed row. Branches on whichever surface is actually
  // open; a channel takes priority since ChannelDetail only ever mounts for one.
  const handleSaveSpaceToEmbed = useCallback((): void => {
    const savedAt = Math.floor(Date.now() / 1000);
    const save = openChannel
      ? saveChannelEmbed(openChannel, savedAt)
      : openGroupId
        ? saveSpaceEmbed(
            {id: openGroupId, owner: openGroupState?.owner ?? currentUserPubkey ?? '', name: openGroupState?.name, gradient: openGroupState?.gradient},
            savedAt,
          )
        : null;
    if (!save) return;
    void save
      .then(added => Alert.alert(added ? 'Saved to embed later' : 'Already saved'))
      .catch(() => Alert.alert('Could not save', 'Please try again.'));
  }, [openChannel, openGroupId, openGroupState, currentUserPubkey]);
  // notifLiveRecompute — the notification center used to snapshot onGetNotifications() ONCE at open
  // time (see openNotifications above) and never again, so a reply/DM/channel post/join-request
  // arriving a second after the user opened the bell was invisible until they closed and reopened
  // it. Re-derive on notifOpen AND on every signal AppRuntime's OWN _notifCache key already treats
  // as authoritative for this exact derivation (see its doc) — one source of truth, same reasoning
  // as channelMsgs/threadNodes above keying on the data layer's own invalidation signals:
  //   • feed — Kind.Comment (replies) and Post/Article/Poll/Voice (the Posts source) are all in
  //     FEED_KINDS, so a new one bumps feedVer and this reference changes.
  //   • inbox — a DM decrypts asynchronously into a REBUILT array with NO store-version bump (see
  //     _notifCache's doc); the array identity is the only signal, exactly what the runtime's own
  //     cache keys on.
  //   • storeVersions.channels — channel broadcasts (CHANNEL_VIEW_KINDS ⊇ LiveChat).
  //   • storeVersions.groups — the admin join-request queue (GROUP_VIEW_KINDS ⊇ GroupKind.Pending).
  //   • storeVersions.identity — a name learned after the fact re-renders a row's actor text, same
  //     reasoning as logHearth's identity dependency below.
  //   • storeVersions.draftAccess — share-request/grant/silent-deny (the DEDICATED signal, not the
  //     noisier .config AppData bump every unrelated organizer doc write also shares).
  //   • notifUnreadCount — belt-and-suspenders for a prefs edit or read-state change with no unread
  //     DELTA of its own (e.g. toggling a category that has zero unread rows right now), which none
  //     of the signals above would otherwise catch.
  // Deliberately NOT storeVersions.thread: that counter is scoped to whichever ONE thread is
  // currently open (see its doc below), but the center lists replies across EVERY post the viewer
  // authored — a signal scoped to one open thread would neither help nor mean anything here.
  //
  // Cost: onGetNotifications() (= AppRuntime.deriveNotifications()) is version-cached (_notifCache)
  // and ALREADY runs on every single snapshot regardless of whether this screen is open, just to
  // produce notifUnreadCount for the bell badge — so calling it again here on a coarser,
  // over-inclusive key is a cache-key check (a handful of O(1) counter reads), never a re-scan,
  // whenever nothing in the derivation's own narrower key actually moved. Gated on notifOpen so a
  // background change pays even that small cost only while the center is actually open.
  //
  // Read-state / badge / scroll safety: onGetNotifications is a pure read (no HWM advance, no
  // delivery side effect — see its own doc), so recomputing can never silently mark anything read.
  // The bell badge renders off the notifUnreadCount PROP (above, in the header), never off
  // notifItems, so it cannot flicker from this. A cache hit returns the SAME array reference, so
  // setNotifItems bails out via React's Object.is check with no re-render at all — nothing to
  // reorder or scroll-reset for a tick that changed nothing the center cares about. A genuine change
  // rebuilds the array, but a row keeps its id/ts unless ITS OWN source event changed, and
  // NotificationsScreen sorts with a stable sort — so unrelated rows never reshuffle. A brand-new
  // row's id was never marked read (readState.ts: an unseen id defaults unread), so an item arriving
  // while the screen is open surfaces as unread rather than being silently swallowed.
  // NotificationsScreen itself stays mounted throughout this (only its `items` prop changes), so its
  // own read-tap overlay (readIds/allRead) and the list's native scroll offset are untouched — a new
  // row prepends above whatever the user is currently reading instead of resetting them to the top.
  useEffect(() => {
    if (!notifOpen) return;
    let cancelled = false;
    const handle = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      setNotifItems(onGetNotifications?.() ?? []);
    });
    return () => {
      cancelled = true;
      handle.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    notifOpen,
    feed,
    inbox,
    storeVersions.channels,
    storeVersions.groups,
    storeVersions.identity,
    storeVersions.draftAccess,
    notifUnreadCount,
  ]);
  // Defer the heavy thread build off the opening tap and refresh it only on a REAL thread change.
  // Open the overlay first (setOpenPost, already committed) so the tap returns immediately; compute
  // threadNodes after the touch/animation settles — exactly the openNotifications pattern. Key the
  // recompute on storeVersions.thread (this thread's comment/post/report/mute + local-mute signal),
  // NOT `feed`, so unrelated background churn (likes, DMs, read-state) never rebuilds the open thread
  // while a genuinely new comment on it still does. Guarded against close (openPost null) and against
  // opening a different post before the deferred pass lands (cancel flag + id capture + handle.cancel).
  useEffect(() => {
    if (!openPost) return;
    const postId = openPost.id;
    let cancelled = false;
    const handle = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      setThreadNodes(onGetThread(postId));
    });
    return () => {
      cancelled = true;
      handle.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPost, storeVersions.thread]);
  const pinnedHistory = useMemo(
    () => (openPost && onGetPinnedHistory ? onGetPinnedHistory(openPost.id, openPost.authorPubkey) : null),
    [openPost, feed],
  );
  // The hearth comes from the organizer's signed stiq:log-page doc resolved against live space +
  // identity metadata, NOT from the feed cache — a config-only write never moves `feed`, so keying
  // on the scoped signals keeps a freshly published note/pick visible immediately (#6): config (the
  // doc itself), channels/groups (a space renaming itself), identity (a person's learned name).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const logHearth = useMemo(
    () => (tab === 'log' ? onGetLogPage?.() ?? null : null),
    [tab, storeVersions.config, storeVersions.channels, storeVersions.groups, storeVersions.identity],
  );
  // Mod log is a full store scan — compute only while the Log tab is open, once per snapshot.
  const modLog = useMemo(() => (tab === 'log' ? onGetModLog?.() ?? [] : []), [tab, feed]);
  // Moderator console data (member-report queue + active bans). Also store scans, so compute only
  // on the Log tab — where the console is opened from — and once per snapshot (keyed on feed).
  const pendingReports = useMemo(
    () => (tab === 'log' ? onGetPendingReports?.() ?? [] : []),
    [tab, feed],
  );
  const bannedMembers = useMemo(
    () => (tab === 'log' ? onGetBannedMembers?.() ?? [] : []),
    [tab, feed],
  );
  const loggedAuthors = useMemo(
    () => (tab === 'log' ? onGetLoggedAuthors?.() ?? [] : []),
    [tab, feed],
  );
  // The original post + thread behind the open mod-log entry (Overlay B). Resolved lazily and
  // ONLY while the modal is actually open — keyed on `logPostInfo`, so a closed modal costs
  // nothing per feed snapshot. `lastLogPostInfo` + the value ref retain the LAST RESOLVED content
  // through the modal's fade-out (the always-mount rule) without recomputing it.
  const [lastLogPostInfo, setLastLogPostInfo] = useState<LogPostOpenInfo | null>(null);
  useEffect(() => {
    if (logPostInfo) setLastLogPostInfo(logPostInfo);
  }, [logPostInfo]);
  const shownLogPostInfo = logPostInfo ?? lastLogPostInfo;
  const logPost = useMemo(
    () => (logPostInfo && onGetLogPost ? onGetLogPost(logPostInfo.targetId) : null),
    [logPostInfo, feed],
  );
  const lastLogPostRef = useRef<ReturnType<NonNullable<typeof onGetLogPost>> | null>(null);
  if (logPost) lastLogPostRef.current = logPost;
  const shownLogPost = logPost ?? lastLogPostRef.current;
  // Leaving the Log tab (a notification route, a pick that jumps to Channels) closes the record's
  // stacked views so returning to the tab lands on the hearth, not a stale drill-in — and drops
  // the retained post payload so nothing keeps resolving (or holding a thread) for a dead modal.
  useEffect(() => {
    if (tab === 'log') return;
    setCommunityLogOpen(false);
    setOpenLogEntryKey(null);
    setLogPostInfo(null);
    setLastLogPostInfo(null);
    lastLogPostRef.current = null;
  }, [tab]);
  // The viewer's own identity. The full buildProfile() is an expensive per-snapshot store scan, but
  // the feed chrome (compose bar + header avatar + composer) needs ONLY the crafted gradient — which
  // is already resolved cheaply (and cached via the gradients identity module) onto any feed item the
  // viewer authored. Read the gradient from there so the scroll-critical path never runs buildProfile;
  // a ref remembers the last known value so it survives snapshots where no self-authored item is
  // visible. GradientAvatar.resolveSpec falls back to the npub seed when there's no crafted gradient —
  // identical to buildProfile returning gradient: undefined, so appearance is unchanged.
  const myGradientRef = useRef<GradientSpec | undefined>(undefined);
  const myGradient = useMemo(() => {
    if (!currentUserPubkey) return undefined;
    // The runtime-provided crafted gradient wins outright: identity edits bump identityVersion and
    // emit, so this prop is fresh on the very render after a Profile save. The feed-item scan stays
    // as the fallback for callers that don't pass the prop.
    if (myCraftedGradient) {
      myGradientRef.current = myCraftedGradient;
      return myCraftedGradient;
    }
    const own = feed.items.find(i => i.authorPubkey === currentUserPubkey)?.authorGradient;
    if (own) myGradientRef.current = own;
    return own ?? myGradientRef.current;
  }, [currentUserPubkey, feed, myCraftedGradient]);
  // The FULL profile (posts / channels / idea-count) is read ONLY by the Settings surface and the
  // viewer's own profile overlay. Build it lazily — never on the plain feed path. While Settings is
  // open we rebuild per snapshot (not the scroll-critical path); a ref preserves the value through the
  // modal's close animation and also captures the freshest crafted gradient for the header avatar.
  const myProfileRef = useRef<Profile | undefined>(undefined);
  const myProfile = useMemo(() => {
    if (settingsOpen && currentUserPubkey && onGetProfile) {
      const built = onGetProfile(currentUserPubkey);
      myProfileRef.current = built;
      if (built.gradient) myGradientRef.current = built.gradient;
    }
    return myProfileRef.current;
  }, [settingsOpen, currentUserPubkey, feed]);
  // Build the viewer's full profile on demand (avatar tap) so the store scan runs only when the
  // profile overlay actually opens.
  const openMyProfile = useCallback(() => {
    if (currentUserPubkey && onGetProfile) setOpenProfile(onGetProfile(currentUserPubkey));
  }, [currentUserPubkey]);
  // ComposerScreen's saved-posts list (finding #4): a feed scan per bookmark id, previously rebuilt on
  // EVERY MainScreen render even while the composer was closed. Compute only when the composer is open,
  // once per snapshot. bookmarkedPostIds is in deps because toggling a bookmark must refresh the list.
  const savedPosts = useMemo(
    () =>
      !composerOpen
        ? []
        : bookmarkedPostIds
            // A bookmarked post that isn't in the visible feed (e.g. one saved from the mod log) is
            // resolved straight from the store, so it's still offered as a saved embed.
            .map(id => feed.items.find(f => f.id === id) ?? onGetPostItem?.(id) ?? null)
            .filter((f): f is FeedItem => !!f)
            .map(f => ({
              id: f.id,
              title: f.title || f.content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'post',
              snippet: inlineMediaSummary(f.summary || f.content).slice(0, 100),
              name: f.authorName,
              gradient: f.authorGradient,
            })),
    [composerOpen, feed, bookmarkedPostIds],
  );
  // Saved event-card tokens ("Add to my embeds") for the composer's 🔖 picker. The saved-embeds
  // store loads async once; the version bump re-reads the sync module cache after it lands and
  // after every composer open (an event may have been bookmarked since the last one).
  const [savedEmbedsVersion, setSavedEmbedsVersion] = useState(0);
  useEffect(() => {
    if (composerOpen) void ensureSavedEmbedsLoaded().then(() => setSavedEmbedsVersion(v => v + 1));
  }, [composerOpen]);
  const savedEmbedTokens = useMemo(
    () =>
      !composerOpen
        ? []
        : // Every saved embed is offered here — posts/comments, public channel posts, spaces, events,
          // private-space posts, and drafts — so the feed composer can embed anything the user saved,
          // not just event cards. Each carries `private` so the composer confirms before inserting a
          // private-sourced token (its content travels with it).
          listSavedEmbeds().map(it => ({
            id: it.id,
            label: savedEmbedRowLabel(it),
            title: it.name?.trim() || (it.draftToken ? 'Untitled draft' : it.msgToken ? 'Private post' : 'Saved post'),
            uri: savedEmbedUri(it),
            private: savedEmbedIsPrivate(it),
          })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composerOpen, savedEmbedsVersion],
  );
  const removeSavedEmbedToken = useCallback((id: string): void => {
    void removeEmbed(id).then(() => setSavedEmbedsVersion(v => v + 1)).catch(() => {});
  }, []);
  // Save a read-only `msg` embed (a private-space post quote) onward into the viewer's OWN embed
  // picker — the token is self-contained, so this is just storing it verbatim keyed by the token
  // itself. A DRAFT embed no longer offers this action from the reader: re-saving the same v2
  // POINTER token would just be "re-share this exact embed", which Phase 5's access-control model
  // explicitly forbids (EmbedReader's header only ever calls this for `t.msg` now — see its module
  // doc). Forking a DELIVERED COPY (`forkDraftFromDelivery` below) is the only onward path for a draft.
  const saveReaderEmbedOnward = useCallback((t: EmbedReaderTarget): void => {
    if (!t.msg) return;
    const savedAt = Math.floor(Date.now() / 1000);
    void saveMessageEmbed(
      {id: t.token, token: t.token, author: t.msg.author, kind: t.msg.kind, name: t.msg.name},
      savedAt,
    ).then(() => { setReaderSavedToken(t.token); setSavedEmbedsVersion(v => v + 1); }).catch(() => {});
  }, []);
  // Share a DRAFT as a `stiq:draft:` v2 POINTER (Phase 5§A) — a teaser, NEVER the full body; that is
  // the security property the whole access-control model rests on. Mints the draft's stable
  // `shareId` ONCE, at first share (feed/drafts.ts's `newShareId` doc), and persists it back onto the
  // draft so a later edit or re-share keeps addressing the SAME access-control doc and the SAME
  // comment thread. `draftExcerptWouldTrim` still warns first when the shared excerpt won't be the
  // whole (short) piece — the full draft always stays intact in Drafts either way.
  const saveDraftAsEmbed = useCallback((draft: Draft): void => {
    const author = currentUserPubkey ?? undefined;
    const shareId = draft.shareId ?? newShareId(author ?? '', draft.content);
    const commit = (): void => {
      if (!draft.shareId) {
        const withShareId: Draft = {...draft, shareId};
        void draftStore?.save(withShareId);
        setDraftList(list => list.map(d => (d.id === draft.id ? withShareId : d)));
      }
      const token = encodeDraftEmbed({
        id: shareId,
        title: draft.title,
        excerpt: sanitizeBody(draft.content, MAX_DRAFT_EXCERPT_LEN),
        author,
        authorName: author ? onGetProfile?.(author)?.name : undefined,
        authorGradient: myGradient,
      });
      void saveDraftEmbed({token, title: draft.title, author}, Math.floor(Date.now() / 1000))
        .then(() => setSavedEmbedsVersion(v => v + 1))
        .catch(() => {});
    };
    if (draftExcerptWouldTrim(draft.content)) {
      Alert.alert(
        'Share a preview only',
        'This embed shows readers a short excerpt, never the full piece — the full writing is only delivered to people you approve. The complete draft stays in your Drafts either way.',
        [{text: 'Cancel', style: 'cancel'}, {text: 'Share preview', onPress: commit}],
      );
    } else {
      commit();
    }
  }, [currentUserPubkey, myGradient, onGetProfile, draftStore]);
  /** An OWNER's own live draft, read straight from the local, already-loaded `draftList` echo of the
   *  DraftStore (Phase 5§E: "an owner reads their live local draft instead" of a `DraftDelivery` —
   *  they are never their own requester, so there is nothing to decrypt). Mirrors the snapshot shape
   *  `AppRuntime.approveDraftAccess` builds for a REAL delivery, byte-for-byte. */
  const getOwnerDraftSnapshot = useCallback((shareId: string): DraftDeliverySnapshot | null => {
    const d = draftList.find(x => x.shareId === shareId);
    if (!d) return null;
    const snap: DraftDeliverySnapshot = {b: d.content};
    if (d.title) snap.ti = d.title;
    if (d.tags.length > 0) snap.tg = [...d.tags];
    if (d.label) snap.l = d.label;
    if (d.contentWarning) snap.cw = d.contentWarning;
    return snap;
  }, [draftList]);
  /** Fork a delivered/owned draft snapshot into the viewer's OWN Drafts ("Save a copy to my drafts",
   *  Phase 5§E) — the only onward path once unlocked. Deliberately mints NO `shareId`: ownership has
   *  genuinely changed, so one is minted fresh (feed/drafts.ts's `newShareId`) only when the forker
   *  first shares THEIR copy themselves (`saveDraftAsEmbed` above), starting a new access-list and a
   *  new comment thread rather than colliding with the original. */
  const forkDraftFromDelivery = useCallback((ref: DraftRef, snapshot: DraftDeliverySnapshot): void => {
    const forked: Draft = {
      id: newDraftId(),
      title: snapshot.ti ?? ref.title ?? '',
      content: snapshot.b,
      tags: snapshot.tg ? [...snapshot.tg] : [],
      savedAt: Math.floor(Date.now() / 1000),
      label: snapshot.l ?? null,
      contentWarning: snapshot.cw,
    };
    void draftStore?.save(forked);
    setDraftList(list => [forked, ...list]);
  }, [draftStore]);
  // Phone book = everyone you can recognise: people you DM, channel owners, and group members —
  // deduped by pubkey, you excluded (bech32 encode + profile store scan per contact + a group-member
  // store scan per group). Extracted so it feeds BOTH the NewMessageScreen memo (below) and the
  // GroupView "add member" contact picker (via onGetPhonebook) without duplicating the dedupe/resolve.
  const buildPhonebookContacts = (): Contact[] => {
    const map = new Map<string, Contact>();
    const add = (pk?: string | null): void => {
      if (!pk || pk === currentUserPubkey || map.has(pk)) return;
      map.set(pk, {
        pubkey: pk,
        npub: safeNpubEncode(pk),
        name: onGetProfile?.(pk)?.name,
        gradient: onGetProfile?.(pk)?.gradient ?? null,
      });
    };
    inbox.forEach(c => add(c.peer));
    channels.forEach(c => add(c.owner));
    groups.forEach(g => onGetGroupMembers?.(g.id)?.forEach(add));
    return [...map.values()];
  };
  // NewMessageScreen contact list (finding #5): previously rebuilt inline on every render while the
  // modal was open. Compute only when it's open, once per snapshot.
  const newMessageContacts = useMemo<Contact[]>(
    () => (showNewMessage ? buildPhonebookContacts() : []),
    [showNewMessage, feed, inbox, channels, groups, currentUserPubkey],
  );
  const newMessageChannels = useMemo(
    () =>
      !showNewMessage
        ? []
        : channels.map(c => ({
            id: c.id,
            name: c.name,
            gradient: c.gradient,
            openCommunity: c.openCommunity,
            about: c.about,
          })),
    [showNewMessage, channels],
  );

  // Memoised tab *elements*: when a relay snapshot re-renders MainScreen, these keep the same element
  // reference (unless their own data changed), so React skips reconciling the whole subtree. Callbacks
  // are intentionally excluded from deps — they delegate to the current runtime and would otherwise
  // change identity every App render, defeating the memo.
  // DMs render as an overlay (no dedicated tab — access via Profile → Message)
  const peerBlocked = openPeer != null ? (isUserBlocked?.(openPeer) ?? false) : false;
  const messagesContent = useMemo(() => {
    if (openPeer === null) return null;
    return openConversation ? (
      <ConversationView
        key={openConversation.peer}
        conversation={openConversation}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        picturesSpentBytes={picturesSpentBytes}
        postRules={postRules}
        selfPubkey={currentUserPubkey ?? ''}
        peerDisplayName={onGetProfile?.(openConversation.peer)?.name}
        getPeerGradient={pk => onGetProfile?.(pk)?.gradient}
        peerNpub={openConversation.peerNpub}
        onSend={(text, replyTo) => onSendDm(openConversation.peer, text, replyTo)}
        onReact={onReactDm ? (rid, emoji) => onReactDm(openConversation.peer, rid, emoji) : undefined}
        onRetry={onRetryDm ? echoId => onRetryDm(openConversation.peer, echoId) : undefined}
        onBack={closeOpenPeerView}
        onOpenProfile={onGetProfile ? () => setOpenProfile(onGetProfile(openConversation.peer)) : undefined}
        onLookupEvent={onGetEvent}
        onOpenNostrPost={openEmbedTarget}
        onOpenInviteLink={onAcceptInviteLink}
        blocked={peerBlocked}
        onBlock={onBlockUser ? () => onBlockUser(openConversation.peer) : undefined}
        onUnblock={onUnblockUser ? () => onUnblockUser(openConversation.peer) : undefined}
        draftStore={draftStore}
        onOpenDrafts={() => { void openDrafts(); }}
      />
    ) : (
      <InboxList
        conversations={inbox}
        onOpen={setOpenPeer}
        getPeerName={pubkey => onGetProfile?.(pubkey)?.name}
        getPeerGradient={pubkey => onGetProfile?.(pubkey)?.gradient}
      />
    );
    // storeVersions.identity: a learned peer name/gradient (post/DM/beacon) must refresh the open
    // conversation's header (bugs #10/#11) even though `openConversation` itself is unchanged.
    // openEmbedTarget: listed for correctness, but its identity is now genuinely stable ([] deps,
    // reading feed/channels/groups through refs) — it no longer churns this memo on every relay
    // snapshot the way its former [feed, channels, groups] deps did.
  }, [openPeer, openConversation, inbox, currentUserPubkey, peerBlocked, allowVoice, draftStore, storeVersions.identity, openEmbedTarget]);

  const logContent = useMemo(() => {
    if (tab !== 'log') return null;
    return (
      <LogScreen
        isModerator={isModerator}
        hearth={logHearth}
        logOpen={communityLogOpen}
        onSetLogOpen={open => {
          setCommunityLogOpen(open);
          // Leaving the record clears its stacked views, exactly like the design's closeLog.
          if (!open) {
            setOpenLogEntryKey(null);
            setLogPostInfo(null);
          }
        }}
        onOpenPick={(ref, type, name) => {
          cancelSearch();
          if (type === 'channel') {
            // `ref` is a native `30311:<owner>:<d>` coordinate (a `stiq:space:` link was already
            // decoded to one in currentFeaturedSpaces). If its definition hasn't reached this device
            // yet — the firehose is newest-N bounded, so an unjoined channel's 30311 may be absent —
            // fetch it by naddr, exactly as tapping a space-embed card does, so the channel view
            // resolves instead of showing a blank screen. No auto-subscribe: this is view-only.
            if (!channels.some(c => c.id === ref)) {
              const parts = ref.split(':');
              if (parts.length === 3) {
                try {
                  onGetEvent?.(
                    nip19.naddrEncode({kind: Number(parts[0]), pubkey: parts[1]!, identifier: parts[2]!}),
                  );
                } catch {
                  /* malformed coordinate — nothing to fetch */
                }
              }
            }
            markSourceSeen(chSeenId(ref), onGetChannelMessages(ref));
            setChannelDetailOpen(false);
            // The rail lives on the Log tab, but the channel view only renders under the Channels tab —
            // switch tabs or the tap sets openChannelId against nothing on screen (a dead tap).
            // Remember this hearth pick as the nav-origin (FIX 1) so closing the channel returns to
            // the Log tab instead of stranding the reader on the Channels tab.
            pushNavOrigin({kind: 'tabRoot', tab: 'log'}, {kind: 'channel', channelId: ref});
            setTab('channels');
            setOpenChannelId(ref);
          } else if (type === 'user') {
            // A featured person opens as their profile — the same route as tapping any post author.
            // The profile overlay renders above any tab, so no tab switch is needed here.
            if (onGetProfile) setOpenProfile(onGetProfile(ref));
          } else if (groups.some(g => g.id === ref)) {
            // A joined group renders under the Channels tab — switch or it's a dead tap.
            pushNavOrigin({kind: 'tabRoot', tab: 'log'}, {kind: 'group', groupId: ref});
            setTab('channels');
            setOpenGroupId(ref);
          } else {
            // Not (yet) a member — the organizer may feature private/closed groups too. Offer the
            // same locked preview a stiq:space embed opens; the pick's carried name labels it
            // until onPreviewSpace hydrates the real metadata.
            setJoinReqSent(false);
            setJoinNote('');
            onPreviewSpace?.(ref);
            setJoinReq({groupId: ref, name});
          }
        }}
        entries={modLog}
        getProfile={onGetProfile}
        openEntryKey={openLogEntryKey}
        onOpenEntry={setOpenLogEntryKey}
        onOpenLogPost={info => setLogPostInfo(info)}
        onRestore={onModerationRestore}
        onOpenModTools={isModerator ? () => setModConsoleOpen(true) : undefined}
        pendingReportCount={pendingReports.length}
        restoreHearthOffset={logHearthScrollYRef.current}
        onHearthScroll={y => { logHearthScrollYRef.current = y; }}
      />
    );
    // `logHearth` is a load-bearing dep, not decoration: it comes from an organizer config doc
    // that moves independently of the feed, so omitting it would leave a freshly published
    // note/pick computed-but-never-rendered until some unrelated log change rebuilt this.
  }, [tab, isModerator, logHearth, communityLogOpen, openLogEntryKey, modLog, pendingReports.length]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Feed chrome (compose bar + sort/tag filters) lives INSIDE the feed list as its header,
  // so it simply scrolls away with the content and sits at the top — no show/hide animation.
  // Only built on the feed tab so its tag-chip mapping never runs while another tab is open.
  // The redesigned "Quiet" sort + tags bar (design handoff · Direction A). Sort renders as plain
  // text with a 2px accent underline on the active mode (echoing the tab underline directly above);
  // tags are hairline chips, with a single soft-accent fill on the active one ("one accent at a
  // time" — no more two competing blue pills, no `|` divider). Shared verbatim by the feed chrome
  // and the search view so the controls look and behave identically whether or not search is open.
  // `keyboardShouldPersistTaps="handled"` is what keeps each chip tappable on the FIRST touch while
  // the search keyboard is up — without it the first tap only dismisses the keyboard.
  // `activeSort`/`onSelectSort` are passed in so the same bar can drive either the feed's persisted
  // `sort` (feed chrome) or the independent `searchSort` (search view) — matching the arrangeFeed
  // memo's `activeSort = searchActive ? searchSort : sort`.
  const renderQuietBar = (
    sorts: SortMode[],
    activeSort: SortMode,
    onSelectSort: (m: SortMode) => void,
  ): React.JSX.Element => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // Dragging this sort/tag rail scrolls it, rather than switching tab (the stage swipe stands
      // down while a finger is on it). Its chips stay tappable — a tap never claims the swipe.
      {...railTouchHandlers}
      style={styles.qbar}
      contentContainerStyle={styles.qbarContent}>
      <View style={styles.qsortGroup}>
        {sorts.map((mode: SortMode) => (
          <Press key={mode} style={styles.qsort} onPress={() => onSelectSort(mode)}>
            <Text style={[styles.qsortText, activeSort === mode && styles.qsortTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {mode === 'hot' ? 'Rising' : mode === 'new' ? 'New' : 'Top'}
            </Text>
            {activeSort === mode && <View style={styles.qsortUnderline} />}
          </Press>
        ))}
      </View>
      <View style={styles.qtagGroup}>
        <Press
          style={[styles.qchip, selectedTags.length === 0 && styles.qchipActive]}
          onPress={() => { setSelectedTags([]); void AsyncStorage.setItem(TAGS_STORAGE_KEY, '[]'); }}>
          <Text style={[styles.qchipText, selectedTags.length === 0 && styles.qchipTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>All</Text>
        </Press>
        {orderedTags.map(({tag: t}) => {
          const active = selectedTags.includes(t);
          return (
            <Press key={t} style={[styles.qchip, active && styles.qchipActive]} onPress={() => toggleTag(t)}>
              <Text style={[styles.qchipText, active && styles.qchipTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t}</Text>
            </Press>
          );
        })}
      </View>
    </ScrollView>
  );

  const feedChrome = !onFeedTab ? null : (
    <View style={styles.chromeWrapper}>
      {/* Sort + tag filter row — redesigned "Quiet" bar (drives the feed's persisted sort) */}
      {renderQuietBar(['hot', 'new'], sort, changeSort)}
      {/* Inline composer (pinned) — opens the full composer on tap */}
      <Press variant="row" style={styles.composer} onPress={startNewPost}>
        <GradientAvatar gradient={myGradient} seed={currentUserPubkey ?? ''} size={30} />
        <View style={styles.cfield}>
          <Text style={styles.ctext} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Share an idea…</Text>
          <Text style={{fontSize: 15, color: colors.textMuted}} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✎</Text>
        </View>
      </Press>
    </View>
  );

  // Throttle the activity ping: at most once per 2 s so it doesn't block JS on every touch.
  const lastActivityRef = React.useRef(0);
  const handleTouchStart = React.useCallback((): void => {
    const now = Date.now();
    if (now - lastActivityRef.current > 2000) {
      lastActivityRef.current = now;
      onUserActivity?.();
    }
  }, [onUserActivity]);

  // Bug #3: once the CACHED slice is exhausted (hasMoreFeed false — every locally-known item is
  // already on screen), also stream in older history from the relay via onLoadOlderFeed. Re-entrancy
  // guard mirrors ChannelView/GroupView's own onLoadOlder wiring — don't refire within 1.5s unless
  // the local feed has since grown (a page actually landed); requestOlder's own subKey de-dup
  // handles an in-flight request, this just stops a stationary scroll-to-bottom from spamming it.
  const olderFeedGuardRef = useRef({lastCalledAt: 0, lastLength: feed.items.length});
  // Reveal the next page (also fired automatically by the feed's onEndReached as the user nears
  // the bottom — see FeedList). Guarded on hasMoreFeed so repeated end-reached events are no-ops.
  const loadMore = useCallback(() => {
    if (hasMoreFeed) { setFeedLimit(n => n + 25); return; }
    if (!onLoadOlderFeed || feed.items.length === 0) return;
    const guard = olderFeedGuardRef.current;
    const now = Date.now();
    if (now - guard.lastCalledAt < 1500 && feed.items.length === guard.lastLength) return;
    guard.lastCalledAt = now;
    guard.lastLength = feed.items.length;
    const oldest = feed.items.reduce((min, it) => Math.min(min, it.createdAt), Infinity);
    onLoadOlderFeed(oldest);
  }, [hasMoreFeed, onLoadOlderFeed, feed.items]);
  // Quiet fallback footer: infinite scroll handles paging, so this is just a subtle affordance
  // (and a tap target) shown while more items remain — not the primary mechanism.
  const loadMoreFooter = hasMoreFeed ? (
    <Press style={styles.loadMoreBtn} onPress={loadMore}>
      <Text style={styles.loadMoreText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Load more</Text>
    </Press>
  ) : null;

  // Profile overlay — memoised so relay snapshots don't re-render it (same pattern as messagesContent).
  // Callbacks (onSetDisplayName/onSetGradient) are deliberately excluded from the deps: they
  // delegate to the current runtime and change identity every App render, which would defeat the memo.
  const profileContent = useMemo(() => {
    if (!openProfile) return null;
    return (
      // Absolute overlay covering the tab stage (whose origin already clears the iOS notch — see
      // the stage note; the header unmounts while a profile is open, so the stage spans the root).
      // ProfileScreen's own root is a plain View, so no extra inset is needed here.
      // Swipe-back (2026-07-27): onSwipeBack is closeProfileView — the SAME function the BackButton
      // right below calls — per the plan's ownership rule.
      <SwipeBackOverlay onSwipeBack={closeProfileView} style={[styles.flex, styles.profileOverlay]}>
        <BackButton label="Back" onPress={closeProfileView} style={styles.backBtn} />
        <ProfileScreen
          profile={openProfile}
          ideaCount={openProfile.ideaCount}
          editable={openProfile.pubkey === currentUserPubkey}
          onSaveName={openProfile.pubkey === currentUserPubkey ? onSetDisplayName : undefined}
          onSetGradient={openProfile.pubkey === currentUserPubkey ? onSetGradient : undefined}
          onOpenDM={openProfile.pubkey !== currentUserPubkey ? (pk => {
            // Remember this profile (+ the tab we came from) so BACK from the DM returns here —
            // openDM itself must stay memory-free (NewMessageScreen also calls it), so the push
            // lives here at the call site instead.
            pushNavOrigin({kind: 'profile', pubkey: openProfile.pubkey, tab}, {kind: 'dm', peer: pk});
            openDM(pk);
          }) : undefined}
          onOpenChannel={id => {
            cancelSearch();
            // Remember this profile (+ the tab we came from) so BACK from the channel returns here
            // instead of stranding the reader on the channels list.
            pushNavOrigin({kind: 'profile', pubkey: openProfile.pubkey, tab}, {kind: 'channel', channelId: id});
            setOpenProfile(null);
            setTab('channels');
            fetchChannelIfUnknown(id, channels, onGetEvent);
            setOpenChannelId(id);
          }}
          onOpenPost={item => {
            pushNavOrigin({kind: 'profile', pubkey: openProfile.pubkey, tab}, {kind: 'post', postId: item.id});
            setOpenProfile(null);
            setOpenPost(item);
            setTab('feed');
          }}
        />
      </SwipeBackOverlay>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProfile, currentUserPubkey]);

  // Memoised wrappers for ChannelList props — stable identity per render, and undefined when the
  // underlying prop is absent (so ChannelList's own "is this provided?" checks stay correct).
  const channelListGetGroupState = useMemo(
    () => (onGetGroupState ? (id: string) => onGetGroupState(id) ?? undefined : undefined),
    [onGetGroupState],
  );

  // Channels 2.0 §9 — denser sub-screens: the persistent top chrome (Stiq. wordmark + profile bar and
  // the Feed/Channels/Log tabs) shows ONLY on an inbox. On any sub-screen (a channel, DM, post detail,
  // create, new-message) it's hidden to reclaim ~85px of vertical space; each sub-screen carries its
  // own back control in its header row.
  // The Log tab's community-log view is deliberately absent: it renders as a full-screen Modal
  // that COVERS the chrome (the design's inset:0 overlay), so hiding the chrome underneath would
  // only cause a layout jump seen through the overlay's slide-in.
  // openPeer is deliberately NOT nested under `tab === 'channels'` — a DM opened from a
  // notification (or any other cross-tab origin) can land with `tab === 'feed'` (FIX 1's
  // navigateToNotification / restoreNavOrigin dm branches never change tab), and the dock/header
  // must hide for it on ANY tab, not just Channels.
  const onSubScreen =
    openProfile !== null ||
    (tab === 'feed' && openPost !== null) ||
    openPeer !== null ||
    (tab === 'channels' &&
      (openChannelId !== null || openGroupId !== null || showCreateChannel || showNewMessage));

  // Tap-latency fix (2026-07-22 follow-up round): while ANY opaque full-screen surface covers the
  // tab stage — a drill-in sub-screen, or one of the full-screen Modal sub-screens (notifications
  // center, composer, settings, drafts, moderator console, events organizer, community log, the
  // log full-post view) — the tab bodies beneath cannot be seen or touched, so re-rendering them
  // is pure tap-latency tax. FeedList's props include per-render inline lambdas (renderItem churn
  // → every visible PostCard re-renders, RichText and all), which made the OPENING commit of a
  // post/notifications pay a few hundred debug-build milliseconds for pixels behind an opaque
  // cover. TabLayer's `covered` freezes the subtree in that very commit; the closing commit
  // unfreezes it with the latest props, so the underlay is repainted fresh in the same frame the
  // cover comes down. Deliberately EXCLUDES partial sheets (TimeFrameSheet, detail menus, pickers)
  // — the stage stays visible under those.
  const tabsCovered =
    onSubScreen ||
    notifOpen ||
    composerOpen ||
    settingsOpen ||
    draftsOpen ||
    (modConsoleOpen && isModerator) ||
    eventsOrgOpen ||
    communityLogOpen ||
    logPostInfo !== null ||
    openEventCoord !== null ||
    embedReader !== null;

  // Cross-tab transition (Phase 4.2): when a DOCK press changes the top-level tab, the whole tab
  // stage fades in from transparent — a soft, clearly-visible ease-in on the dark theme (a
  // bg-coloured scrim is invisible here, and content opacity reads on any background). This replaces
  // the classic-Animated tabContentFade, whose native-driver graph conflicted with the feed's
  // Animated scroll chrome and forced the Feed body to be carved out (the old "never Animated-wrap
  // the feed" landmine). Reanimated's worklet runtime is independent of classic Animated's native
  // node graph, so the fade wraps ALL THREE tabs uniformly — device checklist item: search-over-feed
  // + tab switching must not hang (fallback if it ever does: drop stageAnim from the stage and fades
  // die, nothing else).
  // The fade is ARMED only by a deliberate NAV GESTURE — a dock press or a stage swipe. It is a
  // gesture affordance, not a property of `tab` changing. Programmatic tab jumps — a channel/group
  // pick on the Updates hearth, an embed card, a profile drill-in, a nav-origin restore on close,
  // hardware back — must land INSTANTLY: fading there blanks the app for 260 ms and (worse) lets the
  // target tab's bare list show through while the destination sub-screen mounts over it, which reads
  // as a flicker through a wrong screen. Sub-screen opens/closes inside a tab never touch the stage
  // either (they animate themselves via SubScreen). Under jest the reanimated mock applies
  // withTiming's final value synchronously, so no timer can outlive a unit test.
  //
  // A SWIPE additionally arms a direction, and the incoming stage slides in from the side the finger
  // swept away — the short travel that tells the reader which way along the row they just moved. A
  // dock press has no direction (you can jump two tabs at once) and stays the plain crossfade.
  const stageOpacity = useSharedValue(1);
  const stageShift = useSharedValue(0);
  const stageFadeArmedRef = useRef(false);
  const stageSlideRef = useRef<-1 | 0 | 1>(0);
  useLayoutEffect(() => {
    if (!stageFadeArmedRef.current) return;
    stageFadeArmedRef.current = false;
    const dir = stageSlideRef.current;
    stageSlideRef.current = 0;
    const curve = {duration: 260, easing: ReEasing.out(ReEasing.quad)};
    stageOpacity.value = 0;
    stageOpacity.value = withTiming(1, curve);
    if (dir !== 0) {
      stageShift.value = dir * STAGE_SLIDE;
      stageShift.value = withTiming(0, curve);
    }
  }, [tab, stageOpacity, stageShift]);
  const stageAnim = useAnimatedStyle(() => ({
    opacity: stageOpacity.value,
    transform: [{translateX: stageShift.value}],
  }));

  // ── Top-level tab selection (dock press · stage swipe) ────────────────────────
  // ONE handler behind both gestures so what navigation DOES can never drift between them: clear the
  // nav-origin stack (FIX 1 — a top-level nav is not a "back", so no later back press may restore a
  // return point from before it), drop any live search, then switch and reset that tab's sub-state
  // exactly as the old top tab bar did. `direction` only decorates the transition (see stageSlideRef
  // above). Arming happens ONLY when the tab really changes — arming on a re-press would leave a
  // stale flag for the NEXT, possibly programmatic, tab change to wrongly consume as a fade.
  //
  // `opts.viaBack` marks a switch driven by closeInnermostOverlay's own tab-history pop: that switch
  // must NOT push the tab it's leaving back onto the same history, or BACK would ping-pong between two
  // tabs forever instead of ever exhausting the stack. Every other caller (dock press, stage swipe)
  // passes no opts, so a genuine forward tab-visit always records the tab being left.
  const selectTab = useCallback(
    (next: Tab, direction: -1 | 0 | 1, opts?: {viaBack?: boolean}): void => {
      navStackRef.current = [];
      cancelSearch();
      if (next !== tab) {
        if (!opts?.viaBack) {
          tabHistoryRef.current.push(tab);
          if (tabHistoryRef.current.length > 32) tabHistoryRef.current.shift();
        }
        stageFadeArmedRef.current = true;
        stageSlideRef.current = direction;
      }
      setTab(next);
      if (next === 'feed') setOpenPost(null);
      if (next === 'channels') {
        setOpenChannelId(null);
        setChannelDetailOpen(false);
        setShowCreateChannel(false);
        setShowNewMessage(false);
        setOpenGroupId(null);
      }
    },
    [tab, cancelSearch],
  );

  // A sideways flick across the stage steps one tab along TAB_ORDER. Deliberately NON-wrapping:
  // swiping past either end does nothing, so the row's two edges stay felt rather than looping the
  // reader around to the far side. Disabled while anything opaque covers the stage, and it stands
  // down for a touch that began on a chip rail (isExcluded) so that rail scrolls under the finger.
  const tabSwipeHandlers = useTabSwipe({
    enabled: !tabsCovered,
    isExcluded: () => railTouchRef.current,
    onSwipe: direction => {
      const next = TAB_ORDER[TAB_ORDER.indexOf(tab) + direction];
      if (next) selectTab(next, direction);
    },
  });

  // Whichever tab the member is on IS the launch default: record EVERY change — dock press, swipe
  // or programmatic jump alike — so leaving the app and coming back lands them where they left off.
  // (dockPrefs no-ops when the value is unchanged, so the mount-time pass never writes.)
  useEffect(() => {
    setDockDefaultTab(tab);
  }, [tab]);

  // Point 1 on a SWITCH: MainScreen stays mounted across community switches, so the mount
  // initializer above can't catch a fresh join reached from inside the app (add-mode). When the
  // active community changes to one whose first entry was just recorded, jump to Updates once; a
  // normal return-switch (wasFirstEntry() false) leaves the current tab untouched.
  const firstEntryCidRef = useRef(communityCid);
  useEffect(() => {
    if (communityCid && communityCid !== firstEntryCidRef.current) {
      firstEntryCidRef.current = communityCid;
      tabHistoryRef.current = [];
      if (wasFirstEntry()) setTab('log');
    }
  }, [communityCid]);

  // ── Android hardware BACK ────────────────────────────────────────────────────
  // MainScreen's own level of the app-wide back contract (ui/back.tsx): ONE action registered at
  // BACK_PRIORITY.root — the fallback that peels whichever plain-View overlay MainScreen itself owns,
  // deepest first, mirroring each sub-screen's on-screen back button. Surfaces with internal pages of
  // their own (GroupView's Manage/Add-people, the events organizer, the browser) register their own
  // higher-priority actions next to the buttons they mirror, so those are peeled before this runs.
  // Overlays that render ABOVE the base tab body are checked first; search is a mode embedded in the
  // base view, so it closes just before the view it filters.
  //
  // Deliberately absent: every surface hosted in a native <Modal> (notifications, the community log
  // and its detail sheet, the log full-post view, channel detail, settings, composer, drafts, the
  // moderator console, the action-sheet / history dialogs, …). On Android a Modal is a separate
  // Dialog WINDOW: it consumes the back key itself and calls its own onRequestClose, so the
  // Activity's onBackPressed — and therefore every BackHandler listener — never fires while one is
  // up. Branches for `notifOpen` / `logPostInfo` / `openLogEntryKey` / `communityLogOpen` /
  // `channelDetailOpen` used to sit in this ladder and could never run. Each of those surfaces
  // expresses its back behaviour in its own onRequestClose, which is also the ONLY place that can
  // (NotificationsScreen's pane-aware `goBack` is the model to copy).
  //
  // Nothing in the overlay ladder consumed the press → before falling through to the OS default,
  // closeInnermostOverlay itself pops tabHistoryRef (see its own body below) and walks back to
  // whichever tab the reader was previously ON — a genuine dock press or swipe, never a BACK-driven
  // one (that's what `viaBack` on selectTab prevents from re-entering this same history). Only once
  // that tab-visit stack is exhausted does it return false, RN runs the default, and MainActivity.kt's
  // invokeDefaultOnBackPressed override BACKGROUNDS the app (moveTaskToBack) instead of finishing it —
  // finishing would unmount React and tear the Tor daemon down. Rule 3 (at most one tab hop, ever) is
  // unrelated: it still governs only the nav-origin stack's own `tabRoot` case in restoreNavOrigin
  // (a surface hopping tabs), not this dock-visit history.
  // closeOpenChannelView / closeOpenChannelPostView / closeOpenGroupView / closeOpenPostView /
  // closeOpenPeerView / closeProfileView are declared earlier (right after openEmbedTarget) — ahead
  // of messagesContent/logContent/profileContent above, which call them. Used by BOTH close paths
  // (the in-view ‹ back buttons and the hardware back branches below).
  //
  // Generalized twin of the two old logReturnRef/profileReturnRef watcher effects: a pushed origin
  // only survives while its TARGET stays the view on screen. Any other navigation — a tab press, a
  // dock press (which clears the whole stack outright), opening a different space/post, a DM —
  // forfeits it, popping WITHOUT restoring (the close helpers above already popped-and-restored the
  // entries that legitimately closed; this only cleans up entries the user navigated PAST rather
  // than back OUT of). Deliberately omits openChannelPostId/openLogEntryKey/logPostInfo/
  // modConsoleOpen from its deps — those surfaces' own dedicated close helpers pop precisely, and
  // this effect only needs to be conservative (never evict a still-live entry), not exact.
  useEffect(() => {
    const stack = navStackRef.current;
    while (stack.length > 0) {
      const t = stack[stack.length - 1]!.target;
      let onTarget: boolean;
      switch (t.kind) {
        case 'notifications': onTarget = notifOpen; break;
        case 'profile': onTarget = openProfile?.pubkey === t.pubkey; break;
        case 'channel': onTarget = tab === 'channels' && openChannelId === t.channelId; break;
        case 'group': onTarget = tab === 'channels' && openGroupId === t.groupId; break;
        case 'post': onTarget = tab === 'feed' && openPost?.id === t.postId; break;
        case 'dm': onTarget = openPeer === t.peer; break;
        // No openChannelPostId dep here — approximate as "still somewhere in a channel view";
        // closeOpenChannelPostView (its own dedicated close site) pops it precisely.
        case 'channelPost': onTarget = tab === 'channels' && openChannelId !== null; break;
        case 'event': onTarget = openEventCoord === t.coordinate; break;
        // Phase 5§G notification targets — no live surface tracks "still on this destination" today
        // (see the NavDestination union's own comment), so treat as always-on-target: conservative
        // in the same direction as this effect's stated policy (never evict a still-live entry).
        case 'draftReader': onTarget = true; break;
        case 'draftRequests': onTarget = true; break;
      }
      if (onTarget) break;
      stack.pop();
    }
  }, [tab, openChannelId, openGroupId, openPost, openPeer, openProfile, notifOpen, openEventCoord]);

  const closeInnermostOverlay = (): boolean => {
    if (openProfile !== null) { closeProfileView(); return true; }
    if (openPeer !== null) { closeOpenPeerView(); return true; }
    if (tab === 'channels' && openChannelPostId !== null) { closeOpenChannelPostView(); return true; }
    if (tab === 'feed' && openPost !== null) { closeOpenPostView(); return true; }
    if (searchActive) { cancelSearch(); return true; }
    if (tab === 'channels' && openChannelId !== null) { closeOpenChannelView(); return true; }
    if (tab === 'channels' && openGroupId !== null) { closeOpenGroupView(); return true; }
    // Nothing above consumed the press — the reader is on a bare tab root. Walk back through the
    // tabs they actually chose to visit (dock press / stage swipe) before falling through to the OS
    // default. `viaBack` stops selectTab from re-pushing the tab we're leaving, so this can only ever
    // drain the stack, never loop it.
    const prevTab = tabHistoryRef.current.pop();
    if (prevTab !== undefined && prevTab !== tab) {
      const dir: -1 | 1 = TAB_ORDER.indexOf(prevTab) < TAB_ORDER.indexOf(tab) ? -1 : 1;
      selectTab(prevTab, dir, {viaBack: true});
      return true;
    }
    return false;
  };
  // The create/new-message sub-screens are NOT in the ladder: they are forms, so they own their back
  // at BACK_PRIORITY.host next to their own Cancel buttons, where the discard confirm lives too.
  useBackAction(closeInnermostOverlay, {priority: BACK_PRIORITY.root});

  // Route a notification tap to its target surface — reuses the exact same primitives every other
  // entry point into these surfaces already uses (draft-resume above, ⋯ "view post" in the mod
  // console/log, DM/channel navigation elsewhere in this file). Never invents new state.
  const navigateToNotification = (t: NavTarget): void => {
    if (t.kind === 'dm') {
      setTab('feed');
      setOpenPeer(t.peer);
    } else if (t.kind === 'channel') {
      setTab('channels');
      setChannelDetailOpen(false);
      if (t.channelType === 'public') {
        setOpenGroupId(null);
        setOpenChannelId(t.channelId);
      } else {
        setOpenChannelId(null);
        setOpenGroupId(t.channelId);
      }
    } else if (t.kind === 'event') {
      // An event reminder fired — open the detail straight over whatever is showing.
      setOpenEventRef(null);
      setOpenEventCoord(t.coordinate);
    } else if (t.kind === 'group_requests') {
      // A pending-join-request row: open the group straight on its Manage page (the review queue).
      // openGroupInitialScreen seeds GroupView's screen state; the open-group effect resets it after.
      // v1 gap: if this exact group is ALREADY open, GroupView doesn't remount, so it won't force-
      // switch to Manage — the seed is only read at mount. Accepted (rare; the badge is elsewhere).
      setTab('channels');
      setChannelDetailOpen(false);
      setOpenChannelId(null);
      setOpenGroupInitialScreen('manage');
      setOpenGroupId(t.groupId);
    } else if (t.kind === 'draft_requests') {
      // A pending draft-access-request row (Phase 5§G/notifications.ts) — open the real Manage
      // access queue (Phase 5§F) straight on this draft. `t.draftId` is the stable `shareId`; the
      // title is looked up from the local draftList echo when available (best-effort — a bare
      // notification tap carries only the shareId, so this may be undefined for a not-yet-loaded
      // Drafts list, which DraftAccessScreen already handles as an absent header line).
      setManageAccessTarget({shareId: t.draftId, title: draftList.find(d => d.shareId === t.draftId)?.title});
    } else if (t.kind === 'draft_reader') {
      // A requester's draft just unlocked (Phase 5§G) — open it straight in the reader. Only
      // draftId/ownerPubkey travel on the notification (no cached title/excerpt/gradient), so this
      // builds the MINIMAL DraftRef EmbedReader needs; access state + the real snapshot are resolved
      // live exactly as any other open (the DraftRef's optional fields are all it can't supply).
      setTab('feed');
      setEmbedReader({token: t.draftId, draft: {id: t.draftId, excerpt: '', author: t.ownerPubkey}});
    } else {
      // Always land on the feed so a tap is never a silent no-op (the previous behaviour when the
      // root post had aged out of the cache — common for a cold-start tap on an older reply). Open
      // the thread when the post is resolvable from the feed window or the runtime's event cache.
      // TODO(fetch): thread an async fetch-by-id so an evicted root post can be pulled + opened.
      setTab('feed');
      const item = feed.items.find(f => f.id === t.rootId) ?? onGetPostItem?.(t.rootId) ?? null;
      if (item) setOpenPost(item);
    }
  };

  /** Which tab {@link navigateToNotification} lands on, or undefined for the targets that change no
   *  tab (an event reminder opens a Modal over whatever is showing; a draft-access queue likewise).
   *  Kept adjacent to that function so the two are edited together. */
  const notifTargetTab = (t: NavTarget): Tab | undefined =>
    t.kind === 'event' || t.kind === 'draft_requests' ? undefined :
    t.kind === 'channel' || t.kind === 'group_requests' ? 'channels' :
    'feed';

  // FIX 1: the notifications module's own `NavTarget` (imported above) into a `NavDestination` for
  // the nav-origin stack — same three shapes navigateToNotification itself switches on, just
  // re-keyed onto the generic destination shape (its 'channel' + channelType:'group' maps to the
  // stack's 'group' kind, matching navigateToNotification's own openGroupId branch).
  const notifTargetToDestination = (t: NavTarget): NavDestination =>
    t.kind === 'dm' ? {kind: 'dm', peer: t.peer} :
    t.kind === 'channel' ? (t.channelType === 'public' ? {kind: 'channel', channelId: t.channelId} : {kind: 'group', groupId: t.channelId}) :
    // A join-request row lands on the same group the origin stack tracks as a 'group' destination.
    t.kind === 'group_requests' ? {kind: 'group', groupId: t.groupId} :
    t.kind === 'event' ? {kind: 'event', coordinate: t.coordinate} :
    t.kind === 'draft_requests' ? {kind: 'draftRequests', draftId: t.draftId} :
    t.kind === 'draft_reader' ? {kind: 'draftReader', draftId: t.draftId} :
    {kind: 'post', postId: t.rootId};

  // Cold-start / background taps arrive as a pendingNav prop (App.tsx routes notifee's
  // getInitialNotification / event streams here after runtime hydration) — apply it once, then
  // signal it's been consumed so it isn't re-applied on the next render.
  // Unlike an in-app row tap (which pushes a {kind:'notifications'} origin so BACK reopens the
  // center), a tap from OUTSIDE the app has no center to return to — the app was not open. Record
  // the tab it was showing when the tap landed, so BACK gets the reader off a tab they never chose
  // and back onto their own; the next press then leaves, per contract rule 3.
  useEffect(() => {
    if (pendingNav) {
      const from = navTabRef.current;
      const dest = notifTargetTab(pendingNav);
      if (dest && dest !== from) pushNavOrigin({kind: 'tabRoot', tab: from}, notifTargetToDestination(pendingNav));
      navigateToNotification(pendingNav);
      onPendingNavHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav]);

  return (
    <SafeAreaView style={styles.root} onTouchStart={handleTouchStart}>
      {!onSubScreen && (
        <View style={styles.header}>
          {searchActive ? (
            // Expanding search (design): the bar takes over the whole header row — wordmark,
            // icons, and avatar collapse; Cancel restores them. renderSearchBar keys on
            // searchActive so each open re-seeds + replays the 0.18s entrance.
            renderSearchBar(
              tab === 'feed' ? 'Search posts, tags, people…' : 'Search channels and people…',
              tab === 'feed',
              true,
            )
          ) : (
            <>
              <View style={styles.headerLeft}>
                <Press onPress={() => setSettingsOpen(true)}>
                  <Text style={styles.stiqTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Stiq<Text style={styles.stiqDot} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>.</Text>
                  </Text>
                </Press>
                {/* M7: quiet "background sync" legibility — present only while a relay sync round is
                    actually running, so the widened 1 Hz emit cadence during a backlog reads as
                    intentional rather than the app being laggy. No icon libs: a plain muted dot. */}
                {tab === 'feed' && syncing && (
                  <View style={styles.syncPill} accessibilityLabel="Syncing">
                    <Text style={styles.syncDot} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>●</Text>
                    <Text style={styles.syncPillText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Syncing…</Text>
                  </View>
                )}
              </View>
              <View style={styles.headerActions}>
                {searchAvailable && (
                  <Press
                    accessibilityLabel="Search"
                    style={styles.headerIconBtn}
                    onPress={() => setSearchActive(true)}>
                    <View><Icon name="🔍" size={17}/></View>
                  </Press>
                )}
                {(tab === 'feed' || tab === 'channels') && (
                  <Press
                    accessibilityLabel="Notifications"
                    style={styles.headerIconBtn}
                    onPress={openNotifications}>
                    <View><Icon name="🔔" size={17}/></View>
                    {notifUnreadCount > 0 && (
                      <View style={styles.nbadge}>
                        <Text style={styles.nbadgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                        </Text>
                      </View>
                    )}
                  </Press>
                )}
                {currentUserPubkey && (
                  <Press
                    accessibilityLabel="Your identity"
                    style={styles.meAvatar}
                    onPress={openMyProfile}>
                    <GradientAvatar
                      gradient={myGradient}
                      seed={safeNpubEncode(currentUserPubkey)}
                      size={30}
                    />
                  </Press>
                )}
              </View>
            </>
          )}
        </View>
      )}
      {settingsModal.mounted && <SettingsScreen
        visible={settingsModal.visible}
        onClose={() => setSettingsOpen(false)}
        profile={myProfile}
        onOpenProfile={() => {
          if (myProfile) {
            setOpenProfile(myProfile);
          }
        }}
        onOpenDrafts={() => { void openDrafts(); }}
        onOpenYourEvents={events ? () => {
          setEventsOrgOpen(true);
          // Republish sweep (2026-07-21 incident fix): the host opening their events management
          // surface is one of the two triggers (the other is a relay reconnect) that self-heals a
          // doc that silently never landed on the relay.
          events.republishMine();
        } : undefined}
        pinEnabled={pinEnabled}
        onSetPinEnabled={onSetPinEnabled}
        onVerifyPin={onVerifyPin}
        onWipe={onWipe}
        onLoadCommunities={onLoadCommunities}
        onSwitchCommunity={onSwitchCommunity}
        onRemoveCommunity={onRemoveCommunity}
        onJoinAnotherCommunity={onJoinAnotherCommunity}
        onLoadKeySlots={onLoadKeySlots}
        onSwitchIdentity={onSwitchIdentity}
        onRemoveIdentity={onRemoveIdentity}
        onAddIdentity={onAddIdentity}
        onGetBlossomEndpoint={onGetBlossomEndpoint}
        onSetBlossomEndpoint={onSetBlossomEndpoint}
        onGetPreferredBrowser={onGetPreferredBrowser}
        onSetPreferredBrowser={onSetPreferredBrowser}
        onListBrowsers={onListBrowsers}
        onClearMediaCache={onClearMediaCache}
        onClearEventCache={onClearEventCache}
        onCountCachedEvents={onCountCachedEvents}
        onDeleteCachedData={onDeleteCachedData}
        connection={connection}
        torPhase={torPhase}
        onGetConnectionPrefs={onGetConnectionPrefs}
        onApplyConnectionPrefs={onApplyConnectionPrefs}
        onGetRelaySnapshot={onGetRelaySnapshot}
        onAddRelay={onAddRelay}
        onRemoveRelay={onRemoveRelay}
        onMuteRelay={onMuteRelay}
        onUnmuteRelay={onUnmuteRelay}
        apkUpdatesEnabled={apkUpdatesEnabled}
        onCheckForUpdate={onCheckForUpdate}
        onInstallUpdate={onInstallUpdate}
        tokenStatus={tokenStatus}
        onRefreshTokenStatus={onRefreshTokenStatus}
      />}


      {/* Notification center — live-derived list, snapshotted at open time (no persisted log). */}
      {notifModal.mounted && (
        <NotificationsScreen
          visible={notifModal.visible}
          onClose={() => setNotifOpen(false)}
          items={notifItems}
          prefs={onGetNotificationPrefs?.() ?? DEFAULT_PREFS}
          onSetPrefs={next => onSetNotificationPrefs?.(next)}
          onSelect={target => {
            // Push BEFORE the navigate + close below — not inside navigateToNotification itself,
            // which the cold-start pendingNav effect also calls and must stay memory-free.
            pushNavOrigin({kind: 'notifications'}, notifTargetToDestination(target));
            navigateToNotification(target);
            setNotifOpen(false);
          }}
          onMarkRead={id => onMarkNotificationRead?.(id)}
          onMarkAllRead={() => onMarkAllNotificationsRead?.()}
          channels={channels}
          subscribedChannelIds={subscribedChannelIds ?? []}
          inboxPeers={inbox.map(c => c.peer)}
          getDisplayName={onGetDisplayName}
        />
      )}

      {/* Moderator console — opened only from the Log tab's moderator-only entry, and only when
          the organizer-signed roster makes this user a moderator. Moderation here removes nothing:
          the actions publish signed advisories that route an author's/post's content to the mod log
          (reversible from the "Logged" tab). Lift-ban keeps the legacy hard-ban liftable. */}
      {modConsoleModal.mounted && (
        <ErrorBoundary scope="moderator-console" onReset={() => setModConsoleOpen(false)}>
          <ModeratorConsole
            visible={modConsoleModal.visible}
            onClose={() => setModConsoleOpen(false)}
            scopes={modScopes}
            reports={pendingReports}
            bans={bannedMembers}
            loggedAuthors={loggedAuthors}
            getProfile={onGetProfile}
            checkLimit={onCheckModLimit}
            onLogAuthor={(pubkey, includePast) => onModeratorLogAuthor?.(pubkey, includePast)}
            onLogPost={(targetId, _targetType, author) => onModeratorLogPost?.(targetId, author)}
            onRestoreAuthor={pubkey => onModeratorRestoreAuthor?.(pubkey)}
            onUnban={pubkey => onModeratorUnban?.(pubkey)}
            onViewPost={targetId => {
              pushNavOrigin({kind: 'modConsole'}, {kind: 'post', postId: targetId});
              setModConsoleOpen(false);
              const item = feed.items.find(f => f.id === targetId) ?? onGetLogPost?.(targetId)?.item ?? null;
              if (item) {
                setTab('feed');
                setOpenPost(item);
              }
            }}
          />
        </ErrorBoundary>
      )}

      {/* Search time-frame picker — feed, channels and groups share this single instance. */}
      {timeSheetModal.mounted && <TimeFrameSheet
        visible={timeSheetModal.visible}
        value={timeSel}
        onClose={() => setTimeSheetOpen(false)}
        onApply={setTimeSel}
      />}

      {/* Connection strip — only when NOT fully online (no banner when connected). Non-blocking:
          the cached feed stays scrollable while Tor connects; tap anywhere to open Connection
          settings. Reads as chrome, not an alarm — the state lives in a 5px dot and the bootstrap
          progress rides the strip's own bottom edge, so it costs one text line of height. */}
      {!isOnline(connection) && (
        <Press
          variant="row"
          style={[styles.banner, connectionStalled && styles.bannerStalled]}
          accessibilityLabel={`${connectionText}. Open Connection settings`}
          onPress={() => setSettingsOpen(true)}>
          <View style={styles.bannerRow}>
            <View style={[styles.bannerDot, connectionStalled ? styles.bannerDotStalled : styles.bannerDotWorking]} />
            <Text style={styles.bannerText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{connectionText}</Text>
            <Text style={styles.bannerChevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
          </View>
          {/* Determinate Tor-bootstrap line ON the bottom edge: forward motion while Arti connects —
              seconds, not the 30–90s the old (removed) C-tor engine needed; a warm reconnect
              typically lands in ~2-3s now. 1.5px of height. Renders null once the percent clears on
              a dead circuit, so it never looks hung — the hairline border below it keeps the strip's
              edge either way. */}
          <ProgressBar percent={torBootstrap?.percent} height={1.5} trackColor="transparent" />
        </Press>
      )}
      {/* Primary Current/Spaces/Updates navigation now lives in the floating <BottomDock> (rendered near the
          end of this SafeAreaView), not a top tab bar. It binds to the same `tab`/`setTab` state. */}

      {/* ── Drafts screen — grouped/filtered list with rule-mirrored status chips + undo ── */}
      {draftsModal.mounted && <DraftsScreen
        visible={draftsModal.visible}
        drafts={draftList}
        limits={limitsFromRules(postRules)}
        labels={labels}
        onClose={() => setDraftsOpen(false)}
        onNew={() => { setDraftsOpen(false); startNewPost(); }}
        onOpen={resume}
        onDelete={id => {
          void draftStore?.delete(id);
          setDraftList(list => list.filter(x => x.id !== id));
        }}
        onDuplicate={copy => {
          void draftStore?.save(copy);
          setDraftList(list => [copy, ...list]);
        }}
        onSaveEmbed={saveDraftAsEmbed}
        onGetPendingAccessCount={shareId => onGetDraftAccessQueue?.(shareId)?.length ?? 0}
        onManageAccess={draft => { if (draft.shareId) setManageAccessTarget({shareId: draft.shareId, title: draft.title}); }}
      />}

      {/* ── Owner's "Manage access" queue (Phase 5§F) — reached from the Drafts ⋯ menu once a draft
          has a shareId, or from a 'draft_requests' notification tap. ── */}
      {draftAccessModal.mounted && <DraftAccessScreen
        visible={draftAccessModal.visible}
        draftId={manageAccessTarget?.shareId ?? ''}
        draftTitle={manageAccessTarget?.title}
        onClose={() => setManageAccessTarget(null)}
        onGetPending={onGetDraftAccessQueue}
        onGetApproved={onGetDraftAccessGranted}
        onApprove={onApproveDraftAccess}
        onDeny={onDenyDraftAccess}
        onRevoke={onRevokeDraftAccess}
      />}

      {/* ── Read-only embed reader — a draft (access-gated, Phase 5/6/7) or a private-space post
          shared as an embed. Opened from any embed card tap (openEmbedTarget) or a draft-access
          notification (navigateToNotification's 'draft_reader' case); a `msg` can still be saved
          onward to the viewer's own picker — a draft's onward action is forking instead. ── */}
      <EmbedReader
        target={embedReader}
        onClose={() => setEmbedReader(null)}
        onSaveEmbed={saveReaderEmbedOnward}
        saved={!!embedReader && (readerSavedToken === embedReader.token || isEmbedSaved(embedReader.token))}
        onAuthorPress={onGetProfile ? pubkey => setOpenProfile(onGetProfile(pubkey)) : undefined}
        onGetDraftAccessState={onGetDraftAccessState}
        onGetMyDraftDelivery={onGetMyDraftDelivery}
        onRequestDraftAccess={onRequestDraftAccess}
        // Re-runs the reader's access check whenever an access-relevant event lands, so an approval
        // arriving while the reader is ALREADY OPEN unlocks it in place (see storeVersions.draftAccess).
        accessVersion={storeVersions.draftAccess ?? 0}
        onGetOwnerDraftSnapshot={getOwnerDraftSnapshot}
        onForkDraft={forkDraftFromDelivery}
        onGetDraftThread={onGetDraftThread}
        onGetDraftCommentCount={onGetDraftCommentCount}
        onComment={onComment}
        onGetProfile={onGetProfile}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        picturesSpentBytes={picturesSpentBytes}
        myGradient={myGradient}
        myPubkey={currentUserPubkey ?? undefined}
      />

      {/* ── Events surface — the viewer's event detail (embed tap / reminder tap / preview) and
          the Events — Organizer flow (reached from Settings). Both are always-mounted Modals with
          the standard lazy-latch; both no-op without the runtime seam. */}
      {events && (
        <EventDetailHost
          api={events}
          coordinate={openEventCoord}
          eventRef={openEventRef}
          onClose={closeOpenEventView}
          onOpenPeer={pk => {
            setTab('feed');
            setOpenPeer(pk);
          }}
        />
      )}
      {events && eventsOrgModal.mounted && (
        <EventsOrganizerHost
          api={events}
          visible={eventsOrgModal.visible}
          pictureRules={pictureRules}
          picturesSpentBytes={picturesSpentBytes}
          allowVoice={allowVoice}
          postRules={postRules}
          savedPosts={savedPosts}
          savedEmbedTokens={savedEmbedTokens}
          onClose={() => setEventsOrgOpen(false)}
          onPreview={coordinate => {
            setOpenEventRef(null);
            setOpenEventCoord(coordinate);
          }}
        />
      )}

      {/* Full-page composer (No.1) — a slide-up editor. Lazy-mounted on first open (its RichEditor
          WebView subtree is the heaviest element here), then kept mounted so the slide-down close
          animation still plays. Deliberately NOT keyed by draft id: ComposerScreen resets its own
          state via effect when `initialDraft` changes (Phase 3.5) — the old `key={draft.id}` forced
          a full unmount/rebuild of the WebView editor on every draft resume. */}
      {composerModal.mounted && <ComposerScreen
        visible={composerModal.visible}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        pictureSpentBytes={picturesSpentBytes}
        onClose={() => { setComposerOpen(false); setResumeDraft(undefined); setPromoteTarget(null); }}
        onSubmit={promoteTarget && onPromoteChannelPost
          ? (content, tags, title, label, contentWarning) => { onPromoteChannelPost(promoteTarget, content, tags, title, label, contentWarning); setPromoteTarget(null); }
          : onSubmit}
        promoteNote={promoteTarget ? 'Promoting your channel post — add a title, tags and a label, then publish it to the feed.' : undefined}
        draftStore={promoteTarget ? undefined : draftStore}
        onOpenDrafts={promoteTarget ? undefined : () => { void openDrafts(); }}
        initialDraft={resumeDraft}
        tagPolicy={tagPolicy}
        labels={labels}
        postRules={postRules}
        postingGuidelines={postingGuidelines}
        guidelinesSeenKey={currentUserPubkey ?? 'community'}
        myGradient={myGradient}
        myPubkey={currentUserPubkey ?? undefined}
        communityName={promoteTarget ? undefined : communityName ?? undefined}
        savedPosts={savedPosts}
        onRemoveSaved={onToggleBookmark}
        savedEmbedTokens={savedEmbedTokens}
        onRemoveSavedToken={removeSavedEmbedToken}
      />}

      {/* ── Tab stage (Phase 4.1) ─────────────────────────────────────────────
          ALL THREE top-level tab bodies live here as TabLayers: lazy until first visit, mounted
          forever after, hidden via opacity + frozen re-renders (never display:none — Android resets
          a FlatList's scroll offset when display'd away). Dock presses therefore stop unmounting
          whole surfaces: native scroll positions survive with no restore machinery, and switching
          back to a visited tab costs one unfreeze render instead of a full remount. Drill-in
          sub-screens render as opaque absolute overlays ABOVE their tab's layer (SubScreen /
          threadOverlay / dmOverlay / profileOverlay), so the list beneath stays laid out — the
          feed already worked this way for the thread overlay; now every surface does. */}
      {/* The stage carries the tab-swipe responder (bubbling): a clearly-horizontal drag over a tab's
          vertical list bubbles up here and switches tab, while vertical scrolls fail the dominance
          test and stay with the list. This ONLY works because the stage is not box-none (a box-none
          view can't be a responder — see below) and the release commit doesn't re-require a live
          touch. See ui/useTabSwipe.ts for the full negotiation + the chip-rail tradeoff. */}
      {/* pointerEvents is DELIBERATELY not "box-none" here: a box-none view can never become the
          touch responder, so its should-set handlers never fire — which is exactly why the swipe was
          dead. Default ("auto") lets the stage claim the horizontal drag while its TabLayer children,
          which fill it and manage their own pointer events, still receive every tap and vertical
          scroll. */}
      {/* Scoped press-in delay: inside the scrolling tab bodies, Press holds its highlight for a
          beat so a starting scroll or tab-swipe cancels it before it shows (no more flashing the
          post/chat/row under the thumb). The dock and modals sit OUTSIDE this provider, so their
          buttons stay instant. TabRailTouchContext hands the rail opt-out down to rails in child
          components (the hearth people rail); the two inline rails use railTouchHandlers directly. */}
      <PressDelayContext.Provider value={SCROLL_PRESS_DELAY_MS}>
      <TabRailTouchContext.Provider value={railTouchHandlers}>
      <Reanimated.View
        testID="tab-stage"
        style={[styles.flex, stageAnim]}
        {...tabSwipeHandlers}>
      {/* ── Feed tab ── */}
      <TabLayer active={tab === 'feed'} covered={tabsCovered} testID="tab-layer-feed">
        {/* Feed list stays fully mounted AND laid out while a thread is open (the thread renders as
            an absolute overlay below). On Android `display:none` resets a FlatList's scroll offset,
            so we must NOT hide it — keeping it laid out is what preserves the native scroll position,
            and that position IS the restore: Back re-reveals the list exactly where the reader left
            it, with no scrolling of our own. See the note by openPostFromFeed. */}
        <View style={styles.flex}>
          {/* The search bar itself lives in the header row while active (expanding search). */}

          {/* Redesigned "Quiet" sort + tags bar — kept visible AND fully functional while the
              search bar is open (its chips stay tappable on the first touch over the keyboard).
              In search it drives the independent `searchSort` (which defaults to Top). */}
          {searchActive && renderQuietBar(['hot', 'new', 'top'], searchSort, setSearchSort)}

          {/* Time-frame filtering now lives in the search bar itself (SearchTimeButton →
              TimeFrameSheet), shared with channels, groups and DMs — no separate row here. */}
          {/* FIX 5: the sort/tag bar + composer ride as the list header so they scroll AWAY with
              content (and reappear at the top) instead of staying pinned. Search mode swaps in its
              own chrome above, so the header is suppressed while searching. */}
          <FeedList
            ref={feedListRef}
            items={pagedItems}
            labels={labels}
            connection={connection}
            header={searchActive ? null : feedChrome}
            footer={loadMoreFooter}
            onEndReached={loadMore}
            refreshing={refreshing}
            onRefresh={onRefreshFeed ? handleRefresh : undefined}
            sendStatus={sendStatus}
            sendReasons={sendReasons}
            sendQueuedOffline={sendQueuedOffline}
            onScroll={handleFeedScroll}
            restoreOffset={feedScrollYRef.current}
            onScrollBeginDrag={() => onSetScrolling?.(true)}
            onScrollSettle={() => onSetScrolling?.(false)}
            onVote={onVote}
            onLookupEvent={onGetEvent}
            onOpenNostrPost={openEmbedTarget}
            onItemPress={openPostFromFeed}
            onRetry={onRetry}
            onCancel={onCancelSend}
            onAuthorPress={onGetProfile ? pubkey => {
              const p = onGetProfile(pubkey);
              setOpenProfile(p);
            } : undefined}
            isModerator={isModerator}
            onModeratePost={onModeratePost}
            lockedIds={lockedSet}
            pinnedIds={pinnedSet}
            onModeratorLock={onModeratorLock}
            onModeratorRetag={onModeratorRetag}
            onModeratorPin={onModeratorPin}
            bookmarkedPostIds={bookmarkedPostIds}
            onToggleBookmark={onToggleBookmark}
            onReportPost={onReportPost}
            onMuteAuthor={onMuteAuthor}
            onUnlockContent={onUnlockContent}
          />
        </View>
      </TabLayer>
        {tab === 'feed' && openPost && (
        <ErrorBoundary scope="thread-detail" onReset={() => setOpenPost(null)}>
        {/* Absolute overlay covering the tab stage (which spans the root while a sub-screen is open —
            the header unmounts — and whose origin already clears the iOS notch, so no manual inset
            is needed). Enters with the shared sub-screen fade+slide. onSwipeBack is closeOpenPostView —
            the SAME function the BackButton below calls — per the plan's ownership rule. */}
        <SwipeBackOverlay onSwipeBack={closeOpenPostView} style={[styles.flex, styles.threadOverlay]}>
          {/* iOS keyboard avoidance for the comment composer pinned below the thread. Android resizes
              the window itself (adjustResize), so the KAV is a no-op there (behavior undefined). The
              overlay origin already sits below the notch, so no extra vertical offset is needed. */}
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
          <View style={styles.appbar}>
            <BackButton label="Back" onPress={closeOpenPostView} />
            <View style={styles.appbarRight}>
              <Press
                style={styles.jumpBtn}
                onPress={() => {
                  // FIX 2E: deterministic jump via measured offset (scrollToOffset always lands —
                  // unlike scrollToIndex into not-yet-measured comments, or scrollToEnd with no
                  // comments). The COMMENTS heading's Y within the header IS the target offset.
                  if (jumpDir === 'down') {
                    const headerY = detailHeaderHeightRef.current;
                    // If the header hasn't measured yet (no onLayout), fall back to scrollToEnd so
                    // the tap still moves the user toward the comments.
                    if (headerY > 0) {
                      threadListRef.current?.scrollToOffset({offset: headerY, animated: true});
                    } else {
                      threadListRef.current?.scrollToEnd({animated: true});
                    }
                    detailScrollYRef.current = headerY;
                    setJumpDir('up');
                  } else {
                    threadListRef.current?.scrollToOffset({offset: 0, animated: true});
                    detailScrollYRef.current = 0;
                    setJumpDir('down');
                  }
                }}>
                <Text style={styles.jumpLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{jumpDir === 'down' ? 'Comments' : 'Post'}</Text>
                <Text style={styles.jumpArrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{jumpDir === 'down' ? '↓' : '↑'}</Text>
              </Press>
              <Press style={styles.appbarMore} onPress={() => setDetailMenuOpen(true)} accessibilityLabel="post details">
                <Text style={styles.appbarMoreText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
              </Press>
            </View>
          </View>
          <ThreadView
            nodes={threadNodes ?? []}
            pending={threadNodes === null}
            listKeyFor={listKeyFor}
            listRef={threadListRef}
            opPubkey={openPost.authorPubkey}
            sendStatus={sendStatus}
            sendReasons={sendReasons}
            sendQueuedOffline={sendQueuedOffline}
            onRetryComment={onRetry}
            onCancelComment={onCancelSend}
            getScore={onGetEventScore}
            onLike={ev => onVote(ev.id, resolveAuthorPubkey(ev), 'up')}
            onLookupEvent={onGetEvent}
            onOpenNostrPost={openEmbedTarget}
            onReply={node => setReplyTarget(node)}
            getAuthorName={ev => {
              // Bug #7 + F-attribution fix: a comment may be a blind post (throwaway-signed) — the
              // shared resolver decrypts its real author first (never renders anonymous just because
              // it's blind), then defers to the phonebook's longest-held-wins arbitration rather than
              // trusting the attestation's claimed name outright.
              return onResolveIdentity?.(ev.id)?.name ?? null;
            }}
            getAuthorGradient={ev => onResolveIdentity?.(ev.id)?.gradient}
            onAuthorPress={onGetProfile ? pubkey => setOpenProfile(onGetProfile(pubkey)) : undefined}
            isModerator={isModerator}
            onModeratorHide={ev => {
              // Resolve the REAL author: a blind comment is signed by a throwaway key, so ev.pubkey is
              // NOT the person — the removal report must carry the decrypted author (matches the feed
              // menu + moderator console, which already resolve).
              const author = resolveAuthorPubkey(ev);
              Alert.alert('Hide this comment?', 'It will be hidden community-wide and logged in the mod log.', [
                {text: 'Cancel', style: 'cancel'},
                {text: 'Hide', style: 'destructive', onPress: () => onModeratePost?.(ev.id, author, 'hide')},
              ]);
            }}
            onModeratorHideUser={ev => {
              // MUST resolve the real author: banning ev.pubkey would ban the per-post throwaway key,
              // so the real author keeps posting under fresh throwaways. resolveAuthorPubkey decrypts
              // the attribution to the actual npub (falls back to ev.pubkey for a non-blind comment).
              const author = resolveAuthorPubkey(ev);
              Alert.alert('Hide this user?', 'All of their content will be hidden community-wide.', [
                {text: 'Cancel', style: 'cancel'},
                {text: 'Hide user', style: 'destructive', onPress: () => onModeratePost?.(ev.id, author, 'hideUser')},
              ]);
            }}
            onSaveComment={ev => onToggleBookmark?.(ev.id)}
            getCommentSaved={id => bookmarkedSet.has(id)}
            onMuteAuthor={ev => onMuteAuthor?.(resolveAuthorPubkey(ev))}
            onReportComment={ev => onReportPost?.(ev.id, resolveAuthorPubkey(ev))}
            listHeader={(() => {
              // FIX 4: openPost is a STALE snapshot captured when the post opened — voting updates
              // the live `feed` array, not openPost, so the detail ✦/counters must read from the
              // CURRENT item. Re-derive it each render (a cheap find; feed.items changes once per
              // snapshot). Stable fields (id/authorPubkey/title) are identical, so falling back to
              // openPost when the post has scrolled out of the cache is safe.
              const livePost = feed.items.find(p => p.id === openPost.id) ?? openPost;
              const isTweetPost = isTweetLike(livePost);
              // F-attribution fix (item 2a): resolve through the OPEN POST EVENT's own carried
              // identity — attestation first, then phonebook arbitration, then npub+seed — never a
              // bare phonebook-by-pubkey lookup. That gap (onGetProfile alone, no attestation
              // fallback) is exactly what let this same member's POST render "anonymous" while their
              // COMMENT on the identical screen, resolved via resolveAuthor directly, showed their
              // name. `livePost.authorName`/`authorGradient` (the FeedItem's own resolver-backed
              // fields) are the fallback for the rare case the event isn't in the store to re-resolve.
              const detailIdentity = onResolveIdentity?.(openPost.id);
              const detailName = detailIdentity?.name?.trim() || livePost.authorName;
              const detailGrad = detailIdentity?.gradient ?? livePost.authorGradient;
              const detailNpub = shortenNpub(openPost.author, {lead: 8, tail: 4});
              const detailWhen = relTimeShort(openPost.createdAt);
              const lblMeta = livePost.label ? labelMetaFor(livePost.label, labels) : null;
              const isAuthor = currentUserPubkey === openPost.authorPubkey;
              const noteText = pinnedHistory?.latest?.content?.trim();
              // Organizer-configured author's-note character cap (0 = unbounded).
              const authorNoteMax = postRules.authorNoteMax;
              const openEmbed = openEmbedTarget;
              // FIX 2D/5A/4: shared ✦ vote pill + 💬 reply counter for both detail layouts, read
              // from the LIVE item so a tap immediately highlights ✦ and bumps the count.
              const detailVoted = livePost.myVote === 'up';
              const detailScoreText = livePost.score > 0 ? `+${livePost.score}` : `${livePost.score}`;
              const detailCounters = (
                <View style={styles.detailCounters}>
                  <Press
                    style={styles.pvVote}
                    onPress={() => onVote(openPost.id, openPost.authorPubkey, 'up')}
                    accessibilityLabel="upvote">
                    <Text style={[styles.pvVoteGlyph, detailVoted && styles.pvVoteOnText]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✦</Text>
                    <Text style={[styles.pvVoteText, detailVoted && styles.pvVoteOnText]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailScoreText}</Text>
                  </Press>
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                    <Icon name="💬" size={14} />
                    <Text style={styles.detailReplies} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{`${livePost.commentCount ?? 0}`}</Text>
                  </View>
                </View>
              );
              return (
              <View>
                {/* ── Post rendered in its NATIVE format ── */}
                <View style={styles.pvPost}>
                  {isTweetPost ? (
                    <>
                      <RichText
                        style={styles.dtText}
                        content={openPost.content}
                        onLookupEvent={onGetEvent}
                        onOpenNostrPost={openEmbed}
                        eventDensity="Feed"
                      />
                      {/* FIX 5A: ONE horizontal row — avatar · name · npub · date · ✦ · 💬 */}
                      <View style={styles.dtMeta}>
                        <Press onPress={() => onGetProfile && setOpenProfile(onGetProfile(openPost.authorPubkey))} accessibilityLabel="View author profile">
                          <GradientAvatar gradient={detailGrad} seed={openPost.author} size={22} />
                        </Press>
                        {detailName ? <Text style={styles.dtName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailName}</Text> : null}
                        {/* npub shrinks (from the middle) so the date is NEVER clipped. */}
                        <Text style={styles.dtSub} numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailNpub}</Text>
                        <Text style={styles.dtWhen} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{`· ${detailWhen}`}</Text>
                        <View style={styles.spacer} />
                        {detailCounters}
                        {lblMeta && (
                          <View style={[styles.dLabel, {backgroundColor: lblMeta.bg}]}>
                            <Text style={[styles.dLabelText, {color: lblMeta.color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{lblMeta.text}</Text>
                          </View>
                        )}
                      </View>
                      {/* Tags sit under the body — same chip treatment as the article layout. */}
                      {openPost.tags.length > 0 && (
                        <View style={styles.pvTags}>
                          {openPost.tags.map(t => (
                            <Text key={t} style={styles.pvTag} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t}</Text>
                          ))}
                        </View>
                      )}
                    </>
                  ) : (
                    <>
                      {livePost.title ? <Text style={[styles.pvTitle, paragraphAlign(livePost.title ?? ''), rtlVerticalFix(livePost.title ?? '')]}>{livePost.title}</Text> : null}
                      <Press
                        style={styles.byline}
                        onPress={() => onGetProfile && setOpenProfile(onGetProfile(openPost.authorPubkey))}>
                        <GradientAvatar gradient={detailGrad} seed={openPost.author} size={38} />
                        <View style={styles.bylineId}>
                          <Text style={styles.bylineName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailName || detailNpub}</Text>
                          <View style={styles.bylineSub}>
                            {detailName ? (
                              <>
                                {/* npub shrinks (from the middle) so the date is NEVER clipped. */}
                                <Text style={styles.bylineNpub} numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailNpub}</Text>
                                <Text style={styles.bylineWhen} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{`· ${detailWhen}`}</Text>
                              </>
                            ) : (
                              <Text style={styles.bylineWhen} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailWhen}</Text>
                            )}
                          </View>
                        </View>
                        {/* FIX 2D: keep ✦ vote + 💬 reply counters visible in the detail byline */}
                        {detailCounters}
                        {lblMeta && (
                          <View style={[styles.dLabel, {backgroundColor: lblMeta.bg}]}>
                            <Text style={[styles.dLabelText, {color: lblMeta.color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{lblMeta.text}</Text>
                          </View>
                        )}
                      </Press>
                      <RichText
                        style={styles.articleBody}
                        content={openPost.content}
                        paragraphSpacing={15}
                        onLookupEvent={onGetEvent}
                        onOpenNostrPost={openEmbed}
                        eventDensity="Feed"
                      />
                      {openPost.tags.length > 0 && (
                        <View style={styles.pvTags}>
                          {openPost.tags.map(t => (
                            <Text key={t} style={styles.pvTag} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t}</Text>
                          ))}
                        </View>
                      )}
                    </>
                  )}
                </View>

                {/* ── Author's note (the only editable space) ── */}
                {/* AUTHOR_NOTE_ENABLED (config.ts): ship-dark — OFF hides this whole block (an
                    existing post's note text, the author's edit affordance, the counter, and the
                    "view prior edits" entry point below) with no gap left in its place. Nothing
                    underneath is deleted; flipping the flag back on restores this byte-identical. */}
                {AUTHOR_NOTE_ENABLED && (noteText || (isAuthor && onSetPinnedComment)) && (
                  <View style={styles.noteWrap}>
                    {noteEditing ? (
                      <View style={[styles.note, styles.noteEditing]}>
                        <View style={styles.noteTop}>
                          <View style={styles.noteLabelRow}>
                            <Icon name="📌" size={11}/>
                            <Text style={styles.noteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>EDITING AUTHOR'S NOTE</Text>
                          </View>
                        </View>
                        <TextInput
                          style={styles.noteInput}
                          value={noteDraft}
                          onChangeText={setNoteDraft}
                          maxLength={authorNoteMax > 0 ? authorNoteMax : undefined}
                          multiline
                          autoFocus
                          placeholder=""
                          placeholderTextColor={colors.textMuted}
                        />
                        <View style={styles.noteActions}>
                          <Text style={styles.noteCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                            {authorNoteMax > 0 ? `${noteDraft.length} / ${authorNoteMax}` : `${noteDraft.length}`}
                          </Text>
                          <View style={styles.noteBtnRow}>
                            <Press style={[styles.noteBtn, styles.noteBtnGhost]} onPress={() => setNoteEditing(false)}>
                              <Text style={styles.noteBtnGhostText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
                            </Press>
                            <Press
                              style={[styles.noteBtn, styles.noteBtnPrimary]}
                              onPress={() => {
                                onSetPinnedComment?.(openPost.id, openPost.authorPubkey, openPost.kind, noteDraft.trim());
                                setNoteEditing(false);
                              }}>
                              <Text style={styles.noteBtnPrimaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Save note</Text>
                            </Press>
                          </View>
                        </View>
                      </View>
                    ) : (
                      <View style={styles.note}>
                        <View style={styles.noteTop}>
                          <View style={styles.noteLabelRow}>
                            <Icon name="📌" size={11}/>
                            <Text style={styles.noteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>AUTHOR'S NOTE</Text>
                          </View>
                          {isAuthor && onSetPinnedComment && (
                            <Press style={styles.noteEdit} onPress={() => { setNoteDraft(noteText ?? ''); setNoteEditing(true); }}>
                              <Icon name="✏️" size={12}/>
                              <Text style={styles.noteEditText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{noteText ? 'Edit' : 'Add note'}</Text>
                            </Press>
                          )}
                        </View>
                        {noteText ? (
                          <Text style={[styles.noteBody, paragraphAlign(noteText)]}>{noteText}</Text>
                        ) : (
                          <Text style={styles.noteEmpty}>No note yet — add context, a correction, or an update for readers.</Text>
                        )}
                        {isAuthor && (
                          <View style={styles.noteFoot}>
                            <Text style={styles.noteFootStrong} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>You</Text>
                            <View style={{width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.textMuted}} />
                            <Text style={styles.noteFootText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>only you can edit this note</Text>
                          </View>
                        )}
                        {pinnedHistory && pinnedHistory.history.length > 0 && (
                          <Press onPress={() => setHistoryModalOpen(true)}>
                            <Text style={styles.pinnedHistoryToggle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                              {`View prior edits (${pinnedHistory.history.length})`}
                            </Text>
                          </Press>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* ── Comments head ── */}
                {/* FIX 2E: its Y within the header == the scroll offset that brings comments to the top. */}
                <View
                  style={styles.commentsHead}
                  onLayout={e => { detailHeaderHeightRef.current = e.nativeEvent.layout.y; }}>
                  <Text style={styles.commentsEyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>COMMENTS</Text>
                  <Text style={styles.commentsNum} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{countComments(threadNodes ?? [])}</Text>
                  <View style={styles.commentsRule} />
                </View>
              </View>
              );
            })()}
          />
          {lockedSet.has(openPost.id) ? (
            <View style={styles.lockedComposer}>
              <Text style={styles.lockedComposerText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔒 This thread is locked. No new comments.</Text>
            </View>
          ) : (
            onComment && (
              <CommentComposer
                placeholder={replyTarget ? `Reply to comment…` : 'Add a comment…'}
                submitLabel={replyTarget ? 'Reply' : 'Comment'}
                onGetEvent={onGetEvent}
                allowVoice={allowVoice}
                pictureRules={pictureRules}
                picturesSpentBytes={picturesSpentBytes}
                postRules={postRules}
                myGradient={myGradient}
                myPubkey={currentUserPubkey ?? undefined}
                rootTitle={openPost.title || undefined}
                // A half-written comment survives leaving the thread, keyed on the ROOT POST. Only
                // wired here (of the four CommentComposer surfaces) because `resume` below can
                // genuinely reopen a feed post by id — see DraftLocation's 'comment' variant doc.
                draftStore={draftStore}
                draftLocation={{
                  kind: 'comment',
                  rootId: openPost.id,
                  rootLabel: openPost.title?.trim() || openPost.content.trim().slice(0, 60) || 'a post',
                }}
                onSubmit={text => {
                  const parent = replyTarget
                    ? {id: replyTarget.event.id, pubkey: replyTarget.event.pubkey, kind: replyTarget.event.kind}
                    : {id: openPost.id, pubkey: openPost.authorPubkey, kind: openPost.kind};
                  onComment(text, openPost.id, openPost.authorPubkey, openPost.kind, parent.id, parent.pubkey, parent.kind);
                  setReplyTarget(null);
                }}
              />
            )
          )}
          </KeyboardAvoidingView>
          {/* ── Post detail ⋯ action sheet ── */}
          <Modal visible={detailMenuOpen} transparent animationType="fade" onRequestClose={() => setDetailMenuOpen(false)}>
            <Press variant="bare" style={styles.aSheetBack} onPress={() => setDetailMenuOpen(false)} accessibilityRole="none">
              <Press variant="bare" style={styles.aSheet} onPress={() => {}} accessibilityRole="none">
                <View style={styles.aSheetCard}>
                  <Press
                    variant="row"
                    style={styles.aSheetItem}
                    onPress={() => {
                      const uri = openPost.identifier.startsWith('nostr:') ? openPost.identifier : `nostr:${openPost.identifier}`;
                      Clipboard.setString(uri);
                      setDetailCopied(true);
                      setDetailMenuOpen(false);
                      setTimeout(() => setDetailCopied(false), 2000);
                    }}>
                    <View style={styles.aSheetIcon}>
                      <Icon name="🔗" size={16}/>
                    </View>
                    <Text style={styles.aSheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{detailCopied ? 'Copied ✓' : 'Copy link'}</Text>
                  </Press>
                  {onToggleBookmark && (
                    <Press variant="row" style={styles.aSheetItem} onPress={() => { setDetailMenuOpen(false); onToggleBookmark(openPost.id); }}>
                      <View style={styles.aSheetIcon}>
                        <Icon name={bookmarkedSet.has(openPost.id) ? '✅' : '🔖'} size={16}/>
                      </View>
                      <Text style={styles.aSheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{bookmarkedSet.has(openPost.id) ? 'Saved · tap to remove' : 'Save'}</Text>
                    </Press>
                  )}
                  <Press variant="row" style={styles.aSheetItem} onPress={() => { setDetailMenuOpen(false); /* TODO wire mute */ }}>
                    <View style={styles.aSheetIcon}>
                      <Icon name="🔕" size={16}/>
                    </View>
                    <Text style={styles.aSheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Mute this author</Text>
                  </Press>
                  {onReportPost && (
                    <Press variant="row" style={[styles.aSheetItem, styles.aSheetItemLast]} onPress={() => { setDetailMenuOpen(false); onReportPost(openPost.id, openPost.authorPubkey); }}>
                      <View style={styles.aSheetIcon}>
                        <Icon name="🚩" size={16}/>
                      </View>
                      <Text style={[styles.aSheetText, styles.aSheetDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Report</Text>
                    </Press>
                  )}
                </View>
                <Press style={styles.aSheetCancel} onPress={() => setDetailMenuOpen(false)}>
                  <Text style={styles.aSheetCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
                </Press>
              </Press>
            </Press>
          </Modal>
          {/* ── Author's-note edit-history dialog — scrollable list of every version ──
              AUTHOR_NOTE_ENABLED (config.ts): its only entry point ("view prior edits" above)
              is already gated, so historyModalOpen can never flip true while OFF — this element
              is also gated directly as defense-in-depth so no trace of the surface remains. */}
          {AUTHOR_NOTE_ENABLED && (
          <Modal visible={historyModalOpen} transparent animationType="fade" onRequestClose={() => setHistoryModalOpen(false)}>
            <Press variant="bare" style={styles.histBack} onPress={() => setHistoryModalOpen(false)} accessibilityRole="none">
              <Press variant="bare" style={styles.histSheet} onPress={() => {}} accessibilityRole="none">
                <View style={styles.histHead}>
                  <Text style={styles.histHeadTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>AUTHOR'S NOTE · PRIOR EDITS</Text>
                  <Text style={styles.histHeadNum} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    {pinnedHistory ? `${pinnedHistory.history.length} earlier` : ''}
                  </Text>
                </View>
                <ScrollView style={styles.histList} contentContainerStyle={styles.histListContent}>
                  {pinnedHistory?.latest && (
                    <View style={styles.histItem}>
                      <Text style={styles.histTsCurrent} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        CURRENT · {new Date(pinnedHistory.latest.created_at * 1000).toLocaleString()}
                      </Text>
                      <Text style={styles.histText}>{labelInlineMedia(pinnedHistory.latest.content)}</Text>
                    </View>
                  )}
                  {[...(pinnedHistory?.history ?? [])].reverse().map(ev => (
                    <View key={ev.id} style={styles.histItem}>
                      <Text style={styles.histTs} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{new Date(ev.created_at * 1000).toLocaleString()}</Text>
                      <Text style={styles.histText}>{labelInlineMedia(ev.content)}</Text>
                    </View>
                  ))}
                </ScrollView>
                <Press style={styles.histDone} onPress={() => setHistoryModalOpen(false)}>
                  <Text style={styles.histDoneText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
                </Press>
              </Press>
            </Press>
          </Modal>
          )}
        </SwipeBackOverlay>
        </ErrorBoundary>
        )}

      {/* ── Channels tab ──
          The list layer stays active (visible + live) for the WHOLE channels tab, sub-screens
          included: a channel/group/create/new-message opens as an opaque overlay ABOVE it, so the
          entrance animates over real content and Back reveals the untouched list with zero remount
          (exactly how the feed treats its thread overlay). */}
      <TabLayer active={tab === 'channels'} covered={tabsCovered} testID="tab-layer-channels">
        <View style={styles.flex}>
          {/* One toolbar: the All/DMs/Public/Private/Group filter (scrolls) on the left, the new-DM
              (✏️) and "+ New" actions pinned on the right. The old "Channels" title row is gone — the
              bottom dock already names the tab — and folding it into the filter row collapses two
              stacked bars into a single clean one and keeps the list higher on screen. */}
          <View style={styles.channelBar}>
            {/* Recessed pill track behind the scrollable chips (Task C) — makes it read as ONE
                scrollable strip rather than chips floating loose against the bar's own background. */}
            <View style={styles.channelFilterTrack}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                // Dragging the filter chips scrolls them instead of switching tab (stage swipe
                // stands down while touched); tapping a chip still selects the filter.
                {...railTouchHandlers}
                style={styles.channelFilterScroll}
                contentContainerStyle={styles.channelFilterRow}>
                {([
                  {key: 'all',     label: 'All'},
                  {key: 'dms',     label: 'DMs'},
                  {key: 'public',  label: 'Public'},
                  {key: 'private', label: 'Private'},
                  {key: 'group',   label: 'Group'},
                ] as const).map(({key, label}) => (
                  <Press
                    key={key}
                    accessibilityLabel={`Filter ${label}`}
                    style={[styles.channelFilterChip, channelFilter === key && styles.channelFilterChipActive]}
                    onPress={() => setChannelFilter(key)}>
                    <Text
                      style={[styles.channelFilterText, channelFilter === key && styles.channelFilterTextActive]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {label}
                    </Text>
                  </Press>
                ))}
              </ScrollView>
            </View>
            <View style={styles.channelHeaderActions}>
              {/* Left-edge fade (Task C): an opaque panel with a hard edge reads as the chip strip
                  getting CLIPPED; fading colors.bg in from transparent makes it read as the chips
                  sliding UNDER the pinned actions instead. Purely decorative — never eats touches. */}
              <View style={styles.channelActionsFade} pointerEvents="none">
                <Svg width="100%" height="100%">
                  <Defs>
                    <LinearGradient id="chActFade" x1="0" y1="0" x2="1" y2="0">
                      <Stop offset="0" stopColor={colors.bg} stopOpacity={0} />
                      <Stop offset="1" stopColor={colors.bg} stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect x="0" y="0" width="100%" height="100%" fill="url(#chActFade)" />
                </Svg>
              </View>
              <Press style={styles.channelNewDmBtn} onPress={() => setShowNewMessage(true)} accessibilityLabel="new-message">
                <Text style={styles.channelNewDmIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️</Text>
              </Press>
              <Press style={styles.newChannelBtn} onPress={() => setShowCreateChannel(true)}>
                <Text style={styles.newChannelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>+ New</Text>
              </Press>
            </View>
          </View>

          {/* While searching, the bar lives in the header row (expanding search) and this list
              filters live by channel / group / person name below it. */}

          {/* Unified channel+DM list */}
          {/* INVITATION cards (membership handoff): accept-first consent atop the inbox. Nothing
              is shared with the space until Accept; "Not now" is a local-only dismissal. */}
          {spaceInvites.map(inv => {
            const inviterName = onGetProfile?.(inv.inviter)?.name?.trim()
              || shortenNpub(safeNpubEncode(inv.inviter) ?? inv.inviter, {lead: 10, tail: 4});
            const sub = `${inv.kindWord}${inv.memberCount ? ` · ${inv.memberCount} member${inv.memberCount === 1 ? '' : 's'}` : ''} · invited by ${inviterName}`;
            return (
              <View key={inv.groupId} style={styles.invCard}>
                <Text style={styles.invLabel}>✉️ INVITATION</Text>
                <View style={styles.invHead}>
                  <GradientAvatar
                    seed={inv.groupId}
                    size={40}
                    shape={inv.kindWord === 'Group chat' ? 'hexagon' : 'diamond'}
                  />
                  <View style={styles.invHeadText}>
                    <Text style={styles.invName} numberOfLines={1}>{inv.name ?? 'Private space'}</Text>
                    <Text style={styles.invSub} numberOfLines={1}>{sub}</Text>
                  </View>
                </View>
                <View style={styles.invActions}>
                  <Press
                    style={styles.invAccept}
                    onPress={() => onAcceptSpaceInvite?.(inv.groupId)}
                    accessibilityLabel={`accept-invite-${inv.groupId}`}>
                    <Text style={styles.invAcceptText}>Accept</Text>
                  </Press>
                  <Press
                    style={styles.invDecline}
                    onPress={() => onDismissSpaceInvite?.(inv.groupId)}
                    accessibilityLabel={`dismiss-invite-${inv.groupId}`}>
                    <Text style={styles.invDeclineText}>Not now</Text>
                  </Press>
                </View>
                <Text style={styles.invCaption}>Nothing is shared with the space until you accept.</Text>
              </View>
            );
          })}
          <ChannelList
            channels={searchActive ? channels.filter(c => listMatches([c.name, c.about])) : channels}
            groups={searchActive ? groups.filter(g => listMatches([g.name])) : groups}
            inbox={searchActive ? inbox.filter(c => listMatches([onGetProfile?.(c.peer)?.name, c.peerNpub, c.preview])) : inbox}
            filter={channelFilter}
            currentUserPubkey={currentUserPubkey}
            subscribedIds={subscribedChannelIds}
            readVersion={readVersion}
            // Bug #6: a channel/group-only write never changes `feed`'s identity (see the
            // channelMsgs/openGroup* memos above) — compose the scoped counters instead so
            // per-row previews/unread badges recompute on the writes that actually touch them.
            feedToken={`${storeVersions.channels}:${storeVersions.groups}`}
            onGetChannelMessages={onGetChannelMessages}
            onGetGroupMessages={onGetGroupMessages}
            onGetGroupState={channelListGetGroupState}
            onOpenChannel={id => {
              cancelSearch();
              markSourceSeen(chSeenId(id), onGetChannelMessages(id));
              setChannelDetailOpen(false);
              setOpenChannelId(id);
            }}
            onOpenGroup={id => {
              cancelSearch();
              if (onGetGroupMessages) markSourceSeen(grpSeenId(id), onGetGroupMessages(id));
              setOpenGroupId(id);
            }}
            onOpenDm={peer => {
              cancelSearch();
              const conv = inbox.find(c => c.peer === peer);
              if (conv) void markSeen(dmSeenId(peer), conv.lastAt).then(adv => { if (adv) setReadVersion(v => v + 1); });
              setOpenPeer(peer);
            }}
            onNewChannel={() => setShowCreateChannel(true)}
            onNewDm={() => setShowNewMessage(true)}
            onGetProfile={onGetProfile}
            onScroll={e => { channelsScrollYRef.current = e.nativeEvent.contentOffset.y; }}
            restoreOffset={channelsScrollYRef.current}
          />
        </View>
      </TabLayer>
      {tab === 'channels' && openGroupId && (
        <ErrorBoundary scope="group-view" onReset={() => setOpenGroupId(null)}>
        {/* Swipe-back (2026-07-27): onSwipeBack is closeOpenGroupView — the SAME function GroupView's
            own onBack (below) hands to its header ‹ — per the plan's ownership rule. swipeEnabled is
            groupAtRoot, NOT a bare true: GroupView holds its own 'chat' | 'manage' | 'addpeople' state
            (task 3), and manage/add-people hold forms — a swipe there must stay inert (same as the
            BACK_PRIORITY.page peel GroupView registers for those levels) or it would fire this
            SubScreen's onSwipeBack and close the WHOLE group from two levels deep, stranding nothing
            visible (the surface unmounts) but skipping the peel-one-level contract every ‹ and BACK
            press on this surface otherwise honours. */}
        <SubScreen onSwipeBack={closeOpenGroupView} swipeEnabled={groupAtRoot}>
          {searchActive && renderSearchBar('Search messages…')}
          <GroupView
          key={openGroupId}
          listKeyFor={listKeyFor}
          historyPending={groupHistoryPending}
          groupId={openGroupId}
          initialScreen={openGroupInitialScreen}
          onEnableReplies={startEnableReplies}
          onOpenPromoted={openPromotedFeed}
          getFeedReplyCount={getFeedReplyCount}
          allowVoice={allowVoice}
          pictureRules={pictureRules}
          picturesSpentBytes={picturesSpentBytes}
          postRules={postRules}
          draftStore={draftStore}
          onOpenDrafts={() => { void openDrafts(); }}
          onGetPhonebook={buildPhonebookContacts}
          name={openGroupState?.name ?? groups.find(g => g.id === openGroupId)?.name ?? 'group'}
          about={openGroupState?.about}
          closed={openGroupState?.closed}
          isPrivate={openGroupState?.private}
          gradient={openGroupState?.gradient}
          broadcast={openGroupState?.broadcast}
          reactions={openGroupSettings?.reactions ?? openGroupState?.reactions}
          members={openGroupMembers}
          admins={openGroupAdmins}
          pending={openGroupPending}
          messages={searchActive
            ? filterMessages(openGroupMsgs, m => m.content, m => m.created_at)
            : openGroupMsgs}
          repliesByParent={openGroupReplies}
          currentUserPubkey={currentUserPubkey ?? undefined}
          isMember={!!currentUserPubkey && openGroupMembers.includes(currentUserPubkey)}
          isAdmin={!!currentUserPubkey && openGroupAdmins.includes(currentUserPubkey)}
          isOwner={!!currentUserPubkey && openGroupState?.owner === currentUserPubkey}
          onJoin={() => onJoinGroup?.(openGroupId)}
          onLeave={() => { onLeaveGroup?.(openGroupId); setOpenGroupId(null); }}
          onKick={pubkey => onKickGroupMember?.(openGroupId, pubkey)}
          onAddMember={onAddGroupMember ? (pk, asAdmin) => onAddGroupMember(openGroupId, pk, asAdmin) : undefined}
          joinQueue={onGetJoinRequestQueue?.(openGroupId)}
          onGetRosterActionStatus={onGetRosterActionStatus ? pk => onGetRosterActionStatus(openGroupId, pk) : undefined}
          invited={onGetInvited?.(openGroupId)}
          onInvitePeople={onInvitePeople ? pks => onInvitePeople(openGroupId, pks) : undefined}
          onRevokeInvite={onRevokeInvite ? pk => onRevokeInvite(openGroupId, pk) : undefined}
          shareToken={openGroupShareToken}
          onEditGroup={onEditGroup ? meta => onEditGroup(openGroupId, meta) : undefined}
          pinnedMessageId={openGroupSettings?.pinnedMessageId}
          onSetPinned={onSetSpaceSettings ? mid => {
            const cur = onGetSpaceSettings?.(openGroupId, 'group')?.settings;
            onSetSpaceSettings(openGroupId, {
              rules: cur?.rules ?? DEFAULT_SPACE_RULE_SET,
              reactions: cur?.reactions,
              pinnedMessageId: mid ?? undefined,
            });
          } : undefined}
          onSaveReactions={onSetSpaceSettings ? reactions => {
            const cur = onGetSpaceSettings?.(openGroupId, 'group')?.settings;
            onSetSpaceSettings(openGroupId, {
              rules: cur?.rules ?? DEFAULT_SPACE_RULE_SET,
              reactions: reactions.length > 0 ? reactions : undefined,
              pinnedMessageId: cur?.pinnedMessageId,
            });
          } : undefined}
          logOffer={openLogOffer}
          onSetLogOffer={onSetLogOffer ? () => onSetLogOffer(openGroupId) : undefined}
          onRevokeLogOffer={onRevokeLogOffer ? () => onRevokeLogOffer(openGroupId) : undefined}
          onApprove={onApproveJoin ? pk => onApproveJoin(openGroupId, pk) : undefined}
          onDeny={onDenyJoin ? pk => onDenyJoin(openGroupId, pk) : undefined}
          onDelete={onDeleteGroup ? () => { onDeleteGroup(openGroupId); setOpenGroupId(null); } : undefined}
          onTransfer={onTransferGroupOwner ? pk => onTransferGroupOwner(openGroupId, pk) : undefined}
          onPostChat={(text, replyTo) => toVoidPromise(onPostToGroup?.(openGroupId, text, replyTo))}
          onReply={onReplyToGroup ? (parentId, text) => onReplyToGroup(openGroupId, parentId, text) : undefined}
          getMessageInteractions={mid => getGroupPostInteractions?.(openGroupId, mid) ?? {comments: false, reactions: false}}
          onSetMessageInteractions={(mid, perm) => onSetGroupInteractions?.(openGroupId, mid, perm)}
          onReactToMessage={(mid, pk) => onReactToGroupMessage?.(openGroupId, mid, pk)}
          onReactWithEmoji={(mid, pk, emoji) => onReactToGroupMessage?.(openGroupId, mid, pk, emoji)}
          onGetChannelThread={onGetChannelThread}
          onPostChannelComment={onPostChannelComment}
          onGetReactionsByTarget={onGetReactionsByTarget}
          getAuthorGradient={pubkey => onGetProfile?.(pubkey)?.gradient}
          onEditGroupMessage={onEditGroupMessage ? (mid, content) => toVoidPromise(onEditGroupMessage(openGroupId, mid, content)) : undefined}
          onIsSpaceKeyMissing={onIsSpaceKeyMissing}
          onLookupEvent={onGetEvent}
          // A group has no single-message overlay of its own (unlike a channel's ChannelPostView) —
          // every embed/reference tap here is necessarily "cross-surface", so it always routes
          // through the unified resolver, exactly like the DM path. Previously this set
          // openChannelPostId directly, which nothing renders while a GROUP (not a channel) is
          // open — a dead tap.
          onOpenRef={openEmbedTarget}
          onOpenInviteLink={onAcceptInviteLink}
          onOpenMember={onGetProfile ? pubkey => {
            if (openGroupId) pushNavOrigin({kind: 'group', groupId: openGroupId}, {kind: 'profile', pubkey});
            setOpenGroupId(null);
            setOpenProfile(onGetProfile(pubkey));
          } : undefined}
          onGetDisplayName={onGetProfile ? p => onGetProfile(p)?.name : undefined}
          sendStatus={sendStatus}
          sendReasons={sendReasons}
          onRetry={onRetry}
          onCancel={onCancelSend}
          onLoadOlder={onLoadOlderGroupPage ? () => {
            // Bug #3: stream in older group history past the locally-cached message set.
            const oldest = openGroupMsgs.reduce((min, m) => Math.min(min, m.created_at), Infinity);
            if (Number.isFinite(oldest)) onLoadOlderGroupPage(openGroupId, oldest);
          } : undefined}
          onBack={closeOpenGroupView}
          // Swipe-back (2026-07-27, task 3): lifts whether GroupView is sitting on its 'chat' root
          // into groupAtRoot above, so this SubScreen's swipeEnabled can gate the drag to just that
          // root — see the comment at the <SubScreen> open tag.
          onAtRootChange={setGroupAtRoot}
          />
        </SubScreen>
        </ErrorBoundary>
      )}
      {tab === 'channels' && showNewMessage && (
        // Swipe-back (2026-07-27): onSwipeBack is closeNewMessageScreen — the SAME identifier passed
        // to NewMessageScreen's own onBack below (hoisted from what used to be a duplicated inline
        // arrow) — per the plan's ownership rule.
        <SubScreen onSwipeBack={closeNewMessageScreen}>
        <NewMessageScreen
          contacts={newMessageContacts}
          channels={newMessageChannels}
          onSelect={pubkey => { setShowNewMessage(false); openDM(pubkey); }}
          onSelectChannel={id => {
            setShowNewMessage(false);
            cancelSearch();
            markSourceSeen(chSeenId(id), onGetChannelMessages(id));
            setChannelDetailOpen(false);
            setOpenChannelId(id);
          }}
          onBack={closeNewMessageScreen}
        />
        </SubScreen>
      )}
      {tab === 'channels' && showCreateChannel && (
        <SubScreen>
          <CreateChannel
            managedAvailable={relaySupportsNip29 && !!onCreateGroup}
            onBack={() => setShowCreateChannel(false)}
            onCreate={(meta, kind, closed, isPrivate, broadcast) => {
              setShowCreateChannel(false);
              // Optimistic reveal: the created space is already in the store (publishOptimistic +
              // optimistic group state), so navigate straight INTO it instead of dropping the user
              // back in the list to hunt for it (which read as "it didn't generate").
              if (kind === 'group' && onCreateGroup) {
                void Promise.resolve(onCreateGroup(meta, closed, isPrivate, broadcast)).then(id => {
                  if (id) { cancelSearch(); setOpenGroupId(id); }
                });
              } else {
                void Promise.resolve(onCreateChannel(meta)).then(id => {
                  if (id) { cancelSearch(); setChannelDetailOpen(false); setOpenChannelId(id); }
                });
              }
            }}
          />
        </SubScreen>
      )}
      {/* A tapped public-channel card (finding 1) can point at a coordinate NOT yet in the local
          `channels` store — openChannelId is set optimistically while the 30311 metadata is
          fetched by coordinate (see openEmbedTarget). Previously nothing rendered here at all: the
          list above is suppressed by `!openChannelId`, and the ChannelView branch below requires a
          resolved `openChannel` — a blank tab. Show a lightweight loading placeholder instead; once
          the metadata event lands, `channels` picks it up on the next snapshot and this gives way
          to the real ChannelView below. A Retry action rides alongside it from the start (rather
          than a delayed "stuck" timer — a bare setTimeout here would outlive an unmounted screen
          and fire into a torn-down tree) so a fetch that genuinely never lands never leaves Back
          as the only way out. */}
      {tab === 'channels' && openChannelId && !openChannel && !showCreateChannel && !showNewMessage && (
        <SubScreen>
          <View style={styles.channelHeader}>
            <BackButton label="Back" onPress={closeOpenChannelView} size="sm" />
          </View>
          <EmptyState
            icon="🌐"
            title="Opening channel…"
            subtitle="This can take a moment on a slow connection. Taking too long? Try again."
            action={{label: 'Retry', onPress: retryOpenChannel}}
            style={styles.channelLoadingWrap}
          />
        </SubScreen>
      )}
      {tab === 'channels' && openChannelId && openChannel && !channelDetailOpen && (
        <ErrorBoundary scope="channel-view" onReset={() => setOpenChannelId(null)}>
        {/* Swipe-back (2026-07-27): onSwipeBack is closeOpenChannelView — the SAME function ChannelView
            passes as its own onBack (below) — per the plan's ownership rule. No inner-page state to
            protect here (unlike GroupView), so swipeEnabled stays the default true. */}
        <SubScreen onSwipeBack={closeOpenChannelView}>
          {searchActive && renderSearchBar('Search messages…')}
          <ChannelView
            key={openChannel.id}
            listKeyFor={listKeyFor}
            historyPending={channelHistoryPending}
            onBack={closeOpenChannelView}
            channel={openChannel}
            onEnableReplies={startEnableReplies}
            onOpenPromoted={openPromotedFeed}
            getFeedReplyCount={getFeedReplyCount}
            allowVoice={allowVoice}
            pictureRules={pictureRules}
            picturesSpentBytes={picturesSpentBytes}
            postRules={postRules}
            draftStore={draftStore}
            onOpenDrafts={() => { void openDrafts(); }}
            messages={searchActive ? filterMessages(channelMsgs, m => m.content, m => m.created_at) : channelMsgs}
            isOwner={openChannel.owner === currentUserPubkey}
            currentUserPubkey={currentUserPubkey ?? undefined}
            subscribed={subscribedChannelIds?.includes(openChannelId)}
            onSubscribe={onSubscribeChannel ? () => onSubscribeChannel(openChannelId) : undefined}
            onUnsubscribe={onUnsubscribeChannel ? () => onUnsubscribeChannel(openChannelId) : undefined}
            onBroadcast={text => toVoidPromise(onPostToChannel(openChannelId, text))}
            onEditMessage={onEditChannelMessage ? (id, text) => toVoidPromise(onEditChannelMessage(openChannelId, id, text)) : undefined}
            onOpenDetail={() => setChannelDetailOpen(true)}
            sendStatus={sendStatus}
            sendReasons={sendReasons}
            onRetry={onRetry}
            onCancel={onCancelSend}
            onLoadOlder={onLoadOlderChannelPage ? () => {
              // Bug #3: stream in older channel history past the locally-cached message set.
              const oldest = channelMsgs.reduce((min, m) => Math.min(min, m.created_at), Infinity);
              if (Number.isFinite(oldest)) onLoadOlderChannelPage(openChannel.id, oldest);
            } : undefined}
            onGetEvent={onGetEvent}
            onGetChannelThread={onGetChannelThread}
            onPostChannelComment={onPostChannelComment}
            canModerate={openChannel.owner === currentUserPubkey}
            onModerate={(id, authorPubkey) => onChannelOwnerHide?.(id, authorPubkey)}
            getAuthorName={pubkey => onGetProfile?.(pubkey)?.name}
            getAuthorGradient={pubkey => onGetProfile?.(pubkey)?.gradient}
            onOpenAuthor={onGetProfile ? pubkey => {
              if (openChannelId) pushNavOrigin({kind: 'channel', channelId: openChannelId}, {kind: 'profile', pubkey});
              setOpenChannelId(null);
              setOpenProfile(onGetProfile(pubkey));
            } : undefined}
            getMessageInteractions={mid => getChannelMessageInteractions?.(openChannel.id, mid) ?? {comments: false, reactions: false}}
            onSetMessageInteractions={onSetChannelInteractions}
            reactionEmojis={resolveReactionPalette(openChannel.reactions)}
            onGetReactionsByTarget={onGetReactionsByTarget}
            onReactToMessage={onReactToChannelMessage}
            pinnedMessageId={openChannel.pinnedMessageId}
            onSetPinned={onSetChannelPinned ? mid => onSetChannelPinned(openChannel.id, mid) : undefined}
            onOpenMessage={mid => setOpenChannelPostId(mid)}
            // A reference embed inside a message body may point at a post that ISN'T in this
            // channel (a feed post, a different channel, a group message, …) — setting
            // openChannelPostId for an id absent from channelMsgs used to render nothing at all
            // (the overlay below bails on a missed find). Keep the direct single-post overlay for
            // an in-channel hit; route everything else through the unified resolver.
            onOpenRef={mid => {
              if (channelMsgs.some(m => m.id === mid)) setOpenChannelPostId(mid);
              else openEmbedTarget(mid);
            }}
            onReportMessage={onReportPost}
          />
        </SubScreen>
        </ErrorBoundary>
      )}
      {tab === 'channels' && openChannelId && openChannel && openChannelPostId && (() => {
        const post = channelMsgs.find(m => m.id === openChannelPostId);
        if (!post) return null;
        const isChOwner = openChannel.owner === currentUserPubkey;
        const interactions = getChannelMessageInteractions?.(openChannel.id, post.id) ?? {comments: false, reactions: false};
        return (
          // Swipe-back (2026-07-27): onSwipeBack is closeOpenChannelPostView — the SAME function
          // onBack below hands to the header's ‹ — per the plan's ownership rule.
          <SwipeBackOverlay onSwipeBack={closeOpenChannelPostView} style={styles.threadOverlay}>
            <ChannelPostView
              channelName={openChannel.name}
              message={post}
              isOwner={isChOwner}
              repliesEnabled={interactions.comments || isChOwner}
              // Surface audit (T4.4): the single-post overlay was the one surface missing "Enable
              // replies" — startEnableReplies/openPromotedFeed are the SAME handlers ChannelView and
              // GroupView already wire for their own cards.
              onEnableReplies={startEnableReplies}
              onOpenPromoted={openPromotedFeed}
              promotedReplyCount={(() => { const fid = promotedFeedId(post); return fid ? getFeedReplyCount(fid) : undefined; })()}
              showAuthor={new Set(channelMsgs.map(m => m.pubkey)).size > 1}
              onBack={closeOpenChannelPostView}
              reactionEmojis={resolveReactionPalette(openChannel.reactions)}
              reactionEvents={onGetReactionsByTarget?.().get(post.id) ?? []}
              currentUserPubkey={currentUserPubkey ?? undefined}
              onReact={onReactToChannelMessage ? emoji => onReactToChannelMessage(post.id, post.pubkey, emoji) : undefined}
              thread={onGetChannelThread?.(post.id) ?? []}
              onPostComment={onPostChannelComment ? content => onPostChannelComment(post.id, post.pubkey, post.kind, content) : undefined}
              sendStatus={sendStatus}
              sendReasons={sendReasons}
              sendQueuedOffline={sendQueuedOffline}
              onRetryComment={onRetry}
              onCancelComment={onCancelSend}
              allowVoice={allowVoice}
              pictureRules={pictureRules}
              picturesSpentBytes={picturesSpentBytes}
              canModerate={isChOwner}
              onModerate={(id, authorPubkey) => onChannelOwnerHide?.(id, authorPubkey)}
              getAuthorName={pubkey => onGetProfile?.(pubkey)?.name}
              getAuthorGradient={pubkey => onGetProfile?.(pubkey)?.gradient}
              onGetEvent={onGetEvent}
              // Mirrors the channel-list onOpenRef above: a card embedded in this post/comment may
              // point at another post in this same channel (re-target the single-post overlay) or
              // anywhere else (feed post, different channel, group message, space card, …), which
              // the shared resolver handles.
              onOpenRef={mid => {
                if (channelMsgs.some(m => m.id === mid)) setOpenChannelPostId(mid);
                else openEmbedTarget(mid);
              }}
            />
          </SwipeBackOverlay>
        );
      })()}
      {tab === 'channels' && openChannelId && openChannel && (
        <Modal
          visible={channelDetailOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setChannelDetailOpen(false)}>
          <Press variant="bare" style={styles.sheetBackdrop} onPress={() => setChannelDetailOpen(false)} accessibilityRole="none" />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <ChannelDetail
              channel={openChannel}
              isOwner={openChannel.owner === currentUserPubkey}
              canEdit={openChannel.owner === currentUserPubkey}
              channelType={openChannel.openCommunity ? 'open' : 'public'}
              relationship={
                openChannel.owner === currentUserPubkey
                  ? 'owner'
                  : subscribedChannelIds?.includes(openChannel.id)
                    ? 'following'
                    : 'none'
              }
              onFollow={onSubscribeChannel ? () => onSubscribeChannel(openChannel.id) : undefined}
              onLeave={onUnsubscribeChannel ? () => { onUnsubscribeChannel(openChannel.id); setChannelDetailOpen(false); } : undefined}
              onSaveChannel={meta => onEditChannel?.(openChannel.id, meta)}
              onDeleteChannel={onDeleteChannel ? () => {
                onDeleteChannel(openChannel.id);
                setChannelDetailOpen(false);
                setOpenChannelId(null);
              } : undefined}
              onOpenOwner={onGetProfile ? pubkey => {
                setChannelDetailOpen(false);
                setOpenProfile(onGetProfile(pubkey));
              } : undefined}
              onSaveToEmbed={handleSaveSpaceToEmbed}
            />
          </View>
        </Modal>
      )}

      {/* ── DM overlay (accessed via Profile → Message, not a dedicated tab) ── */}
      {messagesContent && (
        <ErrorBoundary scope="dm-conversation" onReset={() => setOpenPeer(null)}>
        {/* onSwipeBack is closeOpenPeerView — the SAME function ConversationView's own onBack (above,
            in messagesContent) hands to its header ‹ — per the plan's ownership rule. */}
        <SwipeBackOverlay onSwipeBack={closeOpenPeerView} style={styles.dmOverlay}>
          {messagesContent}
        </SwipeBackOverlay>
        </ErrorBoundary>
      )}

      {/* ── Profile overlay ── */}
      {profileContent}

      {/* ── Moderation / guide log tab ── */}
      <TabLayer active={tab === 'log'} covered={tabsCovered} testID="tab-layer-log">
        <View style={styles.flex}>
          {logContent}
        </View>
      </TabLayer>
      </Reanimated.View>
      </TabRailTouchContext.Provider>
      </PressDelayContext.Provider>
      {/* ── end of tab stage ── */}

      {/* ── Log full-post view (Overlay B): the original post behind a mod-log entry.
          A Modal (always-mounted, visible-toggled per the Android rule) so it stacks ABOVE the
          detail sheet's Modal — the design's z-order (log view → sheet → post): the sheet stays
          open beneath, and closing the post returns straight to it. ── */}
      <Modal
        visible={!!logPostInfo}
        animationType="fade"
        onRequestClose={() => setLogPostInfo(null)}>
        <SafeAreaView style={styles.logPostModalRoot}>
          {shownLogPostInfo && (() => {
            const info = shownLogPostInfo;
            const item = shownLogPost?.item ?? null;
            const npub = item?.author ?? '';
            const shortNpub = npub ? shortenNpub(npub, {lead: 12, tail: 4}) : '';
            // F-attribution fix: the shared resolver, keyed off the ORIGINAL POST's own id (not just
            // its author pubkey) so a first-ever-seen blind post's attestation still names it even
            // when the phonebook hasn't learned this author any other way yet. `item?.authorName`
            // (the FeedItem's own already-resolved field) is the next fallback, then the bare npub.
            const resolved = item ? onResolveIdentity?.(item.id) : null;
            const authorName = resolved?.name?.trim() || item?.authorName || shortNpub || 'Unknown';
            return (
              <LogPostView
                kindLabel={info.kindLabel}
                onClose={() => setLogPostInfo(null)}
                banner={{tone: info.bannerTone, text: info.bannerText, reason: info.bannerReason}}
                label={item?.label}
                labels={labels}
                title={item?.title}
                authorName={authorName}
                authorNpub={shortNpub}
                authorGradient={resolved?.gradient ?? item?.authorGradient}
                authorSeed={npub || info.targetId}
                at={item ? logRelAge(item.createdAt) : ''}
                body={item?.content ?? ''}
                score={item?.score ?? 0}
                commentCount={item?.commentCount ?? shownLogPost?.thread.length ?? 0}
                threadNodes={shownLogPost?.thread ?? []}
                getAuthorName={ev => {
                  // Bug #7 + F-attribution fix: mirrors ThreadView's own fix above — resolve a blind
                  // comment's real author via the shared resolver (attestation, then phonebook
                  // arbitration, never the raw attested name outright).
                  return onResolveIdentity?.(ev.id)?.name ?? null;
                }}
                getAuthorGradient={ev => onResolveIdentity?.(ev.id)?.gradient}
                onAuthorPress={onGetProfile ? pubkey => {
                  // A profile is an INLINE overlay (modals cover it) — close the whole modal
                  // stack, sheet included, before opening it. Remember it (FIX 1) so backing out
                  // of the profile returns to this exact log post + sheet, not just the hearth.
                  if (logPostInfo) pushNavOrigin({kind: 'logPost', info: logPostInfo, entryKey: openLogEntryKey}, {kind: 'profile', pubkey});
                  setLogPostInfo(null);
                  setOpenLogEntryKey(null);
                  setOpenProfile(onGetProfile(pubkey));
                } : undefined}
                composer={
                  info.composerClosed || !item || !onComment
                    ? {mode: 'closed', text: info.closedText}
                    : {
                        mode: 'open',
                        onSubmit: text =>
                          onComment(text, item.id, item.authorPubkey, item.kind, item.id, item.authorPubkey, item.kind),
                        allowVoice,
                        pictureRules,
                        picturesSpentBytes,
                      }
                }
                saved={item ? bookmarkedSet.has(item.id) : false}
                onToggleSave={item && onToggleBookmark ? () => onToggleBookmark(item.id) : undefined}
              />
            );
          })()}
        </SafeAreaView>
      </Modal>

      {/* ── LOCKED PREVIEW (membership handoff): full-screen request-to-join for a private space
          the viewer isn't in. Metadata only + optional intro note; after sending, a withdrawable
          "Request sent" card. A silent decline never renders — the card just stays pending.
          Always-mounted (visible toggled) per the Android Modal rule — it can be triggered from
          ANY surface (feed, DM, channel, group, Log) via openEmbedTarget. ── */}
      <Modal
        visible={!!joinReq}
        animationType="slide"
        onRequestClose={() => setJoinReq(null)}>
        <SafeAreaView style={styles.pvRoot}>
          {/* pvRoot (immediately above) carries the opaque backdrop (colors.bg) and stays static —
              SwipeBackView wraps just the CONTENT below, so the strip a drag reveals is app
              background, never a bare Dialog window. onBack is the same expression the Modal's own
              onRequestClose (above) uses, per the plan's ownership rule. */}
          <SwipeBackView onBack={() => setJoinReq(null)}>
          {(() => {
            if (!joinReq) return null;
            const preview = onGetSpacePreview?.(joinReq.groupId) ?? null;
            const name = preview?.name ?? joinReq.name ?? 'Private space';
            const kindWord = preview?.kindWord ?? 'Private channel';
            const shape: AvatarShape = kindWord === 'Group chat' ? 'hexagon' : 'diamond';
            const sub = preview
              ? `${kindWord} · ${preview.memberCount} member${preview.memberCount === 1 ? '' : 's'} · ${preview.adminCount} admin${preview.adminCount === 1 ? '' : 's'}`
              : 'Invite-only space';
            const state =
              onGetJoinState?.(joinReq.groupId) ?? (joinReqSent ? 'pending' : 'none');
            // CONFIRMED root cause (Olene's field incident): the invite DM carries an admin-signed
            // grant, but a tap on the plain `stiq:space:` embed card in the message body (as opposed
            // to the invitation card itself) lands here with no grant attached, and used to default
            // straight to a bare request-to-join — discarding the grant and stranding the requester
            // on the fragile pending+auto-approve path instead of the relay-verified, admin-
            // independent instant-admit path. `spaceInvites` is keyed by group id and only populated
            // for a space with a genuine outstanding invite (getIncomingInvites), so this check is
            // safe for every other space link (no outstanding invite → unchanged behavior below).
            const outstandingInvite = spaceInvites.find(inv => inv.groupId === joinReq.groupId);
            return (
              <>
                <View style={styles.pvHeader}>
                  <Press onPress={() => setJoinReq(null)} accessibilityLabel="preview-back">
                    <Text style={styles.pvBack}>‹ Back</Text>
                  </Press>
                </View>
                <KeyboardAvoidingView
                  style={styles.flex}
                  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                  keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
                <ScrollView
                  style={Platform.OS === 'ios' ? styles.flex : undefined}
                  contentContainerStyle={styles.pvScroll}
                  keyboardShouldPersistTaps="handled">
                  <View style={styles.pvHead}>
                    <GradientAvatar
                      gradient={preview?.gradient ?? joinReq.gradient}
                      seed={joinReq.groupId}
                      size={76}
                      shape={shape}
                    />
                    <Text style={styles.pvName}>{name}</Text>
                    <Text style={styles.pvSub}>{sub}</Text>
                    {preview?.about ? <Text style={styles.pvAbout}>{preview.about}</Text> : null}
                  </View>
                  <View style={styles.pvLockCard}>
                    <Text style={styles.pvLockIcon}>🔐</Text>
                    <Text style={styles.pvLockText}>
                      Invite-only space. You can't see members or messages until an admin lets you in.
                    </Text>
                  </View>
                  {state === 'none' ? (
                    outstandingInvite ? (
                      <>
                        <View style={styles.pvLockCard}>
                          <Text style={styles.pvLockIcon}>✉️</Text>
                          <Text style={styles.pvLockText}>
                            You have an invite to this space — accept to join instantly, no admin
                            approval needed.
                          </Text>
                        </View>
                        <Press
                          style={styles.pvRequestBtn}
                          accessibilityLabel="accept-invite-from-preview"
                          onPress={() => {
                            onAcceptSpaceInvite?.(joinReq.groupId);
                            setJoinReqSent(true);
                          }}>
                          <Text style={styles.pvRequestBtnText}>Accept invite</Text>
                        </Press>
                      </>
                    ) : (
                      <>
                        <Text style={styles.pvNoteLabel}>INTRODUCE YOURSELF · OPTIONAL</Text>
                        <TextInput
                          style={styles.pvNoteInput}
                          value={joinNote}
                          onChangeText={setJoinNote}
                          placeholder="A line about who you are — only the admins see this."
                          placeholderTextColor={colors.textMuted}
                          multiline
                          numberOfLines={3}
                          maxLength={500}
                          accessibilityLabel="join-note"
                        />
                        <Press
                          style={styles.pvRequestBtn}
                          accessibilityLabel="request-to-join"
                          onPress={() => {
                            const note = joinNote.trim() || undefined;
                            if (onRequestToJoin) onRequestToJoin(joinReq.groupId, note);
                            else onJoinGroup?.(joinReq.groupId);
                            setJoinReqSent(true);
                          }}>
                          <Text style={styles.pvRequestBtnText}>Request to join</Text>
                        </Press>
                        <Text style={styles.pvCaption}>
                          Your display name and npub go with the request — nothing else.
                        </Text>
                      </>
                    )
                  ) : state === 'pending' ? (
                    <View style={styles.pvPendingCard}>
                      <Text style={styles.pvPendingTitle}>⏳ Request sent</Text>
                      <Text style={styles.pvPendingBody}>
                        An admin has to approve you. You'll be notified here when you're in.
                      </Text>
                      <Press
                        accessibilityLabel="withdraw-request"
                        onPress={() => {
                          onWithdrawJoinRequest?.(joinReq.groupId);
                          setJoinReqSent(false);
                        }}>
                        <Text style={styles.pvWithdraw}>Withdraw request</Text>
                      </Press>
                    </View>
                  ) : (
                    <Press
                      style={styles.pvRequestBtn}
                      accessibilityLabel="open-space"
                      onPress={() => {
                        const gid = joinReq.groupId;
                        setJoinReq(null);
                        setTab('channels');
                        setOpenChannelId(null);
                        setChannelDetailOpen(false);
                        setOpenGroupId(gid);
                      }}>
                      <Text style={styles.pvRequestBtnText}>You're in — open it</Text>
                    </Press>
                  )}
                </ScrollView>
                </KeyboardAvoidingView>
              </>
            );
          })()}
          </SwipeBackView>
        </SafeAreaView>
      </Modal>

      {/* ── Floating bottom navigation dock (design_handoff_bottom_nav · "Floating dock") ──
          Shared top-level chrome, mounted once here as the last child of the root SafeAreaView so it
          paints over whichever root screen is showing. Hidden on drill-in sub-screens with the SAME
          `!onSubScreen` gate the old top tab bar used. The three handlers are moved verbatim from that
          tab bar — same `tab`/`setTab` state and per-tab sub-state resets — so what navigation DOES is
          unchanged; only where the control lives changed. Modals (sheets, pickers, the log full-post
          view) render in their own native layer above it; the drill-in overlays only appear when
          `onSubScreen` is true, i.e. when the dock is hidden, so there is no z-order conflict. */}
      {!onSubScreen && (
        <BottomDock
          // Built straight off TAB_ORDER so the row's order is the swipe's order, always. The dock
          // renders them exactly like this, left to right, with no reshuffling on selection; a press
          // is a directionless jump (it can cross two tabs at once), hence direction 0.
          items={TAB_ORDER.map(key => ({
            key,
            label: key === 'feed' ? 'Current' : key === 'channels' ? 'Spaces' : 'Updates',
            active: tab === key,
            onPress: () => selectTab(key, 0),
          }))}
          // The feed's return-to-top control lives IN the dock row now (the ↑ bubble mirroring the
          // ≡ bubble). Other tabs pass nothing; sub-screens keep their own standalone JumpButtons
          // (the dock — and so this bubble — is hidden there anyway). `count` turns it into the
          // "N new posts" pill (Task: instant-refresh overhaul) whenever there's something to
          // announce; a tap both jumps to the top AND marks the feed seen, same as the auto-clear
          // the reader gets for free by scrolling there themselves (syncFeedCaughtUp above).
          jump={
            tab === 'feed'
              ? {
                  visible: feedScroll.showJump,
                  // Gated on showJump too, not just the raw count: while the bubble itself is
                  // hidden (reader at/near the top), a truthy count here would be meaningless —
                  // that content is already visible live (Task A's emit pipeline), no affordance
                  // is needed, and handing a hidden control a stale-looking count invites exactly
                  // the kind of prop/render mismatch this file's own scroll-restore tests
                  // (MainScreen.tabScrollRestore.test.tsx) assert against for `visible`.
                  count: feedScroll.showJump && newFeedItemCount > 0 ? newFeedItemCount : undefined,
                  onPress: () => {
                    feedListRef.current?.scrollToOffset({offset: 0, animated: true});
                    feedCaughtUpRef.current = true;
                    // The pill's whole promise, now literal: RELEASE the arrivals the hold has been
                    // buffering (see feedHeldRef) so the jump lands on them. feedScrollYRef is set to
                    // the offset we just commanded so the feed.items effect above cannot re-arm the
                    // hold from a stale position before the scroll animation's own onScroll frames
                    // arrive.
                    feedScrollYRef.current = 0;
                    setFeedHeld(false);
                    markFeedSeen();
                  },
                }
              : undefined
          }
        />
      )}
    </SafeAreaView>
  );
}

// ── SwipeBackOverlay ─────────────────────────────────────────────────────────────
// Shared shell for MainScreen's four bespoke drill-in overlays (feed thread, channel single-post, DM
// conversation, profile — PLAN_SWIPE_BACK_GESTURE_2026-07-27.md task 1). Each of these predates
// <SubScreen> (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) and keeps its own absolute-positioned
// overlay style rather than routing through it, so each needs its own copy of the swipe-back wiring
// SubScreen now does internally (SubScreen.tsx's useSubScreenTransition).
//
// MUST be its own mounted component — NOT a `useSubScreenTransition()` call inlined at one of the
// four call sites. Two of those sites are a `useMemo` factory (profileContent) and a conditionally-
// invoked IIFE (the channel single-post overlay); calling a hook inside either is a Rules-of-Hooks
// violation, since the call would become conditional on openProfile / openChannelPostId. Just as
// important: useSubScreenTransition's translateX/translateY live in useSharedValues scoped to
// WHICHEVER component calls it. <SubScreen>'s own drill-ins reset that state for free because each
// open is a genuine mount (their parent conditional is `cond && <SubScreen>…`, which unmounts on
// close). Calling the hook from MainScreen itself — which never unmounts — would leave a COMMITTED
// swipe's translateX pinned at `width` across a close+reopen, so the surface would reappear
// translated fully off-screen instead of at rest. A dedicated component that itself mounts fresh on
// every open gets both: a legal, unconditional hook call, and a fresh shared value every time.
function SwipeBackOverlay({
  onSwipeBack,
  style,
  children,
}: {
  /** The surface's own close expression — see the plan's ownership rule. All four current callers are
   *  unconditionally swipeable (no inner page to protect), so this component has no `swipeEnabled`
   *  prop of its own; add one the way `<SubScreen>` does if a future caller needs to withhold the
   *  drag. */
  onSwipeBack: () => void;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}): React.JSX.Element {
  const transition = useSubScreenTransition({onSwipeBack, swipeEnabled: true});
  return (
    <Reanimated.View style={[style, transition.style]} {...transition.panHandlers}>
      <SwipeOptOutContext.Provider value={transition.optOut}>{children}</SwipeOptOutContext.Provider>
    </Reanimated.View>
  );
}

function logRelAge(tsSeconds: number): string {
  const mins = Math.max(0, Math.round(Date.now() / 1000 / 60 - tsSeconds / 60));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ── ChannelList ────────────────────────────────────────────────────────────────
// Unified list of DMs (circles), NIP-29 groups (hexagons), public channels
// (rounded squares) and private groups (diamonds). Matches the design spec exactly.

type ChFilter = 'all' | 'dms' | 'public' | 'private' | 'group';

type ChSection = 'run' | 'recent';

/** A fully-resolved list row — preview text, timestamp and unread count already computed so the
 * renderer is a pure styling pass. `section` drives the card background and the right-column order
 * (run → badge over time; recent → time over unread). */
interface ChRow {
  rowKey: string;
  section: ChSection;
  seed: string;                 // gradient seed (peer / channel id / group id)
  shape: AvatarShape;
  name: string;
  preview: string;              // latest message (falls back to about / member count)
  lastAt: number;               // newest message ts; 0 hides the time
  unread: number;
  badge?: 'OWNER' | 'ADMIN';
  gradient?: GradientSpec | null;
  onPress: () => void;
}

type ChListItem = {_kind: 'header'; label: string} | ({_kind: 'row'} & ChRow);

/** Newest message's preview text + timestamp for a channel/group row — identity name header
 * stripped, bare nostr:/http references collapsed to a readable token (so a post that is only an
 * embed shows "↗ post" instead of a raw `nostr:nevent1…`), whitespace collapsed to a single line. */
function lastMsgPreview(msgs: Event[]): {text: string; at: number} {
  let newest: Event | undefined;
  for (const m of msgs) if (!newest || m.created_at > newest.created_at) newest = m;
  if (!newest) return {text: '', at: 0};
  const text = decodeNameHeader(newest.content).text
    .replace(/nostr:(?:nevent1|note1|naddr1|nprofile1|npub1)[a-z0-9]+/gi, '↗ post')
    .replace(/https?:\/\/\S+/gi, '↗ link')
    .replace(/\s+/g, ' ')
    .trim();
  return {text, at: newest.created_at};
}

const ChannelList = React.memo(function ChannelList({
  channels,
  groups,
  inbox,
  filter,
  currentUserPubkey,
  subscribedIds,
  readVersion,
  feedToken,
  onGetChannelMessages,
  onGetGroupMessages,
  onGetGroupState,
  onOpenChannel,
  onOpenGroup,
  onOpenDm,
  onNewChannel,
  onNewDm,
  onGetProfile,
  onScroll,
  restoreOffset,
}: {
  channels: Channel[];
  groups: GroupSummary[];
  inbox: Conversation[];
  filter: ChFilter;
  currentUserPubkey: string | null;
  subscribedIds?: string[];
  /** Bumps when read-state changes so unread counts recompute. */
  readVersion: number;
  /** Per-snapshot store-change token (storeVersions.channels/groups composed — see MainScreen's
   * `feedToken` call site). Drives the row useMemo so per-row store scans + private-group
   * decryption run once per actual channel/group content change, not per render. */
  feedToken: unknown;
  onGetChannelMessages: (channelId: string) => Event[];
  onGetGroupMessages?: (groupId: string) => Event[];
  onGetGroupState?: (id: string) => GroupState | undefined;
  onOpenChannel: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onOpenDm: (peer: string) => void;
  /** Empty-state primary actions — open the create-channel / new-message flows. */
  onNewChannel?: () => void;
  onNewDm?: () => void;
  onGetProfile?: (pubkey: string) => {name?: string; gradient?: GradientSpec | null} | null;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Tab-switch scroll restore (FIX 2): offset (px) to jump back to, ONCE, the first time this
   * list's content is measured after mount — this component (and the Channels tab body around it)
   * unmounts on tab switch AND on drill-down into a channel/group/DM, so a plain remount would
   * otherwise always land at offset 0. */
  restoreOffset?: number;
}): React.JSX.Element {
  const me = currentUserPubkey;

  const showDms     = filter === 'all' || filter === 'dms';
  const showPublic  = filter === 'all' || filter === 'public';
  const showGroups  = filter === 'all' || filter === 'group';
  const showPrivate = filter === 'all' || filter === 'private';

  // Resolve the entire list — per-row store scans and (for private groups) NIP-44 decryption — in one
  // useMemo (finding #5). Keyed on the row inputs plus feedToken (per-snapshot store identity) so the
  // whole list rebuilds only when the sources, filter, read-state or store actually change — NOT on
  // every MainScreen render (relay snapshots on other tabs, search keystrokes, unrelated state).
  // Callbacks are intentionally excluded: they delegate to the current runtime and feedToken already
  // captures the store snapshot they read from.
  const items = useMemo<ChListItem[]>(() => {
  const subs = new Set(subscribedIds ?? []);

  // ── Row builders (each resolves preview / time / unread up front) ───────────
  const channelRow = (c: Channel, section: ChSection): ChRow => {
    const msgs = onGetChannelMessages(c.id);
    const {text, at} = lastMsgPreview(msgs);
    return {
      rowKey: `channel_${c.id}`,
      section,
      seed: c.id,
      shape: c.openCommunity ? 'octagon' : 'square',
      name: c.name,
      preview: text || c.about || '',
      // No cached messages yet (a channel joined seconds ago — its 1311 history is still streaming
      // in over Tor) → sort by the later of when I joined and when it was created, instead of the 0
      // floor that buried it below every DM and space. Mirrors groupRow's metaAt fallback.
      lastAt: at || Math.max(joinedAt(c.id), c.metaAt ?? 0),
      // Point 7: floor-clamp to firstEnteredAt() (hides pre-join history) + show a "1" nudge for a
      // not-yet-opened space on first entry. firstEnteredAt() is 0 for an established member → the
      // plain unread count, unchanged.
      unread: spaceBadge(chSeenId(c.id), msgs, me, firstEnteredAt()),
      badge: section === 'run' ? 'OWNER' : undefined,
      gradient: c.gradient,
      onPress: () => onOpenChannel(c.id),
    };
  };

  const groupRow = (g: GroupSummary, section: ChSection): ChRow => {
    const state = onGetGroupState?.(g.id);
    const isPrivate = state?.private ?? false;
    const isBroadcast = state?.broadcast ?? false;
    const msgs = onGetGroupMessages?.(g.id) ?? [];
    const {text, at} = lastMsgPreview(msgs);
    return {
      rowKey: `group_${g.id}`,
      section,
      seed: g.id,
      // Shape must match GroupView: ONLY a broadcast+private space is a private channel (diamond).
      // A non-broadcast group (group chat / private group) is a hexagon even though it's private —
      // otherwise a group chat wrongly renders the private-channel diamond in the list.
      shape: isBroadcast && isPrivate ? 'diamond' : isBroadcast ? 'octagon' : 'hexagon',
      name: g.name,
      preview: text || `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
      // No readable messages (fresh space, or sealed history the key hasn't unlocked yet) → sort by
      // the 39000's created_at so the space surfaces near its creation/edit recency instead of
      // burying at lastAt 0 below every old row (on-device: an admin's new private channels were
      // invisible in All without deep scrolling).
      lastAt: at || Math.max(joinedAt(g.id), state?.metaAt ?? 0),
      unread: spaceBadge(grpSeenId(g.id), msgs, me, firstEnteredAt()),
      badge: section === 'run' ? 'ADMIN' : undefined,
      gradient: state?.gradient ?? null,
      onPress: () => onOpenGroup(g.id),
    };
  };

  const dmRow = (conv: Conversation): ChRow => {
    const since = lastSeen(dmSeenId(conv.peer));
    let unread = 0;
    for (const m of conv.messages) if (m.createdAt > since && m.sender !== me) unread++;
    return {
      rowKey: `dm_${conv.peer}`,
      section: 'recent',
      // npub seed (not the hex `conv.peer`) so an unclaimed peer's fallback gradient matches the
      // DM bubble / profile / inbox, which all seed with the npub form.
      seed: conv.peerNpub,
      shape: 'circle',
      name: onGetProfile?.(conv.peer)?.name ?? conv.peerNpub.slice(0, 16) + '…',
      preview: conv.preview,
      lastAt: conv.lastAt,
      unread,
      gradient: onGetProfile?.(conv.peer)?.gradient ?? null,
      onPress: () => onOpenDm(conv.peer),
    };
  };

  // ── Partition sources into the two sections, honouring the active filter ────
  const ownedChannels = channels.filter(c => c.owner === me);
  const otherChannels = channels.filter(c => c.owner !== me && subs.has(c.id));
  const adminGroups   = groups.filter(g => g.isAdmin);
  const otherGroups   = groups.filter(g => !g.isAdmin);
  const groupVisible  = (g: GroupSummary): boolean => {
    // A "private channel" is broadcast+private; every other NIP-29 space (group chat / private group)
    // belongs under the Group filter even though it's private — so a group chat isn't mis-sorted into
    // the Private tab alongside actual private channels.
    const st = onGetGroupState?.(g.id);
    const isPrivateChannel = (st?.broadcast ?? false) && (st?.private ?? false);
    if (filter === 'group')   return showGroups && !isPrivateChannel;
    if (filter === 'private') return showPrivate && isPrivateChannel;
    return showGroups || showPrivate; // 'all' / non-group filters fall through to false below
  };

  // One unified stream — every channel, group and DM in a single list, newest activity first. There
  // are no "Channels you run" / "Recent" section headers anymore (the recency order is self-evident);
  // the ones you own or admin are marked ONLY by their OWNER/ADMIN badge (carried by the 'run'
  // section), which is now the sole thing that sets them apart from the rest of the list.
  const allRows: ChRow[] = [
    ...(showPublic ? ownedChannels.map(c => channelRow(c, 'run')) : []),
    ...adminGroups.filter(groupVisible).map(g => groupRow(g, 'run')),
    ...(showDms ? inbox.map(dmRow) : []),
    ...(showPublic ? otherChannels.map(c => channelRow(c, 'recent')) : []),
    ...otherGroups.filter(groupVisible).map(g => groupRow(g, 'recent')),
  ].sort((a, b) => b.lastAt - a.lastAt); // most-recent activity first

  return allRows.map(r => ({_kind: 'row' as const, ...r}));
  // `joinedAt` (spaceJoinedAt.ts) is deliberately NOT a dep: it's a synchronous module-level mirror,
  // not React state, so it can't be listed. Every call site that mutates it already changes a listed
  // dep in the same tick — subscribeChannel emits a snapshot with a fresh `subscribedChannelIds`
  // array identity (→ subscribedIds here), and trackGroup emits one with a fresh `groups` array — so
  // this memo still recomputes exactly when a join stamp lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, groups, inbox, filter, me, subscribedIds, readVersion, feedToken]);

  // Named, stable renderItem (declared before the early return to satisfy the rules of hooks). It
  // closes over nothing volatile — only module-level styles + the pure `relTime`/GradientAvatar — so an
  // empty dep list is correct and each visible row keeps a stable render function across list updates.
  const renderRow = useCallback(({item}: {item: ChListItem}): React.JSX.Element => {
    if (item._kind === 'header') {
      return (
        <View style={styles.channelSection}>
          <Text style={styles.channelSectionText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.label}</Text>
        </View>
      );
    }
    const isRun = item.section === 'run';
    return (
      <Press
        variant="row"
        style={styles.channelRow}
        onPress={item.onPress}>
        <GradientAvatar gradient={item.gradient} seed={item.seed} size={44} shape={item.shape} />
        <View style={styles.channelRowBody}>
          <Text style={styles.channelName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.name}</Text>
          {item.preview ? (
            <Text style={styles.channelAbout} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.preview}</Text>
          ) : null}
        </View>
        <View style={styles.channelRowRight}>
          {isRun ? (
            <>
              {item.badge ? (
                <View style={styles.ownerBadge}><Text style={styles.ownerBadgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.badge}</Text></View>
              ) : null}
              {item.lastAt > 0 ? <Text style={styles.channelTime} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relTime(item.lastAt, 'short-days')}</Text> : null}
            </>
          ) : (
            <>
              {item.lastAt > 0 ? <Text style={styles.channelTime} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relTime(item.lastAt, 'short-days')}</Text> : null}
              {item.unread > 0 ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.unread > 99 ? '99+' : item.unread}</Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </Press>
    );
  }, []);

  // Tab-switch scroll restore (FIX 2), same one-shot idiom as FeedList: this component remounts on
  // every tab switch back to Channels AND on every drill-down into/out of a channel/group/DM (the
  // `!openChannelId && !openGroupId && …` guard around its call site), so a plain `useRef(false)`
  // here (re-created fresh per mount) is exactly the right scope — no cross-mount bleed to guard
  // against.
  const listRef = useRef<FlatList<ChListItem>>(null);
  const restoredRef = useRef(false);
  const handleContentSizeChange = useCallback(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (restoreOffset && restoreOffset > 0) {
      listRef.current?.scrollToOffset({offset: restoreOffset, animated: false});
    }
  }, [restoreOffset]);

  if (items.length === 0) {
    return filter === 'dms' ? (
      <EmptyState
        icon="✏️"
        title="No direct messages yet"
        subtitle="Reach someone privately from their profile, or start a new message."
        action={onNewDm ? {label: 'New message', onPress: onNewDm} : undefined}
      />
    ) : (
      <EmptyState
        icon="🌐"
        title="No channels yet"
        subtitle="Channels are spaces your community can follow. Create the first one."
        action={onNewChannel ? {label: '+ New channel', onPress: onNewChannel} : undefined}
      />
    );
  }

  return (
    <FlatList
      ref={listRef}
      style={styles.flex}
      // Tail padding so the last channel row scrolls clear of the floating bottom nav dock.
      contentContainerStyle={styles.channelListContent}
      // readVersion in extraData forces a re-render when unread counts change after opening a source.
      extraData={readVersion}
      data={items}
      keyExtractor={(item, i) => (item._kind === 'header' ? `h_${i}` : item.rowKey)}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
      // Windowing consistent with FeedList — mount only what's near the viewport so a long channel/DM
      // list doesn't build every row up front.
      removeClippedSubviews
      maxToRenderPerBatch={4}
      windowSize={7}
      initialNumToRender={5}
      renderItem={renderRow}
    />
  );
});

// ── SearchBar (design "Expanding search") ─────────────────────────────────────
// Pill field (🔍 lead icon, border brightens on focus) + accent "Cancel" text button, entering at
// 0.18s ease with opacity 0→1 + scaleX 0.94→1 per the design. `embedded` = the header-row takeover
// variant (flex:1, no chrome of its own); standalone keeps a padded hairline-bottomed row for the
// sub-screens (open channel / group / DM) whose search renders below their own headers.
//
// The search TextInput owns its own draft (finding #15): each keystroke re-renders ONLY this leaf,
// not the whole 2700-line MainScreen. The committed query is pushed up debounced (~180ms), so the
// expensive derived work at the root (arrangeFeed re-sort, ChannelList row rebuild, message
// filtering) runs a few times per second instead of once per keystroke.
const SEARCH_DEBOUNCE_MS = 180;
function SearchBar({
  placeholder,
  showTimeFrame,
  embedded = false,
  initialQuery,
  timeSel,
  onCommit,
  onOpenTimeSheet,
  onCancel,
}: {
  placeholder: string;
  showTimeFrame: boolean;
  /** Render as the header row's content (expanding-search takeover) instead of a standalone row. */
  embedded?: boolean;
  /** Committed query at mount — seeds the local draft so re-opening search preserves any live term. */
  initialQuery: string;
  timeSel: TimeSelection;
  onCommit: (q: string) => void;
  onOpenTimeSheet: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // Entrance: 0.18s ease, opacity 0→1 + scaleX 0.94→1 (design .searchbar sExpand keyframes).
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(entrance, {toValue: 1, duration: 180, easing: Easing.ease, useNativeDriver: true}).start();
  }, [entrance]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const change = (v: string): void => {
    setDraft(v);
    if (timer.current) clearTimeout(timer.current);
    // Empty ("cleared") commits immediately so results reappear without lag; non-empty is debounced.
    if (v === '') { onCommitRef.current(''); return; }
    timer.current = setTimeout(() => onCommitRef.current(v), SEARCH_DEBOUNCE_MS);
  };
  return (
    <Animated.View
      style={[
        embedded ? styles.searchRowEmbedded : styles.searchBar,
        {
          opacity: entrance,
          transform: [{scaleX: entrance.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})}],
        },
      ]}>
      <View style={[styles.sfield, focused && styles.sfieldFocused]}>
        <Icon name="🔍" size={13} />
        <TextInput
          style={styles.sinput}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          value={draft}
          onChangeText={change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoFocus
          returnKeyType="search"
          onSubmitEditing={() => { if (timer.current) clearTimeout(timer.current); onCommitRef.current(draft); }}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
        />
      </View>
      {showTimeFrame && <SearchTimeButton selection={timeSel} onPress={onOpenTimeSheet} />}
      <Press onPress={onCancel} accessibilityLabel="cancel-search">
        <Text style={styles.sCancel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
      </Press>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  // Thread view overlays the (still-laid-out) feed so the feed keeps its native scroll position.
  threadOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, zIndex: 10},
  // Quiet fallback affordance — infinite scroll is primary, so this stays small and muted.
  loadMoreBtn: {alignItems: 'center', paddingVertical: 12, paddingHorizontal: space.md},
  loadMoreText: {color: colors.textMuted, fontSize: 12.5, fontWeight: '500'},
  // minHeight pins the bar to the same height on every tab. The Feed/Channels headers carry 36px icon
  // buttons (search/bell) that the Log header lacks, which used to leave Log's bar visibly shorter —
  // minHeight makes it identical regardless of which actions are present.
  header: {minHeight: 50, paddingTop: 2, paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1},
  // M7: quiet background-sync pill — deliberately muted (surfaceAlt/textMuted, no accent) so it reads
  // as ambient status, not an alert. accessibilityLabel dupes the visible text.
  syncPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.surfaceAlt, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  syncDot: {fontSize: 7, color: colors.textMuted, lineHeight: 8},
  syncPillText: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: weight.medium},
  stiqTitle: {
    // Platform serif (fonts.serif) needs an explicit weight — it carries no bundled bold.
    fontFamily: fontSerif,
    fontWeight: '700',
    fontSize: 25,
    color: colors.textPrimary,
    letterSpacing: -0.25,
    lineHeight: 25,
  },
  stiqDot: {color: colors.accent},
  flex: {flex: 1},
  // The connection strip appears ONLY when offline (the mockup shows no banner when connected —
  // the old green "Connected via Tor" banner is intentionally gone).
  //
  // It is CHROME, not an alert. The strip that shipped through v1.4 filled the full width with solid
  // dangerBg (#3a1f1f) and stacked a centred 72%-wide meter under a wrapping label — a tall red block
  // sitting between the header and the chip rail during every normal cold connect, which is the app
  // working as designed. So: surfaceAlt ground + the same hairline the rest of the chrome divides
  // with, one text line tall (numberOfLines={1} keeps a long ladder label from re-thickening it), the
  // 16px gutter shared with the header and chip rail, and the meter moved onto the bottom edge. Red
  // is spent only on the 5px dot, and only when nothing is actually moving.
  banner: {
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bannerStalled: {backgroundColor: colors.dangerSoft},
  bannerRow: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: space.lg, paddingVertical: 5},
  // Status in 5px, echoing the header's sync pill: amber = climbing, red = nothing is moving.
  bannerDot: {width: 5, height: 5, borderRadius: 2.5},
  bannerDotWorking: {backgroundColor: colors.warning},
  bannerDotStalled: {backgroundColor: colors.danger},
  bannerText: {flexShrink: 1, fontSize: typeScale.micro, color: colors.textSecondary, fontWeight: weight.regular},
  // The whole strip is the tap target; the chevron is just the "leads somewhere" cue, so it stays
  // muted and lets the status line own the width it needs.
  bannerChevron: {marginLeft: 'auto', paddingLeft: 6, fontSize: typeScale.caption, lineHeight: 14, color: colors.textMuted},
  dmOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, zIndex: 15},

  // Log full-post modal (Overlay B) — fills the window; LogPostView's absolute fill sits inside.
  logPostModalRoot: {flex: 1, backgroundColor: colors.bg},

  // Animated chrome wrapper
  chromeWrapper: {overflow: 'hidden'},

  // Header actions (search + bell + avatar) — design .topbar .actions (gap 2, avatar +4 left)
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: 2},
  headerIconBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  meAvatar: {marginLeft: 4},
  // Bell unread badge — design .nbadge: 15px pill, accent bg, 9.5px bold count, 2px ring in the
  // page bg (the CSS box-shadow ring becomes a 2px page-bg border, so the box grows to 19 and the
  // offsets shift by 2 to keep the inner badge at the design's top-3/right-2 position).
  nbadge: {
    position: 'absolute', top: 1, right: 0,
    minWidth: 19, height: 19, borderRadius: 9.5,
    paddingHorizontal: 3.5,
    backgroundColor: colors.accent,
    borderWidth: 2, borderColor: colors.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  nbadgeText: {fontSize: 9.5, fontWeight: '700', color: colors.onAccent, lineHeight: 12},

  // ── Redesigned "Quiet" sort + tags bar (design handoff · Direction A) ──
  // Sort = plain text with a 2px accent underline on the active mode (echoes the tab underline);
  // tags = hairline chips with a single soft-accent fill on the active one ("one accent at a time",
  // no `|` divider — the groups separate by whitespace + the text-vs-chip contrast).
  qbar: {flexGrow: 0, flexShrink: 0, borderBottomWidth: 1, borderBottomColor: colors.border},
  qbarContent: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11},
  qsortGroup: {flexDirection: 'row', alignItems: 'center', gap: 16},
  qsort: {position: 'relative', paddingVertical: 7, justifyContent: 'center'},
  qsortText: {fontSize: 13.5, fontWeight: '600', color: colors.textMuted, lineHeight: 14},
  qsortTextActive: {color: colors.textPrimary},
  qsortUnderline: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, borderRadius: 2, backgroundColor: colors.accent},
  qtagGroup: {flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 12},
  qchip: {paddingVertical: 6, paddingHorizontal: 11, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: 'transparent'},
  qchipActive: {backgroundColor: colors.accentSoft, borderColor: colors.accentTint},
  qchipText: {fontSize: 12.5, fontWeight: '600', color: colors.textSecondary, lineHeight: 13},
  qchipTextActive: {color: colors.accent},

  // Pinned inline composer (design .composer)
  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingTop: 9, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  cfield: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9,
  },
  ctext: {flex: 1, fontSize: 14.5, color: colors.textMuted, fontWeight: '400'},

  // ── Expanding search (design .searchbar / .sfield / .s-cancel) ──
  // Standalone row (sub-screens: open channel / group / DM search below their own headers).
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // Header-row takeover: fills the space the wordmark + actions vacate.
  searchRowEmbedded: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0},
  sfield: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  sfieldFocused: {borderColor: colors.borderLight},
  sinput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: colors.textPrimary,
    fontSize: 14.5,
    fontWeight: '400',
  },
  sCancel: {color: colors.accent, fontSize: 14, fontWeight: '600'},

  // Thread / post page
  backBtn: {paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 8},
  backRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
  backText: {color: colors.accent, fontSize: 14, fontWeight: '400'},
  spacer: {flex: 1},

  // ── Post detail appbar (Back · Comments/Post jump · ⋯) ──
  appbar: {
    height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  appbarBack: {flexDirection: 'row', alignItems: 'center', gap: 6},
  appbarBackText: {color: colors.accent, fontSize: 17, fontWeight: '500'},
  appbarRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  jumpBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderLight,
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
  },
  jumpLabel: {fontSize: 12.5, fontWeight: '600', color: colors.textPrimary},
  jumpArrow: {fontSize: 13, color: colors.textMuted},
  appbarMore: {paddingHorizontal: 8, paddingVertical: 4},
  appbarMoreText: {fontSize: 22, lineHeight: 22, color: colors.textSecondary, fontWeight: '400'},

  // ── PV post (native render) ──
  pvPost: {paddingHorizontal: 20, paddingTop: 20, paddingBottom: 22, borderBottomWidth: 1, borderBottomColor: colors.border},
  pvTitle: {fontSize: 27, fontWeight: '700', lineHeight: 31.86, letterSpacing: -0.27, color: colors.textPrimary, marginBottom: 16},
  byline: {flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 20},
  bylineId: {flex: 1, minWidth: 0},
  bylineName: {fontSize: 15, fontWeight: '600', color: colors.textPrimary},
  bylineSub: {flexDirection: 'row', alignItems: 'center', marginTop: 2},
  bylineNpub: {fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono, flexShrink: 1},
  bylineWhen: {fontSize: 12, color: colors.textMuted, flexShrink: 0, marginLeft: 4},
  articleBody: {fontSize: 17, lineHeight: 29.24, letterSpacing: -0.05, color: colors.textPrimary, fontWeight: '400'},
  pvTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 18},
  pvTag: {
    fontSize: 11.5, color: colors.textSecondary, fontFamily: fonts.mono,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3,
  },
  // tweet detail
  dtText: {fontSize: 22, lineHeight: 31.24, letterSpacing: -0.3, color: colors.textPrimary, fontWeight: '400'},
  dtMeta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20},
  dtName: {fontSize: 12, fontWeight: '600', color: colors.textSecondary, flexShrink: 0},
  dtSub: {fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, flexShrink: 1},
  dtWhen: {fontSize: 11, color: colors.textMuted, flexShrink: 0},
  dLabel: {borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3, flexShrink: 0},
  dLabelText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.7},
  pvVote: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 999, paddingHorizontal: 6, paddingVertical: 6,
  },
  pvVoteGlyph: {fontSize: 13, lineHeight: 16, color: colors.textSecondary, fontWeight: '600', includeFontPadding: false},
  pvVoteText: {fontSize: 13, lineHeight: 16, color: colors.textSecondary, fontWeight: '600', fontVariant: ['tabular-nums'], includeFontPadding: false},
  pvVoteOnText: {color: colors.accent},
  // ── Detail ✦/💬 counter group (byline / tweet meta) ──
  detailCounters: {flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0},
  detailReplies: {fontSize: 13.5, lineHeight: 16, fontWeight: '600', color: colors.textPrimary, includeFontPadding: false},

  // ── Author's note ──
  noteWrap: {padding: 20},
  note: {
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: 8,
    paddingHorizontal: 17, paddingTop: 15, paddingBottom: 16,
  },
  noteEditing: {backgroundColor: colors.surface, borderColor: colors.accentSoft, borderRadius: 8},
  noteTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9},
  noteLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  noteLabel: {fontSize: 11, fontWeight: '700', letterSpacing: 0.99, color: colors.accent},
  noteEdit: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999},
  noteEditText: {fontSize: 13, fontWeight: '600', color: colors.accent},
  noteBody: {fontSize: 17, lineHeight: 25.5, color: colors.textPrimary, fontWeight: '400'},
  noteEmpty: {fontSize: 17, lineHeight: 25.5, color: colors.textMuted, fontStyle: 'italic', fontWeight: '400'},
  noteFoot: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 11},
  noteFootStrong: {fontSize: 12, color: colors.textSecondary, fontWeight: '400'},
  noteFootText: {fontSize: 12, color: colors.textMuted, fontWeight: '400'},
  noteInput: {fontSize: 17, lineHeight: 25.5, color: colors.textPrimary, minHeight: 78, textAlignVertical: 'top', padding: 0, fontWeight: '400'},
  noteActions: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border},
  noteCount: {fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'], fontWeight: '400'},
  noteBtnRow: {flexDirection: 'row', gap: 8},
  noteBtn: {borderRadius: 999, paddingHorizontal: 15, paddingVertical: 8, borderWidth: 1, borderColor: 'transparent'},
  noteBtnGhost: {borderColor: colors.borderLight},
  noteBtnGhostText: {fontSize: 14, fontWeight: '600', color: colors.textSecondary},
  noteBtnPrimary: {backgroundColor: colors.accent},
  noteBtnPrimaryText: {fontSize: 14, fontWeight: '600', color: colors.onAccent},

  // ── Comments head ──
  commentsHead: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, marginTop: 18, marginBottom: 14},
  commentsEyebrow: {fontSize: 11, fontWeight: '700', letterSpacing: 0.99, color: colors.textSecondary},
  commentsNum: {fontSize: 11, fontWeight: '700', color: colors.textMuted},
  commentsRule: {flex: 1, height: 1, backgroundColor: colors.border},

  // ── Shared bottom action sheet (post detail ⋯) ──
  aSheetBack: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  aSheet: {paddingHorizontal: 10, paddingBottom: 12},
  aSheetCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  aSheetItem: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 15, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: colors.border},
  aSheetItemLast: {borderBottomWidth: 0},
  aSheetIcon: {width: 16, alignItems: 'center'},
  aSheetText: {fontSize: 16, fontWeight: '500', color: colors.textPrimary},
  aSheetDanger: {color: colors.danger},
  aSheetCancel: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  aSheetCancelText: {fontSize: 16, fontWeight: '600', color: colors.accent},

  // Filter row (sort + tags merged)
  // Search date-range row — presets + custom from→to. Hairline chips matched to the Quiet bar
  // above it so the search view reads as one consistent surface (the filter logic is unchanged).

  // Channels — pixel-matched to design spec
  channelHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: 13, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  // Placeholder shown while an unresolved channel-embed coordinate is being fetched (finding 1) —
  // never a blank screen while `openChannel` hasn't resolved yet.
  channelLoadingWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg},
  // Opaque (not transparent) so the fade below reads as a true fade-to-solid rather than a fade
  // onto whatever happens to render behind it (Task C).
  channelHeaderActions: {flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.bg},
  // ~24dp fade at the actions panel's own left edge, extending OVER the neighboring chip strip so a
  // chip scrolled up against the actions reads as fading out rather than getting clipped hard.
  channelActionsFade: {position: 'absolute', left: -24, top: 0, bottom: 0, width: 24},
  channelNewDmBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderLight,
    alignItems: 'center', justifyContent: 'center',
  },
  channelNewDmIcon: {fontSize: 14},
  unreadBadge: {
    backgroundColor: colors.accent, borderRadius: radius.pill,
    paddingHorizontal: 7, paddingVertical: 1, flexShrink: 0,
  },
  unreadBadgeText: {color: '#fff', fontSize: 10.5, fontWeight: weight.bold, lineHeight: 16},
  newChannelBtn: {
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: colors.tagBg,
    borderRadius: radius.pill,
  },
  newChannelText: {color: colors.accent, fontSize: 13, fontWeight: '600'},
  channelSection: {
    paddingHorizontal: space.lg,
    paddingTop: 13,
    paddingBottom: 5,
  },
  channelSectionText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  channelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: space.lg, paddingVertical: 11,
    borderBottomColor: colors.border, borderBottomWidth: 1,
  },
  // Channel edit bottom sheet: backdrop + rounded-top sheet (~88% height) with a drag handle.
  sheetBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    maxHeight: '88%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
  },
  sheetHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.borderLight, marginBottom: 4,
  },
  channelRowBody: {flex: 1, minWidth: 0, gap: 3},
  // Right column: a vertical stack — badge-over-time (run) or time-over-unread (recent).
  channelRowRight: {alignItems: 'flex-end', justifyContent: 'center', gap: 5, marginLeft: space.sm},
  channelName: {color: colors.textPrimary, fontSize: 16, fontWeight: weight.semibold},
  channelTime: {fontSize: 12, color: colors.textMuted, flexShrink: 0, lineHeight: 16},
  channelAbout: {color: colors.textSecondary, fontSize: 13.5, lineHeight: 19},
  ownerBadge: {
    backgroundColor: colors.accentSoft, borderRadius: radius.pill,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  ownerBadgeText: {fontSize: 10, color: colors.accent, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase'},
  // Merged channels toolbar: the filter chips (a horizontal-scrolling row of pill chips, accent-filled
  // on the active one, styled like the Notifications page) share ONE hairline-bottomed bar with the
  // new-DM + "+ New" actions — the chips flex and scroll, the actions stay pinned on the right.
  channelBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 9,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  // Soft recessed track behind the scrollable chips (Task C) — same flex:1 sizing as the ScrollView
  // it wraps; purely a background decoration, no metrics of its own.
  channelFilterTrack: {flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill},
  channelFilterScroll: {flex: 1},
  channelFilterRow: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 4},
  channelFilterChip: {paddingVertical: 6, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: colors.surface},
  channelFilterChipActive: {backgroundColor: colors.accent},
  channelFilterText: {fontSize: 13, color: colors.textSecondary, fontWeight: weight.semibold},
  channelFilterTextActive: {color: colors.onAccent},
  // Tail so the channel list's last row clears the floating bottom nav dock.
  channelListContent: {paddingBottom: BOTTOM_DOCK_CLEARANCE},

  // Profile overlay
  profileOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    // Above the DM overlay (zIndex 15) so "View profile" from inside a DM actually surfaces on top;
    // Back closes the profile first (see closeInnermostOverlay) and returns to the conversation.
    zIndex: 20,
  },

  pinnedHistoryToggle: {
    fontSize: typeScale.caption,
    color: colors.link,
    marginTop: space.xs,
    fontWeight: '400',
  },
  // Author's-note edit-history dialog (centered, scrollable list of every version).
  histBack: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  histSheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  histHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  histHeadTitle: {fontSize: 11, fontWeight: '700', letterSpacing: 0.88, color: colors.textMuted},
  histHeadNum: {fontSize: 11, fontWeight: '700', color: colors.textMuted},
  histList: {flexGrow: 0},
  histListContent: {padding: space.lg, gap: space.md},
  histItem: {paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: colors.border},
  histTs: {fontSize: typeScale.micro, color: colors.textMuted, marginBottom: 4, fontWeight: '400'},
  histTsCurrent: {fontSize: typeScale.micro, color: colors.accent, marginBottom: 4, fontWeight: '700', letterSpacing: 0.5},
  histText: {fontSize: typeScale.label, color: colors.textSecondary, fontWeight: '400', lineHeight: 20},
  histDone: {paddingVertical: 14, alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border},
  histDoneText: {fontSize: 16, fontWeight: '600', color: colors.accent},

  // Locked-thread closed composer (mirrors the design's "Commenting is closed" bar)
  lockedComposer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  lockedComposerText: {
    color: colors.textMuted,
    fontSize: typeScale.caption,
  },

  linkDialogOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center'},
  linkDialog: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    width: '85%',
    gap: space.md,
  },
  linkDialogLabel: {fontSize: typeScale.caption, color: colors.textMuted, fontWeight: '600', letterSpacing: 0.5},
  linkDialogActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.sm, alignItems: 'center'},
  linkDialogCancel: {paddingHorizontal: space.md, paddingVertical: space.sm},
  linkDialogCancelText: {color: colors.textSecondary, fontSize: typeScale.body, fontWeight: '400'},
  linkDialogOpen: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  linkDialogOpenText: {color: colors.onAccent, fontSize: typeScale.body, fontWeight: '600'},

  // Compact request-to-join dialog (private-space stiq:space: token, non-member tap) — deliberately
  // tiny: a name + one primary button, no key/roster/big blob.
  // Invitation card (membership handoff) — accept-first consent atop the Channels inbox.
  invCard: {
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  invLabel: {fontSize: 10, fontWeight: '700', letterSpacing: 0.7, color: colors.accent, marginBottom: 9},
  invHead: {flexDirection: 'row', alignItems: 'center', gap: 11},
  invHeadText: {flex: 1, minWidth: 0},
  invName: {fontSize: 15, fontWeight: '700', color: colors.textPrimary},
  invSub: {fontSize: 12, color: colors.textSecondary, marginTop: 2},
  invActions: {flexDirection: 'row', gap: 8, marginTop: 11},
  invAccept: {flex: 1, backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 9, alignItems: 'center'},
  invAcceptText: {color: colors.onAccent, fontSize: 13.5, fontWeight: '600'},
  invDecline: {flex: 1, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 999, paddingVertical: 9, alignItems: 'center'},
  invDeclineText: {color: colors.textSecondary, fontSize: 13.5, fontWeight: '600'},
  invCaption: {fontSize: 11.5, color: colors.textMuted, marginTop: 9},
  // Locked preview (membership handoff) — redlines from design_handoff_membership/SPEC.md §1.
  pvRoot: {flex: 1, backgroundColor: colors.bg},
  pvHeader: {borderBottomWidth: 1, borderBottomColor: colors.border},
  pvBack: {color: colors.accent, fontSize: 14, fontWeight: '600', paddingHorizontal: 12, paddingVertical: 9},
  pvScroll: {paddingTop: 26, paddingHorizontal: 20, paddingBottom: 28},
  pvHead: {alignItems: 'center'},
  pvName: {fontSize: 22, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', lineHeight: 28, marginTop: 13},
  pvSub: {fontSize: 13, color: colors.textMuted, marginTop: 5, textAlign: 'center'},
  pvAbout: {fontSize: 14, color: colors.textSecondary, lineHeight: 22, marginTop: 12, textAlign: 'center'},
  pvLockCard: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
    marginTop: 20,
  },
  pvLockIcon: {fontSize: 15},
  pvLockText: {flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 19},
  pvNoteLabel: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginTop: 20,
    marginBottom: 8,
  },
  pvNoteInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 13,
    color: colors.textPrimary,
    fontSize: 14.5,
    minHeight: 76,
    textAlignVertical: 'top',
  },
  pvRequestBtn: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  pvRequestBtnText: {color: colors.onAccent, fontSize: 15, fontWeight: '600'},
  pvCaption: {fontSize: 11.5, color: colors.textMuted, lineHeight: 17, marginTop: 9, textAlign: 'center'},
  pvPendingCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    alignItems: 'center',
  },
  pvPendingTitle: {fontSize: 15, fontWeight: '700', color: colors.textPrimary},
  pvPendingBody: {fontSize: 13, color: colors.textSecondary, lineHeight: 20, marginTop: 6, textAlign: 'center'},
  pvWithdraw: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '600',
    textDecorationLine: 'underline',
    marginTop: 12,
  },
});
