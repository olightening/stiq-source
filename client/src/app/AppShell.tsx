/**
 * AppShell — the composition root that renders the right screen for the current app state
 * (PLAN.md §3.3, §3.5). Keeps screen selection in one place; the screens themselves are
 * dumb. State (enrollment, lock, connection, feed) is supplied by App.tsx.
 */
import React from 'react';
import type {Event} from 'nostr-tools/pure';
import {BackModal, RootBackScope} from '../ui/back';
import type {ConnectionState} from '../connection';
import type {LockState} from '../lock/autolock';
import type {Feed} from '../feed/feed';
import type {VoteDirection} from '../feed/voting';
import type {CommentNode} from '../feed/thread';
import type {Conversation} from '../dm/conversations';
import type {Channel, ChannelMetadata} from '../channels/channels';
import type {UnlockOutcome} from '../lock/controller';
import type {SendStatus} from '../nostr/outbox';
import {resolveScreen} from './route';
import {OnboardingScreen} from './screens/OnboardingScreen';
import {LockScreen} from './screens/LockScreen';
import {MainScreen} from './screens/MainScreen';
import type {Session} from '../onboarding/enrollment';
import type {PinnedCommentHistory} from '../feed/pinned';
import type {DraftStoreApi} from '../feed/drafts';
import type {TagPolicy} from '../feed/tagPolicy';
import type {LabelConfig} from '../feed/labels';
import type {PostRules} from '../feed/postRules';
import type {PostingGuidelines} from '../feed/postingGuidelines';
import type {PictureRules} from '../feed/pictureRules';
import type {RankingConfig} from '../feed/sort';
import type {ModScope} from '../moderation/organizerConfig';

export interface AppShellProps {
  enrolled: boolean;
  lock: LockState;
  connection: ConnectionState;
  /** Live Tor bootstrap progress (real percent + summary) for the onboarding connect step. */
  torBootstrap?: import('../tor/types').BootstrapProgress | null;
  /** Guided-ladder plain-language connection phase (T2, ship-dark behind GUIDED_AUTO_LADDER; null
   *  when the flag is off). Forwarded to the connect surfaces (onboarding + feed banner + Settings). */
  torPhase?: import('../tor/ladder').ConnectionPhase | null;
  /** Restart the Tor cascade under current prefs (onboarding "Try again" on a failed circuit). */
  onRetryTor?: () => void;
  feed: Feed;
  /** Scoped invalidation counters (bug #6) — see MainScreenProps.storeVersions / AppSnapshot.storeVersions. */
  storeVersions?: {channels: number; groups: number; identity: number; thread?: number; config?: number; draftAccess?: number};
  inbox: Conversation[];
  channels: Channel[];
  /** Hex pubkey of the enrolled user (null before enrollment). */
  currentUserPubkey: string | null;
  isModerator: boolean;
  /** The current user's organizer-granted moderator scopes (empty when not a moderator). */
  modScopes?: readonly ModScope[];
  /** Member reports awaiting moderator review (moderator console). */
  onGetPendingReports?: () => import('../moderation/queue').PendingReport[];
  /** Currently-banned members (moderator console). */
  onGetBannedMembers?: () => import('../moderation/bans').BannedMember[];
  /** Authors under a standing advisory rule — their posts render in the mod log (moderator console). */
  onGetLoggedAuthors?: () => import('../moderation/advisory').LoggedAuthor[];
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
  /** Per-event optimistic delivery status (sending/failed/rejected). */
  sendStatus: ReadonlyMap<string, SendStatus>;
  /** Per-event relay rejection reason (only rejected ids) — shown next to "failed". */
  sendReasons?: ReadonlyMap<string, string>;
  /** Ids whose 'sending' status is a pre-connect queue (relay/Tor not up yet) rather than an active
   *  in-flight publish — see AppSnapshot.sendQueuedOffline / Outbox.queuedOfflineIds(). Drives
   *  "Queued — connecting…" vs "Sending…" in the feed (M7). */
  sendQueuedOffline?: ReadonlySet<string>;
  /** True while a relay sync round is in progress — drives the quiet "Syncing…" header pill (M7). */
  syncing?: boolean;
  /** Retry a failed optimistic write. */
  onRetry?: (eventId: string) => void;
  /** Cancel an unsent write (stop retrying + drop the local copy). */
  onCancelSend?: (eventId: string) => void;
  /** Set when a join code QR was scanned via deep link (stiq://join). */
  incomingJoinCode?: string | null;
  onJoinCodeConsumed?: () => void;
  /** Run the automated credential exchange over Tor (App owns the Tor manager). */
  onAutoExchange?: (
    community: import('../onboarding/community').Community,
    inviteCode: string,
    hooks?: import('../onboarding/exchange').CircuitHooks,
  ) => Promise<import('../onboarding/exchange').ExchangeResult>;
  /**
   * Warm the just-joined community's real event store before the member ever reaches it — the
   * connecting step's "Getting your community ready" rung. App owns the returned prefetch handle
   * (it must hand the pre-minted account slot to enrollment and close the handle first); see
   * onboarding/prefetchCommunity.ts and the `onEnroll` wiring in App.tsx.
   */
  onPrefetchCommunity?: (session: Session) => Promise<unknown>;
  onEnroll?: (
    session: Session,
    pin: string,
    /** Optional panic-wipe PIN. Onboarding leaves this empty; set later in Settings. */
    duressPin: string,
    gradient?: import('../media/gradient').GradientSpec,
    /** Chosen community handle (display name). Stored locally, embedded in authored content. */
    handle?: string,
  ) => Promise<void>;
  /** Whether PIN lock screen is enabled (false → skip straight to feed). */
  pinEnabled?: boolean;
  /** Toggle PIN lock screen on/off. */
  onSetPinEnabled?: (enabled: boolean) => void;
  /** Verify that a PIN string matches the standard slot (returns true/false). */
  onVerifyPin?: (pin: string) => Promise<boolean>;
  /** Emergency wipe — destroys all local data and resets to fresh-install state. */
  onWipe?: () => void;
  /** Verifies a PIN on the lock screen (standard unlock vs duress wipe). */
  onSubmitPin?: (pin: string) => Promise<UnlockOutcome>;
  /** Called on any user interaction; resets the auto-lock inactivity timer. */
  onUserActivity?: () => void;
  /** M5: feed list drag/fling start-stop (AppRuntime.setScrolling) — parks deferred relay-driven
   *  re-renders for the duration so a sync burst can't jump the list under the user's finger. */
  onSetScrolling?: (scrolling: boolean) => void;
  onSubmit: (content: string, tags: string[], title?: string, label?: import('../feed/labels').PostLabel, contentWarning?: string) => void;
  /** No.5: promote a channel post into a feed thread (publishes a feed post + marks the channel message). */
  onPromoteChannelPost?: (message: import('nostr-tools/pure').Event, content: string, tags: string[], title?: string, label?: import('../feed/labels').PostLabel, contentWarning?: string) => void;
  onSendDm: (peer: string, text: string, replyTo?: string) => void;
  onReactDm?: (peer: string, targetRumorId: string, emoji: string) => void;
  onRetryDm?: (peer: string, echoId: string) => void;
  onVote: (postId: string, authorPubkey: string, direction: VoteDirection) => void;
  onCreateChannel: (meta: ChannelMetadata) => Promise<string | null> | void;
  /** Resolves false (never rejects) on a failed send — the composer awaits it to restore a failed draft. */
  onPostToChannel: (channelId: string, content: string) => Promise<boolean> | void;
  /** Author: edit one of your broadcasts in place (position-preserving). */
  onEditChannelMessage?: (channelId: string, originalId: string, content: string) => Promise<boolean> | void;
  /** Owner: edit a channel's metadata (name/about/gradient). */
  onEditChannel?: (channelId: string, meta: ChannelMetadata) => void;
  onDeleteChannel?: (channelId: string) => void;
  /** Owner: pin a broadcast to the channel's PINNED bar (null unpins). */
  onSetChannelPinned?: (channelId: string, messageId: string | null) => void;
  /** Owner: open/close comments & reactions on a channel broadcast message. */
  onSetChannelInteractions?: (messageId: string, perm: import('../channels/interactions').PostInteractions) => void;
  /** React to a channel broadcast message with one of the channel's configured emojis. */
  onReactToChannelMessage?: (messageId: string, messagePubkey: string, emoji: string) => void;
  /** All kind-7 reactions bucketed by the message id they target (for per-broadcast emoji tallies). */
  onGetReactionsByTarget?: () => Map<string, import('nostr-tools/pure').Event[]>;
  /** Read the interaction state of a channel broadcast message. */
  getChannelMessageInteractions?: (channelId: string, messageId: string) => import('../channels/interactions').PostInteractions;
  subscribedChannelIds?: string[];
  onSubscribeChannel?: (channelId: string) => void;
  onUnsubscribeChannel?: (channelId: string) => void;
  onGetThread: (postId: string) => CommentNode[];
  /** Stable list key across the optimistic placeholder→real-id swap (AppRuntime.stableListKey). */
  listKeyFor?: (id: string) => string;
  /** Has `channel:<id>` / `group:<id>` settled its stored-history replay this session? (Phase 5
   * stale-first — AppRuntime.isScopedSubSynced; gates the spaces' empty states.) */
  onIsSpaceSynced?: (subKey: string) => boolean;
  onGetChannelMessages: (channelId: string) => Event[];
  onComment?: (content: string, rootId: string, rootPubkey: string, rootKind: number, parentId: string, parentPubkey: string, parentKind: number) => void;
  onSetPinnedComment?: (postId: string, postAuthorPubkey: string, postKind: number, content: string) => void;
  onGetProfile?: (pubkey: string) => import('../profile/profile').Profile;
  /** The Events surface's one runtime seam (events/api.ts) — forwarded to MainScreen. */
  events?: import('../events/api').EventsApi;
  /** Look up a single event by ID for Nostr link preview / reference embed cards. */
  onGetEvent?: (id: string) => import('../ui/NostrLinkPreview').NostrEventSummary | null;
  /** Aggregate reaction score + the viewer's vote for an event (drives the ✦ like on comments). */
  onGetEventScore?: (id: string) => {score: number; myVote: import('../feed/voting').VoteDirection | null};
  /** Thread of kind-1111 comments under a channel broadcast message. */
  onGetChannelThread?: (messageId: string) => import('../feed/thread').CommentNode[];
  /** Post a signed comment on a channel broadcast message. */
  onPostChannelComment?: (messageId: string, messagePubkey: string, messageKind: number, content: string) => void;
  onGetPinnedHistory?: (postId: string, postAuthor: string) => PinnedCommentHistory;
  /** The Log tab's organizer-controlled hearth (kind-30078 stiq:log-page, resolved live). */
  onGetLogPage?: () => import('../channels/logPage').LogHearthData | null;
  onGetModLog?: () => import('../moderation/modlog').ModLogEntry[];
  /** Resolve the original post + thread behind a mod-log entry (for the Log's full-post view). */
  onGetLogPost?: (targetId: string) => {item: import('../feed/feed').FeedItem | null; thread: import('../feed/thread').CommentNode[]};
  onGetPostItem?: (id: string) => import('../feed/feed').FeedItem | null;
  /** The shared attribution resolver (profile/resolveDisplayIdentity.ts), by event id — forwarded
   *  through to MainScreen's post-detail header / comment / LogPostView attribution. */
  onResolveIdentity?: (id: string) => {name?: string; gradient?: import('../media/gradient').GradientSpec} | null;
  onModeratePost?: (postId: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  /** Block / unblock a DM peer LOCALLY (device-only; nothing published to the relay). */
  onBlockUser?: (pubkey: string) => void;
  onUnblockUser?: (pubkey: string) => void;
  isUserBlocked?: (pubkey: string) => boolean;
  onChannelOwnerHide?: (targetId: string, authorPubkey?: string) => void;
  onModerationRestore?: (
    targetId: string,
    targetType: import('../moderation/modlog').ModTargetType,
    authorPubkey?: string,
  ) => void;
  /** Moderator: lock/unlock a thread (no new comments while locked). */
  onModeratorLock?: (postId: string, authorPubkey: string, lock: boolean) => void;
  /** Moderator: re-tag a post's type label. */
  onModeratorRetag?: (postId: string, authorPubkey: string, label: import('../feed/labels').PostLabel) => void;
  /** Moderator: pin/unpin a post to the top of the feed. */
  onModeratorPin?: (postId: string, authorPubkey: string, pin: boolean) => void;
  /** Persistent draft store for the composer (autosave + resume). */
  draftStore?: DraftStoreApi;
  // ── Draft access control (Phase 5§D/E) — mirror the like-named AppRuntime methods 1:1; forwarded
  // straight through to MainScreen → EmbedReader, the sole consumer. See feed/draftAccess.ts's
  // module doc for the request → approve → deliver model these read/drive.
  onGetDraftAccessState?: (draftId: string) => Promise<'owner' | 'none' | 'pending' | 'approved'>;
  onGetMyDraftDelivery?: (
    draftId: string,
    ownerPubkey?: string,
  ) => Promise<import('../feed/draftAccess').DraftDeliverySnapshot | null>;
  onRequestDraftAccess?: (draftId: string, ownerPubkey: string) => Promise<void>;
  /** A draft's synthetic comment thread (Phase 7§A), keyed by its stable `shareId`. */
  onGetDraftThread?: (shareId: string) => CommentNode[];
  onGetDraftCommentCount?: (shareId: string) => number;
  // ── Owner-side "Manage access" (Phase 5§F) — mirrors the like-named AppRuntime methods 1:1;
  // forwarded straight through to MainScreen → DraftAccessScreen, the sole consumer.
  onGetDraftAccessQueue?: (draftId: string) => {pubkey: string; reqId: string; at: number; name?: string}[];
  onGetDraftAccessGranted?: (draftId: string) => {pubkey: string; at: number; name?: string}[];
  onApproveDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onDenyDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onRevokeDraftAccess?: (draftId: string, requesterPubkey: string) => Promise<void>;
  /** Save the viewer's (relay-blind) display name. */
  onSetDisplayName?: (name: string) => void;
  /** Set or change the viewer's identity gradient. */
  onSetGradient?: (spec: import('../media/gradient').GradientSpec) => void;
  /** The viewer's crafted gradient, straight from the runtime's identity store (see MainScreen). */
  myCraftedGradient?: import('../media/gradient').GradientSpec;
  /** Load the list of enrolled communities for the Settings switcher. */
  onLoadCommunities?: () => Promise<{list: import('../communities/communityStore').EnrolledCommunity[]; activeId: string | null}>;
  /** Switch the active community (updates the relay the app connects to). */
  onSwitchCommunity?: (id: string) => void;
  /** Leave a community — wipes its identity + cached data on-device (irreversible). */
  onRemoveCommunity?: (id: string) => void;
  /** Start onboarding in ADD mode to join ANOTHER community (additive; keeps existing ones). */
  onJoinAnotherCommunity?: () => void;
  /** Load the multi-identity key ring for the Settings identity switcher. */
  onLoadKeySlots?: () => Promise<{slots: import('../keys/keyRing').KeySlot[]; activeId: string | null}>;
  /** Switch the active identity by key-ring slot id. */
  onSwitchIdentity?: (slotId: string) => void;
  /** Leave a single identity (key-ring slot) — wipes that identity; drops the community only when
   *  it was the last identity in it. */
  onRemoveIdentity?: (slotId: string) => void;
  /** Start onboarding to add a new identity. */
  onAddIdentity?: () => void;
  /** True while the "Join another community" flow runs onboarding over the live app. */
  addCommunityMode?: boolean;
  /** Dismiss the add-community onboarding overlay (called on cancel or after a successful join). */
  onExitAddCommunity?: () => void;
  /** Read the user's configured Blossom upload endpoint ('' = uploads disabled). */
  onGetBlossomEndpoint?: () => string;
  /** Persist a new Blossom upload endpoint. */
  onSetBlossomEndpoint?: (url: string) => void;
  /** Read the user's preferred external browser launch id ('' = none chosen). */
  onGetPreferredBrowser?: () => string;
  /** Persist the preferred external browser (package/scheme id; '' clears it). */
  onSetPreferredBrowser?: (id: string) => void;
  /** List installed browsers (for the Settings picker). */
  onListBrowsers?: () => Promise<import('../browser/browserData').InstalledBrowser[]>;
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
  onGetConnectionPrefs?: () => import('../tor/torSettings').TorConnectionPrefs;
  /** Persist new Tor connection prefs AND reconnect under them. */
  onApplyConnectionPrefs?: (prefs: import('../tor/torSettings').TorConnectionPrefs) => void;
  /** Relays management (Settings → Relays) — forwarded through MainScreen to SettingsScreen. */
  onGetRelaySnapshot?: () => import('../communities/communityStore').RelaysSnapshot | null;
  onAddRelay?: (url: string, onionAuthKey: string | null) => Promise<void>;
  onRemoveRelay?: (host: string) => Promise<void>;
  onMuteRelay?: (spec: {url: string; onionAuthKey?: string | null}) => Promise<void>;
  onUnmuteRelay?: (host: string) => Promise<void>;
  /** T9 (APK_UPDATES): whether signed in-app updates are enabled AND the active community ships a
   *  signed repo. False ⇒ Settings hides the "App updates" section and no update check runs. */
  apkUpdatesEnabled?: boolean;
  /** Fetch+verify the community's signed F-Droid index over Tor; resolves an offer or null. */
  onCheckForUpdate?: () => Promise<import('../update/updater').UpdateInfo | null>;
  /** Download the offered APK over Tor, verify its signer/version, and launch the OS install prompt. */
  onInstallUpdate?: (info: import('../update/updater').UpdateInfo) => Promise<void>;
  /** Token/economy status (T5.1/F18) — forwarded through MainScreen to the `__DEV__`-gated Settings
   *  → Diagnostics → Token status screen. See AppRuntime.ts's AppSnapshot.tokenStatus doc. */
  tokenStatus?: import('./tokenEconomyStatus').TokenEconomyStatus;
  /** Force-refresh the per-purpose wallet counts backing tokenStatus (an async SecureStorage read) —
   *  called when the token-status screen opens / the user taps refresh. */
  onRefreshTokenStatus?: () => void;
  /** Active community's tag policy (organizer-defined). */
  tagPolicy?: TagPolicy;
  /** Organizer-defined post labels. */
  labels?: LabelConfig;
  /** Organizer-defined per-post-type rules. */
  postRules?: PostRules;
  /** Organizer posting guidelines (composer rules banner + covenant sheet); null/absent = none. */
  postingGuidelines?: PostingGuidelines | null;
  /** The active community's display name, for the composer byline ("Posting to <b>{name}</b>"). */
  communityName?: string | null;
  /** The active community id — MainScreen re-fires the first-entry redirect when it changes. */
  communityCid?: string | null;
  /** Organizer-tuned Rising ranking parameters. */
  ranking?: RankingConfig;
  /** Whether the organizer allows NIP-A0 voice messages. */
  allowVoice?: boolean;
  /** Organizer picture limits (allow / caps / per-period allowance). */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has spent this period. */
  picturesSpentBytes?: number;
  /** Post IDs bookmarked by the current user. */
  bookmarkedPostIds?: readonly string[];
  /** Post ids a moderator has locked (composer closed). */
  lockedPostIds?: readonly string[];
  /** Post ids a moderator has pinned to the top of the feed. */
  pinnedPostIds?: readonly string[];
  /** Toggle bookmark state for a post. */
  onToggleBookmark?: (postId: string) => void;
  /** Report a post to the organizers. */
  onReportPost?: (postId: string, authorPubkey: string) => void;
  /** Mute an author locally (device-only; filters their content, publishes nothing). */
  onMuteAuthor?: (authorPubkey: string) => void;
  /** Spend a read-token to unlock a locked post's content epoch (C7 read meter; ships dark). */
  onUnlockContent?: (epoch: number) => void;
  /** Pull-to-refresh: re-run the NIP-77 feed reconciliation against the relay. */
  onRefreshFeed?: () => Promise<void>;
  /** Count of feed items newer than the reader's last onMarkFeedSeen mark — the "N new posts"
   *  pill (see MainScreenProps.newFeedItemCount / AppRuntime.markFeedSeen for the full contract). */
  newFeedItemCount?: number;
  /** Advance the "seen" baseline the pill counts forward from (see MainScreenProps.onMarkFeedSeen). */
  onMarkFeedSeen?: () => void;
  /** Scroll-back pagination (bug #3): stream in older feed history from the relay. */
  onLoadOlderFeed?: (until: number) => void;
  /** Scroll-back pagination for an open channel. */
  onLoadOlderChannelPage?: (channelId: string, until: number) => void;
  /** Scroll-back pagination for an open group. */
  onLoadOlderGroupPage?: (groupId: string, until: number) => void;

  // ── NIP-29 managed groups ──
  groups?: import('../channels/groups').GroupSummary[];
  relaySupportsNip29?: boolean;
  onCreateGroup?: (meta: ChannelMetadata, closed?: boolean, isPrivate?: boolean, broadcast?: boolean) => Promise<string | null> | void;
  onJoinGroup?: (groupId: string) => void;
  onLeaveGroup?: (groupId: string) => void;
  onKickGroupMember?: (groupId: string, pubkey: string) => void;
  onAddGroupMember?: (groupId: string, pubkey: string, asAdmin: boolean) => void;
  onEditGroup?: (groupId: string, meta: import('../channels/groups').GroupMeta) => void;
  onGetSpaceSettings?: (
    spaceId: string,
    kind: 'channel' | 'group',
  ) => {settings: import('../channels/spaceRules').SpaceSettings; at: number} | null;
  onSetSpaceSettings?: (spaceId: string, settings: import('../channels/spaceRules').SpaceSettings) => void;
  onGetLogOffer?: (groupId: string) => import('../channels/logOffer').LogOffer | null;
  onSetLogOffer?: (groupId: string) => void;
  onRevokeLogOffer?: (groupId: string) => void;
  onApproveJoin?: (groupId: string, pubkey: string) => void;
  onDenyJoin?: (groupId: string, pubkey: string) => void;
  // ── Membership handoff (locked preview / review queue / accept-first invites) ──
  onRequestToJoin?: (groupId: string, note?: string) => void;
  onWithdrawJoinRequest?: (groupId: string) => void;
  onGetJoinState?: (groupId: string) => 'member' | 'pending' | 'none';
  onPreviewSpace?: (groupId: string) => void;
  onGetSpacePreview?: (groupId: string) => {
    name: string;
    about?: string;
    kindWord: 'Private channel' | 'Group chat';
    memberCount: number;
    adminCount: number;
    gradient?: import('../media/gradient').GradientSpec;
  } | null;
  onGetJoinRequestQueue?: (groupId: string) => {
    pubkey: string;
    at?: number;
    name?: string;
    note?: string;
    invited: boolean;
  }[];
  onInvitePeople?: (groupId: string, pubkeys: string[]) => void;
  onRevokeInvite?: (groupId: string, pubkey: string) => void;
  onGetInvited?: (groupId: string) => {p: string; by: string; at: number}[];
  /** Outcome of the most recent approve/deny publish for a pending pubkey — see
   *  AppRuntime.getRosterActionStatus's doc. Lets the Manage page un-freeze a "✓ Approved" card
   *  whose publish actually bounced instead of silently claiming success. */
  onGetRosterActionStatus?: (
    groupId: string,
    pubkey: string,
  ) => {status?: import('../nostr/outbox').SendStatus; reason?: string} | undefined;
  spaceInvites?: import('./AppRuntime').IncomingSpaceInvite[];
  /** Spaces the viewer asked to join but isn't a MEMBER of yet (the Accept→39002 gap). */
  joiningSpaces?: import('./AppRuntime').JoiningSpace[];
  onAcceptSpaceInvite?: (groupId: string) => void;
  onDismissSpaceInvite?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onTransferGroupOwner?: (groupId: string, pubkey: string) => void;
  /** Admin: open/close comments & reactions on a broadcast-group post. */
  onSetGroupInteractions?: (groupId: string, messageId: string, perm: import('../channels/interactions').PostInteractions) => void;
  /** React to a private/broadcast-channel post with a specific emoji. */
  onReactToGroupMessage?: (groupId: string, messageId: string, messagePubkey: string, emoji?: string) => void;
  /** Read the interaction state of a broadcast-group post. */
  getGroupPostInteractions?: (groupId: string, messageId: string) => import('../channels/interactions').PostInteractions;
  /** Resolves false (never rejects) on a failed send — the composer awaits it to restore a failed draft. */
  onPostToGroup?: (groupId: string, content: string, replyTo?: string) => Promise<boolean> | void;
  /** Author edit of one of your private/broadcast-channel posts. */
  onEditGroupMessage?: (groupId: string, messageId: string, content: string) => Promise<boolean> | void;
  onReplyToGroup?: (groupId: string, parentId: string, content: string) => void;
  /** Whether GROUP's outgoing sends are blocked for lack of a space key (drives the composer's
   *  "Unlocking this space…" banner). */
  onIsSpaceKeyMissing?: (groupId: string) => boolean;
  onGetGroupState?: (groupId: string) => import('../channels/groups').GroupState | null;
  onGetGroupMembers?: (groupId: string) => string[];
  onGetGroupAdmins?: (groupId: string) => string[];
  onGetGroupPending?: (groupId: string) => string[];
  onGetGroupMessages?: (groupId: string) => Event[];
  onGetGroupReplies?: (groupId: string) => Map<string, Event[]>;
  onOpenGroup?: (groupId: string) => void;
  onCloseGroup?: (groupId: string) => void;
  onOpenChannel?: (channelId: string) => void;
  onCloseChannel?: (channelId: string) => void;

  // ── Notifications (bell + live-derived center + tap-to-navigate) ──
  /** Pending post-tap navigation target from a notification (foreground/background tap or
   *  cold-start getInitialNotification, replayed after runtime hydration). Consumed once by
   *  MainScreen, then cleared via onPendingNavHandled — mirrors incomingJoinCode/onJoinCodeConsumed. */
  pendingNav?: import('../notifications/notifications').NavTarget | null;
  onPendingNavHandled?: () => void;
  /** A `stiq://channel/<id>` invite link queued by App.tsx (deep link or cold-start), consumed once
   *  by MainScreen then cleared via onPendingInviteLinkHandled -- mirrors pendingNav. */
  pendingInviteLink?: string | null;
  onPendingInviteLinkHandled?: () => void;
  /** Count of unread derived notifications — the number on the bell's badge (0 = no badge). */
  notifUnreadCount?: number;
  /** Snapshot of the live-derived notification list, taken when the notification center opens. */
  onGetNotifications?: () => import('../notifications/notifications').NotifItem[];
  /** Current notification preferences (dm/channel/post-type/reply/hide-names toggles). */
  onGetNotificationPrefs?: () => import('../notifications/prefs').NotificationPrefs;
  /** Persist new notification preferences. */
  onSetNotificationPrefs?: (next: import('../notifications/prefs').NotificationPrefs) => void;
  /** Mark one notification read (center row tap) — clears its dot + drops the badge count. */
  onMarkNotificationRead?: (id: string) => void;
  /** Mark every notification read (center ✓✓) — clears all dots + the badge. */
  onMarkAllNotificationsRead?: () => void;
}

export function AppShell(props: AppShellProps): React.JSX.Element {
  const screen = resolveScreen({enrolled: props.enrolled, lock: props.lock, pinEnabled: props.pinEnabled});

  // The active screen. Rendered inside a fragment so the connecting overlay can float above it
  // (and above onboarding/lock) — it auto-dismisses on connect, so a normal session is unaffected.
  const renderScreen = (): React.JSX.Element | null => {
    switch (screen) {
      case 'onboarding':
        return (
          <OnboardingScreen
            connection={props.connection}
            torBootstrap={props.torBootstrap}
            torPhase={props.torPhase}
            onRetryTor={props.onRetryTor}
            onEnroll={props.onEnroll}
            onAutoExchange={props.onAutoExchange}
            onPrefetchCommunity={props.onPrefetchCommunity}
            incomingJoinCode={props.incomingJoinCode}
            onJoinCodeConsumed={props.onJoinCodeConsumed}
            onGetConnectionPrefs={props.onGetConnectionPrefs}
            onApplyConnectionPrefs={props.onApplyConnectionPrefs}
          />
        );
      case 'lock':
        return <LockScreen onSubmitPin={props.onSubmitPin} />;
      case 'feed':
        return (
        <MainScreen
          feed={props.feed}
          storeVersions={props.storeVersions}
          inbox={props.inbox}
          channels={props.channels}
          currentUserPubkey={props.currentUserPubkey}
          isModerator={props.isModerator}
          modScopes={props.modScopes}
          onGetPendingReports={props.onGetPendingReports}
          onGetBannedMembers={props.onGetBannedMembers}
          onGetLoggedAuthors={props.onGetLoggedAuthors}
          onModeratorUnban={props.onModeratorUnban}
          onModeratorLogAuthor={props.onModeratorLogAuthor}
          onModeratorRestoreAuthor={props.onModeratorRestoreAuthor}
          onModeratorLogPost={props.onModeratorLogPost}
          onCheckModLimit={props.onCheckModLimit}
          sendStatus={props.sendStatus}
          sendReasons={props.sendReasons}
          sendQueuedOffline={props.sendQueuedOffline}
          syncing={props.syncing}
          connection={props.connection}
          torBootstrap={props.torBootstrap}
          torPhase={props.torPhase}
          onUserActivity={props.onUserActivity}
          onSetScrolling={props.onSetScrolling}
          onRetry={props.onRetry}
          onCancelSend={props.onCancelSend}
          onSubmit={props.onSubmit}
          onPromoteChannelPost={props.onPromoteChannelPost}
          onSendDm={props.onSendDm}
          onReactDm={props.onReactDm}
          onRetryDm={props.onRetryDm}
          onVote={props.onVote}
          onCreateChannel={props.onCreateChannel}
          subscribedChannelIds={props.subscribedChannelIds}
          onSubscribeChannel={props.onSubscribeChannel}
          onUnsubscribeChannel={props.onUnsubscribeChannel}
          onPostToChannel={props.onPostToChannel}
          onEditChannelMessage={props.onEditChannelMessage}
          onEditChannel={props.onEditChannel}
          onDeleteChannel={props.onDeleteChannel}
          onSetChannelPinned={props.onSetChannelPinned}
          onSetChannelInteractions={props.onSetChannelInteractions}
          onReactToChannelMessage={props.onReactToChannelMessage}
          onGetReactionsByTarget={props.onGetReactionsByTarget}
          getChannelMessageInteractions={props.getChannelMessageInteractions}
          onGetThread={props.onGetThread}
          listKeyFor={props.listKeyFor}
          onIsSpaceSynced={props.onIsSpaceSynced}
          onGetChannelMessages={props.onGetChannelMessages}
          onComment={props.onComment}
          onSetPinnedComment={props.onSetPinnedComment}
          onGetProfile={props.onGetProfile}
          events={props.events}
          onGetPinnedHistory={props.onGetPinnedHistory}
          onGetLogPage={props.onGetLogPage}
          onGetModLog={props.onGetModLog}
          onGetLogPost={props.onGetLogPost}
          onGetPostItem={props.onGetPostItem}
          onResolveIdentity={props.onResolveIdentity}
          onModeratePost={props.onModeratePost}
          onBlockUser={props.onBlockUser}
          onUnblockUser={props.onUnblockUser}
          isUserBlocked={props.isUserBlocked}
          onChannelOwnerHide={props.onChannelOwnerHide}
          onModerationRestore={props.onModerationRestore}
          onModeratorLock={props.onModeratorLock}
          onModeratorRetag={props.onModeratorRetag}
          onModeratorPin={props.onModeratorPin}
          draftStore={props.draftStore}
          onGetDraftAccessState={props.onGetDraftAccessState}
          onGetMyDraftDelivery={props.onGetMyDraftDelivery}
          onRequestDraftAccess={props.onRequestDraftAccess}
          onGetDraftThread={props.onGetDraftThread}
          onGetDraftCommentCount={props.onGetDraftCommentCount}
          onGetDraftAccessQueue={props.onGetDraftAccessQueue}
          onGetDraftAccessGranted={props.onGetDraftAccessGranted}
          onApproveDraftAccess={props.onApproveDraftAccess}
          onDenyDraftAccess={props.onDenyDraftAccess}
          onRevokeDraftAccess={props.onRevokeDraftAccess}
          onSetDisplayName={props.onSetDisplayName}
          onSetGradient={props.onSetGradient}
          myCraftedGradient={props.myCraftedGradient}
          pinEnabled={props.pinEnabled}
          onSetPinEnabled={props.onSetPinEnabled}
          onVerifyPin={props.onVerifyPin}
          onWipe={props.onWipe}
          onGetEvent={props.onGetEvent}
          onGetEventScore={props.onGetEventScore}
          onGetChannelThread={props.onGetChannelThread}
          onPostChannelComment={props.onPostChannelComment}
          onLoadCommunities={props.onLoadCommunities}
          onSwitchCommunity={props.onSwitchCommunity}
          onRemoveCommunity={props.onRemoveCommunity}
          onJoinAnotherCommunity={props.onJoinAnotherCommunity}
          onLoadKeySlots={props.onLoadKeySlots}
          onSwitchIdentity={props.onSwitchIdentity}
          onRemoveIdentity={props.onRemoveIdentity}
          onAddIdentity={props.onAddIdentity}
          onGetBlossomEndpoint={props.onGetBlossomEndpoint}
          onSetBlossomEndpoint={props.onSetBlossomEndpoint}
          onGetPreferredBrowser={props.onGetPreferredBrowser}
          onSetPreferredBrowser={props.onSetPreferredBrowser}
          onListBrowsers={props.onListBrowsers}
          onClearMediaCache={props.onClearMediaCache}
          onClearEventCache={props.onClearEventCache}
          onCountCachedEvents={props.onCountCachedEvents}
          onDeleteCachedData={props.onDeleteCachedData}
          onGetConnectionPrefs={props.onGetConnectionPrefs}
          onApplyConnectionPrefs={props.onApplyConnectionPrefs}
          onGetRelaySnapshot={props.onGetRelaySnapshot}
          onAddRelay={props.onAddRelay}
          onRemoveRelay={props.onRemoveRelay}
          onMuteRelay={props.onMuteRelay}
          onUnmuteRelay={props.onUnmuteRelay}
          apkUpdatesEnabled={props.apkUpdatesEnabled}
          onCheckForUpdate={props.onCheckForUpdate}
          onInstallUpdate={props.onInstallUpdate}
          tokenStatus={props.tokenStatus}
          onRefreshTokenStatus={props.onRefreshTokenStatus}
          tagPolicy={props.tagPolicy}
          labels={props.labels}
          postRules={props.postRules}
          postingGuidelines={props.postingGuidelines}
          communityName={props.communityName}
          communityCid={props.communityCid}
          ranking={props.ranking}
          allowVoice={props.allowVoice}
          pictureRules={props.pictureRules}
          picturesSpentBytes={props.picturesSpentBytes}
          bookmarkedPostIds={props.bookmarkedPostIds}
          lockedPostIds={props.lockedPostIds}
          pinnedPostIds={props.pinnedPostIds}
          onToggleBookmark={props.onToggleBookmark}
          onReportPost={props.onReportPost}
          onMuteAuthor={props.onMuteAuthor}
          onUnlockContent={props.onUnlockContent}
          onRefreshFeed={props.onRefreshFeed}
          newFeedItemCount={props.newFeedItemCount}
          onMarkFeedSeen={props.onMarkFeedSeen}
          onLoadOlderFeed={props.onLoadOlderFeed}
          onLoadOlderChannelPage={props.onLoadOlderChannelPage}
          onLoadOlderGroupPage={props.onLoadOlderGroupPage}
          groups={props.groups}
          relaySupportsNip29={props.relaySupportsNip29}
          onCreateGroup={props.onCreateGroup}
          onJoinGroup={props.onJoinGroup}
          onLeaveGroup={props.onLeaveGroup}
          onKickGroupMember={props.onKickGroupMember}
          onAddGroupMember={props.onAddGroupMember}
          onEditGroup={props.onEditGroup}
          onGetSpaceSettings={props.onGetSpaceSettings}
          onSetSpaceSettings={props.onSetSpaceSettings}
          onGetLogOffer={props.onGetLogOffer}
          onSetLogOffer={props.onSetLogOffer}
          onRevokeLogOffer={props.onRevokeLogOffer}
          onApproveJoin={props.onApproveJoin}
          onDenyJoin={props.onDenyJoin}
          onRequestToJoin={props.onRequestToJoin}
          onWithdrawJoinRequest={props.onWithdrawJoinRequest}
          onGetJoinState={props.onGetJoinState}
          onPreviewSpace={props.onPreviewSpace}
          onGetSpacePreview={props.onGetSpacePreview}
          onGetJoinRequestQueue={props.onGetJoinRequestQueue}
          onGetRosterActionStatus={props.onGetRosterActionStatus}
          onInvitePeople={props.onInvitePeople}
          onRevokeInvite={props.onRevokeInvite}
          onGetInvited={props.onGetInvited}
          spaceInvites={props.spaceInvites}
          joiningSpaces={props.joiningSpaces}
          onAcceptSpaceInvite={props.onAcceptSpaceInvite}
          onDismissSpaceInvite={props.onDismissSpaceInvite}
          onDeleteGroup={props.onDeleteGroup}
          onTransferGroupOwner={props.onTransferGroupOwner}
          onSetGroupInteractions={props.onSetGroupInteractions}
          onReactToGroupMessage={props.onReactToGroupMessage}
          getGroupPostInteractions={props.getGroupPostInteractions}
          onPostToGroup={props.onPostToGroup}
          onEditGroupMessage={props.onEditGroupMessage}
          onReplyToGroup={props.onReplyToGroup}
          onIsSpaceKeyMissing={props.onIsSpaceKeyMissing}
          onGetGroupState={props.onGetGroupState}
          onGetGroupMembers={props.onGetGroupMembers}
          onGetGroupAdmins={props.onGetGroupAdmins}
          onGetGroupPending={props.onGetGroupPending}
          onGetGroupMessages={props.onGetGroupMessages}
          onGetGroupReplies={props.onGetGroupReplies}
          onOpenGroup={props.onOpenGroup}
          onCloseGroup={props.onCloseGroup}
          onOpenChannel={props.onOpenChannel}
          onCloseChannel={props.onCloseChannel}
          pendingNav={props.pendingNav}
          onPendingNavHandled={props.onPendingNavHandled}
          pendingInviteLink={props.pendingInviteLink}
          onPendingInviteLinkHandled={props.onPendingInviteLinkHandled}
          notifUnreadCount={props.notifUnreadCount}
          onGetNotifications={props.onGetNotifications}
          onGetNotificationPrefs={props.onGetNotificationPrefs}
          onSetNotificationPrefs={props.onSetNotificationPrefs}
          onMarkNotificationRead={props.onMarkNotificationRead}
          onMarkAllNotificationsRead={props.onMarkAllNotificationsRead}
        />
        );
      default:
        return null;
    }
  };

  // The active screen is rendered directly. Connection status is shown NON-BLOCKING by each
  // screen itself (onboarding's StatusRow/ConnectingStep; the feed's tappable offline banner), so
  // the user can browse the cached feed while Tor connects in the background.
  //
  // "Join another community" runs onboarding in ADD mode as a full-screen overlay ABOVE the live
  // feed (the user is already enrolled, so the normal enrolled→feed route can't reach onboarding).
  // On finish (or cancel) it dismisses via onExitAddCommunity; a successful join has already
  // switched the runtime to the new community, so the feed underneath is already the new one.
  // RootBackScope owns the app's ONE hardware-back listener and must sit above renderScreen():
  // onboarding and the lock screen are siblings of MainScreen here (resolveScreen), so a listener
  // living inside MainScreen — where it used to — could never see them. See ui/back.tsx.
  return (
    <RootBackScope>
      {renderScreen()}
      {/* Presented in a full-screen Modal so it covers the feed edge-to-edge; rendered as a bare
          fragment sibling it would share the flex column with MainScreen and get squeezed.
          BackModal (not Modal) so OnboardingScreen's per-step back actions work identically here
          and on first run — this modal is its own window, so its own scope answers the key. */}
      <BackModal
        visible={!!props.addCommunityMode}
        animationType="slide"
        onClose={() => props.onExitAddCommunity?.()}
        presentationStyle="fullScreen">
        <OnboardingScreen
          mode="add"
          onDone={props.onExitAddCommunity}
          connection={props.connection}
          torBootstrap={props.torBootstrap}
          torPhase={props.torPhase}
          onRetryTor={props.onRetryTor}
          onEnroll={props.onEnroll}
          onAutoExchange={props.onAutoExchange}
          onPrefetchCommunity={props.onPrefetchCommunity}
          incomingJoinCode={props.incomingJoinCode}
          onJoinCodeConsumed={props.onJoinCodeConsumed}
          onGetConnectionPrefs={props.onGetConnectionPrefs}
          onApplyConnectionPrefs={props.onApplyConnectionPrefs}
        />
      </BackModal>
    </RootBackScope>
  );
}
