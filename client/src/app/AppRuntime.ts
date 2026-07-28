/**
 * AppRuntime — the live wiring behind App.tsx (PLAN.md §3.3, §3.5, §2).
 *
 * It derives the app's screen state reactively from the real pieces instead of hardcoding
 * it: enrollment from the keystore (Identity), lock state from AutoLock/LockController (with
 * the duress wipe wired in), and the feed from the cache. Everything is injected, so this is
 * unit-tested end-to-end with in-memory implementations; on device the same code runs
 * against the native secure store, Tor socket, and SQLite cache.
 *
 * When no secure storage is available (e.g. before the native build), there is no Identity,
 * so the app correctly resolves to onboarding.
 */
import type {Event} from 'nostr-tools/pure';
import {AutoLock, type LockState} from '../lock/autolock';
import {PinVault, type HashFn} from '../lock/pin';
import {LockController, type UnlockOutcome} from '../lock/controller';
import {performDuressWipe, type DuressTargets} from '../lock/duress';
import {Identity} from '../keys/identity';
import {EpochWallet, walletKeyFingerprint, walletStorageKeys} from '../blind/wallet';
import {
  TokenPool,
  tokenPoolStorageKeys,
  MEDIA_PURPOSES,
  type MediaPurpose,
  type PoolPurpose,
} from '../blind/tokenPool';
import {
  computeDomainStatuses,
  computeWalletRows,
  filterTokenFailures,
  EMPTY_TOKEN_WALLET_COUNTS,
  type TokenEconomyStatus,
  type TokenWalletCounts,
} from './tokenEconomyStatus';
import {buildSpaceTokenTags} from '../blind/spaceProofs';
import type {Token} from '../blind/wallet';
import {BlindSigner, BlindTokensExhausted, SealKeyUnavailable, type MediaTokenRouter} from '../blind/blindSigner';
import {detectImageType} from '../media/image';
import {
  setActiveCommunityKey,
  decodeCommunityKey,
  getActiveCommunityKey,
} from '../blind/communityKey';
import {
  clearStoredContentKeys,
  clearActiveContentKeys,
  setContentKeyStorage,
  loadContentKeys,
  setContentEpochKey,
  storeContentEpochKey,
  hasContentEpochKey,
  CONTENT_EPOCH_D_TAG,
  parseContentEpochDoc,
} from '../blind/contentKey';
import {
  clearAuthorCache,
  resolveAuthorPubkey,
  isUnattributedBlindPost,
  warmAuthorResolutionCold,
} from '../blind/identity';
import {
  runTokenDraw,
  resumeTokenDraw,
  isStaleKeyDrawFailure,
  type DrawOptions,
  type DrawPurpose,
  type DrawMarker,
  type DrawResult,
} from '../blind/drawExchange';
import {fetchOrgConfigDocs} from '../blind/orgConfigFetch';
import {
  setEpochUnlockUnavailable,
  isEpochUnlockUnavailable,
  clearEpochUnlockDisplay,
  registerEpochUnlockRequester,
  registerEpochUnlockRetryRequester,
  requestEpochUnlock,
} from '../blind/unlockState';
import {saveDrawMarker, loadDrawMarker, clearDrawMarker} from '../blind/drawStaging';
import {base64ToBytes, bytesToBase64} from '../util/base64';
import {runReadUnlock} from '../blind/readUnlock';
import {setBytesPerToken, tokenCost} from '../blind/tokenCost';
import {currentEpoch, TAG_TOKEN, TAG_SIG} from '../blind/protocol';
import {detectDoubleSpends} from '../blind/doubleSpend';
import {buildSpendWitness, parseSpendWitness, verifySpendWitness} from '../blind/spendWitness';
import {
  FEED_STORE_READ_KINDS,
  FEED_KINDS,
  KIND_SPEND_WITNESS,
  KIND_VOICE_MESSAGE,
  KIND_MEDIA_BLOB,
  KIND_READ_AUTH,
  KIND_EVENT,
  KIND_EVENT_RSVP,
  Purpose,
  StiqDom,
  isSpaceContentKind,
} from '../contracts';
import {createBlindRsa} from '../onboarding/blindrsaFast';
import type {RelaySocket} from '../nostr/socket';
import {
  CAPS_SCHEMA_PURPOSE_FINGERPRINTS,
  CAPS_REJECT_CODES_MACHINE_MIN,
  defaultRelayCapabilities,
  parseRelayCapabilities,
  explicitEnforcedFlags,
  type RelayCapabilities,
  type EnforcedFlags,
} from '../nostr/capabilities';
import {loadStickyEnforcement, saveStickyEnforcement} from './stickyEnforcement';
import {
  TIMING_JITTER,
  TRUST_RELAY_REJECT_CODES,
  COMPACTION_V2,
  COMMUNITY_SEEDED_BRIDGES,
  SCOPED_CHANNEL_SYNC,
} from '../config';
import {sendJitterMs} from '../timing/sendJitter';
import {parseRejection, isRetryable} from '../nostr/rejection';
import {isTokenFamilyRejection, DRAW_TIMEOUT_TOKEN_REASON} from '../feed/rejectionMessages';
import {clearFeedSnapshot} from '../nostr/feedSnapshot';
import {log, getRecentLogs} from '../util/log';
import {KeyStore, type SecureStorage, type UnsignedEvent} from '../keys/keystore';
import {multiGet} from '../keys/nativeKeystore';
import {KeyRing, newSlotId, type KeySlot} from '../keys/keyRing';
import {wipeEncryptedCache, wipeLegacyCidStore} from '../nostr/sqliteFactory';
import {SwappableEventStore, type EventStore, type CacheDeleteOpts} from '../nostr/store';
import {clearRenderedMedia} from '../media/renderedMediaCache';
import {migrateToSlots, migrateCidToSlot, migrateWipeLegacyCidStores, wipeLegacyGlobals, preflightMigrationFlags} from './migration';
import {
  reloadBlocklistFor,
  blockPeer as blocklistBlockPeer,
  unblockPeer as blocklistUnblockPeer,
  localDecision as blocklistLocalDecision,
  localBlockedAt as blocklistLocalBlockedAt,
} from '../dm/blocklist';
import {
  LEGACY_DM_SENT,
  LEGACY_DM_REACTIONS,
  LEGACY_DM_FAILED_WRAPS,
  LEGACY_IDENTITY_AT_ITEM,
  dmSentKey,
  dmReactionsKey,
  dmFailedWrapsKey,
  dmBlocklistKey,
  mutedAuthorsKey,
  identityAtKey,
  credTokenKey,
  credSigKey,
  identityRelayKey,
  displayNameSelfKey,
  gradientSelfKey,
  draftsKey,
  eventsCacheKey,
  eventStateKey,
  outboxKey,
  displayNameBookKey,
  gradientBookKey,
  groupsJoinedKey,
  spacesEncryptedKey,
  pictureSpendKey,
  pendingComposeKey,
  COMMUNITY_ACTIVE_SLOT_MAP,
  PREV_OUTBOX_CID,
  PREV_GROUPS_JOINED_CID,
  PREV_SPACES_ENCRYPTED_CID,
} from './workspaceKeys';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Narrow interface used to detect whether a store supports per-kind version counters. */
type StoreWithVersion = {versionOf(kinds: readonly number[]): number};
import {buildFeed, clearItemCache, toFeedItem, warmScoredItemsChunked, type Feed, type FeedItem} from '../feed/feed';
import {publishPost, publishArticle, buildPost, buildArticle, type Signer} from '../feed/compose';
import {MediaSettingsStore} from '../media/mediaSettings';
import {TorSettingsStore, type TorConnectionPrefs} from '../tor/torSettings';
// Device-global Tor network memory (last-working bridges, global + per-network-class). Wiped on a
// full duress/identity reset so a seized device reveals no record of which transports/bridges the
// user reached the network with. NOT touched by per-community removeCommunity (device-global, not
// per-community). See bridgeCache.ts clearAllNetworkClassBridges docstring for the wiring contract.
import {clearCachedBridges, clearAllNetworkClassBridges} from '../tor/bridgeCache';
import {
  deriveOnionAuth,
  setActiveOnionAuth,
  deriveOnionAuthSet,
  setActiveOnionAuthExtra,
  getActiveOnionAuthExtra,
  sameOnionAuthSet,
  onionHostOf,
} from '../tor/onionAuth';
import {BrowserSettingsStore} from '../browser/browserSettings';
import type {ImageMeta} from '../nostr/imeta';
import type {PostLabel} from '../feed/labels';
import {buildPinnedComment, loadPinnedHistory, isPinnedComment, type PinnedCommentHistory} from '../feed/pinned';
import {buildChannelComment, buildPostComment, commentParentAuthor, commentParentId, commentRootAuthor, commentRootId, isStiqComment} from '../feed/comments';
import {buildSubscriptionList, subscribedChannelIds, channelSyncIds} from '../channels/subscriptions';
import {buildBookmarkList, bookmarkedPostIds} from '../feed/bookmarks';
import {DraftStore} from '../feed/drafts';
import {
  DisplayNameStore,
  encodeIdentityHeader,
  encodeInviteHeader,
  encodeEventFrameHeader,
  decodeNameHeader,
  decodeGradientHeader,
  decodeInviteHeader,
  decodeEventFrameHeader,
} from '../profile/displayName';
import {parseEventFrame, encodeEventFrame, type EventFrame} from '../events/eventFrames';
import {
  buildEventDocContent,
  buildEventDocTemplate,
  buildRsvpTemplate,
  eventStatusOf,
  foldLatestEventDocs,
  interestedTallies,
  parseEventDoc,
  type EventDocView,
  type InterestedTally,
  type PublicEventInput,
} from '../events/eventsStore';
import {encodeEventEmbed, eventCoordinate} from '../events/eventEmbed';
import type {EventCardLive} from '../events/eventCardState';
import type {EventDraft, EventReveal, ManagedApplication, ManagedGuest, RsvpState} from '../events/types';
import {EventDraftStore, newEventDraftId} from '../events/drafts';
import {relTimeShort as eventRelTimeShort} from '../events/format';
import {GradientStore} from '../profile/gradientIdentity';
import {displayIdentityFor, type DisplayIdentity} from '../profile/resolveDisplayIdentity';
import type {GradientSpec} from '../media/gradient';
import {decodeGradient, encodeGradient, gradientSpecEqual, randomGradient} from '../media/gradient';
import {
  buildIdentityBeacon,
  encodeProfilePayload,
  decodeProfilePayload,
  hasIdentityToPublish,
  D_IDENTITY_BEACON,
  D_IDENTITY_PROFILE,
} from '../profile/identityDoc';
import {buildReaction, buildRetraction, buildGroupReaction, myVote as myVoteFor, reactionTarget, scoreReactions, type VoteDirection} from '../feed/voting';
import {buildEmojiReaction} from '../channels/reactions';
import {type EventRef} from '../feed/comments';
import {
  createChannel as signChannelCreate,
  buildChannelMessage,
  buildChannelMessageEdit,
  buildChannelEdit,
  channelCoord,
  channelMessages,
  channelMessageEpoch,
  editTargetId,
  foldChannelEdit,
  messageChannelId,
  parseChannel,
  getChannel,
  type Channel,
  type ChannelMetadata,
} from '../channels/channels';
import {
  buildChannelInteractionControl,
  buildGroupInteractionControl,
  channelPostInteractions,
  groupPostInteractions,
  type PostInteractions,
} from '../channels/interactions';
import {
  GroupKind,
  buildGroupCreate,
  buildOptimisticGroupState,
  buildGroupChat,
  buildGroupChatEdit,
  buildGroupJoinRequest,
  buildInviteGrant,
  buildGroupLeaveRequest,
  buildGroupAddUser,
  buildGroupRemoveUser,
  buildGroupEditMetadata,
  buildGroupReply,
  buildGroupDelete,
  buildGroupTransferOwner,
  groupSummariesForIds,
  groupMembers as groupMembersOf,
  groupAdmins as groupAdminsOf,
  isGroupAdmin as isGroupAdminOf,
  isGroupOwner as isGroupOwnerOf,
  groupPending as groupPendingOf,
  groupState as groupStateOf,
  groupChatMessages as groupChatMessagesOf,
  foldGroupChatEdit,
  groupRepliesByParent,
  isGroupMember as isGroupMemberOf,
  messageEpoch,
  eventGroupId,
  stateGroupId,
  newGroupId,
  type GroupMeta,
  type GroupSummary,
  type GroupState,
} from '../channels/groups';
import {withPromotedTag} from '../channels/promote';
import {
  getSpaceSettings as readSpaceSettingsDoc,
  buildSpaceSettings,
  DEFAULT_SPACE_RULE_SET,
  type SpaceSettings,
} from '../channels/spaceRules';
import {
  buildLogOffer,
  buildLogOfferRevoke,
  currentLogOffer,
  type LogOffer,
} from '../channels/logOffer';
import {spaceAutoHidden, type SpaceAutoModConfig} from '../moderation/spaceAutoModeration';
import {loadJoinedGroups, saveJoinedGroups} from '../channels/groupMembership';
import {
  encodeJoinNotePayload,
  parseJoinNotePayload,
  encodeJoinNoteContent,
  parseJoinNoteContent,
  latestJoinRequests,
  isInviteAccept,
  encodeInvitePayload,
  parseInvitePayload,
  encodeInviteGrant,
  INVITE_GRANT_TTL_SECS,
  spaceInvitesDTag,
  encodeInvitesDoc,
  parseInvitesDoc,
  foldInvites,
  loadMyJoinRequests,
  saveMyJoinRequests,
  loadDismissedInvites,
  saveDismissedInvites,
  loadDeliveredSpaceKeys,
  saveDeliveredSpaceKeys,
  KIND_SPACE_INVITES,
  SPACE_INVITES_D_PREFIX,
  SPACE_KEY_REQUEST_D_PREFIX,
  buildSpaceKeyRequest,
  parseSpaceKeyRequest,
  type InvitePayload,
  type JoinNotePayload,
  type SpaceInvite,
  type MyJoinRequest,
  type SpaceInvitesDoc,
} from '../channels/membership';
import {
  encodeDraftAccessPayload,
  parseDraftAccessPayload,
  buildDraftAccessRequestTags,
  latestDraftAccessRequests,
  KIND_DRAFT_ACCESS,
  draftAccessDTag,
  encodeDraftAccessDoc,
  parseDraftAccessDoc,
  foldDraftAccess,
  draftDeliveryDTag,
  buildDraftDeliveryTags,
  encodeDraftDeliverySnapshot,
  parseDraftDeliverySnapshot,
  loadDeniedDraftAccess,
  saveDeniedDraftAccess,
  DRAFT_DELIVERY_TOMBSTONE,
  DRAFT_DELIVERY_D_PREFIX,
  DRAFT_COMMENT_ROOT_KIND,
  type DraftAccessRequestPayload,
  type DraftAccessDoc,
  type DraftGrant,
  type DraftDeliverySnapshot,
} from '../feed/draftAccess';
import {encodeSpaceEmbed} from '../channels/spaceEmbed';
import {
  loadEncryptedSpaces,
  addEncryptedSpace,
  isEncryptedSpace,
} from '../channels/encryptedSpaces';
import {parseInviteLink} from '../channels/invite';
import {
  decryptForSpace,
  encryptForSpace,
  mintGroupKey,
  parseKeyDelivery,
  setSpaceKeyStorage,
  setSpaceKeyNamespace,
  storeSpaceKey,
  loadSpaceKey,
  currentEpoch as currentSpaceEpoch,
  clearSpaceKeysForSlot,
  type SpaceKey,
} from '../channels/groupCrypto';
import {Kind} from '../nostr/events';
import {buildConversations, attachDmReactions, type Conversation, type DmReactionRecord} from '../dm/conversations';
import type {DirectMessage, ConversationKeyCache} from '../dm/dm';
import * as nip19 from 'nostr-tools/nip19';
import {MODERATOR_NPUBS, isModerator} from '../moderation/moderators';
import {
  currentModerators,
  currentLimits,
  currentPermissions,
  organizerHex,
  scopesFor,
  currentModLimits,
  currentCommunityConfig,
  currentFeaturedSpaces,
  currentGuide,
  currentGovernance,
  currentLogPage,
  currentStoragePolicy,
  currentSeededBridges,
  toRetentionPolicy,
  ORGANIZER_D_STORAGE,
  ORGANIZER_D_BRIDGES,
  type ModScope,
  type CommunityConfig,
  type Governance,
  type Limits,
  type Permissions,
  type ModActionLimits,
  type LogPageDoc,
} from '../moderation/organizerConfig';
import {resolveLogPage, legacyLogPageDoc, type LogHearthData} from '../channels/logPage';
import {quotaFor, limitMessage, type LimitCategory} from '../moderation/limits';
import {SessionManager} from '../onboarding/session';
import type {Session} from '../onboarding/enrollment';
import {
  CommunityStore,
  communityId,
  toEnrolledCommunity,
  effectiveMirrors,
  describeRelays,
  type EnrolledCommunity,
  type RelaysSnapshot,
} from '../communities/communityStore';
import type {RelayEntry} from '../onboarding/community';
import {MAX_MIRRORS} from '../onboarding/join';
import {TOKEN_KEYS_D_TAG, parseTokenKeysEvent} from '../onboarding/tokenKeys';
// MirrorSpec is structurally identical to RelayEntry (both {url, onionAuthKey?}) — imported from
// MirrorSet.ts (not re-declared here) so activeSecondaryMirrors' return type is the exact shape
// MirrorSet's constructor (P2 synthesis §1) consumes, with zero duplication risk if it ever drifts.
import type {MirrorSpec} from '../nostr/MirrorSet';
import {
  KIND_TAG_POLICY as KIND_ORG_CONFIG,
  TAG_POLICY_D_TAG,
  DEFAULT_TAG_POLICY,
  parseTagPolicyEvent,
  type TagPolicy,
} from '../feed/tagPolicy';
import {
  LABELS_D_TAG,
  DEFAULT_LABELS,
  parseLabelsEvent,
  type LabelConfig,
} from '../feed/labels';
import {
  POST_RULES_D_TAG,
  DEFAULT_POST_RULES,
  parsePostRulesEvent,
  type PostRules,
} from '../feed/postRules';
import {
  POSTING_GUIDELINES_D_TAG,
  parsePostingGuidelines,
  type PostingGuidelines,
} from '../feed/postingGuidelines';
import {
  PICTURE_RULES_D_TAG,
  DEFAULT_PICTURE_RULES,
  parsePictureRulesEvent,
  normalizePictureRules,
  type PictureRules,
} from '../feed/pictureRules';
import {PictureAllowanceStore, picturesSpentThisPeriod, setPicturePeriodHours} from '../media/pictureAllowance';
import {
  AUDIO_RULES_D_TAG,
  DEFAULT_AUDIO_RULES,
  parseAudioRulesEvent,
  normalizeAudioRules,
  setActiveAudioRules,
  type AudioRules,
} from '../feed/audioRules';
import {extractInlinePictures} from '../feed/picture';
import {
  buildMediaBlobEvent,
  splitMediaBlobsIfEnabled,
  type UnsignedMediaBlob,
} from '../feed/mediaBlob';
import {
  REASONS_D_TAG,
  DEFAULT_REASONS,
  parseReasonsEvent,
  type ReasonsConfig,
} from '../moderation/reasons';
import {
  RANKING_D_TAG,
  DEFAULT_RANKING,
  parseRankingEvent,
  type RankingConfig,
} from '../feed/sort';
import {buildThread, partitionThread, countComments, type CommentNode} from '../feed/thread';
import {
  buildRemoveReport,
  buildRestore,
  buildLockThread,
  buildUnlockThread,
  buildRetag,
  buildPin,
  buildUnpin,
  buildBan,
  buildUnban,
  stiqActionOf,
} from '../moderation/report';
import {
  buildLogUser,
  buildUnlogUser,
  buildLogEvent,
  buildLogBatch,
  advisoryOverlay,
  advisoryActionOf,
  loggedAuthorsFrom,
  type LoggedAuthor,
} from '../moderation/advisory';
import {bannedAuthors, bannedMembers, type BannedMember} from '../moderation/bans';
import {pendingReports, type PendingReport} from '../moderation/queue';
import {moderatorHides, isModeratorHidden, moderatorMutedAuthors, type ModeratorHides} from '../moderation/filter';
import {buildModLog, type ModLogEntry, type SpaceAutoContext} from '../moderation/modlog';
import {moderationOverlay, type ModerationOverlay} from '../moderation/modActions';
import {buildMuteList, blockedPubkeys, ownerReportedIds, channelOwnerOf} from '../moderation/ownerComments';
import {buildProfile, type Profile, type ProfileIdea} from '../profile/profile';
import {storePendingBind, loadPendingBind, clearPendingBind} from '../onboarding/pendingBind';
import {Outbox, type SendStatus} from '../nostr/outbox';
import {PUBLISH_TIMEOUT_MESSAGE, classifyRejection, FETCH_TIMEOUT_MS} from '../nostr/RelayClient';
import {loadPinEnabled, savePinEnabled} from '../lock/pinPrefs';
import {
  notifyDm,
  notifyChannel,
  notifyComment,
  setNotificationAccount,
  isSourceMutedSync,
  dmMuteId,
  chMuteId,
  allCommentsMuteId,
  draftMuteId,
  type NotifItem,
} from '../notifications/notifications';
import {setLogPagePrefsSlot, ensureLogPagePrefsLoaded} from './logPagePrefs';
import {setDockPrefsSlot, ensureDockPrefsLoaded} from './dockPrefs';
import {setFeedSortPrefsSlot, ensureFeedSortPrefsLoaded} from './feedSortPrefs';
import {
  setCommunityEntrySlot,
  ensureCommunityEntryLoaded,
  firstEnteredAt,
  recordEntry,
} from './communityEntry';
import {setSpaceJoinedAtSlot, ensureSpaceJoinedAtLoaded, markJoined} from './spaceJoinedAt';
import {
  ensurePrefsLoaded,
  getPrefs,
  savePrefs,
  isNotifAllowed,
  type NotificationPrefs,
  type NotifDescriptor,
  type PostType,
} from '../notifications/prefs';
import {isNotifRead, markNotifRead, markAllNotifsRead, spaceBadge, chSeenId, grpSeenId} from '../notifications/readState';
import {bodyForMeasure, inlineMediaSummary} from '../feed/inlineMedia';
import {resolveContent, contentEpochOf, isSealedContent} from '../blind/blindPost';

const EMPTY_FEED: Feed = {items: [], log: []};
// Stable empty constants for the idle snapshot returned while the app is locked behind the PIN screen
// or while init has deferred the heavy build off the splash (see buildIdleSnapshot). Shared frozen
// references so a locked-idle re-emit keeps stable array identities (no MainScreen memo churn). Never
// mutated.
const EMPTY_IDS: string[] = [];
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_GROUPS: GroupSummary[] = [];
const EMPTY_SPACE_INVITES: IncomingSpaceInvite[] = [];
const EMPTY_JOINING_SPACES: JoiningSpace[] = [];
const EMPTY_SCOPES: readonly ModScope[] = [];

/** How long the completed (5/5) ring lingers before the entry is dropped. */
const CONFIRM_LINGER_MS = 1500;

/**
 * kind-30078 `d`-tag for the organizer-published mirror list (P2 MirrorSet, synthesis §1.2/§1.7).
 * Handled like the other org-config d-tags (tag policy/labels/post-rules/...) in applyOrgConfig,
 * but its patch (`mirrorsOrg`/`mirrorsOrgAt`) additionally needs a DURABLE anti-rollback gate — see
 * handleIncomingEvent — because effectiveMirrors treats it as an ADDITIVE, cap-truncated tail that
 * must never be replaced by an older doc replayed from a stale/withholding mirror (attack H).
 */
const MIRRORS_D_TAG = 'stiq:mirrors';

/**
 * Parse a `stiq:mirrors` kind-30078 body into a validated RelayEntry[], or null when the content
 * isn't a JSON array at all (malformed doc → applyOrgConfig leaves mirrorsOrg untouched). Accepts
 * either `{url, onionAuthKey}` objects or terse `[url, onionAuthKey|null]` pairs. Every entry's url
 * MUST resolve to a v3 onion host via onionHostOf or that single entry is dropped (a malformed
 * mirror is skipped, not coerced into a relay attempt); the list is capped at MAX_MIRRORS so a
 * publish far beyond the cap can't be used to pad/slow the parse. An empty (but well-formed) array
 * is a VALID result — that's the organizer legitimately withdrawing its OWN added mirrors, which
 * `effectiveMirrors` already treats as safe (user/known-good/seed mirrors are untouched either way).
 */
function parseMirrorsEvent(content: string): RelayEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: RelayEntry[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_MIRRORS) break;
    let url: unknown;
    let onionAuthKey: unknown;
    if (Array.isArray(item)) {
      [url, onionAuthKey] = item;
    } else if (item && typeof item === 'object') {
      url = (item as {url?: unknown}).url;
      onionAuthKey = (item as {onionAuthKey?: unknown}).onionAuthKey;
    } else {
      continue;
    }
    if (typeof url !== 'string' || !onionHostOf(url)) continue;
    out.push({url, onionAuthKey: typeof onionAuthKey === 'string' ? onionAuthKey : null});
  }
  return out;
}

/**
 * Age at which a permanently-undecryptable gift wrap becomes safe to prune from the store (finding
 * #3). NIP-59 back-dates a wrap's created_at up to 2 days to hide send time, so a genuine wrap can
 * legitimately arrive with a timestamp up to 2 days old; we add a 1-day safety margin (3 days total)
 * so a real, recently-received wrap is never pruned mid-decode. Since keys never rotate, a wrap that
 * failed to decrypt is alien forever — only its age gates removal.
 */
const DM_WRAP_PRUNE_AGE_SECONDS = 3 * 24 * 60 * 60;

/**
 * Optimistic roster overlay (session-only). An admin action (promote/demote/kick/approve/deny)
 * publishes a NIP-29 management event, but the roster UI derives from relay-generated 39001/39002/
 * 39004 state — a full Tor round-trip away. The overlay lets the three UI-facing getters reflect the
 * intended change INSTANTLY, then be reconciled against (and superseded by) the relay's fresh state,
 * or reverted the moment the relay rejects the publish. Never touches the crypto readers, which must
 * only ever act on relay-confirmed truth.
 */
type RosterOp = 'promote' | 'demote' | 'kick' | 'approve' | 'deny';
interface RosterOverlayEntry {
  op: RosterOp;
  /** The signed management event's id — its outbox status gates apply-vs-revert. */
  eventId: string;
  /** Wall-clock stamp (Date.now) for opportunistic GC of stale intent. */
  at: number;
}

/**
 * Opportunistic GC horizon: an overlay entry the relay never reconciled (a dropped publish, a relay
 * that silently ignored the management event) must not pin the UI forever. On any reconcile, entries
 * older than this are dropped regardless of whether the fresh relay state reflects them.
 */
const ROSTER_OVERLAY_TTL_MS = 15 * 60 * 1000;

export interface AppRuntimeDeps {
  /** Hardware-backed secure storage, or null when unavailable (→ onboarding). */
  secureStorage: SecureStorage | null;
  /** Event cache (Tor-synced on device). */
  store: EventStore;
  hash?: HashFn;
  autoLockMs?: number;
  /** Build-time fallback roster (legacy v1 communities with no organizer key). */
  moderators?: readonly string[];
  /** Organizer npub (community-code v2): moderation/limits trust root for the dynamic roster. */
  organizerNpub?: string;
  /**
   * Relay publish (Tor-routed on device). Absent → compose-only.
   *
   * `offline: true` means the relay socket isn't up yet (Tor still building the onion circuit, or
   * the connection dropped) — the event was NOT sent and NOT rejected. The runtime keeps such an
   * event queued (it auto-resends on reconnect) instead of marking it failed.
   */
  publish?: (event: Event) => Promise<{accepted: boolean; message: string; offline?: boolean}>;
  /** Fetch specific events by id from the relay (e.g. quoted posts not in cache). */
  fetchEvents?: (ids: string[]) => void;
  /**
   * Fetch events by filter from the relay (e.g. an uncached NIP-19 `naddr` addressable article,
   * which has no single id and must be queried by `{kinds, authors, '#d'}`).
   */
  fetchByFilter?: (filters: import('../nostr/protocol').ReqFilter[]) => void;
  /** Open a group-scoped relay subscription (NIP-29 chat + state) while a group view is active. */
  subscribeGroup?: (groupId: string) => void;
  /** Close a group-scoped subscription opened by subscribeGroup. */
  unsubscribeGroup?: (groupId: string) => void;
  /**
   * Open a CHANNEL-scoped relay subscription (NIP-53 kind-1311 chat, `#a` = the coordinate) while a
   * channel view is active — the channel twin of {@link subscribeGroup}. Named `…ChannelChat`, not
   * `subscribeChannel`, because this class already has a `subscribeChannel(channelId)` that means
   * something entirely different: publish a NIP-51 Follow. This one touches the wire, not the list.
   *
   * Absent (the default, and always while config's SCOPED_CHANNEL_SYNC is OFF) → openChannel /
   * closeChannel are no-ops, exactly as today: 1311 rides the firehose and needs no per-view sub.
   */
  subscribeChannelChat?: (channelId: string) => void;
  /** Close a channel-scoped subscription opened by {@link subscribeChannelChat}. */
  unsubscribeChannelChat?: (channelId: string) => void;
  /**
   * Manual pull-to-refresh: re-run the relay's feed reconciliation now. Resolves when the round
   * completes (NIP-77 negentropy or the legacy feed REQ). Absent / disconnected → no-op.
   */
  resyncFeed?: () => Promise<void>;
  /**
   * Build a fresh per-(community, account) event store (both null = the un-enrolled default).
   * Provided when `store` is a {@link SwappableEventStore}; the runtime calls this on init and on a
   * community/identity switch to open that ACCOUNT's own encrypted DB (per-account isolation, finding
   * #4 — two accounts in one community never share a cache), then swaps it in. Absent → the single
   * `store` is used as-is (tests, pre-native builds).
   */
  createStore?: (cid: string | null, slotId: string | null) => Promise<EventStore>;
  /**
   * Tear down the live relay socket + subscriptions and resolve once it's fully closed. Called at
   * the START of a community switch — BEFORE the identity/store swap — so no in-flight relay write
   * lands in the incoming community's store or gets signed with the new npub. The host reconnects
   * to the new relay afterwards via its normal reconnect path.
   */
  onRelayTeardown?: () => Promise<void>;
  /**
   * Draw a fresh batch of blind-posting tokens NOW over a dedicated Tor socket, resolving `true` when
   * at least one token landed. Provided by the host (which owns the Tor manager). The runtime calls
   * it as a transparent last resort when a blind-eligible write (post/vote/comment/voice) finds the
   * wallet empty, so the anti-spam token machinery stays invisible: the user never sees a
   * "draw tokens" prompt and is never blocked — the write just waits for the auto top-up. Absent in
   * tests / non-blind builds (the write then surfaces the exhaustion as before).
   */
  drawTokensNow?: () => Promise<boolean>;
  /**
   * Open a fresh dedicated Tor socket to the ACTIVE relay for a token draw (tokens-everywhere).
   * Provided by the host (which owns the Tor manager + active relay URL), mirroring the `connect`
   * factory the host passes to {@link unlockContentEpoch}/{@link ensureWriteEpoch} — but exposed as a
   * dep so the runtime can stock the AUXILIARY wallets (space-write, media-write) from
   * {@link stockAuxiliaryWallets} and the space pre-sign hook without a connect arg threaded through
   * every publish. Absent in tests / non-Tor builds → the auxiliary sweep and on-demand space draw
   * are simply skipped (the wallets stay at whatever the proactive path last stocked).
   */
  connectForDraw?: () => RelaySocket;
  /**
   * Fetch the active relay's NIP-11 information document (parsed JSON) over Tor. Provided by the
   * host, which owns the Tor manager + the active relay URL and converts it to the http(s) NIP-11
   * endpoint (`Accept: application/nostr+json`). The runtime calls it ONCE per relay (re)connect to
   * negotiate {@link RelayCapabilities}; any rejection keeps the constant-derived fallback so a
   * capability fetch never breaks connect. Absent in tests / non-Tor builds (→ fallback stands).
   */
  fetchRelayInfo?: () => Promise<unknown>;
  /**
   * Push a freshly-adopted secondary-mirror set to the LIVE MirrorSet (synthesis §1.9). Called after a
   * durable `stiq:mirrors` apply so a newly-trusted honest mirror is used WITHOUT waiting for the next
   * reconnect — the host wires it to {@link MirrorSet.updateSecondaryMirrors}. Absent → the new set is
   * only picked up on the next reconnect (tests / non-transport builds).
   */
  onMirrorsChanged?: (specs: MirrorSpec[]) => void;
  /**
   * Ask the host to reconnect the active relay (a full Tor restart when needed). Called only when a
   * durable `stiq:mirrors` apply GREW the required onion-auth set with a new auth-gated mirror: Tor
   * reads ClientOnionAuthDir at startup, so the daemon must reboot to write the new `<host>.auth_private`
   * before that mirror is reachable (a live socket bounce can't load it). Absent → the new mirror
   * becomes reachable only on the next natural reconnect.
   */
  requestRelayReconnect?: () => void;
}

/**
 * One incoming space invitation (membership handoff): lifted off an invite DM's SOH-i frame and
 * rendered as the accept-first consent card at the top of the Channels inbox. Nothing is shared
 * with the space until the user accepts.
 */
export interface IncomingSpaceInvite {
  groupId: string;
  /** Space name snapshot carried by the invite (render offline; live 39000 may correct it later). */
  name?: string;
  kindWord: 'Private channel' | 'Group chat';
  memberCount?: number;
  /** The inviter's pubkey (the DM sender). */
  inviter: string;
  /** Invite DM timestamp (newest invite per space wins). */
  at: number;
}

/**
 * A space the viewer has ASKED to join (accepted invite or manual `requestToJoin`) but isn't a
 * MEMBER of yet — covers the Accept→39002 gap where the space sits in NEITHER `spaceInvites`
 * (accepted invites are filtered out of that list) nor the members-only inbox.
 */
export interface JoiningSpace {
  groupId: string;
  /** Space name, preferring the invite payload's carried name, else cached relay state. */
  name?: string;
  kindWord: 'Private channel' | 'Group chat';
}

export interface AppSnapshot {
  enrolled: boolean;
  lock: LockState;
  /** Whether the PIN lock screen is enabled. When false, the app skips the lock screen entirely. */
  pinEnabled: boolean;
  feed: Feed;
  inbox: Conversation[];
  channels: Channel[];
  /** Channel ids the user is subscribed to (NIP-51), plus channels they own. */
  subscribedChannelIds: string[];
  /** NIP-29 managed groups the user is a member of (from cached relay state). */
  groups: GroupSummary[];
  /**
   * Incoming space invitations (accept-first consent cards atop the Channels inbox). Sourced from
   * DM-delivered invite frames; dismissed / already-member / already-accepted entries filtered.
   */
  spaceInvites: IncomingSpaceInvite[];
  /**
   * Spaces the viewer has asked to join (accepted invite or manual request) but isn't a MEMBER of
   * yet — a non-actionable "Joining…" row for the Accept→39002 gap. See {@link JoiningSpace}.
   */
  joiningSpaces: JoiningSpace[];
  /** Hex pubkey of the enrolled user, or null before enrollment. */
  currentUserPubkey: string | null;
  /** Whether the current user is a configured moderator. */
  isModerator: boolean;
  /** The current user's granted moderator scopes (empty when not a moderator). */
  modScopes: readonly ModScope[];
  /** Per-event delivery status for optimistic writes (sending/failed/rejected indicators). */
  sendStatus: ReadonlyMap<string, SendStatus>;
  /** Per-event relay rejection reason (only ids the relay rejected) — shown next to "failed". */
  sendReasons: ReadonlyMap<string, string>;
  /**
   * Ids whose 'sending' sendStatus is a pre-connect QUEUE (relay/Tor not up yet) rather than an
   * active in-flight publish — see Outbox.queuedOfflineIds(). Render-only distinction so the feed can
   * show "Queued — connecting…" instead of "Sending…" (M7).
   */
  sendQueuedOffline: ReadonlySet<string>;
  /**
   * Monotonic count of the user's own FEED POSTS the relay has CONFIRMED taking, this runtime
   * instance. Increments in exactly one place — AppRuntime.confirmDelivery, on a genuine landing —
   * and never for a 'failed'/'rejected'/still-in-flight write, never on a timer, never for any other
   * kind of write (see AppRuntime.announceOnConfirm for why posts and nothing else).
   *
   * It exists so the UI can say "Posted" honestly. The composer cannot: it closes on the publish tap
   * and deliberately does not wait for the write (waiting was the "publish tap hangs for seconds"
   * bug), so the outcome arrives seconds later with the composer long gone. A CHANGE in this number
   * is the only thing that fires App.tsx's Toast — which is why it must be a count of landings and
   * nothing else.
   */
  postsDelivered: number;
  /** Active community's tag policy (organizer-defined). */
  tagPolicy: TagPolicy;
  /** Organizer-defined post labels (drives composer + feed chips). */
  labels: LabelConfig;
  /** Organizer-defined per-post-type length/label rules (composer guardrail + auto-moderation). */
  postRules: PostRules;
  /** Organizer posting guidelines (composer rules banner + covenant sheet); null when unset. */
  postingGuidelines: PostingGuidelines | null;
  /** The active community's display name (EnrolledCommunity.name), for the composer byline; null when unset/unenrolled. */
  communityName: string | null;
  /** The active community id (relay-derived). Lets MainScreen re-fire the first-entry redirect on a
   *  switch to a just-joined community (the tab state persists across switches). Null when unenrolled. */
  communityCid: string | null;
  /** Organizer-defined moderation reason buckets (removal picker + mod-log flair). */
  reasons: ReasonsConfig;
  /** Organizer-tuned "Rising" ranking parameters (half-life + score weight). */
  ranking: RankingConfig;
  /** Whether the organizer permits NIP-A0 voice messages (gates the voice UI). */
  allowVoice: boolean;
  /** Organizer picture limits (allow / size caps / per-period allowance). */
  pictureRules: PictureRules;
  /** Organizer voice/audio limits (allow / size + duration caps / recording bitrate / allowance). */
  audioRules: AudioRules;
  /** Picture token bytes the member has spent this period (drives the composer allowance gate). */
  picturesSpentBytes: number;
  /** NIP-51 kind-10003 bookmarked post ids for the current user. */
  bookmarkedPostIds: readonly string[];
  /** Author pubkeys the viewer has LOCALLY muted (device-only; never published to the relay). Their
   *  posts + comments are already filtered out of `feed`/threads — exposed for an unmute UI. Optional
   *  so existing hand-written snapshot literals stay valid; the runtime always populates it. */
  mutedAuthorPubkeys?: readonly string[];
  /** Post ids a moderator has locked (comment composer is closed on these). */
  lockedPostIds: readonly string[];
  /** Post ids a moderator has pinned to the top of the feed. */
  pinnedPostIds: readonly string[];
  /**
   * Scoped invalidation signals for view-level memos that must NOT key on `feed`'s identity — the
   * feed cache deliberately excludes LiveChat/LiveActivity/GroupChat (see FEED_STORE_READ_KINDS'
   * doc comment), so a channel/group-only write never changes `feed` and a memo keyed on it would
   * go stale. Each counter is O(1) per getSnapshot (a store.versionOf sum or a plain field read).
   */
  storeVersions: {
    /** Bumps on anything getChannelMessages self-invalidates on (broadcasts/settings/reports). */
    channels: number;
    /** Bumps on anything a group view reads: chat/thread/reply/reaction content plus moderation. */
    groups: number;
    /** Bumps on any learned identity change — own (name/gradient edits, cross-device adoption) or
     *  a peer's (post/DM/beacon-learned name or gradient). */
    identity: number;
    /** Bumps on anything the open post/thread view reads (comments/posts + moderation reports/mutes)
     *  or a local device-only author mute — the scoped signal MainScreen's threadNodes memo keys on
     *  instead of `feed`, so an open thread rebuilds only on a real thread change (A2). Optional so a
     *  static fallback snapshot (App.tsx's pre-init default) needn't supply it; the runtime always does. */
    thread?: number;
    /** Bumps on any organizer config write (kind-30078) — the scoped signal the Log tab's
     *  announcement/guide/featured memos key on instead of `feed`, which never moves for a
     *  config-only write. Optional for the same static-fallback reason as `thread`. */
    config?: number;
    /**
     * Bumps on anything a draft's access state is derived from: a `DraftAccessRequest`, a
     * `DraftDelivery`, or the owner's `draft-access:<id>` AppData doc — plus the two counters that
     * move with NO relay-visible event (a silent deny, and a delivery decrypt that resolves after
     * `ver` was already read).
     *
     * Load-bearing for `EmbedReader`: the reader's access check must re-run when an approval lands
     * while the reader is ALREADY OPEN, or a requester sits on "Requested · waiting for the owner"
     * until they back out and re-enter. Before this existed the re-check happened only incidentally
     * — App.tsx passes the draft callbacks as inline arrows, so their identity changed every render
     * and the effect re-fired as a side effect of that. Wrapping those callbacks in `useCallback`
     * (an ordinary perf change) would have silently killed the live unlock. This makes the signal
     * explicit. Optional for the same static-fallback reason as `thread`.
     */
    draftAccess?: number;
  };
  /** Count of unread derived notifications — the number on the bell's badge (0 = no badge). */
  notifUnreadCount: number;
  /**
   * Count of visible feed items with a wire `createdAt` newer than the last {@link
   * AppRuntime.markFeedSeen} mark — powers a Twitter-style "N new posts" pill so live arrivals can be
   * announced without yanking the list out from under a reading user (an in-place prepend reflows
   * whatever they're looking at; an explicit "N new, tap to view" doesn't). 0 before the first
   * markFeedSeen call (no baseline yet) and 0 again right after a community/account switch (the mark
   * is one community's timeline — see clearSwitchCaches). Optional so a static pre-init snapshot
   * (App.tsx's INITIAL) doesn't need to carry it; the runtime always populates it once real, exactly
   * like {@link mutedAuthorPubkeys}.
   */
  newFeedItemCount?: number;
  /**
   * True while a relay sync round is in progress (see setRelaySyncing/relaySyncing). Cheap primitive
   * read, not store-derived: never gates or forces a feed rebuild. Drives a quiet "Syncing…"
   * indicator (M7) so a backlog that's still filling in reads as intentional rather than broken — the
   * emit cadence itself is no longer widened during sync (see AppRuntime.emitDeferred's doc: a fresh
   * backlog is exactly when the user most wants to see content land, so it now gets the SAME tight
   * cadence as everything else). Always false on the idle/locked snapshot — no sync UI is on screen
   * behind the lock gate.
   */
  syncing: boolean;
  /**
   * Token/economy status (T5.1/F18) — per-purpose wallet counts, the C5 per-domain provisioning
   * (drift) verdict, and the most recent token-relevant diagnostic log entries. Read-only and
   * consumed ONLY by the `__DEV__`-gated Settings → Diagnostics → Token status screen; every other
   * screen may ignore this field. Contains no secrets: counts, PUBLIC issuer-key fingerprints
   * (already advertised by the relay / carried in the invite), domain names, and calm failure
   * messages only — see tokenEconomyStatus.ts's module doc. Wallet counts reflect the last
   * refreshTokenWalletCounts() call (an async SecureStorage read, cached — see _tokenWalletCounts);
   * the drift verdict and recent-failures slice are recomputed fresh on every snapshot from
   * already-in-memory state, so they never lag behind a wallet-count refresh.
   */
  tokenStatus: TokenEconomyStatus;
}

/**
 * A durable, recoverable POST compose intent (see AppRuntime.pendingPosts / post()). `id` is the
 * optimistic placeholder's temp `local-…` id, reused so recovery re-signs the SAME rendered
 * placeholder rather than duplicating it. `cid`/`slotId` capture the ACTIVE (community, account) at
 * compose time for the silo guard. Persisted per-account (JSON-serializable — no functions/Events).
 */
/** Fields shared by every durably-recoverable optimistic write (see pendingPosts / signPendingWrite). */
interface PendingWriteBase {
  /** The optimistic placeholder's temp `local-…` id (also its store event id + persisted key). */
  id: string;
  content: string;
  /** The active community id at compose time (undefined = un-enrolled/legacy, matched as-is). */
  cid: string | undefined;
  /** The active account/identity slot at compose time (undefined = pre-silo legacy identity). */
  slotId: string | undefined;
  /**
   * Ids of the media-blob events (kind 30351, feed/mediaBlob.ts) this write's body references, in
   * body order — set by {@link AppRuntime.mintMediaBlobs} once `content` has been rewritten from
   * inline base64 to blob references. Empty/absent for every write composed with LAZY_MEDIA_BLOBS off
   * or carrying no media, which is what makes the whole blob path a no-op when the flag is off.
   *
   * IDS, not the blob Events themselves, keeping this queue JSON-clean (no Events) exactly as it was.
   * The bytes live in the local event store, which is the right home and a safe one: a blob's kind
   * falls in the addressable 30000-39999 range, so `isCacheExempt` already forbids BOTH the retention
   * prune and the user-driven cache clear from touching it (nostr/cacheExempt.ts). So the pair
   * (persisted intent, exempt store rows) rehydrates a token-exhausted picture post intact across a
   * restart, and the two can't drift: a switch swaps the store and clears this queue together.
   */
  blobIds?: string[];
}

/** A durably-recoverable feed POST (kind-1 note or kind-30023 article). `type` is OPTIONAL so a queue
 *  persisted before this union existed rehydrates as a post — back-compat with the old shape. */
interface PendingPostWrite extends PendingWriteBase {
  type?: 'post';
  tags: string[];
  title?: string;
  label?: PostLabel;
  contentWarning?: string;
  /**
   * Set ONLY when this feed post is step 1 of {@link AppRuntime.promoteChannelPost} (T4.4) — the
   * source channel/group message step 2 must in-place-edit once THIS post actually signs. Carrying
   * the whole step-2 recipe on step 1's own persisted intent (rather than firing it off eagerly from
   * promoteChannelPost, the way signOptimisticWrite used to) is what makes the pair survive a drought
   * that outlives the app process: this feed post rides the SAME durable pipeline as any other post
   * (placeholder, 'failed'+Retry, drainPendingPosts, per-account persistence), and the moment
   * signPendingWrite has the real signed event id in hand — live OR after a restart rehydrates and
   * drains this exact intent — it derives the step-2 'channelEdit'/'groupEdit' intent from this field
   * and queues IT durably too (see signPendingWrite's promoteSource branch). Absent for every plain
   * post/article, which is the overwhelming majority and pays nothing for this field's existence.
   */
  promoteSource?: {
    kind: 'channel' | 'group';
    channelId?: string;
    groupId?: string;
    originalId: string;
    content: string;
  };
}

/** A durably-recoverable feed COMMENT (NIP-22 kind-1111 / hybrid kind-1), addressed by root + parent. */
interface PendingCommentWrite extends PendingWriteBase {
  type: 'comment';
  root: EventRef;
  parent: EventRef;
}

/** A durably-recoverable author PINNED comment on one of the user's own posts. */
interface PendingPinnedWrite extends PendingWriteBase {
  type: 'pinned';
  postRef: EventRef;
}

/**
 * A durably-recoverable CHANNEL broadcast (NIP-53 kind-1311 into `channelId`).
 *
 * Signed by the BOUND NPUB (see postToChannel), not blind: the relay's GroupGuard gates 1311 on the
 * author's role, and `blindContentKinds` excludes it on purpose — signing it blind would make every
 * broadcast unpublishable. It queues on this durable pipeline for TWO independent reasons, either of
 * which can throw {@link BlindTokensExhausted}:
 *  1. The broadcast's OWN signature spends a space-write token once the relay requires one
 *     (`space_tokens_required` — the `identity` pre-sign hook, spaceTokenTagsFor). "A bound-npub
 *     signature can't spend a token" used to be assumed true here, and the assumption was F2: a
 *     text-only broadcast took a separate instant-publish path with no placeholder to catch this.
 *  2. Its pictures/voice mint into blind blob events (mintMediaBlobs) off the POST wallet — a second,
 *     independent draw that can exhaust on its own.
 * From here down neither reason is special-cased: a broadcast gets exactly what a post needs (instant
 * placeholder ahead of the draw, 'failed'+Retry on a drought, re-signing by drainPendingPosts) from the
 * SAME pipeline rather than a second copy of it.
 *
 * EVERY channel broadcast queues here now (T0.2), including a plain-text one on a relay that doesn't
 * enforce space tokens — the mechanical no-op case: mintMediaBlobs no-ops without media,
 * spaceTokenTagsFor no-ops whenever space_tokens_required is off, and publishOptimistic(event, []) is
 * byte-identical to the old direct sign+publish. What's gone is the SEPARATE fast path a mint-nothing
 * broadcast used to take — it had no placeholder, so a bare-signature space-token exhaustion on it had
 * nothing to catch it (F2).
 */
interface PendingChannelWrite extends PendingWriteBase {
  type: 'channel';
  /** The 30311 channel coordinate this broadcast is addressed to (`a` tag, root marker). */
  channelId: string;
}

/** A durably-recoverable CHANNEL broadcast EDIT — the author's own position-preserving re-publish of
 *  `originalId` (see editChannelMessage / buildChannelMessageEdit). Queues here for the same reason
 *  {@link PendingChannelWrite} does: its own bound-npub signature can spend a space-write token once
 *  the relay requires one (T0.2 — previously editChannelMessage had no placeholder/catch at all). */
interface PendingChannelEditWrite extends PendingWriteBase {
  type: 'channelEdit';
  channelId: string;
  originalId: string;
  /**
   * Set when this edit IS promoteChannelPost's in-place "promoted" marker (T4.3) rather than a plain
   * author edit — the feed-post id `withPromotedTag` appends as `['promoted', promotedFeedId]`.
   * Folding the promote edit onto this SAME variant (instead of a bespoke direct `identity.sign()`)
   * gives it the full durable treatment for free: optimistic placeholder, 'failed'+Retry+calm-reason
   * on a space-token drought, and re-signing via drainPendingPosts — previously this second sign had
   * none of that and could throw uncaught once space_tokens_required is on. Absent for a normal edit.
   */
  promotedFeedId?: string;
}

/** A durably-recoverable GROUP chat message (NIP-29 kind-9 into `groupId`, see postToGroup).
 *  `replyTo` optionally quotes a parent message in-timeline (Telegram-style) — distinct from the
 *  kind-12 THREADED reply below. Queues here because its bound-npub signature can spend a space-write
 *  token once the relay requires one (T0.3 — mirrors PendingChannelWrite's reason #1; a group write
 *  mints no media blobs, so it has no reason #2). */
interface PendingGroupWrite extends PendingWriteBase {
  type: 'group';
  groupId: string;
  replyTo?: string;
}

/** A durably-recoverable GROUP chat EDIT — position-preserving re-publish of `originalId` (see
 *  editGroupMessage). Queues here for the same reason {@link PendingGroupWrite} does (T0.3). */
interface PendingGroupEditWrite extends PendingWriteBase {
  type: 'groupEdit';
  groupId: string;
  originalId: string;
  /** Set when this edit is promoteChannelPost's in-place "promoted" marker (T4.3) — see
   *  {@link PendingChannelEditWrite.promotedFeedId}, same reason, same mechanism. */
  promotedFeedId?: string;
}

/** A durably-recoverable GROUP threaded reply (kind-12) to `parentId` (see replyToGroupMessage).
 *  Queues here for the same reason {@link PendingGroupWrite} does (T0.3). */
interface PendingGroupReplyWrite extends PendingWriteBase {
  type: 'groupReply';
  groupId: string;
  parentId: string;
}

/**
 * A durably-recoverable REACTION (kind-7) — a feed vote/retraction, a channel-message emoji tap, or a
 * group-message emoji tap (see vote/reactToChannelMessage/reactToGroupMessage). Kind 7 is a BLIND
 * content kind on this relay (blindContentKinds / blind_required), so a reaction can need a blind
 * posting token exactly like a post or comment — but it used to ride {@link AppRuntime.signOptimisticWrite}
 * instead, whose catch DISCARDS the placeholder on exhaustion. A dry wallet + a slow/failed Tor draw
 * therefore made a tapped ✦ (or emoji, or retraction) show instantly and then silently vanish seconds
 * later. Queuing here instead keeps it 'failed' (Retry) + persisted, exactly like a comment, and it
 * drains on reconnect/draw/pull-refresh via drainPendingPosts the same way.
 *
 * `scope` picks how {@link AppRuntime.signPendingEvent}/{@link AppRuntime.unsignedForPending} rebuild
 * and sign the real event — the three call sites are wire-DIFFERENT only in one way (the `h` tag /
 * signer), so `scope` is the single discriminant for that:
 *  - 'feed'    : a plain vote/retraction (feed/voting.ts buildReaction/buildRetraction) — no `h` tag,
 *                blind-signed via feedSigner, same shape `content` maps to `+`/`-`/RETRACT_MARKER.
 *  - 'channel' : a channel-message emoji (channels/reactions.ts buildEmojiReaction) — wire-IDENTICAL to
 *                'feed' (no tag distinguishes a channel target from a feed post target), also blind.
 *  - 'group'   : an `['h', groupId]`-tagged reaction (feed/voting.ts buildGroupReaction) — npub-signed
 *                (GroupGuard requires the real member) with a BEARER posting token attached when the
 *                relay demands one and space tokens haven't taken over (bearerReactionTokenTags).
 *
 * `targetId`/`targetPubkey` are the `e`/`p` tags every scope carries; `groupId` is the `h` tag, set
 * only for 'group'. DEDUPE (latest-intent-wins): {@link AppRuntime.sendReaction} REPLACES any reaction
 * already queued for the same (scope, targetId, cid, slotId) — discarding its superseded placeholder
 * and queuing a fresh one — rather than queuing a second write, so a like→retract→like re-tap
 * collapses to ONE queued event instead of three, mirroring how scoreReactions/tallyEmojiReactions
 * only ever count the latest reaction per resolved voter.
 */
interface PendingReactionWrite extends PendingWriteBase {
  type: 'reaction';
  scope: 'feed' | 'channel' | 'group';
  targetId: string;
  targetPubkey: string;
  groupId?: string;
}

/**
 * A write held for durable recovery: rendered as an optimistic placeholder, then signed; on a token
 * drought it stays 'failed' (Retry) + persisted per-account and is re-signed by drainPendingPosts on
 * reconnect / draw / pull-refresh — so it survives an app restart and is never lost.
 *
 * The BLIND writes (post / comment / pinned / reaction) queue here because their own signature spends
 * a POST token. The bound-npub SPACE writes — channel broadcast/edit, group post/edit/reply (T0.2/T0.3)
 * — queue here too, for reasons that look different per write but land on the same pipeline: once the
 * relay requires space-write tokens, EVERY one of these writes' own bound-npub signature spends one via
 * the `identity` pre-sign hook (spaceTokenTagsFor); a channel broadcast's MEDIA additionally mints
 * blind blobs off the post wallet, independent of its own signature. So "bound-npub, therefore can't
 * exhaust tokens" is not a valid inference for any write in this union (see PendingChannelWrite's doc —
 * assuming it was is exactly what F2 got wrong). A GROUP reaction is bound-npub too (GroupGuard) but
 * spends a BEARER posting token rather than a space-write one — see PendingReactionWrite's doc.
 *
 * DMs are the one write-shape that stays OFF this queue, by design rather than by omission: a DM has no
 * feed placeholder to hold — the thread's own optimistic echo (sentByPeer) already plays that role —
 * and its retry story is already durable end to end via sendDM's catch-all + retryDm (same-event outbox
 * retry for a relay reject, full re-seal for a pre-relay/exhaustion failure). Folding it into this queue
 * would duplicate that, not improve it. A DM emoji reaction (reactToDM) is the same story and stays on
 * signOptimisticWrite for the identical reason.
 */
type PendingWrite =
  | PendingPostWrite
  | PendingCommentWrite
  | PendingPinnedWrite
  | PendingChannelWrite
  | PendingChannelEditWrite
  | PendingGroupWrite
  | PendingGroupEditWrite
  | PendingGroupReplyWrite
  | PendingReactionWrite;

/** Back-compat alias — existing references read `PendingCompose`; the type is now the PendingWrite union. */
type PendingCompose = PendingWrite;

/**
 * Stand-in returned by mintMediaBlobs' DRY-RUN split pass, whose only job is to satisfy
 * `splitMediaBlobs`' synchronous `signBlob` seam while we collect the payloads it hands us. The body
 * that pass produces — the only thing this value can reach — is discarded; the real, individually
 * signed blobs are written in a second pass. `id` is 64 hex purely so `encodeBlobTail`'s validation
 * accepts it (it rejects a non-id, which would corrupt a body). Never stored, never signed, never
 * published: its `sig` is empty and it is unreachable from any other code path.
 */
const MINT_PROBE_BLOB: Event = {
  id: '0'.repeat(64),
  pubkey: '',
  sig: '',
  kind: KIND_MEDIA_BLOB,
  tags: [],
  content: '',
  created_at: 0,
};

/**
 * Sniff whether a media-blob payload (base64) is an IMAGE by its leading magic bytes — the picture
 * vs audio split the Phase-4d media router keys on. Decodes only the first few bytes (enough for
 * every image magic number), so it never materializes the whole payload. Any decode failure or
 * non-image magic ⇒ false (treated as audio), which is the safe default: an audio blob paying from
 * the audio wallet, or (if that domain is off) from the post wallet.
 */
function payloadLooksLikeImage(base64Payload: string): boolean {
  // 16 base64 chars decode to 12 bytes — enough for the longest magic (RIFF/WEBP at offset 8..11).
  const head = base64Payload.slice(0, 16);
  if (head.length < 16) return false;
  try {
    return detectImageType(base64ToBytes(head)) !== null;
  } catch {
    return false;
  }
}

export class AppRuntime {
  /**
   * The active identity. Reassigned on a community switch (each community binds its own KeyRing
   * slot, and a slot's signing key + credential are bound at construction), so it is NOT readonly.
   */
  private identity: Identity | null;
  /** Active KeyRing slot id + community id — the namespace every per-community store reloads under. */
  private activeSlotId: string | undefined;
  private activeCid: string | undefined;
  /**
   * True only while a community switch is mid-flight (identity/store/caches being swapped). Gates
   * getSnapshot() and publishOptimistic() so no read or write lands against a half-swapped runtime.
   */
  private switching = false;
  private readonly pins: PinVault | null;
  private readonly autolock: AutoLock;
  private readonly lockController: LockController | null;
  /** Persisted set of joined communities + which one is active (the active relay source). */
  private readonly communities: CommunityStore | null;
  /** Multi-identity key ring: one slot per enrolled (key, community) pair + the active slot. */
  private readonly keyRing: KeyRing | null;
  private readonly sessions = new SessionManager();
  // `urgent` is true for user-initiated changes (post/vote/lock/nav) that must render immediately,
  // and false for the throttled relay firehose — which the host can choose to apply off the
  // interaction path so syncing never competes with scrolling/taps.
  private readonly listeners = new Set<(snapshot: AppSnapshot, urgent: boolean) => void>();
  private readonly outbox: Outbox;
  /** Blind-token wallet (per-post anti-spam tokens); null on builds without secure storage. */
  private wallet: EpochWallet | null = null;
  /**
   * The SIX auxiliary blind-token budgets — read (content-encryption meter, C7), the four media
   * write/read domains (asks #3/#4), and space-write (tokens-everywhere) — pooled behind ONE
   * purpose-indexed {@link TokenPool} (T4.2 unification of the former `ReadWallet`/`makeMediaWallets`/
   * `SpaceWallet` shims). Each purpose stays its own fully independent metered pool under its own
   * storage base and issuer-key fingerprint, only drawn/spent once its own gate opens
   * (content_encryption / media_write_domains / space_tokens_required) — ships dark exactly like
   * before. Rebound to the active slot in lock-step with the posting wallet (rebuildIdentity). The
   * posting wallet above stays OUTSIDE the pool: it alone carries the proactive low-water top-up +
   * on-demand draw-and-retry machinery (feedSigner/maybeRefillWallet/drawTokens), which is genuinely
   * unique rather than a divergent copy. Null on builds without secure storage.
   */
  private tokenPool: TokenPool | null = null;
  /**
   * Last-known per-purpose wallet counts (T5.1/F18) — the cached half of AppSnapshot.tokenStatus.
   * getSnapshot() is synchronous but a wallet's count() is an async SecureStorage round-trip, so
   * counts are refreshed out-of-band by {@link refreshTokenWalletCounts} (called by the `__DEV__`
   * token-status screen on open / manual refresh) and cached here for every snapshot build to read
   * cheaply in between. All-zero until the first refresh — accurate for a fresh runtime that hasn't
   * drawn anything yet, and self-corrects the moment a screen requests one. Read-only diagnostics
   * only: nothing else in the runtime consults this field.
   */
  private _tokenWalletCounts: TokenWalletCounts = EMPTY_TOKEN_WALLET_COUNTS;
  /** The organizer's announced CURRENT content epoch (kind-30078 stiq:content-epoch) — the window new
   *  posts seal under (censorable reads, #4). Null until the organizer runs content sealing. Read by
   *  {@link ensureWriteEpoch} to provision the write key so seal-on-write works. */
  private _announcedContentEpoch: number | null = null;
  /** In-flight guard for ensureWriteEpoch so overlapping relay syncs don't each spend a read token
   *  provisioning the SAME epoch (mirrors _lowWaterRefillInFlight). */
  private _writeEpochProvisionInFlight = false;
  /**
   * The most recent token-draw failure, with its machine code when the organizer supplied one
   * (DrawErrorCode — the stale-key family drives the self-heal). Read by {@link exhaustionReason} so
   * a write that fails on an EMPTY wallet can say WHY the wallet is empty ("keys re-syncing", not
   * "check your connection") — the 2026-07-21 incident's misleading-message fix. Never rendered raw.
   *
   * `quotaSpent` marks the OPPOSITE mislead (2026-07-28 arti-outage follow-up): a draw that
   * SUCCEEDED but returned zero tokens — the organizer's epoch allowance is genuinely spent. The
   * wallet then empties with no `ok:false` recorded, and the eventual BlindTokensExhausted showed
   * its default "check your connection" copy for a quota that no amount of reconnecting refills.
   * `timedOut` carries DrawResult's structured timeout flag so the classifier never string-matches.
   */
  private _lastDrawFailure: {
    purpose: DrawPurpose;
    error: string;
    code?: string;
    timedOut?: boolean;
    quotaSpent?: boolean;
    at: number;
  } | null = null;
  /** In-flight one-shot `stiq:token-keys` fetch (deduped — concurrent stale-key draws share it). */
  private _tokenKeysSync: Promise<boolean> | null = null;
  /** Last time a background key re-sync was scheduled off a C5 advisory, for throttling. */
  private _lastKeyResyncAt = 0;

  // ── Perf instrumentation (T-G1, permanent + cheap) ──────────────────────────────────────────────
  // Every line below rides the existing `log` ring (scope prefixed 'perf:...') so `adb logcat | grep
  // perf` reconstructs a timeline: wallet spend-from-hand vs on-demand draw (feedSigner/
  // spendSpaceTokens/drawForWallet), one line per durable write's queue→sign→outbox→relay-OK
  // lifecycle (queuePendingWrite/signPendingWrite/publishOptimistic/deliver), and epoch-unlock attempt
  // cadence (noteLockedEpochs). Diagnostic only — never gates behavior, never throws, bounded memory.

  /**
   * Per-write lifecycle timestamps (T-G1b), keyed transiently by the write's id — the PLACEHOLDER id
   * (intent.id) until signPendingEvent resolves, then re-keyed to the REAL signed event.id (the two
   * differ: the placeholder is a local compose id, the real id is the computed event hash). Logged as
   * one line per terminal outcome (accepted / rejected / a bounded few pending updates), then dropped.
   * A hard cap guards against an entry surviving forever (e.g. a write silently abandoned mid-drought
   * across many app lifetimes) — diagnostics must never be the thing that leaks memory.
   */
  private _writeTimeline = new Map<
    string,
    {queueAt: number; signAt?: number; outboxAt?: number; kind: string}
  >();
  private static readonly WRITE_TIMELINE_CAP = 300;

  /** Start a write's perf timeline at the moment it's queued (queuePendingWrite). */
  private noteWriteQueued(id: string, kind: string): void {
    if (this._writeTimeline.size >= AppRuntime.WRITE_TIMELINE_CAP) {
      const oldest = this._writeTimeline.keys().next().value;
      if (oldest !== undefined) this._writeTimeline.delete(oldest);
    }
    this._writeTimeline.set(id, {queueAt: Date.now(), kind});
  }

  /** Re-key a write's timeline entry from its placeholder id to the real signed event id, logging the
   *  queue→sign delta (the portion that may have included an on-demand draw). */
  private noteWriteSigned(placeholderId: string, realId: string): void {
    const t = this._writeTimeline.get(placeholderId);
    if (!t) return;
    this._writeTimeline.delete(placeholderId);
    t.signAt = Date.now();
    this._writeTimeline.set(realId, t);
    log.info('perf:write', `${t.kind} id=${realId.slice(0, 8)} queue→sign=${t.signAt - t.queueAt}ms`);
  }

  /** Mark the moment a write's real event landed in the outbox (publishOptimistic). */
  private noteWriteOutboxed(eventId: string): void {
    const t = this._writeTimeline.get(eventId);
    if (t && t.outboxAt === undefined) t.outboxAt = Date.now();
  }

  /** Log + drop this write's timeline on a terminal outcome (deliver()'s accepted/rejected/failed
   *  branches). `outcome` is folded into the line so a `grep perf:write` scan also shows WHY a write
   *  took as long as it did. No-op (silent) for an id with no tracked entry — every write but a
   *  PendingWrite (votes/reactions/DMs/moderation actions) never gets one, by design. */
  private noteWriteTerminal(eventId: string, outcome: string): void {
    const t = this._writeTimeline.get(eventId);
    if (!t) return;
    this._writeTimeline.delete(eventId);
    const now = Date.now();
    const signAt = t.signAt ?? now;
    const outboxAt = t.outboxAt ?? signAt;
    log.info(
      'perf:write',
      `${t.kind} id=${eventId.slice(0, 8)} ${outcome} queue→sign=${signAt - t.queueAt}ms ` +
        `sign→outbox=${outboxAt - signAt}ms outbox→relay=${now - outboxAt}ms total=${now - t.queueAt}ms`,
    );
  }

  /** Epoch-unlock attempt cadence (T-G1d): count per rolling ~60s window, one summary line per
   *  window — cheap enough to call on every noteLockedEpochs attempt start without flooding the ring. */
  private _unlockAttemptsWindowStart = 0;
  private _unlockAttemptsThisWindow = 0;
  private noteUnlockAttempt(): void {
    const now = Date.now();
    if (this._unlockAttemptsWindowStart === 0) this._unlockAttemptsWindowStart = now;
    this._unlockAttemptsThisWindow++;
    const elapsed = now - this._unlockAttemptsWindowStart;
    if (elapsed >= 60_000) {
      log.info('perf:unlock', `attempts=${this._unlockAttemptsThisWindow} in ${Math.round(elapsed / 1000)}s`);
      this._unlockAttemptsWindowStart = now;
      this._unlockAttemptsThisWindow = 0;
    }
  }

  /**
   * Per-purpose in-flight draw coalescing for the auxiliary (pool) token domains — churn cap (T-G3a):
   * a channel broadcast + a DM + a group message can all find the space-write wallet dry in the same
   * tick; each independently calling {@link drawForWallet} would stack multiple concurrent Tor
   * round-trips for the IDENTICAL purpose on the one SOCKS circuit. Concurrent callers instead
   * coalesce onto ONE draw and all await its outcome — mirrors the posting wallet's App.tsx-level
   * `drawInFlight` coalescing and {@link maybeRefillWallet}'s `_lowWaterRefillInFlight` latch,
   * generalized per pooled purpose so the same protection covers space-write and media-write without a
   * bespoke flag per purpose. Also logs perf:draw start/end/duration for every ACTUAL draw (not the
   * callers that merely coalesced onto one already running).
   */
  private _auxDrawInFlight = new Map<PoolPurpose, Promise<{ok: boolean; drawn: number; error?: string}>>();

  private drawForWalletDeduped(
    connect: () => RelaySocket,
    wallet: EpochWallet,
    purpose: PoolPurpose,
    count: number,
  ): Promise<{ok: boolean; drawn: number; error?: string}> {
    const existing = this._auxDrawInFlight.get(purpose);
    if (existing) return existing;
    const startedAt = Date.now();
    log.info('perf:draw', `purpose=${purpose} start`);
    const promise = this.drawForWallet(connect, wallet, purpose, count).then(res => {
      log.info(
        'perf:draw',
        `purpose=${purpose} end ok=${res.ok} drawn=${res.drawn} ms=${Date.now() - startedAt}`,
      );
      return res;
    });
    this._auxDrawInFlight.set(purpose, promise);
    void promise.finally(() => {
      if (this._auxDrawInFlight.get(purpose) === promise) this._auxDrawInFlight.delete(purpose);
    });
    return promise;
  }

  /**
   * Sealed-epoch AUTO-unlock state (invisible members-only reads): epoch → retry bookkeeping. The
   * feature is deliberately not user-visible — a sealed item on screen triggers a background
   * read-token unlock (noteLockedEpochs), the item re-renders decrypted when the key lands, and only
   * a member whose unlocks keep being REFUSED (read-revoked) ever sees a persistent members-only
   * card. `lastFatal` distinguishes that refusal (long backoff, quiet card) from transient Tor
   * failures (short backoff, still treated as pending). Cleared on community/account switch.
   */
  private readonly _epochUnlock = new Map<
    number,
    {inFlight: boolean; attempts: number; nextAt: number; lastFatal: boolean}
  >();
  /** Signs blind-eligible content (feed posts/comments/reactions/polls/voice) as relay-blind when
   *  the community is provisioned; falls back to plain npub signing otherwise. */
  private contentSigner: BlindSigner | null = null;
  /** Persistent post drafts (autosave / resume). */
  readonly drafts: DraftStore;
  readonly eventDrafts: EventDraftStore;
  /** Relay-blind display names (own name + learned npub→name book). */
  readonly displayNames: DisplayNameStore;
  /** Relay-blind identity gradients (own set-once gradient + learned npub→gradient book). */
  readonly gradients: GradientStore;
  /** Pending "confirmed ring lingers then clears" timers, cleared on dispose. */
  private readonly confirmTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Local backoff-resend timers for still-'sending' outbox events, keyed by event id (see
   *  scheduleResend). Cleared on dispose alongside confirmTimers. */
  private readonly resendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Event ids currently mid-flight through deliver()'s deps.publish() call — guards against the
   *  local resend timer and onRelayConnected's reconnect flush both re-publishing the same
   *  still-unsent event concurrently (see deliver()). */
  private readonly inFlightDeliveries = new Set<string>();
  /**
   * Event ids of the user's own FEED POSTS that are in flight and, IF THEY LAND, warrant an explicit
   * "Posted" confirmation. Registered by signPendingWrite the moment a post's real event is
   * published; consumed exactly once, by confirmDelivery. Registering is inert on its own — an id
   * sitting here announces nothing; only a real confirmation acts on it.
   *
   * Only feed POSTS are registered, and that line is deliberate rather than incidental. A post is the
   * one write whose composing surface is DESTROYED by publishing: ComposerScreen closes on the tap
   * and never learns the outcome, and the resulting card can be scrolled or navigated away from long
   * before the Tor blind draw settles. Every other write leaves the user looking at the thing they
   * wrote with its own SendProgress attached — a comment in its thread, a broadcast on its
   * BroadcastCard, a DM in its conversation — so a floating confirmation would only repeat, over the
   * top of the user's own screen, what the card beside their thumb already says.
   *
   * Media BLOBS are never registered either, and must not be: a post's blobs land BEFORE the post
   * does (deliver()'s dependsOn gate), so announcing a blob would announce a post that has not been
   * sent yet — the precise "claims an outcome it doesn't have" failure this surface exists to avoid.
   */
  private readonly announceOnConfirm = new Set<string>();
  /** Backing counter for AppSnapshot.postsDelivered. confirmDelivery is its ONLY writer. */
  private _postsDelivered = 0;
  /**
   * Send status for the OPTIMISTIC compose PLACEHOLDER a post/comment/vote renders BEFORE the
   * (possibly seconds-long, Tor-bound) blind draw+sign resolves — keyed by the placeholder's temp
   * `local-…` id. The placeholder Event is store.save()'d so the feed renders it instantly, and this
   * status is merged into the snapshot's `sendStatus` so the send ring shows — but the placeholder is
   * NEVER routed through the outbox as a deliverable (its signature is a placeholder), exactly as
   * sendDM shows its echo without publishing an unsigned event. On sign SUCCESS the placeholder is
   * swapped for the real signed event (which then rides the outbox + deliver); on a final draw/sign
   * exhaustion a POST placeholder stays 'failed' (Retry) while its intent is queued in
   * `pendingPosts` for auto-recovery. In-memory only: rebuilt from `pendingPosts` on cold load /
   * switch-back; cleared on a workspace switch (clearSwitchCaches) + dispose.
   *
   * Each entry also carries an optional `reason` (T0.3), set only alongside 'failed' — the SAME calm,
   * non-jargon message {@link BlindTokensExhausted} carries (never raw token/draw/allowance prose, F4).
   * Merged into the snapshot's `sendReasons` (see sendReasonsSnapshot) alongside Outbox.reason, so a
   * feed post / comment / channel / group write that fails at SIGN time — before it ever reaches the
   * outbox — shows the same "failed + reason + Retry" shape a relay-rejected write gets, instead of a
   * bare, unexplained ✕. */
  private readonly awaitingSign = new Map<string, {status: 'sending' | 'failed'; reason?: string}>();
  /** Monotonic counter bumped on every `awaitingSign` mutation (set/delete/clear) — lets
   *  sendStatusSnapshot() cache its merged Map alongside outbox.version() and skip a rebuild when
   *  neither has changed (P2-2 / C2: restores React.memo on feed cells by keeping the snapshot's
   *  object identity stable across emits that touch neither the outbox nor a compose placeholder). */
  private _awaitingSignVersion = 0;
  /** Durable recovery queue of token-exhausted BLIND-write compose intents — posts, comments AND
   *  pinned comments (see post() / comment() / setPinnedComment() / signPendingWrite). Each entry
   *  carries its placeholder `id` + the params needed to rebuild+re-sign it + the ACTIVE (cid, slotId)
   *  at compose time. drainPendingPosts() re-signs ONLY intents whose captured pair still matches the
   *  active pair and DROPS the rest — so a write composed in community/account A can never be re-signed
   *  with B's feedSigner and published into B (wrong attribution / a cross-silo identity link).
   *
   *  PERSISTED per-ACCOUNT (persistPendingCompose → pendingComposeKey(slot); the body is sensitive, so
   *  an encrypted slot-scoped key, never global/plaintext) so a post survives an app kill mid-draw and
   *  is recovered on cold load / reconnect / pull-to-refresh — not lost to a purely-in-memory queue.
   *  Cleared (in-memory only) on a workspace switch; the outgoing account's persisted copy stays for
   *  when it becomes active again. */
  private readonly pendingPosts: PendingCompose[] = [];
  private enrolled = false;
  private pinEnabled = true;
  private tagPolicy: TagPolicy = DEFAULT_TAG_POLICY;
  private labels: LabelConfig = DEFAULT_LABELS;
  private postRules: PostRules = DEFAULT_POST_RULES;
  private postRulesAt = 0;
  private postingGuidelines: PostingGuidelines | null = null;
  private pictureRules: PictureRules = DEFAULT_PICTURE_RULES;
  private audioRules: AudioRules = DEFAULT_AUDIO_RULES;
  private reasons: ReasonsConfig = DEFAULT_REASONS;
  private ranking: RankingConfig = DEFAULT_RANKING;
  /** Organizer Nostr pubkey for the active community — used to validate kind-30078 updates. */
  private activeOrganizerPubkey: string | undefined;
  /**
   * Cached active community record (P2 MirrorSet, synthesis §1.2/§1.6/§1.7), refreshed every
   * loadActiveCommunityPolicy call (cold init + every community switch) and kept in lock-step by a
   * durably-accepted live `stiq:mirrors` update (see handleIncomingEvent). undefined before the
   * first community resolves. Backs the synchronous {@link activeSecondaryMirrors} accessor so
   * App.tsx can read the effective mirror set inline while building the primary relay socket.
   */
  private activeCommunity: EnrolledCommunity | undefined;
  /**
   * In-memory MAX(created_at) watermark per org-config `d`-tag (P2 §1.7 governance union,
   * anti-rollback / attack H): a stale or withholding mirror replaying an OLDER kind-30078 event
   * for a `d` we've already applied a newer one for is dropped in handleIncomingEvent. Session-only
   * (reset on restart) — `stiq:mirrors` additionally checks the DURABLE `mirrorsOrgAt` field
   * (persisted on the community record) so that specific d-tag stays rollback-safe across restarts
   * too, since more than one mirror can deliver it.
   */
  private readonly _orgConfigAt = new Map<string, number>();
  /** Active community's shared community key (base64, v3 only) — the per-community blind-post secret. */
  private activeCommunityKey: string | undefined;
  /**
   * Fingerprint of the active community's POSTING-token issuer key (`postIssuerPublicKey ??
   * issuerPublicKey`). Bound onto the per-community wallet so it discards tokens drawn under a prior
   * issuer key (a domain-sep cutover / key rotation) and self-heals instead of bricking posting.
   */
  private activePostKeyFp: string | undefined;
  /** Fingerprint of the active community's READ-token issuer key (`readIssuerPublicKey`), if any. Only
   *  compared against the relay's advertised read fingerprint (C5); undefined when the community has no
   *  read key or read metering is off. */
  private activeReadKeyFp: string | undefined;
  /**
   * Fingerprint of the active community's SPACE-WRITE-token issuer key (`spaceWriteIssuerPublicKey`,
   * falling back to `issuerPublicKey`), compared against the relay's advertised `spaceWrite`
   * fingerprint SET (C5/T1.4 — fixes F6: space-write previously had NO fingerprint field at all, so a
   * stale key sailed straight through undetected). Undefined when the community carries neither key.
   */
  private activeSpaceWriteKeyFp: string | undefined;
  /** Fingerprint of the active community's PICTURE-WRITE-token issuer key, compared against the
   *  relay's advertised `picture` fingerprint SET (C5/T1.4, T1.3's media leg). Media-READ has no
   *  consumption path anywhere (F12) and is intentionally NOT tracked here. */
  private activePictureWriteKeyFp: string | undefined;
  /** Fingerprint of the active community's AUDIO-WRITE-token issuer key, compared against the relay's
   *  advertised `audio` fingerprint SET (C5/T1.4, T1.3's media leg). */
  private activeAudioWriteKeyFp: string | undefined;
  /**
   * Set (by verifyCommunityProvisioning) when the relay ADVERTISED a purpose-key fingerprint SET that
   * the active community's posting/space-write/media/read key does not match — a stale/mis-provisioned
   * invite (C5). While set, feedSigner refuses to sign so posting fails LOUDLY with this message
   * instead of every blind post silently failing at the relay. Undefined whenever caps advertise no
   * fingerprints (fallback), so today's behaviour is byte-identical until a relay actually advertises
   * domain separation. Self-heals (T1.4/F6): a live `stiq:token-keys` re-sync that adopts a matching
   * key clears this on the next verify — never a permanent brick (see rebindPurposeKeyFingerprints).
   */
  private _communityKeyError: string | undefined;
  private inbox: Conversation[] = [];
  /**
   * Messages WE sent, keyed by recipient pubkey. A sent DM is gift-wrapped to the recipient,
   * so we can't decrypt our own copy from the relay — we echo it locally instead, with a live
   * send status. (In memory for the session; survives relay-driven inbox refreshes.)
   */
  private readonly sentByPeer = new Map<string, DirectMessage[]>();
  /** My own DM reactions (I never receive my own wraps back, so track them for optimistic display).
   * Persisted via saveDmReactions() so they survive a restart; the peer's copy lives in the wrap cache. */
  private readonly myDmReactions: {targetRumorId: string; emoji: string}[] = [];
  /**
   * Inbox decrypt cache (audit finding #2). Gift wraps are immutable and decryption (NIP-44
   * unwrap) is expensive, yet refreshInbox ran on every incoming wrap and re-decrypted the WHOLE
   * cache each time — O(N²) during a DM sync burst. We decrypt each wrap at most once: successful
   * decrypts land in `decryptedWraps` (keyed by wrap id), and every attempted wrap id is recorded
   * in `seenWrapIds` so undecryptable wraps (not addressed to us) are never retried either.
   */
  private readonly decryptedWraps = new Map<string, DirectMessage>();
  private readonly seenWrapIds = new Set<string>();
  /**
   * Per-identity NIP-44 conversation-key cache (finding #2): a repeat sender's inner-seal key is
   * derived once, not per wrap. Holds only derived per-peer keys (never the raw secret key), so it is
   * safe to keep across refreshes; cleared with the rest of the DM caches on switch / duress.
   */
  private convKeyCache: ConversationKeyCache | undefined;
  /**
   * Persisted NEGATIVE decrypt cache (finding #4): wrap ids proven undecryptable-for-us (decoy /
   * not-addressed-to-us). Wrap ids are public, so persisting them does NOT leak DM plaintext
   * (PLAN.md §4.1) — only which wraps we skipped. Seeded into seenWrapIds on launch so we never
   * re-attempt the (permanent, since keys never rotate) full-ECDH unwrap of the same alien wraps
   * every cold start. Debounced-persisted; wiped on duress / leave.
   */
  private readonly failedWrapIds = new Set<string>();
  private _failedWrapsDirty = false;
  private _failedWrapsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cached hex pubkey, so the relay subscription plan can read it synchronously. */
  private myPubkey: string | undefined;
  /**
   * NIP-29 group ids the user has created or joined. Group state is off-firehose, so we must
   * remember each id and re-open its scoped subscription on every relay (re)connect — that's
   * what makes a created/joined group appear and survive a restart. Loaded in init().
   */
  private joinedGroups = new Set<string>();
  /**
   * My OUTSTANDING join requests (membership handoff), keyed by group id — the requester side of
   * the silent-decline contract: the relay's Pending set is the ADMINS' view; this local record is
   * what keeps the requester rendering "pending" even after a silent decline cleared them there.
   * Cleared only by withdraw (9022) or by actually becoming a member (39002 lists me). Persisted
   * per identity slot (a 9021 is signed by one npub). Loaded in loadWorkspaceState.
   */
  private myJoinRequests: Record<string, MyJoinRequest> = {};
  /** "Not now" invite dismissals: space id → the dismissed invite's `at` (local-only; per slot).
   *  A strictly newer invite (a deliberate re-invite) re-surfaces the card. */
  private dismissedInvites = new Map<string, number>();
  /**
   * Incoming space invites lifted off decrypted DM bodies (the SOH-i frame; see ingestDecrypted),
   * newest per space. Session-lived — rebuilt from the decrypted-wrap cache each run, exactly like
   * the inbox itself. Never persisted (derives from DMs which are themselves never persisted
   * decrypted).
   */
  private readonly incomingInvites = new Map<string, {payload: InvitePayload; inviter: string; at: number}>();
  /** Decrypted join-request intro notes, keyed by 9021 event id (null = undecryptable-for-me). */
  private readonly _joinNoteCache = new Map<string, JoinNotePayload | null>();
  /** 9021 ids currently being unsealed, so the async decrypt kicks once per event. */
  private readonly _joinNoteInflight = new Set<string>();
  /** `<groupId>:<pubkey>` pairs this session already auto-approved (invited accepts) — guards the
   *  approve → 39004 re-emit → handleIncomingEvent loop from double-firing. */
  private readonly _autoApproved = new Set<string>();
  /** Group ids whose 39000/39001/39002 preview fetch was already requested this session. */
  private readonly _previewFetched = new Set<string>();
  /**
   * Draft access control (Phase 5§D, feed/draftAccess.ts) — mirrors the join-request caches above,
   * but simpler in one respect: a `DraftAccessRequest` has no relay-side authoritative pending list
   * to diverge from (contrast the 39004 pending set a join request's local `myJoinRequests` record
   * has to survive a silent decline against), so "pending" is read straight off the durable local
   * copy of the requester's own request event (see `draftAccessOwnerFor`) rather than needing its
   * own separate persisted map.
   */
  /** Decrypted `DraftDelivery` snapshots, keyed by draftId and tagged with the source event id, so a
   *  newer (or revoke-tombstoned) delivery is never served from a stale decrypt. */
  private readonly _draftDeliveryCache = new Map<
    string,
    {eventId: string; snapshot: DraftDeliverySnapshot | null}
  >();
  /**
   * Bumped whenever {@link getMyDraftDelivery} finishes a FRESH decrypt (a cache miss it just
   * filled) — folded into `deriveNotifications()`'s cache key (Phase 5§G's draft-access-granted
   * block). The decrypt is genuinely async (NIP-44) and finishes strictly after the DraftDelivery
   * event itself already bumped `storeVersionOf`, so without this counter a derive that ran while
   * the decrypt was still in flight would cache the row-less pass forever — nothing else would ever
   * signal that new (decrypted) information became available.
   */
  private _draftDeliveryDecryptVersion = 0;
  /** Decrypted `DraftAccessRequest` notes for MY OWN queue (owner side), keyed by request event id. */
  private readonly _draftAccessNoteCache = new Map<string, DraftAccessRequestPayload | null>();
  /** Request event ids currently being unsealed, so the async decrypt kicks once per event. */
  private readonly _draftAccessNoteInflight = new Set<string>();
  /**
   * Draft-access requests I (as owner) have silently denied — {@link denyDraftAccess} publishes
   * nothing at all, so this local, per-slot record is the ONLY thing stopping the same request from
   * re-appearing in {@link getDraftAccessQueue} forever. Keyed `${draftId}:${requesterPubkey}` → the
   * denied request's `at`. Loaded in loadWorkspaceState; persisted per identity slot.
   */
  private _draftAccessDenied: Record<string, number> = {};
  /**
   * Bumped whenever {@link denyDraftAccess} records a genuinely new (or strictly-newer) denial.
   * `deriveNotifications()`'s owner-side draft-access-request block folds this into its cache key
   * (Phase 5§G): a silent deny publishes NOTHING (by design — see denyDraftAccess's doc), so unlike
   * every other source feeding that cache there is no relay-visible event to bump `storeVersionOf`
   * for. Without this counter, denying a request from the (concurrently-built) Manage-access UI
   * would leave the just-denied row stuck in the notification center until some UNRELATED event
   * happened to invalidate the cache.
   */
  private _draftAccessDenyVersion = 0;
  /**
   * Channel coordinates whose view is CURRENTLY on screen and therefore holds a scoped kind-1311
   * subscription (config's SCOPED_CHANNEL_SYNC). Deliberately NOT persisted and not a membership
   * list — unlike {@link joinedGroups} this is pure view state, so it is rebuilt from scratch each
   * run by openChannel/closeChannel.
   *
   * It exists for one reason: RelayClient.sendSubscribe() RESETS knownSubIds to the plan's subs on
   * every (re)connect, dropping every scoped sub. Joined channels survive that automatically (the
   * plan re-emits the standing `channels` sub), but an OPEN UNJOINED channel — the discovery case —
   * would lose its subscription mid-read and never get it back. resubscribeChannels() re-opens it,
   * exactly as resubscribeGroups() does for groups.
   */
  private openChannels = new Set<string>();
  /**
   * The GROUP mirror of {@link openChannels}: group views currently on screen, session-only. A group
   * you have JOINED survives reconnects via `joinedGroups` — but an OPEN UNJOINED group (a locked
   * preview you're reading, a space you're deciding whether to request) is in neither set, so its
   * scoped sub died permanently on the first reconnect (sendSubscribe()'s knownSubIds reset), and
   * if `relay` was null at open time the sub never existed at all. resubscribeGroups() unions this
   * set in, exactly as resubscribeChannels() consults openChannels.
   */
  private openGroups = new Set<string>();
  /**
   * In-memory private-space E2E key cache for SYNCHRONOUS decrypt-on-read (the SecureStorage is
   * async, but getGroupMessages/getChannelMessages must return decrypted Events synchronously
   * during render). Keyed `<spaceId>:<epoch>` → 32-byte key; the highest epoch per space is tracked
   * in `_spaceEpoch`. Hydrated from the keystore when a private space opens (openGroup) and when a
   * key arrives (invite/join/delivery). Mirrors the joinedGroups hydration pattern, but the keys are
   * SECRET so they are sourced from / persisted to the keystore, never AsyncStorage.
   */
  private readonly _spaceKeyCache = new Map<string, Uint8Array>();
  private readonly _spaceEpoch = new Map<string, number>();
  /**
   * Bumped whenever a space key lands in `_spaceKeyCache` (create/rotate/delivery/hydrate — all
   * funnel through cacheSpaceKeyInMemory). Folded into snapshot `storeVersions.groups` so a key
   * arriving AFTER a sealed space rendered invalidates the group-view memos: the store's chat events
   * were already there, but versionOf() never moves on a key unwrap, so an open private space stayed
   * "No messages yet." until an unrelated write bumped it (on-device Garden Pink bug).
   */
  private _spaceKeysVersion = 0;
  /**
   * Per-space snapshot of the last-seen member set (from the relay's 39002 list), for the
   * censorable-space-reads rekey (tokens-everywhere): when a member DISAPPEARS from a private space
   * we OWN, we rotate the SpaceKey so the departed member can't read future messages — closing the
   * gap where a VOLUNTARY leaver (9022, which unlike a kick never triggered a rotation) kept the
   * current key. Session-only (rebuilt from the relay's 39002 stream); cleared on switch/wipe.
   */
  private readonly _spaceMemberSnapshot = new Map<string, Set<string>>();
  /**
   * Pubkeys we ALREADY rotated the key away from (via {@link rotateSpaceKey}) this session, per
   * space. The 39002-shrink rekey skips these so a kick — which rotates immediately in
   * kickGroupMember — never double-rotates when its resulting member-list shrink arrives.
   */
  private readonly _rotatedOut = new Map<string, Set<string>>();
  /**
   * Session-only optimistic roster overlay: groupId → pubkey → the latest admin-action intent for
   * that pubkey. Applied ONLY at the three UI-facing getters (getGroupMembers/getGroupAdmins/
   * getJoinRequestQueue) so promote/demote/kick/approve/deny reflect before the relay's 39001/39002/
   * 39004 round-trip; reconciled + GC'd on incoming relay state ({@link reconcileRosterOverlay}) and
   * reverted the instant its publish is terminally 'rejected'. NEVER persisted, NEVER read by the
   * crypto readers (space-key delivery/rotation act on relay-confirmed truth only). Cleared on
   * community/account switch (clearSwitchCaches), like {@link _rotatedOut}.
   */
  private readonly _rosterOverlay = new Map<string, Map<string, RosterOverlayEntry>>();
  /** Per-(space:member) highest space-key epoch THIS device has wrapped+delivered as a 30079 — the
   *  dedupe behind {@link maybeDeliverKeyToNewMembers}. Hydrated per slot; persisted best-effort. */
  private _deliveredKeyTo = new Map<string, number>();
  /**
   * Decrypted-PLAINTEXT cache for private-space messages (finding #4), keyed by event id. A NIP-44
   * decrypt of an immutable event always yields the same plaintext, so we run decryptForSpace at most
   * ONCE per message per session — every subsequent render (each MainScreen snapshot, each search
   * keystroke) is an O(1) Map hit with zero crypto. MEMORY-ONLY, NEVER persisted (mirrors the DM
   * `decryptedWraps` rule: decrypted content must never touch disk); cleared with the space keys on
   * community switch and on duress / emergency wipe.
   */
  private readonly _spacePlaintextCache = new Map<string, string>();
  /**
   * Provenance of each cached epoch key delivered via kind-30079 (keyed `<spaceId>:<epoch>`):
   * whether it came from the group owner, and the delivery's created_at. Used to decide whether a
   * later authorized delivery for the SAME epoch should replace the cached key (owner-wins, else
   * latest-created-at) rather than silently ignoring a legitimate admin rotation. Locally-minted
   * keys (createGroup/rotateSpaceKey/invite) have no entry — they're never overwritten by a remote
   * delivery for the same epoch since `has(cacheKey)` short-circuits before unwrap.
   */
  private readonly _spaceKeyDeliveryMeta = new Map<string, {fromOwner: boolean; createdAt: number}>();
  /** Spaces this session already published a key-redelivery request for — one 30078 per space per
   *  app run, ever ({@link maybeRequestSpaceKeyRedelivery}). Session-only ON PURPOSE: while the
   *  member stays keyless, each app run re-publishes ONE fresh request (addressable — it replaces
   *  the previous doc server-side), which is exactly the retry cadence the responder's
   *  created_at watermark expects; once a key lands the trigger condition itself goes false. */
  private readonly _keyRedeliveryRequested = new Set<string>();
  /** Responder-side dedupe for incoming key-redelivery requests, `<spaceId>:<requester>` → the
   *  latest request created_at already answered ({@link maybeRedeliverSpaceKey}). Session-only:
   *  re-answering the same addressable request after a restart just re-publishes the idempotent
   *  addressable 30079 — wasted bytes at worst, never a correctness or confidentiality issue. */
  private readonly _keyRequestAnswered = new Map<string, number>();
  /** Media uploaded this session, keyed by URL, so post() can re-attach its NIP-94 imeta. */
  private readonly uploadedMedia = new Map<string, ImageMeta>();
  /**
   * naddr coordinates (`kind:pubkey:identifier`) already requested via fetchByFilter, so a
   * re-render of an unresolved naddr embed doesn't re-issue the same filter query each frame.
   */
  private readonly requestedNaddrs = new Set<string>();
  /** User-configurable Blossom upload endpoint (persisted; overrides the build default). */
  private readonly mediaSettings: MediaSettingsStore;
  /** Per-period picture-allowance spend (persisted; enforced client-side — see pictureAllowance.ts). */
  private readonly pictureAllowance: PictureAllowanceStore;
  /** User-configurable Tor connection mode (persisted; steers the connect cascade in App.tsx). */
  private readonly torSettings: TorSettingsStore;
  /** The user's default browser, where "Open in my browser" sends a link (persisted). */
  private readonly browserSettings: BrowserSettingsStore;

  // ── Version-keyed caches ───────────────────────────────────────────────────────────────────────
  // These memoize expensive recomputes that run on every getSnapshot() call. Each cache is
  // invalidated automatically by the version counter: store.save() bumps the version for its kind,
  // so any user action (post/vote/comment) that calls store.save() → publishOptimistic
  // immediately invalidates the relevant cache. The cache is only a skip for calls whose inputs
  // are IDENTICAL to the last call — which is the common relay-firehose case between user actions.

  /**
   * Memoized listChannels() result, keyed by versionOf([Kind.LiveActivity]).
   * Invalidated whenever a LiveActivity event is added/removed (which covers channel creates and
   * edits). User creates a channel → publishOptimistic → store.save → version bumps →
   * next getSnapshot() sees a new version and recomputes. Correctness: guaranteed.
   */
  private _channelsCache: {version: number; channels: Channel[]} | undefined;

  /**
   * Memoized buildFeed() result.
   *
   * Feed kinds: Post(1), Article(30023), Poll(1068), VoiceMessage(1222), Reaction(7),
   * Comment(1111), PollResponse(1018), Report(1984), MuteList(10000).
   * Names/gradients are learned from feed-kind events (Post, Article, Comment), so the
   * feed-kind version covers the common case where a new post introduces a new name or gradient;
   * the outer cache is additionally keyed on moderators identity so a roster change triggers a
   * recompute even when no feed event changed.
   *
   * User action correctness: any post/vote/comment calls publishOptimistic → store.save →
   * feedVer bumps → cache miss → immediate recompute. Safe.
   */
  private _feedCache: {feedVer: number; moderatorsKey: string; myPubkey: string | undefined; autoKey: string; identityVersion: number; feed: Feed} | undefined;

  /**
   * Bumped whenever the viewer's OWN relay-blind identity (display name or gradient) changes.
   * Those edits write no Nostr event, so versionOf(FEED_KINDS) doesn't move — folding this counter
   * into the feed-cache key forces buildFeed to re-run so the viewer's own name/gradient re-renders
   * across their feed posts. It also cascades to the composer/settings/header self-avatars: MainScreen
   * memoizes `myProfile` on the feed reference, so a rebuilt feed hands it a fresh gradient too.
   */
  private _identityVersion = 0;

  /**
   * Bumped whenever notification prefs change (setNotificationPrefs). Folded into
   * _notifCache's key so deriveNotifications() re-filters immediately after a prefs edit even
   * though no store event moved (a pure AsyncStorage-backed settings change).
   */
  private _prefsVersion = 0;

  /**
   * Bumped whenever notification read state changes (markNotificationRead / markAllNotificationsRead).
   * Folded into _notifCache's key so the cached rows' `read` flags — and the bell badge count derived
   * from them — refresh even though no store event moved.
   */
  private _readVersion = 0;

  /**
   * Memoized deriveNotifications() result — the live-derived notification center list. Keyed on
   * versionOf() of the kinds it scans (comments, gift-wraps, channel chat/definitions, and the feed
   * post kinds + reports feeding the Posts source) + _identityVersion (a display-name learned after
   * the fact re-renders rows) + _prefsVersion (a settings change re-filters without a new event) +
   * _readVersion (a read-state change re-flags rows) + _mutedVersion (a local author mute drops
   * Posts rows) + myPubkey (a community/identity switch invalidates it) + the `this.inbox` ARRAY
   * IDENTITY — DMs decrypt asynchronously into a rebuilt inbox array with NO store-version bump
   * (the gift-wrap events landed long before their plaintext), so without this key a list cached
   * mid-decrypt would never grow its DM rows. + _draftAccessDenyVersion (Phase 5§G — a silent deny
   * has no relay-visible event to bump `ver` for; see its field doc) + _draftDeliveryDecryptVersion
   * (Phase 5§G — a DraftDelivery's async decrypt resolves strictly after `ver` already bumped for
   * the event's own arrival; see its field doc).
   */
  private _notifCache:
    | {
        ver: number;
        identityVersion: number;
        prefsVersion: number;
        readVersion: number;
        mutedVersion: number;
        draftDenyVersion: number;
        draftDeliveryVersion: number;
        inbox: readonly Conversation[];
        myPubkey: string | undefined;
        items: NotifItem[];
      }
    | undefined;

  // ── Splash / lock handoff (A1) ─────────────────────────────────────────────────────────────────
  /**
   * While true, getSnapshot() returns cheap empty heavy fields (feed/channels/groups/moderation/
   * bookmarks) WITHOUT touching the store, so init()'s first emit can hand off to the splash before
   * the whole cached history is parsed behind it. Set at the start of init(); cleared on the next
   * macrotask after init resolves (scheduleDeferredHeavy) — i.e. AFTER the splash hands off — and on
   * the first unlock (the autolock onChange handler), so the real build always lands.
   */
  private _deferHeavy = false;
  private _deferHeavyTimer: ReturnType<typeof setTimeout> | undefined;

  // ── init() reentrancy guard ────────────────────────────────────────────────────────────────────
  /**
   * Guards init() against concurrent/repeat invocation on the same instance. App.tsx races init()
   * against a timeout and lets a Retry re-invoke init() while the original (hung) call may still be
   * in flight — without this, both calls would run the full init body (migrations, store swap,
   * workspace hydration, first emit) a second time concurrently, a reentrancy hazard (double
   * deep-link replay, double emit, or a half-swapped store race). While set, init() returns this SAME
   * promise instead of starting a second run. Cleared once the run settles (success OR failure); see
   * `_initSucceeded` for what happens next.
   */
  private _initPromise: Promise<void> | null = null;
  /** Set once init() has resolved successfully. Makes a repeat init() call a cheap no-op — the
   *  runtime is already live, so re-running the body would redo migrations/hydration/emits for no
   *  reason. Deliberately NOT set on failure, so a genuinely failed/abandoned init leaves the door
   *  open for a fresh attempt (e.g. a Retry after the in-flight promise itself rejected). */
  private _initSucceeded = false;

  // ── Posts-first scoring (A2) ───────────────────────────────────────────────────────────────────
  /**
   * False until the first reaction-scored feed pass has run. The first heavy feed build skips the
   * kind-7 reaction bucketing (structure only — scores default to 0); scheduleScorePass() then runs a
   * follow-up that recomputes WITH scores and re-emits. Once flipped, every build is fully scored.
   * Reset on a community switch so the incoming (cold) store also builds posts-first.
   */
  private _feedScored = false;
  private _scorePassScheduled = false;
  private _scorePassTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Generation counter for the score pass (P1-4/B3). Captured by scheduleScorePass() when a pass
   * starts; bumped by clearSwitchCaches() and dispose() so an in-flight reaction-bucket warm or
   * chunked item-cache warm (warmScoredFeedChunked) notices it's been superseded — by a community
   * switch or teardown — and stops before flipping `_feedScored`/emitting against a workspace it no
   * longer owns.
   */
  private _scorePassGen = 0;

  /**
   * Generation counter for the community-switch structural warm (P1-3/A3). Captured by
   * activateWorkspace() right after it calls clearSwitchCaches() (which bumps this, same as
   * `_scorePassGen`); checked by warmSwitchKindsChunked() before every kind AND by activateWorkspace
   * itself before its final emit, so a superseding community switch or a removeCommunity/
   * removeIdentity teardown (whose "nothing left" branch calls clearSwitchCaches() directly,
   * bypassing activateWorkspace's `switching` re-entrancy guard) stops an in-flight PREWARM_KINDS
   * chunk-warm before it touches or emits against a workspace it no longer owns. Bumped alongside
   * `_scorePassGen` at both its choke points (clearSwitchCaches(), dispose()) for the same reason.
   */
  private _switchWarmGen = 0;

  // ── Snapshot-scoped derived-value caches (findings #10/#11/#12/#13) ────────────────────────────
  // getSnapshot() ran ~6-8 full-bucket store scans per emit (moderator roster, overlay, banned set,
  // org config, bookmarks, subscriptions) even when nothing changed. Each is now version-keyed on the
  // kind bucket(s) it reads, so a cache-hit snapshot does ZERO store queries for them, and the arrays
  // keep a stable identity (killing MainScreen's per-emit arrangeFeed churn). Correctness is by
  // version bump: store.save(kind) bumps versionOf([kind]) → the relevant cache misses immediately.
  // Every cache degrades to recompute-every-time when the store lacks versionOf (see storeVersionOf).

  /** moderatorNpubs() — the resolved roster, keyed on versionOf([AppData]) + organizer. */
  private _rosterCache: {ver: number; org: string | undefined; npubs: readonly string[]} | undefined;
  /** moderationOverlay() — keyed on versionOf([Report]) + roster identity. */
  private _overlayCache: {ver: number; modKey: string; overlay: ModerationOverlay} | undefined;
  /** moderatorHides() — the roster-global hide context (kind-1984 reports + kind-10000 mutes),
   *  keyed on versionOf([Report, MuteList]) + roster identity. Mirrors _overlayCache; the thread
   *  view rebuilds each open, so this collapses the two full report/mute scans to a hit whenever no
   *  new report/mute-list event has arrived. */
  private _hidesCache: {ver: number; modKey: string; hides: ModeratorHides} | undefined;
  /** Locked/pinned id arrays derived from the overlay — stable identity while the overlay is unchanged. */
  private _overlayIdCache: {overlay: ModerationOverlay | undefined; locked: string[]; pinned: string[]} | undefined;
  /** bannedAuthors() key-set — keyed on versionOf([Report]) + roster identity. */
  private _bannedCache: {ver: number; modKey: string; banned: Set<string>} | undefined;
  /** currentLimits() — keyed on versionOf([AppData]) + organizer. */
  private _limitsCache: {ver: number; org: string | undefined; limits: Limits | undefined} | undefined;
  /** currentPermissions() — keyed on versionOf([AppData]) + organizer. */
  private _permsCache: {ver: number; org: string | undefined; perms: Permissions | undefined} | undefined;
  /** currentCommunityConfig() (getCommunityConfig) — keyed on versionOf([AppData]) + organizer
   *  (heaviness-audit #6: was a full uncached scan on every call). */
  private _communityConfigCache:
    | {ver: number; org: string | undefined; config: CommunityConfig | undefined}
    | undefined;
  /** getLogPage()'s underlying organizer doc — currentLogPage() ?? legacyLogPageDoc(currentGuide(),
   *  currentFeaturedSpaces()) — keyed on versionOf([AppData]) + organizer (heaviness-audit #6: 3 full
   *  scans per call). getLogPage() still resolves this cached doc against live channels/groups/
   *  identities on every call (resolveLogPage) — those have their own freshness independent of any
   *  AppData event — so only the raw config-doc scans are collapsed to a hit. */
  private _logPageDocCache: {ver: number; org: string | undefined; doc: LogPageDoc} | undefined;
  /** currentGovernance() (getGovernance) — keyed on versionOf([AppData]) + organizer. */
  private _governanceCache: {ver: number; org: string | undefined; gov: Governance | undefined} | undefined;
  /** currentModLimits() (checkModLimit) — keyed on versionOf([AppData]) + organizer. */
  private _modLimitsCache:
    | {ver: number; org: string | undefined; limits: ModActionLimits | undefined}
    | undefined;
  /** bookmarkedPostIds() — keyed on versionOf([Bookmarks]) + myPubkey; stable array identity. */
  private _bookmarksCache: {ver: number; myPubkey: string | undefined; ids: string[]} | undefined;
  /** subscribedChannelSet() — keyed on versionOf([ChannelSubscriptions]) + channels version + myPubkey. */
  private _subsCache: {ver: number; chVer: number; myPubkey: string | undefined; ids: string[]} | undefined;
  /** getEventScore() reaction tally — one bucketed pass keyed on versionOf([Reaction]) + myPubkey. */
  private _scoreCache: {ver: number; byTarget: Map<string, Event[]>} | undefined;
  /** Per-channel derived (folded + auto-moderated) message list, keyed on the kinds it reads + id. */
  private readonly _channelMsgCache = new Map<string, {ver: number; msgs: Event[]}>();
  /** Per-group derived (folded + hidden-filtered, PRE-decryption) message list, keyed on kinds + id. */
  private readonly _groupMsgCache = new Map<string, {ver: number; visible: Event[]}>();

  /**
   * getProfile() memo, per pubkey (adversarial-review fix: getProfile is called from render hot
   * paths — a DM/comment/channel-list row per render — and was unconditionally re-scanning the
   * WHOLE visible feed (`.items.filter(authorPubkey===pubkey)`) AND the whole raw comment+post store
   * (`ideaCountFor`, two full un-indexed kind buckets, `resolveAuthorPubkey` per event) on EVERY
   * call. Keyed on the SAME composite `_cachedBuildFeed` uses (feedVer/moderatorsKey/myPubkey/
   * autoKey/identityVersion — see `autoModKeyFor`) plus `_mutedVersion` (visibleFeed's own extra
   * invalidation layer: a locally-muted author's own posts drop out of their profile too). A hit
   * skips buildProfile + the feed filter pass + ideaCountFor's scans entirely — one Map lookup.
   */
  private readonly _profileCache = new Map<
    string,
    {feedVer: number; moderatorsKey: string; myPubkey: string | undefined; autoKey: string; identityVersion: number; mutedVer: number; profile: Profile}
  >();
  /**
   * getIdentity() memo, per pubkey — a thin name+gradient+npub lookup for render-hot callers that
   * never need Profile's posts/ideaCount (see getIdentity's doc comment). Keyed only on
   * `_identityVersion` + myPubkey: every name/gradient change (self-edit, cross-device adoption, or
   * a peer's learned identity) bumps `_identityVersion` (see learnNameFromContent/setMyDisplayName/
   * setMyGradient), so no feed/moderation dependency is needed here.
   */
  private readonly _identityCache = new Map<
    string,
    {identityVersion: number; myPubkey: string | undefined; identity: {pubkey: string; npub: string; name?: string; gradient?: GradientSpec}}
  >();

  // ── Local, device-only feed author mute (Fix 1) ────────────────────────────────────────────────
  // "Mute this author" from a feed/comment ⋯ menu hides that author's posts + comments on THIS
  // device only. It is PURELY LOCAL: muteAuthor/unmuteAuthor touch only this in-memory set +
  // AsyncStorage — they NEVER sign or publish anything (no kind-10000 mute list, no event), so a
  // mute leaks nothing to the relay and never affects relay-blindness/anonymity. The set is
  // per-identity-slot (hydrated in loadWorkspaceState, wiped in wipePerSlotState), mirroring the DM
  // blocklist. `_mutedVersion` bumps on every change so the muted-feed cache invalidates.
  private mutedAuthors = new Set<string>();
  private _mutedVersion = 0;
  /** visibleFeed() — the mute-filtered feed, keyed on the raw feed identity + _mutedVersion so the
   *  filtered array keeps a stable identity (React.memo) until either the feed or the mute set changes. */
  private _visibleFeedCache: {raw: Feed; mutedVer: number; feed: Feed} | undefined;
  /** mutedAuthorPubkeys() snapshot array — keyed on _mutedVersion for stable identity between emits. */
  private _mutedListCache: {ver: number; ids: readonly string[]} | undefined;

  // ── "New content since mark" — Twitter-style feed pill (see markFeedSeen/newFeedItemCountSince,
  // near visibleFeed() below, and AppSnapshot.newFeedItemCount's doc for the consumer contract). ────
  /**
   * Read-position watermark: the newest feed item's wire `createdAt` as of the last
   * {@link markFeedSeen} call. `undefined` = no baseline yet, so `newFeedItemCountSince` always reads
   * 0 — the UI opts IN by calling markFeedSeen() once it has something meaningful to measure "new"
   * against, rather than this guessing at a default (e.g. treating a fresh, never-marked feed as
   * "all new" would paint a bogus pill on first load). Reset to `undefined` on community/account
   * switch (clearSwitchCaches): a mark captured in one community's createdAt timeline is meaningless
   * compared against another's, so a switch starts the pill fresh rather than reporting nonsense
   * (e.g. every post in the freshly-entered community reading as "new").
   */
  private _feedSeenMark: number | undefined;
  /** Version-cache for {@link newFeedItemCountSince} — keyed on the exact `feed` reference (stable
   *  unless the feed's actual content changed, see _feedCache/_visibleFeedCache) crossed with the
   *  mark, so a getSnapshot() between real feed changes is an O(1) hit, never a rescan. */
  private _newFeedCountCache: {feed: Feed; mark: number; count: number} | undefined;

  /**
   * Read the store's per-kind version sum, or `undefined` when the store has no version counters
   * (dev/legacy stores) — in which case every version-keyed cache falls back to recomputing each
   * call, preserving correctness. The SwappableEventStore always defines versionOf, so on-device and
   * in jest (PersistentEventStore extends the versioned InMemoryEventStore) this returns a number.
   */
  private storeVersionOf(kinds: readonly number[]): number | undefined {
    const s = this.deps.store as Partial<StoreWithVersion>;
    return typeof s.versionOf === 'function' ? s.versionOf(kinds) : undefined;
  }

  /**
   * created_at (seconds) of the newest identity (name/gradient) WE have committed locally — either
   * a local edit or an adopted encrypted profile from another device. Guards cross-device adoption:
   * an incoming encrypted profile is adopted only when strictly newer, so a late/stale copy can
   * never clobber a fresher local change. Persisted so the guard survives a restart.
   */
  private _myIdentityAt = 0;

  /**
   * True when an identity edit could not be announced (announceIdentity gated pre-enrollment, or
   * signing failed with the key locked). Settled on the next successful unlock (submitPin) —
   * without it, a swallowed announce leaves the edit local-only until the NEXT edit.
   */
  private _identityAnnouncePending = false;

  // ── Per-identity-slot secure-storage keys (namespaced by the active slot; legacy global before
  //    a slot is known / on a pre-silo install). These carry SECRETS or per-identity state, so they
  //    must never bleed across communities. ──────────────────────────────────────────────────────
  private identityAtItem(): string {
    return this.activeSlotId ? identityAtKey(this.activeSlotId) : LEGACY_IDENTITY_AT_ITEM;
  }
  private sentDmsItem(): string {
    return this.activeSlotId ? dmSentKey(this.activeSlotId) : LEGACY_DM_SENT;
  }
  private dmReactionsItem(): string {
    return this.activeSlotId ? dmReactionsKey(this.activeSlotId) : LEGACY_DM_REACTIONS;
  }
  private dmFailedWrapsItem(): string {
    return this.activeSlotId ? dmFailedWrapsKey(this.activeSlotId) : LEGACY_DM_FAILED_WRAPS;
  }
  private eventStateItem(): string {
    return eventStateKey(this.activeSlotId ?? undefined);
  }

  /**
   * Kinds that buildFeed (+ buildModeratedFeed) reads from the store. Now the shared contract export
   * FEED_STORE_READ_KINDS (C9's deferred TODO) — membership is byte-identical to the old inline literal
   * (adds MuteList/10000; omits LiveChat/1311, LiveActivity/30311, voice-reply/1244). This is the
   * STORE-READ set only; it must never feed the feed REQ (that would stream every member's mute list).
   */
  private static readonly FEED_KINDS: readonly number[] = FEED_STORE_READ_KINDS;

  /**
   * Structural feed buckets to pre-warm while the app sits LOCKED (see schedulePrewarmWhileLocked) —
   * everything the first post-unlock buildFeed reads EXCEPT kind-7 reactions. Reactions are the
   * largest bucket and are skipped by the posts-first build anyway; they are chunk-warmed LAST
   * (warmReactionBucketChunked) so their one-shot parse never lands during PIN entry, yet the
   * post-unlock scored pass still finds them in RAM.
   */
  private static readonly PREWARM_KINDS: readonly number[] = FEED_STORE_READ_KINDS.filter(
    k => k !== Kind.Reaction,
  );

  /** Delay before the locked-window pre-warm fires: behind first lock-screen paint, ahead of a human
   *  PIN entry. Erring short is safe — a faster-than-this unlock just pays the parse as it does today. */
  private static readonly PREWARM_DELAY_MS = 400;

  /**
   * Kinds getProfile's memo (adversarial-review fix — see its doc comment) self-invalidates on:
   * FEED_KINDS (posts/ideaCount/moderation, exactly what visibleFeed/ideaCountFor read) PLUS the two
   * kinds buildProfile itself reads that FEED_KINDS omits — Metadata/kind-0 (legacy; nothing in this
   * app publishes it today, kept for forward-safety) and LiveActivity/30311 (a profile's OWNED
   * channels — deliberately excluded from FEED_KINDS since buildFeed doesn't render channel
   * definitions from the store scan, but buildProfile does read them per-author).
   */
  private static readonly PROFILE_KINDS: readonly number[] = [
    Kind.Metadata,
    Kind.LiveActivity,
    ...AppRuntime.FEED_KINDS,
  ];

  /**
   * Kinds getChannelMessages self-invalidates on (channel broadcasts, space settings, owner/mod
   * reports). Shared with the snapshot's storeVersions.channels (#6) so a later view-level memo can
   * key on the EXACT same signal the data layer already treats as authoritative — one source of
   * truth, so the two can never drift apart.
   */
  private static readonly CHANNEL_VIEW_KINDS: readonly number[] = [Kind.LiveChat, Kind.AppData, Kind.Report];

  /**
   * Kinds the organizer's signed config docs arrive on (kind-30078, one addressable doc per `d`).
   * The feed cache excludes AppData, so a config-only write never changes `feed`'s identity — a
   * Log-tab memo keyed on `feed` would never see a freshly published announcement/guide. This is
   * the scoped signal those memos key on instead (#6, same reasoning as CHANNEL_VIEW_KINDS).
   */
  private static readonly CONFIG_VIEW_KINDS: readonly number[] = [Kind.AppData];

  /**
   * Kinds a group view depends on (#6): the wire content kinds `subscribeGroup` requests off the
   * relay — chat(9)/thread(11)/reply(12)/reaction(7), App.tsx's `chatFilter` — PLUS the moderation
   * kinds getGroupMessages self-invalidates on (report/mute-list/space-settings) PLUS every
   * membership kind the Manage page derives from: the relay-generated roster state
   * (39000-39004 metadata/admins/members/roles/pending) AND the local membership ops
   * (9000/9001/9021/9022) whose optimistic publish must re-render the roster overlay instantly.
   * Without the membership kinds, an admin's open Manage page never saw an incoming approve echo
   * (39002) or even its OWN optimistic approve (9000 insert) — the on-device "requests/members
   * frozen while the group is open" bug. Broader than getGroupMessages' own cache key on purpose:
   * MainScreen's group view composes messages + replies + reactions + roster together, so its
   * invalidation signal must cover them all.
   */
  private static readonly GROUP_VIEW_KINDS: readonly number[] = [
    GroupKind.Chat,
    GroupKind.Thread,
    GroupKind.Reply,
    Kind.Reaction,
    Kind.Report,
    Kind.MuteList,
    Kind.AppData,
    GroupKind.Metadata,
    GroupKind.Admins,
    GroupKind.Members,
    GroupKind.Roles,
    GroupKind.Pending,
    GroupKind.AddUser,
    GroupKind.RemoveUser,
    GroupKind.JoinRequest,
    GroupKind.LeaveRequest,
  ];

  /**
   * Kinds the open post/thread view depends on (#6): the comment representations buildThread reads
   * — kind-1111 comments and kind-1 hybrid 'stiq-comment' notes (Post bucket) — PLUS the moderation
   * kinds moderatedThread hides on (report/mute-list). Shared with the snapshot's
   * storeVersions.thread so MainScreen's threadNodes memo keys on the EXACT signal the thread build
   * actually reads, instead of `feed` (which churns on every reaction/DM/read-state emit — A2). A
   * post/comment/report/mute-list write on the open thread bumps it; unrelated firehose churn (likes,
   * DMs, read-state, profiles) does not, so an open thread stops rebuilding on every background emit.
   */
  private static readonly THREAD_VIEW_KINDS: readonly number[] = [
    Kind.Post,
    Kind.Comment,
    Kind.Report,
    Kind.MuteList,
  ];

  /**
   * Everything a draft's access state is derived from (Phase 5§D) — the scoped signal behind
   * `AppSnapshot.storeVersions.draftAccess`. `AppData` is in here because the owner's grant/revoke
   * doc (`draft-access:<draftId>`) rides kind-30078; that makes this counter move on unrelated
   * AppData writes too, which is the correct direction to err (a redundant re-check costs one cheap
   * derive; a MISSED one leaves an approved reader staring at the teaser).
   */
  private static readonly DRAFT_ACCESS_VIEW_KINDS: readonly number[] = [
    Kind.DraftAccessRequest,
    Kind.DraftDelivery,
    Kind.AppData,
  ];

  /**
   * Pending refreshInbox coalescing timer. A burst of incoming gift wraps triggers one
   * refreshInbox per wrap (each adds to seenWrapIds and calls buildConversations). We coalesce
   * them into a single call within a 250 ms window. The decrypt cache (decryptedWraps /
   * seenWrapIds) is intact: the first wrap is NOT immediately processed — it is scheduled; if more
   * arrive within 250 ms they collapse into one refreshInbox call that processes them all at once.
   * User-initiated paths (sendDM) call refreshInbox directly and bypass this timer.
   */
  private _refreshInboxTimer: ReturnType<typeof setTimeout> | undefined;

  /** Debounce window for the coalesced sent-DM / failed-wrap persists (finding #4/#5). */
  private static readonly DM_PERSIST_DEBOUNCE_MS = 400;
  private _sentDmsDirty = false;
  private _sentDmsTimer: ReturnType<typeof setTimeout> | undefined;

  /** Last snapshot handed out — returned as-is while a community switch is mid-flight (see getSnapshot). */
  private _lastSnapshot: AppSnapshot | undefined;

  /**
   * The negotiated view of what the relay actually enforces (NIP-11 + stiq-capabilities). Starts as
   * the constant-derived fallback (behaviour == today's build constants) and is refreshed once per
   * relay (re)connect from onRelayConnected; a failed fetch keeps the last-known/fallback value.
   */
  private _relayCaps: RelayCapabilities = defaultRelayCapabilities();

  /**
   * STICKY enforcement flags for the ACTIVE community — the union of every enforcement field the
   * relay has EXPLICITLY advertised, this session or any earlier one (persisted per cid, reloaded
   * by loadWorkspaceState). Overlaid on top of whatever `_relayCaps` currently holds by
   * {@link applyStickyEnforcement}, so the windows where `_relayCaps` is only the constant
   * fallback — a cold start before the first NIP-11 fetch lands, a community switch's reset, or a
   * connect whose capability fetch failed — can no longer downgrade a known-enforcing community to
   * "tokens not required" and manufacture token-less space writes (the 2026-07-28 "out of tokens"
   * field bug's confirmed enabler). Only an explicit fresh advertisement (explicitEnforcedFlags)
   * ever CHANGES a field here, in either direction; absence never does. Reset alongside
   * `_relayCaps` on a community switch — each community's own persisted flags reload after the
   * swap, so nothing bleeds across communities.
   */
  private _stickyEnforced: Partial<EnforcedFlags> = {};

  /**
   * Re-assert the sticky enforcement flags over the current `_relayCaps` (and re-derive the
   * weight-pricing rate from the merged view). Called wherever `_relayCaps` is (re)assigned from a
   * source that may know LESS than the community's persisted record: the per-workspace sticky
   * reload, and every caps re-negotiation. Safe to call with an empty sticky set — a pure no-op
   * overlay, byte-identical behaviour.
   */
  private applyStickyEnforcement(): void {
    this._relayCaps = {
      ...this._relayCaps,
      enforcedFlags: {...this._relayCaps.enforcedFlags, ...this._stickyEnforced},
    };
    setBytesPerToken(this._relayCaps.enforcedFlags.bytesPerToken);
  }

  /** User-facing message when the active community's keys don't match the relay's advertised
   *  fingerprints (C5). Kept as one constant so the pre-check (feedSigner) and any future surface
   *  read the same wording. */
  private static readonly COMMUNITY_MISPROVISIONED = 'community mis-provisioned — update your invite';

  constructor(private readonly deps: AppRuntimeDeps) {
    this.outbox = new Outbox(deps.secureStorage);
    this.drafts = new DraftStore(deps.secureStorage);
    this.eventDrafts = new EventDraftStore(deps.secureStorage, '');
    this.displayNames = new DisplayNameStore(deps.secureStorage);
    this.gradients = new GradientStore(deps.secureStorage);
    this.mediaSettings = new MediaSettingsStore(deps.secureStorage);
    this.pictureAllowance = new PictureAllowanceStore(deps.secureStorage);
    this.torSettings = new TorSettingsStore(deps.secureStorage);
    this.browserSettings = new BrowserSettingsStore(deps.secureStorage);
    // Wire private-space E2E keys to the hardware-backed secure storage (secrets — never AsyncStorage).
    // No-op when storage is absent (builds without the native keystore): private spaces just can't decrypt.
    // The per-account namespace is bound later in rebuildIdentity, once the active slot is resolved.
    setSpaceKeyStorage(deps.secureStorage);
    // Wire the content-epoch key store (C7 read meter) to the same hardware-backed secure storage.
    // Safe to do UNCONDITIONALLY and independent of the caps flag: it merely enables PERSISTENCE of
    // keys that are only ever populated by unlockContentEpoch, which is itself gated on the caps flag.
    // Until then nothing writes a content key, so this changes nothing (ships dark). The per-account
    // namespace is applied later via loadContentKeys(slotId) once the active slot is resolved.
    setContentKeyStorage(deps.secureStorage);
    // Render → runtime unlock seam: any surface that meets a sealed body (comment thread, embed
    // card, pinned note, moderation snippet) requests its epoch's background unlock through the
    // unlockState module instead of a prop chain; all requests land in the ONE deduped/backoff
    // state machine. Latest runtime wins the registration (community switch rebuilds runtimes).
    registerEpochUnlockRequester(epoch => this.noteLockedEpochs([epoch]));
    // Tap-to-retry seam (the terminal `unlockUnavailable` card): a SEPARATE registration from the
    // silent one above, so an explicit tap can reset a backed-off epoch's attempt count while the
    // silent per-render kick above never disturbs a slow organizer-refusal backoff on its own.
    registerEpochUnlockRetryRequester(epoch => this.retryEpochUnlock(epoch));
    this.autolock = new AutoLock(deps.autoLockMs);
    this.autolock.onChange(state => {
      // Unlock lifts the heavy-build gate: the user is now in, so this very emit must render the real
      // feed (a locked snapshot withholds it). On device the deferred macrotask has usually cleared
      // this already; clearing it here also covers the unlock-before-macrotask ordering (and the
      // fake-timer test path, where that macrotask has not run).
      if (state === 'unlocked') this._deferHeavy = false;
      this.emit();
    });

    if (deps.secureStorage) {
      this.identity = new Identity(deps.secureStorage);
      // Blind-posting wallet + signer. contentSigner falls back to plain npub signing until a
      // community key is loaded, so this changes nothing until a community opts into blind posting.
      this.wallet = new EpochWallet(deps.secureStorage);
      // The six auxiliary budgets (read / four media / space-write, T4.2 TokenPool — all ship dark).
      // Rebound per-slot in rebuildIdentity in lock-step with the posting wallet; each purpose only
      // ever drawn/spent once its own gate opens (content_encryption / media domain / space tokens).
      this.tokenPool = new TokenPool(deps.secureStorage);
      this.identity.setPreSignHook(unsigned => this.spaceTokenTagsFor(unsigned));
      this.contentSigner = new BlindSigner(
        this.identity,
        this.wallet,
        u => this.routeMediaToken(u),
        () => this.sealRequiredNow(),
      );
      this.pins = new PinVault(deps.secureStorage, deps.hash);
      this.communities = new CommunityStore(deps.secureStorage);
      this.keyRing = new KeyRing(deps.secureStorage);

      // Both the duress-PIN path and the Settings emergency kill switch (wipeAllData) run the SAME
      // full wipe via duressWipeTargets(), so they can never drift (security findings #8/#10/#18).
      this.lockController = new LockController(this.pins, this.autolock, () =>
        performDuressWipe(this.duressWipeTargets()),
      );
    } else {
      this.identity = null;
      this.pins = null;
      this.communities = null;
      this.keyRing = null;
      this.lockController = null;
    }
  }

  /**
   * Read persisted state (enrollment + outbox) and publish the first snapshot.
   *
   * Idempotent/reentrant-safe (see `_initPromise`/`_initSucceeded` above): an init already in flight
   * is deduped to the SAME promise; a completed success makes a repeat call a no-op; a completed
   * FAILURE clears the guard so a fresh call actually re-runs the body. This method itself does not
   * change what a single init does — it only decides whether `_doInit()` runs at all.
   *
   * Deliberately NOT `async`: an `async` method would wrap every call's return in a brand-new Promise
   * object even when delegating to `_initPromise`, so two overlapping callers (App.tsx's Retry calling
   * init() again while the original is still in flight) would each get a distinct-but-equivalent
   * promise instead of the literal same one. Returning `_initPromise` directly keeps them identical.
   */
  init(): Promise<void> {
    if (this._initSucceeded) {
      return Promise.resolve(); // already live — re-running would redo migrations/hydration/emits
    }
    if (this._initPromise) {
      return this._initPromise; // in-flight — dedupe callers onto the one real run
    }
    this._initPromise = this._doInit()
      .then(() => {
        this._initSucceeded = true;
      })
      .finally(() => {
        this._initPromise = null;
      });
    return this._initPromise;
  }

  /** The actual init body (see `init()` for the reentrancy guard wrapping this). */
  private async _doInit(): Promise<void> {
    // Defer the heavy feed/channels/moderation build off the splash critical path: every snapshot
    // emitted DURING init resolves its store-derived fields empty (see getSnapshot), so init's first
    // emit hands off to the splash without synchronously parsing the whole cached history behind it.
    // scheduleDeferredHeavy() below lifts this on the next macrotask (after init resolves).
    this._deferHeavy = true;
    // Migrate a pre-silo single-community install into the per-community slot model, THEN re-key the
    // identity-bound state (wallet/outbox/groups/spaces/space-keys/content-keys/picture-spend) from
    // per-community/global into the per-account (slot) namespace. Both are idempotent + copy-not-move,
    // so this is safe on every launch and no-ops after the first run.
    if (this.deps.secureStorage && this.keyRing && this.communities) {
      // Fold the three migration-flag reads into ONE multiGet (audit finding #2 hygiene) instead of
      // three serial getItem round-trips — every launch forever after the first hits each function's
      // "already migrated" fast return, so this collapses that steady-state cost 3→1 round-trips.
      const migrationFlags = await preflightMigrationFlags(this.deps.secureStorage);
      await migrateToSlots(this.deps.secureStorage, this.keyRing, this.communities, migrationFlags);
      await migrateCidToSlot(this.deps.secureStorage, this.keyRing, migrationFlags);
      // Finding #4: drop the orphaned pre-per-account per-cid event store now that the cache is
      // per-(cid, account). No content copy — each account re-syncs into its own fresh file.
      await migrateWipeLegacyCidStores(this.deps.secureStorage, this.keyRing, migrationFlags);
    }
    // Resolve which identity slot + community are active and bind the Identity to that slot's key.
    await this.resolveActiveNamespace();
    this.rebuildIdentity();

    // Finding #2 (audit P2 — phase-split init): on a genuinely FRESH install (no legacy key, no
    // migrated slot, nothing ever enrolled) there is nothing under the active namespace to hydrate
    // FOR yet. Read just this one cheap signal to tell that case apart from a real account, and take
    // a FAST PATH that paints the onboarding/lock UI immediately instead of paying for a SQLCipher
    // open + ~25 more serial keystore reads for state that doesn't exist. This is the SAME
    // isEnrolled() read loadWorkspaceState() would otherwise do first (its "enrolled must resolve
    // FIRST" comment below) — threading it through the ENROLLED branch means that path pays for it
    // exactly once, not twice.
    const earlyEnrolled = this.identity ? await this.identity.isEnrolled() : false;

    if (!earlyEnrolled) {
      this.enrolled = false;
      this.pinEnabled = await loadPinEnabled();
      // Skip swapActiveStore()/createEncryptedEventStore ENTIRELY here: opening (or minting a fresh
      // key for) a SQLCipher DB has nothing to cache pre-account — the event cache is never migrated
      // forward (migrateWipeLegacyCidStores above drops the orphaned legacy file outright) and no
      // relay is even known before a community is joined. completeEnrollment() runs its OWN real
      // swapActiveStore()+loadWorkspaceState() the moment the user actually enrolls (see its call
      // site), so the store simply stays the constructor's in-memory default for onboarding.
      //
      // Emit the first snapshot IMMEDIATELY. buildIdleSnapshot() (still gated by the _deferHeavy set
      // above) never touches the store, so this is safe before anything below even starts.
      this.emit();
      // Phase 2, fire-and-forget — same pattern refreshInbox() already uses below: device-wide
      // settings + workspace hydration run in the BACKGROUND instead of blocking the splash.
      //
      // `phase2Gen` guards against a real enrollment (or a teardown) completing WHILE this is still
      // in flight: completeEnrollment() bumps `_initPhase2Gen` and then runs its OWN real
      // swapActiveStore()+loadWorkspaceState() against the freshly-minted slot, so a stale phase-2
      // re-running loadWorkspaceState()/emit() afterwards would at best redundantly redo that work
      // against whatever is now active, and at worst race it. Checked before every side-effecting
      // step below; superseded → bail without touching anything (mirrors the _scorePassGen/
      // _switchWarmGen idiom used for the analogous community-switch/dispose race elsewhere in this
      // class). Never rejects — the tail's `finally` always runs scheduleDeferredHeavy (when not
      // superseded) so a failure here can't strand the app on the idle snapshot.
      const phase2Gen = this._initPhase2Gen;
      // App.tsx's cold cascade starts from init().finally() and reads getTorConnectionPrefs()
      // SYNCHRONOUSLY the instant this promise resolves — it does not wait for phase 2 below. So
      // torSettings.load() (the call that populates that accessor) is hoisted out of the Promise.all
      // and awaited HERE, before the un-enrolled return, guaranteeing a preset picked mid-onboarding
      // is live before the first cold cascade ever reads it. It's one cheap single-key read (see
      // TorSettingsStore.load) — worth promoting on its own; the rest of phase 2 stays backgrounded.
      // The same promise is reused in the Promise.all below so it is never loaded twice.
      const torSettingsReady = this.torSettings.load();
      await torSettingsReady;
      this._initPhase2Ready = (async (): Promise<void> => {
        try {
          await Promise.all([
            this.mediaSettings.load(),
            torSettingsReady,
            this.browserSettings.load(),
            ensurePrefsLoaded(),
          ]);
          if (this._initPhase2Gen !== phase2Gen) return; // superseded — completeEnrollment()/dispose() own it now
          await this.loadWorkspaceState();
          if (this._initPhase2Gen !== phase2Gen) return; // superseded mid-hydration — its own emit is newer
          this.emit();
          if (this.enrolled) {
            this._inboxReady = this.refreshInbox();
            void this._inboxReady;
          }
        } catch (e) {
          log.error('init-phase2', e);
        } finally {
          if (this._initPhase2Gen === phase2Gen) {
            this._attributionWarmupReady = this.warmColdStartAttribution().finally(() => this.scheduleDeferredHeavy());
            void this._attributionWarmupReady;
            this.schedulePrewarmWhileLocked();
          }
        }
      })();
      void this._initPhase2Ready;
      return;
    }

    // ENROLLED path — byte-for-byte unchanged from before this fix, aside from reusing
    // `earlyEnrolled` so loadWorkspaceState() below doesn't re-read isEnrolled() a second time.
    //
    // Device-wide settings (NOT siloed — see workspaceKeys.ts): five independent keystore/AsyncStorage
    // reads, each writing a disjoint accessor, with no cross-dependency. Load them concurrently rather
    // than as serial awaits so they dispatch back-to-back instead of stalling the JS thread between each.
    // (The per-account picture-allowance spend is loaded inside loadWorkspaceState instead — it needs the
    // active slot id + the community's finalised pictureRules.periodHours.)
    //
    // Open the active community's own event store CONCURRENTLY with those reads: swapActiveStore()'s
    // SQLCipher open needs only the namespace resolved above, and the settings loads touch neither the
    // store nor one another — so the store handle comes up in parallel instead of after the serial
    // setting reads. loadWorkspaceState() (which reads from the store) runs only once BOTH have
    // settled, preserving the required namespace→swap→hydrate order.
    await Promise.all([
      this.swapActiveStore(),
      loadPinEnabled().then(v => { this.pinEnabled = v; }),
      this.mediaSettings.load(),
      this.torSettings.load(),
      this.browserSettings.load(),
      // Notification prefs + the center's read state are device-wide (not siloed per
      // community/identity — same tier as the settings above), so warm both here.
      // Notification PREFERENCES (notify-on-DM etc.) are device-wide. The mute list + high-water marks
      // + read/seen + center read-state are namespaced PER ACCOUNT (finding D1) and warmed inside
      // loadWorkspaceState() via setNotificationAccount(activeSlotId), so they are NOT loaded here.
      ensurePrefsLoaded(),
    ]);

    // Hydrate every per-community/per-identity store under the active namespace.
    await this.loadWorkspaceState(earlyEnrolled);

    // Emit the first snapshot IMMEDIATELY — do NOT block it on the historical DM decrypt (finding #1).
    // A large persisted gift-wrap backlog is seconds of pure-JS ECDH on the single Hermes thread; the
    // feed/lock/onboarding UI must not wait for it. refreshInbox chunks the decrypt, yields between
    // chunks, and re-emits as conversations materialise, so DMs stream in shortly after the app is
    // interactive. The returned promise is retained so shutdown/tests can await full completion.
    this.emit();
    if (this.enrolled) {
      this._inboxReady = this.refreshInbox();
      void this._inboxReady;
    }
    // Cold-start hydration bypasses RelayClient's paced ingest drain entirely — the persisted SQLite
    // history loadWorkspaceState() just hydrated is ALREADY sitting in the store, never having passed
    // through onIngestEvent's per-event warmup (see RelayClient/blind/identity.ts). So warm the blind-
    // attribution resolver cache over it here too, in its own bounded + yielding chunk pass
    // (warmAuthorResolutionCold — mirrors refreshInbox's chunked DM decrypt above), BEFORE lifting
    // _deferHeavy: this makes the first real buildFeed's synchronous resolveAuthor calls more likely
    // cache hits instead of paying hundreds of NIP-44 decrypts + schnorr verifies inside one frozen
    // macrotask. `finally` guarantees scheduleDeferredHeavy always still runs — a warmup failure (or
    // simply the cap being hit on a very large store) can never strand the app on the idle snapshot;
    // buildFeed's own resolveAuthor calls stay exactly as correct on anything left unwarmed.
    this._attributionWarmupReady = this.warmColdStartAttribution().finally(() => this.scheduleDeferredHeavy());
    void this._attributionWarmupReady;
    // While the user sits on the lock screen, warm the structural feed buckets so the first unlock is
    // a fast warm-RAM rebuild instead of a cold SQLite SELECT+parse (post-PIN latency). Guarded to
    // the enrolled+PIN+locked case; best-effort and lock-safe (warms buckets only — see the method).
    this.schedulePrewarmWhileLocked();
  }

  /** Resolves once the cold-start attribution-cache warmup pass kicked off by `_doInit` has finished
   *  (or given up). Tests await this to observe the complete warmup; normal UI does not need to. */
  private _attributionWarmupReady: Promise<void> = Promise.resolve();

  /** Await the in-flight (or last) cold-start attribution warmup kicked off by init(). */
  whenAttributionWarmupReady(): Promise<void> {
    return this._attributionWarmupReady;
  }

  /**
   * While the app sits on the lock screen (enrolled + PIN on + locked), pre-warm the structural feed
   * buckets so the FIRST post-unlock getSnapshot is a warm-RAM rebuild rather than a cold SQLite
   * SELECT + JSON.parse of thousands of rows — a big slice of the "lag between entering the PIN and
   * the feed appearing".
   *
   * ONE KIND PER MACROTASK, yielding between them: warming every structural kind in a SINGLE
   * store.query() would parse up to thousands of rows per kind in one uninterrupted macrotask, and
   * because it fires ~PREWARM_DELAY_MS after boot that block would land right as the user is tapping
   * their PIN — freezing the keypad (the exact transient jank we're trying to kill). Spreading it one
   * kind per macrotask keeps each parse short and lets queued key taps run in between. Each per-kind
   * warm is a synchronous, atomic warmKind (via query), so there is no mid-warm delete race.
   * (Chunking WITHIN a single very large kind is a possible further refinement, deferred until
   * on-device profiling shows one bucket is still a frame-buster — it needs a yielding store-level
   * warm with a delete-race guard.)
   *
   * SAFE while locked: store.query() only warms the in-RAM event mirror (warmKind = SELECT+parse),
   * the SAME at-rest event category that ingest — which is NOT lock-gated — already reads/writes
   * against the already-open, already-keyed SQLCipher DB. It builds NO FeedItems, decrypts NO DM gift
   * wraps, and emits NOTHING, so it cannot lift the lock's render gate (getSnapshot stays lock-gated,
   * returning the idle snapshot) and reveals nothing on screen. kind-7 is excluded from the sync
   * per-kind loop (see PREWARM_KINDS) but is chunk-warmed LAST via warmReactionBucketChunked, so even
   * the largest bucket is ready by unlock without ever parsing in one macrotask. A duress wipe's
   * store.clear() already purges these warmed buckets (it clears the
   * _warm set), so no duress-specific handling is needed — the pre-warm is also PIN-agnostic (it runs
   * before any PIN is entered), so it adds no real-vs-duress timing tell.
   */
  private schedulePrewarmWhileLocked(): void {
    if (!this.enrolled || !this.pinEnabled) return; // no lock screen → the real unlock build warms it
    if (this.autolock.getState() !== 'locked') return; // first-run / PIN-off lands unlocked
    const kinds = [...AppRuntime.PREWARM_KINDS];
    let i = 0;
    const warmNext = (): void => {
      // Bail the moment the user unlocks — the real build then warms whatever's left (no regression).
      if (this.autolock.getState() !== 'locked') return;
      if (i >= kinds.length) {
        // Structural buckets done — LAST (lowest priority), chunk-warm the kind-7 reaction bucket
        // too, so the post-unlock scored pass finds it already in RAM instead of paying its parse
        // then. Chunked + yielding (never one macrotask), and it coalesces with the scored pass's
        // own warm if the user unlocks mid-warm. Excluded from PREWARM_KINDS on purpose: the sync
        // per-kind warm above must never pay the largest bucket's one-shot parse during PIN entry.
        void this.warmReactionBucketChunked();
        return;
      }
      const k = kinds[i++]!;
      try {
        this.deps.store.query({kinds: [k]});
      } catch {
        // Best-effort: a failed warm just means the post-unlock build pays that kind's parse as today.
      }
      const next = setTimeout(warmNext, 0); // yield so a key tap can run before the next bucket
      (next as unknown as {unref?: () => void}).unref?.();
    };
    const t0 = setTimeout(warmNext, AppRuntime.PREWARM_DELAY_MS);
    (t0 as unknown as {unref?: () => void}).unref?.();
  }

  /**
   * Best-effort cache warmup for the blind-attribution resolver over the just-hydrated store (see
   * `_doInit`'s call site for why this exists and `warmAuthorResolutionCold` for the chunking). Never
   * throws — a failure here must never prevent `scheduleDeferredHeavy` (chained via the caller's
   * `finally`) from running.
   */
  private async warmColdStartAttribution(): Promise<void> {
    if (!this.enrolled) return;
    try {
      const events = this.deps.store.query({kinds: FEED_KINDS});
      await warmAuthorResolutionCold(events);
    } catch {
      // best-effort only — scheduleDeferredHeavy still runs via the caller's `finally`
    }
  }

  /**
   * Lift the splash-handoff heavy-build gate on the next macrotask (setTimeout 0), then emit so the
   * real feed/channels/moderation build runs AFTER init resolves and the splash has handed off. Idempotent.
   */
  private scheduleDeferredHeavy(): void {
    if (this._deferHeavyTimer !== undefined) return;
    // Best-effort, like every other link in this fire-and-forget chain (warmColdStartAttribution's
    // own doc comment: "never throws"): this runs from a `.finally()` that init() never awaits
    // (`void this._attributionWarmupReady`), so a throw here would surface as an unhandled rejection
    // with no relation to whatever the host is doing by the time it lands — e.g. a torn-down test
    // harness whose global `setTimeout` no longer exists. Never let that escape.
    try {
      this._deferHeavyTimer = setTimeout(() => {
        this._deferHeavyTimer = undefined;
        this._deferHeavy = false;
        this.emit();
      }, 0);
      // Don't let this off-critical-path handoff keep the process alive (mirrors scheduleRetentionPrune).
      (this._deferHeavyTimer as unknown as {unref?: () => void}).unref?.();
    } catch {
      // best-effort — see above
    }
  }

  /**
   * Resolves once init()'s fire-and-forget PHASE 2 (audit finding #2's un-enrolled fast path —
   * device-wide settings + loadWorkspaceState + the attribution warmup tail) has finished. Stays the
   * already-resolved default on the ENROLLED path, which has no separate phase 2 — everything runs
   * before init()'s own promise settles there, exactly as before this fix. Tests await this to
   * observe the un-enrolled fast path's background work complete; normal UI does not need to.
   */
  private _initPhase2Ready: Promise<void> = Promise.resolve();

  /**
   * Generation guard for the un-enrolled fast path's fire-and-forget phase 2 (mirrors
   * `_scorePassGen`/`_switchWarmGen`). Bumped by `completeEnrollment()` and `dispose()` — either
   * means a stale phase 2 must stop touching this runtime instead of racing the real
   * enrollment/teardown. Captured once at phase-2 kickoff; a mismatch at any checkpoint means
   * "superseded", so phase 2 bails without emitting or scheduling anything further.
   */
  private _initPhase2Gen = 0;

  /** Await the un-enrolled fast path's fire-and-forget init phase 2, kicked off by init(). */
  whenInitPhase2Ready(): Promise<void> {
    return this._initPhase2Ready;
  }

  /** Resolves when the most recently kicked-off historical DM decrypt has fully drained. Tests and
   *  the shutdown path await this to observe the complete inbox; normal UI does not need to. */
  private _inboxReady: Promise<void> = Promise.resolve();

  /** Await the in-flight (or last) historical inbox decrypt kicked off by init()/activateWorkspace(). */
  whenInboxReady(): Promise<void> {
    return this._inboxReady;
  }

  /** Read the active KeyRing slot id + community id into the in-memory namespace pointers. */
  private async resolveActiveNamespace(): Promise<void> {
    this.activeSlotId = (await this.keyRing?.getActiveSlotId()) ?? undefined;
    this.activeCid = (await this.communities?.activeId()) ?? undefined;
  }

  /** (Re)bind the Identity to the active slot's namespaced key + credential (or legacy when none). */
  private rebuildIdentity(): void {
    this.identity = this.deps.secureStorage
      ? new Identity(this.deps.secureStorage, this.activeSlotId)
      : null;
    // The blind-token wallet is PER-ACCOUNT (identity slot): each token is blind-signed by a specific
    // community's issuer and is valid ONLY at that community's relay, and TWO accounts in the SAME
    // community must not share a token pool (one account draining or suppressing the other). Rebind the
    // wallet to the active slot in lock-step with the identity, so a switch/enroll never (a) spends
    // account A's tokens on account B's post — B's relay would reject the wrong-credential token — nor
    // (b) lets A's balance suppress B's own low-watermark top-up (leaving B unable to post blind). A
    // pre-silo/un-enrolled wallet (namespace '') is simply re-drawn on the next relay connect.
    //
    // The wallet is ALSO siloed to one issuer key: its posting-key fingerprint is bound just below in
    // loadActiveCommunityPolicy (the single point where the active community's posting key is resolved),
    // NOT here — passing a possibly-stale in-memory fingerprint during a switch would wrongly wipe the
    // incoming account's fresh tokens. Until then it stays unbound (reconciliation off), which is safe
    // because nothing spends between here and loadWorkspaceState.
    this.wallet = this.deps.secureStorage
      ? new EpochWallet(this.deps.secureStorage, this.activeSlotId ?? '')
      : null;
    // The six auxiliary budgets (read / four media / space-write) are per-account for the same
    // reasons; rebind the whole pool to the active slot in lock-step. Their per-purpose issuer-key
    // fingerprints are bound later in loadActiveCommunityPolicy.
    this.tokenPool = this.deps.secureStorage
      ? new TokenPool(this.deps.secureStorage, this.activeSlotId ?? '')
      : null;
    // Bind the private-space E2E key store to the active ACCOUNT too, so store/load/hydrate of space
    // keys read the current slot's namespace — an account never decrypts a private space that a sibling
    // account (or a prior identity) joined. Cleared to the legacy layout when un-enrolled.
    setSpaceKeyNamespace(this.activeSlotId);
    // The blind content signer wraps the CURRENT identity + wallet; rebuild it in lock-step so a slot
    // swap (enrollment / community switch) never leaves it signing with a stale, wrong-slot identity
    // (which would read no key → "no key enrolled" on the next post) or spending the wrong wallet.
    this.contentSigner =
      this.identity && this.wallet
        ? new BlindSigner(
            this.identity,
            this.wallet,
            u => this.routeMediaToken(u),
            () => this.sealRequiredNow(),
          )
        : null;
    // Install the space-token pre-sign hook on the fresh identity (tokens-everywhere, dark). Bound
    // in lock-step so a slot swap never leaves it spending the wrong slot's space wallet. The hook
    // returns null for every non-space kind and whenever enforcement is off, so signing is unchanged
    // until an operator flips space_tokens_required.
    this.identity?.setPreSignHook(unsigned => this.spaceTokenTagsFor(unsigned));
  }

  /**
   * Point the SwappableEventStore at the active ACCOUNT's own encrypted DB (per-(cid, slot), finding
   * #4). No-op unless a `createStore` factory is wired AND `deps.store` is swappable — tests and
   * pre-native builds pass a plain store and use it as-is. Ordering is already safe: init() resolves
   * the namespace before this runs, and activateWorkspace/completeEnrollment set activeSlotId +
   * activeCid before calling it — so an intra-community IDENTITY switch now opens a DIFFERENT file
   * instead of a no-op.
   */
  private async swapActiveStore(): Promise<void> {
    const {createStore, store} = this.deps;
    if (createStore && store instanceof SwappableEventStore) {
      // Build the incoming store BEFORE touching the live one, so a factory failure leaves the
      // current store active. Then close the outgoing inner to release its native op-sqlite
      // (SQLCipher) handle — without this, every community switch leaked a connection.
      const previous = store.current as {close?: () => void};
      store.setInner(await createStore(this.activeCid ?? null, this.activeSlotId ?? null));
      previous.close?.();
    }
  }

  /**
   * Hydrate every per-community / per-identity store under the CURRENT active namespace
   * (`activeSlotId` / `activeCid`). Shared by init() and by activateWorkspace() after a switch, so a
   * switch reloads exactly what a cold start would for the target community — nothing carries over.
   */
  private async loadWorkspaceState(knownEnrolled?: boolean): Promise<void> {
    const slotId = this.activeSlotId;
    const cid = this.activeCid;
    // enrolled must resolve FIRST — loadPubkey() below guards on this.enrolled. `knownEnrolled` lets
    // a caller that already paid for this exact isEnrolled() read (init()'s early phase-split gate)
    // pass it through instead of reading it again; every other caller (switch, resume) omits it and
    // this reads fresh exactly as before.
    this.enrolled = knownEnrolled ?? (this.identity ? await this.identity.isEnrolled() : false);
    // drafts.reload is synchronous (no keystore await) and order-free — fire it now.
    this.drafts.reload(slotId);
    this.eventDrafts.reload(slotId ?? '');
    // Events state (my RSVPs + host decisions) is per-slot: clear the outgoing account's records
    // before hydratePerSlotSecureReads re-reads this slot's own (session folds rebuild from DMs).
    this.myEventRsvps.clear();
    this.eventDecisions.clear();
    this.eventApplications.clear();
    this.eventWaitlists.clear();
    // Point ALL notification state (mutes + HWM + read/seen + center read-state) at THIS account and
    // reload it, so two identities on one device never share notification state (finding D1). Runs on
    // init AND on every switch (activateWorkspace → loadWorkspaceState), mirroring drafts.reload(slotId).
    await setNotificationAccount(slotId);
    // Log-tab member prefs (the tucked-note dismissals + mod-log layout) switch and eagerly load
    // here too — the runtime owns per-account state switching, and the eager load is what lets the
    // Log tab read the tucked state synchronously on its very first paint (no flash — STATES §2).
    setLogPagePrefsSlot(slotId);
    await ensureLogPagePrefsLoaded();
    // Dock prefs (default tab + collapsed/expanded bubble state) follow the same contract: switch
    // the slot + eager-load so MainScreen's initial tab and the dock's first paint read the
    // persisted state synchronously — no flash of the wrong tab or a wrongly-open dock.
    setDockPrefsSlot(slotId);
    await ensureDockPrefsLoaded();
    // Feed sort (Rising/New) follows the same contract: switch the slot + eager-load so MainScreen's
    // sort bar reads the remembered choice synchronously on its very first paint — no flash of the
    // default 'new' before the stored value loads (the async in-component load this replaces did
    // flash, presenting as "the app forgot my sort" on a cold, contended start).
    setFeedSortPrefsSlot(slotId);
    await ensureFeedSortPrefsLoaded();
    // Local join stamps — eager-loaded here so the Spaces list reads them synchronously on its very
    // first paint (the row builder is a sync useMemo and cannot await storage).
    setSpaceJoinedAtSlot(slotId);
    await ensureSpaceJoinedAtLoaded();
    // Per-(account, community) first-entry signal — eager-loaded here so MainScreen's initial tab and
    // getLogPage's welcome window read it synchronously on first paint (Points 1/6/7). The ENTRY
    // itself is recorded only by enroll() (a genuine join), never by a cold start or a switch, so an
    // already-joined member reads firstEnteredAt()=0 and every first-run behavior is a clean no-op.
    setCommunityEntrySlot(slotId, cid);
    await ensureCommunityEntryLoaded();
    // The remaining ~11 hydrations read disjoint keystore keys into disjoint in-memory fields, so run
    // them concurrently instead of as a serial await chain (the splash is held for this whole block via
    // init()'s first emit()). Two real ordering constraints are preserved:
    //   • enrolled (above) resolves before loadPubkey();
    //   • outbox.reload() completes before loadSentMessages() — it reconciles a still-'sending' echo
    //     against this.outbox.has() (see loadSentMessages).
    // Under old-arch RN the native decrypts still dispatch one-at-a-time, but this removes the per-read
    // JS await/microtask gaps and lets them run back-to-back. No security/ordering semantics change —
    // same keys, same values, same identity/wallet already rebound above.
    await Promise.all([
      this.loadPubkey(),
      // Load the active community policy, THEN reload this ACCOUNT's picture-allowance spend under the
      // now-finalised period + the slot namespace. Chained (not a sibling of the Promise.all) so it sees
      // the community's real pictureRules.periodHours rather than racing loadActiveCommunityPolicy, and
      // so switching accounts never leaves the previous account's spend in the module accessor.
      this.loadActiveCommunityPolicy().then(() =>
        this.pictureAllowance.load(this.pictureRules.periodHours, slotId),
      ),
      this.displayNames.reload(slotId, cid),
      this.gradients.reload(slotId, cid),
      reloadBlocklistFor(slotId),
      // Local, device-only feed author-mute set (per ACCOUNT). Purely local — never published.
      this.loadMutedAuthors(slotId),
      // Batch the three plain single-key per-slot secure reads (identityAt / DM-reactions /
      // failed-wraps) into ONE native round-trip via multiGet, then run each hydration's parse
      // verbatim (see hydratePerSlotSecureReads) — collapsing three serial bridge hops into one.
      this.hydratePerSlotSecureReads(),
      // Joined groups are per-ACCOUNT (slot) namespaced (security-audit siloing), not per-community.
      loadJoinedGroups(slotId).then(g => { this.joinedGroups = new Set(g); }),
      // My outstanding join requests + dismissed invites (membership handoff) — same slot siloing.
      loadMyJoinRequests(slotId).then(m => { this.myJoinRequests = m; }),
      loadDismissedInvites(slotId).then(m => { this.dismissedInvites = new Map(Object.entries(m)); }),
      // Which (space, member) pairs this admin device has already keyed (30079) — the dedupe
      // behind the member-arrival key backfill, persisted so cold starts don't re-deliver.
      loadDeliveredSpaceKeys(slotId).then(m => { this._deliveredKeyTo = new Map(Object.entries(m)); }),
      // Sticky enforcement flags for THIS community (per cid): what its relay has ever explicitly
      // advertised as enforced. Merged UNDER any explicit flags a fetch already negotiated this
      // session (current values win — an explicit fresh doc is always newer than the disk record),
      // then overlaid onto _relayCaps so the pre-first-fetch window already attaches space tokens
      // for a community known to require them (the 2026-07-28 caps-fallback split-brain fix).
      loadStickyEnforcement(cid ?? undefined).then(s => {
        this._stickyEnforced = {...s, ...this._stickyEnforced};
        this.applyStickyEnforcement();
      }),
      // Draft-access requests I've silently denied (Phase 5§D) — same per-slot siloing; see
      // denyDraftAccess/getDraftAccessQueue.
      loadDeniedDraftAccess(slotId).then(m => { this._draftAccessDenied = m; }),
      // Hydrate the LOCAL "spaces I treat as encrypted" set so isEncryptedSpace() is synchronous and
      // outgoingSeal is fail-closed from the first render — independent of the relay's 39000.
      loadEncryptedSpaces(slotId),
      this.outbox.reload(slotId).then(() => this.loadSentMessages()),
    ]);
    // Fresh conversation-key cache for the newly-active identity (finding #2). A slot's keys never
    // decrypt another slot's DMs, so it starts empty here and is repopulated as wraps decrypt.
    this.convKeyCache = this.identity ? this.identity.newConversationKeyCache() : undefined;
    // Rehydrate this account's durable post recovery queue (persisted per-slot) so a post that failed
    // to sign (token-exhausted) survives a restart / switch-away and shows again with Retry, then is
    // auto-drained on the next reconnect / pull-to-refresh. AFTER the displayNames/gradients reload
    // above so its re-rendered placeholder header is this account's. Un-enrolled (no slot) → no-op.
    await this.loadPendingCompose(slotId);
  }

  /**
   * Hydrate the three plain single-key per-slot secure reads — identityAt, DM reactions, and the
   * failed-wrap negative cache — with ONE batched multiGet instead of three serial getItem bridge
   * hops (init issues these on the native single-thread executor, where each hop is a serialized
   * round-trip). Each raw value is handed to the SAME parse/normalize the individual loaders used, so
   * the end state is identical; only the number of native round-trips changes. On a stale native
   * binary or the test mock (no multiGet), the helper transparently falls back to per-key getItem.
   */
  private async hydratePerSlotSecureReads(): Promise<void> {
    const storage = this.deps.secureStorage;
    const idKey = this.identityAtItem();
    const rxKey = this.dmReactionsItem();
    const fwKey = this.dmFailedWrapsItem();
    const evKey = this.eventStateItem();
    const raw = storage
      ? await multiGet([idKey, rxKey, fwKey, evKey], storage)
      : {[idKey]: null, [rxKey]: null, [fwKey]: null, [evKey]: null};
    this._myIdentityAt = this.parseIdentityAt(raw[idKey]);
    this.applyDmReactions(raw[rxKey]);
    this.applyFailedWraps(raw[fwKey]);
    this.applyEventState(raw[evKey] ?? null);
  }

  /**
   * Persist the in-memory sent-message echoes so they survive an app restart — DEBOUNCED (finding #5).
   * A single sendDM previously rewrote the ENTIRE (unbounded) sent-DM history to the hardware keystore
   * three times (optimistic echo, wrap-id adoption, delivery-status flip), plus once per later status
   * change. The keystore write is slow and the history is rewritten whole each time, so we coalesce a
   * burst into ONE write on a short timer. Callers that must guarantee durability before proceeding
   * (shutdown, community switch, duress) call {@link flushSentMessages} to force it out immediately.
   */
  private saveSentMessages(): void {
    this._sentDmsDirty = true;
    if (this._sentDmsTimer !== undefined) return; // a write is already pending — coalesce
    this._sentDmsTimer = setTimeout(() => {
      this._sentDmsTimer = undefined;
      void this.flushSentMessages();
    }, AppRuntime.DM_PERSIST_DEBOUNCE_MS);
  }

  /** Force any pending debounced sent-message write out now (shutdown / switch / duress). */
  private async flushSentMessages(): Promise<void> {
    if (this._sentDmsTimer !== undefined) {
      clearTimeout(this._sentDmsTimer);
      this._sentDmsTimer = undefined;
    }
    if (!this._sentDmsDirty) return;
    this._sentDmsDirty = false;
    if (!this.deps.secureStorage) return;
    try {
      const obj: Record<string, DirectMessage[]> = {};
      for (const [peer, msgs] of this.sentByPeer) obj[peer] = msgs;
      await this.deps.secureStorage.setItem(this.sentDmsItem(), JSON.stringify(obj));
    } catch {
      // best effort
    }
  }

  /**
   * Restore persisted sent-message echoes. A still-'sending' echo is KEPT queued when its gift
   * wrap is still in the outbox — it will auto-resend on reconnect (outbox.load() runs first in
   * init(), so this reconciliation sees the restored queue). An echo with no matching outbox entry
   * is orphaned (e.g. persisted by an older build that published DMs outside the outbox, or a
   * cancelled send) and is downgraded to 'failed' so it stops spinning forever.
   */
  private async loadSentMessages(): Promise<void> {
    if (!this.deps.secureStorage) return;
    try {
      const raw = await this.deps.secureStorage.getItem(this.sentDmsItem());
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, DirectMessage[]>;
      this.sentByPeer.clear();
      for (const [peer, msgs] of Object.entries(obj)) {
        for (const m of msgs) {
          if (m.status === 'sending' && !this.outbox.has(m.id)) m.status = 'failed';
        }
        this.sentByPeer.set(peer, msgs);
      }
    } catch {
      // ignore corrupt cache
    }
  }

  /**
   * Restore the persisted negative decrypt cache (finding #4): wrap ids we already proved
   * undecryptable-for-us. Keys never rotate in this design, so "undecryptable for me" is permanent —
   * seed these into seenWrapIds so refreshInbox never re-runs the (full-ECDH) unwrap attempt on the
   * same alien decoy wraps every launch. Public ids only; no plaintext (PLAN.md §4.1).
   */
  private applyFailedWraps(raw: string | null | undefined): void {
    // Parse-only (no I/O): always clears failedWrapIds first — as the old loadFailedWraps did, even
    // with no storage — then applies the batched-read value. Fed by hydratePerSlotSecureReads.
    this.failedWrapIds.clear();
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as unknown;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string') {
            this.failedWrapIds.add(id);
            this.seenWrapIds.add(id); // never re-attempt a known-undecryptable wrap
          }
        }
      }
    } catch {
      // ignore corrupt cache
    }
  }

  /** Persist the negative decrypt cache — DEBOUNCED, coalesced with the sent-DM write burst. */
  private saveFailedWraps(): void {
    this._failedWrapsDirty = true;
    if (this._failedWrapsTimer !== undefined) return;
    this._failedWrapsTimer = setTimeout(() => {
      this._failedWrapsTimer = undefined;
      void this.flushFailedWraps();
    }, AppRuntime.DM_PERSIST_DEBOUNCE_MS);
  }

  /** Force any pending negative-cache write out now (shutdown / switch / duress). */
  private async flushFailedWraps(): Promise<void> {
    if (this._failedWrapsTimer !== undefined) {
      clearTimeout(this._failedWrapsTimer);
      this._failedWrapsTimer = undefined;
    }
    if (!this._failedWrapsDirty) return;
    this._failedWrapsDirty = false;
    if (!this.deps.secureStorage) return;
    try {
      await this.deps.secureStorage.setItem(this.dmFailedWrapsItem(), JSON.stringify([...this.failedWrapIds]));
    } catch {
      // best effort
    }
  }

  /** The signer for blind-eligible content (feed posts, comments, reactions, polls, voice). It
   *  posts relay-blind once a community key is loaded, else signs normally. Callers guard on
   *  this.identity first, so the blind signer is always constructed here.
   *
   *  Wrapped so that an empty wallet NEVER blocks or surfaces to the user: if the blind signer throws
   *  BlindTokensExhausted, we transparently draw a fresh batch (host-provided drawTokensNow) and retry
   *  once. Drawing is normally proactive (on connect/foreground) PLUS a low-water refill fired after
   *  every successful spend (see maybeRefillWallet below), so this on-demand path is a rare safety net
   *  — but it's what makes the anti-spam token an invisible background detail rather than a "draw
   *  tokens" prompt. If no draw capability is wired or the draw fails, the original error propagates
   *  (tests / offline). */
  private get feedSigner(): Signer {
    const inner = (this.contentSigner ?? this.identity)!;
    const drawNow = this.deps.drawTokensNow;
    // C5 — refuse to sign a blind-eligible write when the relay advertised a purpose-key fingerprint
    // this community's key doesn't match (a stale/mis-provisioned invite). Otherwise the wallet blinds
    // tokens under a key the relay rejects and EVERY post silently fails at the relay; here it fails
    // LOUDLY with a clear message the composer surfaces. Undefined at caps fallback → unchanged.
    if (this._communityKeyError) {
      const message = this._communityKeyError;
      return {sign: () => Promise.reject(new Error(message))};
    }
    // Only the blind signer can exhaust tokens; plain npub signing (no contentSigner) never does.
    if (!this.contentSigner || !drawNow) return inner;
    return {
      sign: async unsigned => {
        // A write racing loadActiveCommunityPolicy (cold start / community switch) would see no
        // community key yet and fall back to a TOKENLESS npub sign — which a blind community's
        // relay rejects with [token_required] (the observed tokenless-30023 rejects). Wait for the
        // in-flight policy load instead; resolves instantly when the policy is already loaded.
        if (!getActiveCommunityKey() && this._policyLoad) await this._policyLoad.catch(() => {});
        try {
          const event = await inner.sign(unsigned);
          // T-G1a: tokens were already in hand — no draw on this write's critical path at all.
          log.info('perf:wallet', 'spend purpose=post source=hand');
          this.maybeRefillWallet(drawNow); // fire-and-forget low-water top-up; never blocks the write
          return event;
        } catch (e) {
          if (!(e instanceof BlindTokensExhausted)) throw e;
          // Seal key missing (content encryption required, no epoch key loaded): the remedy is NOT a
          // token draw — provision the write epoch (spends one read token over Tor) and retry once.
          // A second SealKeyUnavailable propagates into the durable queue, and the write auto-sends
          // when unlockContentEpoch eventually lands the key (its drainPendingPosts hook).
          if (e instanceof SealKeyUnavailable) {
            const connect = this.deps.connectForDraw;
            if (!connect) throw e;
            const t0 = Date.now();
            log.info('perf:draw', 'purpose=read trigger=seal-key start');
            await this.ensureWriteEpoch(connect);
            log.info('perf:draw', `purpose=read trigger=seal-key end ms=${Date.now() - t0}`);
            return inner.sign(unsigned);
          }
          // Top up behind the scenes, then retry exactly once. A second exhaustion (draw yielded
          // nothing — offline, or the organizer's per-epoch cap is genuinely hit) propagates. No
          // maybeRefillWallet here — drawNow() just topped the wallet up as part of handling the
          // exhaustion itself, so an immediate low-water re-check would be redundant.
          // T-G1a: this IS the rare on-demand draw safety net (background from the composer's point of
          // view — every caller of feedSigner.sign is itself fire-and-forget from the UI, see post()).
          const t0 = Date.now();
          log.info('perf:draw', 'purpose=post trigger=on-demand start');
          const drew = await drawNow();
          log.info('perf:draw', `purpose=post trigger=on-demand end ok=${drew} ms=${Date.now() - t0}`);
          if (!drew) throw e;
          return inner.sign(unsigned);
        }
      },
    };
  }

  /** Below this many unspent tokens, a successful spend (see feedSigner above) fires a background
   *  refill so the wallet restocks long before it can hit zero and force the RARE on-demand
   *  draw-and-retry to actually engage. Well under DRAW_BATCH so one top-up lasts a good while. */
  private static readonly LOW_WATER_REFILL_THRESHOLD = 15;

  /** Guards the low-water refill so a burst of spends landing in the same tick (post + vote + comment
   *  all completing together) fires at most ONE drawTokensNow() rather than stacking draws. Set
   *  SYNCHRONOUSLY (before the async wallet-count check) so two back-to-back calls can't both slip
   *  past the guard while the first is still awaiting; cleared in the draw's finally regardless of
   *  outcome, so a later spend can try again. */
  private _lowWaterRefillInFlight = false;

  /** Fire-and-forget: never awaited on a write path (see feedSigner). Checks the wallet AFTER a
   *  successful spend and, if it dropped below LOW_WATER_REFILL_THRESHOLD, draws a fresh batch in the
   *  background via the same host-provided drawTokensNow used for the on-demand safety net. */
  private maybeRefillWallet(drawNow: () => Promise<boolean>): void {
    if (this._lowWaterRefillInFlight || !this.wallet) return;
    this._lowWaterRefillInFlight = true;
    void (async () => {
      try {
        const wallet = this.wallet; // snapshot — a switch mid-check must not query/refill the wrong account
        if (wallet && (await wallet.count()) < AppRuntime.LOW_WATER_REFILL_THRESHOLD) {
          await drawNow();
        }
      } catch {
        // best-effort background top-up — a later spend retries
      } finally {
        this._lowWaterRefillInFlight = false;
      }
    })();
  }

  /**
   * How many blind posting tokens to draw per top-up. Deliberately generous: every post, comment,
   * AND reaction/vote spends one token, so an active member burns them fast, and the whole point is
   * that a well-meaning user never notices the wallet. Kept at or below the organizer's per-epoch cap
   * (a larger request is clamped/rejected there).
   */
  private static readonly DRAW_BATCH = 100;

  /**
   * Fill the blind-posting wallet for the current epoch by drawing tokens from the organizer over a
   * (Tor-routed) relay socket. Presents the member's anonymous credential as proof; the organizer
   * never learns the npub. Safe to call opportunistically (post-enrollment, on a low wallet, or at
   * epoch rollover). The caller supplies a `connect` factory that opens a fresh dedicated socket —
   * runTokenDraw retries across several of them (recovering a lost response from the relay's stored
   * copy), so the top-up completes over a flaky Tor circuit without re-drawing or burning quota.
   * The on-demand path (a post finding the wallet empty) passes a smaller `attempts` budget so a
   * post never hangs; the proactive path is patient because it runs invisibly in the background.
   */
  async drawTokens(
    connect: () => RelaySocket,
    count = AppRuntime.DRAW_BATCH,
    opts?: {attempts?: number; timeoutMs?: number},
  ): Promise<{ok: boolean; drawn: number; error?: string}> {
    if (!this.identity || !this.wallet || !this.communities) {
      return {ok: false, drawn: 0, error: 'not enrolled'};
    }
    // F-D: capture the TARGET wallet into a local now, before the multi-minute Tor draw below — the
    // mutable `this.wallet` field gets reassigned by rebuildIdentity on an identity/community switch,
    // so re-reading `this.wallet` after the await (as this code used to at the deposit below) would
    // credit tokens minted under THIS account's issuer key into whatever account is active when the
    // draw finally resolves. Mirrors drawForWallet's own stable `wallet` parameter.
    const wallet = this.wallet;
    const active = await this.communities.active();
    if (!active?.organizerPubkey) {
      return {ok: false, drawn: 0, error: 'this community has no organizer mailbox'};
    }
    const credential = await this.identity.credential();
    if (!credential) {
      return {ok: false, drawn: 0, error: 'no membership credential'};
    }
    // F10: resume any batch a prior kill left signed-but-unstaged BEFORE starting a fresh draw — a
    // fresh draw's own marker would otherwise silently overwrite (and strand) the old one.
    await this.resumeStagedDraw(Purpose.Post, wallet, connect);
    // Fresh-enroll gap (2026-07-21 incident): a short-link invite carries ZERO purpose keys, so the
    // first draw would fall back to blinding under the enrollment key — wrong-key draws the organizer
    // rejects (or signs unusably). Fetch the live `stiq:token-keys` doc FIRST when it's missing.
    await this.ensureFreshPurposeKeys(connect, Purpose.Post);
    const epoch = currentEpoch();
    // Posting-token draw: blinds under K_post (postIssuerPublicKey) when the community carries it
    // (token domain separation, #3/#4/#29), else falls back to the single issuer key. purpose
    // defaults to 'post'. The credential presented for authorization stays the K_enroll credential.
    // `EnrolledCommunity.issuerPublicKey` is optional (a v2 record can persist before the deferred
    // key is fetched/verified) while `Community.issuerPublicKey` (drawExchange's input type) stays
    // required; `?? ''` keeps this a no-op for every existing (resolved) community. Built via a
    // closure so the stale-key heal can rebuild the SAME options from a freshly re-synced record.
    const buildOpts = (c: NonNullable<typeof active>): DrawOptions => ({
      connect,
      community: {
        relayUrl: c.relayUrl,
        issuerPublicKey: c.issuerPublicKey ?? '',
        organizerPubkey: c.organizerPubkey,
        postIssuerPublicKey: c.postIssuerPublicKey,
        readIssuerPublicKey: c.readIssuerPublicKey,
      },
      blindRsa: createBlindRsa(),
      credential,
      epoch,
      count,
      // Capability-driven PoW (C4): mine to the relay's advertised enroll difficulty so an operator
      // can raise it without shipping a new client. Falls back to ENROLL_POW_DIFFICULTY via the caps
      // constant fallback (relay hasn't advertised) → byte-identical to before.
      powDifficulty: this._relayCaps.enrollPow,
      // Schema-gates capFromResponse's legacy prose scrape (C3): at/above CAPS_SCHEMA_ERROR_CODES the
      // relay guarantees the structured `cap` field so a cap-less error is fatal, not prose-scraped.
      // Today's caps report schemaVersion < that threshold, so the self-heal stays active — unchanged.
      capsSchemaVersion: this._relayCaps.schemaVersion,
      attempts: opts?.attempts,
      timeoutMs: opts?.timeoutMs,
      // F10 durable draw staging: persist a recovery marker before the mailbox round-trip.
      onMarker: marker => this.stageDrawMarker(Purpose.Post, marker),
    });
    const res = await this.healedTokenDraw(
      buildOpts(this.activeCommunity ?? active),
      async () => {
        const fresh = this.activeCommunity ?? (await this.communities?.active()) ?? null;
        return fresh?.organizerPubkey ? buildOpts(fresh) : null;
      },
    );
    if (!res.ok) {
      // Remember WHY (with the organizer's machine code when present) so a write failing on the
      // empty wallet can surface the true cause via exhaustionReason — never a raw error string.
      this._lastDrawFailure = {purpose: Purpose.Post, error: res.error, code: res.code, timedOut: res.timedOut, at: Date.now()};
      // Terminal (organizer/relay rejected, or exhausted every attempt without a definitive answer is
      // NOT terminal — see below): only clear the marker when there is nothing left to recover.
      if (!res.timedOut) await this.clearStagedDraw(Purpose.Post);
      return {ok: false, drawn: 0, error: res.error};
    }
    // ok-but-EMPTY = the organizer's epoch allowance is spent (drawExchange's cap family resolves to
    // an empty draw on purpose). Record it so exhaustionReason can say "allowance used" instead of
    // the default "check your connection" — reconnecting can never refill a spent quota. A non-empty
    // draw clears any stale marker: the wallet demonstrably refills again.
    this._lastDrawFailure =
      res.tokens.length === 0
        ? {purpose: Purpose.Post, error: 'epoch allowance spent', quotaSpent: true, at: Date.now()}
        : null;
    await wallet.add(epoch, res.tokens);
    // Reconciled into the wallet — safe to drop the marker now (F10 step 3: persist-then-clear).
    await this.clearStagedDraw(Purpose.Post);
    // Publish-durability FIX — a fresh batch just landed: retry anything queued by post()'s catch
    // while the wallet was exhausted (see drainPendingPosts).
    void this.drainPendingPosts();
    return {ok: true, drawn: res.tokens.length};
  }

  /**
   * F10 durable draw staging — the three small helpers `drawTokens`/`drawForWallet`/
   * `unlockContentEpoch`'s read-draw share. `resumeStagedDraw` is called at the TOP of every draw
   * entry point (opportunistically, before that call's OWN fresh draw): if a prior call staged a
   * marker but the process died before reconciling it into the wallet, this replays the SAME signed
   * request + reply key (the organizer already stored — and charged the epoch quota for — its
   * response, so replaying never re-draws or re-charges) and finalizes using the marker's stored
   * secrets, exactly mirroring the normal draw's own persist-then-clear ordering. Best-effort and
   * silent on the happy path (no marker → one cheap SecureStorage read, no-op).
   */
  private async resumeStagedDraw(
    purpose: DrawPurpose,
    wallet: EpochWallet,
    connect: () => RelaySocket,
  ): Promise<void> {
    if (!this.deps.secureStorage) return;
    const storage = this.deps.secureStorage;
    const namespace = this.activeSlotId ?? '';
    let marker: DrawMarker | null;
    try {
      marker = await loadDrawMarker(storage, namespace, purpose);
    } catch {
      return;
    }
    if (!marker) return;
    try {
      const res = await resumeTokenDraw(marker, {
        connect,
        blindRsa: createBlindRsa(),
        capsSchemaVersion: this._relayCaps.schemaVersion,
      });
      if (!res.ok) {
        if (!res.timedOut) {
          // Terminal (organizer/relay rejected it, or the epoch allowance shrank under it) — nothing
          // left to recover, so clear rather than retry forever against a batch that can never
          // resolve. Logged (not silently swallowed): if the organizer HAD already signed+charged this
          // batch (a genuine reject, not the no-charge cap case), that quota spend has no client-side
          // refund path — same class as the relay-side spend-then-reject gap (F1) — so this must be
          // observable, even though there is nothing more this code can do about it.
          log.warn('draw', `abandoning unrecoverable staged ${purpose} draw: ${res.error}`);
          await clearDrawMarker(storage, namespace, purpose);
        }
        // timedOut → still might resolve; leave the marker for the next opportunity.
        return;
      }
      await wallet.add(marker.epoch, res.tokens);
      await clearDrawMarker(storage, namespace, purpose);
    } catch (e) {
      // Never let a resume failure block the caller's own fresh draw attempt.
      log.warn('draw', `staged ${purpose} draw resume threw: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Persist a draw-in-flight marker for `purpose`, best-effort (see DrawOptions.onMarker). */
  private async stageDrawMarker(purpose: DrawPurpose, marker: DrawMarker): Promise<void> {
    if (!this.deps.secureStorage) return;
    try {
      await saveDrawMarker(this.deps.secureStorage, this.activeSlotId ?? '', purpose, marker);
    } catch {
      // Best-effort — a failed stage only means a kill in the next few seconds isn't recoverable, no
      // worse than before this fix existed.
    }
  }

  /** Clear `purpose`'s draw-in-flight marker, best-effort. */
  private async clearStagedDraw(purpose: DrawPurpose): Promise<void> {
    if (!this.deps.secureStorage) return;
    try {
      await clearDrawMarker(this.deps.secureStorage, this.activeSlotId ?? '', purpose);
    } catch {
      // best-effort
    }
  }

  /** How many unspent posting tokens the wallet holds (0 when not blind / not enrolled). */
  async walletBalance(): Promise<number> {
    return this.wallet ? this.wallet.count() : 0;
  }

  /**
   * Force-refresh the per-purpose wallet counts (T5.1/F18) — the async half of
   * AppSnapshot.tokenStatus (wallet counts need a SecureStorage round-trip; the rest of tokenStatus
   * is already in-memory and always fresh — see buildTokenEconomyStatus). Read-only: calls the SAME
   * EpochWallet.count() / TokenPool.get(purpose).count() every top-up sweep already uses — no draw,
   * no spend, no wallet mutation of any kind. Mirrors walletBalance()'s existing semantics (a UI/status
   * read, never a hot path) for the posting wallet, and extends it to the six TokenPool-pooled
   * auxiliary purposes. The `__DEV__` token-status screen calls this on open and on manual refresh;
   * getSnapshot() reads the cached result in between (_tokenWalletCounts) so a routine emit never pays
   * a storage round-trip it didn't ask for.
   */
  async refreshTokenWalletCounts(): Promise<TokenWalletCounts> {
    const [post, read, pictureWrite, pictureRead, audioWrite, audioRead, spaceWrite] = await Promise.all([
      this.wallet ? this.wallet.count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.Read).count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.PictureWrite).count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.PictureRead).count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.AudioWrite).count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.AudioRead).count() : Promise.resolve(0),
      this.tokenPool ? this.tokenPool.get(Purpose.SpaceWrite).count() : Promise.resolve(0),
    ]);
    this._tokenWalletCounts = {post, read, pictureWrite, pictureRead, audioWrite, audioRead, spaceWrite};
    this.emit();
    return this._tokenWalletCounts;
  }

  /**
   * Build AppSnapshot.tokenStatus (T5.1/F18) — read-only wallet/economy diagnostics. Wallet counts
   * come from the last {@link refreshTokenWalletCounts} call (cached in _tokenWalletCounts); the
   * per-domain C5 drift verdict and the recent-failures slice are recomputed fresh on every call from
   * already-in-memory state (negotiated relay capabilities + this device's own per-domain key
   * fingerprints + the diagnostic log ring buffer), so they never go stale between one wallet-count
   * refresh and the next. Cheap (no storage, no store query, no network) — safe to call from both
   * getSnapshot() and the idle/deferred-heavy snapshot path.
   */
  private buildTokenEconomyStatus(): TokenEconomyStatus {
    const caps = this._relayCaps;
    const domains = computeDomainStatuses(caps, {
      posting: this.activePostKeyFp,
      spaceWrite: this.activeSpaceWriteKeyFp,
      picture: this.activePictureWriteKeyFp,
      audio: this.activeAudioWriteKeyFp,
      read: this.activeReadKeyFp,
    });
    return {
      wallets: this._tokenWalletCounts,
      walletRows: computeWalletRows(this._tokenWalletCounts, caps),
      domains,
      communityKeyError: this._communityKeyError,
      recentFailures: filterTokenFailures(getRecentLogs()),
    };
  }

  // ── WalletHub: the ONE scheduler for every AUXILIARY token domain (tokens-everywhere) ─────────
  //
  // The posting wallet keeps its own proactive + low-water + on-exhaustion machinery (drawTokens /
  // feedSigner / maybeRefillWallet) untouched. The auxiliary domains — space-write, and the media
  // WRITE domains — are stocked by ONE pass here so the device does the least work: a single
  // sequential sweep over only the ACTIVE domains (gated by relay caps), each drawing over the same
  // caller-supplied Tor connect factory, each below its own low-water line. Inactive domains cost
  // nothing (no draw, no socket). Pre-stocking ahead of need is also the SECURE choice: it breaks
  // the timing correlation a just-in-time draw would create between a credential-authenticated draw
  // and the later (blind) spend. Read domains stay lazy (drawn on unlock) — unchanged.

  /** Space-write batch: smaller than posting (a member sends fewer channel/group/DM messages than
   *  feed posts+votes+comments), still enough that one sweep lasts a good while. */
  private static readonly SPACE_DRAW_BATCH = 50;
  /** Media-write batch: media is the rarest write, so the smallest batch. */
  private static readonly MEDIA_DRAW_BATCH = 25;
  /** Below this many tokens an auxiliary wallet is topped up on the next sweep. */
  private static readonly AUX_LOW_WATER = 10;

  /**
   * The auxiliary sweep's worklist (T4.2 — replaces a hand-unrolled `if` per domain with a config
   * table): one row per proactively-stocked purpose, naming its batch size and the relay-capability
   * predicate that gates it. Enabling a new proactively-stocked purpose is adding one row here, not a
   * new branch in {@link stockAuxiliaryWallets}. Order matches the pre-T4.2 sweep (space, then
   * picture, then audio) so behavior/log order is unchanged.
   */
  private static readonly AUX_DRAW_JOBS: ReadonlyArray<{
    purpose: PoolPurpose;
    batch: number;
    active: (caps: RelayCapabilities) => boolean;
  }> = [
    {
      purpose: Purpose.SpaceWrite,
      batch: AppRuntime.SPACE_DRAW_BATCH,
      active: caps => caps.enforcedFlags.spaceTokensRequired,
    },
    {
      purpose: Purpose.PictureWrite,
      batch: AppRuntime.MEDIA_DRAW_BATCH,
      active: caps => caps.mediaWriteDomains.picture,
    },
    {
      purpose: Purpose.AudioWrite,
      batch: AppRuntime.MEDIA_DRAW_BATCH,
      active: caps => caps.mediaWriteDomains.audio,
    },
  ];

  /** Guards the auxiliary sweep so overlapping relay syncs / foregrounds don't stack draws. */
  private _auxStockInFlight = false;

  /**
   * Top up every ACTIVE auxiliary token wallet that has fallen below its low-water line, in one
   * background sweep. Called from the host on relay sync/foreground alongside the posting top-up,
   * with a fresh Tor `connect` factory. A no-op (draws nothing, opens no socket) for a domain whose
   * relay capability is off — so with today's caps this returns immediately. Never throws into the
   * caller; a failed domain is retried on the next sweep.
   */
  async stockAuxiliaryWallets(connect: () => RelaySocket): Promise<void> {
    if (this._auxStockInFlight) return;
    this._auxStockInFlight = true;
    try {
      // Sequential (not parallel): one Tor round-trip at a time is gentler on the device and the
      // circuit, and these are background top-ups with no user waiting. Each is independently
      // low-water-gated so a well-stocked domain is skipped for free.
      for (const job of AppRuntime.AUX_DRAW_JOBS) {
        if (!job.active(this._relayCaps)) continue;
        const wallet = this.tokenPool?.get(job.purpose);
        if (!wallet) continue;
        try {
          if ((await wallet.count()) >= AppRuntime.AUX_LOW_WATER) continue;
          // T-G3a: routed through the same per-purpose dedup as the on-demand path (spendSpaceTokens)
          // so a proactive sweep and a concurrent write-triggered drought for the SAME purpose share
          // one draw instead of racing two.
          await this.drawForWalletDeduped(connect, wallet, job.purpose, job.batch);
        } catch {
          // best-effort per domain — a later sweep retries
        }
      }
    } finally {
      this._auxStockInFlight = false;
    }
  }

  /**
   * App-foreground low-water kick (T-G4). The host's AppState 'active' handler calls this when the
   * connection rode straight through backgrounding (no reconnect happened, so onRelayConnected's own
   * post-connect top-ups never reran) — the one foreground moment otherwise left uncovered between a
   * background drought and the next write finding a dry wallet. Tops up the posting wallet via the
   * SAME host-provided on-demand draw the write path's safety net uses (deps.drawTokensNow — watermark-
   * gated + single-flighted at the host, see App.tsx's `drawInFlight`) and sweeps every auxiliary
   * domain below its low-water line (stockAuxiliaryWallets — whole-sweep + per-purpose deduped).
   * Both are best-effort background top-ups: never throws, never awaited by anything that would turn
   * this into a foreground wait, and a free no-op when the wallet/pools are already warm.
   */
  async foregroundLowWaterRefill(): Promise<void> {
    const drawNow = this.deps.drawTokensNow;
    if (drawNow) void drawNow().catch(() => {});
    const connect = this.deps.connectForDraw;
    if (connect) void this.stockAuxiliaryWallets(connect).catch(() => {});
  }

  /**
   * Draw `count` tokens of `purpose` into `wallet` from the organizer over Tor. The generalized core
   * of {@link drawTokens} (which stays the posting-specific entry point, adding drainPendingPosts):
   * blinds under the purpose's issuer key (space-write / media-write, falling back to the enrollment
   * key), presents the K_enroll credential, and deposits the batch. WRITE purposes only — never
   * attaches a reader-auth, so these draws stay anonymous exactly like posting draws.
   */
  private async drawForWallet(
    connect: () => RelaySocket,
    wallet: EpochWallet,
    purpose: DrawPurpose,
    count: number,
  ): Promise<{ok: boolean; drawn: number; error?: string}> {
    if (!this.identity || !this.communities) return {ok: false, drawn: 0, error: 'not enrolled'};
    const active = await this.communities.active();
    if (!active?.organizerPubkey) return {ok: false, drawn: 0, error: 'no organizer mailbox'};
    const credential = await this.identity.credential();
    if (!credential) return {ok: false, drawn: 0, error: 'no membership credential'};
    // F10: resume any batch a prior kill left staged for this exact purpose before drawing a fresh one.
    await this.resumeStagedDraw(purpose, wallet, connect);
    // Fresh-enroll gap: fetch the live key set before the first draw of a purpose whose dedicated
    // key is missing (short-link invites carry none) — see drawTokens for the incident rationale.
    await this.ensureFreshPurposeKeys(connect, purpose);
    const epoch = currentEpoch();
    const buildOpts = (c: NonNullable<typeof active>): DrawOptions => ({
      connect,
      community: {
        relayUrl: c.relayUrl,
        issuerPublicKey: c.issuerPublicKey ?? '',
        organizerPubkey: c.organizerPubkey,
        postIssuerPublicKey: c.postIssuerPublicKey,
        readIssuerPublicKey: c.readIssuerPublicKey,
        picWriteIssuerPublicKey: c.picWriteIssuerPublicKey,
        picReadIssuerPublicKey: c.picReadIssuerPublicKey,
        audWriteIssuerPublicKey: c.audWriteIssuerPublicKey,
        audReadIssuerPublicKey: c.audReadIssuerPublicKey,
        spaceWriteIssuerPublicKey: c.spaceWriteIssuerPublicKey,
      },
      purpose,
      blindRsa: createBlindRsa(),
      credential,
      epoch,
      count,
      powDifficulty: this._relayCaps.enrollPow,
      capsSchemaVersion: this._relayCaps.schemaVersion,
      onMarker: marker => this.stageDrawMarker(purpose, marker),
    });
    const res = await this.healedTokenDraw(
      buildOpts(this.activeCommunity ?? active),
      async () => {
        const fresh = this.activeCommunity ?? (await this.communities?.active()) ?? null;
        return fresh?.organizerPubkey ? buildOpts(fresh) : null;
      },
    );
    if (!res.ok) {
      this._lastDrawFailure = {purpose, error: res.error, code: res.code, timedOut: res.timedOut, at: Date.now()};
      if (!res.timedOut) await this.clearStagedDraw(purpose);
      return {ok: false, drawn: 0, error: res.error};
    }
    // Same ok-but-EMPTY quota marker as drawTokens above (allowance spent ≠ connection trouble).
    this._lastDrawFailure =
      res.tokens.length === 0
        ? {purpose, error: 'epoch allowance spent', quotaSpent: true, at: Date.now()}
        : null;
    await wallet.add(epoch, res.tokens);
    await this.clearStagedDraw(purpose);
    return {ok: true, drawn: res.tokens.length};
  }

  /**
   * The pre-sign hook installed on {@link Identity} (tokens-everywhere, SHIPS DARK). For a bound-npub
   * SPACE content kind, when the relay requires space tokens, it spends the weight-priced cost from
   * the space wallet (drawing a fresh batch over Tor and retrying once if the wallet is short — the
   * same invisible safety net as feedSigner) and returns the all-proofs token chain bound to the
   * member's npub. Returns null for every other kind, and whenever enforcement is off, so signing is
   * byte-identical until an operator flips `space_tokens_required`.
   *
   * The event stays npub-signed (roles + attribution intact); the tokens prove the spam price was
   * paid without revealing whose. Attaches BEFORE finalize (Identity.sign appends these tags, so
   * they're covered by the id + signature; the proofs bind to the member pubkey, fixed up front).
   *
   * FAIL-LOUD on genuine exhaustion (organizer allowance spent): throws so the write surfaces as
   * failed rather than posting tokenless (which the relay would reject anyway). Mirrors a feed post.
   */
  private async spaceTokenTagsFor(unsigned: {kind: number; content?: string; tags?: string[][]}): Promise<string[][] | null> {
    if (!this._relayCaps.enforcedFlags.spaceTokensRequired) return null;
    if (!isSpaceContentKind(unsigned)) return null;
    if (!this.tokenPool || !this.identity) return null;
    const need = tokenCost(unsigned.content ?? '', unsigned.tags ?? [], this._relayCaps.enforcedFlags.bytesPerToken);
    const tokens = await this.spendSpaceTokens(need);
    const {pubkey} = await this.identity.info();
    return buildSpaceTokenTags(tokens, pubkey);
  }

  /**
   * Spend `need` space-write tokens, drawing a fresh batch over Tor and retrying once when the wallet
   * is short (the invisible safety net feedSigner uses). Throws {@link BlindTokensExhausted} on genuine
   * exhaustion (organizer allowance spent) — T0.1: a calm, typed throw (not a plain Error) — so every
   * caller's durable catch (signPendingWrite's `e instanceof BlindTokensExhausted` branch, T0.2/T0.3)
   * and sendDM's catch-all (which pipes `err.message` straight into the DM's failureReason) both surface
   * a reasoned, non-jargon failure instead of losing the write silently (F2) or leaking raw prose (B6).
   * Shared by the space content pre-sign hook and the DM-wrap token attach.
   */
  private async spendSpaceTokens(need: number): Promise<Token[]> {
    if (!this.tokenPool) throw new Error('space wallet unavailable');
    let tokens = await this.tokenPool.get(Purpose.SpaceWrite).spendMany(need);
    if (tokens) {
      log.info('perf:wallet', `spend purpose=space-write source=hand need=${need}`);
    } else {
      // Wallet short: draw a fresh batch over a dedicated Tor socket, then retry the spend once. The
      // connect factory throws when the relay isn't up yet — treat that as "couldn't draw" (the
      // exhaustion error below then surfaces the failed send) rather than crashing the sign path.
      // T-G3a: drawForWalletDeduped coalesces this with any OTHER concurrent space-write drought
      // (a channel post + a DM landing in the same tick) onto ONE Tor round-trip.
      try {
        const connect = this.deps.connectForDraw;
        if (connect) {
          log.info('perf:wallet', `spend purpose=space-write source=draw need=${need}`);
          await this.drawForWalletDeduped(connect, this.tokenPool.get(Purpose.SpaceWrite), Purpose.SpaceWrite, AppRuntime.SPACE_DRAW_BATCH);
          tokens = await this.tokenPool.get(Purpose.SpaceWrite).spendMany(need);
        }
      } catch {
        // no draw socket available — fall through to the exhaustion error
      }
    }
    if (!tokens) throw new BlindTokensExhausted(Purpose.SpaceWrite);
    return tokens;
  }

  /**
   * Bearer posting token for an ATTRIBUTED space reaction (h-tagged kind-7) — the one content shape
   * that belongs to BOTH worlds. GroupGuard requires the real member npub (a throwaway signer fails
   * its membership check), while the relay's blind gate (blind_required) covers kind 7 regardless of
   * tags — so a tokenless npub reaction is rejected [token_required], and a blind-signed one is
   * rejected [not_group_member]: without this attach, space reactions have NO admissible shape on a
   * blind community. The relay's documented interim routing (membership.go, the kind-7 carve-out in
   * the space gate) is "kind 7 pays a posting token either way", and handleBlindPost admits an
   * npub-signed event carrying bearer (token, sig) pairs while holder proofs ship dark — so: spend
   * the weight-priced cost from the POSTING wallet and attach plain stiq_token/stiq_sig pairs, no
   * stiq_spend proofs (a bearer client emits zero, which the relay's proof-count bound allows).
   *
   * Returns null when the relay doesn't demand it: not a blind community, or space tokens took over
   * (spaceTokenTagsFor owns that chain — the relay routes h-tagged 7 to the space gate then, where
   * mixed-in bearer posting tokens would break the all-proofs count equation).
   *
   * OPERATOR NOTE: space_tokens_required must flip ON no later than holder_proof_required — under
   * holder proofs an attributed bearer event fails (token 0 must equal event.pubkey), so the bearer
   * window this helper covers must be closed by space-token enforcement first.
   */
  private async bearerReactionTokenTags(unsigned: {content?: string; tags?: string[][]}): Promise<string[][] | null> {
    const flags = this._relayCaps.enforcedFlags;
    if (!flags.blindRequired || flags.spaceTokensRequired) return null;
    if (!this.wallet) return null;
    const need = tokenCost(unsigned.content ?? '', unsigned.tags ?? [], flags.bytesPerToken);
    let tokens = await this.wallet.spendMany(need);
    if (!tokens && this.deps.drawTokensNow) {
      // Wallet short: top up over Tor exactly like the feedSigner safety net, then retry once.
      if (await this.deps.drawTokensNow()) tokens = await this.wallet.spendMany(need);
    }
    if (!tokens) throw new BlindTokensExhausted();
    const tags: string[][] = [];
    for (const t of tokens) {
      tags.push([TAG_TOKEN, bytesToBase64(t.token)], [TAG_SIG, bytesToBase64(t.sig)]);
    }
    return tags;
  }

  /**
   * DM-wrap token attach (tokens-everywhere, SHIPS DARK). Passed to {@link Identity.sealDM}/
   * {@link Identity.sealDmReaction}, which forward it to mineGiftWrap AFTER minting the wrap's
   * ephemeral key: it spends the weight-priced cost of the wrap from the space wallet and returns the
   * all-proofs token chain bound to the WRAP's ephemeral pubkey (the wrap's own signer), so the DM
   * pays the same anti-spam price as any space write while staying unattributable — the tokens prove
   * a member paid, never who. Returns [] (no tags) whenever enforcement is off, so DMs are unchanged.
   */
  private dmTokenAttach = async (
    wrapPubkeyHex: string,
    weighable: {content: string; tags: string[][]},
  ): Promise<string[][]> => {
    if (!this._relayCaps.enforcedFlags.spaceTokensRequired || !this.tokenPool) return [];
    const need = tokenCost(weighable.content, weighable.tags, this._relayCaps.enforcedFlags.bytesPerToken);
    const tokens = await this.spendSpaceTokens(need);
    return buildSpaceTokenTags(tokens, wrapPubkeyHex);
  };

  /**
   * Media token router injected into {@link BlindSigner} (Phase 4d, SHIPS DARK). For a kind-30351
   * media blob, when the relay advertises the matching media WRITE domain, returns that domain's
   * dedicated wallet + `stiq_dom` value so the blob's tokens are drawn under (and verified against)
   * the picture/audio write key instead of the general posting key — letting the organizer meter and
   * price media independently of text. Returns null for a non-blob event, a domain the relay hasn't
   * advertised, or a missing wallet — the post wallet then pays with no `stiq_dom`, byte-identical.
   * The blind signer already falls back to the post wallet if the chosen media wallet is empty, so a
   * media draught never blocks posting.
   */
  private routeMediaToken(unsigned: {kind: number; content?: string}): ReturnType<MediaTokenRouter> {
    if (unsigned.kind !== KIND_MEDIA_BLOB || !this.tokenPool) return null;
    const domains = this._relayCaps.mediaWriteDomains;
    // Sniff the payload: a media blob's content is the base64 media buffer. Image magic ⇒ picture,
    // anything else ⇒ audio (the only two media modalities the composer produces).
    const isPicture = payloadLooksLikeImage(unsigned.content ?? '');
    if (isPicture) {
      if (!domains.picture) return null;
      return {wallet: this.tokenPool.get(Purpose.PictureWrite), domain: StiqDom.Picture};
    }
    if (!domains.audio) return null;
    return {wallet: this.tokenPool.get(Purpose.AudioWrite), domain: StiqDom.Audio};
  }

  /**
   * How many read tokens to draw per read-wallet top-up. Smaller than the posting batch because a
   * member unlocks content windows far less often than they post/vote — but still enough to unlock
   * many epochs from one Tor round-trip. Kept at/below the organizer's per-epoch read allowance.
   */
  private static readonly READ_DRAW_BATCH = 25;

  /**
   * Read-meter unlock (content-encryption, C7 — SHIPS DARK). Spend one blind READ token to obtain the
   * content epoch key K_E for `epoch` from the organizer over Tor, then cache + persist it so the feed
   * decrypts that window's sealed bodies and re-renders (the feed's `contentLockState` cache key forces
   * the locked→unlocked rebuild), and emit.
   *
   * MASTER GATE: this is a NO-OP unless `caps.enforcedFlags.contentEncryption === true`. With today's
   * fallback caps (flag false) it returns immediately WITHOUT drawing a read token, contacting the
   * organizer, or touching any content key — so the whole read-meter subsystem is inert and behaviour
   * is byte-identical. And because nothing seals a body until the flag is on AND the organizer
   * advertises an epoch, no locked feed item ever exists to tap today, so this is doubly dormant.
   *
   * ANONYMITY: the read-token draw and the unlock both ride Tor exactly like the posting-token draw —
   * throwaway request/reply keys, blind (unlinkable) tokens, organizer mailbox — so the npub is never
   * revealed and blind posting is untouched. `connect` opens a fresh dedicated Tor socket, supplied by
   * the host (which owns the Tor manager), mirroring {@link drawTokens}.
   *
   * A failed unlock consumes the read token by design: the read meter is a finite per-member budget
   * (that is the whole point — see ../blind/readUnlock), so a burned token merely costs one budget
   * unit and runReadUnlock already retries internally to recover a response lost over a flaky circuit.
   */
  async unlockContentEpoch(
    connect: () => RelaySocket,
    epoch: number,
    opts?: {
      /** True when the unlock was triggered BY an actual sealed item (noteLockedEpochs): a sealed
       *  post in the store is itself proof the community provisioned content encryption, so the
       *  unlock proceeds even when the relay flag is currently OFF — otherwise content sealed while
       *  the flag was on becomes permanently unreadable the moment an operator turns it off (the
       *  2026-07-21 incident's stranded posts). Absent (write-side provisioning) keeps the gate. */
      sealedItem?: boolean;
    },
  ): Promise<{ok: boolean; error?: string; transient?: boolean}> {
    // Dark-ship master gate — inert until a relay advertises the content-encryption capability OR a
    // sealed item is actually in front of us (see opts.sealedItem above).
    if (!this._relayCaps.enforcedFlags.contentEncryption && !opts?.sealedItem) {
      return {ok: false, error: 'content encryption not enabled'};
    }
    if (!Number.isInteger(epoch) || epoch < 0) return {ok: false, error: 'invalid content epoch'};
    // Already unlocked (or unlocked by a concurrent tap) — idempotent success, no token burned.
    if (hasContentEpochKey(epoch)) return {ok: true};
    if (!this.identity || !this.tokenPool || !this.communities) {
      return {ok: false, error: 'not enrolled'};
    }
    // Capture the paying account BEFORE the long Tor round-trips below, so an account switch mid-unlock
    // can't file this slot's purchased content-epoch key under a sibling slot (per-account siloing).
    // F-D: the read WALLET itself must be captured the same way — `this.tokenPool` is reassigned by
    // rebuildIdentity on a slot/community switch, so `this.tokenPool.get(Purpose.Read)` re-evaluated
    // after the draw's Tor round-trip (below) could return a DIFFERENT account's wallet than the one
    // that started the draw, depositing tokens minted under this account's issuer key into a sibling
    // account. Capture it once, up front, and use only the local from here down (mirrors `slot`).
    const slot = this.activeSlotId;
    const readWallet = this.tokenPool.get(Purpose.Read);
    const active = await this.communities.active();
    if (!active?.organizerPubkey) {
      return {ok: false, error: 'this community has no organizer mailbox'};
    }

    // One read token: spend from the wallet, drawing a fresh batch over Tor when it is empty (the
    // read wallet is stocked lazily on first unlock, unlike the posting wallet's proactive top-up).
    let token = await readWallet.spend();
    if (!token) {
      const credential = await this.identity.credential();
      if (!credential) return {ok: false, error: 'no membership credential'};
      // F10: resume any batch a prior kill left staged before drawing a fresh read batch.
      await this.resumeStagedDraw(Purpose.Read, readWallet, connect);
      const drawEpoch = currentEpoch();
      // Censorable reads (#4): under read-auth enforcement, prove our npub on the read draw so the
      // organizer can refuse a read-REVOKED member. A member-signed reader-auth (kind KIND_READ_AUTH)
      // that rides INSIDE the NIP-44 draw payload — it is NEVER published to the relay. The posting
      // draw (drawTokens) never signs one, so posting stays blind + uncensorable — the most a mod can
      // do to a poster is ban (→ advisory mod-log). Absent under today's caps (flag false) → read
      // draws stay anonymous, byte-identical to before.
      const readerAuth = this._relayCaps.enforcedFlags.readAuthRequired
        ? await this.identity.sign({
            kind: KIND_READ_AUTH, // must match the organizer (issuer/organizer-server.mjs)
            created_at: Math.floor(Date.now() / 1000),
            tags: [['epoch', String(drawEpoch)]],
            content: '',
          })
        : undefined;
      // Fresh-enroll gap: a short-link invite carries no `rk` — fetch the live key set before the
      // first read draw rather than mis-blinding (or dead-ending on the C5 read-gate).
      await this.ensureFreshPurposeKeys(connect, Purpose.Read);
      const buildOpts = (c: NonNullable<typeof active>): DrawOptions => ({
        connect,
        // Read-token draw: blinds under K_read (readIssuerPublicKey) when the community carries it,
        // else falls back to the single issuer key. The credential presented stays the K_enroll one.
        community: {
          relayUrl: c.relayUrl,
          // See the matching note in drawTokens() above: EnrolledCommunity.issuerPublicKey is
          // optional (v2 pre-fetch), Community.issuerPublicKey stays required.
          issuerPublicKey: c.issuerPublicKey ?? '',
          organizerPubkey: c.organizerPubkey,
          postIssuerPublicKey: c.postIssuerPublicKey,
          readIssuerPublicKey: c.readIssuerPublicKey,
        },
        purpose: Purpose.Read,
        readerAuth,
        // C5 read-gate: fail cleanly if the relay advertises a read fingerprint but this invite has no
        // `rk` (would otherwise mis-blind under the enroll/posting key). Absent → no gate (dark path).
        readFingerprint: this._relayCaps.purposeKeyFingerprints.read,
        blindRsa: createBlindRsa(),
        credential,
        epoch: drawEpoch,
        count: AppRuntime.READ_DRAW_BATCH,
        powDifficulty: this._relayCaps.enrollPow,
        capsSchemaVersion: this._relayCaps.schemaVersion,
        // F10 durable draw staging: persist a recovery marker before the mailbox round-trip.
        onMarker: marker => this.stageDrawMarker(Purpose.Read, marker),
      });
      const drawn = await this.healedTokenDraw(
        buildOpts(this.activeCommunity ?? active),
        async () => {
          const fresh = this.activeCommunity ?? (await this.communities?.active()) ?? null;
          return fresh?.organizerPubkey ? buildOpts(fresh) : null;
        },
      );
      if (!drawn.ok) {
        this._lastDrawFailure = {purpose: Purpose.Read, error: drawn.error, code: drawn.code, timedOut: drawn.timedOut, at: Date.now()};
        if (!drawn.timedOut) await this.clearStagedDraw(Purpose.Read);
        return {ok: false, error: drawn.error, transient: drawn.timedOut === true};
      }
      await readWallet.add(drawEpoch, drawn.tokens);
      await this.clearStagedDraw(Purpose.Read);
      token = await readWallet.spend();
      if (!token) return {ok: false, error: 'no read tokens available (organizer allowance spent)'};
    }

    const res = await runReadUnlock({
      connect,
      organizerPubkey: active.organizerPubkey,
      token,
      epoch,
      // The unlock request is an organizer-mailbox event (kind 9026) like the draw request (kind
      // 9024), so it mines to the relay's advertised enroll PoW — same as drawTokens.
      powDifficulty: this._relayCaps.enrollPow,
    });
    if (!res.ok) return {ok: false, error: res.error, transient: res.timedOut === true};

    // Persist under the account that PAID (captured at entry) so an account switch during the long Tor
    // unlock can't file this key under a sibling slot — a cross-silo leak of a metered read capability.
    // Only inject into the process-global in-memory key map + emit when that account is STILL active; if
    // the user switched away, the key stays on disk and loadContentKeys rehydrates it on return.
    await storeContentEpochKey(slot ?? '', res.epoch, res.key);
    if (this.activeSlotId === slot) {
      setContentEpochKey(res.epoch, res.key);
      setEpochUnlockUnavailable(res.epoch, false);
      // F-attribution fix (item 3b): every post already sealed under this epoch just became
      // readable — teach the phonebook from each one's now-decryptable plaintext header BEFORE
      // emit(), mirroring decryptSpaceMessages' post-decrypt learn pattern for group chat. Without
      // this, a member whose ONLY visible content was sealed under this epoch would never teach the
      // phonebook anything until some unrelated re-render happened to touch their post again.
      this.learnFromUnlockedEpoch(res.epoch);
      // The whole-feed cache's key has NO lock component (feedVer/moderators/…): without dropping it
      // here, the just-unlocked items would keep rendering LOCKED off the cached feed until some
      // unrelated store change bumped feedVer. The per-item cache (contentLockState 'L'→'u' in its
      // key) then rebuilds exactly the affected items on the next build.
      this._feedCache = undefined;
      this.emit();
      // A write queued by SealKeyUnavailable (content encryption on, no write key yet) is waiting on
      // exactly this key — retry the durable queue now, mirroring drawTokens' post-draw drain.
      void this.drainPendingPosts();
    }
    return {ok: true};
  }

  /**
   * Provision the CURRENT content epoch's key so seal-on-write works (censorable reads, #4 — SHIPS
   * DARK). Without this a member with the content-encryption flag on has no write key and would post
   * PLAINTEXT (a leak) — so once the organizer announces `stiq:content-epoch` and the relay advertises
   * the flag, the client unlocks that epoch (spending one read token, over Tor) so BlindSigner seals
   * new bodies under it. Idempotent + guarded so overlapping relay syncs don't each burn a token; a
   * no-op unless the flag is on AND an epoch was announced AND it isn't already unlocked. The host
   * calls this on relay sync alongside the proactive token top-up, passing a fresh Tor `connect`.
   */
  async ensureWriteEpoch(connect: () => RelaySocket): Promise<void> {
    if (!this._relayCaps.enforcedFlags.contentEncryption) return; // dark-ship master gate
    const epoch = this._announcedContentEpoch;
    if (epoch === null || !Number.isInteger(epoch) || epoch < 0) return;
    if (hasContentEpochKey(epoch)) return; // already unlocked → we can already write under it
    if (this._writeEpochProvisionInFlight) return;
    this._writeEpochProvisionInFlight = true;
    try {
      await this.unlockContentEpoch(connect, epoch); // spends one read token; caps-gated + idempotent
    } catch {
      // best-effort background provision — a later sync retries
    } finally {
      this._writeEpochProvisionInFlight = false;
    }
  }

  /**
   * True when new writes MUST seal (relay advertises content_encryption + the organizer announced a
   * current epoch): BlindSigner then throws {@link SealKeyUnavailable} on a missing write key instead
   * of silently posting plaintext — the 2026-07-21 leak (ensureWriteEpoch's provision failed and
   * members posted plaintext with no warning). False whenever the feature is off/dark, keeping every
   * existing deployment byte-identical.
   */
  private sealRequiredNow(): boolean {
    return this._relayCaps.enforcedFlags.contentEncryption && this._announcedContentEpoch !== null;
  }

  /**
   * Fresh-enroll preflight for a token draw (2026-07-21 incident). `STIQ_SHORT_LINKS` join codes
   * carry ZERO purpose issuer keys, so until the live `stiq:token-keys` doc is ingested every draw
   * falls back to blinding under the enrollment key — the organizer then either throws "signature
   * representative out of range" or signs a batch the client can't unblind, and the wallet never
   * fills no matter how often the member retries. When the relay advertises domain-separated keys
   * but this community record has NO key for `purpose`, fetch the organizer's live key doc FIRST
   * (bounded, deduped) so the very first draw blinds correctly. A key that is PRESENT but stale is
   * handled downstream by {@link healedTokenDraw}; nothing here blocks the draw on failure — the
   * fallback path is no worse than before this preflight existed.
   */
  private async ensureFreshPurposeKeys(connect: () => RelaySocket, purpose: DrawPurpose): Promise<void> {
    const fps = this._relayCaps.purposeKeyFingerprints;
    const domainSepAdvertised = !!(fps.posting || fps.read || fps.spaceWrite || fps.picture || fps.audio);
    if (!domainSepAdvertised) return;
    const active = this.activeCommunity ?? (await this.communities?.active()) ?? undefined;
    if (!active) return;
    const keyByPurpose: Record<DrawPurpose, string | undefined> = {
      [Purpose.Post]: active.postIssuerPublicKey,
      [Purpose.Read]: active.readIssuerPublicKey,
      [Purpose.PictureWrite]: active.picWriteIssuerPublicKey,
      [Purpose.PictureRead]: active.picReadIssuerPublicKey,
      [Purpose.AudioWrite]: active.audWriteIssuerPublicKey,
      [Purpose.AudioRead]: active.audReadIssuerPublicKey,
      [Purpose.SpaceWrite]: active.spaceWriteIssuerPublicKey,
    };
    if (keyByPurpose[purpose]) return;
    await this.syncTokenKeysNow(connect);
  }

  /**
   * One-shot fetch of the organizer's `stiq:token-keys` (+ `stiq:content-epoch`) docs over a
   * dedicated socket, piped through {@link handleIncomingEvent} — the single ingestion path that
   * validates authorship, applies the patch to the active community, persists it, and re-runs the C5
   * fingerprint rebind. Deduped: concurrent callers (several stale draws at once) share one fetch.
   * Resolves true when a token-keys doc was seen (the caller re-reads the community record for the
   * actual keys — truth lives there, not in this boolean).
   */
  private syncTokenKeysNow(connect: () => RelaySocket): Promise<boolean> {
    const existing = this._tokenKeysSync;
    if (existing) return existing;
    const run = (async (): Promise<boolean> => {
      const organizerHex = this.activeOrganizerHex();
      if (!organizerHex) return false;
      const docs = await fetchOrgConfigDocs({
        connect,
        organizerHex,
        dTags: [TOKEN_KEYS_D_TAG, CONTENT_EPOCH_D_TAG],
      });
      let sawTokenKeys = false;
      for (const doc of docs) {
        if (doc.tags.find(t => t[0] === 'd')?.[1] === TOKEN_KEYS_D_TAG) sawTokenKeys = true;
        this.handleIncomingEvent(doc);
      }
      return sawTokenKeys;
    })();
    this._tokenKeysSync = run.finally(() => {
      this._tokenKeysSync = null;
    });
    return this._tokenKeysSync;
  }

  /**
   * Run a token draw and, on a WRONG-KEY failure (the stale-key family — organizer-reported
   * `stale-blind-key`, a client-side unblind failure, or the C5 mis-provision gate), re-fetch the
   * live `stiq:token-keys` doc and retry EXACTLY ONCE with options rebuilt from the freshly-adopted
   * record. This is what turns the 2026-07-21 "retrying never helps" outage into one extra
   * round-trip: the retry blinds under the organizer's actual signing key. `rebuild` returns null
   * when no fresh community is available — the original failure then stands. Bounded by design (no
   * loop): a retry that fails again is returned as-is, with its own (fresher) error.
   */
  private async healedTokenDraw(
    opts: DrawOptions,
    rebuild: () => Promise<DrawOptions | null>,
  ): Promise<DrawResult> {
    const res = await this.healedTokenDrawInner(opts, rebuild);
    // A draw that just completed is live proof the organizer-mailbox pipe works END-TO-END (Tor
    // circuit up, mailbox answering, response delivered) — exactly the moment a parked auto-unlock
    // deserves its retry. Field case (2026-07-23, Samsung M31 on a slow circuit): a fresh enroll's
    // four unlock attempts all timed out racing the proactive wallet draws through one cold Tor
    // pipe and flipped terminal; the draws then landed minutes later, but with reconnect/
    // foreground/tap (the only revival triggers) never firing, the sealed backlog stayed gray
    // bars for the rest of the session. The epoch a read-draw is currently unlocking is in-flight
    // and skipped by the revive, so this can't re-enter its own unlock.
    if (res.ok) this.reviveStuckEpochUnlocks('draw success (mailbox pipe proven)');
    return res;
  }

  /** The draw + stale-key heal itself — split out so {@link healedTokenDraw} (the only caller) has
   *  one exit to hang the draw-success unlock revival on. */
  private async healedTokenDrawInner(
    opts: DrawOptions,
    rebuild: () => Promise<DrawOptions | null>,
  ): Promise<DrawResult> {
    const first = await runTokenDraw(opts);
    if (first.ok || !isStaleKeyDrawFailure(first)) return first;
    log.warn(
      'wallet',
      `stale-key draw failure (${first.code ?? 'legacy-prose'}) — re-syncing token keys and retrying once`,
    );
    await this.syncTokenKeysNow(opts.connect);
    const retry = await rebuild();
    if (!retry) return first;
    return runTokenDraw(retry);
  }

  /** Backoff ladder for transient auto-unlock failures (Tor flakiness): quick early retries. Once
   *  {@link UNLOCK_MAX_TRANSIENT_ATTEMPTS} are exhausted with no answer at all, the epoch stops
   *  pretending "any moment now" and flips to the SAME terminal `unlockUnavailable` state a real
   *  organizer refusal gets (2026-07-22: prod's permanent gray bars — pending never used to
   *  terminate, so a dead mailbox or a device that never got a live Tor circuit sat locked forever).
   *  A FATAL state (refusal OR exhausted) then retries only every {@link UNLOCK_FATAL_BACKOFF_MS} —
   *  the quiet members-only card stands meanwhile — UNLESS a reconnect/foreground/tap revives it
   *  sooner (see {@link reviveStuckEpochUnlocks}, {@link retryEpochUnlock}). */
  private static readonly UNLOCK_RETRY_BACKOFF_MS = [15_000, 30_000, 45_000];
  private static readonly UNLOCK_MAX_TRANSIENT_ATTEMPTS = 4;
  private static readonly UNLOCK_FATAL_BACKOFF_MS = 30 * 60_000;

  /**
   * The INVISIBLE unlock path (members-only content, 2026-07-21 redesign): the render layer calls
   * this with the epochs of sealed items it just built, and each still-locked epoch gets a background
   * read-token unlock — no tap, no prompt. When the key lands, emit() re-renders the items decrypted
   * (their cache key carries contentLockState, so L→u rebuilds). Members in good standing therefore
   * never SEE the feature: at worst a brief neutral placeholder on the very first sealed item per
   * epoch. Once an epoch's unlocks keep failing — either an outright organizer REFUSAL, or
   * {@link UNLOCK_MAX_TRANSIENT_ATTEMPTS} transient (Tor/timeout) failures with no answer at all —
   * it flips to the one user-visible state: the quiet members-only card (see
   * {@link epochAccessState}). Deduped per epoch, backoff on failure, cleared on community/account
   * switch. Safe to call on every feed build (cheap no-op for unlocked epochs).
   *
   * NOTE on `deps.connectForDraw` while Tor/WS is still connecting: the host (App.tsx) wires this as
   * a wrapper that THROWS synchronously until the relay socket factory is late-bound (i.e. before the
   * first connect), not as `undefined` — so the `!connect` guard below essentially never fires in
   * production. The actual failure when offline happens one level down (unlockContentEpoch /
   * runReadUnlock / runTokenDraw all catch a throwing `connect()` and report it as a TRANSIENT
   * result), so a request that can't reach the wire is never silently dropped mid-attempt — it comes
   * back here as `res.transient` and re-enters the ladder below. The part that WAS silently dropped
   * (see the 2026-07-22 investigation) is what happens to `st.nextAt` once it's set: nothing but
   * another call to `noteLockedEpochs` ever re-checks it, and a quiet feed (no new relay events, so
   * the feed-cache hit path never calls {@link noteFeedLocks} again) means that call may never come.
   * {@link reviveStuckEpochUnlocks} closes that gap by actively re-kicking on reconnect/foreground.
   */
  noteLockedEpochs(epochs: Iterable<number>): void {
    const connect = this.deps.connectForDraw;
    if (!connect || !this.identity) return;
    for (const epoch of epochs) {
      if (!Number.isInteger(epoch) || epoch < 0 || hasContentEpochKey(epoch)) continue;
      const st = this._epochUnlock.get(epoch) ?? {inFlight: false, attempts: 0, nextAt: 0, lastFatal: false};
      if (st.inFlight || Date.now() < st.nextAt) continue;
      st.inFlight = true;
      this._epochUnlock.set(epoch, st);
      log.info('unlock', `epoch ${epoch} requested (attempt ${st.attempts + 1})`);
      this.noteUnlockAttempt(); // perf: epoch-unlock attempt cadence (count/minute)
      // SEQUENTIAL, never parallel: each unlock spends from the ONE read wallet, and concurrent
      // spend()s on the same EpochWallet race its read-modify-write persistence (observed to strand
      // the whole balance). One Tor round-trip at a time also mirrors stockAuxiliaryWallets'
      // deliberate pacing. The chain never rejects (both continuations settle it).
      this._epochUnlockChain = this._epochUnlockChain
        .then(() => this.unlockContentEpoch(connect, epoch, {sealedItem: true}))
        .then(res => {
          st.inFlight = false;
          if (res.ok) {
            const decrypted = this.countSealedPostsForEpoch(epoch);
            log.info('unlock', `epoch ${epoch} K_E applied — ${decrypted} cached post(s) now decrypt`);
            this._epochUnlock.delete(epoch);
            return;
          }
          st.attempts++;
          if (res.transient) {
            if (st.attempts >= AppRuntime.UNLOCK_MAX_TRANSIENT_ATTEMPTS) {
              // Exhausted the ladder with no answer at all (dead mailbox, no Tor circuit ever landed,
              // …) — stop pretending "any moment now" and give the quiet card, same as a refusal.
              log.warn(
                'unlock',
                `epoch ${epoch} exhausted ${st.attempts} attempts with no answer (${res.error}) — terminal (unlockUnavailable)`,
              );
              this.markEpochTerminal(epoch, st);
            } else {
              const ladder = AppRuntime.UNLOCK_RETRY_BACKOFF_MS;
              const wait = ladder[Math.min(st.attempts - 1, ladder.length - 1)]!;
              log.info(
                'unlock',
                `epoch ${epoch} transient failure (attempt ${st.attempts}/${AppRuntime.UNLOCK_MAX_TRANSIENT_ATTEMPTS}): ${res.error} — retrying in ${wait}ms`,
              );
              st.nextAt = Date.now() + wait;
            }
          } else {
            // Organizer refused (revoked reader / allowance spent / spent token) — immediately
            // terminal regardless of attempt count; retrying wouldn't change an explicit refusal.
            log.warn('unlock', `epoch ${epoch} refused by organizer: ${res.error} — terminal (unlockUnavailable)`);
            this.markEpochTerminal(epoch, st);
          }
          this.armEpochUnlockTimer(); // honor the schedule this failure just set (see the method doc)
        })
        .catch(err => {
          st.inFlight = false;
          st.attempts++;
          log.warn(
            'unlock',
            `epoch ${epoch} unlock threw unexpectedly (attempt ${st.attempts}): ${(err as Error)?.message ?? err}`,
          );
          if (st.attempts >= AppRuntime.UNLOCK_MAX_TRANSIENT_ATTEMPTS) {
            this.markEpochTerminal(epoch, st);
          } else {
            st.nextAt = Date.now() + 60_000;
          }
          this.armEpochUnlockTimer();
        });
    }
  }

  /** Flip `epoch` to the terminal `unlockUnavailable` state (shared by refusal + exhausted-ladder
   *  paths): slow backoff, the quiet members-only card, item-cache key bump so PostCard's memo
   *  actually repaints off it (see feed.ts's 'L' vs 'Lx' key). */
  private markEpochTerminal(epoch: number, st: {lastFatal: boolean; nextAt: number}): void {
    st.lastFatal = true;
    st.nextAt = Date.now() + AppRuntime.UNLOCK_FATAL_BACKOFF_MS;
    setEpochUnlockUnavailable(epoch, true);
    this._feedCache = undefined; // same array identity would keep memoized rows on 'pending'
    this.emit(); // flip the card from pending → unavailable
  }

  /** How many cached sealed posts of `epoch` exist — telemetry only (logged once K_E lands so a
   *  logcat grep for 'unlock' shows how many cards a single answer actually repaints). Best-effort:
   *  a query failure (e.g. a test double store) never blocks the unlock itself. */
  private countSealedPostsForEpoch(epoch: number): number {
    try {
      return this.deps.store
        .query({unordered: true})
        .filter(e => isSealedContent(e) && contentEpochOf(e) === epoch).length;
    } catch {
      return 0;
    }
  }

  /**
   * Tap-to-retry (the terminal `unlockUnavailable` card, PostCard's members-only banner): a member
   * manually retrying resets the epoch's attempt counter/backoff and kicks ONE fresh attempt right
   * away. Safe to call for an epoch `noteLockedEpochs` never saw yet (registers a fresh slot). A
   * still-revoked member simply flips straight back to unavailable once the retry's answer lands —
   * this can't manufacture access that was genuinely refused.
   */
  retryEpochUnlock(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 0 || hasContentEpochKey(epoch)) return;
    const st = this._epochUnlock.get(epoch);
    if (st?.inFlight) return; // already mid-attempt — nothing to reset
    log.info(
      'unlock',
      `epoch ${epoch} manual retry (tap) — resetting attempts (was ${isEpochUnlockUnavailable(epoch) ? 'unavailable' : 'pending'})`,
    );
    if (st) {
      st.attempts = 0;
      st.lastFatal = false;
      st.nextAt = 0;
    }
    setEpochUnlockUnavailable(epoch, false);
    this._feedCache = undefined;
    this.emit();
    this.noteLockedEpochs([epoch]);
  }

  /**
   * Reconnect / foreground revival: a fresh Tor circuit or the app returning to the foreground is
   * exactly the moment a stuck unlock deserves ONE new attempt — a member should never have to know
   * to tap. Resets EVERY non-in-flight epoch's backoff/attempt count (including a TERMINAL one) and
   * actively RE-KICKS `noteLockedEpochs` — merely clearing the gate and hoping some future feed
   * rebuild calls back in is not enough: `noteFeedLocks` only runs on an actual feed-cache MISS (a
   * new event/reaction/comment bumping `feedVer`), so on a quiet feed nothing would ever re-check
   * `nextAt` again. That reactive-only design is the likely 2026-07-22 prod gap: a device whose very
   * first attempt fires before the relay socket is live (`deps.connectForDraw` still throwing) fails
   * once, schedules a retry 15-45s out, and then — if the feed never changes again — NOTHING ever
   * calls back in to honor it. A still-revoked member flips straight back to unavailable once this
   * retry's answer lands, so this can't undo a real refusal.
   */
  private reviveStuckEpochUnlocks(reason: string): void {
    const toKick: number[] = [];
    for (const [epoch, st] of this._epochUnlock) {
      if (st.inFlight) continue;
      if (st.attempts > 0 || st.lastFatal) {
        log.info(
          'unlock',
          `epoch ${epoch} revived on ${reason} (was ${st.lastFatal ? 'unavailable' : 'pending'}, ${st.attempts} prior attempt(s))`,
        );
      }
      st.attempts = 0;
      st.lastFatal = false;
      st.nextAt = 0;
      setEpochUnlockUnavailable(epoch, false);
      toKick.push(epoch);
    }
    if (toKick.length === 0) return;
    this._feedCache = undefined; // drop any 'Lx' terminal card before the render loop sees the reset
    this.emit();
    this.noteLockedEpochs(toKick);
  }

  /** Serializes every auto-unlock (see noteLockedEpochs) — settled links only, never rejects. */
  private _epochUnlockChain: Promise<void> = Promise.resolve();

  /** The ladder's scheduler (see {@link armEpochUnlockTimer}) — undefined when nothing is scheduled. */
  private _epochUnlockTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * One timer that honors the ladder's OWN schedule (`st.nextAt`). Without it, a scheduled retry —
   * the 15-45s transient backoff or the 30-minute terminal backoff — only ever fired if something
   * ELSE called noteLockedEpochs again (a feed-cache miss) or a reconnect/foreground/tap revival
   * landed. A session that stays connected and foregrounded on a quiet feed honors NONE of those
   * (the 2026-07-23 M31 field report: sealed backlog stayed gray bars for a whole session), so
   * "retries every UNLOCK_FATAL_BACKOFF_MS" was documentation, not behavior. Re-armed after every
   * attempt settles; cleared on community/account switch (clearSwitchCaches) and dispose().
   */
  private armEpochUnlockTimer(): void {
    if (this._epochUnlockTimer !== undefined) {
      clearTimeout(this._epochUnlockTimer);
      this._epochUnlockTimer = undefined;
    }
    let soonest = Infinity;
    for (const st of this._epochUnlock.values()) {
      if (!st.inFlight && st.nextAt > 0 && st.nextAt < soonest) soonest = st.nextAt;
    }
    if (!Number.isFinite(soonest)) return;
    // Min 1s so a nextAt that's already past (armed late, after a long-settling attempt) can never
    // hot-loop; each firing either kicks attempts (which re-arm on settle) or re-arms further out.
    this._epochUnlockTimer = setTimeout(() => {
      this._epochUnlockTimer = undefined;
      const now = Date.now();
      const due: number[] = [];
      for (const [epoch, st] of this._epochUnlock) {
        if (!st.inFlight && st.nextAt > 0 && now >= st.nextAt) due.push(epoch);
      }
      if (due.length > 0) this.noteLockedEpochs(due);
      this.armEpochUnlockTimer(); // anything scheduled but not yet due gets the next window
    }, Math.max(1_000, soonest - Date.now()));
  }

  /**
   * How a still-locked epoch should render: 'pending' (an unlock is in flight / will retry — show a
   * neutral loading treatment, the member is not meant to notice) vs 'unavailable' (the organizer
   * REFUSED an unlock — the one deliberately user-visible state, shown as a quiet members-only
   * card). An unlocked epoch never reaches this (resolveContent already decrypted it).
   */
  epochAccessState(epoch: number): 'pending' | 'unavailable' {
    return this._epochUnlock.get(epoch)?.lastFatal ? 'unavailable' : 'pending';
  }

  /** The calm reason shown when a write fails on an empty wallet WHOSE refill failed on stale keys:
   *  honest about the actual cause (key re-sync, fixes itself) instead of blaming the connection. */
  private static readonly KEY_RESYNC_REASON =
    'Your community updated its security keys — the app is re-syncing them now. This will send automatically in a moment.';
  /** The calm reason when the wallet is empty because the organizer's epoch allowance is genuinely
   *  SPENT (the last refill came back ok-but-empty): the default exhaustion copy says "check your
   *  connection", which sends a member whose quota ran out off to debug a network that is fine —
   *  the mirror image of the 2026-07-21 mislead, surfaced by the 2026-07-28 arti outage. */
  private static readonly QUOTA_SPENT_REASON =
    "You've used this community's posting allowance for now — it refills automatically. This will send once it does.";
  /** How long a recorded draw failure may explain a subsequent exhaustion before it goes stale. */
  private static readonly DRAW_FAILURE_REASON_TTL_MS = 10 * 60_000;

  /**
   * The user-facing reason for a failed send. For a token-exhaustion failure, consults the most
   * recent draw failure: when the wallet is empty BECAUSE the community's issuer keys changed under
   * us (the stale-key family), says so — "check your connection" was the 2026-07-21 incident's
   * misleading dead-end, sending members off to debug their network while retries could never help.
   * When the wallet is empty because the last refill returned ok-but-EMPTY (allowance spent), says
   * THAT — the connection copy misleads in the opposite direction. A draw that merely timed out
   * keeps the default connection copy, which is then the truth. Every string returned for the
   * exhaustion family is one of the calm, pre-written messages — raw draw/token prose still never
   * reaches a user (F2/F4/B6 unchanged).
   */
  exhaustionReason(e: unknown): string {
    if (e instanceof BlindTokensExhausted) {
      const f = this._lastDrawFailure;
      if (f !== null && Date.now() - f.at < AppRuntime.DRAW_FAILURE_REASON_TTL_MS) {
        if (isStaleKeyDrawFailure({ok: false, error: f.error, code: f.code})) {
          return AppRuntime.KEY_RESYNC_REASON;
        }
        if (f.quotaSpent) return AppRuntime.QUOTA_SPENT_REASON;
      }
      return e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }

  /**
   * Throttled background key re-sync, kicked when the C5 check finds a fingerprint mismatch it
   * cannot enforce (advisory mode): instead of only logging a warning and waiting for the live
   * stream to happen to deliver a corrected doc, actively fetch it — a present-but-wrong key then
   * heals within one round-trip of being detected, before any draw fails on it.
   */
  private scheduleKeyResync(): void {
    const connect = this.deps.connectForDraw;
    if (!connect) return;
    const now = Date.now();
    if (now - this._lastKeyResyncAt < 10 * 60_000) return;
    this._lastKeyResyncAt = now;
    void this.syncTokenKeysNow(connect).catch(() => {});
  }

  /** Persist my DM reactions so they survive a restart (the peer's copy lives in the wrap cache). */
  private async saveDmReactions(): Promise<void> {
    if (!this.deps.secureStorage) return;
    try {
      await this.deps.secureStorage.setItem(this.dmReactionsItem(), JSON.stringify(this.myDmReactions));
    } catch {
      // best effort
    }
  }

  /** Restore my persisted DM reactions on startup. */
  private applyDmReactions(raw: string | null | undefined): void {
    // Parse-only (no I/O): mirrors the old loadDmReactions exactly — an empty/absent value leaves the
    // current list untouched, a present value replaces it. Fed by hydratePerSlotSecureReads.
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {targetRumorId?: string; emoji?: string}[];
      this.myDmReactions.length = 0;
      for (const r of parsed) {
        if (r?.targetRumorId && r?.emoji) this.myDmReactions.push({targetRumorId: r.targetRumorId, emoji: r.emoji});
      }
    } catch {
      // ignore corrupt cache
    }
  }

  /**
   * Cache the user's hex pubkey when enrolled; clear it otherwise.
   *
   * Fast path: the key ring persists each slot's npub as plaintext metadata at enrollment time
   * (`KeySlot.npub` — no secret material). Bech32-decoding that npub yields the exact same hex pubkey
   * as reading the secret key and running secp256k1 `getPublicKey()`, but skips BOTH the secret-key
   * keystore read and the EC scalar-mult on every single launch. Falls back to the secret-key path
   * (via `identity.info()`) when there is no active slot (pre-silo legacy identity) or the persisted
   * npub is missing/undecodable — so a corrupt/older record never leaves myPubkey unset.
   */
  private async loadPubkey(): Promise<void> {
    if (!this.identity || !this.enrolled) {
      this.myPubkey = undefined;
      return;
    }
    if (this.activeSlotId && this.keyRing) {
      try {
        const slots = await this.keyRing.listSlots();
        const npub = slots.find(s => s.id === this.activeSlotId)?.npub;
        if (npub) {
          const decoded = nip19.decode(npub);
          if (decoded.type === 'npub' && typeof decoded.data === 'string') {
            this.myPubkey = decoded.data;
            return;
          }
        }
      } catch {
        // fall through to the secret-key path below
      }
    }
    try {
      this.myPubkey = (await this.identity.info()).pubkey;
    } catch {
      this.myPubkey = undefined;
    }
  }

  /**
   * The user's hex pubkey when enrolled, else undefined. Synchronous so the relay
   * subscription plan can scope DM cover traffic on socket open without awaiting the keystore.
   */
  getPubkey(): string | undefined {
    return this.enrolled ? this.myPubkey : undefined;
  }

  /** Active KeyRing slot id (the ACCOUNT namespace), or undefined un-enrolled. Synchronous so the
   *  host can key the per-(cid, slot) feed-snapshot floor on (re)connect without awaiting storage. */
  getActiveSlotId(): string | undefined {
    return this.activeSlotId;
  }

  /** Organizer Nostr pubkey for the active community (synchronous, for subscription plan). */
  getOrganizerPubkey(): string | undefined {
    return this.activeOrganizerPubkey;
  }

  /**
   * Secondary mirrors for MirrorSet (P2 synthesis §1.6/§1.9): every relay in the active community's
   * effective mirror set EXCEPT the one the caller is already connecting to as primary, mapped down
   * to the {url, onionAuthKey} shape MirrorSet's constructor consumes. Synchronous (reads the
   * community cached by loadActiveCommunityPolicy / a durably-accepted live `stiq:mirrors` update)
   * so App.tsx can call it inline while building the primary relay socket — no extra relay/storage
   * round trip on the connect path. Returns [] before any community resolves (un-enrolled / cold
   * init) or once `effectiveMirrors` has nothing left after excluding the primary, so a build with
   * a single known mirror stays a MirrorSet with zero secondaries — byte-identical to today.
   */
  activeSecondaryMirrors(primaryUrl: string): MirrorSpec[] {
    if (!this.activeCommunity) return [];
    const primaryHost = onionHostOf(primaryUrl) ?? primaryUrl;
    return effectiveMirrors(this.activeCommunity)
      .filter(m => (onionHostOf(m.url) ?? m.url) !== primaryHost)
      .map(m => ({url: m.url, onionAuthKey: m.onionAuthKey ?? null}));
  }

  /**
   * Known-good mirror capture (P2 synthesis §1.2 / MF-1) — the PRODUCER the un-evictable mirror tier
   * was missing. MirrorSet calls this (via App.tsx's `onMirrorObservedGood`) with a secondary this
   * device has SEEN serve valid community content: promoted to primary, or delivering a confirmed
   * recent FEED_KINDS delta a withholding primary should have served. We upsert its spec into the
   * ACTIVE community's `mirrorsKnownGood` — a tier {@link effectiveMirrors} unions and the org can
   * NEVER drop (a `stiq:mirrors` doc only ever replaces `mirrorsOrg`, and `upsert`'s absent-stays-
   * absent guard forbids erasure). So once trusted, no org de-list can retract this mirror: the whole
   * point of the fix. Deduped by onion host (re-observing the same mirror is a no-op). Updates the
   * in-memory cache synchronously so a subsequent `activeSecondaryMirrors()` reflects it at once, then
   * persists against the FRESHEST stored record so a racing org-config/switch write isn't clobbered.
   * Fire-and-forget; a storage hiccup just means it's re-captured on the next confirmed delta.
   */
  recordKnownGoodMirror(spec: MirrorSpec): void {
    const cached = this.activeCommunity;
    if (!this.communities || !cached) return;
    const host = onionHostOf(spec.url) ?? spec.url.trim().toLowerCase();
    const hasHost = (list: RelayEntry[] | undefined): boolean =>
      (list ?? []).some(m => (onionHostOf(m.url) ?? m.url.trim().toLowerCase()) === host);
    if (hasHost(cached.mirrorsKnownGood)) return; // already trusted — no-op
    const entry: RelayEntry = {url: spec.url, onionAuthKey: spec.onionAuthKey ?? null};
    // Synchronous cache update so effectiveMirrors/activeSecondaryMirrors see it immediately (and a
    // later org de-list recomputes to a set that still contains it).
    this.activeCommunity = {...cached, mirrorsKnownGood: [...(cached.mirrorsKnownGood ?? []), entry]};
    // Durable persist against the latest stored record for THIS community only.
    void this.communities.active().then(active => {
      if (!active || active.id !== cached.id || hasHost(active.mirrorsKnownGood)) return;
      // Assert ONLY mirrorsKnownGood against the freshest stored record; OMIT mirrorsOrg/mirrorsOrgAt/
      // mirrorsUser so the absent-stays-absent guard preserves a concurrent org-config write (§7).
      const next = {...active, mirrorsKnownGood: [...(active.mirrorsKnownGood ?? []), entry]};
      delete next.mirrorsOrg;
      delete next.mirrorsOrgAt;
      delete next.mirrorsUser;
      void this.communities?.upsert(next);
    });
  }

  /** Onion-host identity key for a relay url (ws://host, wss://host, trailing slash are one relay). */
  private relayHostKey(url: string): string {
    return onionHostOf(url) ?? url.trim().toLowerCase();
  }

  /**
   * Push the active community's current {@link effectiveMirrors} onto the LIVE transport without a
   * reconnect (synthesis §1.9): refresh the reconcile-only secondary set, and keep the Tor daemon's
   * secondary onion-auth set in lock-step. A reconnect is requested ONLY when the auth set GREW with a
   * new auth-gated mirror (Tor reads ClientOnionAuthDir only at startup); a public newcomer or a
   * shrink/mute is applied live by updateSecondaryMirrors. No-op before a community resolves. Callers
   * must have already updated `this.activeCommunity` so effectiveMirrors reflects the change here.
   */
  private pushMirrorsLive(): void {
    const c = this.activeCommunity;
    if (!c) return;
    this.deps.onMirrorsChanged?.(this.activeSecondaryMirrors(c.relayUrl));
    const prevExtra = getActiveOnionAuthExtra();
    const nextExtra = deriveOnionAuthSet(effectiveMirrors(c));
    if (!sameOnionAuthSet(prevExtra, nextExtra)) {
      setActiveOnionAuthExtra(nextExtra);
      const grew = nextExtra.some(n => !prevExtra.some(p => p.onionHost === n.onionHost));
      if (grew) this.deps.requestRelayReconnect?.();
    }
  }

  /**
   * Commit the member's user-controlled relay tiers (mirrorsUser + mirrorsBlocked) for the active
   * community: update the in-memory cache synchronously so {@link relaySnapshot} + effectiveMirrors
   * reflect it at once, adopt the change on the live transport, then persist against the FRESHEST
   * stored record for this community. Asserts ONLY the two user tiers (omits mirrorsOrg/mirrorsOrgAt/
   * mirrorsKnownGood) so upsert's absent-stays-absent guard preserves a concurrent org-config or
   * known-good write (§7 race), exactly like {@link recordKnownGoodMirror}.
   */
  private async commitUserRelays(
    base: EnrolledCommunity,
    mirrorsUser: RelayEntry[],
    mirrorsBlocked: RelayEntry[],
  ): Promise<void> {
    this.activeCommunity = {...base, mirrorsUser, mirrorsBlocked};
    this.pushMirrorsLive();
    this.emit();
    if (!this.communities) return;
    const active = await this.communities.active();
    if (!active || active.id !== base.id) return; // member switched community mid-edit
    const next: EnrolledCommunity = {...active, mirrorsUser, mirrorsBlocked};
    delete next.mirrorsOrg;
    delete next.mirrorsOrgAt;
    delete next.mirrorsKnownGood;
    await this.communities.upsert(next);
  }

  /**
   * Add a member-chosen mirror to the active community's `mirrorsUser` tier ("decide what relays they
   * receive from"). De-duped by onion host and capped at MAX_MIRRORS; adding a relay also UN-mutes it
   * (adding = wanting to receive). Never adds the primary as a mirror. Adopted live + persisted.
   */
  async addUserMirror(spec: MirrorSpec): Promise<void> {
    const c = this.activeCommunity;
    if (!c) return;
    const host = this.relayHostKey(spec.url);
    if (host === this.relayHostKey(c.relayUrl)) return; // the primary is not a mirror
    if ((c.mirrorsUser ?? []).some(m => this.relayHostKey(m.url) === host)) return; // already added
    const entry: RelayEntry = {url: spec.url, onionAuthKey: spec.onionAuthKey ?? null};
    const mirrorsUser = [...(c.mirrorsUser ?? []), entry].slice(0, MAX_MIRRORS);
    const mirrorsBlocked = (c.mirrorsBlocked ?? []).filter(m => this.relayHostKey(m.url) !== host);
    await this.commitUserRelays(c, mirrorsUser, mirrorsBlocked);
  }

  /** Remove a member-added mirror (by onion host) from `mirrorsUser`. Adopted live + persisted. */
  async removeUserMirror(host: string): Promise<void> {
    const c = this.activeCommunity;
    if (!c) return;
    const mirrorsUser = (c.mirrorsUser ?? []).filter(m => this.relayHostKey(m.url) !== host);
    await this.commitUserRelays(c, mirrorsUser, c.mirrorsBlocked ?? []);
  }

  /**
   * Mute ("close from") a relay: add it to the device-only `mirrorsBlocked` tier so effectiveMirrors
   * subtracts it. Never mutes the PRIMARY (the app must keep ≥1 relay — the UI hides mute there). The
   * full spec is stored so unmute/UI can still name the relay even if the organizer later drops it from
   * every tier. Adopted live (the muted secondary is disconnected) + persisted.
   */
  async muteMirror(spec: MirrorSpec): Promise<void> {
    const c = this.activeCommunity;
    if (!c) return;
    const host = this.relayHostKey(spec.url);
    if (host === this.relayHostKey(c.relayUrl)) return; // primary is never muted
    if ((c.mirrorsBlocked ?? []).some(m => this.relayHostKey(m.url) === host)) return; // already muted
    const entry: RelayEntry = {url: spec.url, onionAuthKey: spec.onionAuthKey ?? null};
    await this.commitUserRelays(c, c.mirrorsUser ?? [], [...(c.mirrorsBlocked ?? []), entry]);
  }

  /** Un-mute a relay (by onion host): remove it from `mirrorsBlocked` so it can be received from again. */
  async unmuteMirror(host: string): Promise<void> {
    const c = this.activeCommunity;
    if (!c) return;
    const mirrorsBlocked = (c.mirrorsBlocked ?? []).filter(m => this.relayHostKey(m.url) !== host);
    await this.commitUserRelays(c, c.mirrorsUser ?? [], mirrorsBlocked);
  }

  /** The Relays-screen snapshot for the active community (null before a community resolves). */
  relaySnapshot(): RelaysSnapshot | null {
    return this.activeCommunity ? describeRelays(this.activeCommunity) : null;
  }

  /**
   * The negotiated relay capabilities (what the relay actually enforces). Always defined: returns
   * the constant-derived fallback before the first successful NIP-11 fetch, or if the relay
   * advertises no stiq-capabilities block, so callers never special-case "unknown". Refreshed once
   * per relay (re)connect. Currently drives the NIP-29 managed-group gate; PoW/domain-sep/kinds are
   * intentionally NOT consumed yet (later waves).
   */
  relayCapabilities(): RelayCapabilities {
    return this._relayCaps;
  }

  /**
   * The active community's shared community key (base64), or undefined for a v1/v2 community.
   * The blind-posting layer uses it to attribute posts locally while the relay stays blind; it is
   * per-community (each silo carries its own), so it re-resolves on every community switch.
   */
  getActiveCommunityKey(): string | undefined {
    return this.activeCommunityKey;
  }

  /** Load organizer config (tag policy, labels, post rules, reasons) + pubkey from the active community. */
  /** The in-flight {@link loadActiveCommunityPolicy} run, so a blind-eligible write racing a cold
   *  start / community switch can wait for the community key instead of falling back to a tokenless
   *  npub sign that a blind community is guaranteed to reject ([token_required]). Null when idle. */
  private _policyLoad: Promise<void> | null = null;

  private loadActiveCommunityPolicy(): Promise<void> {
    const run = this.loadActiveCommunityPolicyInner();
    this._policyLoad = run;
    return run.finally(() => {
      if (this._policyLoad === run) this._policyLoad = null;
    });
  }

  private async loadActiveCommunityPolicyInner(): Promise<void> {
    if (!this.communities) return;
    const active = await this.communities.active();
    // P2 MirrorSet (synthesis §1.2/§1.6): cache the whole record so activeSecondaryMirrors() can
    // compute effectiveMirrors() synchronously off the ACTIVE community without another storage
    // round trip on the relay-connect path. undefined (not null) so the field's absence reads the
    // same as "unresolved" everywhere else in this class.
    this.activeCommunity = active ?? undefined;
    // RESET each organizer-config field to its default BEFORE applying the active community's values,
    // so a community that omits a field (or switching to one that never set it) can never inherit the
    // PREVIOUS community's tagPolicy/labels/postRules/reasons/ranking (a cross-community config leak).
    // pictureRules already normalises absent→default; the rest now mirror it.
    this.tagPolicy = active?.tagPolicy ?? DEFAULT_TAG_POLICY;
    this.labels = active?.labels ?? DEFAULT_LABELS;
    this.postRules = active?.postRules ?? DEFAULT_POST_RULES;
    this.postRulesAt = active?.postRulesAt ?? 0;
    this.postingGuidelines = active?.postingGuidelines ?? null;
    this.pictureRules = normalizePictureRules(active?.pictureRules);
    setPicturePeriodHours(this.pictureRules.periodHours);
    this.audioRules = normalizeAudioRules(active?.audioRules);
    setActiveAudioRules(this.audioRules);
    this.reasons = active?.reasons ?? DEFAULT_REASONS;
    this.ranking = active?.ranking ?? DEFAULT_RANKING;
    this.activeOrganizerPubkey = active?.organizerPubkey;
    // Pick up the last-known content epoch (censorable reads, #4) for the ACTIVE community so a
    // returning member can provision the write key before a fresh announcement arrives. Absent until
    // the organizer runs content sealing.
    this._announcedContentEpoch = active?.contentEpoch ?? null;
    // v3: the shared community key rides in the community record (per-community secret). Re-read it
    // on every switch so a blind-posting consumer always sees the ACTIVE community's key.
    this.activeCommunityKey = active?.communityKey;
    // Bind every per-purpose wallet's issuer-key fingerprint from the just-resolved active community,
    // then re-run the C5 domain-separation check. Extracted (T1.4/F6) so the IDENTICAL rebind can also
    // run from a live `stiq:token-keys` re-sync (see handleIncomingEvent's TOKEN_KEYS_D_TAG handling),
    // not just full community resolution — reads `this.activeCommunity`, already set above.
    this.rebindPurposeKeyFingerprints();
    // Keep the blind layer's synchronous in-memory key in lock-step with the ACTIVE community, so
    // blind posts encrypt/attribute under the current community's key — never a stale one after a
    // switch. (Replaces the pre-silo global loadCommunityKey(): master carries the key per-community.)
    setActiveCommunityKey(active?.communityKey ? decodeCommunityKey(active.communityKey) : null);
    // Rehydrate the per-account content-epoch keys (C7 read meter) for the active slot from secure
    // storage, in lock-step with the community key. loadContentKeys clears the previous slot's
    // in-memory keys FIRST, so a switch never leaks an unlocked content window across the silo
    // boundary. Ships dark: the store is empty until unlockContentEpoch persists a key (caps-gated),
    // so today this loads nothing and _writeEpoch stays -1 (BlindSigner keeps posts plaintext).
    await loadContentKeys(this.activeSlotId ?? '');
    // Auto-unlock bookkeeping is per-(community, account) — epochs are community-scoped and the read
    // budget is per-account — so a switch starts it fresh (a denial there isn't a denial here).
    this._epochUnlock.clear();
    if (this._epochUnlockTimer !== undefined) {
      clearTimeout(this._epochUnlockTimer);
      this._epochUnlockTimer = undefined;
    }
    clearEpochUnlockDisplay();
    // Keep the active onion-auth reach credential (lever 2) in lock-step with the ACTIVE community
    // too, so the Tor manager reconnects to the members-only onion with the current community's key.
    // Null for a public onion. App.tsx reads getActiveOnionAuth() before (re)connecting.
    setActiveOnionAuth(active ? deriveOnionAuth(active.relayUrl, active.onionAuthKey) : null);
    // Same lock-step for the SECONDARY mirrors' onion-auth credentials (P2 §1.7/§1.9): every
    // effective mirror that carries its own client-auth key gets it written before the Tor daemon
    // starts. Empty when the active community has no secondaries or none are auth-gated — a
    // single-mirror/public-onion build stays byte-identical to today (no auth files beyond primary).
    setActiveOnionAuthExtra(active ? deriveOnionAuthSet(effectiveMirrors(active)) : []);
    clearAuthorCache();
  }

  /**
   * (Re)bind every per-purpose wallet's issuer-key fingerprint from the ACTIVE community record, then
   * re-run the C5 domain-separation check. Reads `this.activeCommunity` — the caller must have already
   * set/updated it. Runs from THREE points where the active community's keys can change:
   *   1. Full community resolution (loadActiveCommunityPolicyInner — cold init, community switch).
   *   2. A caps refresh (verifyCommunityProvisioning is also re-run directly from onRelayConnected,
   *      but the keys themselves don't change there, only the relay's advertised fingerprints).
   *   3. (T1.4/F6) A live `stiq:token-keys` re-sync (handleIncomingEvent's TOKEN_KEYS_D_TAG case),
   *      so a member whose invite was mis-provisioned SELF-HEALS the moment the organizer republishes
   *      a corrected key — no restart, no re-enrollment. Without this, a stale/mis-provisioned C5
   *      block would be a PERMANENT brick until the next cold start, exactly the failure mode F6/F8
   *      warn against ("the whole mechanism silently no-ops → clients never converge").
   */
  private rebindPurposeKeyFingerprints(): void {
    const active = this.activeCommunity;
    // Bind the active community's posting-token issuer-key fingerprint onto the (already-rebuilt)
    // wallet. This is the SINGLE authoritative point where the active community — and thus its
    // posting key — is resolved for every entry path, so it's where the wallet learns which issuer
    // key its tokens must match. A domain-sep cutover or key rotation changes this fingerprint, and
    // the wallet then discards the now-unspendable batch on its next load so the normal top-up
    // redraws under the current key. Absent community ⇒ undefined ⇒ reconciliation disabled.
    const postKey = active?.postIssuerPublicKey ?? active?.issuerPublicKey;
    this.activePostKeyFp = postKey ? walletKeyFingerprint(postKey) : undefined;
    this.wallet?.setKeyFingerprint(this.activePostKeyFp);
    // C5 — remember the READ-token issuer-key fingerprint too, then verify ALL of them against the
    // relay's advertised purpose-key fingerprints. This is the single authoritative point where the
    // active community's keys are resolved, so it's where a stale/mis-provisioned invite is caught.
    const readKey = active?.readIssuerPublicKey;
    this.activeReadKeyFp = readKey ? walletKeyFingerprint(readKey) : undefined;
    // Bind the read wallet to the active community's K_read fingerprint so a K_read rotation /
    // domain-sep cutover self-heals the same way the posting wallet does (discard the stale batch,
    // redraw on the next unlock). Absent read key ⇒ undefined ⇒ reconciliation disabled. (Dark today.)
    this.tokenPool?.setKeyFingerprint(Purpose.Read, this.activeReadKeyFp);
    // T1.4/F6: track the two media WRITE-issuer fingerprints the relay actually verifies (matching
    // mediaWriteDomains / the `stiq_dom` picture|audio vocabulary) so C5 can catch a stale key on
    // these domains too. Media-READ has no consumption path anywhere (F12) and stays out of scope.
    const pictureKey = active?.picWriteIssuerPublicKey ?? active?.issuerPublicKey;
    this.activePictureWriteKeyFp = pictureKey ? walletKeyFingerprint(pictureKey) : undefined;
    const audioKey = active?.audWriteIssuerPublicKey ?? active?.issuerPublicKey;
    this.activeAudioWriteKeyFp = audioKey ? walletKeyFingerprint(audioKey) : undefined;
    // Bind each of the four media wallets to its own community issuer-key fingerprint, the same way —
    // a per-media key rotation / domain-sep cutover self-heals (discard stale batch, redraw on next
    // use). Each falls back to the enrollment key when the community carries no key for that media
    // domain (single-key deployment), matching how the draw blinds. Absent ⇒ undefined ⇒ reconciliation
    // off. Dark today (nothing draws/spends these until sealing is on).
    if (this.tokenPool) {
      const mediaKeyByPurpose: Record<MediaPurpose, string | undefined> = {
        [Purpose.PictureWrite]: pictureKey,
        [Purpose.PictureRead]: active?.picReadIssuerPublicKey ?? active?.issuerPublicKey,
        [Purpose.AudioWrite]: audioKey,
        [Purpose.AudioRead]: active?.audReadIssuerPublicKey ?? active?.issuerPublicKey,
      };
      for (const purpose of MEDIA_PURPOSES) {
        const key = mediaKeyByPurpose[purpose];
        this.tokenPool.setKeyFingerprint(purpose, key ? walletKeyFingerprint(key) : undefined);
      }
    }
    // Bind the space-write wallet to K_spacewrite the same way (fall back to the enrollment key for a
    // single-key deployment). Dark today (nothing draws/spends it until the relay requires space tokens).
    const spaceKey = active?.spaceWriteIssuerPublicKey ?? active?.issuerPublicKey;
    this.activeSpaceWriteKeyFp = spaceKey ? walletKeyFingerprint(spaceKey) : undefined;
    this.tokenPool?.setKeyFingerprint(Purpose.SpaceWrite, this.activeSpaceWriteKeyFp);
    this.verifyCommunityProvisioning();
  }

  /**
   * C5 — domain-separation verification. Compare the active community's per-purpose issuer-key
   * fingerprints against the relay's ADVERTISED purpose-key fingerprint SETS and flag a mis-provisioned
   * invite. Runs at the points where either input can change: community resolution / a live
   * stiq:token-keys re-sync (both via rebindPurposeKeyFingerprints) and a caps refresh (onRelayConnected).
   *
   * FINGERPRINT WIRE-FORMAT CONTRACT (see CLIENT_C5_FINGERPRINT_CONTRACT.md): the relay's advertised
   * `purpose_key_fingerprints.{posting,read,binding}` MUST equal
   *   sha256_hex( utf8( base64_standard_DER_SPKI_string_of_the_issuer_public_key ) )[:16]
   * i.e. the relay must base64-encode its DER-SPKI issuer key EXACTLY as the join/community code
   * carries it (standard base64, with padding, no newlines) and hash THAT string — the same bytes
   * {@link walletKeyFingerprint} hashes on this side. If the relay instead advertised fingerprints
   * hashed over PEM text or raw DER bytes, EVERY member would mismatch. That is precisely why the
   * HARD block below is schema-gated: it cannot fire until the relay advertises a schemaVersion that
   * GUARANTEES this format.
   *
   * ROTATION-SAFE SET COMPARE (T1.4/F6, pinned shape — Fable B3): the relay advertises each domain as
   * an ARRAY of fingerprints — a rotation runs the OLD and NEW issuer key in parallel for an overlap
   * window, and every array entry is a currently-valid key. A wallet key is STALE iff it prefix-matches
   * NONE of the advertised entries for that domain — matching ANY entry (not only the first) means the
   * wallet is fine, just mid-rotation overlap. A first-entry-only equality check would hard-block every
   * client mid-rotation, recreating the swk incident from inside its own fix.
   *
   * SCHEMA GATE / SHIP-AHEAD SAFETY: a fingerprint mismatch (or a read-metered relay + rk-less invite)
   * only sets `_communityKeyError` — and thus only blocks posting — when
   * `caps.schemaVersion >= CAPS_SCHEMA_PURPOSE_FINGERPRINTS`. Below that threshold (which includes
   * today's fallback `schemaVersion` 0) the same condition is ADVISORY only: a `log.warn`, never a
   * block. And at caps fallback `purposeKeyFingerprints` is empty anyway, so the check finds nothing
   * and `_communityKeyError` stays undefined — posting behaves byte-for-byte as today. This makes a
   * premature, relay-triggered posting outage impossible: enforcement can't activate until the relay
   * pins the format via its advertised schema.
   *
   * NOT A PERMANENT BRICK (T1.4/F6): this recomputes `reason` fresh on every call rather than latching
   * — so once rebindPurposeKeyFingerprints adopts a corrected key (a live stiq:token-keys re-sync),
   * the very next post() call succeeds with no restart or re-enrollment.
   *
   * ANONYMITY: this only compares PUBLIC issuer-key fingerprints — it never touches the blind-posting
   * secret, the community key, or which key blinds/signs a token.
   */
  private verifyCommunityProvisioning(): void {
    const fps = this._relayCaps.purposeKeyFingerprints;
    const enforce = this._relayCaps.schemaVersion >= CAPS_SCHEMA_PURPOSE_FINGERPRINTS;
    // The relay advertises the FULL sha256 hex of the issuer key; the client fingerprint (e.g.
    // activePostKeyFp) is the same hash TRUNCATED to 16 hex. So the client fingerprint must be a
    // PREFIX of a relay entry — never exact-equal for the live 64-hex form. (An older relay that
    // advertised a 16-hex value compares as full equality, since the client fp is then the whole
    // string.) `client` is stale iff it prefix-matches NONE of `entries` — see the doc above.
    const staleAgainstSet = (entries: string[] | undefined, client: string): boolean => {
      if (!entries || entries.length === 0) return false; // relay advertised nothing for this domain
      return !entries.some(relay => relay.slice(0, client.length) === client);
    };
    // The pre-T1.4 single-string compare, kept ONLY for `read` (unchanged/deferred — see the field doc
    // on purposeKeyFingerprints).
    const fpMismatch = (relay: string, client: string): boolean =>
      relay.slice(0, client.length) !== client;
    // The specific mis-provisioning found, if any (undefined = correctly provisioned).
    let reason: string | undefined;
    if (fps.posting && this.activePostKeyFp && staleAgainstSet(fps.posting, this.activePostKeyFp)) {
      reason = `posting-key fingerprint mismatch (invite ${this.activePostKeyFp} not in relay set [${fps.posting.join(', ')}])`;
    } else if (
      fps.spaceWrite &&
      this.activeSpaceWriteKeyFp &&
      staleAgainstSet(fps.spaceWrite, this.activeSpaceWriteKeyFp)
    ) {
      // F6's headline gap: space-write previously had NO fingerprint field to compare against at all,
      // so a stale key sailed straight through undetected. Now caught exactly like posting.
      reason = `space-write-key fingerprint mismatch (invite ${this.activeSpaceWriteKeyFp} not in relay set [${fps.spaceWrite.join(', ')}])`;
    } else if (
      fps.picture &&
      this.activePictureWriteKeyFp &&
      staleAgainstSet(fps.picture, this.activePictureWriteKeyFp)
    ) {
      reason = `picture-write-key fingerprint mismatch (invite ${this.activePictureWriteKeyFp} not in relay set [${fps.picture.join(', ')}])`;
    } else if (
      fps.audio &&
      this.activeAudioWriteKeyFp &&
      staleAgainstSet(fps.audio, this.activeAudioWriteKeyFp)
    ) {
      reason = `audio-write-key fingerprint mismatch (invite ${this.activeAudioWriteKeyFp} not in relay set [${fps.audio.join(', ')}])`;
    } else if (fps.read && this.activeReadKeyFp && fpMismatch(fps.read, this.activeReadKeyFp)) {
      reason = `read-key fingerprint mismatch (invite ${this.activeReadKeyFp} != relay ${fps.read})`;
    } else if (fps.read && this.activeReadKeyFp === undefined) {
      // Trap 2 — the relay advertises read metering (fps.read) but THIS invite carries no `rk`, so
      // there is no read key to compare and nothing downstream flags it (the drawExchange read-gate
      // isn't wired until C7). Catch the mis-provisioning here: the invite needs updating.
      reason = 'relay advertises read metering but this invite carries no read key (rk)';
    }

    if (!reason) {
      this._communityKeyError = undefined;
      return;
    }
    if (enforce) {
      this._communityKeyError = AppRuntime.COMMUNITY_MISPROVISIONED;
    } else {
      // Below the schema threshold the relay does not yet GUARANTEE the pinned fingerprint format, so
      // a mismatch is more likely a format skew than a real mis-provisioning. Advise only — NEVER
      // block posting (ship-ahead safety).
      this._communityKeyError = undefined;
      log.warn(
        'caps',
        `C5 provisioning advisory (schemaVersion ${this._relayCaps.schemaVersion} < ${CAPS_SCHEMA_PURPOSE_FINGERPRINTS}; advisory only, not blocking): ${reason}`,
      );
      // Don't just warn — actively re-fetch the live key doc (throttled) so a present-but-stale key
      // heals BEFORE a draw fails on it, rather than waiting for the live stream to happen to
      // redeliver one (2026-07-21: the dormant advisory left wrong keys in place all night).
      this.scheduleKeyResync();
    }
  }

  /**
   * Call when the relay WebSocket opens.
   * Retries a pending bind event that survived a previous crash or connectivity failure.
   */
  async onRelayConnected(): Promise<void> {
    // T-G1c: this whole method re-runs on EVERY (re)connect, not just the first — verified (T-G3b)
    // by tracing every teardown/reconnect path in App.tsx (community switch, network bounce, dormancy
    // exit) back to a fresh `startRelay()`, which always calls this unconditionally. Logged here so a
    // field logcat session can see exactly when a reconnect happened and how much was queued for it.
    log.info('perf:tor', `onRelayConnected fired — flushing ${this.outbox.unsent().length} unsent write(s)`);
    // 0. Publish-durability FIX — re-attempt any post that couldn't be SIGNED at compose time
    // because the blind wallet was still exhausted after feedSigner's own draw-and-retry (see
    // post()'s catch). A relay (re)connect is exactly when a proactive token top-up would have
    // landed, so this is the natural place to retry — independent of secureStorage/enrolled below
    // (drainPendingPosts is a no-op without an identity).
    void this.drainPendingPosts();

    // 0b. Republish MY event docs (2026-07-21 incident fix — see republishMyEventDocs): addressable
    // 31923 writes have no outbox-retry path of their own, so a reconnect is also the moment to
    // resweep them. Throttled internally to once per connect cycle.
    void this.republishMyEventDocs();

    // A fresh connect is also the natural moment to retry a stuck auto-unlock (the backoff was
    // waiting out a dead circuit that just got replaced) — including a TERMINAL one, since the
    // circuit that just came up may be the very thing the earlier attempts never had. See
    // {@link reviveStuckEpochUnlocks}.
    this.reviveStuckEpochUnlocks('relay reconnect');

    const storage = this.deps.secureStorage;
    if (!storage || !this.enrolled) return;

    // 1. Retry the binding event that survived a crash/offline enrollment.
    const pending = await loadPendingBind(storage);
    if (pending) {
      try {
        const result = await this.deps.publish?.(pending);
        if (result?.accepted) {
          await clearPendingBind(storage);
        }
      } catch {
        // Will retry next connection cycle.
      }
    }

    // 2. Retry any optimistic writes (posts/votes/channels/comments) not yet acknowledged.
    for (const event of this.outbox.unsent()) {
      void this.deliver(event);
    }

    // 3. Scoped subscriptions (groups + open channels) are re-opened from onRelaySubscribed(), NOT
    //    here: this method runs at relay CONSTRUCTION time, before the Tor socket has opened, and
    //    RelayClient.sendSubscribe() resets knownSubIds to the plan's subs the moment it does open —
    //    wiping any scoped sub registered from here. That silent wipe is exactly why an accepted
    //    join request never resolved on the requester's device: the fresh 39002 had no surviving
    //    subscription to arrive on until the user happened to open a group view.

    // 4. Negotiate the relay's advertised capabilities (NIP-11 + stiq-capabilities) ONCE per
    //    connect, so cross-process invariants (today the NIP-29 gate; later PoW/domain-sep/kinds)
    //    come from what the relay actually enforces rather than a build constant. Fetched over Tor
    //    by the host; on ANY failure the previous/fallback caps stand so connect is never blocked.
    if (this.deps.fetchRelayInfo) {
      try {
        const relayInfoDoc = await this.deps.fetchRelayInfo();
        // Sticky enforcement (2026-07-28 fix): fold the doc's EXPLICIT enforcement fields into the
        // per-community sticky record BEFORE adopting the parsed caps. parseRelayCapabilities maps
        // "absent" to the constant fallback (false/0) — indistinguishable from an explicit
        // downgrade — so the sticky overlay below is what keeps a known token-enforcing community
        // enforcing across a doc that omits the block, while an explicit `false` still lands (it
        // updates the sticky record itself, so the overlay carries the downgrade too).
        this._stickyEnforced = {...this._stickyEnforced, ...explicitEnforcedFlags(relayInfoDoc)};
        void saveStickyEnforcement(this._stickyEnforced, this.activeCid ?? undefined);
        this._relayCaps = parseRelayCapabilities(relayInfoDoc);
        // Weight-pricing (client half): activate token weight-pricing at the relay's advertised rate.
        // bytes_per_token = 0 (caps fallback / relay didn't advertise) → pricing off → every post costs
        // exactly one token, unchanged. Must MATCH the relay's identical chargeableSize computation.
        // applyStickyEnforcement re-derives it from the MERGED flags (explicit ⊇ sticky for every
        // field this doc advertised, so a fresh advertisement is never overridden).
        this.applyStickyEnforcement();
        // C5 — re-verify domain separation now that caps are known (the first resolution ran before
        // this fetch, so this is where a mis-provisioned invite is actually caught on cold start).
        this.verifyCommunityProvisioning();
        log.info(
          'perf:tor',
          `caps re-negotiated on reconnect: contentEncryption=${this._relayCaps.enforcedFlags.contentEncryption} ` +
            `blindRequired=${this._relayCaps.enforcedFlags.blindRequired} spaceTokensRequired=${this._relayCaps.enforcedFlags.spaceTokensRequired}`,
        );
      } catch (err) {
        log.warn('caps', 'relay capability fetch failed; keeping fallback', err);
      }
    }
  }

  /**
   * Call when the relay has actually SENT its subscription plan on an open socket (the host wires
   * this to MirrorSet.onSubscribed). This is the only moment a scoped sub can be (re)opened and
   * survive — sendSubscribe() just reset the client's sub registry to the plan's subs, dropping
   * every scoped sub from any earlier connection (or from a too-early onRelayConnected()).
   *
   * Re-opens the scoped subscription for every joined/requested group (their 39000-39004 state,
   * chat, and raw 9021s are all off-firehose — without this a fresh connect never streams them, so
   * an approval granted while this device was away would leave the requester stuck "pending"
   * forever) and for any channel view currently on screen (see resubscribeChannels).
   */
  onRelaySubscribed(): void {
    this.resubscribeGroups();
    this.resubscribeChannels();
  }

  /**
   * Manual pull-to-refresh: re-run the relay's feed reconciliation now and resolve when it
   * completes. Delegates to the live relay's resyncFeed; resolves immediately (no throw) when the
   * relay is absent or disconnected, so the UI spinner always clears. New events stream into the
   * cache via the normal ingest path, re-rendering the feed.
   */
  async refreshFeed(): Promise<void> {
    // Pull-to-refresh actively recovers a token-exhausted post: re-sign + deliver anything queued in
    // pendingPosts (durability FIX #3/#5) rather than waiting for the next relay reconnect / draw. A
    // pull mid-draw was one of the paths that used to lose a post; now it drains the durable queue.
    void this.drainPendingPosts();
    try {
      await this.deps.resyncFeed?.();
    } catch {
      // A failed reconciliation falls back inside the relay; never surface it as a spinner hang.
    }
  }

  /** Open the scoped relay subscription for each remembered group (idempotent). */
  private resubscribeGroups(): void {
    // joinedGroups = membership (persisted); openGroups = views on screen right now (session).
    // The union covers the discovery case: an OPEN UNJOINED group's sub must survive reconnects
    // (and a subscribe swallowed by a null relay at open time) exactly like an open channel's.
    for (const groupId of new Set([...this.joinedGroups, ...this.openGroups])) {
      this.deps.subscribeGroup?.(groupId);
      // A reconnect is exactly the "cold reconnect" moment the M32 field incident traces to — give
      // every remembered group's invited-accept sweep another chance here too, so a stranded
      // invited+pending member self-heals on the group LIST refreshing, not only when an admin
      // happens to open that specific group. See sweepInvitedAfterKeys's doc.
      this.sweepInvitedAfterKeys(groupId);
    }
  }

  /**
   * Re-open the scoped kind-1311 subscription for every channel view currently on screen
   * (idempotent). The channel mirror of {@link resubscribeGroups} — see {@link openChannels} for why
   * the standing `channels` sub does not make this redundant. No-op when the dep isn't wired
   * (SCOPED_CHANNEL_SYNC off).
   */
  private resubscribeChannels(): void {
    for (const channelId of this.openChannels) {
      this.deps.subscribeChannelChat?.(channelId);
    }
  }

  /**
   * Remember a group and immediately open its scoped subscription, so its relay-emitted state
   * (39000-39003) flows into the cache and it appears in the group list right away. Persisted so
   * the subscription is re-opened on the next connect/restart.
   */
  private async trackGroup(groupId: string): Promise<void> {
    if (!this.joinedGroups.has(groupId)) {
      this.joinedGroups.add(groupId);
      // Must stay INSIDE this not-yet-joined branch: joinedGroups is rehydrated directly into the
      // Set on load (~line 2711) and reconnects go through resubscribeGroups (~line 4747), which
      // calls deps.subscribeGroup directly — neither re-enters this branch. Hoisting the stamp out
      // of the `if` would make every group jump to the top of Spaces on every app start.
      markJoined(groupId, AppRuntime.nowSec());
      await saveJoinedGroups([...this.joinedGroups], this.activeSlotId);
    }
    this.deps.subscribeGroup?.(groupId);
    this.emit(); // group appears in the list immediately (placeholder until state streams in)
  }

  /**
   * Forget a group on leave: remove it from the viewer's list *immediately* (optimistic), drop the
   * subscription, and stop re-subscribing on reconnect. Local-intent removal is what makes "Leave"
   * work even for an OWNER, whom the relay forbids from leaving — the group still exists server-side
   * but disappears from this user's view, which is the behaviour they expect.
   */
  private async untrackGroup(groupId: string): Promise<void> {
    if (this.joinedGroups.delete(groupId)) {
      await saveJoinedGroups([...this.joinedGroups], this.activeSlotId);
    }
    this.deps.unsubscribeGroup?.(groupId);
    this.emit();
  }

  /**
   * Optimistic publish: cache the signed event and re-render IMMEDIATELY, then push to the
   * relay in the background. The caller does not await relay delivery, so the UI never blocks
   * on Tor. Delivery status is tracked in the outbox for the "sending…/failed" indicator and
   * for retry on reconnect.
   *
   * `dependsOn` names outbox events that must LAND before this one is sent — today, the media blobs
   * a post's body references (signPendingWrite). It changes only the WIRE order: the event is still
   * stored and re-rendered here, instantly, so the optimistic UI is identical either way. Omitted (or
   * empty) — every other write in this class — is byte-identical to before it existed.
   */
  private async publishOptimistic(event: Event, dependsOn?: readonly string[]): Promise<void> {
    this.deps.store.save(event); // optimistic; dedupes if the relay echoes it back
    await this.outbox.add(event, dependsOn);
    this.noteWriteOutboxed(event.id); // perf: sign→outbox timestamp (no-op for a non-tracked write)
    this.emit();
    void this.deliver(event);
  }

  /**
   * The events `eventId` is still waiting on before it may be sent (see OutboxEntry.dependsOn) —
   * empty for every write that has none, which is every write but a blob-carrying post.
   *
   * An id the outbox no longer knows counts as LANDED, not as missing: the only way an entry leaves
   * the queue is confirmDelivery's post-linger sweep (i.e. the relay took it) or an explicit
   * cancel/removal, and dependencies are always added to the outbox BEFORE the event that names them
   * — so "gone" here means "delivered and swept", never "never queued".
   */
  private blobsBlocking(eventId: string): Event[] {
    const deps = this.outbox.dependenciesOf(eventId);
    if (deps.length === 0) return [];
    const statuses = this.outbox.statuses();
    const out: Event[] = [];
    for (const id of deps) {
      const status = statuses.get(id);
      // 'accepted' counts as landed: the relay's OK IS delivery (see deliver()), and 'confirmed'
      // follows it immediately — waiting for the echo as well would strand the post whenever a
      // back-dated blind post's echo never arrives, which is the exact bug confirmDelivery fixed.
      if (status === undefined || status === 'accepted' || status === 'confirmed') continue;
      const blob = this.outbox.eventFor(id);
      if (blob) out.push(blob);
    }
    return out;
  }

  /**
   * A dependency of some queued write just finished a delivery attempt — decide what that means for
   * the writes waiting on it. Called at the end of every deliver(), so it sees the freshly-written
   * status. No-op for the overwhelming majority of events, which nothing depends on.
   *
   * This is where "blob fails ⇒ post never sent, user retries" is actually enforced, and where the
   * user is TOLD. A blob has no card of its own — it is an implementation detail of its post — so its
   * outcome is reported ON the post, through the send indicator that is already there:
   *   • every blob landed  → send the post now (the ring carries on to accepted/confirmed);
   *   • blob 'rejected'    → the relay will never take it, so the post must never go: mark the POST
   *                          rejected, carrying the relay's own reason, giving the user the normal
   *                          red "couldn't send" + Retry/Cancel (Retry re-drives blob then post);
   *   • blob 'failed'      → ambiguous/timed out: mark the post failed too, so it shows Retry AND is
   *                          re-driven with its blob by the next reconnect (unsent() covers both);
   *   • blob queued offline→ mirror "Queued — connecting…" onto the post, which is the literal truth.
   * A post whose blob is merely still in flight keeps the plain 'sending' ring it already had.
   */
  private async advanceBlobDependents(dependencyId: string): Promise<void> {
    const dependents = this.outbox.dependentsOf(dependencyId);
    if (dependents.length === 0) return;
    const status = this.outbox.statuses().get(dependencyId);
    for (const dependent of dependents) {
      if (status === 'rejected') {
        await this.outbox.markRejected(dependent.id, this.outbox.reasons().get(dependencyId));
      } else if (status === 'failed') {
        await this.outbox.markFailed(dependent.id);
      } else if (this.blobsBlocking(dependent.id).length === 0) {
        void this.deliver(dependent);
      } else if (this.outbox.queuedOfflineIds().has(dependencyId)) {
        await this.outbox.markSending(dependent.id, true);
      }
    }
    this.emit();
  }

  /**
   * Escalating local backoff for a still-'sending' event: attempt 0 waits 4s, 1 waits 8s, 2 waits
   * 16s, 3 waits 32s (4 scheduled resends total, on top of the original send — a bounded ~5
   * attempts, capped under a minute). This is a LOCAL, self-driven retry so a healthy relay
   * connection whose single blind-post Tor circuit hiccuped doesn't have to wait for a full
   * reconnect cycle (onRelayConnected) to try again — today that was the ONLY retry path, and a
   * 'sending' post could sit forever while the app looked Connected.
   */
  private static readonly RESEND_BACKOFF_MS = [4_000, 8_000, 16_000, 32_000];

  /** Schedule the next backoff-resend attempt for `event` (see RESEND_BACKOFF_MS). No-ops once the
   *  backoff table is exhausted — a reconnect (onRelayConnected) still retries it after that. */
  private scheduleResend(event: Event, attempt: number): void {
    if (attempt >= AppRuntime.RESEND_BACKOFF_MS.length) return;
    this.clearResendTimer(event.id); // at most one pending resend timer per event
    const delay = AppRuntime.RESEND_BACKOFF_MS[attempt]!;
    const timer = setTimeout(() => {
      this.resendTimers.delete(event.id);
      // Stop the chain the moment the event left 'sending' — delivered meanwhile by this same
      // chain, by onRelayConnected's reconnect flush, by a manual Retry, or cancelled outright.
      // Checking status (not just outbox.has()) is what lets a rejection/failure/removal end the
      // chain even though the entry may still exist under a different terminal status.
      if (this.outbox.statuses().get(event.id) !== 'sending') return;
      void this.deliver(event, attempt + 1);
    }, delay);
    this.resendTimers.set(event.id, timer);
  }

  private clearResendTimer(eventId: string): void {
    const timer = this.resendTimers.get(eventId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.resendTimers.delete(eventId);
    }
  }

  /**
   * Timing-correlation defense (T15): a small, bounded, uniformly-random delay applied to the
   * NETWORK send of a write — never to the optimistic UI render (that already happened in
   * publishOptimistic). Gated on the default-ON TIMING_JITTER kill-switch; a zero/negative draw or
   * the flag off is a byte-identical no-op. Awaited as the FIRST statement inside deliver()'s try so
   * every write funnelling through deliver (posts/votes/comments, DM gift wraps, and reconnect/backoff
   * resends) inherits it without touching RelayClient or the isolated blind-post circuit.
   */
  private async applySendJitter(): Promise<void> {
    if (!TIMING_JITTER) return;
    const ms = sendJitterMs();
    if (ms <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  /** Push one event to the relay and update its outbox status (background; never throws).
   *  `attempt` counts local backoff resends (see scheduleResend) — 0 for the original send and
   *  every manual retry / reconnect resend. */
  private async deliver(event: Event, attempt = 0): Promise<void> {
    // In-flight de-dupe guard: the local backoff timer above and onRelayConnected's reconnect
    // flush can both try to re-deliver the same still-unsent event around the same moment.
    // Without this they'd race a concurrent deps.publish() for the same id (double-send / a
    // clobbered outbox status from whichever call's result lands second). Whichever call gets
    // here first "owns" this delivery; the other is a harmless no-op.
    if (this.inFlightDeliveries.has(event.id)) return;
    // Blob-before-post ordering gate. A post whose body references media blobs must not be SENT until
    // every one of those blobs has landed at the relay — otherwise a half-fail leaves readers with a
    // post whose picture does not exist, permanently and unfixably. Ordering the SIGN step closed the
    // other direction (a body can never reference a blob that failed to sign, see mediaBlob.ts);
    // delivery is the separate, retrying half, and this is where it is closed.
    //
    // Returning here is not a failure and loses nothing: the post stays queued in the outbox exactly
    // as it was ('sending' — which is the truth: it has not been sent), and it is re-driven the moment
    // its last blob lands (advanceBlobDependents) or by the next reconnect flush. We kick the blobs on
    // the way out so a post arriving here first — a reconnect flush walks unsent() in queue order —
    // still gets its blobs moving rather than waiting on a timer. No dependencies (every write but a
    // blob-carrying post, and every write at all with LAZY_MEDIA_BLOBS off) ⇒ this is a Map lookup
    // returning empty, and deliver() proceeds byte-identically to before.
    const blocking = this.blobsBlocking(event.id);
    if (blocking.length > 0) {
      for (const blob of blocking) void this.deliver(blob);
      return;
    }
    this.inFlightDeliveries.add(event.id);
    try {
      // Timing-correlation defense (T15): defer only the wire send by a small bounded random delay;
      // the optimistic render already happened in publishOptimistic, so this is invisible to the user.
      await this.applySendJitter();
      const result = await this.deps.publish?.(event);
      if (result?.accepted) {
        await this.outbox.markAccepted(event.id);
        // The relay's OK 'accepted' IS delivery — confirm immediately for every kind. This used to be
        // withheld for feed kinds (posts/reactions/comments/reports), pending the firehose echoing the
        // event back to us via the live feed subscription. But that subscription's `since` advances
        // (buildFeedFilter, subscriptionPlan.ts) and a blind post's back-dated created_at (blindPost.ts
        // fuzzBlindCreatedAt) can land below it — most commonly for a send DELAYED past Tor connecting,
        // then auto-resent minutes later — so the echo could simply never arrive and the ring stayed
        // stuck at "accepted" forever despite the relay having stored the post. If an echo DOES still
        // arrive later, it lands in markEchoed(), which is now just a harmless no-op redundant confirm
        // for an id the outbox has already confirmed and dropped.
        await this.confirmDelivery(event.id);
        await this.syncDmEcho(event, 'sent');
        this.noteWriteTerminal(event.id, 'accepted'); // perf: full queue→sign→outbox→relay-OK line
      } else if (result?.offline) {
        // The relay isn't connected yet (Tor still establishing the onion circuit, or the socket
        // dropped). The write wasn't sent OR rejected — it's just waiting for a relay. Keep it
        // queued ("sending") so it shows a quiet progress bar, not a red "failed" badge, and let
        // onRelayConnected() re-deliver it automatically once the relay (re)connects. Marking it
        // failed here is exactly what made a post composed during "Connecting…" look broken.
        await this.outbox.markSending(event.id, true); // queued offline — see queuedOfflineIds()
        await this.syncDmEcho(event, 'sending');
        // Also self-drive a bounded local retry (see scheduleResend) rather than relying SOLELY on
        // the next reconnect — a single blind post's dedicated Tor circuit can fail transiently
        // while the relay connection itself stays healthy, and onRelayConnected only fires on an
        // actual reconnect.
        this.scheduleResend(event, attempt);
      } else if (result && result.accepted === false && result.message !== PUBLISH_TIMEOUT_MESSAGE) {
        // The relay was reachable and returned an OK frame REJECTING this event. Classify the reason
        // (C3): a known-TRANSIENT refusal (rate-limit / "try again" / duplicate / …) is treated like an
        // ambiguous miss — markFailed keeps it in unsent() so it auto-retries on reconnect and Retry
        // stays live, since a fresh attempt may well land. Everything else (blocked/invalid/auth/pow,
        // AND any unclassified reason — the B1 terminal-rejected win) is PERMANENT: the same signed
        // event carries the same now-stale token, so re-sending it just earns the same "no" and burns
        // Tor bandwidth. markRejected keeps the optimistic copy with its reason and drops it from the
        // auto-resend set — a user-initiated Retry stays available.
        // T12-S6: route the retryable decision through the authoritative machine-code table ONLY when
        // the relay guarantees it (advertises reject_codes_version >= CAPS_REJECT_CODES_MACHINE_MIN) AND
        // the TRUST_RELAY_REJECT_CODES kill-switch is on. Otherwise keep the legacy prose heuristic
        // (classifyRejection) so the pre-flip path — today's live relay advertises v2 — stays
        // byte-identical. Either way the RAW relay message is stored (markRejected); the calm mapping is
        // done at render, so outbox.reasons() is unchanged.
        const trustCodes =
          TRUST_RELAY_REJECT_CODES &&
          this.relayCapabilities().rejectCodesVersion >= CAPS_REJECT_CODES_MACHINE_MIN;
        const retryable = trustCodes
          ? isRetryable(parseRejection(result.message), {trustCodes: true})
          : classifyRejection(result.message).retryable;
        if (retryable) {
          await this.outbox.markFailed(event.id);
        } else {
          await this.outbox.markRejected(event.id, result.message);
          this.noteWriteTerminal(event.id, 'rejected'); // perf: permanent — no further retry to time
        }
        await this.syncDmEcho(event, 'failed', result.message);
      } else if (attempt < AppRuntime.RESEND_BACKOFF_MS.length) {
        // Ambiguous: the publish timed out with no OK frame (we don't know if the relay got it). This
        // used to wait SOLELY on a genuine relay reconnect to retry — but nothing forces a merely
        // congested-but-alive socket closed on its own (RelayClient's bounded stall detection is the
        // conservative backstop for THAT), so that wait was unbounded (finding #dms). Self-drive the
        // SAME bounded local backoff every other ambiguous/offline write already gets above, and keep
        // showing the quiet "sending" affordance (·) rather than a hard "failed" ✕ while attempts
        // remain — a fresh attempt may well land, unlike a genuine rejection.
        await this.outbox.markSending(event.id);
        await this.syncDmEcho(event, 'sending');
        this.scheduleResend(event, attempt);
      } else {
        // The local backoff ladder is exhausted. Settle to "failed / Retry / Cancel" — a genuine relay
        // reconnect (onRelayConnected) still auto-resends it from here, and a manual Retry stays live.
        await this.outbox.markFailed(event.id);
        await this.syncDmEcho(event, 'failed');
      }
    } catch {
      await this.outbox.markFailed(event.id);
      await this.syncDmEcho(event, 'failed');
    } finally {
      this.inFlightDeliveries.delete(event.id);
    }
    // This attempt's outcome may be what a blob-carrying post has been waiting on (or the news that
    // it will never land). No-op unless something actually depends on this event.
    await this.advanceBlobDependents(event.id);
    this.emit();
  }

  /**
   * Mark an event fully delivered (5/5), then remove it so the ring fills and disappears. Reached
   * from exactly two places, both of which mean the relay HAS the event: deliver()'s `accepted` OK
   * branch, and markEchoed() (the relay handed the event back to us). A 'failed' or 'rejected' write
   * never arrives here — which is what makes this the right, and only, place to count a landing.
   */
  private async confirmDelivery(eventId: string): Promise<void> {
    this.clearResendTimer(eventId); // delivered — no need to wait for the pending resend to no-op
    await this.outbox.markConfirmed(eventId);
    // The ONLY writer of postsDelivered, i.e. the only origin of a "Posted" confirmation anywhere in
    // the app. Gated on the outbox ACTUALLY recording this id as confirmed rather than merely on
    // reaching this line: markConfirmed is a silent no-op for an id the outbox no longer holds, which
    // is exactly what a community/account switch mid-delivery produces (reload() drops the queue).
    // Announcing there would tell the user a post landed in a community they have already left.
    if (this.outbox.statuses().get(eventId) === 'confirmed' && this.announceOnConfirm.delete(eventId)) {
      this._postsDelivered++;
    }
    this.emit();
    const timer = setTimeout(() => {
      this.confirmTimers.delete(timer);
      void this.outbox.remove(eventId).then(() => this.emit());
    }, CONFIRM_LINGER_MS);
    this.confirmTimers.add(timer);
  }

  /** Called when ANY event arrives from the relay — if it's one of ours, it's now delivered. */
  markEchoed(eventId: string): void {
    if (this.outbox.has(eventId)) {
      void this.confirmDelivery(eventId);
    }
  }

  /**
   * C2/C3 consumer: the relay CLOSED one of our subscriptions (wired from RelayClient.onSubError).
   * `auth-required:`/`restricted:` mean the relay refused to serve this sub without authentication /
   * membership — a non-fatal condition the user may need to act on (re-auth, re-join). There is no
   * dedicated app-level banner surface today, so this routes into the on-device diagnostics `log`
   * ring; THIS is the single hook point where a future "this space needs re-authentication" banner
   * would read from. Any other CLOSED reason is logged too — a relay refusal is never silently
   * dropped. Never throws (a listener bug must not kill the relay session).
   */
  handleSubError(err: {subId: string; message: string}): void {
    const {code} = classifyRejection(err.message);
    if (code === 'auth-required' || code === 'restricted') {
      // TODO(ui): surface an app-level "space needs re-auth / membership" banner from here.
      log.warn('relay', `subscription "${err.subId}" needs auth/membership: ${err.message}`);
    } else {
      log.warn('relay', `subscription "${err.subId}" closed by relay: ${err.message}`);
    }
    // Phase 5 stale-first: a CLOSED scoped sub will never EOSE — no more history is coming, so the
    // UI must stop treating that space's empty list as "still loading" (or its empty state would be
    // suppressed forever). "Synced" here means "settled", not "successful".
    this.markScopedSubSynced(err.subId);
  }

  // ── Scoped-sub history sync (Phase 5, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) ──────────────
  /**
   * Scoped sub ids (`channel:<id>` / `group:<id>`) whose stored-history replay has SETTLED this
   * session — EOSE arrived (history fully replayed) or the relay CLOSED the sub (nothing more is
   * coming). Until a space's id lands here, its empty message list means "still loading", and
   * ChannelView/GroupView suppress their "No broadcasts/messages yet." empty states (the
   * stale-first rule: never claim empty before the first load has settled). Session-scoped on
   * purpose: once history has replayed once, the local store holds it, so later reconnects can't
   * re-introduce the false-empty flash. Cleared on a community switch (clearSwitchCaches).
   */
  private readonly _scopedSubsSynced = new Set<string>();

  /** Record a scoped sub's history replay as settled (EOSE or CLOSED) and refresh the UI gates. */
  markScopedSubSynced(subId: string): void {
    if (this._scopedSubsSynced.has(subId)) return;
    this._scopedSubsSynced.add(subId);
    // Non-urgent: this only relaxes an empty-state gate; a reconnect's EOSE burst coalesces.
    this.emit(false);
  }

  /** Has `channel:<id>` / `group:<id>` settled its stored-history replay this session? Arrow
   *  property (stable identity) — handed to MainScreen as the `onIsSpaceSynced` prop. */
  readonly isScopedSubSynced = (subId: string): boolean => this._scopedSubsSynced.has(subId);

  /**
   * C2 consumer: a relay NOTICE frame (wired from RelayClient.onNotice) — a human-readable relay
   * message not tied to any subscription. Routed into the diagnostics `log` facade so it is observable
   * (e.g. a future "copy diagnostics" screen) rather than silently dropped. Never throws.
   */
  handleNotice(message: string): void {
    log.info('relay', `NOTICE: ${message}`);
  }

  /** Cancel a still-unsent (e.g. failed) write: stop retrying it and drop the local copy. */
  async cancelSend(eventId: string): Promise<void> {
    this.clearResendTimer(eventId); // stop any pending local backoff resend for the cancelled send
    // Give up the pending "Posted" confirmation too: the user has said they don't want this post, so
    // a late in-flight ack must not congratulate them on it. (confirmDelivery's outbox guard already
    // covers the removal below; this makes the intent explicit and keeps the set from accumulating
    // ids that can never be consumed.)
    this.announceOnConfirm.delete(eventId);
    if (this.awaitingSign.has(eventId)) {
      // A compose PLACEHOLDER (never signed / never in the outbox): drop it + its recovery-queue entry.
      this.discardPlaceholder(eventId);
      this.removeRecoveryIntent(eventId);
      await this.persistPendingCompose();
      this.emit();
      return;
    }
    await this.outbox.remove(eventId);
    this.deps.store.remove?.(eventId);
    this.emit();
  }

  /**
   * Manually retry a failed / rejected / still-in-flight optimistic write. A 'failed' compose
   * PLACEHOLDER (a blind post / comment / pinned comment whose draw+sign exhausted) is re-signed from
   * its queued intent — NOT re-delivered (it has no valid signature). Everything else is looked up by
   * id (not via unsent(), which excludes the terminal 'rejected' state) so a user-initiated Retry still
   * works on a relay-rejected send — the automatic reconnect resend is what we stopped, not this.
   */
  async retry(eventId: string): Promise<void> {
    if (this.awaitingSign.has(eventId)) {
      const intent = this.pendingPosts.find(p => p.id === eventId);
      if (!intent) return; // a vote placeholder (no recovery queue) — nothing to re-sign
      // Splice the intent OUT of pendingPosts BEFORE the (seconds-long) draw+sign, mirroring
      // drainPendingPosts's splice-before-await contract. Without this, signPendingWrite's internal
      // BlindTokensExhausted→drawNow()→drawTokens fires `void drainPendingPosts()`, which finds this
      // intent STILL queued, splices it, and signs it a SECOND time — publishing the write twice and
      // burning two tokens from one Retry tap. signPendingWrite's catch re-queues the intent on a
      // fresh exhaustion, so removing-first stays durable-on-failure. (hardening: retry double-post)
      this.removeRecoveryIntent(eventId);
      this.awaitingSign.set(eventId, {status: 'sending'}); // clear any prior failure reason
      this._awaitingSignVersion++;
      this.emit();
      try {
        await this.signPendingWrite(intent);
      } catch {
        // Re-exhausted → signPendingWrite already flipped it back to 'failed' + re-queued.
      }
      return;
    }
    const event = this.outbox.eventFor(eventId);
    if (event) {
      await this.deliver(event);
    }
  }

  /**
   * Re-deliver every outbox event that hasn't been confirmed sent. Called when the relay
   * (re)connects so a post made while the connection was down publishes automatically — the
   * user shouldn't have to manually retry once connectivity returns.
   */
  async resendUnsent(): Promise<void> {
    for (const event of this.outbox.unsent()) {
      await this.deliver(event);
    }
  }

  /**
   * Moderation/config trust root for the ACTIVE community, as an npub.
   *
   * Prefers the organizer carried in the join code (`EnrolledCommunity.organizerPubkey`, loaded
   * into `activeOrganizerPubkey`) so every community the device joins is governed by ITS OWN
   * organizer — nothing community-specific is baked into the build. Falls back to the optional
   * build-time `deps.organizerNpub` (a white-label single-community pin; normally undefined).
   *
   * Returned as an npub because organizerConfig.ts decodes npub→hex internally. This is the
   * single source of truth used by every organizer-config read below; it MUST match the key the
   * live-config path (handleIncomingEvent) accepts events from, or the dashboard's moderator
   * roster / limits / branding silently never apply.
   */
  private organizerNpub(): string | undefined {
    if (this.activeOrganizerPubkey) {
      try {
        return nip19.npubEncode(this.activeOrganizerPubkey);
      } catch {
        // Malformed stored pubkey — fall through to the build-time fallback.
      }
    }
    return this.deps.organizerNpub;
  }

  /**
   * The active organizer's pubkey (hex) for gating LIVE org-config ingest (handleIncomingEvent).
   * Prefers the join-code organizer on the active community; falls back to the build-time pin
   * (`deps.organizerNpub`, decoded to hex) so a white-label single-community build — whose enrolled
   * record may carry NO `organizerPubkey` — still ingests live kind-30078 config. This mirrors
   * {@link organizerNpub}'s resolution exactly, so the live gate trusts the SAME authority the
   * store-scan readers (currentLimits/currentGovernance/…) already do. Before this, the gate keyed
   * on the raw `activeOrganizerPubkey` field alone: when that was undefined (organizerPubkey absent,
   * only the build pin set), every live picture-limits / audio-limits / labels doc was silently
   * dropped while the readers kept working via the fallback — a real "rules don't sync" asymmetry.
   */
  private activeOrganizerHex(): string | undefined {
    if (this.activeOrganizerPubkey) return this.activeOrganizerPubkey;
    const npub = this.deps.organizerNpub;
    if (!npub) return undefined;
    try {
      const dec = nip19.decode(npub);
      return dec.type === 'npub' ? (dec.data as string) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Current moderator roster: the organizer's dynamically published roster when present
   * (community-code v2), otherwise the build-time fallback. Version-cached on versionOf([AppData])
   * + organizer so a freshly-received grant/withdraw (a new kind-30078 roster) takes effect on the
   * next snapshot, while a firehose of non-config events reuses the cached array.
   */
  private moderatorNpubs(): readonly string[] {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._rosterCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.npubs;
    const base =
      currentModerators(this.deps.store, org) ??
      this.deps.moderators ??
      MODERATOR_NPUBS;
    // The organizer is the moderation trust root — always an admin (gets mod actions and may
    // author the community guide), even when not explicitly listed in their own roster.
    const npubs = !org ? base : base.includes(org) ? base : [org, ...base];
    if (ver !== undefined) this._rosterCache = {ver, org, npubs};
    return npubs;
  }

  /** Stable string key for a roster (order-independent), used to key roster-dependent caches. */
  private moderatorsKeyOf(npubs: readonly string[]): string {
    return [...npubs].sort().join('\0');
  }

  /** Version-cached moderation overlay (kind-1984 lock/pin/retag effects). Keyed on
   * versionOf([Report]) + roster identity (the roster gates which reports count). */
  private cachedOverlay(moderators: readonly string[]): ModerationOverlay {
    const ver = this.storeVersionOf([Kind.Report]);
    const modKey = this.moderatorsKeyOf(moderators);
    const c = this._overlayCache;
    if (ver !== undefined && c && c.ver === ver && c.modKey === modKey) return c.overlay;
    const overlay = moderationOverlay(this.deps.store, moderators);
    if (ver !== undefined) this._overlayCache = {ver, modKey, overlay};
    return overlay;
  }

  /** Version-cached moderator-global hide context (kind-1984 reports + kind-10000 mute lists).
   * Keyed on versionOf([Report, MuteList]) + roster identity (the roster gates which reports and
   * mute lists count) — exactly mirroring cachedOverlay. moderatorHides runs two full store scans
   * (reports + mute lists), so caching it keeps the open thread from re-scanning on every rebuild;
   * a genuinely new report or mute-list event bumps the version and invalidates it. */
  private cachedModeratorHides(moderators: readonly string[]): ModeratorHides {
    const ver = this.storeVersionOf([Kind.Report, Kind.MuteList]);
    const modKey = this.moderatorsKeyOf(moderators);
    const c = this._hidesCache;
    if (ver !== undefined && c && c.ver === ver && c.modKey === modKey) return c.hides;
    const hides = moderatorHides(this.deps.store, moderators);
    if (ver !== undefined) this._hidesCache = {ver, modKey, hides};
    return hides;
  }

  /** Version-cached banned-author key set (kind-1984 ban/unban). Keyed on versionOf([Report]) +
   * roster identity. Time-based ban expiry is not a store event, so — matching the prior _feedCache
   * autoKey — it is intentionally not part of the key. */
  private cachedBannedSet(moderators: readonly string[], nowSec: number): Set<string> {
    const ver = this.storeVersionOf([Kind.Report]);
    const modKey = this.moderatorsKeyOf(moderators);
    const c = this._bannedCache;
    if (ver !== undefined && c && c.ver === ver && c.modKey === modKey) return c.banned;
    const banned = new Set(bannedAuthors(this.deps.store, moderators, nowSec).keys());
    if (ver !== undefined) this._bannedCache = {ver, modKey, banned};
    return banned;
  }

  /** Version-cached organizer rate-limit policy. Keyed on versionOf([AppData]) + organizer. */
  private cachedLimits(): Limits | undefined {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._limitsCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.limits;
    const limits = currentLimits(this.deps.store, org);
    if (ver !== undefined) this._limitsCache = {ver, org, limits};
    return limits;
  }

  /** Version-cached organizer per-mod permission doc. Keyed on versionOf([AppData]) + organizer. */
  private cachedPermissions(): Permissions | undefined {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._permsCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.perms;
    const perms = currentPermissions(this.deps.store, org);
    if (ver !== undefined) this._permsCache = {ver, org, perms};
    return perms;
  }

  /** Version-cached organizer community config (branding, defaults, announcement). Keyed on
   *  versionOf([AppData]) + organizer — mirrors cachedLimits/cachedPermissions exactly
   *  (heaviness-audit #6). */
  private cachedCommunityConfig(): CommunityConfig | undefined {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._communityConfigCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.config;
    const config = currentCommunityConfig(this.deps.store, org);
    if (ver !== undefined) this._communityConfigCache = {ver, org, config};
    return config;
  }

  /** Version-cached Log-tab hearth doc: currentLogPage() ?? legacyLogPageDoc(currentGuide(),
   *  currentFeaturedSpaces()) — 3 full AppData scans collapsed to a hit. Keyed on
   *  versionOf([AppData]) + organizer, exactly like cachedLimits/cachedPermissions
   *  (heaviness-audit #6). getLogPage() still resolves the returned doc against live
   *  channels/groups/identities on every call — those are NOT AppData-keyed, so they are
   *  intentionally left outside this cache. */
  private cachedLogPageDoc(): LogPageDoc {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._logPageDocCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.doc;
    const doc =
      currentLogPage(this.deps.store, org) ??
      legacyLogPageDoc(currentGuide(this.deps.store, org), currentFeaturedSpaces(this.deps.store, org));
    if (ver !== undefined) this._logPageDocCache = {ver, org, doc};
    return doc;
  }

  /** Version-cached governance knobs (newcomer window + channel-create rule). Keyed on
   *  versionOf([AppData]) + organizer (heaviness-audit #6). */
  private cachedGovernance(): Governance | undefined {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._governanceCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.gov;
    const gov = currentGovernance(this.deps.store, org);
    if (ver !== undefined) this._governanceCache = {ver, org, gov};
    return gov;
  }

  /** Version-cached moderator-action rate-cap doc. Keyed on versionOf([AppData]) + organizer
   *  (heaviness-audit #6). The per-user daily/weekly report tally in checkModLimit is NOT cached
   *  here — it depends on `this.myPubkey`'s own kind-1984 reports, which change independently of
   *  any organizer AppData doc. */
  private cachedModLimits(): ModActionLimits | undefined {
    const org = this.organizerNpub();
    const ver = this.storeVersionOf([Kind.AppData]);
    const c = this._modLimitsCache;
    if (ver !== undefined && c && c.ver === ver && c.org === org) return c.limits;
    const limits = currentModLimits(this.deps.store, org);
    if (ver !== undefined) this._modLimitsCache = {ver, org, limits};
    return limits;
  }

  /** Version-cached bookmark ids (kind-10003). Keyed on versionOf([Bookmarks]) + myPubkey; returns
   * the SAME array reference while unchanged so MainScreen's memo deps stop churning. */
  private cachedBookmarkedPostIds(): string[] {
    const ver = this.storeVersionOf([Kind.Bookmarks]);
    const c = this._bookmarksCache;
    if (ver !== undefined && c && c.ver === ver && c.myPubkey === this.myPubkey) return c.ids;
    const ids = bookmarkedPostIds(this.deps.store, this.myPubkey);
    if (ver !== undefined) this._bookmarksCache = {ver, myPubkey: this.myPubkey, ids};
    return ids;
  }

  /** Locked/pinned id arrays from the overlay, with STABLE identity while the overlay object is
   * unchanged (the overlay is itself version-cached, so identical inputs → identical arrays). This
   * stops MainScreen's pinnedSet/arrangeFeed memos from re-firing every emit. */
  private overlayIdArrays(overlay: ModerationOverlay | undefined): {locked: string[]; pinned: string[]} {
    const c = this._overlayIdCache;
    if (c && c.overlay === overlay) return {locked: c.locked, pinned: c.pinned};
    const locked = overlay ? [...overlay.lockedPostIds] : [];
    const pinned = overlay ? [...overlay.pinnedPostIds] : [];
    this._overlayIdCache = {overlay, locked, pinned};
    return {locked, pinned};
  }

  /**
   * Friendly client-side rate-limit pre-check (Phase B). Returns a message when the user has
   * exhausted their organizer-configured quota for `category`, or null when free to publish.
   * The relay is the hard enforcer; this just spares the user a bare relay rejection.
   * Moderators are skipped when the policy exempts them.
   */
  checkLimit(category: LimitCategory): string | null {
    if (!this.myPubkey) return null;
    const limits = this.cachedLimits();
    if (!limits) return null;
    if (limits.exemptModerators && isModerator(this.myPubkey, this.moderatorNpubs())) {
      return null;
    }
    const quota = quotaFor(this.deps.store, this.myPubkey, category, limits);
    return limitMessage(quota, category);
  }

  /** Organizer community config (branding, defaults, announcement) for the active community. */
  getCommunityConfig(): CommunityConfig | undefined {
    return this.cachedCommunityConfig();
  }

  /**
   * The Log tab's hearth — the organizer's stiq:log-page doc resolved against live metadata
   * (channels/logPage.ts). Falls back to a doc synthesized from the LEGACY guide + featured docs
   * when the organizer hasn't published the new page yet, so an existing community still renders
   * its rules and curated rail. Null only when there is nothing at all to show.
   *
   * Groups are looked up individually via groupStateOf rather than from the snapshot's `groups`
   * list: that list holds only the groups this member has JOINED, but the organizer may pick a
   * group the member hasn't joined yet — which is the whole point of picking it. A ref with no
   * cached metadata still yields a row (marked unreachable), never a silent drop.
   */
  getLogPage(): LogHearthData | null {
    const org = this.organizerNpub();
    const doc = this.cachedLogPageDoc();
    const groups = doc.picks
      .filter(p => p.type === 'group')
      .map(p => groupStateOf(this.deps.store, p.ref))
      .filter((g): g is GroupState => !!g);
    const orgHex = organizerHex(org);
    const orgIdentity = orgHex ? this.getIdentity(orgHex) : undefined;
    return resolveLogPage(doc, {
      channels: this.listChannels(),
      groups,
      userInfo: pk => this.getIdentity(pk),
      organizer: orgHex
        ? {pubkey: orgHex, name: orgIdentity?.name, gradient: orgIdentity?.gradient ?? null}
        : undefined,
      // Member counts exist only where membership is visible: a NIP-29 group's member list. A
      // NIP-53 channel is blind by design — no subscriber roster — so its line stays absent.
      memberCountOf: (ref, type) => {
        if (type !== 'group') return undefined;
        const n = groupMembersOf(this.deps.store, ref).length;
        return n > 0 ? n : undefined;
      },
      // Live unread bubble per picked space (Point 2), floor-clamped + first-entry-nudged exactly
      // like the Spaces list (readState.spaceBadge) so the two never disagree.
      firstEnteredAt: firstEnteredAt(),
      unreadOf: (ref, type) => {
        const sourceId = type === 'group' ? grpSeenId(ref) : chSeenId(ref);
        const msgs = type === 'group' ? this.getGroupMessages(ref) : channelMessages(this.deps.store, ref);
        return spaceBadge(sourceId, msgs, this.myPubkey ?? undefined, firstEnteredAt());
      },
      nowMs: Date.now(),
    });
  }

  /** Governance knobs (newcomer window + channel-create rule). */
  getGovernance(): Governance | undefined {
    return this.cachedGovernance();
  }

  /**
   * Moderator-action rate pre-check (UX; the relay also hard-enforces). Returns a message when the
   * current user has hit the organizer's cap for `action` today / this week, else null. The action
   * key matches the stiq-action value ('ban'|'retag'|…) or 'hide' for a plain removal report.
   */
  checkModLimit(action: string): string | null {
    if (!this.myPubkey) return null;
    const cap = this.cachedModLimits()?.[action];
    if (!cap || (!cap.daily && !cap.weekly)) return null;
    if (this.activeOrganizerPubkey && this.myPubkey === this.activeOrganizerPubkey) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    let day = 0;
    let week = 0;
    for (const r of this.deps.store.query({kinds: [Kind.Report], authors: [this.myPubkey]})) {
      // Advisory directives (log-user/log/unlog-user/log-batch) carry their action in the same
      // stiq-action tag but stiqActionOf doesn't recognize them, so consult advisoryActionOf first;
      // otherwise they'd all mis-count as 'hide' and their organizer caps would never fire.
      if ((advisoryActionOf(r) ?? stiqActionOf(r) ?? 'hide') !== action) continue;
      if (r.created_at >= nowSec - 7 * 86400) week++;
      if (r.created_at >= nowSec - 86400) day++;
    }
    if (cap.daily && day >= cap.daily) return `Daily limit reached for this action (${cap.daily}).`;
    if (cap.weekly && week >= cap.weekly) return `Weekly limit reached for this action (${cap.weekly}).`;
    return null;
  }

  getSnapshot(): AppSnapshot {
    // While a community switch is mid-flight the identity/store/caches are being swapped; reading
    // now could render a half-swapped mix. Return the last good snapshot until the switch settles
    // (activateWorkspace emits a fresh one when done).
    if (this.switching && this._lastSnapshot) {
      return this._lastSnapshot;
    }
    const lock = this.autolock.getState();
    // Skip the ENTIRE heavy build — feed, channels, groups, moderation overlay, banned set, bookmarks,
    // subscriptions — and return cheap constants WITHOUT touching the store (no SqliteEventStore.warmKind)
    // when either (a) the app is locked behind the PIN screen (none of it is on screen), or (b) init has
    // deferred the build off the splash critical path. Both paths always end in a real build: unlock
    // lifts (a) via the autolock emit; the scheduled macrotask lifts (b).
    if (this._deferHeavy || (lock === 'locked' && this.pinEnabled)) {
      const idle = this.buildIdleSnapshot(lock);
      this._lastSnapshot = idle;
      return idle;
    }
    const moderators = this.moderatorNpubs();
    // Parse channels once and reuse for the subscribed-set (was parsed twice — audit finding #3).
    // listChannels() is itself version-cached on Kind.LiveActivity (see _channelsCache).
    const channels = this.enrolled ? this.listChannels() : [];
    // Live moderator overlay (lock/re-tag/pin effects). Single pass over kind-1984; feeds both
    // the snapshot's locked/pinned sets and buildFeed's label-override + pin-float ordering.
    // Version-cached on versionOf([Report]) + roster so a firehose of non-report events reuses it.
    const overlay = this.enrolled ? this.cachedOverlay(moderators) : undefined;
    // Locked/pinned arrays keep a stable identity while `overlay` is unchanged (finding #11).
    const {locked: lockedPostIds, pinned: pinnedPostIds} = this.overlayIdArrays(overlay);
    // Hoisted (rather than computed inline in the literal below) so newFeedItemCountSince can reuse
    // the SAME reference below without a second visibleFeed() call — cheap either way (cache hit),
    // but this keeps it to exactly one call site per snapshot, matching the rest of this function.
    const feed = this.enrolled ? this.visibleFeed(moderators, overlay) : EMPTY_FEED;
    const snapshot: AppSnapshot = {
      enrolled: this.enrolled,
      lock: this.autolock.getState(),
      pinEnabled: this.pinEnabled,
      feed,
      inbox: this.enrolled ? this.inbox : [],
      channels,
      subscribedChannelIds: this.enrolled ? this.subscribedChannelSet(channels) : [],
      // groupSummariesForIds() has its own internal version cache in channels/groups.ts
      // (_summaryCacheByStore WeakMap keyed on the store, myPubkey, idsKey, and versionOf).
      // No double-caching needed here — the call is already O(1) on a cache hit.
      groups: this.enrolled
        ? groupSummariesForIds(this.deps.store, this.inboxGroupIds(), this.myPubkey)
        : [],
      spaceInvites: this.enrolled ? this.getIncomingInvites() : [],
      joiningSpaces: this.enrolled ? this.getJoiningSpaces() : [],
      currentUserPubkey: this.enrolled ? (this.myPubkey ?? null) : null,
      isModerator:
        this.enrolled && this.myPubkey
          ? isModerator(this.myPubkey, moderators)
          : false,
      modScopes:
        this.enrolled && this.myPubkey && isModerator(this.myPubkey, moderators)
          ? scopesFor(this.myPubkey, this.cachedPermissions())
          : [],
      sendStatus: this.sendStatusSnapshot(), // outbox + optimistic compose placeholders
      sendReasons: this.sendReasonsSnapshot(),
      sendQueuedOffline: this.outbox.queuedOfflineIds(),
      postsDelivered: this._postsDelivered,
      tagPolicy: this.tagPolicy,
      labels: this.labels,
      postRules: this.postRules,
      postingGuidelines: this.postingGuidelines,
      communityName: this.activeCommunity?.name ?? null,
      communityCid: this.activeCid ?? null,
      reasons: this.reasons,
      ranking: this.ranking,
      allowVoice: this.enrolled && this.cachedLimits()?.allowVoice === true,
      pictureRules: this.pictureRules,
      audioRules: this.audioRules,
      picturesSpentBytes: picturesSpentThisPeriod(),
      bookmarkedPostIds: this.enrolled ? this.cachedBookmarkedPostIds() : [],
      mutedAuthorPubkeys: this.enrolled ? this.cachedMutedAuthorPubkeys() : EMPTY_IDS,
      lockedPostIds,
      pinnedPostIds,
      storeVersions: {
        channels: this.storeVersionOf(AppRuntime.CHANNEL_VIEW_KINDS) ?? 0,
        groups: (this.storeVersionOf(AppRuntime.GROUP_VIEW_KINDS) ?? 0) + this._spaceKeysVersion,
        identity: this._identityVersion,
        thread: (this.storeVersionOf(AppRuntime.THREAD_VIEW_KINDS) ?? 0) + this._mutedVersion,
        config: this.storeVersionOf(AppRuntime.CONFIG_VIEW_KINDS) ?? 0,
        draftAccess:
          (this.storeVersionOf(AppRuntime.DRAFT_ACCESS_VIEW_KINDS) ?? 0) +
          this._draftAccessDenyVersion +
          this._draftDeliveryDecryptVersion,
      },
      notifUnreadCount: this.enrolled ? this.deriveNotifications().reduce((n, it) => n + (it.read ? 0 : 1), 0) : 0,
      newFeedItemCount: this.enrolled ? this.newFeedItemCountSince(feed) : 0,
      syncing: this.relaySyncing(),
      tokenStatus: this.buildTokenEconomyStatus(),
    };
    this._lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Cheap snapshot with every store-derived heavy field empty — returned while the app is locked
   * behind the PIN screen or while init has deferred the heavy build off the splash. Touches ZERO
   * store buckets (no warmKind / no query), so the splash and lock screen never pay to parse the
   * cached history. Only in-memory state is read: enrollment, lock state, the already-loaded organizer
   * policy (tag/labels/rules/reasons/ranking/pictureRules), the pubkey, and the outbox status map.
   * Heavy fields use shared empty constants so a locked-idle re-emit keeps stable array identities.
   */
  private buildIdleSnapshot(lock: LockState): AppSnapshot {
    return {
      enrolled: this.enrolled,
      lock,
      pinEnabled: this.pinEnabled,
      feed: EMPTY_FEED,
      inbox: EMPTY_CONVERSATIONS,
      channels: EMPTY_CHANNELS,
      subscribedChannelIds: EMPTY_IDS,
      groups: EMPTY_GROUPS,
      spaceInvites: EMPTY_SPACE_INVITES,
      joiningSpaces: EMPTY_JOINING_SPACES,
      currentUserPubkey: this.enrolled ? (this.myPubkey ?? null) : null,
      isModerator: false,
      modScopes: EMPTY_SCOPES,
      sendStatus: this.sendStatusSnapshot(), // outbox + optimistic compose placeholders
      sendReasons: this.sendReasonsSnapshot(),
      sendQueuedOffline: this.outbox.queuedOfflineIds(),
      postsDelivered: this._postsDelivered,
      tagPolicy: this.tagPolicy,
      labels: this.labels,
      postRules: this.postRules,
      postingGuidelines: this.postingGuidelines,
      communityName: this.activeCommunity?.name ?? null,
      communityCid: this.activeCid ?? null,
      reasons: this.reasons,
      ranking: this.ranking,
      allowVoice: false,
      pictureRules: this.pictureRules,
      audioRules: this.audioRules,
      picturesSpentBytes: picturesSpentThisPeriod(),
      bookmarkedPostIds: EMPTY_IDS,
      mutedAuthorPubkeys: EMPTY_IDS,
      lockedPostIds: EMPTY_IDS,
      pinnedPostIds: EMPTY_IDS,
      // storeVersionOf is a pure in-memory counter sum (no warmKind/query — see its doc comment), so
      // reading it here is still zero-store-touch; keeping it real (not a placeholder 0) means a memo
      // comparing this idle snapshot against the next real one still sees a true, monotonic signal.
      storeVersions: {
        channels: this.storeVersionOf(AppRuntime.CHANNEL_VIEW_KINDS) ?? 0,
        groups: (this.storeVersionOf(AppRuntime.GROUP_VIEW_KINDS) ?? 0) + this._spaceKeysVersion,
        identity: this._identityVersion,
        thread: (this.storeVersionOf(AppRuntime.THREAD_VIEW_KINDS) ?? 0) + this._mutedVersion,
        config: this.storeVersionOf(AppRuntime.CONFIG_VIEW_KINDS) ?? 0,
        draftAccess:
          (this.storeVersionOf(AppRuntime.DRAFT_ACCESS_VIEW_KINDS) ?? 0) +
          this._draftAccessDenyVersion +
          this._draftDeliveryDecryptVersion,
      },
      // Cheap idle snapshot: skip the store-touching derive entirely (matches isModerator/feed/etc.
      // above) — the real build on unlock/deferred-heavy-lift recomputes the true value immediately.
      notifUnreadCount: 0,
      // Same reasoning: `feed` is EMPTY_FEED behind the lock gate, so there is nothing to count "new"
      // against — the real build picks the true count back up immediately.
      newFeedItemCount: 0,
      // Nothing sync-related renders behind the lock gate / off the splash critical path — always
      // false here regardless of the live relaySyncing() flag; the real build (unlock/deferred-heavy
      // lift) picks up the true value immediately.
      syncing: false,
      // Cheap (no storage/store touch — see buildTokenEconomyStatus), so it costs nothing to keep
      // real even behind the lock gate / off the splash critical path.
      tokenStatus: this.buildTokenEconomyStatus(),
    };
  }

  /**
   * Return a memoized buildFeed result. Re-runs only when the set of feed-kind events or the
   * moderator roster changes. buildFeed's own _itemCache (per-post FeedItem memoization) is
   * additive on top of this outer guard: the outer guard skips building even the FeedItem array
   * when nothing changed; the inner per-post cache skips reconstructing individual FeedItems.
   *
   * Correctness for user actions: every action that writes a feed-kind event calls
   * publishOptimistic → store.save → per-kind version counter bumps → feedVer changes →
   * cache miss → immediate recompute. Actions that write non-feed-kind events (e.g. group chat,
   * channel subscription) don't need a feed recompute and correctly get a cache hit.
   */
  /**
   * Auto-moderation cache-key component: posts the organizer's rules auto-hide are dropped from the
   * feed, and the rule signature is part of the caller's cache key so a policy change re-runs the
   * build (the posts themselves bump feedVer; a rule/ban change alone doesn't, since it rides an
   * AppData/30078 doc, not a FEED_KINDS event — so it needs its own key component). Shared by
   * `_cachedBuildFeed` (needs the derived `autoCfg` too) and getProfile's memo (only needs `autoKey`,
   * to detect a reshuffle of visibleFeed's posts without re-deriving `autoCfg` a second time).
   */
  private autoModKeyFor(
    moderators: readonly string[],
  ): {autoCfg: {postRules: PostRules; postRulesAt: number; bannedAuthors: Set<string>}; autoKey: string} {
    const nowSec = Math.floor(Date.now() / 1000);
    const banned = this.cachedBannedSet(moderators, nowSec);
    const autoCfg = {postRules: this.postRules, postRulesAt: this.postRulesAt, bannedAuthors: banned};
    const r = this.postRules;
    const autoKey = `${this.postRulesAt}|${r.note.max}|${r.note.labelRequired}|${r.article.max}|${r.article.labelRequired}|${[...banned].sort().join(',')}`;
    return {autoCfg, autoKey};
  }

  private _cachedBuildFeed(moderators: readonly string[], overlay?: ModerationOverlay): Feed {
    const {autoCfg, autoKey} = this.autoModKeyFor(moderators);
    // POSTS-FIRST (A2): the first heavy feed build skips the kind-7 reaction bucketing (the largest
    // bucket) so the structural feed paints without warming/parsing every cached reaction; a scored
    // follow-up pass then recomputes and re-emits. Once that pass has run (_feedScored), every build
    // is fully scored. The score values live in FeedItem.score/myVote/voteTimestamps — the shape is
    // identical, only the derived values differ — so buildFeed's version-keyed cache stays correct.
    const skipScores = !this._feedScored;
    const opts = skipScores ? {skipScores: true} : undefined;
    if ('versionOf' in this.deps.store && typeof (this.deps.store as StoreWithVersion).versionOf === 'function') {
      const storeV = this.deps.store as StoreWithVersion;
      const feedVer = storeV.versionOf(AppRuntime.FEED_KINDS);
      // Represent moderator identity as a sorted join of their npubs. Sorted so the key is
      // stable regardless of the order returned by moderatorNpubs().
      const moderatorsKey = [...moderators].sort().join('\0');
      const identityVersion = this._identityVersion;
      const c = this._feedCache;
      if (
        c !== undefined &&
        c.feedVer === feedVer &&
        c.moderatorsKey === moderatorsKey &&
        c.myPubkey === this.myPubkey &&
        c.autoKey === autoKey &&
        c.identityVersion === identityVersion
      ) {
        // The overlay is derived purely from kind-1984 (in FEED_KINDS), so any overlay change
        // also bumps feedVer → this hit only happens when the overlay is unchanged too. When the
        // cached feed is still unscored, scheduleScorePass() (queued when it was built) will drop
        // this entry and re-emit scored — so a cache hit here never leaves scores permanently at 0.
        return c.feed;
      }
      const feed = buildFeed(this.deps.store, moderators, this.myPubkey, this.displayNames, this.gradients, overlay, autoCfg, opts, this._ownPostOrder);
      this._feedCache = {feedVer, moderatorsKey, myPubkey: this.myPubkey, autoKey, identityVersion, feed};
      if (skipScores) this.scheduleScorePass();
      this.noteFeedLocks(feed.items);
      return feed;
    }
    // Fallback: versionOf unavailable — always recompute.
    const feed = buildFeed(this.deps.store, moderators, this.myPubkey, this.displayNames, this.gradients, overlay, autoCfg, opts, this._ownPostOrder);
    if (skipScores) this.scheduleScorePass();
    this.noteFeedLocks(feed.items);
    return feed;
  }

  /**
   * Kick the invisible auto-unlock for every still-locked item a fresh feed build produced (see
   * noteLockedEpochs). Deferred a macrotask so the (render-path) feed build never synchronously
   * starts Tor work; the per-epoch dedup/backoff inside noteLockedEpochs makes repeated builds free.
   */
  private noteFeedLocks(items: readonly FeedItem[]): void {
    const epochs = new Set<number>();
    for (const it of items) {
      if (it.locked && it.lockedEpoch !== undefined && !hasContentEpochKey(it.lockedEpoch)) {
        epochs.add(it.lockedEpoch);
      }
    }
    if (epochs.size === 0) return;
    setTimeout(() => this.noteLockedEpochs(epochs), 0);
  }

  /**
   * Queue the posts-first scored follow-up (A2): on the next macrotask, chunk-warm the reaction
   * bucket AND every visible item's SCORED `_itemCache` entry (B3/P1-4), THEN mark scoring live,
   * drop the unscored feed cache, and re-emit so the next getSnapshot rebuilds the feed WITH kind-7
   * reaction scores — cheaply, since every item's cache entry is already warm. Idempotent while
   * pending; after it fires every build is fully scored. If it fires while the app is
   * locked/deferred, the emit yields a cheap idle snapshot (harmless) and the eventual
   * unlock/defer-lift build is fully scored — no unscored feed is ever shown to the user.
   */
  private scheduleScorePass(): void {
    if (this._scorePassScheduled) return;
    this._scorePassScheduled = true;
    const gen = this._scorePassGen;
    this._scorePassTimer = setTimeout(() => {
      this._scorePassTimer = undefined;
      // Chunk-warm the kind-7 reaction bucket BEFORE flipping to the scored build. Without this, the
      // scored rebuild's store.query({kinds:[7]}) fell through to the sync warmKind — a single
      // macrotask SELECT + JSON.parse of up to REACTION_RETENTION rows landing one tick after first
      // feed paint, the largest measured JS-thread block of the whole unlock path. The chunked warm
      // parses ~WARM_CHUNK_ROWS per macrotask and yields between chunks, so taps keep running; the
      // scored emit then finds the bucket already in RAM. Best-effort: on any failure (or a store
      // without warmKindChunked) the finally still runs the pass and the sync warm pays as before.
      void this.warmReactionBucketChunked()
        // B3/P1-4: the SQL warm above was chunked but the CONSUMING rebuild wasn't — the scored
        // emit's buildFeed() still ran toFeedItem() for every visible post in one synchronous shot.
        // Chunk-warm the scored `_itemCache` entries too (same setTimeout(0) yield idiom), so by the
        // time we flip _feedScored/emit below, the real rebuild is all cache hits.
        .then(() => this.warmScoredFeedChunked(gen))
        .finally(() => {
          this._scorePassScheduled = false;
          if (this._scorePassGen !== gen) return; // superseded by a switch/dispose mid-warm
          this._feedScored = true;
          this._feedCache = undefined; // force a scored rebuild on the next getSnapshot
          this.emit();
        });
    }, 0);
    // Don't let the off-critical-path scored pass keep the process alive (mirrors scheduleRetentionPrune).
    (this._scorePassTimer as unknown as {unref?: () => void}).unref?.();
  }

  /**
   * B3/P1-4: pre-warm the SCORED `_itemCache` entry for every currently visible post in chunks
   * across multiple macrotasks, using the SAME moderators/overlay/autoCfg the eventual scored
   * `buildFeed()` will use (moderatorNpubs/cachedOverlay/autoModKeyFor — the same helpers the public
   * feed build path already calls), so a warmed entry and the live rebuild's entry key identically.
   * This is pure work-spreading: it changes nothing about the eventual feed, only WHEN each item's
   * `toFeedItem()` cost is paid. Best-effort — any failure just means the following scored build
   * pays for whatever wasn't warmed, exactly as before this fix. `gen` is the `_scorePassGen`
   * scheduleScorePass() captured when this pass started; passed through as the chunk loop's
   * continue-guard so a mid-warm community switch or dispose() stops it early.
   */
  private async warmScoredFeedChunked(gen: number): Promise<void> {
    try {
      const moderators = this.moderatorNpubs();
      const overlay = this.cachedOverlay(moderators);
      const {autoCfg} = this.autoModKeyFor(moderators);
      await warmScoredItemsChunked(
        this.deps.store,
        moderators,
        this.myPubkey,
        this.displayNames,
        this.gradients,
        overlay,
        autoCfg,
        this._ownPostOrder,
        () => this._scorePassGen === gen,
      );
    } catch {
      // best-effort — the scored build's own per-item cache-miss path still produces correct items
    }
  }

  /**
   * Chunked, yielding warm of the kind-7 reaction bucket (SqliteEventStore.warmKindChunked, via the
   * SwappableEventStore passthrough). Resolves immediately when the backing store has no chunked warm
   * (in-memory/jest) and NEVER rejects — both the scored pass and the lock-screen pre-warm treat it
   * as best-effort. Coalesces at the store layer, so the pre-warm and the scored pass share one pass.
   */
  private async warmReactionBucketChunked(): Promise<void> {
    try {
      const store = this.deps.store as EventStore & {
        warmKindChunked?: (kind: number, chunkRows?: number) => Promise<void>;
      };
      await store.warmKindChunked?.(Kind.Reaction);
    } catch {
      // best-effort — the scored build's own sync warm still produces a correct bucket
    }
  }

  /**
   * P1-3/A3: chunk-warm every PREWARM_KINDS bucket (Post/Comment/Report/MuteList/… — everything the
   * switch's first, posts-first `buildFeed()` cold-warms) on the JUST-SWAPPED-IN store, so
   * activateWorkspace's REBUILD phase never pays the un-chunked `warmKind()`'s single-macrotask
   * SELECT + JSON.parse of up to TIMELINE_RETENTION rows PER KIND inside its final emit(). Reuses
   * the exact SqliteEventStore.warmKindChunked (via the SwappableEventStore passthrough) that
   * already chunk-warms the reaction bucket for the scored pass (warmReactionBucketChunked) — this
   * just calls it once per structural kind, sequentially. No extra yield is inserted BETWEEN kinds
   * (that would be a new idiom): warmKindChunked already yields a real `setTimeout(0)` macrotask
   * between every {@link WARM_CHUNK_ROWS} chunk WITHIN a kind, which is where the real cost lives —
   * a kind small enough to resolve in one chunk is cheap enough that skipping straight to the next
   * kind costs nothing. Best-effort and side-effect-free on failure: kind-7 reactions are
   * deliberately excluded (PREWARM_KINDS), same as the locked-screen pre-warm — the posts-first
   * build never touches that bucket, so warming it here would be wasted work.
   *
   * `gen` is the `_switchWarmGen` activateWorkspace captured right after clearSwitchCaches() (which
   * bumps it). Checked before every kind so a superseding community switch or a
   * removeCommunity/removeIdentity teardown aborts this pass before it touches a store — or, back
   * in activateWorkspace, emits — a workspace it no longer owns. On a store without warmKindChunked
   * (in-memory/jest, or a plain non-swappable EventStore) each call resolves immediately (same as
   * warmReactionBucketChunked), so this whole pass is a same-microtask no-op — it never inserts a
   * macrotask delay into a switch that has nothing to chunk-warm.
   */
  private async warmSwitchKindsChunked(gen: number): Promise<void> {
    const store = this.deps.store as EventStore & {
      warmKindChunked?: (kind: number, chunkRows?: number) => Promise<void>;
    };
    for (const k of AppRuntime.PREWARM_KINDS) {
      if (this._switchWarmGen !== gen) return; // superseded — never touch a store we no longer own
      try {
        await store.warmKindChunked?.(k);
      } catch {
        // best-effort — the eventual build's own sync warmKind still produces a correct bucket
      }
    }
  }

  /** Visible thread for a root, with community-moderator hides removed and the viewer's locally
   *  muted authors pruned (a muted comment takes its subtree with it, mirroring a moderator hide).
   *  The mute is device-only — see muteAuthor(). */
  getThread(postId: string): CommentNode[] {
    const visible = this.moderatedThread(postId).visible;
    if (this.mutedAuthors.size === 0) return visible;
    return partitionThread(visible, ev => this.mutedAuthors.has(resolveAuthorPubkey(ev))).visible;
  }

  // ── Local, device-only feed author mute (Fix 1) ────────────────────────────────────────────────
  // muteAuthor/unmuteAuthor/isAuthorMuted operate on an in-memory Set persisted to AsyncStorage per
  // identity slot. They publish NOTHING to the relay — no kind-10000 mute list, no event — so they
  // leak nothing and keep the relay fully blind (contrast moderatorHideUser, which signs+publishes a
  // NIP-51 mute list). The mute only filters what THIS device renders (visibleFeed + getThread).

  /** Hydrate the local muted-author set for the active slot. Purely local; [] on any error. */
  private async loadMutedAuthors(slotId: string | undefined): Promise<void> {
    this.mutedAuthors = new Set(slotId ? await this.readAsyncSet(mutedAuthorsKey(slotId)) : []);
    this._mutedVersion++;
    this._visibleFeedCache = undefined;
    this._mutedListCache = undefined;
  }

  /** Persist the muted-author set to this slot's AsyncStorage key. Best-effort (local convenience). */
  private async persistMutedAuthors(): Promise<void> {
    const key = this.activeSlotId ? mutedAuthorsKey(this.activeSlotId) : undefined;
    if (!key) return;
    try {
      await AsyncStorage.setItem(key, JSON.stringify([...this.mutedAuthors]));
    } catch {
      /* best-effort — a failed write just means the mute isn't persisted across restarts */
    }
  }

  /**
   * Mute a feed author LOCALLY (device-only). Their posts + comments stop rendering on this device
   * until unmuted. Publishes NOTHING — no relay event of any kind. Idempotent.
   */
  async muteAuthor(pubkey: string): Promise<void> {
    if (!pubkey || this.mutedAuthors.has(pubkey)) return;
    this.mutedAuthors.add(pubkey);
    this._mutedVersion++;
    this._visibleFeedCache = undefined;
    this._mutedListCache = undefined;
    this.emit();
    await this.persistMutedAuthors();
  }

  /** Un-mute a locally-muted author (device-only). Publishes NOTHING. Idempotent. */
  async unmuteAuthor(pubkey: string): Promise<void> {
    if (!this.mutedAuthors.delete(pubkey)) return;
    this._mutedVersion++;
    this._visibleFeedCache = undefined;
    this._mutedListCache = undefined;
    this.emit();
    await this.persistMutedAuthors();
  }

  /** Whether the viewer has locally muted this author (device-only). Synchronous. */
  isAuthorMuted(pubkey: string): boolean {
    return this.mutedAuthors.has(pubkey);
  }

  /** Snapshot-stable array of locally-muted author pubkeys (drives any unmute UI, e.g. Settings). */
  private cachedMutedAuthorPubkeys(): readonly string[] {
    const c = this._mutedListCache;
    if (c && c.ver === this._mutedVersion) return c.ids;
    const ids = [...this.mutedAuthors];
    this._mutedListCache = {ver: this._mutedVersion, ids};
    return ids;
  }

  /**
   * The feed with locally-muted authors removed. Memoized on the raw feed's identity + _mutedVersion
   * so the filtered array keeps a stable reference (React.memo on PostCard) across emits that change
   * neither. Zero-cost passthrough when nothing is muted (returns the raw feed as-is).
   */
  private visibleFeed(moderators: readonly string[], overlay?: ModerationOverlay): Feed {
    const raw = this._cachedBuildFeed(moderators, overlay);
    if (this.mutedAuthors.size === 0) return raw;
    const c = this._visibleFeedCache;
    if (c && c.raw === raw && c.mutedVer === this._mutedVersion) return c.feed;
    const feed: Feed = {items: raw.items.filter(i => !this.mutedAuthors.has(i.authorPubkey)), log: raw.log};
    this._visibleFeedCache = {raw, mutedVer: this._mutedVersion, feed};
    return feed;
  }

  /**
   * Record the CURRENT feed as "seen" — the read-position baseline
   * {@link AppSnapshot.newFeedItemCount} measures forward from (the feed UI's "N new posts" pill).
   * Call it once the feed on screen is the one "new" should be measured against: e.g. when the feed
   * tab first shows real content, or when the user taps the pill / scrolls back to the top to view
   * what just arrived.
   *
   * Computes the mark from a FRESH visibleFeed() call rather than trusting whatever snapshot happens
   * to be cached on {@link _lastSnapshot}: a store mutation (store.save) bumps the version counters
   * the instant it happens, but nothing re-derives `_lastSnapshot` until the next getSnapshot() call —
   * which, outside of the normal render/emit loop, isn't guaranteed to have happened yet (e.g. a
   * caller that reacts to an event straight off the wire, before any render). Reading a stale
   * snapshot here would silently under- or over-count everything that arrived since it was built.
   * visibleFeed/_cachedBuildFeed are themselves version-cached (see their docs), so this is a cache
   * HIT — and therefore cheap — in the common case where nothing changed since the last real build;
   * it only does real work exactly when there's a genuine change to account for, which is also
   * exactly when a stale answer would be wrong. No-op while not enrolled — nothing to mark.
   *
   * RETURNS whether the mark actually MOVED — i.e. whether any snapshot field could have changed as
   * a result. This exists so the UI host can skip the re-render on the (very common) repeat mark
   * against an unchanged feed: getSnapshot() builds a brand-new object on every call, so a host that
   * unconditionally setState()s its result can never bail out on Object.is and re-renders the whole
   * tree for nothing. It is also a hard bound on the render→mark→render cycle App.tsx's
   * handleMarkFeedSeen sits in: a mark can only trigger a render while it is still genuinely
   * advancing, which real content arrival bounds — so even if a future caller reintroduces an
   * unstable callback identity (the vc9 100%-CPU bug), the cycle terminates after one pass instead
   * of running forever. Idempotent by construction: calling it twice with no new content returns
   * false the second time.
   */
  markFeedSeen(): boolean {
    if (!this.enrolled) return false;
    const moderators = this.moderatorNpubs();
    const items = this.visibleFeed(moderators, this.cachedOverlay(moderators)).items;
    let mark = 0;
    for (const item of items) {
      if (item.createdAt > mark) mark = item.createdAt;
    }
    if (this._feedSeenMark === mark) return false;
    this._feedSeenMark = mark;
    return true;
  }

  /**
   * Count of `feed`'s items with a wire `createdAt` strictly newer than the last {@link markFeedSeen}
   * mark. Backs {@link AppSnapshot.newFeedItemCount} — see its doc for the 0-before-a-mark /
   * 0-after-a-switch contract.
   *
   * Deliberately createdAt-only — NOT sortFeed's sortAt-preferring `at()` recency key (feed/sort.ts).
   * `sortAt` exists solely to locally reorder the viewer's OWN posts past their bucket-fuzzed wire
   * timestamp (FeedItem.sortAt's doc, audit #48), is in MILLISECONDS, and is undefined for every
   * other author — mixing it into a createdAt-SECONDS comparison here would read every own post from
   * anytime this session as "newer" than any real timestamp (the identical unit trap sort.ts's
   * risingScore doc warns against). Excluding it costs nothing: the viewer already saw their own post
   * render instantly via the optimistic-write path (scheduleOptimisticEmit) — it doesn't need a "new
   * content" pill to announce it too. A blind post's createdAt can be fuzzed up to
   * BLIND_TS_BUCKET_SECONDS (180s) backward, which can rarely undercount a just-arrived post by that
   * margin — an existing, accepted imprecision of the whole ordering scheme (sortFeed's 'new' mode
   * carries the identical limit), not one this introduces.
   *
   * Version-cached on the exact `feed` reference crossed with the mark (see _newFeedCountCache): a
   * getSnapshot() that leaves the feed untouched (a channel/group-only write, or simply no relay
   * event since the last call) is an O(1) hit. A genuine feed change is one O(n) scan reading an
   * already-computed field off already-built FeedItems — buildFeed/toFeedItem are never invoked here
   * — which is what keeps this affordable to compute on every emit rather than a full feed rebuild.
   */
  private newFeedItemCountSince(feed: Feed): number {
    const mark = this._feedSeenMark;
    if (mark === undefined) return 0;
    const c = this._newFeedCountCache;
    if (c && c.feed === feed && c.mark === mark) return c.count;
    let count = 0;
    for (const item of feed.items) {
      if (item.createdAt > mark) count++;
    }
    this._newFeedCountCache = {feed, mark, count};
    return count;
  }

  /**
   * Resolve the original post + thread behind a moderation-log entry, for the Log's full-post
   * view. When the target is a comment, we open its ROOT post so the comment shows in context.
   * The post may itself be hidden (it's then found in the feed's moderation log), so we look in
   * both the visible feed and the hidden log. Returns a null item when the post isn't cached.
   */
  getLogPost(targetId: string): {item: FeedItem | null; thread: CommentNode[]} {
    const ev = this.deps.store.getById(targetId);
    const isComment = ev ? ev.kind === Kind.Comment || isStiqComment(ev) : false;
    const rootId = ev && isComment ? commentRootId(ev) ?? targetId : targetId;
    const moderators = this.moderatorNpubs();
    const feed = this._cachedBuildFeed(moderators, moderationOverlay(this.deps.store, moderators));
    const item =
      feed.items.find(i => i.id === rootId) ??
      feed.log.find(l => l.item.id === rootId)?.item ??
      // Auto-hidden posts (organizer rules) are dropped from the feed AND aren't in the moderation
      // log's routed set, so resolve them straight from the store — otherwise the log entry opens an
      // empty view and its removed-content card looks dead.
      this.feedItemFor(rootId);
    // The mod-log post view is a moderation INSPECTION surface: show the FULL thread (including the
    // comments moderators hid), not the reader-facing `getThread` which filters hidden ones out — so
    // clicking a removed comment actually renders it in context rather than silently dropping it.
    return {item, thread: buildThread(this.deps.store, rootId)};
  }

  /**
   * Resolve a single event id to a FeedItem straight from the store — for posts that live OUTSIDE
   * the visible feed and the routed moderation log (e.g. an organizer auto-hidden post). Lets the
   * mod-log view and the saved-embeds picker render any post the user can reference. Enriches with
   * the same vote score + display name/gradient the feed would compute.
   */
  feedItemFor(id: string): FeedItem | null {
    const ev = this.deps.store.getById(id);
    if (!ev) return null;
    const {score, myVote} = this.getEventScore(id);
    // F-attribution fix (item 2b): resolve through the shared resolver (attestation-first, then
    // phonebook, then npub+seed) rather than a phonebook-only lookup — this event may never have
    // passed through buildFeed's own attestation-teaching pass (e.g. an auto-hidden or evicted post),
    // so a bare `nameFor` here used to render anonymous even when the post's own attestation named
    // its author.
    const identity = this.resolveIdentity(ev);
    return toFeedItem(ev, score, undefined, myVote, undefined, identity.name, identity.gradient);
  }

  /**
   * Classify a FeedItem into the 5 organizer-configurable post types (note/article/picture/
   * voice/poll) the notification prefs gate on. There is no dedicated Nostr kind for "picture" —
   * inline pictures/voice clips are embedded in a kind-1 note or kind-30023 article body — so this
   * reuses the same feed-derived signals (FeedItem.voice / imageUrl / images) the composer and
   * feed cards already use to detect them, checked in order of specificity (poll/article kinds are
   * unambiguous; voice and inline pictures are mutually exclusive per the composer's media cap).
   */
  private postTypeOfFeedItem(item: FeedItem): PostType {
    if (item.kind === Kind.Poll) return 'poll';
    if (item.kind === Kind.Article) return 'article';
    if (item.voice) return 'voice';
    if (item.imageUrl || (item.images && item.images.length > 0)) return 'picture';
    return 'note';
  }

  /**
   * Live-derived notification center (no persisted log): replies to my posts, the latest incoming
   * DM per peer, the latest broadcast per known channel, and members' new public feed posts — each
   * filtered through isNotifAllowed() (the SAME decision authority the push composers use in
   * notifications.ts) and sorted newest-first. Rows carry the design's structured text
   * (actor / action / target / preview), an avatar spec, and their current read flag. Pure read of
   * already-cached state — no HWM advance, no delivery side effect — so calling it repeatedly
   * (e.g. on every emit, to compute notifUnreadCount) is safe.
   *
   * Version-cached — see _notifCache's doc for the full key.
   */
  deriveNotifications(): NotifItem[] {
    if (!this.myPubkey) return [];
    const prefs = getPrefs();
    const ver = this.storeVersionOf([
      Kind.Comment, Kind.GiftWrap, Kind.LiveChat, Kind.LiveActivity,
      // Posts source: the feed post kinds + reports (moderation drops a hidden post's row).
      Kind.Post, Kind.Article, Kind.Poll, KIND_VOICE_MESSAGE, Kind.Report,
      // Join-request source (admins of closed groups): the group roster state — 39002 members +
      // 39001 admins gate the source, and 39004 pending IS the request set. WITHOUT these the cache
      // never invalidates on a new/cleared request and the requests source is dead on arrival.
      GroupKind.Members, GroupKind.Admins, GroupKind.Pending,
      // SCOPED_CHANNEL_SYNC only: the channel rows below are scoped by channelSyncSet(), which reads
      // the member's NIP-51 kind-10009 follow list — so following/unfollowing a channel now CHANGES
      // this list's contents. Without 10009 in the key the cache would keep serving the pre-Follow
      // rows until some unrelated kind happened to bump. Added conditionally because with the flag
      // off the derivation does not read 10009 at all, and widening the key would invalidate this
      // cache on every Follow for no change in output.
      ...(SCOPED_CHANNEL_SYNC ? [Kind.ChannelSubscriptions] : []),
      // Draft-access source (Phase 5§G): DraftAccessRequest (owner-side queue) + DraftDelivery
      // (requester-side "granted") events, plus Kind.AppData (grant/revoke docs — the SAME broad
      // bucket other AppData-keyed caches in this file already fold in, e.g. line ~8611; a draft's
      // access-list doc is just one more AppData subtype riding it).
      Kind.DraftAccessRequest, Kind.DraftDelivery, Kind.AppData,
    ]);
    const identityVersion = this._identityVersion;
    const prefsVersion = this._prefsVersion;
    const readVersion = this._readVersion;
    const mutedVersion = this._mutedVersion;
    // Phase 5§G: a silent deny never touches the store (no relay-visible event), so it needs its own
    // version signal — see _draftAccessDenyVersion's doc.
    const draftDenyVersion = this._draftAccessDenyVersion;
    // Phase 5§G: a DraftDelivery's decrypt finishes strictly AFTER the event itself already bumped
    // `ver` — see _draftDeliveryDecryptVersion's doc.
    const draftDeliveryVersion = this._draftDeliveryDecryptVersion;
    const c = this._notifCache;
    if (
      ver !== undefined &&
      c !== undefined &&
      c.ver === ver &&
      c.identityVersion === identityVersion &&
      c.prefsVersion === prefsVersion &&
      c.readVersion === readVersion &&
      c.mutedVersion === mutedVersion &&
      c.draftDenyVersion === draftDenyVersion &&
      c.draftDeliveryVersion === draftDeliveryVersion &&
      c.inbox === this.inbox &&
      c.myPubkey === this.myPubkey
    ) {
      return c.items;
    }

    // Text shaping for the center rows (design: single-space-squeezed excerpts, curly-quoted
    // messages/titles, 2-line preview clamp handled by the renderer).
    const excerpt = (s: string, max: number): string => {
      const t = s.replace(/\s+/g, ' ').trim();
      return t.length > max ? `${t.slice(0, max - 1)}…` : t;
    };
    const quoted = (s: string): string => `“${s}”`;

    const items: NotifItem[] = [];

    // Replies to my posts — BOTH comment representations (NIP-22 conflict resolution, see
    // feed/comments.ts): kind-1111 comments (any non-note root) and hybrid kind-1 'stiq-comment'
    // notes (root is a plain post — the majority case). Mirrors thread.ts's buildThread union: query
    // the Post bucket once and partition in a single pass instead of a separate .filter call.
    // The "is this for me" gate mirrors handleIncomingEvent's live notifyComment call: notify when I
    // authored the thread ROOT (someone replied to my post) OR the immediate PARENT (someone replied
    // to MY comment, even inside someone else's thread). A single event is visited once in this loop,
    // so root===me && parent===me (a reply to my comment on my own post) still yields exactly one row.
    // Honor the legacy all-comments mute the push path checks (allCommentsMuteId) so a muted source
    // doesn't keep listing + lighting the bell.
    const commentsMuted = isSourceMutedSync(allCommentsMuteId);
    const kind1Posts = this.deps.store.query({kinds: [Kind.Post]});
    const stiqComments: Event[] = [];
    for (const ev of kind1Posts) {
      if (isStiqComment(ev)) stiqComments.push(ev);
    }
    const replyEvents = [...this.deps.store.query({kinds: [Kind.Comment]}), ...stiqComments];
    for (const ev of replyEvents) {
      if (commentsMuted) break;
      const rootAuthorPubkey = commentRootAuthor(ev);
      const parentAuthorPubkey = commentParentAuthor(ev);
      if (rootAuthorPubkey !== this.myPubkey && parentAuthorPubkey !== this.myPubkey) continue;
      // A comment publishes BLIND: signed by a per-post throwaway key, with the real author sealed in
      // the encrypted stiq_attr attestation. So resolve the real identity (never the raw ev.pubkey) —
      // otherwise (a) my OWN reply, whose throwaway signer ≠ my npub, slips past this self-skip and
      // notifies me, and (b) a peer's reply renders "Someone" over a stranger's seed-gradient because
      // the phonebook has no name for the throwaway. This is the resolveIdentity rule the embed-card
      // fix pinned (getEvent was the last hold-out then; the notification centre was another).
      const commenter = this.resolveIdentity(ev);
      if (commenter.pubkey === this.myPubkey) continue; // my own reply — never notify me

      const rootId = commentRootId(ev);
      if (!rootId) continue;
      const rootItem = this.feedItemFor(rootId);
      const postType = rootItem ? this.postTypeOfFeedItem(rootItem) : undefined;
      const desc: NotifDescriptor = {kind: 'reply', postType};
      if (!isNotifAllowed(prefs, desc)) continue;
      const name = commenter.name;
      // Immediate parent, across both forms (commentParentId handles NIP-22 lowercase 'e' and the
      // hybrid form's reply/root markers). When that parent is my own comment, the reply targets my
      // comment, not the post itself — phrase it per the design's copy table. The parent is a comment
      // too, so resolve ITS real author the same way (a blind parent's ev.pubkey is a throwaway).
      const parentId = commentParentId(ev);
      const parent = parentId && parentId !== rootId ? this.deps.store.getById(parentId) : null;
      // A comment on a shared DRAFT has no published post — its synthetic root carries the
      // DRAFT_COMMENT_ROOT_KIND sentinel (stamped on the kind-1111's uppercase 'K' tag by buildComment).
      // Phrase it as a draft, and never try to title the (nonexistent) root post.
      const isDraftRoot =
        ev.kind === Kind.Comment &&
        ev.tags.find(t => t[0] === 'K' && t[1])?.[1] === String(DRAFT_COMMENT_ROOT_KIND);
      const action =
        parent && this.resolveIdentity(parent).pubkey === this.myPubkey
          ? 'replied to your comment on'
          : isDraftRoot
          ? 'commented on your draft'
          : 'commented on your post';
      // Title the root post the way a human reads it: its title, else a one-line summary of its body —
      // run through inlineMediaSummary so an embed-only post ("stiq:draft:…", an event card, …) shows
      // its label ("✍ Draft") instead of leaking the raw base64 token as gibberish.
      const rootTitle = rootItem ? rootItem.title ?? excerpt(inlineMediaSummary(rootItem.content), 48) : '';
      const body = resolveContent(ev);
      const previewText = body.locked ? '' : excerpt(inlineMediaSummary(decodeNameHeader(body.text).text), 140);
      items.push({
        id: ev.id,
        ts: ev.created_at,
        kind: 'reply',
        target: {kind: 'post', rootId},
        read: isNotifRead(ev.id, ev.created_at),
        actor: name || 'Someone',
        action,
        targetText: rootTitle ? quoted(rootTitle) : undefined,
        preview: previewText ? quoted(previewText) : undefined,
        avatar: {shape: 'circle', seed: commenter.npub, gradient: commenter.gradient},
      });
    }

    // DMs — latest incoming message per peer (mirrors the push path's per-conversation notify loop).
    for (const conv of this.inbox) {
      const latest = this.latestIncoming(conv.messages);
      if (!latest) continue;
      if (isSourceMutedSync(dmMuteId(latest.sender))) continue; // honor the per-peer push mute
      const desc: NotifDescriptor = {kind: 'dm', peer: latest.sender};
      if (!isNotifAllowed(prefs, desc)) continue;
      const name = this.displayNames.nameFor(latest.sender);
      const previewText = excerpt(inlineMediaSummary(decodeNameHeader(latest.text).text), 140);
      items.push({
        id: latest.id,
        ts: latest.createdAt,
        kind: 'dm',
        target: {kind: 'dm', peer: latest.sender},
        read: isNotifRead(latest.id, latest.createdAt),
        actor: name || 'Someone',
        action: 'sent you a message',
        preview: previewText ? quoted(previewText) : undefined,
        avatar: {shape: 'circle', seed: conv.peerNpub, gradient: this.gradientFor(latest.sender)},
      });
    }

    // Channel broadcasts — the latest per channel. One pass over Kind.LiveChat, bucketed by the
    // channel's `a` coordinate, mirrors _buildChannels()'s latest-by-coordinate style rather than
    // re-querying the store once per channel.
    //
    // SCOPED_CHANNEL_SYNC narrows this from "every known channel" to "channels the member is a part
    // of", and BOTH halves of that are load-bearing:
    //   • Non-joined channels stop raising rows. Their messages no longer stream (that is the whole
    //     point of the scoping), so leaving the loop broad would just mean rows that silently stop
    //     appearing. This is the intended behaviour and matches the ask — a channel you never joined
    //     should not be notifying you. Channels you ARE in still badge and notify exactly as before,
    //     because the plan's standing `channels` sub keeps their messages arriving whether or not you
    //     open them.
    //   • DECOY channels must stay INERT. The scoped sub deliberately fetches a few channels the
    //     member is NOT in, as cover traffic. Without this scoping those decoys would surface as real
    //     notifications — the user would be pinged by a handful of arbitrary channels they never
    //     joined, which is both nonsense UX and a tell. Cover traffic must be invisible above the
    //     wire, exactly like the DM sub's decoy gift wraps (which simply fail to decrypt) and the
    //     self-list sub's decoy lists (which every consumer reads back filtered to `authors:[me]`).
    // Flag off: channelSyncSet() is unused and the loop stays over every known channel, as today.
    const channels = this.listChannels();
    const channelIds = new Set(
      SCOPED_CHANNEL_SYNC ? this.channelSyncSet() : channels.map(ch => ch.id),
    );
    const latestByChannel = new Map<string, Event>();
    for (const ev of this.deps.store.query({kinds: [Kind.LiveChat]})) {
      const cid = ev.tags.find(t => t[0] === 'a')?.[1];
      if (!cid || !channelIds.has(cid)) continue;
      if (ev.pubkey === this.myPubkey) continue; // my own broadcast — never notify me
      // An EDIT is not new activity: it must neither mint a fresh notification (its own id would
      // re-notify a message the user already read) nor let its fresh created_at outrank a genuinely
      // newer broadcast. The row is keyed to the ORIGINAL; the edit only refreshes the preview text.
      if (editTargetId(ev)) continue;
      const prev = latestByChannel.get(cid);
      if (!prev || ev.created_at > prev.created_at) latestByChannel.set(cid, ev);
    }
    for (const ch of channels) {
      const latestEv = latestByChannel.get(ch.id);
      if (!latestEv) continue;
      if (isSourceMutedSync(chMuteId(ch.id))) continue; // honor the per-channel push mute
      // NIP-53 Live Activities are the only channels listChannels() returns — always 'channel'/'public'.
      const desc: NotifDescriptor = {kind: 'channel', channelId: ch.id, channelType: 'channel'};
      if (!isNotifAllowed(prefs, desc)) continue;
      const posterName = this.displayNames.nameFor(latestEv.pubkey);
      // Preview through the edit fold so the row shows the broadcast's CURRENT text.
      const shownEv = foldChannelEdit(this.deps.store, latestEv) ?? latestEv;
      const previewText = excerpt(inlineMediaSummary(decodeNameHeader(shownEv.content).text), 140);
      items.push({
        id: latestEv.id,
        ts: latestEv.created_at,
        kind: 'channel',
        target: {kind: 'channel', channelId: ch.id, channelType: 'public'},
        read: isNotifRead(latestEv.id, latestEv.created_at),
        // Design copy: "<poster> posted in #channel"; when the poster has no resolvable name the
        // channel itself is the actor ("#channel has a new post") rather than a raw npub.
        actor: posterName || `#${ch.name}`,
        action: posterName ? 'posted in' : 'has a new post',
        targetText: posterName ? `#${ch.name}` : undefined,
        preview: previewText || undefined,
        avatar: {shape: ch.openCommunity ? 'octagon' : 'square', seed: ch.id, gradient: ch.gradient},
      });
    }

    // New public posts from members — the design's fourth source ("Posts" chip). Reuses the exact
    // moderated + locally-muted-filtered feed the Feed tab renders, windowed to the last 7 days
    // (the center's Today / This week horizon) and capped so a cold sync can't flood the list.
    const moderators = this.moderatorNpubs();
    const feed = this.visibleFeed(moderators, moderationOverlay(this.deps.store, moderators));
    const postFloor = Math.floor(Date.now() / 1000) - 7 * 86400;
    const postItems = feed.items
      .filter(i => i.authorPubkey !== this.myPubkey && i.createdAt >= postFloor)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
    for (const item of postItems) {
      const desc: NotifDescriptor = {kind: 'post', postType: this.postTypeOfFeedItem(item)};
      if (!isNotifAllowed(prefs, desc)) continue;
      const previewText = item.title ?? excerpt(item.content, 140);
      items.push({
        id: item.id,
        ts: item.createdAt,
        kind: 'post',
        target: {kind: 'post', rootId: item.id},
        read: isNotifRead(item.id, item.createdAt),
        actor: item.authorName || 'A member',
        action: 'posted publicly',
        preview: previewText || undefined,
        // FeedItem.author is already the npub — the same seed every feed avatar uses.
        avatar: {shape: 'circle', seed: item.author, gradient: item.authorGradient},
      });
    }

    // Pending join requests — for every CLOSED group I administer, so a request badges + notifies
    // even when I never open that group's Manage page (the whole point of this source). Gated exactly
    // like the channel source's TWO mutes: the GroupView info-sheet toggle (grp:<id>) AND the
    // notification-prefs per-group/per-channel toggle (isNotifAllowed with a 'group' channel
    // descriptor). getJoinRequestQueue already unseals the requester's name, excludes auto-approving
    // invited accepts (filtered again here), and — via the roster overlay — omits requests an admin
    // just approved/denied. Bounded to the handful of groups I run. Tap routes to the Manage page.
    if (this.myPubkey) {
      const me = this.myPubkey;
      for (const gid of this.joinedGroups) {
        if (!groupAdminsOf(this.deps.store, gid).includes(me)) continue;
        const state = groupStateOf(this.deps.store, gid);
        if (!state?.closed) continue;
        if (isSourceMutedSync(`grp:${gid}`)) continue; // GroupView's per-group mute toggle
        const desc: NotifDescriptor = {kind: 'channel', channelId: gid, channelType: 'group'};
        if (!isNotifAllowed(prefs, desc)) continue;
        // Group avatar convention (GroupView.avatarShape): a broadcast space reads as a diamond
        // (private channel), everything else as a hexagon (group).
        const shape = state.broadcast ? 'diamond' : 'hexagon';
        const groupName = state.name || 'a space';
        for (const rq of this.getJoinRequestQueue(gid)) {
          if (rq.invited) continue; // invited accepts auto-approve — not a pending decision
          if (!rq.reqId) continue; // no raw 9021 yet → no stable id to key read-state on
          const ts = rq.at ?? Math.floor(Date.now() / 1000);
          items.push({
            id: rq.reqId,
            ts,
            kind: 'channel',
            target: {kind: 'group_requests', groupId: gid},
            read: isNotifRead(rq.reqId, ts),
            actor: rq.name || 'Someone',
            action: 'requested to join',
            targetText: groupName,
            avatar: {shape, seed: gid, gradient: state.gradient},
          });
        }
      }
    }

    // Draft access requests — OWNER side (Phase 5§G). Someone asked to view one of MY shared drafts
    // and I haven't granted or (silently) denied them yet. Mirrors the join-request block just above
    // in spirit — a pending ask routed to a "manage" surface — but collapses to ONE actionable row
    // PER DRAFT rather than one row per request: a "Manage access" screen shows the WHOLE queue for
    // that draft at once (mirrors group_requests routing to a single Manage page), so one notification
    // is enough to say "there's something to review here", closer to the channel-broadcast block's
    // "latest per source" collapse than the join-request block's "one row per request". Scanning
    // DraftAccessRequest events addressed to me (`p == me`) directly — rather than cross-referencing
    // AppRuntime's own draft list — is deliberate: `getDraftAccessQueue` itself needs no such
    // cross-reference (a request is "mine to decide" purely by virtue of naming ME as the `p` tag),
    // and AppRuntime has no SYNCHRONOUS view of the (async, SecureStorage-backed) DraftStore for
    // deriveNotifications to read here. One consequence: this row cannot show the draft's title
    // (not carried on the request event, and not available without an async draft-store read) — the
    // Manage-access screen the tap opens resolves that once the local draft is looked up there.
    if (this.myPubkey) {
      const me = this.myPubkey;
      const pendingDraftIds = new Set<string>();
      for (const ev of this.deps.store.query({kinds: [Kind.DraftAccessRequest]})) {
        if (!ev.tags.some(t => t[0] === 'p' && t[1] === me)) continue;
        const draftId = ev.tags.find(t => t[0] === 'd')?.[1];
        if (draftId) pendingDraftIds.add(draftId);
      }
      for (const draftId of pendingDraftIds) {
        if (isSourceMutedSync(draftMuteId(draftId))) continue; // a future Manage-access mute toggle
        // getDraftAccessQueue already excludes requesters I've already granted (getDraftAccessGranted
        // instead) or silently denied (_draftAccessDenied) — every entry here is genuinely pending.
        const queue = this.getDraftAccessQueue(draftId);
        if (queue.length === 0) continue;
        const latest = queue[0]!; // sorted desc by `at` — the most recently asking requester
        // Gated on the dedicated `drafts` category. This first shipped borrowing the group-channel
        // descriptor as the closest existing analog, which meant silencing draft requests also
        // silenced group-join requests — one switch could not express "join requests yes, draft
        // chatter no". See NotificationPrefs.drafts.
        const desc: NotifDescriptor = {kind: 'draft', event: 'request'};
        if (!isNotifAllowed(prefs, desc)) continue;
        const others = queue.length - 1;
        items.push({
          id: latest.reqId,
          ts: latest.at,
          kind: 'draft',
          target: {kind: 'draft_requests', draftId},
          read: isNotifRead(latest.reqId, latest.at),
          actor: latest.name || 'Someone',
          action:
            others > 0
              ? `and ${others} other${others === 1 ? '' : 's'} requested access to your draft`
              : 'requested access to your draft',
          avatar: {
            shape: 'circle',
            seed: nip19.npubEncode(latest.pubkey),
            gradient: this.gradientFor(latest.pubkey),
          },
        });
      }
    }

    // Draft access GRANTED — REQUESTER side (Phase 5§G). Genuinely new ground: a group-join approval
    // notifies nobody at all (the requester only discovers it by polling membership state) — this is
    // the first "your request was approved" notification in the app. Derived by noticing a
    // DraftDelivery addressed to me whose CURRENT latest event (by created_at, per draftId) decrypts
    // to a real snapshot — a revoke's tombstone (or a not-yet-approved/undecryptable delivery) yields
    // no row, so a silent denial and a silent revoke both stay exactly that: silent. The decrypt
    // reuses the SAME _draftDeliveryCache getMyDraftDelivery populates (never a second, divergent
    // decrypt path) — an uncached delivery kicks getMyDraftDelivery in the background (which caches +
    // emits on completion) and is skipped THIS pass, picked up on the re-derive right after.
    if (this.myPubkey) {
      const me = this.myPubkey;
      const latestDeliveryByDraft = new Map<string, Event>();
      for (const ev of this.deps.store.query({kinds: [Kind.DraftDelivery]})) {
        if (!ev.tags.some(t => t[0] === 'p' && t[1] === me)) continue;
        const draftId = this.draftIdFromDeliveryTag(ev, me);
        if (!draftId) continue;
        const prev = latestDeliveryByDraft.get(draftId);
        if (!prev || ev.created_at > prev.created_at) latestDeliveryByDraft.set(draftId, ev);
      }
      for (const [draftId, ev] of latestDeliveryByDraft) {
        const cached = this._draftDeliveryCache.get(draftId);
        if (!cached || cached.eventId !== ev.id) {
          void this.getMyDraftDelivery(draftId, ev.pubkey); // fire-and-forget: caches + emits when done
          continue;
        }
        if (!cached.snapshot) continue; // tombstone (revoked) or corrupt — nothing to notify about
        if (isSourceMutedSync(dmMuteId(ev.pubkey))) continue; // honor a DM mute of the owner too
        // Gated on the dedicated `drafts` category — same switch as the request block above, since
        // the two are halves of one conversation. Previously this borrowed the DM descriptor (a
        // DraftDelivery is mechanically DM-shaped: a private seal riding `#p == me`), which meant
        // turning off draft approvals also turned off DMs. The explicit DM-mute check on the line
        // above is kept: muting the OWNER as a person still suppresses their approval.
        const desc: NotifDescriptor = {kind: 'draft', event: 'granted'};
        if (!isNotifAllowed(prefs, desc)) continue;
        items.push({
          id: ev.id,
          ts: ev.created_at,
          kind: 'draft',
          target: {kind: 'draft_reader', draftId, ownerPubkey: ev.pubkey},
          read: isNotifRead(ev.id, ev.created_at),
          actor: this.displayNames.nameFor(ev.pubkey) || 'Someone',
          action: 'approved your request to read',
          targetText: cached.snapshot.ti ? quoted(cached.snapshot.ti) : undefined,
          avatar: {shape: 'circle', seed: nip19.npubEncode(ev.pubkey), gradient: this.gradientFor(ev.pubkey)},
        });
      }
    }

    items.sort((a, b) => b.ts - a.ts);
    const capped = items.length > 100 ? items.slice(0, 100) : items;

    if (ver !== undefined) {
      this._notifCache = {
        ver, identityVersion, prefsVersion, readVersion, mutedVersion,
        draftDenyVersion, draftDeliveryVersion,
        inbox: this.inbox, myPubkey: this.myPubkey, items: capped,
      };
    }
    return capped;
  }

  /** Latest message in a conversation not sent by me — backward scan, no reversed-copy allocation. */
  private latestIncoming<T extends {sender: string}>(messages: readonly T[]): T | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.sender !== this.myPubkey) return m;
    }
    return undefined;
  }

  /** Mark one notification read (center row tap) — clears its dot and drops the badge count. */
  async markNotificationRead(id: string): Promise<void> {
    // Update the in-memory read mirror BEFORE bumping the cache key + emitting, so the re-derive
    // sees the new state (the screen shows its own optimistic clear in the meantime).
    await markNotifRead(id);
    this._readVersion++;
    this.emit();
  }

  /** Mark every notification read (center ✓✓ Mark-all-read) — clears all dots and the badge. */
  async markAllNotificationsRead(): Promise<void> {
    await markAllNotifsRead(Math.floor(Date.now() / 1000));
    this._readVersion++;
    this.emit();
  }

  /** Current notification preferences (dm/channel/post-type/reply/hide-names toggles). */
  getNotificationPrefs(): NotificationPrefs {
    return getPrefs();
  }

  /**
   * Persist new notification preferences. Bumps _prefsVersion so deriveNotifications() re-filters
   * on the very next call even though no store event moved, then re-emits so the bell/list refresh.
   */
  async setNotificationPrefs(next: NotificationPrefs): Promise<void> {
    await savePrefs(next);
    this._prefsVersion++;
    this.emit();
  }

  /**
   * Split a thread into visible comments and those hidden by community moderators.
   *
   * Post authors have NO moderation authority over comments on their own posts — only the
   * organizer's signed moderator roster can hide content. A comment is hidden community-wide
   * only when a current moderator reported it (kind-1984) or its author is on a moderator's
   * mute list.
   */
  private moderatedThread(rootId: string): {visible: CommentNode[]; hidden: CommentNode[]} {
    const tree = buildThread(this.deps.store, rootId);
    const modHides = this.cachedModeratorHides(this.moderatorNpubs());
    return partitionThread(tree, ev => isModeratorHidden(ev, modHides) || isUnattributedBlindPost(ev));
  }

  // ── Moderator-global actions (Phase C) ────────────────────────────────────────────────
  // These take effect community-wide only when the signer is in the organizer's roster; the
  // filter ignores actions from non-moderators, so the UI gates these on snapshot.isModerator.

  /**
   * The removal-report content snapshot for `targetId` (report.ts's CONTENT_SNAPSHOT_TAG): the
   * cached body when it's plaintext or already unlocked, else undefined. A kind-1984 report is
   * append-only and PUBLISHED — a still-sealed target's ciphertext must never be embedded in one
   * (it would be frozen there forever), so a locked target omits the snapshot entirely rather than
   * degrading it; buildRemoveReport already treats an absent snapshot as "attach none".
   */
  private contentSnapshotFor(targetId: string): string | undefined {
    const ev = this.deps.store.getById(targetId);
    if (!ev) return undefined;
    const body = resolveContent(ev);
    return body.locked ? undefined : body.text;
  }

  /** Moderator: hide a post or comment for everyone (append-only kind-1984 report). */
  async moderatorHide(
    targetId: string,
    authorPubkey?: string,
    reasonId?: string,
    note?: string,
  ): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildRemoveReport(targetId, {authorPubkey, reasonId, note, contentSnapshot: this.contentSnapshotFor(targetId)}));
    await this.publishOptimistic(event);
  }

  /** Moderator: restore (un-hide) a previously hidden post or comment. */
  async moderatorRestore(targetId: string, authorPubkey?: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildRestore(targetId, {authorPubkey}));
    await this.publishOptimistic(event);
  }

  /** Moderator: ban a user with a fixed message; their posts auto-hide + log until unbanned. */
  async moderatorBan(pubkey: string, message: string, untilSec?: number): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildBan(pubkey, {message, untilSec}));
    await this.publishOptimistic(event);
  }

  /** Moderator: lift a ban on a user. */
  async moderatorUnban(pubkey: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildUnban(pubkey));
    await this.publishOptimistic(event);
  }

  // ── Advisory-only moderation (blind posts): mods remove NOTHING; they broadcast signed
  // directives that tell clients to RENDER an author's/event's posts in the mod log instead of the
  // feed. Signed by the moderator's npub so the roster verifies them; content stays on the relay.

  /** Moderator: standing rule — render every post from this npub in the mod log (reversible). */
  async moderatorLogUser(pubkey: string): Promise<void> {
    if (!this.identity) return;
    await this.publishOptimistic(await this.identity.sign(buildLogUser(pubkey)));
  }

  /** Moderator: cancel a standing rule — the author's posts return to the feed. */
  async moderatorUnlogUser(pubkey: string): Promise<void> {
    if (!this.identity) return;
    await this.publishOptimistic(await this.identity.sign(buildUnlogUser(pubkey)));
  }

  /** Moderator: render one event in the mod log (reverse with moderatorRestore). */
  async moderatorLogEvent(eventId: string, authorPubkey?: string): Promise<void> {
    if (!this.identity) return;
    await this.publishOptimistic(await this.identity.sign(buildLogEvent(eventId, authorPubkey)));
  }

  /** Moderator: render a batch of an author's PAST events in the mod log (the "+ past posts"
   *  option when banning an npub). */
  async moderatorLogBatch(eventIds: string[], authorPubkey: string): Promise<void> {
    if (!this.identity || eventIds.length === 0) return;
    await this.publishOptimistic(await this.identity.sign(buildLogBatch(eventIds, authorPubkey)));
  }

  /** Moderator: hide a user globally (add them to the moderator's kind-10000 mute list). */
  async moderatorHideUser(pubkey: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const current = blockedPubkeys(this.deps.store, this.myPubkey);
    if (current.has(pubkey)) return;
    current.add(pubkey);
    const event = await this.identity.sign(buildMuteList([...current]));
    await this.publishOptimistic(event);
  }

  /** Moderator: un-hide a user (republish the mute list without them). */
  async moderatorUnhideUser(pubkey: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const current = blockedPubkeys(this.deps.store, this.myPubkey);
    if (!current.has(pubkey)) return;
    current.delete(pubkey);
    const event = await this.identity.sign(buildMuteList([...current]));
    await this.publishOptimistic(event);
  }

  /** Moderator: lock or unlock a thread (append-only kind-1984 stiq-action). A locked thread
   *  keeps its content but takes no new comments — enforced client-side via the snapshot's
   *  lockedPostIds (the relay does not gate kind-1111 feed comments). */
  async moderatorLockThread(targetId: string, lock: boolean, authorPubkey?: string): Promise<void> {
    if (!this.identity) return;
    const build = lock ? buildLockThread : buildUnlockThread;
    const event = await this.identity.sign(build(targetId, {authorPubkey}));
    await this.publishOptimistic(event);
  }

  /** Moderator: re-tag a post's type label (append-only kind-1984 stiq-action carrying the new
   *  ['l', label, 'stiq.type'] tag). The feed overlays this label over the author's. */
  async moderatorRetag(targetId: string, label: PostLabel, authorPubkey?: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildRetag(targetId, label, {authorPubkey}));
    await this.publishOptimistic(event);
  }

  /** Moderator: pin or unpin a post to the top of the feed (append-only kind-1984 stiq-action). */
  async moderatorPin(targetId: string, pin: boolean, authorPubkey?: string): Promise<void> {
    if (!this.identity) return;
    const build = pin ? buildPin : buildUnpin;
    const event = await this.identity.sign(build(targetId, {authorPubkey}));
    await this.publishOptimistic(event);
  }

  /**
   * Whether this peer's DMs are effectively blocked for the viewer — drives the DM block footer and
   * inbox hiding. Purely local + device-scoped: a local decision (block/allow) layered over any
   * MODERATOR removal (a moderator's kind-10000 mute list). NOTHING is published to the relay for a
   * DM block; the moderator mute is the moderator's own already-published event. Precedence: an
   * explicit local decision always wins (so a user can un-block a moderator-removed peer), otherwise
   * the peer follows the moderator mute.
   */
  isUserBlocked(pubkey: string): boolean {
    return this.effectiveDmBlocked(pubkey);
  }

  /** Effective DM block state = local decision ⊕ moderator auto-block (see {@link isUserBlocked}). */
  effectiveDmBlocked(pubkey: string): boolean {
    const decision = blocklistLocalDecision(pubkey);
    if (decision === 'allow') return false; // explicit local override wins over a moderator mute
    if (decision === 'block') return true;
    return this.dmModMuted().has(pubkey); // moderator-removed → auto-blocked on every client
  }

  /**
   * The instant (epoch seconds) from which this peer is effectively blocked, or undefined if not
   * blocked. DMs received before it are kept history (hidden, restorable on unblock); DMs after it
   * are deleted on arrival ({@link dropBlockedArrivals}). A local block uses its own recorded time; a
   * moderator auto-block uses the mute list's created_at.
   */
  private dmBlockSince(pubkey: string): number | undefined {
    const decision = blocklistLocalDecision(pubkey);
    if (decision === 'allow') return undefined;
    if (decision === 'block') return blocklistLocalBlockedAt(pubkey);
    return this.dmModMuted().get(pubkey)?.created_at;
  }

  /** Version-cached map of moderator-muted pubkey -> the mute-list event, for DM auto-blocking.
   *  Keyed on versionOf([MuteList, AppData]) + roster identity (the roster gates which mute lists
   *  count), matching the other moderator-selector caches. */
  private _dmMuteCache?: {ver: number; modKey: string; muted: Map<string, Event>};
  private dmModMuted(): Map<string, Event> {
    const mods = this.moderatorNpubs();
    const ver = this.storeVersionOf([Kind.MuteList, Kind.AppData]);
    const modKey = this.moderatorsKeyOf(mods);
    const c = this._dmMuteCache;
    if (ver !== undefined && c && c.ver === ver && c.modKey === modKey) return c.muted;
    const muted = moderatorMutedAuthors(this.deps.store, mods);
    if (ver !== undefined) this._dmMuteCache = {ver, modKey, muted};
    return muted;
  }

  /**
   * Block a DM peer LOCALLY (device-only; nothing published to the relay — an identity-signed mute
   * would deanonymise the mute relationship). Their conversation drops out of the inbox immediately,
   * their kept history stays (hidden, restored on unblock), and DMs arriving after now are deleted on
   * arrival. This is distinct from the moderator "hide user" action ({@link moderatorHideUser}),
   * which is a relay-published community-wide moderation event.
   */
  async blockDmPeer(pubkey: string): Promise<void> {
    await blocklistBlockPeer(pubkey);
    this.rebuildInboxFromCache();
    this.emit(); // user action — reflect immediately
  }

  /** Unblock a DM peer locally by recording an explicit allow (which also overrides a moderator
   *  auto-block). Their kept history reappears in the inbox and future DMs render again. */
  async unblockDmPeer(pubkey: string): Promise<void> {
    await blocklistUnblockPeer(pubkey);
    this.rebuildInboxFromCache();
    this.emit();
  }

  /** Full moderator-action log (newest first) for the searchable Moderation Log screen. */
  getModLog(): ModLogEntry[] {
    return buildModLog(
      this.deps.store,
      this.moderatorNpubs(),
      {postRules: this.postRules, postRulesAt: this.postRulesAt},
      this.administeredSpaceAutoContexts(),
    );
  }

  /**
   * Auto-moderation contexts for the spaces the viewer administers (owner/admin), so their rule
   * violations surface in the mod log. A space admin has mod power inside their own space.
   */
  private administeredSpaceAutoContexts(): SpaceAutoContext[] {
    const me = this.myPubkey;
    if (!me) return [];
    const out: SpaceAutoContext[] = [];
    for (const ch of this.listChannels()) {
      if (ch.owner !== me && !(ch.admins ?? []).includes(me)) continue;
      out.push({messages: channelMessages(this.deps.store, ch.id), cfg: this.spaceAutoCfg(ch.id, 'channel')});
    }
    for (const gid of this.joinedGroups) {
      if (!groupAdminsOf(this.deps.store, gid).includes(me) && !isGroupOwnerOf(this.deps.store, gid, me)) continue;
      out.push({messages: groupChatMessagesOf(this.deps.store, gid), cfg: this.spaceAutoCfg(gid, 'group')});
    }
    return out;
  }

  /**
   * Member reports awaiting moderator review (moderator console). Computed from the cache: member
   * (non-moderator) kind-1984 hide-reports on content no moderator has acted on yet, grouped by
   * target. Visible only where the UI is gated on snapshot.isModerator.
   */
  getPendingReports(): PendingReport[] {
    return pendingReports(
      this.deps.store,
      this.moderatorNpubs(),
      this.reasons,
      Math.floor(Date.now() / 1000),
    );
  }

  /** Currently-banned members (active bans, newest first) for the moderator console. */
  getBannedMembers(): BannedMember[] {
    return bannedMembers(this.deps.store, this.moderatorNpubs(), Math.floor(Date.now() / 1000));
  }

  /**
   * Authors currently under a standing advisory rule (`log-user`) — their posts render in the mod
   * log, not the feed, until a moderator reverses it. Drives the moderator console's "Logged" tab.
   * Matched on the REAL author, so a rule follows a blind author across every throwaway key.
   */
  getLoggedAuthors(): LoggedAuthor[] {
    const overlay = advisoryOverlay(this.deps.store.query({kinds: [Kind.Report]}), pk =>
      isModerator(pk, this.moderatorNpubs()),
    );
    return loggedAuthorsFrom(overlay);
  }

  /**
   * Cached feed-post ids authored by `pubkey` (resolving each blind post's REAL author) — the set a
   * moderator pulls into the log in one `log-batch` when logging an author "with their past posts".
   * Mirrors buildModeratedFeed's post set (posts/articles/polls/voice, excluding hybrid comments).
   */
  getAuthorEventIds(pubkey: string): string[] {
    const ids: string[] = [];
    for (const ev of this.deps.store.query({kinds: [Kind.Post, Kind.Article, Kind.Poll, 1222]})) {
      if (isStiqComment(ev)) continue;
      if (resolveAuthorPubkey(ev) === pubkey) ids.push(ev.id);
    }
    return ids;
  }

  /**
   * Resolve a reference — a hex event id OR a nostr: URI (nevent/note/naddr) — to the cached event.
   * naddr (addressable, e.g. NIP-23 articles) resolves by (kind, author, d-tag).
   */
  private resolveRef(ref: string): import('nostr-tools/pure').Event | null {
    if (/^[0-9a-f]{64}$/i.test(ref)) return this.deps.store.getById(ref) ?? null;
    // A raw addressable coordinate (`kind:pubkey:d`). NostrLinkPreview hands the tap/lookup path a
    // DECODED naddr in exactly this shape (decodeNostrUri), so without this branch an
    // unresolved-naddr card could fetch but never resolve/open.
    const coord = /^(\d+):([0-9a-f]{64}):(.+)$/.exec(ref);
    if (coord) {
      return (
        this.deps.store
          .query({kinds: [Number(coord[1])], authors: [coord[2]!]})
          .find(e => e.tags.some(t => t[0] === 'd' && t[1] === coord[3])) ?? null
      );
    }
    try {
      const decoded = nip19.decode(ref.replace(/^nostr:/, ''));
      if (decoded.type === 'note') return this.deps.store.getById(decoded.data) ?? null;
      if (decoded.type === 'nevent') return this.deps.store.getById(decoded.data.id) ?? null;
      if (decoded.type === 'naddr') {
        const {kind, pubkey, identifier} = decoded.data;
        return (
          this.deps.store
            .query({kinds: [kind], authors: [pubkey]})
            .find(e => e.tags.some(t => t[0] === 'd' && t[1] === identifier)) ?? null
        );
      }
    } catch {
      /* not a bech32/nostr ref */
    }
    return null;
  }

  /**
   * The hex event id an unresolved ref can be id-fetched by — for a bare hex id, a `note`, or a
   * `nevent`. Returns null for `naddr` (addressable), which has no single id and is instead
   * filter-fetched in getEvent via `fetchByFilter`.
   */
  private fetchableId(ref: string): string | null {
    if (/^[0-9a-f]{64}$/i.test(ref)) return ref;
    try {
      const decoded = nip19.decode(ref.replace(/^nostr:/, ''));
      if (decoded.type === 'note') return decoded.data;
      if (decoded.type === 'nevent') return decoded.data.id;
    } catch {
      /* not a bech32/nostr ref */
    }
    return null;
  }

  /** Look up a single event for a quoted-post embed; lazily fetch it from the relay if absent. */
  getEvent(ref: string): import('../ui/NostrLinkPreview').NostrEventSummary | null {
    const raw = this.resolveRef(ref);
    if (!raw) {
      // Not cached yet — ask the relay for it. When it arrives, the store-change re-render
      // resolves this lookup. Both fetch paths de-dupe repeated requests, so it's safe to call
      // on every render of an unresolved embed.
      const id = this.fetchableId(ref);
      if (id) {
        // hex / note / nevent → id-scoped fetch.
        this.deps.fetchEvents?.([id]);
      } else {
        // naddr / raw coordinate (addressable, e.g. NIP-23 article) → filter-scoped fetch.
        this.fetchNaddr(ref);
      }
      return null;
    }
    // A quoted channel/group message must agree with what the open surface renders: the live views
    // fold the author's latest edit in place (channelMessages/groupChatMessages) while this
    // resolver reads the raw store — without the same fold an embed card would show the pre-edit
    // text forever while the destination it opens shows the edit.
    let ev = foldChannelEdit(this.deps.store, raw) ?? foldGroupChatEdit(this.deps.store, raw) ?? raw;
    // Space-sealed content (`['encrypted','nip44']` — private channels/groups): decrypt with the
    // held space key exactly like the open surface would; without a key the body stays HIDDEN.
    // resolveContent below only understands the blind content-epoch scheme and would otherwise
    // pass space-sealed NIP-44 ciphertext through as if it were plaintext (never render ciphertext).
    const embedSpaceId =
      ev.kind === Kind.LiveChat
        ? messageChannelId(ev)
        : ev.kind === GroupKind.Chat || ev.kind === GroupKind.Thread || ev.kind === GroupKind.Reply
          ? eventGroupId(ev)
          : null;
    if (embedSpaceId) {
      const dec = this.decryptSpaceMessages([ev], embedSpaceId);
      if (dec.length === 0) {
        // Sealed and not decryptable here (no key / stripped tags): attribute the card, hide the body.
        const who = this.resolveIdentity(ev);
        return {id: ev.id, pubkey: who.pubkey, content: '', name: who.name, kind: ev.kind, gradient: who.gradient};
      }
      ev = dec[0]!;
    }
    // Attribution goes through the ONE shared resolver (resolveIdentity → displayIdentityFor), NOT
    // the raw `ev.pubkey`: content published blind is signed by a PER-POST THROWAWAY key, so the
    // signer has no phonebook name and seeds a gradient belonging to nobody. The resolver decrypts
    // the carried attestation to the real npub, teaches the phonebook from it, then reads back the
    // arbitrated name — the same chain ThreadView/feed cards already render a comment's author
    // through. Without it an EMBEDDED comment rendered a throwaway npub and a stranger's gradient
    // while the very same comment in the thread rendered the member's name.
    const identity = this.resolveIdentity(ev);
    const titleOf = (e: typeof ev): string | undefined =>
      e.tags.find(t => (t[0] === 'subject' || t[0] === 'title') && t[1])?.[1];
    // The quoted/referenced event itself may be sealed (a post/article/comment riding the blind
    // feedSigner) — resolve before deriving the preview text so a still-locked embed shows '' (the
    // neutral state RefEmbed/ReferencedCard/NostrLinkPreview already render for empty content)
    // rather than raw ciphertext, and kick its epoch's background unlock so the embed self-heals.
    const body = resolveContent(ev);
    if (body.locked) {
      const epoch = contentEpochOf(ev);
      if (epoch !== null) requestEpochUnlock(epoch);
    }
    // A comment embed names the post it lives under ("in <root title>").
    const isComment = ev.kind === Kind.Comment || isStiqComment(ev);
    let rootTitle: string | undefined;
    let rootId: string | undefined;
    if (isComment) {
      rootId = commentRootId(ev) ?? undefined;
      const root = rootId ? this.deps.store.getById(rootId) : null;
      if (root) {
        const rootBody = resolveContent(root);
        if (rootBody.locked) {
          const rootEpoch = contentEpochOf(root);
          if (rootEpoch !== null) requestEpochUnlock(rootEpoch);
        }
        rootTitle = titleOf(root) ?? decodeNameHeader(rootBody.text).text.replace(/\s+/g, ' ').slice(0, 64);
      } else if (rootId) {
        // The embed both names and NAVIGATES to the root ("in <title>", tap → open the thread), and
        // the tap can only land once the root is cached — fetch it exactly like the comment itself
        // was fetched (id-scoped, de-duped + un-blacklisted one layer down in RelayClient).
        this.deps.fetchEvents?.([rootId]);
      }
    }
    return {
      id: ev.id,
      pubkey: identity.pubkey,
      content: decodeNameHeader(body.text).text,
      name: identity.name,
      kind: ev.kind,
      title: titleOf(ev),
      gradient: identity.gradient,
      rootTitle,
      rootId,
    };
  }

  /**
   * Lazily fetch an uncached `naddr` (addressable, e.g. a NIP-23 kind-30023 article) by its
   * `{kind, author, '#d'}` coordinate. De-duped per coordinate so re-rendering an unresolved
   * embed doesn't re-issue the query; the article streams into the store and the next snapshot
   * re-render resolves it.
   *
   * Un-blacklist on failure: `deps.fetchByFilter` is fire-and-forget (no success/failure callback),
   * so `requestedNaddrs` would otherwise dedupe this coordinate FOREVER the instant one attempt
   * fails/times out — the same defect RelayClient.fetchByFilter's own cleanup fixes one layer down,
   * mirrored here since this dedupe is a separate Set above it. Give the relay's own REQ window to
   * resolve it (RelayClient self-closes the underlying fetch at FETCH_TIMEOUT_MS) and drop the key
   * if the coordinate still isn't cached, so the next getEvent() render (or an explicit retry)
   * re-issues the fetch instead of it staying permanently unresolved for the rest of the session.
   */
  private fetchNaddr(ref: string): void {
    let kind: number;
    let pubkey: string;
    let identifier: string;
    // Accept both the bech32 `naddr` form and the raw `kind:pubkey:d` coordinate form —
    // resolveRef resolves both, so both must be fetchable or a coordinate ref never heals.
    const coord = /^(\d+):([0-9a-f]{64}):(.+)$/.exec(ref);
    if (coord) {
      kind = Number(coord[1]);
      pubkey = coord[2]!;
      identifier = coord[3]!;
    } else {
      let decoded;
      try {
        decoded = nip19.decode(ref.replace(/^nostr:/, ''));
      } catch {
        return; // not a bech32/nostr ref
      }
      if (decoded.type !== 'naddr') return;
      ({kind, pubkey, identifier} = decoded.data);
    }
    const key = `${kind}:${pubkey}:${identifier}`;
    if (this.requestedNaddrs.has(key)) return;
    this.requestedNaddrs.add(key);
    this.deps.fetchByFilter?.([{kinds: [kind], authors: [pubkey], '#d': [identifier]}]);
    const timer = setTimeout(() => {
      const resolved = this.deps.store
        .query({kinds: [kind], authors: [pubkey]})
        .some(e => e.tags.some(t => t[0] === 'd' && t[1] === identifier));
      if (!resolved) this.requestedNaddrs.delete(key);
    }, FETCH_TIMEOUT_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
  }

  /** Aggregate reaction score + the viewer's own vote for any event (used by comment likes). */
  getEventScore(id: string): {score: number; myVote: VoteDirection | null} {
    // Serve from the version-cached target→reactions map (one bucketed pass per kind-7 version)
    // instead of a full store scan+filter per call. ThreadView calls this per visible comment on
    // every render, so this turns O(comments × reactions) back into O(reactions) once per version
    // (findings #12/#14). Signature unchanged, so App.tsx's inline closure + LogPostView are untouched.
    const reactions = this.reactionTally().get(id) ?? [];
    const {score} = scoreReactions(reactions);
    const mine = this.myPubkey ? myVoteFor(reactions, this.myPubkey) : null;
    return {score, myVote: mine};
  }

  /** Reaction bucket map (target id → its kind-7 reactions), version-cached on versionOf([Reaction]).
   * Shared by getEventScore (per-comment likes) and getReactionsByTarget (channel tallies). */
  private reactionTally(): Map<string, Event[]> {
    const ver = this.storeVersionOf([Kind.Reaction]);
    const c = this._scoreCache;
    if (ver !== undefined && c && c.ver === ver) return c.byTarget;
    const byTarget = new Map<string, Event[]>();
    // unordered: bucketed into a target→reactions Map below; scoreReactions/myVoteFor pick the
    // latest per voter by created_at COMPARISON, not by array position (P0-3/C1), so this bucket
    // — up to REACTION_RETENTION=8000 — never needs the O(n log n) DESC sort.
    for (const r of this.deps.store.query({kinds: [Kind.Reaction], unordered: true})) {
      const target = reactionTarget(r);
      if (!target) continue;
      const bucket = byTarget.get(target);
      if (bucket) bucket.push(r);
      else byTarget.set(target, [r]);
    }
    if (ver !== undefined) this._scoreCache = {ver, byTarget};
    return byTarget;
  }

  /**
   * Thread of kind-1111 comments under a channel broadcast message. The CHANNEL OWNER is
   * sovereign over their channel and may hide comments within it; those hides are honoured here
   * (scoped to this channel's owner). Community moderators have no authority inside channels.
   */
  getChannelThread(messageId: string): CommentNode[] {
    const visible = this.moderatedThread(messageId).visible;
    const owner = this.channelOwnerForMessage(messageId);
    if (!owner) return visible;
    const hidden = ownerReportedIds(this.deps.store, owner);
    return hidden.size ? partitionThread(visible, ev => hidden.has(ev.id)).visible : visible;
  }

  /** Resolve the owning pubkey of the channel a broadcast message belongs to (else ''). */
  private channelOwnerForMessage(messageId: string): string {
    const msg = this.deps.store.getById(messageId);
    const channelId = msg ? messageChannelId(msg) : null;
    return channelId ? channelOwnerOf(channelId) : '';
  }

  /**
   * Channel-owner action: hide a post or comment within the owner's channel by publishing a
   * kind-1984 report (recorded + reviewable). Honoured only inside that channel.
   */
  async channelOwnerHide(
    targetId: string,
    authorPubkey?: string,
    reasonId?: string,
    note?: string,
  ): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildRemoveReport(targetId, {authorPubkey, reasonId, note, contentSnapshot: this.contentSnapshotFor(targetId)}));
    await this.publishOptimistic(event);
  }

  /** Post a signed (non-anonymous) comment on a channel broadcast message. */
  async postChannelComment(
    messageId: string,
    messagePubkey: string,
    messageKind: number,
    content: string,
  ): Promise<void> {
    if (!this.identity) return;
    const root: EventRef = {id: messageId, pubkey: messagePubkey, kind: messageKind};
    const unsigned = buildChannelComment(this.withMyName(content), root, root);
    const event = await this.identity.sign(unsigned);
    await this.publishOptimistic(event);
    this.accountPictures(content);
  }

  /**
   * The moderation authority for a space — owner + admins. Restore authority for space
   * auto-moderation and the allowed signer set for the space's settings doc. Channels carry admins
   * as owner-signed `['p', pk, 'admin']` tags on the 30311; groups use the relay's 39001 + 39000 owner.
   */
  private spaceAdmins(spaceId: string, kind: 'channel' | 'group'): Set<string> {
    if (kind === 'channel') {
      const ch = getChannel(this.deps.store, spaceId);
      return ch ? new Set<string>([ch.owner, ...(ch.admins ?? [])]) : new Set<string>();
    }
    const admins = new Set<string>(groupAdminsOf(this.deps.store, spaceId));
    const owner = groupStateOf(this.deps.store, spaceId)?.owner;
    if (owner) admins.add(owner);
    return admins;
  }

  /** Resolve a space's client-side auto-moderation config (rule set + retro cutoff + admin set). */
  private spaceAutoCfg(spaceId: string, kind: 'channel' | 'group'): SpaceAutoModConfig {
    const admins = this.spaceAdmins(spaceId, kind);
    const found = readSpaceSettingsDoc(this.deps.store, spaceId, admins);
    return {
      rules: found ? found.settings.rules : DEFAULT_SPACE_RULE_SET,
      rulesAt: found ? found.at : 0,
      spaceAdmins: admins,
    };
  }

  /** The current settings doc for a space (rules + reactions/pinned), or null if none published. */
  getSpaceSettings(spaceId: string, kind: 'channel' | 'group'): {settings: SpaceSettings; at: number} | null {
    return readSpaceSettingsDoc(this.deps.store, spaceId, this.spaceAdmins(spaceId, kind));
  }

  /** Publish a space's settings doc (admin/owner only — signed by the caller's identity). */
  async setSpaceSettings(spaceId: string, settings: SpaceSettings): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildSpaceSettings(spaceId, settings));
    await this.publishOptimistic(event);
  }

  /**
   * The current log offer for a group — the owner-consent gate that lets a PRIVATE group be listed
   * in the organizer dashboard's community log picker (GET /api/discover; see channels/logOffer.ts).
   * Reads are keyed to the group's OWNER pubkey from cached relay state, so an impostor's doc can
   * never be mistaken for the real offer. Returns null when the owner is unknown, no offer was ever
   * published, or the latest doc is a revoke.
   */
  getLogOffer(groupId: string): LogOffer | null {
    const owner = groupStateOf(this.deps.store, groupId)?.owner;
    if (!owner) return null;
    return currentLogOffer(this.deps.store, groupId, owner);
  }

  /**
   * Owner action: publish a LIVE log offer for a group, built from its CURRENT name/gradient/
   * private/closed/broadcast state — opts it into the community log picker. Owner-signed happens
   * naturally (the caller's identity signs); the UI gates this action on isOwner.
   */
  async setLogOffer(groupId: string): Promise<void> {
    if (!this.identity) return;
    const st = groupStateOf(this.deps.store, groupId);
    if (!st) return;
    const event = await this.identity.sign(buildLogOffer({
      gid: groupId,
      name: st.name,
      gradient: encodeGradient(st.gradient),
      private: !!st.private,
      closed: !!st.closed,
      broadcast: !!st.broadcast,
    }));
    await this.publishOptimistic(event);
  }

  /**
   * Owner action: revoke a group's log offer — republishes the SAME addressable `d` as a tombstone,
   * which (NIP-33 latest-wins) supersedes any earlier live offer and delists the space.
   */
  async revokeLogOffer(groupId: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildLogOfferRevoke(groupId));
    await this.publishOptimistic(event);
  }

  getChannelMessages(channelId: string): Event[] {
    // Version-cache the fully-derived (folded + auto-moderated) list on the kinds it reads: channel
    // broadcasts (1311), space settings (30078), and restore/owner reports (1984). ChannelList calls
    // this per channel per render, so an unchanged store now returns the cached array (finding #13).
    // Channels are plaintext today; the encrypted branch below runs only if the guard trips, and the
    // decrypt is version-keyed too since a new encrypted message bumps the 1311 version.
    const ver = this.storeVersionOf(AppRuntime.CHANNEL_VIEW_KINDS);
    const cached = ver !== undefined ? this._channelMsgCache.get(channelId) : undefined;
    if (cached && cached.ver === ver) return cached.msgs;
    let msgs = channelMessages(this.deps.store, channelId);
    // NIP-53 channels are public today (no `private` flag), so messages are plaintext. Defensive
    // E2E guard: if any channel message ever carries the encrypted marker, decrypt it with this
    // space's cached key (none today), and HIDE anything we can't decrypt — never render ciphertext.
    if (msgs.some(m => channelMessageEpoch(m) !== null)) {
      msgs = this.decryptSpaceMessages(msgs, channelId);
    }
    // Client-side space auto-moderation (admin rules → auto-remove) + the channel owner's own hides.
    const auto = spaceAutoHidden(this.deps.store, msgs, this.spaceAutoCfg(channelId, 'channel'));
    const owner = channelOwnerOf(channelId);
    const hidden = owner ? ownerReportedIds(this.deps.store, owner) : new Set<string>();
    const result = !auto.size && !hidden.size ? msgs : msgs.filter(m => !auto.has(m.id) && !hidden.has(m.id));
    if (ver !== undefined) this._channelMsgCache.set(channelId, {ver, msgs: result});
    return result;
  }

  /**
   * All kind-7 reactions in the store, bucketed by the message id they target. One pass — the
   * channel view tallies per message against the channel's configured emoji set (cheaper than a
   * per-message store scan). Mirrors the feed's reaction bucketing.
   */
  getReactionsByTarget(): Map<string, Event[]> {
    return this.reactionTally();
  }

  /**
   * This author's NIP-22 kind-1111 comments + hybrid kind-1 stiq-comment notes ("ideas"), resolved
   * for the profile's Ideas tab AND (via `.length`) the IDEAS stat. Attribution goes through the SAME
   * blind path the feed uses (resolveAuthorPubkey) — a raw `{authors: [pubkey]}` query never matches
   * a blind-posted comment (per-post throwaway signer). Not moderation-filtered, mirroring
   * buildProfile's pre-#8 behaviour (a hidden comment still counts as an "idea" its author wrote);
   * author's-note pins ARE excluded (they aren't comments the user wrote as ideas). Each idea's root
   * post is resolved to a visible feed item so a tap opens that thread; roots absent from the visible
   * feed leave `rootPost` undefined (the row is shown but not tappable).
   */
  private ideasFor(pubkey: string, feedItems: readonly FeedItem[]): ProfileIdea[] {
    // unordered: we sort by created_at at the end, so scan order is irrelevant.
    const own: Event[] = [];
    for (const c of this.deps.store.query({kinds: [Kind.Comment], unordered: true})) {
      if (!isPinnedComment(c) && resolveAuthorPubkey(c) === pubkey) own.push(c);
    }
    for (const p of this.deps.store.query({kinds: [Kind.Post], unordered: true})) {
      if (isStiqComment(p) && resolveAuthorPubkey(p) === pubkey) own.push(p);
    }
    if (own.length === 0) return [];
    // Resolve only the roots we actually need, scanning the feed once (skipped when nobody's comment
    // has a resolvable root) rather than building a Map of the whole feed on every getProfile miss.
    const rootIds = new Set<string>();
    for (const c of own) {
      const r = commentRootId(c);
      if (r) rootIds.add(r);
    }
    const rootById = new Map<string, FeedItem>();
    if (rootIds.size > 0) {
      for (const it of feedItems) if (rootIds.has(it.id)) rootById.set(it.id, it);
    }
    const ideas = own.map((c): ProfileIdea => {
      const body = resolveContent(c);
      const rootId = commentRootId(c);
      const rootPost = rootId ? rootById.get(rootId) : undefined;
      const rootTitle = rootPost
        ? rootPost.title ?? (decodeNameHeader(rootPost.content).text.replace(/\s+/g, ' ').slice(0, 64) || undefined)
        : undefined;
      return {
        id: c.id,
        content: body.locked ? '' : decodeNameHeader(body.text).text,
        createdAt: c.created_at,
        ...(rootPost ? {rootPost} : {}),
        ...(rootTitle ? {rootTitle} : {}),
      };
    });
    ideas.sort((a, b) => b.createdAt - a.createdAt);
    return ideas;
  }

  /**
   * Build (or reuse a cached) Profile for `pubkey`: metadata + owned channels (buildProfile) overlaid
   * with the locally-known name/gradient, plus posts + ideaCount resolved through the SAME
   * blind-attribution-aware, moderation-filtered path every other view renders through (visibleFeed) —
   * never a raw `{authors:[pubkey]}` store query, since a blind post's real author lives in its
   * encrypted attribution, not `event.pubkey`.
   *
   * MEMOIZED per pubkey (adversarial-review fix): getProfile is invoked from render hot paths —
   * InboxList's getPeerName/getPeerGradient per DM row, ThreadView/LogPostView/comment attribution per
   * comment node, channel-list rows, ConversationView's peer gradient — once per row per render, all
   * funneling through the single `onGetProfile` prop (App.tsx → this method). Unmemoized, EVERY call
   * re-ran the full `.items.filter(authorPubkey===pubkey)` pass over the whole visible feed AND
   * `ideaCountFor`'s two full un-indexed kind-bucket scans (all kind-1 + all kind-1111, `resolveAuthorPubkey`
   * per event) — so a single identity bump re-rendering those lists cost O(rows × community-size) per
   * frame. The memo is keyed on the exact composite `_cachedBuildFeed` uses to decide whether
   * visibleFeed's returned posts could have changed (feedVer/moderatorsKey/myPubkey/autoKey/
   * identityVersion — see `autoModKeyFor`) plus `_mutedVersion` (visibleFeed's own extra invalidation
   * layer) and PROFILE_KINDS (adds Metadata/LiveActivity, which FEED_KINDS omits but buildProfile
   * reads). A hit costs one Map lookup; a miss recomputes exactly what the unmemoized code did.
   *
   * Hot callers only ever need name+gradient (never posts/ideaCount) — see getIdentity() for a
   * lighter-weight lookup. It is not yet wired to those call sites: they route through this single
   * `onGetProfile` prop today, and this memo alone already removes the per-row store-scan cost;
   * migrating them to a dedicated `onGetIdentity` prop is a follow-up (those call sites live in
   * MainScreen.tsx/CommentItem.tsx/ConversationView.tsx, outside this file's ownership this wave).
   */
  getProfile(pubkey: string): Profile {
    const moderators = this.moderatorNpubs();
    const moderatorsKey = this.moderatorsKeyOf(moderators);
    const {autoKey} = this.autoModKeyFor(moderators);
    const feedVer = this.storeVersionOf(AppRuntime.PROFILE_KINDS);
    const identityVersion = this._identityVersion;
    const mutedVer = this._mutedVersion;
    const myPubkey = this.myPubkey;

    if (feedVer !== undefined) {
      const cached = this._profileCache.get(pubkey);
      if (
        cached &&
        cached.feedVer === feedVer &&
        cached.moderatorsKey === moderatorsKey &&
        cached.myPubkey === myPubkey &&
        cached.autoKey === autoKey &&
        cached.identityVersion === identityVersion &&
        cached.mutedVer === mutedVer
      ) {
        return cached.profile;
      }
    }

    const profile = buildProfile(this.deps.store, pubkey);
    // Overlay the locally-known display name (own name for self, learned name for others).
    // Never sourced from the relay.
    const localName = pubkey === myPubkey ? this.displayNames.getMyName() : this.displayNames.nameFor(pubkey);
    const gradient = this.gradientFor(pubkey);
    // Self only: has our own name definitively lost the longest-held-wins arbitration? getMyName
    // (above) renders our name to US unconditionally, so without this the ONE person affected is
    // the only one who can't see it. Everyone else needs no such flag — nameFor() already withholds
    // a name its holder doesn't own, so a losing claimant simply renders as a bare npub. Recomputed
    // whenever `identityVersion` bumps (learnNameFromContent / setMyDisplayName), which is exactly
    // when the phonebook could have changed the answer — so the memo key above already covers it.
    const nameConflict = pubkey === myPubkey ? this.displayNames.nameConflict(pubkey) : undefined;
    // Posts + idea count (#8): resolved from the feed, not buildProfile's raw store query — a blind
    // post's real author lives in its encrypted attribution, not event.pubkey. Reuses the SAME
    // moderation path every other view renders through (visibleFeed), not a second, subtly
    // different filter; a hidden post stays hidden here too, even to its own author (today's
    // single-visibility model).
    const visibleItems = this.visibleFeed(moderators, this.cachedOverlay(moderators)).items;
    const posts = visibleItems.filter(i => i.authorPubkey === pubkey);
    // Ideas (this author's comments) resolved into a displayable list; the IDEAS stat is its length.
    const ideas = this.ideasFor(pubkey, visibleItems);
    const ideaCount = ideas.length;
    const overlaid = {...profile, posts, ideas, ideaCount, ...(localName ? {name: localName} : {})};
    const withGradient = gradient ? {...overlaid, gradient} : overlaid;
    const result = nameConflict ? {...withGradient, nameConflict} : withGradient;

    if (feedVer !== undefined) {
      this._profileCache.set(pubkey, {feedVer, moderatorsKey, myPubkey, autoKey, identityVersion, mutedVer, profile: result});
    }
    return result;
  }

  /**
   * Lightweight identity-only lookup (name + gradient + npub) for render-hot callers that never need
   * Profile's posts/ideaCount — introduced alongside getProfile's memo (see its doc comment) as the
   * cheaper alternative those call sites should migrate to; it skips buildProfile + visibleFeed +
   * ideaCountFor entirely, not just memoizes them. Keyed only on `_identityVersion` + myPubkey: every
   * name/gradient change (self-edit, cross-device adoption, or a peer's learned identity) bumps
   * `_identityVersion` (learnNameFromContent/setMyDisplayName/setMyGradient), so unlike getProfile's
   * memo this needs no feed/moderation dependency at all.
   */
  getIdentity(pubkey: string): {pubkey: string; npub: string; name?: string; gradient?: GradientSpec} {
    const identityVersion = this._identityVersion;
    const myPubkey = this.myPubkey;
    const cached = this._identityCache.get(pubkey);
    if (cached && cached.identityVersion === identityVersion && cached.myPubkey === myPubkey) {
      return cached.identity;
    }
    const name = pubkey === myPubkey ? this.displayNames.getMyName() : this.displayNames.nameFor(pubkey);
    const gradient = this.gradientFor(pubkey);
    const identity = {pubkey, npub: nip19.npubEncode(pubkey), ...(name ? {name} : {}), ...(gradient ? {gradient} : {})};
    this._identityCache.set(pubkey, {identityVersion, myPubkey, identity});
    return identity;
  }

  /**
   * The shared attribution resolver (see resolveDisplayIdentity.ts) bound to this runtime's
   * phonebook + gradient store + viewer identity — the ONE path every render surface (feed items,
   * the post-detail header, comments, LogPostView) should resolve "who authored this EVENT" through.
   * Unlike {@link getIdentity}/{@link getProfile} (pubkey-only phonebook lookups), this takes the
   * actual event and re-teaches the phonebook from ITS carried attestation before reading it back —
   * so it is correct even for an event no buildFeed pass has ever iterated (a deep-linked post, one
   * evicted from the feed cache, …), which is exactly the gap that let a post render "anonymous"
   * while a comment by the same member, resolved via `resolveAuthor` directly, rendered their name.
   */
  resolveIdentity(event: {id: string; pubkey: string; tags: string[][]; created_at: number}): DisplayIdentity {
    return displayIdentityFor(event, {names: this.displayNames, grads: this.gradients, myPubkey: this.myPubkey});
  }

  /**
   * {@link resolveIdentity}, looked up by event id straight from the store — for callers (the
   * post-detail header) that hold only an id/FeedItem, not the raw event. Null when the event isn't
   * cached (never synced, or evicted).
   */
  resolveIdentityById(id: string): DisplayIdentity | null {
    const ev = this.deps.store.getById(id);
    return ev ? this.resolveIdentity(ev) : null;
  }

  /** The viewer's own (editable, relay-blind) display name. */
  getMyDisplayName(): string {
    return this.displayNames.getMyName();
  }

  /**
   * Set the viewer's display name. Never published as plaintext kind-0 metadata; instead it is
   * announced relay-blind via the identity beacon + encrypted-profile carriers (announceIdentity).
   */
  async setMyDisplayName(name: string): Promise<void> {
    await this.displayNames.setMyName(name);
    this._identityVersion++; // no feed-kind store event → force the feed cache to rebuild with the new name
    this.emit();
    await this.announceIdentity();
  }

  /** Wrap outgoing authored content with the viewer's identity headers (display name + gradient). */
  private withMyName(content: string): string {
    return encodeIdentityHeader(content, this.displayNames.getMyName(), this.gradients.myWire());
  }

  /**
   * Add any inline-picture bytes in a freshly-composed body to the member's per-period allowance
   * spend (client-side; the blind relay can't attribute picture bytes to a member — see
   * pictureAllowance.ts). Called once per user-initiated publish, not from publishOptimistic
   * (which also runs on outbox retries and would double-count).
   */
  private accountPictures(body: string): void {
    const bytes = extractInlinePictures(body).reduce((n, p) => n + p.weightBytes, 0);
    if (bytes > 0) void this.pictureAllowance.add(bytes);
  }

  /** Learn an author's embedded display name + gradient from any plaintext authored content. */
  private learnNameFrom(event: Event): void {
    // Gift wraps are encrypted (DM identity is learned post-decrypt); only these plaintext
    // authored kinds carry the SOH identity headers.
    if (
      event.kind !== Kind.Post &&
      event.kind !== Kind.Article &&
      event.kind !== Kind.Comment &&
      event.kind !== Kind.LiveChat &&
      event.kind !== GroupKind.Chat
    ) {
      return;
    }
    // FIX 4 (generalized — F-attribution guard, item 4): ANY event carrying an explicit
    // ['encrypted','nip44'] marker has CIPHERTEXT in `content` under a scheme `resolveContent` below
    // does NOT understand — UNLESS it's a recognized blind content-epoch seal (`isSealedContent`,
    // gated on also being a blind/token post), which the resolveContent+body.locked check just below
    // already handles correctly (locked while the epoch key is missing, decrypted once it lands).
    // A private-group kind-9's header, for instance, is encrypted under the SPACE key — a completely
    // different mechanism `isSealedContent` doesn't recognize (no token ⇒ not a blind post), so
    // `resolveContent` would otherwise (wrongly) treat its ciphertext as already-plaintext content.
    // Skip those here regardless of kind — not just GroupKind.Chat, in case another carrier ever
    // reuses the same tag convention — poisoning displayNames with garbage; the name is learned
    // post-decrypt in decryptSpaceMessages → learnNameFromContent instead.
    if (event.tags.some(t => t[0] === 'encrypted' && t[1] === 'nip44') && !isSealedContent(event)) {
      return;
    }
    // A post/article/comment can likewise be SEALED under a content epoch key (the blind
    // feedSigner's content-encryption meter) — same risk as FIX 4 above, a different mechanism.
    // Resolve first; a still-locked body has no plaintext header to learn yet — never poison
    // displayNames with a header parsed out of ciphertext. Not a stuck state: the moment this
    // epoch's key lands, learnFromUnlockedEpoch (unlockContentEpoch) sweeps every post already
    // sealed under it, so this isn't left waiting on a re-ingest that never happens.
    const body = resolveContent(event);
    if (body.locked) return;
    // F-attribution fix (item 3): a BLIND post's plaintext SOH header (withMyName rides on every
    // outgoing body, blind or not) is keyed on the real author, never the throwaway signer that
    // `event.pubkey` is for a blind post — resolveAuthorPubkey decrypts the attestation the same way
    // toFeedItem/prepareFeedItems do, so the phonebook always learns under the pubkey the community
    // actually attributes the post to.
    this.learnNameFromContent(resolveAuthorPubkey(event), body.text, event.created_at);
  }

  /**
   * Learn an author's display name + gradient from already-PLAINTEXT content (shared by the
   * plaintext path, the post-decrypt private-space path, and the peer identity-beacon handler).
   *
   * Bumps `_identityVersion` when either value actually changes what renders for `pubkey` — a
   * channel/group message or an identity beacon is NOT a feed-kind event (see FEED_STORE_READ_KINDS),
   * so feedVer alone would miss it and a peer's newly-learned name/gradient would never re-render
   * their existing feed posts. Compared before/after (rather than trusting the store's own change
   * report) so a repeat sighting of an already-known identity — the common case, since every post a
   * known member authors re-embeds their current header — never forces a needless feed rebuild.
   */
  private learnNameFromContent(pubkey: string, content: string, createdAt: number): void {
    const {name} = decodeNameHeader(content);
    const wire = decodeGradientHeader(content);
    const prevName = name ? this.displayNames.nameFor(pubkey) : undefined;
    const prevGrad = wire ? this.gradients.gradientFor(pubkey) : undefined;
    if (name) void this.displayNames.learn(pubkey, name, createdAt);
    if (wire) void this.gradients.learn(pubkey, wire, createdAt);
    if (
      (name && this.displayNames.nameFor(pubkey) !== prevName) ||
      (wire && !gradientSpecEqual(this.gradients.gradientFor(pubkey), prevGrad))
    ) {
      this._identityVersion++;
    }
  }

  /**
   * F-attribution fix (item 3b): sweep every FEED_KINDS event sealed under `epoch` and teach the
   * phonebook from its now-decryptable plaintext SOH header, the moment that epoch's key lands
   * (called from unlockContentEpoch, right after setContentEpochKey). Mirrors decryptSpaceMessages'
   * post-decrypt learn pattern for private-group chat: a sealed post's ciphertext was ALWAYS skipped
   * by learnNameFrom (never poison displayNames with a header parsed out of ciphertext), so without
   * this sweep a member whose only synced content was sealed at ingest time would never teach the
   * phonebook anything until some unrelated re-render happened to touch their post again — no
   * re-ingest ever re-fires (onEvent fires once per event id; the store dedupes by id).
   *
   * A blind + sealed post's plaintext header is keyed on the REAL author, never the throwaway
   * signer `event.pubkey` is for a blind post — resolveAuthorPubkey decrypts the attestation the
   * same way toFeedItem/prepareFeedItems/learnNameFrom do.
   */
  private learnFromUnlockedEpoch(epoch: number): void {
    for (const ev of this.deps.store.query({kinds: FEED_KINDS, unordered: true})) {
      if (contentEpochOf(ev) !== epoch) continue; // unsealed, or sealed under a different epoch
      const body = resolveContent(ev);
      if (body.locked) continue; // malformed `ke` / still-locked for some other reason — nothing to learn
      this.learnNameFromContent(resolveAuthorPubkey(ev), body.text, ev.created_at);
    }
  }

  /** The viewer's own gradient (null → render the seed-derived default). */
  getMyGradient(): GradientSpec | null {
    return this.gradients.getMyGradient();
  }

  /**
   * Set or change the viewer's identity gradient. Rides the viewer's next authored content AND is
   * announced immediately (relay-blind) via the identity beacon + encrypted-profile (announceIdentity),
   * so peers and the viewer's own other devices pick it up without waiting for a post.
   */
  async setMyGradient(spec: GradientSpec): Promise<void> {
    await this.gradients.setMyGradient(spec);
    this._identityVersion++; // no feed-kind store event → force the feed cache to rebuild with the new gradient
    this.emit();
    await this.announceIdentity();
  }

  /**
   * Publish the viewer's current identity (name + gradient) via two relay-blind carriers, so it
   * propagates WITHOUT waiting for the viewer to author a post:
   *   • identity beacon (kind-30078 d="identity") — SOH header the relay never interprets; peers
   *     learn the new name/gradient off the firehose (same learn path as posts).
   *   • encrypted profile (kind-30078 d="identity-enc") — NIP-44 self-ciphertext; the relay stores
   *     only ciphertext and the viewer's OTHER devices decrypt + converge on it.
   * Both are addressable (one per author, latest replaces). Best-effort: a locked key or offline
   * relay just means publishOptimistic queues to the outbox and retries on reconnect.
   */
  private async announceIdentity(): Promise<void> {
    if (!this.identity || !this.enrolled) {
      // Edited before enrollment finished (or without a signer): remember that an announce is
      // owed so the next unlock retries it — otherwise the change stays local-only until the
      // NEXT identity edit, with nothing on the wire in between.
      this._identityAnnouncePending = true;
      return;
    }
    const name = this.displayNames.getMyName();
    const wire = this.gradients.myWire();
    if (!hasIdentityToPublish(name, wire)) return;
    this._identityAnnouncePending = false;
    // Strictly-monotonic timestamp so each announce replaces the last and cross-device adoption
    // always sees a newer created_at (guards against two edits in the same wall-clock second).
    const at = Math.max(Math.floor(Date.now() / 1000), this._myIdentityAt + 1);
    await this.setMyIdentityAt(at);
    const beacon = buildIdentityBeacon(name, wire, at);
    if (beacon) {
      try {
        await this.publishOptimistic(await this.identity.sign(beacon));
      } catch {
        // signing failed (e.g. key locked) — retried on the next unlock via the pending flag;
        // the header also still rides the next real post
        this._identityAnnouncePending = true;
      }
    }
    try {
      const profile = await this.identity.buildEncryptedProfile(encodeProfilePayload(name, wire), at);
      await this.publishOptimistic(profile);
    } catch {
      // key locked / offline — retried on the next unlock via the pending flag
      this._identityAnnouncePending = true;
    }
  }

  /**
   * Adopt one of OUR OWN encrypted-profile events (from another device) into local identity, but
   * only when strictly newer than what we hold — so a stale copy can't clobber a fresher local
   * edit. Adopts via the STORES directly (never announceIdentity), so this can't loop between
   * devices. No-op when locked/undecryptable (retried when the event is re-ingested).
   */
  private async adoptEncryptedProfile(event: Event): Promise<void> {
    if (!this.identity || event.created_at <= this._myIdentityAt) return;
    let plaintext: string;
    try {
      plaintext = await this.identity.decryptSelfProfile(event.content);
    } catch {
      return; // locked or not decryptable — skip
    }
    const {n, g} = decodeProfilePayload(plaintext);
    let changed = false;
    if (typeof n === 'string' && n !== this.displayNames.getMyName()) {
      await this.displayNames.setMyName(n);
      changed = true;
    }
    if (typeof g === 'string') {
      const spec = decodeGradient(g);
      if (spec) {
        await this.gradients.setMyGradient(spec);
        changed = true;
      }
    }
    await this.setMyIdentityAt(event.created_at);
    if (changed) {
      this._identityVersion++;
      this.emit();
    }
  }

  /** Load the persisted created_at of our newest committed identity (0 when never set/absent). */
  private parseIdentityAt(raw: string | null | undefined): number {
    // Parse-only (no I/O): normalize the persisted identityAt into a positive finite created_at, else
    // 0. Byte-for-byte the old loadIdentityAt's normalize; fed by hydratePerSlotSecureReads.
    try {
      const n = raw ? Number(raw) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Record (in memory + persisted) the created_at of our newest committed identity. */
  private async setMyIdentityAt(at: number): Promise<void> {
    this._myIdentityAt = at;
    try {
      await this.deps.secureStorage?.setItem(this.identityAtItem(), String(at));
    } catch {
      // best-effort — the in-memory value still guards this session
    }
  }

  /** The crafted gradient known for `pubkey`, or undefined (renderer falls back to the seed). */
  gradientFor(pubkey: string): GradientSpec | undefined {
    return pubkey === this.myPubkey
      ? this.gradients.getMyGradient() ?? undefined
      : this.gradients.gradientFor(pubkey);
  }

  /**
   * The narrow choke point every author's-note render (MainScreen's "current note" panel and its
   * prior-edits history dialog) reads through — an author's-note pin is an ordinary comment and can
   * therefore itself be sealed under a content epoch (like any other blind post). Resolve every
   * returned version's content here so neither caller ever touches ciphertext; a still-locked
   * version renders '' (MainScreen already guards empty note text with `?.trim()`) and its epoch
   * gets a background unlock kick so the note self-heals, mirroring feed.ts's toFeedItem.
   */
  getPinnedHistory(postId: string, postAuthor: string): PinnedCommentHistory {
    const raw = loadPinnedHistory(this.deps.store, postId, postAuthor);
    const resolved = (ev: Event): Event => {
      if (!isSealedContent(ev)) return ev;
      const body = resolveContent(ev);
      if (body.locked) {
        const epoch = contentEpochOf(ev);
        if (epoch !== null) requestEpochUnlock(epoch);
      }
      return {...ev, content: body.text};
    };
    return {
      latest: raw.latest ? resolved(raw.latest) : null,
      history: raw.history.map(resolved),
    };
  }

  private listChannels(): Channel[] {
    // Fast path: return the cached result if the LiveActivity bucket hasn't changed.
    // Mirror the versionOf runtime-narrowing pattern from channels/groups.ts:327+.
    if ('versionOf' in this.deps.store && typeof (this.deps.store as {versionOf: unknown}).versionOf === 'function') {
      const storeV = this.deps.store as {versionOf: (kinds: number[]) => number};
      const ver = storeV.versionOf([Kind.LiveActivity, Kind.Delete]);
      if (this._channelsCache !== undefined && this._channelsCache.version === ver) {
        return this._channelsCache.channels;
      }
      const channels = this._buildChannels();
      this._channelsCache = {version: ver, channels};
      return channels;
    }
    // Fallback: versionOf unavailable — always recompute (original behaviour).
    return this._buildChannels();
  }

  private _buildChannels(): Channel[] {
    // Owner-issued NIP-09 deletions (kind 5) retract a channel by its `a` coordinate. A deletion
    // only counts if signed by the coordinate's owner (`30311:<owner>:<d>`), so nobody can delete
    // someone else's channel.
    const deleted = new Set<string>();
    for (const ev of this.deps.store.query({kinds: [Kind.Delete]})) {
      for (const tag of ev.tags) {
        if (tag[0] === 'a' && tag[1] && tag[1].split(':')[1] === ev.pubkey) deleted.add(tag[1]);
      }
    }
    // NIP-53 channels are addressable (kind 30311): keep only the latest event per
    // coordinate, so re-published metadata edits replace the prior definition.
    const latestByCoord = new Map<string, {ev: Event; ch: Channel}>();
    for (const ev of this.deps.store.query({kinds: [Kind.LiveActivity]})) {
      const ch = parseChannel(ev);
      if (!ch || deleted.has(ch.id)) continue;
      const prev = latestByCoord.get(ch.id);
      if (!prev || ev.created_at > prev.ev.created_at) latestByCoord.set(ch.id, {ev, ch});
    }
    return [...latestByCoord.values()].map(v => v.ch);
  }

  /**
   * Channels the user is subscribed to (NIP-51 kind-10009), unioned with channels they own
   * (an owner is implicitly subscribed to their own channel).
   */
  private subscribedChannelSet(channels: Channel[] = this.listChannels()): string[] {
    // Keyed on the subscription-list bucket (10009) AND the channel-list bucket (30311/5, since a
    // channel WE own is implicitly subscribed) + myPubkey. Returns the SAME array reference while
    // unchanged (finding #11) — and drops the redundant second sort the audit found (there is none
    // to add here; the Set already dedupes without sorting).
    const ver = this.storeVersionOf([Kind.ChannelSubscriptions]);
    const chVer = this.storeVersionOf([Kind.LiveActivity, Kind.Delete]) ?? 0;
    const c = this._subsCache;
    if (ver !== undefined && c && c.ver === ver && c.chVer === chVer && c.myPubkey === this.myPubkey) {
      return c.ids;
    }
    const subscribed = new Set(subscribedChannelIds(this.deps.store, this.myPubkey));
    if (this.myPubkey) {
      for (const ch of channels) {
        if (ch.owner === this.myPubkey) subscribed.add(ch.id);
      }
    }
    const ids = [...subscribed];
    if (ver !== undefined) this._subsCache = {ver, chVer, myPubkey: this.myPubkey, ids};
    return ids;
  }

  /** Whether the user is subscribed to (or owns) a channel. */
  isSubscribed(channelId: string): boolean {
    return this.subscribedChannelSet().includes(channelId);
  }

  /**
   * Subscribe to a channel: republish the NIP-51 list with the channel added.
   *
   * Also opens the channel's scoped kind-1311 subscription right away (SCOPED_CHANNEL_SYNC; a no-op
   * with the flag off). The plan's standing `channels` sub is only rebuilt on the next relay
   * (re)connect, so without this a member who follows a channel would see nothing new in it until
   * they reconnected. Same reasoning as trackGroup's immediate subscribeGroup for NIP-29.
   */
  async subscribeChannel(channelId: string): Promise<void> {
    if (!this.identity) return;
    const current = new Set(subscribedChannelIds(this.deps.store, this.myPubkey));
    if (current.has(channelId)) return;
    current.add(channelId);
    // Stamp the join moment so the row sorts to the top of Spaces immediately, before its 1311
    // history streams in over Tor.
    markJoined(channelId, AppRuntime.nowSec());
    this.deps.subscribeChannelChat?.(channelId);
    const event = await this.identity.sign(buildSubscriptionList([...current]));
    await this.publishOptimistic(event);
  }

  /** Unsubscribe from a channel: republish the NIP-51 list without it. */
  async unsubscribeChannel(channelId: string): Promise<void> {
    if (!this.identity) return;
    const current = new Set(subscribedChannelIds(this.deps.store, this.myPubkey));
    if (!current.has(channelId)) return;
    current.delete(channelId);
    const event = await this.identity.sign(buildSubscriptionList([...current]));
    await this.publishOptimistic(event);
  }

  /** Toggle a NIP-51 bookmark on a post (kind-10003). Republishes the updated list. */
  async toggleBookmark(postId: string): Promise<void> {
    if (!this.identity) return;
    const current = new Set(bookmarkedPostIds(this.deps.store, this.myPubkey));
    if (current.has(postId)) {
      current.delete(postId);
    } else {
      current.add(postId);
    }
    const event = await this.identity.sign(buildBookmarkList([...current]));
    await this.publishOptimistic(event);
  }

  /** Whether the user has bookmarked a post. */
  isBookmarked(postId: string): boolean {
    return bookmarkedPostIds(this.deps.store, this.myPubkey).includes(postId);
  }

  /** Submit a NIP-56 user report (kind-1984) to the relay for organizer review. */
  async reportPost(postId: string, authorPubkey: string, reasonId = 'other', note?: string): Promise<void> {
    if (!this.identity) return;
    // `reasonId` is an organizer reason-bucket id (RemovalSheet picks from snapshot.reasons), so a
    // member report aggregates under the same buckets the moderator queue + mod log resolve. The
    // content snapshot keeps the reported body searchable in the mod log even if it leaves cache —
    // contentSnapshotFor omits it entirely for a still-sealed target (never publish ciphertext).
    const unsigned = buildRemoveReport(postId, {authorPubkey, reasonId, note, contentSnapshot: this.contentSnapshotFor(postId)});
    const event = await this.identity.sign(unsigned);
    await this.deliver(event);
  }

  /**
   * Create a channel owned by this account (§3.7), publish it optimistically, and return its
   * addressable coordinate so the caller can navigate straight into the just-created channel (it's
   * already in the store via publishOptimistic, so its view renders immediately).
   */
  async createChannel(meta: ChannelMetadata): Promise<string | null> {
    if (!this.identity) {
      return null;
    }
    const event = await signChannelCreate(this.identity, meta);
    await this.publishOptimistic(event);
    const d = event.tags.find(t => t[0] === 'd')?.[1];
    return d ? channelCoord(event.pubkey, d) : null;
  }

  /**
   * Broadcast a message into a channel you own. ALWAYS durable (T0.2): rendered as an optimistic
   * placeholder BEFORE the sign, then queued on the shared 'channel' PendingWrite pipeline — see
   * {@link PendingChannelWrite}'s doc for why a bound-npub broadcast still needs this (its own
   * signature can spend a space-write token once the relay requires one, and its media independently
   * mints blind blobs off the post wallet). Both are draws that can take seconds over Tor and can
   * throw BlindTokensExhausted, so the placeholder is what keeps the message from simply being absent
   * from the channel for that whole window — the draft is already cleared by then (ChannelView.sendText
   * clears it synchronously, without awaiting this promise).
   *
   * A plain broadcast on a relay that enforces nothing and mints no media is the mechanical no-op case
   * (mintMediaBlobs / spaceTokenTagsFor both no-op, publishOptimistic(event, []) unchanged) — so this
   * costs nothing beyond one macrotask on today's default (space_tokens off) posture. What this
   * replaces is a SEPARATE fast path a mint-nothing broadcast used to take with no placeholder at all —
   * which had nothing to catch a bare-signature space-token exhaustion (F2).
   */
  async postToChannel(channelId: string, content: string): Promise<void> {
    if (!this.identity) {
      return;
    }
    const intent: PendingChannelWrite = {
      type: 'channel',
      id: this.localComposeId(),
      channelId,
      content,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    // NO recordOwnPostOrder: that key only feeds buildFeed's sortAt, to undo the bucket-fuzzed
    // created_at a BLIND post gets. A broadcast's created_at is unfuzzed and channelMessages sorts on
    // it directly, so a broadcast has nothing to correct for.
    await this.queuePendingWrite(intent);
  }

  /**
   * Author edit of one of your broadcasts — position-preserving (folds over the original at read time,
   * see channels.ts channelMessages). ALWAYS durable (T0.2), via the 'channelEdit' PendingWrite variant
   * — same placeholder + failed/Retry + drainPendingPosts treatment as a fresh broadcast, and for the
   * same reason: this edit's own bound-npub signature can spend a space-write token once the relay
   * requires one (PendingChannelEditWrite's doc). Previously this had no placeholder/catch at all, so a
   * drought here threw uncaught with the edited text lost.
   */
  async editChannelMessage(channelId: string, originalId: string, content: string): Promise<void> {
    if (!this.identity) return;
    const intent: PendingChannelEditWrite = {
      type: 'channelEdit',
      id: this.localComposeId(),
      channelId,
      originalId,
      content,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    await this.queuePendingWrite(intent);
  }

  /** Owner: edit a channel's metadata/gradient by re-publishing the same `d` (latest-wins). */
  async editChannel(channelId: string, meta: ChannelMetadata): Promise<void> {
    if (!this.identity) return;
    const parts = channelId.split(':');
    // coord = 30311:<owner>:<d> — owner-only guard.
    if (parts[1] !== this.myPubkey) return;
    const d = parts.slice(2).join(':');
    if (!d) return;
    // A 30311 edit REPLACES the whole tag set (addressable, latest-wins), so structural flags a
    // metadata/pin edit doesn't carry — the open-community mode and the admin roster — must be
    // preserved from the current definition, or a rename/pin would silently revert an open community
    // to a plain public channel and wipe its admins. Explicit values in `meta` still win (e.g. an
    // admin-roster edit passes `admins`).
    const existing = this.listChannels().find(c => c.id === channelId);
    const merged: ChannelMetadata = {
      ...meta,
      admins: meta.admins ?? existing?.admins,
      openCommunity: meta.openCommunity ?? existing?.openCommunity,
    };
    const event = await this.identity.sign(buildChannelEdit(d, merged));
    await this.publishOptimistic(event);
  }

  /** Owner: pin (or unpin, with null) a broadcast — merged into the channel def and republished. */
  async setChannelPinned(channelId: string, messageId: string | null): Promise<void> {
    if (!this.identity) return;
    if (channelId.split(':')[1] !== this.myPubkey) return; // owner-only
    const ch = this.listChannels().find(c => c.id === channelId);
    if (!ch) return;
    await this.editChannel(channelId, {
      name: ch.name,
      about: ch.about,
      picture: ch.picture,
      gradient: ch.gradient,
      reactions: ch.reactions,
      pinnedMessageId: messageId ?? undefined,
    });
  }

  /** Owner: delete a channel (NIP-09 kind-5 referencing the addressable 30311 coordinate). */
  async deleteChannel(channelId: string): Promise<void> {
    if (!this.identity) return;
    const parts = channelId.split(':');
    if (parts[1] !== this.myPubkey) return; // owner-only
    const event = await this.identity.sign({
      kind: Kind.Delete,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['a', channelId], ['k', String(Kind.LiveActivity)]],
      content: '',
    });
    await this.publishOptimistic(event);
  }

  /** Owner: open/close comments & reactions on a channel message (NIP-53, client-honored). */
  async setChannelInteractions(messageId: string, perm: PostInteractions): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildChannelInteractionControl(messageId, perm));
    await this.publishOptimistic(event);
  }

  /**
   * React (kind-7) to a channel message. DURABLE (T-reactions): kind 7 is a BLIND content kind
   * relay-side (blindContentKinds) — a blind community rejects a tokenless npub-signed reaction with
   * [token_required]. A channel reaction carries no `h` tag, so it rides the same blind path as a feed
   * vote — throwaway signer + posting token + encrypted attribution (members still resolve who
   * reacted; the relay can't). sendReaction keeps the tap instant while the token spend happens
   * behind the placeholder, and — unlike the signOptimisticWrite path this used to ride — keeps the
   * placeholder 'failed'+Retry (never discards it) on a drought, draining once tokens arrive.
   */
  async reactToChannelMessage(
    messageId: string,
    messagePubkey: string,
    content = '+',
  ): Promise<void> {
    if (!this.identity) return;
    const unsigned = buildEmojiReaction(messageId, messagePubkey, content);
    await this.sendReaction('channel', messageId, messagePubkey, unsigned);
  }

  /**
   * The interaction state an owner has set for a channel message. Comments still default CLOSED
   * (unchanged); REACTIONS now default to the space rule's `defaultReactions` (spaceRules.ts —
   * previously ignored entirely, so an admin-configured "reactions on by default" setting never
   * actually took effect and every message needed its OWN per-message open) — an explicit per-message
   * owner override (buildChannelInteractionControl) still wins either way.
   */
  getChannelMessageInteractions(channelId: string, messageId: string): PostInteractions {
    const owner = channelId.split(':')[1] ?? '';
    const fallback = {comments: false, reactions: this.spaceAutoCfg(channelId, 'channel').rules.defaultReactions};
    return channelPostInteractions(this.deps.store, owner, messageId, fallback);
  }

  // ── NIP-29 managed groups ─────────────────────────────────────────────────────────────────

  // ── private-space E2E key cache (decrypt-on-read) ──────────────────────────────────────────────

  /**
   * Whether a group is PRIVATE (E2E-encrypted) per the relay's 39000. A space is encrypted iff it is
   * flagged `private` — this covers BOTH a private group (members read+write) and a private CHANNEL
   * (private + broadcast: members read, admins write). `broadcast` governs only WHO may write top-
   * level, NOT whether content is encrypted, so a private+broadcast space IS encrypted. Only a public
   * space (private:false) — including a PUBLIC broadcast — stays plaintext. (This is a relay-dependent
   * signal; `isEncryptedSpace` is the relay-independent local mark and holding a key is authoritative,
   * so the seal/decrypt paths OR these together.) A NIP-53 channel is never private today (no
   * `private` flag), so this only returns true for groups.
   */
  private isPrivateSpace(groupId: string): boolean {
    const st = groupStateOf(this.deps.store, groupId);
    return !!st?.private;
  }

  /** Put a key into the in-memory cache + track the highest epoch (synchronous side). */
  private cacheSpaceKeyInMemory(spaceId: string, epoch: number, key: Uint8Array): void {
    if (!this._spaceKeyCache.has(`${spaceId}:${epoch}`)) this._spaceKeysVersion++;
    this._spaceKeyCache.set(`${spaceId}:${epoch}`, key);
    const cur = this._spaceEpoch.get(spaceId);
    if (cur === undefined || epoch > cur) this._spaceEpoch.set(spaceId, epoch);
  }

  /**
   * Persist a freshly-obtained space key (keystore) AND populate the in-memory cache so render can
   * read it synchronously. Idempotent. The key is a secret — only ever stored via the keystore.
   */
  private async cacheSpaceKey(spaceId: string, epoch: number, key: Uint8Array): Promise<void> {
    this.cacheSpaceKeyInMemory(spaceId, epoch, key);
    await storeSpaceKey(spaceId, epoch, key);
  }

  /**
   * Hydrate every stored epoch key for a space into the in-memory cache (called when the space
   * opens, before its messages render). Walks epochs 0..currentEpoch so old-epoch messages stay
   * decryptable after rotation. No-op when nothing is stored.
   */
  private async hydrateSpaceKeys(spaceId: string): Promise<void> {
    // Retry any key deliveries dropped before this group's owner/admin state was known (startup, and
    // deliveries that raced ahead of state) — the persisted state is now available to verify them.
    this.reprocessPendingKeyDeliveries(spaceId);
    const top = await currentSpaceEpoch(spaceId);
    if (top < 0) return;
    // Only re-render if we actually cached a NEW key. Emitting unconditionally here fed a render loop:
    // opening a private space → this emit → MainScreen re-render → its open-group effect re-ran (its
    // callback deps changed identity every render) → openGroup → hydrateSpaceKeys → this emit → … which
    // froze the whole app. Guarding on `changed` (plus stabilizing that effect's deps) breaks it.
    let changed = false;
    for (let e = 0; e <= top; e++) {
      if (this._spaceKeyCache.has(`${spaceId}:${e}`)) continue;
      const key = await loadSpaceKey(spaceId, e);
      if (key) { this.cacheSpaceKeyInMemory(spaceId, e, key); changed = true; }
    }
    if (changed) this.emit();
  }

  /** The latest space key for OUTGOING messages, or undefined when none is cached (not a member). */
  private outgoingSpaceKey(spaceId: string): SpaceKey | undefined {
    const epoch = this._spaceEpoch.get(spaceId);
    if (epoch === undefined) return undefined;
    const key = this._spaceKeyCache.get(`${spaceId}:${epoch}`);
    return key ? {key, epoch} : undefined;
  }

  /**
   * Decide whether an incoming AUTHORIZED kind-30079 delivery should REPLACE the key already cached
   * for the same `(spaceId, epoch)`. Owner-signed deliveries win over admin ones; among same-source
   * deliveries the latest by created_at wins. A locally-minted key (no provenance entry) is treated
   * as owner-equivalent and is never overwritten by a remote same-epoch delivery (our own copy is
   * authoritative for keys we minted). Prevents a legitimate admin rotation from being silently
   * dropped while stopping a stale/duplicate delivery from clobbering a good key.
   */
  private shouldReplaceSpaceKey(
    cacheKey: string,
    delivery: {sender: string},
    senderIsOwner: boolean,
    createdAt: number,
  ): boolean {
    const prev = this._spaceKeyDeliveryMeta.get(cacheKey);
    // No provenance → the cached key was minted locally (our own) → keep it.
    if (!prev) return false;
    // Owner trumps admin.
    if (senderIsOwner && !prev.fromOwner) return true;
    if (!senderIsOwner && prev.fromOwner) return false;
    // Same authority tier → prefer the newer delivery.
    return createdAt > prev.createdAt;
  }

  /**
   * Resolve the encryption key for an OUTGOING message in `groupId`, FAIL-CLOSED and RELAY-INDEPENDENT.
   *
   * The classification must NOT trust the relay's 39000 alone (it can be absent during the
   * create→send window, or stripped by a malicious relay). So:
   *  1. If we HOLD a key for this space → ALWAYS encrypt under it (`{enc}`). This is authoritative:
   *     possessing a space key means the space is encrypted, regardless of what 39000 says.
   *  2. Else if the space is private (relay 39000) OR locally marked encrypted (`isEncryptedSpace`)
   *     → BLOCK the send (`{blocked: true}`). We never fall through to plaintext for a space we
   *     believe is encrypted but whose key hasn't hydrated/arrived yet — that would leak to the relay.
   *  3. Else (genuinely public/broadcast) → `{}` → plaintext, byte-identical to before.
   */
  private outgoingSeal(groupId: string): {enc?: SpaceKey; blocked?: boolean} {
    const key = this.outgoingSpaceKey(groupId);
    if (key) return {enc: key}; // we hold a key → always encrypt (relay-independent)
    if (this.isPrivateSpace(groupId) || isEncryptedSpace(groupId)) return {blocked: true};
    return {}; // genuinely public → plaintext
  }

  /**
   * Decrypt-on-read transform for a private/encrypted space's messages. For each event tagged
   * `['encrypted','nip44']`, look up its `ke`-epoch key in the cache and replace `content` with the
   * plaintext, then learn the author's name from the DECRYPTED header.
   *
   * NEVER RENDER CIPHERTEXT: for a space we treat as encrypted (private per 39000 OR locally marked
   * encrypted), we push ONLY successfully-decrypted messages. Anything else is HIDDEN —
   *  - a message whose `['encrypted','nip44']`/`ke` tag was stripped (epoch === null) — a malicious
   *    relay can't downgrade an encrypted space to leak/forge a "plaintext" message;
   *  - a message whose epoch key we don't hold; or
   *  - a message that fails to decrypt (tampered / wrong key).
   * A member missing a key sees the space minus those messages, never ciphertext, never a crash.
   */
  private decryptSpaceMessages(events: Event[], spaceId: string): Event[] {
    // Relay-independent classification: a space is encrypted if 39000 says private OR we locally
    // marked it (key obtained). For such spaces, undecryptable == hidden (no plaintext pass-through).
    const encrypted = this.isPrivateSpace(spaceId) || isEncryptedSpace(spaceId);
    const out: Event[] = [];
    for (const ev of events) {
      const epoch = messageEpoch(ev);
      if (epoch === null) {
        // Tag absent. For an encrypted space this is a stripped/forged message → HIDE (never render
        // raw content as text). For a genuinely public space, pass plaintext through unchanged.
        if (!encrypted) out.push(ev);
        continue;
      }
      // Decrypt-once: an event's plaintext is immutable, so serve a prior decrypt straight from the
      // per-session cache (finding #4). This is what makes a repeat render / search keystroke over an
      // open private space do ZERO NIP-44 work.
      const cachedPlain = this._spacePlaintextCache.get(ev.id);
      if (cachedPlain !== undefined) {
        this.learnNameFromContent(ev.pubkey, cachedPlain, ev.created_at);
        out.push({...ev, content: cachedPlain});
        continue;
      }
      const key = this._spaceKeyCache.get(`${spaceId}:${epoch}`);
      if (!key) continue; // no key for this epoch — hide
      try {
        const plaintext = decryptForSpace(ev.content, key);
        this._spacePlaintextCache.set(ev.id, plaintext); // memory-only; never persisted
        // Learn the author's name/gradient from the DECRYPTED header (the raw ciphertext was skipped
        // in learnNameFrom to avoid poisoning displayNames — see FIX 4).
        this.learnNameFromContent(ev.pubkey, plaintext, ev.created_at);
        out.push({...ev, content: plaintext});
      } catch {
        // undecryptable (tampered / wrong key) — hide rather than render ciphertext
      }
    }
    return out;
  }

  /**
   * Create a relay-managed group (NIP-29) and return its id. The relay validates the 9007, makes
   * the creator owner+admin, and emits the 39000-39003 state the client will fetch. Returns null
   * if not enrolled.
   *
   * For a PRIVATE space — a private group OR a private CHANNEL (any `private:true`) — mint the shared
   * E2E key at epoch 0 and store it so the creator can immediately encrypt/decrypt; it is later
   * delivered to members via the invite link. `broadcast` only sets who may WRITE, not whether the
   * space is encrypted, so a private+broadcast channel is keyed here too.
   */
  async createGroup(meta: GroupMeta = {}): Promise<string | null> {
    if (!this.identity) return null;
    const groupId = newGroupId();
    // Mint + store the space key for ANY private space (private group AND private+broadcast channel);
    // both are "members-only reading" and E2E-encrypted. Only a genuinely PUBLIC space (private:false),
    // including a public broadcast, stays plaintext.
    // CRITICAL: cache the key in memory + mark the space encrypted SYNCHRONOUSLY (before the first
    // await / any publish) so the creator can NEVER plaintext-send in the create→send window even if
    // the relay's 39000 hasn't arrived. cacheSpaceKeyInMemory is sync; the keystore write + the
    // AsyncStorage write are awaited but the in-memory state (cache + isEncryptedSpace) is set first.
    if (meta.private) {
      const key = mintGroupKey();
      this.cacheSpaceKeyInMemory(groupId, 0, key); // synchronous — closes the create→send race
      void addEncryptedSpace(groupId); // in-memory mark is synchronous; persist best-effort
      await storeSpaceKey(groupId, 0, key); // persist the secret to the keystore
    }
    const event = await this.identity.sign(buildGroupCreate(groupId, meta));
    // OPTIMISTIC state: a 9007 create alone gives the client no name/owner/members/admins/flags (those
    // come from the relay's 39000-39003, which only arrive after a slow Tor round-trip) — so the new
    // space would otherwise render as a nameless hexagon the creator can't even post in. Seed local,
    // self-authored 39000/39001/39002 (creator = owner+admin+member) so it shows the right name, type
    // (diamond/"Private channel"), encryption banner, and a working composer INSTANTLY. Stored locally
    // only + tagged ['optimistic'] so the relay's authoritative state supersedes it on arrival.
    if (this.myPubkey) {
      for (const tmpl of buildOptimisticGroupState(groupId, meta, this.myPubkey)) {
        this.deps.store.save(await this.identity.sign(tmpl));
      }
    }
    await this.publishOptimistic(event);
    // Subscribe so the relay's emitted 39000-39003 state flows in and supersedes the optimistic seed.
    await this.trackGroup(groupId);
    return groupId;
  }

  /** Request to join a group (auto-admitted if open; pending an admin if closed). */
  async joinGroup(groupId: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupJoinRequest(groupId));
    await this.publishOptimistic(event);
    await this.trackGroup(groupId);
  }

  /** Leave a group. */
  async leaveGroup(groupId: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupLeaveRequest(groupId));
    await this.publishOptimistic(event);
    await this.untrackGroup(groupId);
  }

  /** Admin action: add (or, with asAdmin, promote) a user to a group. For a private/encrypted space,
   * deliver the CURRENT-epoch key to the new member so they can immediately read + post. */
  async addGroupMember(
    groupId: string,
    pubkey: string,
    asAdmin = false,
    overlayOp?: RosterOp | null,
  ): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupAddUser(groupId, pubkey, asAdmin));
    // Stamp the optimistic overlay BEFORE publishOptimistic so its emit() already sees the intent.
    // An explicit overlayOp (approveJoin passes 'approve') wins; otherwise a bare add promotes-or-
    // demotes by the admin flag. The three UI getters apply it until the relay reconciles or rejects.
    // `null` suppresses stamping entirely — the BACKGROUND invited-accept auto-approve sweep
    // (autoApproveInvited) is not a user tap needing instant feedback, and its established UX keeps
    // the invitee visible in getJoinRequestQueue flagged invited:true until the relay's 39002 lands.
    if (overlayOp !== null) {
      this.stampRosterOverlay(groupId, pubkey, overlayOp ?? (asAdmin ? 'promote' : 'demote'), event.id);
    }
    await this.publishOptimistic(event);
    // KEY THE NEW MEMBER (availability + closes the stale-invite leak): an admin silently adding a
    // member must hand them the current key, else they can never decrypt/post. Delivering the CURRENT
    // epoch — not an old one a removed member still holds — is what closes the leak where a joiner
    // posts under a stale epoch. Reuses rotateSpaceKey's wrap/deliver path (deliverSpaceKeyTo).
    if (this.isPrivateSpace(groupId) || isEncryptedSpace(groupId)) {
      await this.deliverCurrentSpaceKeyTo(groupId, pubkey);
    }
  }

  /**
   * Wrap + publish the CURRENT-epoch space key to `member` as a kind-30079 delivery. Self-delivery is
   * skipped (we hold our own copy). No-op when no key is cached (we can't key someone we can't read).
   * Best-effort: a failed publish doesn't throw — the member re-ingests on a later sync.
   */
  private async deliverCurrentSpaceKeyTo(groupId: string, member: string): Promise<void> {
    if (!this.identity || member === this.myPubkey) return;
    const current = this.outgoingSpaceKey(groupId);
    if (!current) return; // no key cached → nothing to deliver
    try {
      const delivery = await this.identity.wrapSpaceKeyFor(groupId, current.epoch, current.key, member);
      await this.publishOptimistic(delivery);
      this.markKeyDelivered(groupId, member, current.epoch);
    } catch {
      // best effort — the new member picks the key up from the replaceable delivery on later sync
    }
  }

  /** Record (and persist, best-effort) that `member` has been handed the space key for `epoch`,
   *  so the 39002-driven backfill never re-delivers what this device already sent. */
  private markKeyDelivered(groupId: string, member: string, epoch: number): void {
    const key = `${groupId}:${member}`;
    const prev = this._deliveredKeyTo.get(key);
    if (prev !== undefined && prev >= epoch) return;
    this._deliveredKeyTo.set(key, epoch);
    void saveDeliveredSpaceKeys(
      Object.fromEntries(this._deliveredKeyTo),
      this.activeSlotId ?? undefined,
    );
  }

  /** Admin action: remove (kick) a user from a group. Rotates the E2E key for a private space. */
  async kickGroupMember(groupId: string, pubkey: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupRemoveUser(groupId, pubkey));
    // Stamp the optimistic 'kick' BEFORE publishOptimistic (so its emit() sees it) and BEFORE the
    // rotate/revoke side effects below, which are unchanged and keep reading relay-confirmed truth.
    this.stampRosterOverlay(groupId, pubkey, 'kick', event.id);
    await this.publishOptimistic(event);
    // For a PRIVATE space, rotate the shared key so the removed member can't read post-removal
    // messages. Mint epoch+1, store it locally, and deliver it (NIP-44-wrapped per member) to every
    // REMAINING member. New messages use the new epoch; the removed member lacks the new key.
    if (this.isPrivateSpace(groupId) || isEncryptedSpace(groupId)) {
      await this.rotateSpaceKey(groupId, pubkey);
    }
    // A kick must also RETIRE the target's fulfilled invite entry: it is only masked from the fold
    // while they are a member, so post-kick it would resurface in getSpaceInvited and any online
    // admin's autoApproveInvited would silently re-admit their next bare 9021 — undoing the kick
    // with no admin decision. A revoke from any authorized author is authoritative across the whole
    // fold (foldInvites: newer revoke beats every older add), so the kicker's own doc suffices.
    // (A VOLUNTARY leaver's entry is deliberately left alone: a leaver asking to rejoin being
    // auto-approved by a still-standing invite is the smooth re-entry we want, not a hole — and the
    // relay-side grant gate (RemovedAt) already forces a kicked member's GRANT path to pending.)
    await this.revokeSpaceInvite(groupId, pubkey);
  }

  /**
   * Mint a new-epoch E2E key for a private space and re-distribute it to each remaining member via a
   * per-member NIP-44-wrapped kind-30079 delivery event. `removed` is excluded from delivery (and so
   * never receives the new key). Self-delivery is skipped — we already store our own copy locally.
   *
   * Best-effort: a delivery that fails to publish doesn't block the rotation; that member will pick
   * up the new key from the addressable (replaceable) delivery event on a later sync, or via a fresh
   * invite. Old-epoch keys are retained so pre-rotation history stays readable.
   *
   * KNOWN LIMITATION (not fully solved here): two different admins rotating CONCURRENTLY can each mint
   * a DIFFERENT key for the same epoch number → divergent keys and message loss for messages sealed
   * under the loser's key. The owner-wins replacement in shouldReplaceSpaceKey reduces but does not
   * eliminate this (two admins racing produce two admin-tier keys). The clean resolution is an OWNER
   * re-key: the owner mints the next epoch and redelivers, and shouldReplaceSpaceKey makes the
   * owner's delivery authoritative, converging everyone onto one key.
   */
  private async rotateSpaceKey(groupId: string, removed: string): Promise<void> {
    if (!this.identity) return;
    // Record the departure so the 39002-shrink rekey (maybeRekeyOnMemberLeave) doesn't rotate AGAIN
    // when the relay's resulting member-list update arrives — a kick rotates here immediately.
    let out = this._rotatedOut.get(groupId);
    if (!out) this._rotatedOut.set(groupId, (out = new Set()));
    out.add(removed);
    const prevEpoch = await currentSpaceEpoch(groupId);
    const newEpoch = Math.max(0, prevEpoch) + 1;
    const newKey = mintGroupKey();
    // Store + cache locally first so OUR new messages immediately use the new epoch.
    await this.cacheSpaceKey(groupId, newEpoch, newKey);

    const remaining = groupMembersOf(this.deps.store, groupId).filter(
      pk => pk !== removed && pk !== this.myPubkey,
    );
    // 0 remaining members → nothing to deliver; the local mint+store above is sufficient.
    if (remaining.length === 0) return;
    for (const member of remaining) {
      try {
        const delivery = await this.identity.wrapSpaceKeyFor(groupId, newEpoch, newKey, member);
        await this.publishOptimistic(delivery);
        this.markKeyDelivered(groupId, member, newEpoch);
      } catch {
        // a single member's delivery failing must not abort the rotation
      }
    }
  }

  /**
   * Censorable space reads (tokens-everywhere): rotate the SpaceKey when a member DISAPPEARS from a
   * private space we own, so a VOLUNTARY leaver (9022 — which, unlike a kick, never triggered a
   * rotation) can't read messages sent after they left. Driven by the relay's 39002 member-list
   * stream: we diff the new list against the last snapshot and rotate away from anyone who vanished.
   *
   * OWNER-ONLY, deliberately: two admins rotating concurrently mint divergent keys (the documented
   * limitation on {@link rotateSpaceKey}). The owner is the single converging authority — an owner
   * re-key is exactly the "clean resolution" that path describes — so only the owner rekeys on a
   * leave; an admin observing the shrink defers to the owner. A member already rotated out by a kick
   * this session is skipped (kickGroupMember rotated immediately), so a kick never double-rotates.
   *
   * SHIPS SAFE: the first 39002 for a space only seeds the snapshot (no prior set → no "left" diff),
   * so opening a space never spuriously rekeys. A no-op for public spaces / spaces we don't own /
   * spaces we hold no key for.
   */
  private maybeRekeyOnMemberLeave(event: Event): void {
    const groupId = event.tags.find(t => t[0] === 'd')?.[1];
    if (!groupId || !this.myPubkey) return;
    const nextMembers = new Set(groupMembersOf(this.deps.store, groupId));
    const prev = this._spaceMemberSnapshot.get(groupId);
    this._spaceMemberSnapshot.set(groupId, nextMembers);
    // No prior snapshot ⇒ this is the first 39002 we've seen; seed only, never rekey.
    if (!prev) return;
    // Only the OWNER rekeys, and only for a private/encrypted space we actually hold a key for.
    if (!this.isGroupOwner(groupId)) return;
    if (!(this.isPrivateSpace(groupId) || isEncryptedSpace(groupId))) return;
    if (!this.outgoingSpaceKey(groupId)) return;
    const rotatedOut = this._rotatedOut.get(groupId);
    for (const pk of prev) {
      if (pk === this.myPubkey || nextMembers.has(pk)) continue; // still present (or us)
      if (rotatedOut?.has(pk)) continue; // already rotated away from (a kick) — don't double-rotate
      // A member left and we haven't rekeyed them out yet — rotate now (best-effort, background).
      void this.rotateSpaceKey(groupId, pk).catch(() => {});
    }
  }

  /**
   * Member-arrival key backfill (the "joined but can't read/post" fix). The relay's grant-admit
   * path (inviteGrantAdmits) makes someone a MEMBER with no admin action at all — and no admin
   * action means nobody ever ran {@link deliverCurrentSpaceKeyTo} for them: they land in a private
   * space that renders empty and where their own sends are blocked (outgoingSeal is fail-closed).
   *
   * Fix: every time an admin/owner device that HOLDS the key sees a 39002 for a private/encrypted
   * space, it delivers the current-epoch key to every member it hasn't already keyed at that epoch
   * (the persisted {@link _deliveredKeyTo} dedupe bounds the cost — one delivery per member per
   * epoch, ever). Deliberately NOT diffed against a member-list snapshot: sweeping the full list
   * also BACKFILLS members grant-admitted before this fix shipped, self-healing existing spaces the
   * moment any admin's client sees their 39002. Epoch-keyed dedupe also covers the
   * rotate-between-invite-and-accept race for free: a rotation bumps the epoch, the next 39002
   * re-delivers the fresh key. Not owner-gated (any keyed admin may backfill — delivery is
   * idempotent per (author, space, member) via the addressable 30079).
   */
  private maybeDeliverKeyToNewMembers(event: Event): void {
    const groupId = event.tags.find(t => t[0] === 'd')?.[1];
    if (!groupId || !this.myPubkey || !this.identity) return;
    if (!isGroupAdminOf(this.deps.store, groupId, this.myPubkey)) return;
    if (!(this.isPrivateSpace(groupId) || isEncryptedSpace(groupId))) return;
    const current = this.outgoingSpaceKey(groupId);
    if (!current) return; // we hold no key ourselves — nothing to hand out
    for (const member of groupMembersOf(this.deps.store, groupId)) {
      if (member === this.myPubkey) continue;
      if ((this._deliveredKeyTo.get(`${groupId}:${member}`) ?? -1) >= current.epoch) continue;
      // Best-effort, background — deliverCurrentSpaceKeyTo marks the dedupe on success only, so a
      // failed publish retries on the next 39002 arrival.
      void this.deliverCurrentSpaceKeyTo(groupId, member);
    }
  }

  /**
   * The highest space-key epoch demonstrably IN USE in `spaceId` — the max `ke` tag across its
   * cached messages (−1 when none carry one). Cheap store scan, run only on opening a
   * private/encrypted space; the vc14 on-open backfill is what keeps this evidence fresh.
   */
  private maxSeenSpaceEpoch(spaceId: string): number {
    let max = -1;
    for (const ev of this.deps.store.query({kinds: [9, 11, 12, Kind.LiveChat]})) {
      const sid = ev.tags.find(t => (t[0] === 'h' || t[0] === 'a') && t[1])?.[1];
      if (sid !== spaceId) continue;
      const epoch = messageEpoch(ev);
      if (epoch !== null && epoch > max) max = epoch;
    }
    return max;
  }

  /**
   * REQUESTER half of the key-redelivery loop (the "private space looks empty forever" fix,
   * OPEN_ITEMS §3.1). A member can end up in a private space holding no usable key with NOTHING
   * left to heal them: the admin's kind-30079 delivery never reached this device (relay pruned or
   * paged it out, publish lost in an outage) while the admin's persisted `_deliveredKeyTo`
   * watermark says "already keyed at this epoch" — so the 39002-driven backfill will never send
   * again, decryptSpaceMessages hides everything, and the space renders a legitimate-looking
   * "No messages yet." indefinitely.
   *
   * The break-out is explicit: publish ONE addressable kind-30078 request doc
   * (`d="space-key-request:<spaceId>"`, h-tagged so it rides the group's own scoped sub) that any
   * keyed admin's {@link maybeRedeliverSpaceKey} answers by re-running the current-epoch delivery,
   * watermark notwithstanding. Fires from the same on-open moment as hydrateSpaceKeys — the open
   * is what proves the member actually wants in — and only when the evidence says we're behind:
   * we hold NO key at all, or cached messages carry a `ke` above our highest epoch (a rotation we
   * missed). Once per space per session; the addressable doc replaces itself server-side.
   */
  private async maybeRequestSpaceKeyRedelivery(spaceId: string): Promise<void> {
    if (!this.identity || !this.enrolled || !this.myPubkey) return;
    if (this._keyRedeliveryRequested.has(spaceId)) return;
    const held = this._spaceEpoch.get(spaceId) ?? -1;
    if (held >= 0 && held >= this.maxSeenSpaceEpoch(spaceId)) return; // current — nothing to heal
    // Non-members don't ask: a keyed admin ignores an outsider's request anyway (the responder's
    // membership gate), so skip the publish when the relay-signed roster is known and excludes us.
    // An absent roster (39002 not yet synced) errs toward asking — worst case an unanswered doc.
    const members = groupMembersOf(this.deps.store, spaceId);
    if (members.length > 0 && !members.includes(this.myPubkey)) return;
    this._keyRedeliveryRequested.add(spaceId);
    const event = await this.identity.sign(buildSpaceKeyRequest(spaceId));
    await this.publishOptimistic(event);
  }

  /**
   * RESPONDER half of the key-redelivery loop: an incoming `space-key-request:` doc (see
   * {@link maybeRequestSpaceKeyRedelivery}) from a CURRENT member of a private/encrypted space
   * this device holds the key for → re-run the per-member current-epoch delivery.
   *
   * Guards, in order of what they protect:
   *  • admin-of-space + member-of-space (relay-signed 39001/39002) — a key must never leave for an
   *    outsider: a kicked/never-joined requester fails the roster check, exactly like every other
   *    delivery path (this is the same relay-confirmed truth maybeDeliverKeyToNewMembers acts on);
   *  • CURRENT epoch only — a rejoiner who lost old epochs must not recover the history a rotation
   *    deliberately locked away from them;
   *  • created_at watermark per (space, requester) — the same addressable request replayed by a
   *    reconnect is answered once; a genuinely NEW request (fresh created_at from the member's next
   *    session) is answered again.
   *
   * The point of this path is that it deliberately BYPASSES the `_deliveredKeyTo` watermark:
   * that watermark records "this device already sent it", the request is the member proving the
   * key never ARRIVED, and the request wins. deliverCurrentSpaceKeyTo publishes unconditionally
   * and re-marks the watermark on success, so the 39002 sweep's dedupe stays consistent after.
   */
  private maybeRedeliverSpaceKey(event: Event): void {
    const req = parseSpaceKeyRequest(event);
    if (!req || !this.myPubkey || req.requester === this.myPubkey) return;
    const {spaceId, requester} = req;
    if (!isGroupAdminOf(this.deps.store, spaceId, this.myPubkey)) return;
    if (!(this.isPrivateSpace(spaceId) || isEncryptedSpace(spaceId))) return;
    if (!this.outgoingSpaceKey(spaceId)) return; // we hold nothing to hand out
    if (!groupMembersOf(this.deps.store, spaceId).includes(requester)) return;
    const answeredKey = `${spaceId}:${requester}`;
    if ((this._keyRequestAnswered.get(answeredKey) ?? 0) >= req.at) return;
    this._keyRequestAnswered.set(answeredKey, req.at);
    void this.deliverCurrentSpaceKeyTo(spaceId, requester);
  }

  /** Admin action: edit a group's metadata/access. */
  async editGroup(groupId: string, meta: GroupMeta): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupEditMetadata(groupId, meta));
    await this.publishOptimistic(event);
  }

  /** Admin action: open/close comments & reactions on a group post (kind-9009, relay-enforced). */
  async setGroupInteractions(
    groupId: string,
    messageId: string,
    perm: PostInteractions,
  ): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(
      buildGroupInteractionControl(groupId, messageId, perm),
    );
    await this.publishOptimistic(event);
  }

  /**
   * React (group-scoped kind-7 with `['h',groupId]`) to a group message. DURABLE (T-reactions): an
   * h-tagged kind-7 can't ride the throwaway blind path (GroupGuard requires the REAL member npub),
   * yet the relay's blind gate covers kind 7 regardless of tags — so under blind_required it stays
   * npub-signed and carries a BEARER posting token (see bearerReactionTokenTags, applied inside
   * signPendingEvent's 'group'-scope branch). The placeholder keeps the tap instant even when the
   * wallet needs a Tor top-up first, and — unlike the signOptimisticWrite path this used to ride —
   * stays 'failed'+Retry (never discarded) on a drought, draining once tokens arrive.
   */
  async reactToGroupMessage(
    groupId: string,
    messageId: string,
    messagePubkey: string,
    content = '+',
  ): Promise<void> {
    if (!this.identity) return;
    const unsigned = buildGroupReaction(groupId, messageId, messagePubkey, content);
    await this.sendReaction('group', messageId, messagePubkey, unsigned, groupId);
  }

  /**
   * The authoritative interaction state for a group post. Comments still default CLOSED; REACTIONS
   * default to the space rule's `defaultReactions` — see getChannelMessageInteractions's doc (same
   * fix, same reasoning). An explicit per-message admin override still wins.
   */
  getGroupPostInteractions(groupId: string, messageId: string): PostInteractions {
    const fallback = {comments: false, reactions: this.spaceAutoCfg(groupId, 'group').rules.defaultReactions};
    return groupPostInteractions(this.deps.store, messageId, fallback);
  }

  /** Admin action: approve a pending join request (adds the user as a plain member). */
  async approveJoin(groupId: string, pubkey: string): Promise<void> {
    // Pass 'approve' so the overlay stamps an approve (adds to members + drops from the pending
    // queue) rather than being mis-stamped 'demote' by addGroupMember's asAdmin=false default.
    await this.addGroupMember(groupId, pubkey, false, 'approve');
  }

  /**
   * Admin action: deny a pending join request (relay clears it from the pending set).
   *
   * Does NOT rotate the space key: the denied user was never a member and never received the key, so
   * rotating would be a spurious, costly re-key (a fresh per-member delivery to everyone) that
   * protects against nothing. Publishes the 9001 remove (which clears the pending entry) directly,
   * bypassing kickGroupMember's rotation.
   */
  async denyJoin(groupId: string, pubkey: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupRemoveUser(groupId, pubkey));
    // Kick and deny share the 9001 wire kind, so the overlay op is the only discriminator: stamp
    // 'deny' here (drops from the pending queue) vs kickGroupMember's 'kick' (drops from members).
    this.stampRosterOverlay(groupId, pubkey, 'deny', event.id);
    await this.publishOptimistic(event);
  }

  /** Owner action: delete the group entirely, and drop it from this user's list. */
  async deleteGroup(groupId: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupDelete(groupId));
    await this.publishOptimistic(event);
    await this.untrackGroup(groupId);
  }

  /** Owner action: transfer ownership of the group to another member. */
  async transferGroupOwner(groupId: string, pubkey: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupTransferOwner(groupId, pubkey));
    await this.publishOptimistic(event);
  }

  /**
   * Invite a specific user to a (private) group by DMing them the join link — they CHOOSE to join
   * by acting on it (vs an admin silently adding them). The invite is a normal encrypted DM, so it
   * is a unique, targeted invite for that one member.
   *
   * The link is navigate-only and never carries the space's E2E key: the recipient opens it, sends
   * a kind-9021 join request, and — once an admin approves — `deliverCurrentSpaceKeyTo` hands them
   * the current-epoch key via kind-30079. This avoids ever putting the membership credential in a
   * URL that could be logged, screenshotted, or forwarded outside the DM.
   */
  async inviteToGroup(groupId: string, recipientPubkey: string): Promise<void> {
    await this.inviteToSpace(groupId, [recipientPubkey]);
  }

  /**
   * Accept an invite LINK: parse it, store any carried E2E key (so the space decrypts immediately),
   * then join. Use this for the deep-link / pasted-link path. Returns the space id (or null when the
   * link is unrecognisable). The key fragment, if present, never leaves the device.
   */
  async acceptInviteLink(url: string): Promise<string | null> {
    const parsed = parseInviteLink(url);
    if (!parsed) return null;
    if (parsed.key && parsed.epoch !== undefined) {
      // We received a space key via the invite fragment → this space is encrypted. Mark it locally
      // (relay-independent) BEFORE joining so any immediate send is fail-closed, and cache the key.
      await addEncryptedSpace(parsed.spaceId);
      await this.cacheSpaceKey(parsed.spaceId, parsed.epoch, parsed.key);
    }
    await this.joinGroup(parsed.spaceId);
    return parsed.spaceId;
  }

  // ── Membership handoff: sealed-note join requests + accept-first invites ─────────────────────
  // (design_handoff_membership; MEMBERSHIP_HANDOFF_PLAN.md. Relay untouched — 9021/9022/9000/9001
  // already do everything; every new behaviour here is client-side.)

  /**
   * The group ids the Channels inbox lists: the joined set MINUS spaces where my join request is
   * still outstanding and I'm not yet a member. A requested space is tracked (subscribed) so its
   * state streams in, but the design keeps its pending life on the locked preview / embed CTA —
   * it only becomes an inbox row once an admin lets me in (or immediately, for an open group,
   * which records no request). Cheap: the extra membership check runs only for the (rare) ids
   * with an outstanding request.
   */
  private inboxGroupIds(): string[] {
    const ids = [...this.joinedGroups];
    const pendingIds = Object.keys(this.myJoinRequests);
    if (pendingIds.length === 0 || !this.myPubkey) return ids;
    const me = this.myPubkey;
    return ids.filter(
      id => !this.myJoinRequests[id] || isGroupMemberOf(this.deps.store, id, me),
    );
  }

  /**
   * The viewer's relationship to a space, for the locked preview / embed CTA:
   * 'member' | 'pending' | 'none'. A silent DECLINE never surfaces — the relay clears the admins'
   * Pending entry but the local record keeps this reading 'pending', by design.
   */
  joinRequestStateFor(groupId: string): 'member' | 'pending' | 'none' {
    if (this.myPubkey && isGroupMemberOf(this.deps.store, groupId, this.myPubkey)) return 'member';
    return this.myJoinRequests[groupId] ? 'pending' : 'none';
  }

  /**
   * One-shot scoped fetch hydrating a locked preview for a space the viewer is NOT in: 39000
   * metadata (name/about/flags) + 39001/39002 (admin/member counts). Allowed for non-members —
   * the relay's private-group read gate ships dark; the spec's visibility contract ("non-members
   * see name/about/type/counts only") is what this feeds. Events land via the normal ingest gate.
   */
  previewSpace(groupId: string): void {
    if (this._previewFetched.has(groupId)) return;
    this._previewFetched.add(groupId);
    this.deps.fetchByFilter?.([
      {kinds: [GroupKind.Metadata, GroupKind.Admins, GroupKind.Members], '#d': [groupId]},
    ]);
  }

  /** What the locked preview renders (from cached state; call previewSpace() to hydrate). */
  getSpacePreview(groupId: string): {
    name: string;
    about?: string;
    kindWord: 'Private channel' | 'Group chat';
    memberCount: number;
    adminCount: number;
    gradient?: GradientSpec;
  } | null {
    const st = groupStateOf(this.deps.store, groupId);
    if (!st) return null;
    return {
      name: st.name,
      about: st.about,
      kindWord: st.broadcast ? 'Private channel' : 'Group chat',
      memberCount: groupMembersOf(this.deps.store, groupId).length,
      adminCount: groupAdminsOf(this.deps.store, groupId).length,
      gradient: st.gradient,
    };
  }

  /**
   * Request to join a space, with the optional "introduce yourself" note. The note (+ the
   * requester's display name) is NIP-44-sealed PER ADMIN into the 9021's content — 9021 is not a
   * scope-forced kind, so plaintext would be readable by any community member, and the spec
   * promises "only the admins see this". No admins resolvable and no note → bare 9021 (unchanged
   * wire). Records the local pending state that survives a silent decline.
   */
  async requestToJoin(groupId: string, note?: string): Promise<void> {
    if (!this.identity) return;
    const content = await this.sealJoinNoteFor(groupId, note?.trim() || undefined);
    const event = await this.identity.sign(buildGroupJoinRequest(groupId, content));
    await this.publishOptimistic(event);
    await this.trackGroup(groupId);
    this.myJoinRequests[groupId] = {sentAt: Math.floor(Date.now() / 1000)};
    await saveMyJoinRequests(this.myJoinRequests, this.activeSlotId);
    this.emit();
  }

  /** Withdraw an outstanding request (9022 clears the relay's Pending entry) — back to 'none'. */
  async withdrawJoinRequest(groupId: string): Promise<void> {
    if (!this.identity) return;
    const event = await this.identity.sign(buildGroupLeaveRequest(groupId));
    await this.publishOptimistic(event);
    delete this.myJoinRequests[groupId];
    await saveMyJoinRequests(this.myJoinRequests, this.activeSlotId);
    await this.untrackGroup(groupId);
    this.emit();
  }

  /** Seal `{name, note}` to each current admin (+ owner). '' when there is nothing to carry. */
  private async sealJoinNoteFor(groupId: string, note?: string): Promise<string> {
    if (!this.identity) return '';
    const myName = this.displayNames.getMyName();
    if (!note && !myName) return '';
    const recipients = new Set(groupAdminsOf(this.deps.store, groupId));
    const owner = groupStateOf(this.deps.store, groupId)?.owner;
    if (owner) recipients.add(owner);
    recipients.delete(this.myPubkey ?? '');
    if (recipients.size === 0) return '';
    const payload = encodeJoinNotePayload({n: myName || undefined, t: note});
    const seals: Record<string, string> = {};
    for (const pk of recipients) {
      try {
        seals[pk] = await this.identity.sealForPeer(pk, payload);
      } catch {
        // one unsealable admin (malformed pk) must not block the request
      }
    }
    return encodeJoinNoteContent(seals);
  }

  /**
   * The admin review queue for a space: the relay's authoritative 39004 pending set joined against
   * the latest raw 9021 per requester (sealed note + request time). Entries whose pubkey is in the
   * folded INVITED set are flagged so the UI routes them to the invited strip / auto-approve, not
   * the visible queue. Kicks async unsealing of any not-yet-decrypted notes (emit() on arrival).
   */
  getJoinRequestQueue(groupId: string): {
    pubkey: string;
    /** The raw 9021 event id, when one is cached — a stable id the notification center keys read
     *  state on. Absent only for a pending pubkey whose 9021 we never fetched (39004 lists it, but
     *  the raw request event hasn't landed on our scoped sub yet). */
    reqId?: string;
    at?: number;
    name?: string;
    note?: string;
    invited: boolean;
  }[] {
    let pending = groupPendingOf(this.deps.store, groupId);
    if (pending.length === 0) return [];
    // Optimistic overlay: an approve or deny still awaiting the relay's 39004 must drop from the
    // review queue at once. A terminally-rejected publish (rosterOverlayApplies=false) keeps the
    // entry, so a bounced approve/deny reverts the row back into the queue.
    const overlay = this._rosterOverlay.get(groupId);
    if (overlay) {
      pending = pending.filter(pk => {
        const entry = overlay.get(pk);
        if (!entry || !this.rosterOverlayApplies(entry)) return true;
        return entry.op !== 'approve' && entry.op !== 'deny';
      });
      if (pending.length === 0) return [];
    }
    const raw = latestJoinRequests(this.deps.store, groupId);
    const invited = new Set(this.getSpaceInvited(groupId).map(i => i.p));
    return pending.map(pk => {
      const ev = raw.get(pk);
      const unsealed = ev ? this.unsealJoinNote(ev) : undefined;
      return {
        pubkey: pk,
        reqId: ev?.id,
        at: ev?.created_at,
        name: unsealed?.n ?? this.displayNames.nameFor(pk) ?? undefined,
        note: unsealed?.t,
        invited: invited.has(pk) || (ev ? isInviteAccept(ev) : false),
      };
    });
  }

  /** My seal off a 9021, decrypted once per event id (async; emit() re-renders on completion). */
  private unsealJoinNote(ev: Event): JoinNotePayload | undefined {
    const cached = this._joinNoteCache.get(ev.id);
    if (cached !== undefined) return cached ?? undefined;
    const seals = parseJoinNoteContent(ev.content);
    const mine = this.myPubkey ? seals?.[this.myPubkey] : undefined;
    if (!seals || !mine || !this.identity) {
      this._joinNoteCache.set(ev.id, null);
      return undefined;
    }
    if (!this._joinNoteInflight.has(ev.id)) {
      this._joinNoteInflight.add(ev.id);
      void this.identity
        .openFromPeer(ev.pubkey, mine)
        .then(plain => this._joinNoteCache.set(ev.id, parseJoinNotePayload(plain)))
        .catch(() => this._joinNoteCache.set(ev.id, null))
        .finally(() => {
          this._joinNoteInflight.delete(ev.id);
          this.emit();
        });
    }
    return undefined;
  }

  /**
   * Invite people to a space — accept-first, never a direct add. Each recipient gets a normal
   * encrypted DM carrying the SOH-i invite frame (lifted into their inbox invitation card) plus a
   * readable fallback line + the self-contained space embed card; membership changes ONLY when
   * they accept (9021 an admin auto-approves). The outstanding invites are recorded in my
   * per-author `space-invites:` doc so every admin sees the Invited strip and can revoke.
   */
  async inviteToSpace(groupId: string, pubkeys: string[]): Promise<void> {
    if (!this.identity || pubkeys.length === 0) return;
    const st = groupStateOf(this.deps.store, groupId);
    const name = st?.name ?? 'a private space';
    const memberCount = groupMembersOf(this.deps.store, groupId).length;
    const base: InvitePayload = {
      g: groupId,
      n: st?.name,
      k: st?.broadcast ? 'channel' : 'group',
      m: memberCount || undefined,
    };
    const embed = encodeSpaceEmbed({
      kind: 39000,
      owner: st?.owner ?? this.myPubkey ?? '',
      identifier: groupId,
      name: st?.name,
      private: true,
      gradient: st?.gradient,
    });
    const at = Math.floor(Date.now() / 1000);
    // Only an ADMIN can mint a grant the relay will honor. A non-admin inviter (a member of a group
    // chat) sends a grantless invite — the accept then falls to the pending queue for an admin to
    // approve, exactly as before. Computed once; the per-recipient grant is signed inside the loop.
    const canGrant = !!this.myPubkey && isGroupAdminOf(this.deps.store, groupId, this.myPubkey);
    // Per-recipient DM sends run CONCURRENTLY, and the invites-doc publish (an unrelated resource
    // with no dependency on the DMs landing) rides alongside: the serial version stacked K×(PoW
    // mine + send jitter + Tor round-trip) before other admins' Invited strip even updated. Hermes
    // is single-threaded so the PoW CPU time is unchanged — the win is the wall-clock idle time
    // (jitter + network) overlapping across recipients. Each sendDM already renders its optimistic
    // echo + surfaces its own failure state, so per-recipient errors stay independently visible.
    const sends = pubkeys
      .filter(pk => pk !== this.myPubkey)
      .map(async pk => {
        let gr: string | undefined;
        if (canGrant) {
          try {
            const grant = await this.identity!.sign(buildInviteGrant(groupId, pk, at + INVITE_GRANT_TTL_SECS));
            gr = encodeInviteGrant(grant);
          } catch {
            // Best-effort: a failed grant just means this invitee's accept waits for an admin.
          }
        }
        const wire = encodeInvitePayload({...base, gr});
        await this.sendDM(pk, `You're invited to join "${name}" on Stiq.\n${embed}`, undefined, wire);
      });
    const doc = this.publishMyInvitesDoc(groupId, doc => {
      const fresh = pubkeys.filter(pk => pk !== this.myPubkey);
      const rest = doc.inv.filter(i => !fresh.includes(i.p));
      return {
        inv: [...rest, ...fresh.map(p => ({p, by: this.myPubkey ?? '', at}))],
        rev: doc.rev.filter(r => !fresh.includes(r.p)), // a re-invite supersedes my old revoke
      };
    });
    await Promise.all([...sends, doc]);
  }

  /** Revoke an outstanding invite (any admin may revoke any inviter's) — strip row's ✕. */
  async revokeSpaceInvite(groupId: string, pubkey: string): Promise<void> {
    await this.publishMyInvitesDoc(groupId, doc => ({
      inv: doc.inv.filter(i => i.p !== pubkey),
      rev: [...doc.rev.filter(r => r.p !== pubkey), {p: pubkey, at: Math.floor(Date.now() / 1000)}],
    }));
  }

  /**
   * The space's folded outstanding-invite set (the Invited strip): union of authorized authors'
   * docs, latest add per target minus newer revokes minus current members. Authorized = admins +
   * owner, plus every member for a non-broadcast group chat (the design's "anyone in a group chat
   * can add people").
   */
  getSpaceInvited(groupId: string): SpaceInvite[] {
    const docs: {author: string; doc: SpaceInvitesDoc}[] = [];
    const dTag = spaceInvitesDTag(groupId);
    const latestByAuthor = new Map<string, Event>();
    for (const ev of this.deps.store.query({kinds: [KIND_SPACE_INVITES]})) {
      if (!ev.tags.some(t => t[0] === 'd' && t[1] === dTag)) continue;
      const cur = latestByAuthor.get(ev.pubkey);
      if (!cur || ev.created_at > cur.created_at) latestByAuthor.set(ev.pubkey, ev);
    }
    for (const [author, ev] of latestByAuthor) {
      const plain = this.openInvitesDoc(groupId, ev);
      if (!plain) continue;
      const doc = parseInvitesDoc(plain);
      if (doc) docs.push({author, doc});
    }
    if (docs.length === 0) return [];
    const st = groupStateOf(this.deps.store, groupId);
    const members = groupMembersOf(this.deps.store, groupId);
    const authorized = new Set(groupAdminsOf(this.deps.store, groupId));
    if (st?.owner) authorized.add(st.owner);
    if (st && !st.broadcast) for (const m of members) authorized.add(m);
    return foldInvites(docs, authorized, members);
  }

  /** Decrypt (or pass through) one author's invites doc content. Null when unreadable. */
  private openInvitesDoc(groupId: string, ev: Event): string | null {
    const epoch = messageEpoch(ev);
    if (epoch === null) return ev.content || null;
    const key = this._spaceKeyCache.get(`${groupId}:${epoch}`);
    if (!key) return null;
    const cached = this._spacePlaintextCache.get(ev.id);
    if (cached !== undefined) return cached;
    try {
      const plain = decryptForSpace(ev.content, key);
      this._spacePlaintextCache.set(ev.id, plain);
      return plain;
    } catch {
      return null;
    }
  }

  /** Read-modify-publish MY per-author invites doc, sealed under the space's current epoch key
   *  when we hold one (members-only readable; the relay and non-members see ciphertext). */
  private async publishMyInvitesDoc(
    groupId: string,
    mutate: (doc: SpaceInvitesDoc) => SpaceInvitesDoc,
  ): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    let current: SpaceInvitesDoc = {inv: [], rev: []};
    const dTag = spaceInvitesDTag(groupId);
    let latest: Event | undefined;
    for (const ev of this.deps.store.query({kinds: [KIND_SPACE_INVITES]})) {
      if (ev.pubkey !== this.myPubkey) continue;
      if (!ev.tags.some(t => t[0] === 'd' && t[1] === dTag)) continue;
      if (!latest || ev.created_at > latest.created_at) latest = ev;
    }
    if (latest) {
      const plain = this.openInvitesDoc(groupId, latest);
      const parsed = plain ? parseInvitesDoc(plain) : null;
      if (parsed) current = parsed;
    }
    const next = mutate(current);
    const json = encodeInvitesDoc(next);
    // Same fail-closed rule as messages: a private space with no key must not publish the invitee
    // list in plaintext. (An admin always holds the key, so this only trips in broken states.)
    const {enc, blocked} = this.outgoingSeal(groupId);
    if (blocked) return;
    // Strictly-monotonic per-author timestamp: an invite + a revoke in the same wall-clock second
    // would otherwise tie on created_at and replaceable-latest readers could keep the OLDER doc
    // (the exact tie the relay's emitState clamps against for its own state events).
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1);
    const event = await this.identity.sign({
      kind: KIND_SPACE_INVITES,
      created_at: createdAt,
      tags: [
        ['d', dTag],
        ...(enc ? [['encrypted', 'nip44'], ['ke', String(enc.epoch)]] : []),
      ],
      content: enc ? encryptForSpace(json, enc.key) : json,
    });
    await this.publishOptimistic(event);
    this.emit();
  }

  /** Incoming invitation cards for the Channels inbox (dismissed + already-member filtered). */
  getIncomingInvites(): IncomingSpaceInvite[] {
    const out: IncomingSpaceInvite[] = [];
    for (const [gid, inv] of this.incomingInvites) {
      // Suppressed only while the dismissal covers THIS invite: a strictly newer invite (bigger
      // at — a deliberate re-invite after a leave/kick) re-surfaces the card.
      if ((this.dismissedInvites.get(gid) ?? -1) >= inv.at) continue;
      if (this.myPubkey && isGroupMemberOf(this.deps.store, gid, this.myPubkey)) continue;
      if (this.myJoinRequests[gid]) continue; // accepted already — pending an admin's auto-approve
      out.push({
        groupId: gid,
        name: inv.payload.n,
        kindWord: inv.payload.k === 'channel' ? 'Private channel' : 'Group chat',
        memberCount: inv.payload.m,
        inviter: inv.inviter,
        at: inv.at,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * Spaces the viewer has asked to join (accepted invite via {@link acceptSpaceInvite} or a manual
   * {@link requestToJoin}) but isn't a MEMBER of yet — drives a non-actionable "Joining…" row that
   * covers the gap between Accept and the relay's 39002 landing, during which the space is in
   * NEITHER `getIncomingInvites()` (accepted entries are filtered out of that list) nor the
   * members-only inbox (`inboxGroupIds` excludes a pending non-member). Name/kind prefer the
   * invite payload that produced this join (mirrors `getIncomingInvites`'s mapping); a manual
   * `requestToJoin` has no invite payload, so it falls back to cached relay state.
   */
  getJoiningSpaces(): JoiningSpace[] {
    const out: JoiningSpace[] = [];
    for (const gid of Object.keys(this.myJoinRequests)) {
      if (this.myPubkey && isGroupMemberOf(this.deps.store, gid, this.myPubkey)) continue;
      const inv = this.incomingInvites.get(gid)?.payload;
      if (inv) {
        out.push({groupId: gid, name: inv.n, kindWord: inv.k === 'channel' ? 'Private channel' : 'Group chat'});
        continue;
      }
      const st = groupStateOf(this.deps.store, gid);
      out.push({groupId: gid, name: st?.name, kindWord: st?.broadcast ? 'Private channel' : 'Group chat'});
    }
    return out;
  }

  /**
   * Accept an incoming invite: a 9021 marked `['invite']` (+ track the group). Any online admin's
   * client auto-approves it against the folded invited set; membership lands with the relay's
   * 39002 + the kind-30079 key delivery. Nothing was shared with the space before this moment.
   */
  async acceptSpaceInvite(groupId: string): Promise<void> {
    if (!this.identity) return;
    // Forward the inviting admin's grant (if the invite carried one) so the relay admits me to
    // membership immediately — no admin need be online. A grantless invite falls to the pending
    // queue for an admin's client to auto-approve, exactly as before.
    const grant = this.incomingInvites.get(groupId)?.payload.gr;
    const event = await this.identity.sign(buildGroupJoinRequest(groupId, '', true, grant));
    await this.publishOptimistic(event);
    await this.trackGroup(groupId);
    this.myJoinRequests[groupId] = {sentAt: Math.floor(Date.now() / 1000)};
    await saveMyJoinRequests(this.myJoinRequests, this.activeSlotId);
    this.emit();
  }

  /** "Not now": local-only dismissal — the space is never told, the DM stays in the thread.
   *  Records the dismissed invite's own `at`, so only invites up to this one stay hidden. */
  async dismissSpaceInvite(groupId: string): Promise<void> {
    const at = this.incomingInvites.get(groupId)?.at ?? Math.floor(Date.now() / 1000);
    this.dismissedInvites.set(groupId, Math.max(at, this.dismissedInvites.get(groupId) ?? 0));
    await saveDismissedInvites(Object.fromEntries(this.dismissedInvites), this.activeSlotId);
    this.emit();
  }

  /**
   * Auto-approve invited accepts: for a space I administer, approve any pending pubkey that is in
   * the folded invited set. Runs off 39004/9021 arrivals (handleIncomingEvent). The `_autoApproved`
   * guard stops the approve → 39004 re-emit → re-entry loop; approve itself is idempotent
   * relay-side, so two admins racing is harmless.
   */
  private autoApproveInvited(groupId: string): void {
    if (!this.myPubkey || !isGroupAdminOf(this.deps.store, groupId, this.myPubkey)) return;
    const pending = groupPendingOf(this.deps.store, groupId);
    if (pending.length === 0) return;
    const invited = new Set(this.getSpaceInvited(groupId).map(i => i.p));
    if (invited.size === 0) return;
    for (const pk of pending) {
      if (!invited.has(pk)) continue;
      const guard = `${groupId}:${pk}`;
      if (this._autoApproved.has(guard)) continue;
      this._autoApproved.add(guard);
      // Silent approve (overlayOp=null): a background sweep, not a user tap, so it must NOT stamp the
      // optimistic overlay — that would drop the invitee from getJoinRequestQueue, whereas the
      // invited-accept UX keeps them flagged invited:true in the strip until the relay's 39002 lands.
      void this.addGroupMember(groupId, pk, false, null);
    }
  }

  /** A 39002 arrival that lists ME fulfils my outstanding request for that space. */
  private reconcileMyJoinRequests(membersEvent: Event): void {
    const gid = stateGroupId(membersEvent);
    if (!gid || !this.myJoinRequests[gid] || !this.myPubkey) return;
    if (!isGroupMemberOf(this.deps.store, gid, this.myPubkey)) return;
    delete this.myJoinRequests[gid];
    void saveMyJoinRequests(this.myJoinRequests, this.activeSlotId);
    this.emit();
  }

  // ── Draft access control: "a key to enter" (Phase 5§D; see feed/draftAccess.ts's module doc) ──
  // Every `draftId` below is a Draft's stable `shareId` (feed/drafts.ts) — the id a shared
  // `stiq:draft:` embed carries — NOT the draft's local, per-device `id`. Modeled 1:1 on the
  // join-request flow just above (requestToJoin/getJoinRequestQueue/approveJoin/denyJoin/
  // joinRequestStateFor), reusing the SAME `Identity.sealForPeer`/`openFromPeer` primitive
  // `sealJoinNoteFor`/`unsealJoinNote` use, rather than inventing a parallel pattern.

  /**
   * Request access to someone else's shared draft — mirrors {@link requestToJoin}. `note`, when
   * given, becomes the requester's displayed name for this ask (falling back to my own display
   * name); `DraftAccessRequestPayload` carries only a name (no free-text note field — see
   * feed/draftAccess.ts), so there is nothing further to seal.
   *
   * Unlike a join request, nothing here needs its own persisted "I asked" bookkeeping the way
   * {@link requestToJoin} needs `myJoinRequests`: a NIP-29 join request needs one because a silent
   * decline actively CLEARS the relay's 39004 pending entry, so the requester must remember locally
   * in order to keep rendering 'pending' after that clear. A `DraftAccessRequest` has no such
   * relay-side list to diverge from — the request event itself, once durably saved by
   * `publishOptimistic`, IS the record {@link getDraftAccessState} and {@link getDraftAccessQueue}
   * both read "pending" off.
   */
  async requestDraftAccess(draftId: string, ownerPubkey: string, note?: string): Promise<void> {
    if (!this.identity) return;
    const name = note?.trim() || this.displayNames.getMyName() || undefined;
    const content = await this.identity.sealForPeer(ownerPubkey, encodeDraftAccessPayload({n: name}));
    const event = await this.identity.sign({
      kind: Kind.DraftAccessRequest,
      created_at: Math.floor(Date.now() / 1000),
      tags: buildDraftAccessRequestTags(draftId, ownerPubkey),
      content,
    });
    await this.publishOptimistic(event);
    this.emit();
  }

  /**
   * The owner's pending-request queue for one of THEIR OWN shared drafts — mirrors
   * {@link getJoinRequestQueue}: joins the raw `DraftAccessRequest` events addressed to me against
   * whichever of my own doc's actions (grant OR revoke) most recently touched that pubkey, plus my
   * local silent-deny record (see `denyDraftAccess`'s doc). A request drops out of the pending queue
   * once I've acted on it EITHER way — approved (they belong in {@link getDraftAccessGranted}
   * instead) or revoked (they belong in neither list — "revoked", not "asking") — unless a STRICTLY
   * NEWER request arrives after that action, which re-opens the question and surfaces them again.
   */
  getDraftAccessQueue(draftId: string): {
    pubkey: string;
    /** The raw request event id — a stable id a "Manage access" UI can key read state on. */
    reqId: string;
    at: number;
    name?: string;
  }[] {
    if (!this.myPubkey) return [];
    const raw = latestDraftAccessRequests(this.deps.store, draftId, this.myPubkey);
    if (raw.size === 0) return [];
    const lastActionAt = this.lastDraftAccessActionAt(this.myPubkey, draftId);
    const out: {pubkey: string; reqId: string; at: number; name?: string}[] = [];
    for (const [pk, ev] of raw) {
      const acted = lastActionAt.get(pk);
      if (acted !== undefined && acted >= ev.created_at) continue; // already granted or revoked since
      const deniedAt = this._draftAccessDenied[`${draftId}:${pk}`];
      if (deniedAt !== undefined && deniedAt >= ev.created_at) continue; // silently declined, not re-surfaced
      const unsealed = this.unsealDraftAccessNote(ev);
      out.push({pubkey: pk, reqId: ev.id, at: ev.created_at, name: unsealed?.n ?? this.displayNames.nameFor(pk) ?? undefined});
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * The owner's "Approved" list for one of THEIR OWN shared drafts — the folded grant set (latest
   * grant per pubkey, minus a same-or-later revoke), for a "Manage access" UI's revoke `✕` list
   * (mirrors `GroupView`'s Members-list revoke treatment, per the plan's Phase 5§F).
   */
  getDraftAccessGranted(draftId: string): {pubkey: string; at: number; name?: string}[] {
    if (!this.myPubkey) return [];
    return this.foldedDraftAccessGrants(this.myPubkey, draftId)
      .map(g => ({pubkey: g.p, at: g.at, name: this.displayNames.nameFor(g.p) ?? undefined}))
      .sort((a, b) => b.at - a.at);
  }

  /** Per-pubkey timestamp of the most recent action (grant OR revoke, whichever is newer) in MY
   *  `draft-access:<draftId>` doc — the single signal {@link getDraftAccessQueue} needs to tell "never
   *  yet decided" apart from "already decided, one way or the other". */
  private lastDraftAccessActionAt(ownerPubkey: string, draftId: string): Map<string, number> {
    const out = new Map<string, number>();
    const found = this.latestDraftAccessDoc(ownerPubkey, draftId);
    if (!found) return out;
    for (const g of found.doc.grants) {
      const cur = out.get(g.p);
      if (cur === undefined || g.at > cur) out.set(g.p, g.at);
    }
    for (const r of found.doc.revokes) {
      const cur = out.get(r.p);
      if (cur === undefined || r.at > cur) out.set(r.p, r.at);
    }
    return out;
  }

  /** My seal off a DraftAccessRequest, decrypted once per event id (async; emit() re-renders on
   *  completion) — mirrors {@link unsealJoinNote}. */
  private unsealDraftAccessNote(ev: Event): DraftAccessRequestPayload | undefined {
    const cached = this._draftAccessNoteCache.get(ev.id);
    if (cached !== undefined) return cached ?? undefined;
    if (!this.identity) {
      this._draftAccessNoteCache.set(ev.id, null);
      return undefined;
    }
    if (!this._draftAccessNoteInflight.has(ev.id)) {
      this._draftAccessNoteInflight.add(ev.id);
      void this.identity
        .openFromPeer(ev.pubkey, ev.content)
        .then(plain => this._draftAccessNoteCache.set(ev.id, parseDraftAccessPayload(plain)))
        .catch(() => this._draftAccessNoteCache.set(ev.id, null))
        .finally(() => {
          this._draftAccessNoteInflight.delete(ev.id);
          this.emit();
        });
    }
    return undefined;
  }

  /**
   * Approve a pending request for one of MY OWN shared drafts — mirrors
   * {@link approveJoin}/{@link addGroupMember}'s read-modify-publish + deliver shape: (1) add a
   * grant to my `draft-access:<draftId>` doc (mirrors {@link publishMyInvitesDoc}), (2) build the
   * CURRENT draft snapshot (from the live `Draft`, so a later edit + re-approve delivers the
   * update — the locked "edit propagation" decision) and publish it as a `DraftDelivery` sealed
   * directly to the requester. No-ops if `draftId` doesn't name one of my own current drafts.
   */
  async approveDraftAccess(draftId: string, requesterPubkey: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const draft = (await this.drafts.all()).find(d => d.shareId === draftId);
    if (!draft) return; // not (or no longer) mine — nothing to grant or deliver
    await this.publishMyDraftAccessDoc(draftId, doc => {
      const at = Math.floor(Date.now() / 1000);
      return {
        grants: [...doc.grants.filter(g => g.p !== requesterPubkey), {p: requesterPubkey, at}],
        revokes: doc.revokes.filter(r => r.p !== requesterPubkey), // a re-approve supersedes my own old revoke
      };
    });
    const snapshot: DraftDeliverySnapshot = {b: draft.content};
    if (draft.title) snapshot.ti = draft.title;
    if (draft.tags.length > 0) snapshot.tg = [...draft.tags];
    if (draft.label) snapshot.l = draft.label;
    if (draft.contentWarning) snapshot.cw = draft.contentWarning;
    await this.publishDraftDelivery(draftId, requesterPubkey, encodeDraftDeliverySnapshot(snapshot));
  }

  /**
   * Deny a pending request — mirrors {@link denyJoin}'s silent-decline posture, but even more so:
   * denyJoin still PUBLISHES a real 9001 that clears the relay's authoritative pending list; a
   * draft has no such list, so there is NOTHING that would ever tell the relay or the requester a
   * decision was made. This device only remembers not to keep re-surfacing the same request in
   * {@link getDraftAccessQueue} (see feed/draftAccess.ts's `loadDeniedDraftAccess` doc) — a
   * STRICTLY NEWER re-request surfaces again, mirroring the "Not now" invite-dismissal precedent.
   */
  async denyDraftAccess(draftId: string, requesterPubkey: string): Promise<void> {
    const key = `${draftId}:${requesterPubkey}`;
    const at = Math.floor(Date.now() / 1000);
    const prev = this._draftAccessDenied[key];
    if (prev === undefined || at > prev) {
      this._draftAccessDenied = {...this._draftAccessDenied, [key]: at};
      await saveDeniedDraftAccess(this._draftAccessDenied, this.activeSlotId);
      // No relay-visible event resulted from this — bump the dedicated counter
      // deriveNotifications() folds in, since storeVersionOf alone would never see this change.
      this._draftAccessDenyVersion++;
    }
    this.emit();
  }

  /**
   * Revoke a previously-granted draft access — mirrors {@link revokeSpaceInvite}: add a revoke
   * entry to my `draft-access:<draftId>` doc. FORWARD-ONLY, same posture as a group kick
   * (`rotateSpaceKey`'s doc comment): this cannot erase a snapshot the requester's client already
   * decrypted and may have cached — there is no key to rotate the way a live space's does. It also
   * republishes the `DraftDelivery` slot for this requester with a sealed TOMBSTONE plaintext (see
   * `DRAFT_DELIVERY_TOMBSTONE` — NIP-44 rejects a truly empty plaintext, so this is the closest
   * equivalent): since `DraftDelivery` is parameterized-replaceable, any FRESH read of "the latest
   * delivery for (draftId, requesterPubkey)" — {@link getMyDraftDelivery}, {@link
   * getDraftAccessState} — now resolves to nothing, which is what makes a revoke observable for
   * FUTURE checks at all. A requester who already fetched + decrypted the real snapshot before
   * this ran keeps whatever they already hold; comments they posted while they had access are
   * likewise not retroactively hidden (Phase 7§B) — forward-secrecy, not retroactive erasure,
   * exactly the posture already accepted for a group kick.
   */
  async revokeDraftAccess(draftId: string, requesterPubkey: string): Promise<void> {
    await this.publishMyDraftAccessDoc(draftId, doc => ({
      grants: doc.grants.filter(g => g.p !== requesterPubkey),
      revokes: [
        ...doc.revokes.filter(r => r.p !== requesterPubkey),
        {p: requesterPubkey, at: Math.floor(Date.now() / 1000)},
      ],
    }));
    await this.publishDraftDelivery(draftId, requesterPubkey, DRAFT_DELIVERY_TOMBSTONE);
  }

  /** Read-modify-publish MY `draft-access:<draftId>` doc — mirrors {@link publishMyInvitesDoc},
   *  minus the space-epoch sealing (a draft-access doc has no "space" to encrypt under; it is
   *  plain JSON, exactly the shape the plan specifies). */
  private async publishMyDraftAccessDoc(
    draftId: string,
    mutate: (doc: DraftAccessDoc) => DraftAccessDoc,
  ): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const found = this.latestDraftAccessDoc(this.myPubkey, draftId);
    const current: DraftAccessDoc = found?.doc ?? {grants: [], revokes: []};
    const next = mutate(current);
    // Strictly-monotonic per-author timestamp (mirrors publishMyInvitesDoc): a grant + a revoke in
    // the same wall-clock second would otherwise tie on created_at, and a replaceable-latest reader
    // could keep the OLDER doc.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (found?.event.created_at ?? 0) + 1);
    const event = await this.identity.sign({
      kind: KIND_DRAFT_ACCESS,
      created_at: createdAt,
      tags: [['d', draftAccessDTag(draftId)]],
      content: encodeDraftAccessDoc(next),
    });
    await this.publishOptimistic(event);
    this.emit();
  }

  /** The latest `draft-access:<draftId>` doc authored by `ownerPubkey`, or undefined when none is
   *  cached / none parses. Addressable events aren't guaranteed deduped in the local store, so
   *  (like {@link getSpaceInvited}/{@link publishMyInvitesDoc}) this picks the highest created_at
   *  by hand rather than assuming only one copy is ever cached. */
  private latestDraftAccessDoc(
    ownerPubkey: string,
    draftId: string,
  ): {doc: DraftAccessDoc; event: Event} | undefined {
    const dTag = draftAccessDTag(draftId);
    let latest: Event | undefined;
    for (const ev of this.deps.store.query({kinds: [KIND_DRAFT_ACCESS]})) {
      if (ev.pubkey !== ownerPubkey) continue;
      if (!ev.tags.some(t => t[0] === 'd' && t[1] === dTag)) continue;
      if (!latest || ev.created_at > latest.created_at) latest = ev;
    }
    if (!latest) return undefined;
    const doc = parseDraftAccessDoc(latest.content);
    return doc ? {doc, event: latest} : undefined;
  }

  /** The folded (latest-grant-wins-unless-revoked) grant set for one owner's draft — a thin
   *  single-author wrapper over {@link foldDraftAccess}. */
  private foldedDraftAccessGrants(ownerPubkey: string, draftId: string): DraftGrant[] {
    const found = this.latestDraftAccessDoc(ownerPubkey, draftId);
    if (!found) return [];
    return foldDraftAccess([{author: ownerPubkey, doc: found.doc}], new Set([ownerPubkey]));
  }

  /**
   * The inverse of {@link buildDraftDeliveryTags}/{@link draftDeliveryDTag}: recover `draftId` from
   * a `DraftDelivery` event's `d` tag, given the event is already known to be addressed to `me` (its
   * `p` tag). Used by {@link deriveNotifications}'s draft-access-granted block, which discovers
   * candidate draftIds by scanning ALL DraftDelivery events addressed to me rather than starting
   * from a known draftId — the direction none of the existing helpers above run. Exact prefix/suffix
   * match (not a naive split on ':') because both `draftId` and a pubkey are plain hex and could in
   * principle contain no ':' themselves, but matching the literal wrapping is simplest and safest.
   */
  private draftIdFromDeliveryTag(ev: Event, me: string): string | undefined {
    const d = ev.tags.find(t => t[0] === 'd')?.[1];
    if (!d || !d.startsWith(DRAFT_DELIVERY_D_PREFIX) || !d.endsWith(`:${me}`)) return undefined;
    const draftId = d.slice(DRAFT_DELIVERY_D_PREFIX.length, d.length - me.length - 1);
    return draftId || undefined;
  }

  /** The latest `DraftDelivery` event addressed to `requesterPubkey` for `draftId` — optionally
   *  scoped to a known `ownerPubkey` signer. Used from BOTH sides: a requester checking their own
   *  delivery (`requesterPubkey = me`) and an owner computing the next monotonic created_at when
   *  approving/revoking (`requesterPubkey = them`). */
  private latestDraftDeliveryEvent(
    draftId: string,
    requesterPubkey: string,
    ownerPubkey?: string,
  ): Event | undefined {
    const dTag = draftDeliveryDTag(draftId, requesterPubkey);
    let latest: Event | undefined;
    for (const ev of this.deps.store.query({kinds: [Kind.DraftDelivery]})) {
      if (!ev.tags.some(t => t[0] === 'd' && t[1] === dTag)) continue;
      if (ownerPubkey && ev.pubkey !== ownerPubkey) continue;
      if (!latest || ev.created_at > latest.created_at) latest = ev;
    }
    return latest;
  }

  /** Seal `plaintext` to `requesterPubkey` and publish it as the `DraftDelivery` for
   *  (draftId, requesterPubkey), strictly newer than whatever's already published there so
   *  "latest wins" always resolves to this call — the shared plumbing behind both a real
   *  approval (`plaintext` = the encoded snapshot) and a revoke's tombstone
   *  (`plaintext` = `DRAFT_DELIVERY_TOMBSTONE`). */
  private async publishDraftDelivery(draftId: string, requesterPubkey: string, plaintext: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const content = await this.identity.sealForPeer(requesterPubkey, plaintext);
    const prior = this.latestDraftDeliveryEvent(draftId, requesterPubkey, this.myPubkey);
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (prior?.created_at ?? 0) + 1);
    const event = await this.identity.sign({
      kind: Kind.DraftDelivery,
      created_at: createdAt,
      tags: buildDraftDeliveryTags(draftId, requesterPubkey),
      content,
    });
    await this.publishOptimistic(event);
  }

  /**
   * Who owns `draftId`, as far as THIS device can tell — derived from whichever local record
   * already names them: my own `DraftAccessRequest`'s `p` tag (durable — `publishOptimistic` saved
   * it already, so this survives a restart with no separate bookkeeping), or, failing that, the
   * signer of any `DraftDelivery` addressed to me for this draftId (only the true owner's seal
   * decrypts, but the SIGNER identity itself needs no decrypt to read). Undefined when neither
   * exists — I've never engaged with this draftId at all.
   */
  private draftAccessOwnerFor(draftId: string): string | undefined {
    if (!this.myPubkey) return undefined;
    for (const ev of this.deps.store.query({kinds: [Kind.DraftAccessRequest]})) {
      if (ev.pubkey !== this.myPubkey) continue;
      if (!ev.tags.some(t => t[0] === 'd' && t[1] === draftId)) continue;
      const owner = ev.tags.find(t => t[0] === 'p' && t[1])?.[1];
      if (owner) return owner;
    }
    const dTag = draftDeliveryDTag(draftId, this.myPubkey);
    for (const ev of this.deps.store.query({kinds: [Kind.DraftDelivery]})) {
      if (ev.tags.some(t => t[0] === 'd' && t[1] === dTag)) return ev.pubkey;
    }
    return undefined;
  }

  /**
   * Fetch + decrypt MY OWN `DraftDelivery` for `draftId` — the frozen snapshot an owner sealed to
   * me on approval. `ownerPubkey`, when supplied (e.g. from an already-parsed `DraftRef`), scopes
   * the lookup to a known signer; omitted, any delivery addressed to me under this draftId is
   * tried. Cached per draftId, keyed to the source event id, so a newer (or revoke-tombstoned)
   * delivery is never served from a stale decrypt (see `_draftDeliveryCache`'s field doc). Returns
   * `null` for "nothing valid to decrypt yet" — never distinguished from "not yet approved" vs
   * "revoked" here; {@link getDraftAccessState} is what tells those apart for the caller.
   *
   * A FRESH decrypt (a cache miss this call just filled) bumps {@link _draftDeliveryDecryptVersion}
   * and calls {@link emit} — mirrors {@link unsealDraftAccessNote}'s "cache then announce" contract.
   * Needed so `deriveNotifications()`'s draft-access-granted block (Phase 5§G), which fires this off
   * in the background on an uncached delivery and reads {@link _draftDeliveryCache} back
   * synchronously, doesn't stay stuck on a pre-decrypt derive forever once the decrypt lands.
   */
  async getMyDraftDelivery(draftId: string, ownerPubkey?: string): Promise<DraftDeliverySnapshot | null> {
    if (!this.identity || !this.myPubkey) return null;
    const latest = this.latestDraftDeliveryEvent(draftId, this.myPubkey, ownerPubkey);
    if (!latest) return null;
    const cached = this._draftDeliveryCache.get(draftId);
    if (cached && cached.eventId === latest.id) return cached.snapshot;
    try {
      const plain = await this.identity.openFromPeer(latest.pubkey, latest.content);
      const snapshot = parseDraftDeliverySnapshot(plain);
      this._draftDeliveryCache.set(draftId, {eventId: latest.id, snapshot});
      this._draftDeliveryDecryptVersion++;
      this.emit();
      return snapshot;
    } catch {
      this._draftDeliveryCache.set(draftId, {eventId: latest.id, snapshot: null});
      this._draftDeliveryDecryptVersion++;
      this.emit();
      return null;
    }
  }

  /**
   * My relationship to a shared draft — mirrors {@link joinRequestStateFor}'s state shape, but
   * ASYNC where that one is sync: resolving 'owner' consults the local (SecureStorage-backed)
   * DraftStore, and resolving 'approved' requires attempting a NIP-44 decrypt, both genuinely async
   * (unlike group membership, a plain synchronous EventStore tag scan).
   *
   *  - 'owner'    — `draftId` names one of my own current drafts (`this.drafts`).
   *  - 'approved' — a `DraftDelivery` addressed to me exists and decrypts to a real snapshot.
   *  - 'pending'  — no delivery yet, but I have an outstanding `DraftAccessRequest` for it.
   *  - 'none'     — neither of the above (including: a delivery exists but is a revoke's tombstone
   *                 and no longer decrypts to anything — see revokeDraftAccess).
   */
  async getDraftAccessState(draftId: string): Promise<'owner' | 'none' | 'pending' | 'approved'> {
    if ((await this.drafts.all()).some(d => d.shareId === draftId)) return 'owner';
    if (!this.myPubkey) return 'none';
    const ownerPubkey = this.draftAccessOwnerFor(draftId);
    if (!ownerPubkey) return 'none';
    if (this.latestDraftDeliveryEvent(draftId, this.myPubkey, ownerPubkey)) {
      const snapshot = await this.getMyDraftDelivery(draftId, ownerPubkey);
      return snapshot ? 'approved' : 'none';
    }
    return latestDraftAccessRequests(this.deps.store, draftId, ownerPubkey).has(this.myPubkey)
      ? 'pending'
      : 'none';
  }

  /**
   * Phase 7§A (runtime half): a draft's comment thread, keyed by its stable `shareId` — the id
   * every embedded copy of a shared draft carries, so the SAME thread resolves wherever it's
   * opened (the locked "one unified thread" decision). Thin wrapper: `buildThread` never validates
   * that its root id names a real, fetched post (comments.ts's root-id scan is a bare string
   * match), so this resolves correctly even for a draft that has never been published anywhere.
   */
  getDraftThread(shareId: string): CommentNode[] {
    return buildThread(this.deps.store, shareId);
  }

  /** Total comment count for a draft's thread (the reader's "COMMENTS N" row, Phase 6). */
  getDraftCommentCount(shareId: string): number {
    return countComments(this.getDraftThread(shareId));
  }

  /**
   * Whether GROUP's outgoing sends are currently blocked for lack of a space key — the exact
   * fail-closed condition `outgoingSeal` guards against. Drives the composer's proactive
   * "Unlocking this space…" banner so a member sees the reason before they even try to send,
   * rather than only after a `SPACE_KEY_UNAVAILABLE` throw.
   */
  isSpaceKeyMissing(groupId: string): boolean {
    return this.outgoingSeal(groupId).blocked === true;
  }

  /**
   * Send a chat message into a group (relay accepts it only from members). `replyTo` quotes a parent.
   *
   * Durable (T0.3): rendered as an optimistic placeholder BEFORE the sign, then queued on the shared
   * 'group' PendingWrite pipeline — mirrors postToChannel/PendingChannelWrite's doc: this write's own
   * bound-npub signature can spend a space-write token via the `identity` pre-sign hook once the relay
   * requires one, and that spend is a Tor-bound draw that can throw BlindTokensExhausted. Previously
   * this had NO placeholder and NO try/catch, so a drought threw uncaught with nothing on screen while
   * the draw ran and no failure state after (F3).
   *
   * The SPACE-KEY fail-closed check stays a synchronous PRE-check, unchanged: a locked private space
   * refuses before anything renders, exactly as before. That is a DIFFERENT failure (no key at all)
   * from a token drought, and intentionally is not durably retried here — the composer's existing
   * draft-restore already covers it (see GroupView/isSpaceKeyMissing).
   */
  async postToGroup(groupId: string, content: string, replyTo?: string): Promise<void> {
    if (!this.identity) return;
    // FAIL-CLOSED: a private space with no key blocks the send rather than leaking plaintext. Throws
    // (rather than a silent no-op) so the composer can show a visible failure AND restore the draft
    // instead of the message vanishing with zero feedback. Checked BEFORE the intent exists — see
    // this method's doc for why this stays a pre-check rather than joining the durable catch below.
    if (this.outgoingSeal(groupId).blocked) throw new Error('SPACE_KEY_UNAVAILABLE');
    const intent: PendingGroupWrite = {
      type: 'group',
      id: this.localComposeId(),
      groupId,
      replyTo,
      content,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    await this.queuePendingWrite(intent);
  }

  /** Author edit of one of your group messages — position-preserving (folds over the original at read
   *  time). Durable (T0.3) via the 'groupEdit' PendingWrite variant — see postToGroup's doc. */
  async editGroupMessage(groupId: string, originalId: string, content: string): Promise<void> {
    if (!this.identity) return;
    if (this.outgoingSeal(groupId).blocked) throw new Error('SPACE_KEY_UNAVAILABLE'); // fail-closed
    const intent: PendingGroupEditWrite = {
      type: 'groupEdit',
      id: this.localComposeId(),
      groupId,
      originalId,
      content,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    await this.queuePendingWrite(intent);
  }

  /** Send a threaded reply (kind 12) to a parent message in a group. Durable (T0.3) via the
   *  'groupReply' PendingWrite variant — see postToGroup's doc. */
  async replyToGroupMessage(groupId: string, parentId: string, content: string): Promise<void> {
    if (!this.identity) return;
    if (this.outgoingSeal(groupId).blocked) throw new Error('SPACE_KEY_UNAVAILABLE'); // fail-closed
    const intent: PendingGroupReplyWrite = {
      type: 'groupReply',
      id: this.localComposeId(),
      groupId,
      parentId,
      content,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    await this.queuePendingWrite(intent);
  }

  /** Pending join requests for a group (admins act on these). */
  getGroupPending(groupId: string): string[] {
    return groupPendingOf(this.deps.store, groupId);
  }

  /** Threaded replies (kind 12) for a group, keyed by parent message id; decrypted for private spaces. */
  getGroupReplies(groupId: string): Map<string, Event[]> {
    const byParent = groupRepliesByParent(this.deps.store, groupId);
    // Decrypt-on-read for a space we treat as encrypted (relay 39000 private OR locally marked):
    // replace each sealed reply's content with plaintext and HIDE anything undecryptable (never render
    // ciphertext), mirroring getGroupMessages. Public/broadcast groups are untouched (plaintext).
    if (!(this.isPrivateSpace(groupId) || isEncryptedSpace(groupId))) return byParent;
    const decrypted = new Map<string, Event[]>();
    for (const [parentId, replies] of byParent) {
      const visible = this.decryptSpaceMessages(replies, groupId);
      if (visible.length > 0) decrypted.set(parentId, visible);
    }
    return decrypted;
  }

  /** Group metadata from cached relay state. */
  getGroupState(groupId: string): GroupState | null {
    return groupStateOf(this.deps.store, groupId);
  }

  // ── Optimistic roster overlay (see {@link _rosterOverlay}) ──────────────────────────────────

  /** Record the latest admin-action intent for a pubkey in a group so the UI getters reflect it at
   *  once. Keyed by pubkey — a newer op for the same member replaces any older one. */
  private stampRosterOverlay(groupId: string, pubkey: string, op: RosterOp, eventId: string): void {
    let byPk = this._rosterOverlay.get(groupId);
    if (!byPk) this._rosterOverlay.set(groupId, (byPk = new Map()));
    byPk.set(pubkey, {op, eventId, at: Date.now()});
  }

  /**
   * Whether an overlay entry should still be applied by the getters. It applies unless its publish
   * is TERMINALLY 'rejected' (the relay's OK frame said no — the instant-revert path). A non-terminal
   * 'failed' (ambiguous timeout, auto-retried) KEEPS applying, matching the message-bubble send-status
   * convention; a missing status (still in flight / already confirmed-and-swept) also applies.
   */
  private rosterOverlayApplies(entry: RosterOverlayEntry): boolean {
    return this.outbox.statuses().get(entry.eventId) !== 'rejected';
  }

  /**
   * Outcome of the most recent admin roster action (promote/demote/kick/approve/deny) taken on
   * `pubkey` in `groupId` this session — straight off the outbox, the SAME signal a message bubble's
   * "sending…/failed" ring reads (see `sendStatus`/`sendReasons`). `getJoinRequestQueue` already
   * reverts a terminally-rejected approve/deny back into the live queue on its own (rosterOverlayApplies),
   * but a UI that separately remembers "I already resolved this row" (GroupView's `resolvedReqs`)
   * needs its OWN signal to know a resolution it rendered didn't actually stick — otherwise a bounced
   * approve keeps showing a false "✓ Approved" forever, silently recreating this exact incident.
   * Undefined once no admin action has been taken on this pubkey this session, or after the overlay
   * entry is reconciled away (the relay confirmed it) or GC'd (see `ROSTER_OVERLAY_TTL_MS`).
   */
  getRosterActionStatus(groupId: string, pubkey: string): {status?: SendStatus; reason?: string} | undefined {
    const entry = this._rosterOverlay.get(groupId)?.get(pubkey);
    if (!entry) return undefined;
    return {status: this.outbox.statuses().get(entry.eventId), reason: this.outbox.reasons().get(entry.eventId)};
  }

  /**
   * Reconcile a group's overlay against fresh relay state (called from handleIncomingEvent on an
   * incoming 39001/39002/39004): drop each entry whose semantic outcome the relay now reflects, plus
   * opportunistic GC of entries older than {@link ROSTER_OVERLAY_TTL_MS}. No emit needed — the state
   * event's own save→emit re-renders. Reads relay-confirmed truth ONLY (never the overlaid getters).
   */
  private reconcileRosterOverlay(groupId: string): void {
    const overlay = this._rosterOverlay.get(groupId);
    if (!overlay) return;
    const admins = new Set(groupAdminsOf(this.deps.store, groupId));
    const members = new Set(groupMembersOf(this.deps.store, groupId));
    const pending = new Set(groupPendingOf(this.deps.store, groupId));
    const now = Date.now();
    for (const [pk, entry] of overlay) {
      let reflected = false;
      switch (entry.op) {
        case 'promote': reflected = admins.has(pk); break;
        case 'demote': reflected = !admins.has(pk); break;
        case 'kick': reflected = !members.has(pk); break;
        case 'approve': reflected = members.has(pk); break;
        case 'deny': reflected = !pending.has(pk); break;
      }
      if (reflected || now - entry.at > ROSTER_OVERLAY_TTL_MS) overlay.delete(pk);
    }
    if (overlay.size === 0) this._rosterOverlay.delete(groupId);
  }

  /** Member pubkeys of a group (relay's latest 39002, with the optimistic roster overlay applied). */
  getGroupMembers(groupId: string): string[] {
    const base = groupMembersOf(this.deps.store, groupId);
    const overlay = this._rosterOverlay.get(groupId);
    if (!overlay) return base;
    const set = new Set(base);
    for (const [pk, entry] of overlay) {
      if (!this.rosterOverlayApplies(entry)) continue;
      if (entry.op === 'kick') set.delete(pk);
      else if (entry.op === 'approve') set.add(pk);
    }
    return [...set];
  }

  /** Admin pubkeys of a group (relay's latest 39001, with the optimistic roster overlay applied). */
  getGroupAdmins(groupId: string): string[] {
    const base = groupAdminsOf(this.deps.store, groupId);
    const overlay = this._rosterOverlay.get(groupId);
    if (!overlay) return base;
    const set = new Set(base);
    for (const [pk, entry] of overlay) {
      if (!this.rosterOverlayApplies(entry)) continue;
      if (entry.op === 'promote') set.add(pk);
      else if (entry.op === 'demote') set.delete(pk);
    }
    return [...set];
  }

  /** Whether the current user is an admin of the group. */
  isGroupAdmin(groupId: string): boolean {
    return this.myPubkey ? groupAdminsOf(this.deps.store, groupId).includes(this.myPubkey) : false;
  }

  /** Whether the current user is the owner of the group. */
  isGroupOwner(groupId: string): boolean {
    return this.myPubkey ? isGroupOwnerOf(this.deps.store, groupId, this.myPubkey) : false;
  }

  /** Group chat messages (kind 9), oldest first, minus moderator hides; decrypted for private spaces. */
  getGroupMessages(groupId: string): Event[] {
    // Version-cache the derived, hidden-filtered list (edit-folding + moderator hides + space
    // auto-moderation) on the kinds it reads: chat (9), moderator/space reports (1984), mute lists
    // (10000), space settings (30078); plus roster identity (moderatorHides is roster-gated). The
    // decrypt step below is version-independent (it reads only the message ciphertext) and is itself
    // cached per event id in _spacePlaintextCache (finding #4), so a private space decrypts each
    // message at most once per session even though this pre-decrypt list is re-derived on version bumps.
    const moderators = this.moderatorNpubs();
    const ver = this.storeVersionOf([GroupKind.Chat, Kind.Report, Kind.MuteList, Kind.AppData]);
    const modKey = this.moderatorsKeyOf(moderators);
    const cacheKey = `${groupId}\0${modKey}`;
    const cached = ver !== undefined ? this._groupMsgCache.get(cacheKey) : undefined;
    let visible: Event[];
    if (cached && cached.ver === ver) {
      visible = cached.visible;
    } else {
      const msgs = groupChatMessagesOf(this.deps.store, groupId);
      // Honour the organizer-rooted moderator roster: a message a community moderator hid (or whose
      // author they muted) must not render in a group/broadcast view.
      const hides = moderatorHides(this.deps.store, moderators);
      // Plus the space's own admin-set content rules (client-side auto-remove → space mod log).
      const auto = spaceAutoHidden(this.deps.store, msgs, this.spaceAutoCfg(groupId, 'group'));
      visible = msgs.filter(m => !isModeratorHidden(m, hides) && !auto.has(m.id));
      if (ver !== undefined) this._groupMsgCache.set(cacheKey, {ver, visible});
    }
    // Then decrypt-on-read for a space we treat as encrypted (relay 39000 private OR locally marked):
    // replace each encrypted message's content with plaintext and HIDE anything undecryptable.
    // Public/broadcast groups are untouched (plaintext pass-through).
    return this.isPrivateSpace(groupId) || isEncryptedSpace(groupId)
      ? this.decryptSpaceMessages(visible, groupId)
      : visible;
  }

  /** Open a group's scoped relay subscription (chat + state) while its view is on screen. */
  openGroup(groupId: string): void {
    // Track BEFORE subscribing (mirror of openChannel): if the relay is null/mid-reconnect right
    // now, the subscribe call below is a silent no-op, and the next onRelaySubscribed's
    // resubscribeGroups() is what actually opens it — but only if the id is in a tracked set.
    this.openGroups.add(groupId);
    this.deps.subscribeGroup?.(groupId);
    // Pull this space's E2E keys into the in-memory cache (so its messages decrypt on render), then
    // give the invited-accept auto-approve sweep another chance — see sweepInvitedAfterKeys's doc for
    // why simply opening the group must be able to heal a stranded invited+pending member.
    this.sweepInvitedAfterKeys(groupId);
  }

  /**
   * Re-run {@link autoApproveInvited} for a group once its E2E key (if it needs one) is available,
   * so an invited+pending member the arrival-triggered sweep missed still gets promoted (M32 field
   * fix). `autoApproveInvited` itself already reads live pending/invited state straight from the
   * local store — never from the event that triggered it — so simply calling it again here is enough
   * to heal an already-ingested 9021, with no need to wait for (or fabricate) a fresh arrival.
   *
   * The gap this closes: for a PRIVATE space, `getSpaceInvited` can't decrypt the invited-set doc
   * until the space's key is in `_spaceKeyCache`, which is populated only by `hydrateSpaceKeys` —
   * itself fired only from `openGroup`/here. A pending+invited 9021 arriving in connect-time backfill
   * (before the admin ever opens the group) reaches the arrival-triggered sweep with the key still
   * missing, sees an empty invited set, bails, and — since nothing else re-triggers it — is never
   * retried. Called from `openGroup` (an admin opening the group) and `resubscribeGroups` (a
   * reconnect refreshing the group list), the two "give it another chance" moments the fix needs.
   */
  private sweepInvitedAfterKeys(groupId: string): void {
    // Relay-independent, same condition hydrateSpaceKeys itself is gated on: a public space's
    // invited doc is plaintext (no key needed), so the sweep can run immediately, synchronously.
    if (this.isPrivateSpace(groupId) || isEncryptedSpace(groupId)) {
      void this.hydrateSpaceKeys(groupId).then(() => {
        this.autoApproveInvited(groupId);
        // AFTER hydration (so the keystore has had its say): if this member still holds no usable
        // key, ask the space's admins to re-deliver — the "private space looks empty forever"
        // self-heal. See maybeRequestSpaceKeyRedelivery.
        void this.maybeRequestSpaceKeyRedelivery(groupId);
      });
    } else {
      this.autoApproveInvited(groupId);
    }
  }

  /** Close a group's scoped subscription. */
  closeGroup(groupId: string): void {
    // Admins of a CLOSED space keep its pending/state (and chat) subscription live even after
    // leaving the screen, so the requests badge + join-request notifications stay current without
    // waiting for the next reconnect's resubscribeGroups(). Bounded to the few closed groups you run.
    // The id stays in openGroups too, so a reconnect keeps that deliberately-live sub alive.
    if (this.isGroupAdmin(groupId) && groupStateOf(this.deps.store, groupId)?.closed) return;
    this.openGroups.delete(groupId);
    this.deps.unsubscribeGroup?.(groupId);
  }

  /**
   * Open a channel's scoped kind-1311 subscription while its view is on screen — the channel mirror
   * of {@link openGroup} (bug 8; config's SCOPED_CHANNEL_SYNC gates the dep, so this is a no-op with
   * the flag off).
   *
   * This is what keeps DISCOVERY working once 1311 leaves the firehose. The standing `channels` sub
   * only carries channels the member is already IN, so a channel reached from a member's profile, a
   * `stiq:space:` embed, or a deep link is not covered by it — without this its view would open
   * permanently empty and the Follow button would sit above a blank page. It also gives an opened
   * channel a proper history page rather than whatever slice of the standing sub's shared `limit`
   * happened to land on it.
   */
  openChannel(channelId: string): void {
    this.openChannels.add(channelId);
    this.deps.subscribeChannelChat?.(channelId);
  }

  /** Close a channel's scoped subscription. Mirror of {@link closeGroup}. */
  closeChannel(channelId: string): void {
    this.openChannels.delete(channelId);
    this.deps.unsubscribeChannelChat?.(channelId);
  }

  /**
   * The channel coordinates the member is a part of — followed, owned, or administered. The REAL
   * values the plan's scoped `channels` sub hides inside its decoy cover set; wired into
   * createFeedAndDmPlan as `getJoinedChannelIds` (App.tsx).
   *
   * NOT {@link subscribedChannelSet}: that answers "does the UI show Following?" and must not treat
   * an admin as a follower. See channels/subscriptions.ts's channelSyncIds for the full split.
   */
  channelSyncSet(): string[] {
    return channelSyncIds(this.deps.store, this.myPubkey, this.listChannels());
  }

  /**
   * Every channel coordinate this device knows exists (from the cached kind-30311 definitions, which
   * stay on the firehose). The DECOY CANDIDATE universe for the scoped `channels` sub; wired into
   * createFeedAndDmPlan as `getKnownChannelIds` (App.tsx).
   */
  knownChannelIds(): string[] {
    return this.listChannels().map(ch => ch.id);
  }

  /**
   * Decrypt cached gift wraps into conversations (plaintext stays in memory). The heavy work — a
   * pure-JS ECDH-per-wrap unwrap on the single Hermes thread — is CHUNKED and yields the event loop
   * between chunks (finding #1), and each chunk re-emits so conversations stream in rather than the
   * app freezing on a large historical backlog. A repeat sender's inner-seal key is derived once via
   * the persistent conversation-key cache (finding #2). Wraps that will never decrypt for us (decoy /
   * not-addressed-to-us) are recorded in a persisted negative cache and pruned from the store once
   * they age past the NIP-59 backdating window (findings #3/#4).
   */
  async refreshInbox(urgent = false): Promise<void> {
    if (!this.identity || !this.enrolled) {
      this.inbox = [];
      return;
    }
    const cache = (this.convKeyCache ??= this.identity.newConversationKeyCache());
    // Only decrypt wraps we haven't seen before — decryption is the expensive step, and wraps are
    // immutable, so a wrap decrypted once never needs re-decrypting. seenWrapIds is seeded with the
    // persisted negative cache on load, so known-alien decoys are skipped without any ECDH.
    const wraps = this.deps.store.query({kinds: [Kind.GiftWrap]});
    const fresh = wraps.filter(w => !this.seenWrapIds.has(w.id));
    if (fresh.length > 0) {
      // Rebuild + emit as chunks land, so a large backlog materialises progressively (finding #1).
      const onChunk = (soFar: DirectMessage[]): void => {
        this.ingestDecrypted(soFar);
        this.rebuildInboxFromCache();
        this.emitDeferred();
      };
      const {messages, failedIds} = await this.identity.readInbox(fresh, cache, onChunk);
      // Mark every fresh wrap seen — including undecryptable ones — so we never attempt them again.
      for (const w of fresh) this.seenWrapIds.add(w.id);
      this.ingestDecrypted(messages);
      // Delete-on-arrival: a blocked peer's newly-received DMs are removed from the store + cache
      // (their pre-block history is left untouched, just hidden). Runs after ingest so it also
      // evicts any that a progressive onChunk already cached.
      this.dropBlockedArrivals(messages);
      // Persist the undecryptable ids (finding #4) and prune those aged past the backdating window
      // (finding #3). Both operate on public wrap ids only — no plaintext leaves memory.
      if (failedIds.length > 0) {
        for (const id of failedIds) this.failedWrapIds.add(id);
        this.saveFailedWraps();
      }
      this.pruneStaleWraps();
    }
    this.rebuildInboxFromCache();
    // A user's own DM action (send / react / status-flip) passes urgent=true so its optimistic echo
    // renders on the NEXT frame — the same synchronous emit() path publishOptimistic() uses for feed/
    // group writes. The default (false) keeps relay/backlog-driven refreshes on the throttled
    // emitDeferred() cadence they were designed for. See sendDM/reactToDM/syncDmEcho.
    if (urgent) this.emit();
    else this.emitDeferred();
  }

  /**
   * Fold a batch of freshly-decrypted messages into {@link decryptedWraps}, stripping each relay-blind
   * identity header (display name + gradient) and learning it once. Idempotent per wrap id, so a
   * progressive `onChunk` batch and the final batch can overlap without double-processing.
   *
   * Bumps `_identityVersion` when a sender's learned name/gradient actually changes — a DM is never a
   * feed-kind event, so a peer's identity learned only from their DMs would otherwise never propagate
   * to how their existing feed posts render (see learnNameFromContent for the same reasoning).
   */
  private ingestDecrypted(messages: DirectMessage[]): void {
    for (const m of messages) {
      if (this.decryptedWraps.has(m.id)) continue;
      const wire = decodeGradientHeader(m.text);
      // Space-invite frame (membership handoff): lift the payload BEFORE decodeNameHeader strips
      // every leading frame off m.text below. Newest invite per space wins; the DM itself keeps
      // rendering as normal text + embed card in the thread.
      const inviteWire = decodeInviteHeader(m.text);
      if (inviteWire && m.sender !== this.myPubkey) {
        const inv = parseInvitePayload(inviteWire);
        if (inv) {
          const cur = this.incomingInvites.get(inv.g);
          if (!cur || m.createdAt > cur.at) {
            this.incomingInvites.set(inv.g, {payload: inv, inviter: m.sender, at: m.createdAt});
          }
        }
      }
      // Event control frame (application rail): lift + fold BEFORE decodeNameHeader strips it.
      // Routing is by role: a frame about an event I host folds into the host-side queue; a frame
      // FROM an event's host about my own application updates my RSVP record. My own outgoing
      // frames never round-trip (we can't read our own wraps) — sender-side state is set directly
      // by the action methods, so a self-sent frame here is ignored defensively.
      const evtWire = decodeEventFrameHeader(m.text);
      if (evtWire && m.sender !== this.myPubkey) {
        const frame = parseEventFrame(evtWire);
        if (frame) this.ingestEventFrame(frame, m.sender, m.createdAt);
      }
      const {name, text} = decodeNameHeader(m.text);
      const prevGrad = wire ? this.gradients.gradientFor(m.sender) : undefined;
      const prevName = name ? this.displayNames.nameFor(m.sender) : undefined;
      if (wire) void this.gradients.learn(m.sender, wire, m.createdAt);
      if (name) void this.displayNames.learn(m.sender, name);
      if (
        (wire && !gradientSpecEqual(this.gradients.gradientFor(m.sender), prevGrad)) ||
        (name && this.displayNames.nameFor(m.sender) !== prevName)
      ) {
        this._identityVersion++;
      }
      m.text = text;
      this.decryptedWraps.set(m.id, m);
    }
  }

  /** Rebuild {@link inbox} from the decrypted-wrap cache + local sent echoes + DM reactions. */
  private rebuildInboxFromCache(): void {
    const all = [...this.decryptedWraps.values()];
    // Reactions (inner kind-7) are folded onto their target message, not rendered as messages.
    const chat = all.filter(m => !m.reaction);
    const reactions: DmReactionRecord[] = [];
    for (const m of all) {
      if (m.reaction) reactions.push({sender: m.sender, targetRumorId: m.reaction.targetRumorId, emoji: m.reaction.emoji});
    }
    // My own reactions never round-trip to me (I don't receive my own wraps) — add them optimistically.
    const me = this.myPubkey ?? '';
    for (const r of this.myDmReactions) reactions.push({sender: me, targetRumorId: r.targetRumorId, emoji: r.emoji});
    this.inbox = attachDmReactions(
      this.mergeSent(buildConversations(chat, peer => this.effectiveDmBlocked(peer))),
      reactions,
      me,
    );
  }

  /**
   * Delete-on-arrival for blocked peers: drop freshly-decrypted DMs from an effectively-blocked
   * sender out of the store and the decrypt cache, so a blocked peer's NEW messages never persist.
   * Only messages received after the block instant are deleted ({@link dmBlockSince}); anything
   * older is the user's kept history, left in place so unblocking restores it. Reactions from a
   * blocked sender are dropped the same way. No-op when the store can't remove (in-memory fake).
   */
  private dropBlockedArrivals(messages: DirectMessage[]): void {
    const remove = this.deps.store.remove;
    if (!remove) return;
    for (const m of messages) {
      if (!this.effectiveDmBlocked(m.sender)) continue;
      const since = this.dmBlockSince(m.sender);
      if (since === undefined || m.createdAt < since) continue; // pre-block history — keep + hide
      remove.call(this.deps.store, m.id);
      this.decryptedWraps.delete(m.id);
      // The id stays in seenWrapIds (already marked) so it's never re-decrypted; it's gone from the
      // store regardless, so it won't be re-queried.
    }
  }

  /**
   * Remove gift wraps that (a) we have proven undecryptable-for-us and (b) are older than the NIP-59
   * backdating window plus a safety margin, from the event store (finding #3). Keys never rotate, so
   * an undecryptable wrap is permanently alien; deleting the aged ones caps the unbounded decoy /
   * foreign-ciphertext growth that every inbox refresh and the persisted cache otherwise keep paying
   * for. We NEVER prune a wrap newer than the backdating window (a genuine wrap could still be
   * back-dated within it), and we drop the pruned ids from the negative cache since the store no
   * longer holds them.
   */
  private pruneStaleWraps(): void {
    if (this.failedWrapIds.size === 0 || !this.deps.store.remove) return;
    // NIP-59 back-dates created_at up to 2 days; require an extra day of margin before we treat an
    // undecryptable wrap as safely prunable.
    const cutoff = Math.floor(Date.now() / 1000) - (DM_WRAP_PRUNE_AGE_SECONDS);
    let pruned = false;
    for (const id of this.failedWrapIds) {
      const wrap = this.deps.store.getById(id);
      if (!wrap) {
        // Already gone from the store — stop tracking it.
        this.failedWrapIds.delete(id);
        pruned = true;
        continue;
      }
      if (wrap.created_at <= cutoff) {
        this.deps.store.remove(id);
        this.failedWrapIds.delete(id);
        this.seenWrapIds.delete(id); // it's gone; if it ever re-arrives it can be re-attempted
        pruned = true;
      }
    }
    if (pruned) this.saveFailedWraps();
  }

  /**
   * Coalescing scheduler for relay-driven inbox refreshes. A burst of gift-wrap events (relay
   * replay, DM sync) each calls this instead of refreshInbox directly. Multiple calls within
   * RELAY_EMIT_THROTTLE_MS collapse into one refreshInbox — the seenWrapIds decrypt cache means
   * that one consolidated call processes ALL pending wraps at once (not just the last one).
   *
   * User-initiated paths (sendDM calls refreshInbox directly) are unaffected — they bypass
   * this scheduler and always get an immediate, unconditional refresh.
   */
  private scheduleRefreshInbox(): void {
    if (this._refreshInboxTimer !== undefined) return; // already pending — coalesce
    this._refreshInboxTimer = setTimeout(() => {
      this._refreshInboxTimer = undefined;
      void this.refreshInbox();
    }, AppRuntime.RELAY_EMIT_THROTTLE_MS);
  }

  /**
   * Fold our locally-echoed sent messages into the received conversations, keyed by recipient.
   * Each peer's messages are re-sorted oldest-first so sent + received interleave correctly.
   */
  private mergeSent(received: Conversation[]): Conversation[] {
    if (this.sentByPeer.size === 0) return received;
    const byPeer = new Map<string, Conversation>();
    for (const c of received) byPeer.set(c.peer, {...c, messages: [...c.messages]});
    for (const [peer, sent] of this.sentByPeer) {
      const existing = byPeer.get(peer);
      if (existing) {
        existing.messages.push(...sent);
      } else {
        byPeer.set(peer, {
          peer,
          peerNpub: nip19.npubEncode(peer),
          messages: [...sent],
          lastAt: 0,
          preview: '',
        });
      }
    }
    const merged = [...byPeer.values()];
    for (const c of merged) {
      c.messages.sort((a, b) => a.createdAt - b.createdAt);
      const last = c.messages[c.messages.length - 1];
      c.lastAt = last?.createdAt ?? 0;
      c.preview = last?.text ?? '';
    }
    merged.sort((a, b) => b.lastAt - a.lastAt);
    return merged;
  }

  /**
   * Seal a DM, mine its proof-of-work, and echo it into our own conversation with a live send
   * status. The message shows immediately (status 'sending' / ·). Its gift wrap is then queued in
   * the shared outbox and delivered in the background: it flips to 'sent' (✓) on relay OK, stays
   * queued (·) — NOT failed — while the relay is still offline (auto-resending on reconnect), and
   * only shows 'failed' (✕) on a genuine relay rejection or a sealing error.
   */
  async sendDM(
    peerPubkey: string,
    text: string,
    replyTo?: string,
    inviteWire?: string,
    eventFrameWire?: string,
  ): Promise<void> {
    if (!this.identity) {
      return;
    }
    // Optimistic local echo — we can't read our own outgoing wrap back, so track it ourselves.
    const localEchoId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const echo: DirectMessage = {
      id: localEchoId,
      // Keeps the bubble's React key stable when `echo.id` adopts the real wrap id below —
      // the thread keys on `localId ?? id`, so the just-sent row never remounts mid-send.
      localId: localEchoId,
      rumorId: '', // filled from the seal below, so a reaction to my own message can target it
      sender: this.myPubkey ?? '',
      text,
      createdAt: Math.floor(Date.now() / 1000),
      status: 'sending',
      ...(replyTo ? {replyTo} : {}),
      ...(inviteWire ? {inviteWire} : {}), // kept so a Retry re-sends the invite grant, not bare text
    };
    const bucket = this.sentByPeer.get(peerPubkey);
    if (bucket) bucket.push(echo);
    else this.sentByPeer.set(peerPubkey, [echo]);
    // Debounced persist (finding #5): the three writes in one send burst (this optimistic echo, the
    // wrap-id adoption below, and the delivery-status flip in syncDmEcho) coalesce into ONE keystore
    // write. dispose()/switch/duress flush it; the outbox independently persists the wrap itself.
    this.saveSentMessages();
    await this.refreshInbox(true); // show it right away (urgent: synchronous emit, no throttle)

    let wrap: Event;
    try {
      // Embed our identity (display name + gradient, if set) inside the encrypted DM — relay-blind.
      // A space invite additionally leads with its SOH-i frame (membership handoff): the recipient's
      // client lifts it into the inbox invitation card; every text renderer strips it like the
      // identity headers, so the visible message is just `text` (fallback line + embed card).
      // An event control frame (application rail) leads the body the same way — every renderer
      // strips it via parseHeaders; the recipient's client lifts it in ingestDecrypted.
      const framed0 = eventFrameWire ? encodeEventFrameHeader(text, eventFrameWire) : text;
      const framed = inviteWire ? encodeInviteHeader(framed0, inviteWire) : framed0;
      const body = encodeIdentityHeader(framed, this.displayNames.getMyName(), this.gradients.myWire());
      // Capability-driven DM PoW (C4): mine to the relay's advertised dm_pow (caps fallback = DM_POW_DIFFICULTY).
      const sealed = await this.identity.sealDM(peerPubkey, body, replyTo, this._relayCaps.dmPow, this.dmTokenAttach); // mines PoW (can take a while)
      wrap = sealed.wrap;
      echo.rumorId = sealed.rumorId;
    } catch (err) {
      // Sealing / PoW mining / token draw failed before the message ever reached the relay — a
      // genuine failure (there is no wrap to queue), surfaced as ✕ WITH a reason and a Retry (the
      // thread's DmBubble reads failureReason). NOT the offline-relay case handled below. The common
      // trigger is space-token exhaustion once space_tokens_required is on (spendSpaceTokens throws).
      echo.status = 'failed';
      // exhaustionReason: a token-drought DM says WHY (keys re-syncing vs connection) with the same
      // calm-message guarantee; every other error keeps its own message as before.
      echo.failureReason = err instanceof Error ? this.exhaustionReason(err) : 'Something went wrong — please try again.';
      this.saveSentMessages();
      await this.refreshInbox(true);
      return;
    }
    // Adopt the real gift-wrap id so the outbox entry and the echo share a key, then route the wrap
    // through the SAME outbox as optimistic posts. This keeps the DM QUEUED ('sending' / ·) when the
    // relay isn't up yet and auto-resends it on reconnect (onRelayConnected → resendUnsent), instead
    // of the old fire-once publish that flashed 'failed' (✕) the instant Tor wasn't ready — a DM
    // never retried because, unlike a post, the DM thread has no manual Retry button. deliver()
    // drives the echo's final status through syncDmEcho().
    this.deps.store.save(wrap); // optimistic local copy; dedupes if the relay ever echoes it back
    echo.id = wrap.id;
    this.saveSentMessages();
    await this.outbox.add(wrap);
    await this.deliver(wrap);
    this.accountPictures(text);
  }

  /**
   * React to a DM message (by its shared rumor id) with an emoji — a NIP-17 gift-wrapped kind-7 to
   * the peer, PoW-mined like a message. Shown optimistically; the peer sees it after delivery.
   *
   * On failure (T4.3) the optimistic reaction is rolled back AND the error is RE-THROWN — a DM
   * reaction has no draft/Retry to preserve (unlike a message), but it must not vanish with zero
   * feedback either. Previously this swallowed the error silently: the tap would revert with no
   * explanation, the one reaction path Phase 0 left that way while channel/group reactions (via
   * signOptimisticWrite) already surfaced theirs. Rethrowing routes it through the SAME caller
   * (App.tsx's runWrite) every other reaction/vote failure uses, for the same calm one-shot Alert —
   * consistent treatment, not a bespoke silent one.
   */
  async reactToDM(peerPubkey: string, targetRumorId: string, emoji: string): Promise<void> {
    const e = emoji.trim();
    if (!this.identity || !targetRumorId || !e) return;
    // One reaction per (message, emoji) from me. I never receive my own wraps back, so record it
    // locally for optimistic display.
    if (this.myDmReactions.some(r => r.targetRumorId === targetRumorId && r.emoji === e)) return;
    this.myDmReactions.push({targetRumorId, emoji: e});
    await this.saveDmReactions();
    await this.refreshInbox(true);
    try {
      const wrap = await this.identity.sealDmReaction(peerPubkey, targetRumorId, e, this._relayCaps.dmPow, this.dmTokenAttach); // mines PoW (C4 capability-driven)
      this.deps.store.save(wrap);
      await this.outbox.add(wrap);
      await this.deliver(wrap);
    } catch (err) {
      // Seal/mine/token-draw failed before reaching the relay — roll back the optimistic reaction,
      // then surface it (see doc above) rather than swallowing it.
      const i = this.myDmReactions.findIndex(r => r.targetRumorId === targetRumorId && r.emoji === e);
      if (i >= 0) this.myDmReactions.splice(i, 1);
      await this.saveDmReactions();
      await this.refreshInbox(true);
      throw err;
    }
  }

  /**
   * Mirror a gift wrap's outbox delivery outcome onto its sent-DM echo. DMs route their wraps
   * through the shared outbox (offline-queue + retry-on-reconnect), but the DM thread renders from
   * the separate `sentByPeer` echo, so deliver() calls this to keep the two in lock-step. No-op for
   * non-DM events — posts/votes/comments render straight from the outbox `sendStatus` map.
   */
  private async syncDmEcho(event: Event, status: DirectMessage['status'], reason?: string): Promise<void> {
    if (event.kind !== Kind.GiftWrap) return;
    const echo = this.findSentEcho(event.id);
    if (!echo || (echo.status === status && echo.failureReason === reason)) return;
    echo.status = status;
    echo.failureReason = reason; // carries a relay reject reason; clears (undefined) once 'sent'
    this.saveSentMessages();
    await this.refreshInbox(true);
  }

  /** Locate a sent-DM echo by its (adopted) gift-wrap id across all peer buckets. */
  private findSentEcho(wrapId: string): DirectMessage | undefined {
    for (const msgs of this.sentByPeer.values()) {
      const echo = msgs.find(m => m.id === wrapId);
      if (echo) return echo;
    }
    return undefined;
  }

  /**
   * Retry a failed ('✕') DM from the thread's Retry affordance. Two cases, mirroring how sendDM
   * failed: if the wrap made it into the outbox (seal succeeded, the relay rejected or the publish
   * timed out), re-deliver it through the SAME generic path posts use ({@link retry} → outbox
   * eventFor → deliver), which drives the echo status via syncDmEcho. If nothing was queued (a
   * PRE-relay seal/PoW/token failure — the common space-token-exhaustion case), drop the stale
   * placeholder and re-run the full seal+send with the original payload, including any space-invite
   * wire so the retried invite still carries its grant. `peer` is required because an outgoing echo's
   * `sender` is MY pubkey, not the recipient — the peer isn't recoverable from the echo alone.
   */
  async retryDm(peer: string, echoId: string): Promise<void> {
    const echo = this.findSentEcho(echoId);
    if (!echo || echo.status !== 'failed') return;
    if (this.outbox.eventFor(echoId)) {
      await this.retry(echoId);
      return;
    }
    const {text, replyTo, inviteWire} = echo;
    this.removeSentEcho(echoId);
    await this.sendDM(peer, text, replyTo, inviteWire);
  }

  /** Drop a sent-DM echo (by id) from whichever peer bucket holds it — used by retryDm before a
   *  pre-relay re-send so the thread doesn't show a duplicate. Mirrors findSentEcho's cross-bucket scan. */
  private removeSentEcho(echoId: string): void {
    for (const msgs of this.sentByPeer.values()) {
      const i = msgs.findIndex(m => m.id === echoId);
      if (i >= 0) {
        msgs.splice(i, 1);
        return;
      }
    }
  }

  subscribe(listener: (snapshot: AppSnapshot, urgent: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot(), true);
    return () => this.listeners.delete(listener);
  }

  /** The active community's relay ws URL, or `fallback` when nothing is enrolled yet. */
  async activeRelayUrl(fallback: string): Promise<string> {
    return this.communities ? this.communities.activeRelayUrl(fallback) : fallback;
  }

  /** All enrolled communities + which one is active — for the Settings community switcher. */
  async getCommunities(): Promise<{list: EnrolledCommunity[]; activeId: string | null}> {
    if (!this.communities) return {list: [], activeId: null};
    const [list, activeId] = await Promise.all([
      this.communities.list(),
      this.communities.activeId(),
    ]);
    return {list, activeId};
  }

  /**
   * Switch the active community. A community can hold MULTIPLE accounts (identity slots), so this
   * restores the LAST account used in that community (persisted per-community, see resolveSlotForCid)
   * rather than an arbitrary first match, then activates that workspace — a complete silo swap of
   * identity, event store, name/gradient, DMs, groups, wallet, and caches. The host reconnects the
   * relay to the new community's onion afterwards (see activateWorkspace).
   */
  async switchCommunity(id: string): Promise<void> {
    const slots = (await this.keyRing?.listSlots()) ?? [];
    const slot = await this.resolveSlotForCid(id, slots);
    await this.activateWorkspace(id, slot?.id);
  }

  // ── per-community last-active account (slot) map ────────────────────────────────────────────────
  // Persisted device-global index cid → slotId, so switchCommunity(cid) reopens the account the user
  // last used there instead of a first-match slot. NOT siloed (it's an index, holds no secret).

  /** Read the persisted cid→slotId map (best-effort; {} on any error / no storage). */
  private async readCommunitySlotMap(): Promise<Record<string, string>> {
    const s = this.deps.secureStorage;
    if (!s) return {};
    try {
      const raw = await s.getItem(COMMUNITY_ACTIVE_SLOT_MAP);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async writeCommunitySlotMap(map: Record<string, string>): Promise<void> {
    try {
      await this.deps.secureStorage?.setItem(COMMUNITY_ACTIVE_SLOT_MAP, JSON.stringify(map));
    } catch {
      // best effort — a missing map just falls back to first-match slot selection
    }
  }

  /** Remember `slotId` as the account last active in community `cid`. */
  private async rememberActiveSlot(cid: string, slotId: string): Promise<void> {
    const map = await this.readCommunitySlotMap();
    if (map[cid] === slotId) return;
    map[cid] = slotId;
    await this.writeCommunitySlotMap(map);
  }

  /** Drop the map entry for a community (leaving it entirely). */
  private async forgetCommunityActiveSlot(cid: string): Promise<void> {
    const map = await this.readCommunitySlotMap();
    if (!(cid in map)) return;
    delete map[cid];
    await this.writeCommunitySlotMap(map);
  }

  /** Drop any map entry pointing at a removed slot (so a stale pointer never resurrects a wiped account). */
  private async forgetSlotEverywhere(slotId: string): Promise<void> {
    const map = await this.readCommunitySlotMap();
    let changed = false;
    for (const cid of Object.keys(map)) {
      if (map[cid] === slotId) {
        delete map[cid];
        changed = true;
      }
    }
    if (changed) await this.writeCommunitySlotMap(map);
  }

  /**
   * The account (slot) to activate for community `cid`: its remembered last-active slot when that
   * slot still exists in the community, else the first slot in the community, else undefined. `slots`
   * is passed in so callers can filter out slots being removed.
   */
  private async resolveSlotForCid(cid: string, slots: KeySlot[]): Promise<KeySlot | undefined> {
    const cidSlots = slots.filter(s => communityId(s.relayUrl) === cid);
    if (cidSlots.length === 0) return undefined;
    const remembered = (await this.readCommunitySlotMap())[cid];
    return cidSlots.find(s => s.id === remembered) ?? cidSlots[0];
  }

  /** All identities in the key ring + which slot is active — for the Settings identity switcher. */
  async listKeySlots(): Promise<{slots: KeySlot[]; activeId: string | null}> {
    if (!this.keyRing) return {slots: [], activeId: null};
    const [slots, activeId] = await Promise.all([
      this.keyRing.listSlots(),
      this.keyRing.getActiveSlotId(),
    ]);
    return {slots, activeId};
  }

  /**
   * Switch the active identity (key-ring slot). A slot is bound 1:1 to a community, so this is the
   * same operation as switchCommunity viewed from the identity side — it activates the slot's
   * workspace (its community id is the slot's relay onion).
   */
  async switchIdentity(slotId: string): Promise<void> {
    if (!this.keyRing) {
      throw new Error('secure storage unavailable; cannot switch identity on this build');
    }
    const slots = await this.keyRing.listSlots();
    const slot = slots.find(s => s.id === slotId);
    if (!slot) {
      throw new Error(`no key-ring slot ${slotId}`);
    }
    await this.activateWorkspace(communityId(slot.relayUrl), slotId);
  }

  /**
   * Activate a community+identity workspace — the complete silo swap that makes a switch change
   * EVERYTHING (npub, name, gradient, feed, channels, DMs) with no bleed from the outgoing
   * community. Ordered teardown → swap → rebuild:
   *
   *   1. FREEZE: gate reads/writes (`switching`), tear the relay down (via the host) so no in-flight
   *      relay write lands in the incoming store or gets signed with the new npub, and flush the
   *      outgoing workspace's dirty in-memory DM state under its CURRENT namespace.
   *   2. SWAP: move the persisted active pointers (slot + community, in lockstep), repoint the
   *      in-memory namespace, rebind the Identity to the new slot's key, clear all version-keyed and
   *      DM caches, and swap the event store to the new community's own encrypted DB.
   *   3. REBUILD: reload every per-community store under the new namespace, re-decrypt the new
   *      store's DM inbox, emit a fresh snapshot. The host then reconnects the relay to the new
   *      community's onion (its subscription plan reads the now-current pubkey/organizer).
   */
  private async activateWorkspace(cid: string, slotId: string | undefined): Promise<void> {
    if (this.switching) return; // ignore re-entrant switches (e.g. a double-tap in the switcher)
    this.switching = true;
    // Captured right after clearSwitchCaches() bumps `_switchWarmGen` below — see its doc comment.
    // Declared outside the try so the post-try emit guard (bottom of this method) can still read it.
    let switchWarmGen = this._switchWarmGen;
    try {
      // 1. FREEZE — close the live relay first, then FLUSH the outgoing DM echoes/reactions + negative
      // cache (force the debounced writes out before we swap the active-slot storage keys underneath).
      await this.deps.onRelayTeardown?.();
      // Drop the OUTGOING relay's advertised capabilities: they described a DIFFERENT relay and must
      // not be applied to the incoming community (e.g. a stale purpose-key fingerprint would spuriously
      // flag the new community as mis-provisioned, or an old weight-pricing rate would misprice its
      // posts). Back to the constant fallback until the new relay's onRelayConnected re-negotiates.
      // The sticky enforcement record is per-community too: drop it with the caps (the incoming
      // community's own persisted flags reload in loadWorkspaceState below, closing the gap long
      // before its relay connects).
      this._relayCaps = defaultRelayCapabilities();
      this._stickyEnforced = {};
      setBytesPerToken(this._relayCaps.enforcedFlags.bytesPerToken);
      await this.flushSentMessages();
      await this.flushFailedWraps();
      await this.saveDmReactions();
      if (this.displayNames) await this.displayNames.flush();
      if (this.gradients) await this.gradients.flush();

      // 2. SWAP — persisted pointers (both, to hold the slot↔community invariant), then in-memory.
      if (slotId) await this.keyRing?.setActiveSlot(slotId);
      if (slotId) await this.rememberActiveSlot(cid, slotId); // this account is now cid's last-active
      await this.communities?.setActive(cid);
      this.activeSlotId = slotId;
      this.activeCid = cid;
      this.rebuildIdentity();
      this.clearSwitchCaches();
      switchWarmGen = this._switchWarmGen; // the bump clearSwitchCaches() just made
      await this.swapActiveStore();

      // 3. REBUILD — hydrate the new workspace exactly as a cold start would, then rebuild the inbox.
      // The historical decrypt is kicked off NON-BLOCKING (finding #1): it chunks + yields + re-emits,
      // so the switch completes and the new community renders without waiting on the full DM backlog.
      await this.loadWorkspaceState();
      if (this.enrolled) {
        this._inboxReady = this.refreshInbox();
        void this._inboxReady;
      }
      // P1-3/A3: chunk-warm the new store's structural buckets (PREWARM_KINDS) BEFORE the switch's
      // first emit, spread across yielding macrotasks (warmSwitchKindsChunked). Without this, the
      // first post-switch getSnapshot() → buildFeed() cold-warmed Post/Comment/Report/MuteList via
      // the un-chunked warmKind(): a single synchronous SELECT + JSON.parse of up to
      // TIMELINE_RETENTION rows PER KIND, landing inside the emit() below.
      await this.warmSwitchKindsChunked(switchWarmGen);
    } finally {
      this.switching = false;
    }
    // Skip the emit if a newer switch or a teardown superseded us mid-warm (see _switchWarmGen) —
    // that supersedeing path already emitted its own, more current state; ours would be stale.
    if (this._switchWarmGen === switchWarmGen) this.emit();
  }

  /**
   * Drop every in-memory cache that is scoped to the outgoing community, so nothing renders from it
   * after a switch. Version-keyed caches (feed/channels/space keys) are cleared so they recompute
   * against the new store; DM caches are cleared and then repopulated from the new slot's persisted
   * keys by loadWorkspaceState()/refreshInbox().
   */
  private clearSwitchCaches(): void {
    this._feedCache = undefined;
    this._channelsCache = undefined;
    this._identityVersion = 0;
    this._notifCache = undefined;
    // The "new since" pill's mark is one community's createdAt timeline — comparing it against the
    // incoming community's would report nonsense (e.g. every post there reading as "new"). A switch
    // starts the pill fresh instead; see _feedSeenMark's doc.
    this._feedSeenMark = undefined;
    this._newFeedCountCache = undefined;
    // Rebuild the incoming (cold) community posts-first too: reset the score latch and drop any
    // pending scored pass so the switch's first feed build skips the new store's kind-7 warm.
    this._feedScored = false;
    this._scorePassScheduled = false;
    if (this._scorePassTimer !== undefined) {
      clearTimeout(this._scorePassTimer);
      this._scorePassTimer = undefined;
    }
    // Bump the generation so an in-flight reaction-bucket warm or chunked item-cache warm
    // (warmScoredFeedChunked) from the OUTGOING community notices it's stale on its next continue
    // check and stops — it must never flip _feedScored/emit against the store just swapped in above.
    this._scorePassGen++;
    // P1-3/A3: same bump, same reason — stop an in-flight community-switch structural warm
    // (warmSwitchKindsChunked) from an OUTGOING switch too; see _switchWarmGen's doc comment.
    this._switchWarmGen++;
    // Snapshot-scoped derived-value caches (findings #10/#11/#12/#13). The SwappableEventStore's
    // version base advances on swap so version keys can never collide across communities, but we drop
    // these anyway so no stale object survives the switch (matching _feedCache/_channelsCache).
    this._rosterCache = undefined;
    this._overlayCache = undefined;
    this._hidesCache = undefined;
    this._overlayIdCache = undefined;
    this._bannedCache = undefined;
    this._limitsCache = undefined;
    this._permsCache = undefined;
    this._communityConfigCache = undefined;
    this._logPageDocCache = undefined;
    this._governanceCache = undefined;
    this._modLimitsCache = undefined;
    this._bookmarksCache = undefined;
    this._subsCache = undefined;
    this._scoreCache = undefined;
    this._channelMsgCache.clear();
    this._groupMsgCache.clear();
    this._profileCache.clear(); // no stale posts/ideaCount/name/gradient from the outgoing community
    this._identityCache.clear();
    clearItemCache();
    this._spaceKeyCache.clear();
    this._spaceEpoch.clear();
    this._spaceMemberSnapshot.clear(); // per-space member snapshot is per-community (leave-rekey)
    this._rotatedOut.clear();
    this._rosterOverlay.clear(); // session-only optimistic admin-action intents never survive a switch
    this._spacePlaintextCache.clear(); // drop decrypted private-space plaintext with the space keys
    this._spaceKeyDeliveryMeta.clear();
    this._scopedSubsSynced.clear(); // the incoming community's spaces haven't replayed history yet
    this.uploadedMedia.clear();
    // Drop the OUTGOING community/account's optimistic compose placeholders (purge from its store) +
    // its in-memory recovery queue: a switch discards them exactly as a restart would. The PERSISTED
    // per-account recovery queue is LEFT on disk (rehydrated when that account is next active). This is
    // the PRIMARY guard against re-publishing A's content into B; the per-intent (cid, slotId) filter
    // in signPendingWrite/drainPendingPosts is defense-in-depth for a drain racing this clear.
    this.clearComposePlaceholders();
    this.requestedNaddrs.clear();
    this.sentByPeer.clear();
    this.myDmReactions.length = 0;
    this.decryptedWraps.clear();
    this.seenWrapIds.clear();
    // Membership-handoff per-slot state: requests/dismissals are re-hydrated for the new slot by
    // loadWorkspaceState; the derived/secret-adjacent caches must never survive a switch.
    this.myJoinRequests = {};
    this.dismissedInvites = new Map();
    this._deliveredKeyTo = new Map();
    this.incomingInvites.clear();
    this._joinNoteCache.clear();
    this._joinNoteInflight.clear();
    this._autoApproved.clear();
    this._previewFetched.clear();
    // Per-identity DM caches: dropped here, then re-seeded for the new slot by loadWorkspaceState
    // (loadFailedWraps + a fresh conversation-key cache). Never let one identity's keys/negative-set
    // survive into another.
    this.failedWrapIds.clear();
    this._failedWrapsDirty = false;
    this.convKeyCache?.clear();
    this.convKeyCache = undefined;
    this.inbox = [];
  }

  /**
   * Leave a community: activate a remaining one (or reset to un-enrolled), then WIPE the left
   * community's on-device data. Leaving a community leaves it for EVERY account enrolled in it, so
   * this removes ALL of that community's identity slots (not just the first) plus each slot's
   * per-account residue, and finally the shared per-community stores (the encrypted event-cache DB).
   * Iterating every slot is what stops a sibling account from being orphaned (its key left behind
   * while its community + DB are gone). Irreversible: the npubs are gone, so rejoining makes fresh
   * identities. (User-confirmed "wipe everything on leave".)
   */
  async removeCommunity(id: string): Promise<void> {
    if (!this.communities || !this.keyRing) return;
    const slots = await this.keyRing.listSlots();
    const cidSlots = slots.filter(s => communityId(s.relayUrl) === id);
    const wasActive = (await this.communities.activeId()) === id;

    // Switch away FIRST if we're leaving the active community, so the runtime is never pointed at a
    // half-deleted workspace. Pick any other community (never a slot being removed); if none remain,
    // drop to the un-enrolled state.
    if (wasActive) {
      const others = (await this.communities.list()).filter(c => c.id !== id);
      const next = others[0];
      if (next) {
        const nextSlot = await this.resolveSlotForCid(
          next.id,
          slots.filter(s => communityId(s.relayUrl) !== id),
        );
        await this.activateWorkspace(next.id, nextSlot?.id);
      } else {
        await this.deps.onRelayTeardown?.();
        this.activeSlotId = undefined;
        this.activeCid = undefined;
        this.rebuildIdentity();
        this.clearSwitchCaches();
        this.enrolled = false;
        this.myPubkey = undefined;
        this.emit();
      }
    }

    // Now delete the left community's data. Remove the community entry, then EACH of its accounts'
    // slots + per-account residue + per-account event store, then the orphaned legacy per-cid store.
    const storage = this.deps.secureStorage;
    await this.communities.remove(id);
    await this.forgetCommunityActiveSlot(id);
    for (const s of cidSlots) {
      await this.keyRing.removeSlot(s.id); // secret key + credential + relay
      await this.wipePerSlotState(s.id); // wallet/outbox/groups/spaces/DMs/pending-compose/… per account
      await this.forgetSlotEverywhere(s.id);
      // This account's OWN per-(cid, slot) event store (finding #4 — each account has its own): the
      // encrypted DB + SQLCipher key, its durable feed-state snapshot (T16-S3), and the non-sqlite
      // fallback cache blob. Iterating every slot is what stops a sibling account's cache orphaning.
      if (storage) {
        await wipeEncryptedCache(storage, id, s.id);
        await clearFeedSnapshot(storage, id, s.id);
        await this.removeSecureBestEffort(eventsCacheKey(id, s.id));
      }
    }
    if (storage) {
      // Drop the ORPHANED pre-per-account per-cid store + its snapshot too, so a removed community
      // leaves no cached ciphertext / high-water trace (feedSnapshot.ts wipe-path note: the snapshot
      // must be enumerated by removeCommunity + the duress targets alongside the event cache).
      await wipeLegacyCidStore(storage, id); // SQLCipher op-sqlite file + key
      await this.removeSecureBestEffort(eventsCacheKey(id)); // no-slot SecureStorage fallback blob
      await clearFeedSnapshot(storage, id);
    }
  }

  /** Best-effort single secure-storage key removal (never throws) — shared by the leave/wipe paths. */
  private async removeSecureBestEffort(key: string): Promise<void> {
    try {
      await this.deps.secureStorage?.removeItem(key);
    } catch {
      // best effort — keep wiping the rest
    }
  }

  /**
   * Leave a single IDENTITY (key-ring slot). A member can hold more than one identity in the same
   * community (e.g. joined twice with different invites), so leaving is per-identity, not per
   * community: wipe just this slot's secret key + credential. Only when it was the LAST identity for
   * its community do we also drop the community entry + its shared event-cache DB. If the removed
   * slot was active, switch to another identity first (preferring one in the same community) or drop
   * to the un-enrolled state when none remain. Irreversible.
   */
  async removeIdentity(slotId: string): Promise<void> {
    if (!this.communities || !this.keyRing) return;
    const slots = await this.keyRing.listSlots();
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return;
    const cid = communityId(slot.relayUrl);
    const wasActive = (await this.keyRing.getActiveSlotId()) === slotId;
    const siblingsSameCid = slots.filter(s => s.id !== slotId && communityId(s.relayUrl) === cid);
    const othersAny = slots.filter(s => s.id !== slotId);

    // Switch away FIRST if this identity is active, so we never sit on a half-deleted workspace.
    // Prefer another identity in the SAME community (its store/community entry survive), else any.
    if (wasActive) {
      const next = siblingsSameCid[0] ?? othersAny[0];
      if (next) {
        await this.activateWorkspace(communityId(next.relayUrl), next.id);
      } else {
        await this.deps.onRelayTeardown?.();
        this.activeSlotId = undefined;
        this.activeCid = undefined;
        this.rebuildIdentity();
        this.clearSwitchCaches();
        this.enrolled = false;
        this.myPubkey = undefined;
        this.emit();
      }
    }

    // Wipe this identity's secret key + credential, then its per-account residue (wallet, outbox,
    // joined-groups/encrypted-spaces + their space keys, DM caches, drafts, self name/gradient,
    // picture-spend, pending-compose queue). A sibling account in the same community keeps its own —
    // this is per-account.
    await this.keyRing.removeSlot(slotId);
    await this.wipePerSlotState(slotId);
    await this.forgetSlotEverywhere(slotId);
    const storage = this.deps.secureStorage;
    // This account's OWN per-(cid, slot) event store (finding #4): the encrypted DB + SQLCipher key,
    // its feed snapshot, and the fallback cache blob — wiped on EVERY removal, since each account now
    // has its own file (a sibling account in the same community keeps its own, separate store).
    if (storage) {
      await wipeEncryptedCache(storage, cid, slotId);
      await clearFeedSnapshot(storage, cid, slotId);
      await this.removeSecureBestEffort(eventsCacheKey(cid, slotId));
    }
    // Only when no other identity uses this community do we also drop the community entry + the
    // orphaned legacy per-cid store (+ its snapshot).
    if (siblingsSameCid.length === 0) {
      await this.communities.remove(cid);
      await this.forgetCommunityActiveSlot(cid);
      if (storage) {
        await wipeLegacyCidStore(storage, cid);
        await clearFeedSnapshot(storage, cid);
      }
    }
  }

  /**
   * Wipe one account's (identity slot's) per-account residue — everything namespaced by the slot that
   * KeyRing.removeSlot does NOT already clear (it wipes only the signing key + credential + relay).
   * Used by both leave paths (removeCommunity / removeIdentity). Best-effort per key so one failure
   * can't strand the rest; a sibling account in the same community is untouched (per-account keys).
   */
  private async wipePerSlotState(slotId: string): Promise<void> {
    const storage = this.deps.secureStorage;
    if (!storage) return;
    const rm = async (key: string): Promise<void> => {
      try {
        await storage.removeItem(key);
      } catch {
        /* best effort */
      }
    };
    const rmAsync = async (key: string): Promise<void> => {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        /* best effort */
      }
    };
    // Private-space E2E keys FIRST — read the slot's space-id sets (joined groups ∪ encrypted spaces)
    // before dropping those sets, since SecureStorage can't be enumerated.
    const spaceIds = new Set<string>([
      ...(await loadJoinedGroups(slotId)),
      ...(await this.readAsyncSet(spacesEncryptedKey(slotId))),
    ]);
    await clearSpaceKeysForSlot(storage, slotId, spaceIds);
    await clearStoredContentKeys(slotId); // content-epoch keys (dark feature)
    // Blind-token wallet (tokens + last-drawn epoch + issuer-key fingerprint).
    const w = walletStorageKeys(slotId);
    await rm(w.tokens);
    await rm(w.epoch);
    await rm(w.keyfp);
    // The six auxiliary budgets (read / four media / space-write — T4.2 TokenPool, ship dark, usually
    // empty). Same three keys (tokens/epoch/keyfp) each; one loop over every pooled purpose.
    for (const keys of tokenPoolStorageKeys(slotId)) {
      await rm(keys.tokens);
      await rm(keys.epoch);
      await rm(keys.keyfp);
    }
    await rm(outboxKey(slotId)); // pending optimistic sends
    await rm(pendingComposeKey(slotId)); // durable recovery queue of token-exhausted compose intents
    await rm(pictureSpendKey(slotId)); // picture-allowance spend
    await rm(identityAtKey(slotId)); // self-profile timestamp
    await rm(displayNameSelfKey(slotId)); // self display name
    await rm(gradientSelfKey(slotId)); // self gradient
    await rm(draftsKey(slotId)); // plaintext unsent drafts
    await rm(dmSentKey(slotId)); // sent-DM echoes
    await rm(dmReactionsKey(slotId)); // my DM reactions
    await rm(dmFailedWrapsKey(slotId)); // negative decrypt cache
    await rmAsync(dmBlocklistKey(slotId)); // DM blocklist (AsyncStorage)
    await rmAsync(mutedAuthorsKey(slotId)); // local feed author-mute set (AsyncStorage)
    await rmAsync(groupsJoinedKey(slotId)); // joined NIP-29 groups (AsyncStorage)
    await rmAsync(spacesEncryptedKey(slotId)); // encrypted-space id set (AsyncStorage)
  }

  /** Read a persisted AsyncStorage string-array set (encrypted spaces); [] on any error. */
  private async readAsyncSet(key: string): Promise<string[]> {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Finish onboarding: publish the binding event, store key + credential, set PINs.
   *
   * `opts.slotId` ADOPTS an account slot the host already minted instead of minting a fresh one.
   * That exists for exactly one caller — the first-run community prefetch
   * (onboarding/prefetchCommunity.ts), which opened this community's real per-(cid, slot) store
   * during the connecting step and filled it over Tor while the member picked a handle. The slot id
   * IS the store's namespace, so passing it here is what makes `swapActiveStore()` below reopen that
   * ALREADY-WARM database rather than mint a second, empty one and silently discard the download.
   * Omitted (add mode from a build without the prefetch, tests, any failure path) → a fresh slot,
   * byte-identical to the pre-prefetch behaviour.
   *
   * Passing a slot id is safe even when the prefetch failed: the id then simply names an empty
   * namespace, which is precisely what minting one here would have produced. Nothing about the slot
   * is persisted until `keyRing.addSlot` below, so an abandoned pre-minted id references nothing.
   */
  async completeEnrollment(
    session: Session,
    standardPin: string,
    duressPin?: string,
    gradient?: GradientSpec,
    opts?: {slotId?: string},
  ): Promise<void> {
    if (!this.identity || !this.pins || !this.deps.secureStorage) {
      throw new Error('secure storage unavailable; cannot enroll on this build');
    }
    // Finding #2 phase-split: a real enrollment supersedes init()'s un-enrolled fast-path phase 2
    // (see `_initPhase2Gen`'s doc comment) — bump it FIRST, synchronously, before any await gives a
    // stale phase 2 a chance to act on this runtime concurrently with the real hydration below.
    this._initPhase2Gen++;
    // Whether the device already has an unlock PIN (i.e. this is an ADDITIONAL community joined via
    // "add mode", not the first-run enrollment). Captured up front, before setPins could change it.
    const isAddMode = await this.pins.isConfigured();

    // Persist the binding event before touching secure storage so that a crash
    // between here and publish can be retried automatically on reconnect.
    await storePendingBind(this.deps.secureStorage, session.bindingEvent);

    // Add mode joins while a relay for the CURRENT community is live. Tear it down before we swap
    // the identity/store below, so no in-flight write lands in the new community's store or is
    // signed with the new npub (the host reconnects to the new relay right after — see App.tsx
    // onEnroll → forceRelayReconnectRef). Harmless on first-run enrollment (no live relay yet).
    await this.deps.onRelayTeardown?.();

    // Mint a fresh identity slot for this (key, community) pair and make it the active namespace
    // BEFORE enrolling, so the key/credential/name/gradient all land under the slot's namespace —
    // never the legacy globals. This is what makes joining a SECOND community additive (a new slot)
    // rather than overwriting the first identity. `opts.slotId` adopts the prefetch's pre-minted slot
    // instead — see this method's doc comment for why that matters.
    const slot: KeySlot = {
      id: opts?.slotId ?? newSlotId(),
      communityName: session.community.name ?? session.community.organizerLabel ?? 'Community',
      relayUrl: session.relayUrl,
      enrolledAt: Math.floor(Date.now() / 1000),
      npub: session.npub,
    };
    this.activeSlotId = slot.id;
    this.activeCid = communityId(session.relayUrl);
    this.rebuildIdentity();
    // Purge the OUTGOING account's optimistic compose placeholders from its (about-to-be-swapped-away)
    // store before opening the new account's store, so an add-mode enrollment never carries account
    // A's un-signed placeholders into the new account B (mirrors clearSwitchCaches on a switch).
    this.clearComposePlaceholders();
    // The wallet is namespaced by the freshly-minted slot (rebuildIdentity re-pointed it above), so it
    // is already empty — a NEW account can never inherit a sibling account's tokens even in the SAME
    // community. Clear defensively so any stray state under this slot id is gone before the
    // post-enrollment top-up draws a fresh batch under the new credential.
    await this.wallet?.clear();
    await this.tokenPool?.clearAll(); // the six auxiliary budgets (dark) — never inherit a sibling's stash
    // Enroll writes the secret key + credential + relay under the slot's namespace.
    await this.identity!.enroll(session.secretKey, session.relayUrl, session.credential);
    await this.keyRing?.addSlot(slot); // registers the slot AND marks it active
    // Additive: joining an EXISTING community adds this NEW account and makes it that community's
    // active slot (a sibling account in the same community is never replaced), so a later
    // switchCommunity(cid) reopens whichever account was last active there.
    await this.rememberActiveSlot(this.activeCid, slot.id);
    // Record the community (relay + organizer identity) and make it active, so the app talks
    // to this community's relay rather than the build-time default.
    await this.communities?.upsert(toEnrolledCommunity(session.community));
    // Open this community's own (empty) event store and hydrate the fresh workspace under the new
    // namespace, so the just-enrolled identity's name/gradient/drafts/DMs read+write in silo. This
    // also runs loadActiveCommunityPolicy(), which adopts this community's organizer as the
    // moderation/config trust root AND syncs the blind layer's community key (v3) — so a member can
    // attribute blind posts while the relay stays blind, keyed to the ACTIVE community.
    await this.swapActiveStore();
    await this.loadWorkspaceState();
    // Point 1/6/7: THIS is the member's first-ever entry into this community (first-run enrollment
    // OR an add-mode join). Stamp it now — loadWorkspaceState above already pointed communityEntry at
    // this (slot, cid) — so MainScreen lands on Updates, the welcome countdown starts, and pre-join
    // history stays out of the space unread counts.
    recordEntry(Math.floor(Date.now() / 1000));
    // The unlock PIN is device-wide, not per-community. Only set it on the FIRST enrollment;
    // joining an ADDITIONAL community (add mode) must never reset the PIN the user already has.
    //
    // `standardPin &&` guards the case where NO PIN was ever chosen. That is unreachable through the
    // pre-2026-07-15 UI (the onboarding PIN step is mandatory on a first run, and add mode — the one
    // caller that passes '' — is excluded by isAddMode), but it IS the normal first run once the PIN
    // UI ships dark (PIN_LOCK_UI false, config.ts): onboarding skips the PIN step, so `standardPin`
    // arrives ''. Without this guard `setPins('')` would seal the EMPTY STRING into the hardware
    // keystore as this device's real unlock PIN — a credential the member never chose, which
    // `verify('')` would then classify as 'standard'. Sealing nothing is both the truthful state and
    // the recoverable one: `pins.isConfigured()` stays false, which is the signal a future
    // re-enablement needs to tell "never had a PIN" (→ prompt to set one) from "has a PIN".
    // Byte-identical when PIN_LOCK_UI is on: `standardPin` is then always a real 4-digit PIN.
    //
    // Knock-on, flag-off only: with no PIN sealed, `isAddMode` (derived from isConfigured() above)
    // stays false, so a later join of a SECOND community also takes the `!isAddMode` branch below
    // and calls autolock.unlock(). That is inert — with the PIN UI dark, pinEnabled is false and
    // AutoLock's state gates nothing (see PIN_LOCK_UI). setPins stays skipped there either way,
    // since add mode passes '' too.
    if (!isAddMode && standardPin) {
      await this.pins.setPins(standardPin, duressPin);
    }
    // Persist the identity gradient chosen during onboarding (editable later from the profile). A
    // member who skipped picking one (no `gradient` arg) gets a fresh RANDOMLY-generated gradient
    // auto-claimed here instead — same generator the onboarding gradient maker's own shuffle button
    // uses (randomGradient) — so every enrolled identity has a real first-claim other members
    // converge on, rather than silently rendering the (unclaimed) seed-derived fallback until this
    // member's first authored post. Self-claim only, via the EXACT same call a chosen gradient takes
    // (mirrors siloing: gradients.reload() above already re-pointed the store at this new slot); the
    // subsequent onEnroll → setMyDisplayName call (App.tsx) announces it via the identity beacon
    // exactly as it would for a chosen gradient. Written after loadWorkspaceState so it lands under
    // the new slot's gradient key.
    await this.gradients.setMyGradient(gradient ?? randomGradient());

    // Mark enrolled now — credentials are persisted. Even if publish fails below,
    // the pending bind will be retried by onRelayConnected() when Tor reconnects.
    this.sessions.clear();
    this.enrolled = true;
    await this.loadPubkey();
    // First-run: land UNLOCKED, straight into the feed (bug #4). The member just set AND confirmed
    // this EXACT PIN twice, seconds ago, during onboarding — that already IS this session's
    // authentication, so bouncing them straight to a lock screen asking for the PIN they just typed
    // is redundant and jarring. A LATER lock (inactivity timeout, backgrounding, or a genuine cold
    // start of an already-enrolled app — which constructs a brand-new AutoLock defaulting to
    // 'locked') still requires the PIN exactly as before; only the transition that immediately
    // follows enrollment itself skips the prompt. Add mode: the app is already unlocked and in use,
    // so this whole branch is skipped (as before) — the user simply stays on the (now-active) new
    // community's feed.
    if (!isAddMode) this.autolock.unlock();
    this.emit();

    // Publish the kind-9011 binding event so the relay registers this npub.
    // publish is the lazy relay delegate — returns {accepted:false} when relay is offline.
    const result = await this.deps.publish?.(session.bindingEvent) ??
      {accepted: false, message: 'relay not connected — wait for "Connected via Tor"'};
    if (result.accepted) {
      await clearPendingBind(this.deps.secureStorage);
    }
    // If publish failed, leave the pending bind; onRelayConnected() will retry it.
    // Don't throw — the user is enrolled and the lock screen will appear.
  }

  /** Reset the inactivity timer — call on any user interaction. */
  touch(): void {
    this.autolock.touch();
  }

  /**
   * Lock the app immediately — call when the app is backgrounded so a resumed app always re-prompts
   * for the PIN/biometric rather than relying on the (unreliable, throttled) inactivity timer to fire
   * while backgrounded (security finding #22). No-op when unenrolled or when the user has turned the
   * PIN lock off, so it never traps a user who opted out of the lock screen. Locking also drops the
   * unlocked vault session via the autolock listener wired in the constructor.
   */
  lock(): void {
    if (!this.enrolled || !this.pinEnabled) return;
    this.pins?.forgetCached();
    this.autolock.lock();
  }

  async submitPin(pin: string): Promise<UnlockOutcome> {
    if (!this.lockController) {
      return 'rejected';
    }
    const outcome = await this.lockController.submitPin(pin);
    if (outcome === 'unlocked' && this._identityAnnouncePending) {
      // An identity edit's announce was gated or failed while the key was locked/pre-enrollment —
      // the signer is live again now, so settle the debt (fire-and-forget: best-effort like every
      // announce; failure re-arms the flag).
      void this.announceIdentity();
    }
    if (outcome === 'wiped' && this.identity) {
      this.enrolled = await this.identity.isEnrolled(); // duress cleared it
      this.myPubkey = undefined;
      this.inbox = []; // DM wraps are wiped with the cache
      this.decryptedWraps.clear(); // drop decrypted plaintext + seen-set with the wiped cache
      this.seenWrapIds.clear();
      this._spacePlaintextCache.clear(); // drop decrypted private-space plaintext on duress
      this.failedWrapIds.clear(); // wipe the persisted negative decrypt cache (finding #4 security)
      this.convKeyCache?.clear(); // drop every derived per-peer conversation key
      this.sentByPeer.clear();
      this.myDmReactions.length = 0;
      void this.flushSentMessages();
      void this.flushFailedWraps();
      void this.saveDmReactions();
      this.emit();
    } else if (outcome !== 'unlocked') {
      // A plain 'unlocked' already emitted via autolock.unlock() → onChange (which also lifted
      // _deferHeavy and ran the first heavy build), so emitting again here would just re-run a full
      // getSnapshot on the post-PIN hot path. 'rejected' (and a wiped-without-identity edge) still
      // want a refresh; LockScreen's shake is driven by local state, not this emit.
      this.emit();
    }
    return outcome;
  }

  /** Toggle PIN lock screen on/off. Persists the choice to AsyncStorage. */
  async setPinEnabled(enabled: boolean): Promise<void> {
    this.pinEnabled = enabled;
    await savePinEnabled(enabled);
    this.emit();
  }

  /** Verify whether a PIN matches the standard slot (no side effects). */
  async verifyPin(pin: string): Promise<boolean> {
    if (!this.pins) return false;
    return (await this.pins.verify(pin)) === 'standard';
  }

  /**
   * Build the FULL wipe target set shared by the duress-PIN path (LockController) and the Settings
   * emergency kill switch ({@link wipeAllData}), so the two can never drift (security findings
   * #8/#10/#18). Both must leave a true fresh-install state, clearing:
   *   - every identity slot's (ACCOUNT's) secret signing key + credential + bound relay (not just the
   *     active one), PLUS its complete per-account residue via {@link wipePerSlotState}: the
   *     self-profile timestamp, self display-name/gradient, drafts (plaintext unsent posts), the DM
   *     sent/reactions/failed-wraps caches + DM blocklist, the blind-token wallet, the outbox, the
   *     joined-groups / encrypted-spaces sets + their private-space E2E keys, the content-epoch keys,
   *     and the picture-allowance spend — all per-account (finding M3),
   *   - the community key — the in-memory active copy (setActiveCommunityKey(null)) + every
   *     per-community list record's embedded base64 key (communities.clear) + any pre-slot global
   *     `stiq.community.key` leftover (wipeLegacyGlobals) — the membership secret that deanonymises
   *     every member's blind posts,
   *   - every community's encrypted event-cache DB + non-sqlite fallback cache blob + learned
   *     name/gradient phonebooks (the per-community PUBLIC layer), and any migration-leftover per-CID
   *     outbox/groups/spaces,
   *   - the per-community last-active-account index,
   *   - the pre-silo LEGACY_* globals the migration copies but never moves (incl. the raw
   *     `stiq.identity.sk` private key and the AsyncStorage-backed legacy DM blocklist),
   *   - the two PINs + the brute-force attempt counter (via PinVault.clear).
   */
  private duressWipeTargets(): DuressTargets {
    const storage = this.deps.secureStorage!;
    const communities = this.communities!;
    const keyRing = this.keyRing!;
    return {
      identity: this.identity!,
      pins: this.pins!,
      cache: this.deps.store,
      // Drop the SQLCipher key + delete the legacy cache file so the encrypted events can't be
      // forensically recovered (no-op on builds without the native store).
      cacheFile: {wipe: () => wipeEncryptedCache(storage)},
      session: this.sessions,
      extra: async () => {
        // Best-effort per-key removal so one failure can't strand later keys (finding M3): the
        // "true fresh-install state" guarantee requires EVERY namespaced item to go, not just the
        // first few. removeSecure hits the hardware keystore; removeAsync hits AsyncStorage — the
        // wrong backend is a silent no-op, so each key must use the API that actually stores it.
        const removeSecure = async (key: string): Promise<void> => {
          try {
            await storage.removeItem(key);
          } catch {
            /* best effort — keep wiping the rest */
          }
        };
        const removeAsync = async (key: string): Promise<void> => {
          try {
            await AsyncStorage.removeItem(key);
          } catch {
            /* best effort — keep wiping the rest */
          }
        };
        // Community key (the "who" secret): drop the in-memory active copy. There is no separate stored
        // global mirror anymore — the key at rest lives only in the per-community list record (cleared
        // by communities.clear below) + any pre-slot leftover (wiped by wipeLegacyGlobals).
        setActiveCommunityKey(null);
        // Per-community PUBLIC layer, before clearing the list (each record embeds the community's
        // base64 key): the ORPHANED legacy per-cid store (finding #4 — the per-(cid, account) stores
        // are wiped in the per-slot loop below) + legacy snapshot + non-sqlite fallback blob + learned
        // name/gradient phonebooks. Also purge any migration-leftover per-CID outbox/groups/spaces.
        for (const community of await communities.list()) {
          const cid = community.id;
          await wipeLegacyCidStore(storage, cid); // orphaned pre-per-account per-cid DB + SQLCipher key
          await clearFeedSnapshot(storage, cid); // legacy per-cid feed-state snapshot (T16-S3)
          await removeSecure(eventsCacheKey(cid)); // legacy per-cid non-sqlite fallback event cache blob
          await removeSecure(displayNameBookKey(cid)); // learned npub→name phonebook
          await removeSecure(gradientBookKey(cid)); // learned npub→gradient phonebook
          await removeSecure(PREV_OUTBOX_CID(cid)); // migration-leftover per-CID outbox
          await removeAsync(PREV_GROUPS_JOINED_CID(cid)); // migration-leftover per-CID joined groups
          await removeAsync(PREV_SPACES_ENCRYPTED_CID(cid)); // migration-leftover per-CID encrypted spaces
        }
        clearActiveContentKeys();
        await communities.clear();
        await removeSecure(COMMUNITY_ACTIVE_SLOT_MAP); // per-community last-active-account index
        // Every identity slot (ACCOUNT): signing key + credential + bound relay, then its COMPLETE
        // per-account residue (wallet, outbox, groups/spaces + space keys, content keys, DM caches,
        // drafts, self name/gradient, picture-spend, pending-compose) via the shared per-account wipe,
        // PLUS this account's OWN per-(cid, slot) event store (finding #4): encrypted DB + SQLCipher
        // key + feed snapshot + non-sqlite fallback blob.
        for (const slot of await keyRing.listSlots()) {
          const sid = slot.id;
          const scid = communityId(slot.relayUrl);
          await new KeyStore(storage, sid).reset(); // stiq_privkey_<sid>
          await removeSecure(credTokenKey(sid));
          await removeSecure(credSigKey(sid));
          await removeSecure(identityRelayKey(sid));
          await this.wipePerSlotState(sid);
          await wipeEncryptedCache(storage, scid, sid); // per-account encrypted DB + SQLCipher key
          await clearFeedSnapshot(storage, scid, sid); // per-account feed-state snapshot
          await removeSecure(eventsCacheKey(scid, sid)); // per-account non-sqlite fallback blob
        }
        await keyRing.clear();
        // Pre-silo legacy globals the migration copies but never moves (incl. raw stiq.identity.sk).
        await wipeLegacyGlobals(storage);
        // Device-global Tor network memory: the last-working bridge set (global cache) AND every
        // per-network-class entry (stiq.tor.bridges.net.<class>). Erased here so a full reset leaves
        // no trace of which transports/bridges reached the network — the "wiped on a duress reset"
        // promise in bridgeCache.ts. Both are best-effort internally (never throw).
        await clearCachedBridges(storage);
        await clearAllNetworkClassBridges(storage);
      },
    };
  }

  /**
   * Emergency kill switch: wipes all local data exactly as the duress PIN would.
   * Resets to fresh-install state. Use from Settings → Security.
   */
  async wipeAllData(): Promise<void> {
    if (!this.identity || !this.pins || !this.deps.secureStorage) return;
    await performDuressWipe(this.duressWipeTargets());
    this.enrolled = false;
    this.myPubkey = undefined;
    this.inbox = [];
    this.decryptedWraps.clear();
    this.seenWrapIds.clear();
    this._spacePlaintextCache.clear(); // drop decrypted private-space plaintext on emergency wipe
    this.failedWrapIds.clear(); // wipe the persisted negative decrypt cache (finding #4 security)
    this.convKeyCache?.clear();
    this.sentByPeer.clear();
    this.myDmReactions.length = 0;
    // Remove the persisted DM caches from secure storage so an emergency wipe leaves nothing behind.
    void this.deps.secureStorage.removeItem(this.dmFailedWrapsItem()).catch(() => undefined);
    void this.deps.secureStorage.removeItem(this.sentDmsItem()).catch(() => undefined);
    this._failedWrapsDirty = false;
    this._sentDmsDirty = false;
    this.emit();
  }

  /** Call when the cache changes (e.g. RelayClient.onEvent) to refresh the feed. */
  notifyStoreChanged(): void {
    this.emitDeferred();
    // P4 publish-on-detect rides the SAME store-change reaction that recomputes the feed, debounced
    // on its own timer so a cold-start firehose coalesces into one scan (see scheduleWitnessScan).
    this.scheduleWitnessScan();
  }

  // ── P4 double-spend witnesses (publish-on-detect + consume-verify) ──────────────────────────────
  // The LOCAL detector (buildModeratedFeed → detectDoubleSpends) is the SOLE authority for hiding a
  // double-spend loser; a witness never hides anything directly (verify-never-trust is structural).
  // Publishing exists only to SHARE the signal so a mirror/client holding just one side of a conflict
  // can id-fetch the other and let ITS local detector act. Session-scoped guard: each token-id is
  // witnessed at most once per run — the durable witness is already on the relay/feed after that, and
  // the local detector hides losers from the store regardless, so we never re-emit.
  private _witnessedTokens = new Set<string>();
  private _witnessScanTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Debounced publish-on-detect trigger. Coalesces a relay burst into a single scan at the feed-
   * refresh cadence (RELAY_EMIT_THROTTLE_MS), so the firehose doesn't re-scan per event. The scan
   * itself is cheap after the first pass: validSpentTokenIds memoizes its per-event crypto (WeakMap),
   * which buildModeratedFeed already warmed over the same events, so this only rebuilds the bucket map.
   */
  private scheduleWitnessScan(): void {
    if (this._witnessScanTimer !== undefined) return;
    this._witnessScanTimer = setTimeout(() => {
      this._witnessScanTimer = undefined;
      void this.publishNewSpendWitnesses();
    }, AppRuntime.RELAY_EMIT_THROTTLE_MS);
    // Don't let this off-critical-path timer keep the process alive (mirrors scheduleScorePass).
    (this._witnessScanTimer as unknown as {unref?: () => void}).unref?.();
  }

  /**
   * The feed post set the double-spend detector scans — the SAME kinds buildModeratedFeed renders
   * (Post/Article/Poll/Voice, excluding hybrid kind-1 'stiq-comment' notes). Article de-dup by
   * coordinate is intentionally NOT applied: a double-spend split is re-derived from the raw events
   * on every client (and by verifySpendWitness over just the named pair), so scanning the un-deduped
   * set here only ever surfaces MORE conflicts to share — it can never cause an honest post to hide,
   * since a valid second spend still requires the holder's own proof.
   */
  private doubleSpendPostSet(): Event[] {
    return this.deps.store
      .query({kinds: [Kind.Post, Kind.Article, Kind.Poll, KIND_VOICE_MESSAGE]})
      .filter(ev => !isStiqComment(ev));
  }

  /**
   * PUBLISH-ON-DETECT: scan the current feed post set for holder double-spends and broadcast one
   * signed {@link buildSpendWitness} per loser of each NEW conflict (a token-id not yet witnessed this
   * session). Signed with the bound member's real key via the SAME identity-signed publish path that
   * moderation reports use (identity.sign → publishOptimistic), so it is attributable and rides the
   * feed firehose. Runs OUTSIDE _cachedBuildFeed (which must stay side-effect-free) — this is the only
   * place a witness is minted. A witness carries NO trust: every consumer (including us) re-derives the
   * conflict locally before hiding, so publishing a wrong one hides nothing anywhere.
   */
  private async publishNewSpendWitnesses(): Promise<void> {
    // Only a bound member can sign an attributable witness. Anonymous/locked sessions skip entirely:
    // the local detector still hides losers from the store, so the signal isn't lost — just unshared.
    const identity = this.identity;
    if (!identity || !this.enrolled) return;
    const ds = detectDoubleSpends(this.doubleSpendPostSet());
    if (ds.conflicts.size === 0) return;
    for (const conflict of ds.conflicts.values()) {
      if (this._witnessedTokens.has(conflict.tokenId)) continue;
      // Mark BEFORE the first await so a re-entrant scan (another burst firing mid-publish) can't
      // double-emit the same token's witnesses. Idempotent even if it did — the relay/feed de-dupes.
      this._witnessedTokens.add(conflict.tokenId);
      for (const loserId of conflict.losers) {
        try {
          const signed = await identity.sign(
            buildSpendWitness(conflict.tokenId, conflict.winner, loserId),
          );
          await this.publishOptimistic(signed);
        } catch {
          // Signing/publish failed (key locked, offline). publishOptimistic already queues+retries a
          // real publish; a locked-key sign just skips — the next scan re-attempts only if we DIDN'T
          // mark it, so on a sign failure we un-mark so a later unlocked scan can still witness it.
          this._witnessedTokens.delete(conflict.tokenId);
          break;
        }
      }
    }
  }

  /**
   * CONSUME-VERIFY an ingested double-spend witness (kind {@link KIND_SPEND_WITNESS}). VERIFY-NEVER-
   * TRUST: {@link verifySpendWitness} re-derives the losers from the referenced events in OUR store,
   * so anything it proves is ALREADY hidden by the local detector (buildModeratedFeed) over that same
   * store — this is corroboration, never an independent hide. The one thing a witness adds is
   * DISCOVERY: if it names an event our store is MISSING, the local detector is blind to the conflict,
   * so we best-effort id-fetch the unheld side(s) via the same by-id REQ path getEvent uses
   * (deps.fetchEvents → MirrorSet.fetchById, deduped + chunked). When they arrive, handleIncomingEvent
   * re-runs the detector over the now-complete store and the loser hides itself. We never hide on the
   * witness's own labels, so a forged/mislabelled witness proves — and hides — nothing.
   */
  private consumeSpendWitness(event: Event): void {
    // Re-derive locally. Non-empty → both sides held + they genuinely collide; the feed already hides
    // these losers, nothing more to do (the return value is discarded — hiding is the detector's job).
    if (verifySpendWitness(event, this.deps.store).length > 0) return;
    // Empty proof: either a referenced event is MISSING (fetch it so the local detector can then act)
    // or the named events simply don't collide (a false witness — nothing to fetch, since none missing).
    const parsed = parseSpendWitness(event);
    if (!parsed) return;
    const missing = parsed.eventIds.filter(id => !this.deps.store.getById(id));
    if (missing.length > 0) this.deps.fetchEvents?.(missing);
  }

  /**
   * Apply a live kind-30078 organizer-config event by its `d` tag: update the in-memory field
   * and return the patch to persist on the active community. Returns null for an unrecognized
   * d-tag or malformed content, in which case the caller leaves state untouched.
   */
  private applyOrgConfig(
    d: string | undefined,
    content: string,
    createdAt: number,
  ): Partial<EnrolledCommunity> | null {
    switch (d) {
      case TAG_POLICY_D_TAG: {
        const v = parseTagPolicyEvent(content);
        if (!v) return null;
        this.tagPolicy = v;
        return {tagPolicy: v};
      }
      case LABELS_D_TAG: {
        const v = parseLabelsEvent(content);
        if (!v) return null;
        this.labels = v;
        return {labels: v};
      }
      case POST_RULES_D_TAG: {
        const v = parsePostRulesEvent(content);
        if (!v) return null;
        this.postRules = v;
        this.postRulesAt = createdAt;
        return {postRules: v, postRulesAt: createdAt};
      }
      case POSTING_GUIDELINES_D_TAG: {
        // A valid-but-EMPTY doc means the organizer CLEARED the guidelines — that must apply (set
        // null, hide the banner), so only a malformed/foreign doc is ignored here.
        let raw: unknown;
        try {
          raw = JSON.parse(content);
        } catch {
          return null;
        }
        if (!raw || typeof raw !== 'object' || (raw as {v?: unknown}).v !== 1) return null;
        const v = parsePostingGuidelines(raw);
        this.postingGuidelines = v;
        return {postingGuidelines: v};
      }
      case PICTURE_RULES_D_TAG: {
        const v = parsePictureRulesEvent(content);
        if (!v) return null;
        this.pictureRules = v;
        setPicturePeriodHours(v.periodHours);
        return {pictureRules: v};
      }
      case AUDIO_RULES_D_TAG: {
        const v = parseAudioRulesEvent(content);
        if (!v) return null;
        this.audioRules = v;
        setActiveAudioRules(v);
        return {audioRules: v};
      }
      case CONTENT_EPOCH_D_TAG: {
        // The organizer's announced CURRENT content epoch (censorable reads, #4). Remember it so
        // ensureWriteEpoch can provision the write key before composing — otherwise a member with the
        // content-encryption flag on would seal under a stale/absent key. The created_at rollback guard
        // in handleIncomingEvent already blocks a mirror replaying an OLDER announcement, so the epoch
        // only ever moves forward. Persisted so a returning member knows which epoch to provision.
        const v = parseContentEpochDoc(content);
        if (!v) return null;
        this._announcedContentEpoch = v.epoch;
        return {contentEpoch: v.epoch};
      }
      case REASONS_D_TAG: {
        const v = parseReasonsEvent(content);
        if (!v) return null;
        this.reasons = v;
        return {reasons: v};
      }
      case RANKING_D_TAG: {
        const v = parseRankingEvent(content);
        if (!v) return null;
        this.ranking = v;
        return {ranking: v};
      }
      case MIRRORS_D_TAG: {
        // Durable anti-rollback (P2 §1.7, attack H): this.activeCommunity mirrors the PERSISTED
        // mirrorsOrgAt (reloaded from storage by loadActiveCommunityPolicy at cold start / every
        // switch), so this holds even across a restart that clears the session-only _orgConfigAt
        // watermark checked in handleIncomingEvent — a stale/withholding mirror can't replay an
        // OLDER `stiq:mirrors` doc to shrink or roll back the effective mirror set.
        if (createdAt <= (this.activeCommunity?.mirrorsOrgAt ?? 0)) return null;
        const v = parseMirrorsEvent(content);
        if (!v) return null;
        if (this.activeCommunity) {
          this.activeCommunity = {...this.activeCommunity, mirrorsOrg: v, mirrorsOrgAt: createdAt};
        }
        return {mirrorsOrg: v, mirrorsOrgAt: createdAt};
      }
      case ORGANIZER_D_STORAGE: {
        // Organizer-tunable retention policy (T16-S2). Dark unless COMPACTION_V2 is on. The just-arrived
        // doc is already persisted (RelayClient saves before onEvent, per App.tsx onSeen/onEvent split),
        // so currentStoragePolicy reads the freshest value; apply it to the LIVE store's caps without a
        // restart, and return the patch so it also persists on the community for the next cold boot.
        if (!COMPACTION_V2) return null;
        const policy = currentStoragePolicy(this.deps.store, this.organizerNpub());
        if (!policy) return null; // malformed/absent → null (no watermark advance), like the sibling cases
        const inner =
          (this.deps.store as {current?: unknown}).current ?? this.deps.store;
        (inner as {setRetentionPolicy?: (p: ReturnType<typeof toRetentionPolicy>) => void})
          .setRetentionPolicy?.(toRetentionPolicy(policy));
        return {storagePolicy: policy};
      }
      case ORGANIZER_D_BRIDGES: {
        // Community-seeded transport bridges (T14-S5). Dark unless COMMUNITY_SEEDED_BRIDGES is on. Parse
        // the organizer's latest stiq:bridges doc (validated obfs4/webtunnel only, deduped + capped) and
        // persist on the community; App.tsx resolveBridges consumes seededBridges as a zero-network
        // webtunnel/obfs4 source. Return null when nothing survives so absent-stays-absent is preserved.
        if (!COMMUNITY_SEEDED_BRIDGES) return null;
        const seeded = currentSeededBridges(this.deps.store, this.organizerNpub());
        return seeded ? {seededBridges: seeded} : null;
      }
      case TOKEN_KEYS_D_TAG: {
        // Live issuer-key distribution (token draw pipeline). An already-enrolled member never
        // received the newer purpose keys — notably `swk` (space-write) — in their join code, so
        // without this their space-write token draw mis-blinds under the enrollment key and every
        // DM / channel / group write fails once space_tokens_required is enforced. Adopt whatever
        // keys the organizer advertises (each validated in parseTokenKeysEvent); the caller persists
        // the patch via communities.upsert, and drawForWallet reads the fresh record from
        // communities.active() on its next draw — so the member's wallet fills on the next send with
        // no re-enrollment.
        const v = parseTokenKeysEvent(content);
        if (!v) return null;
        // T1.4/F6 — mirror MIRRORS_D_TAG below: merge the new keys into the in-memory active
        // community record SYNCHRONOUSLY (not just the async persisted upsert the caller kicks off),
        // so handleIncomingEvent can immediately rebindPurposeKeyFingerprints() with the FRESH keys.
        // This is what makes a mis-provisioned/stale-key C5 block self-heal the moment the organizer
        // republishes a corrected `stiq:token-keys` doc, instead of staying bricked until the next
        // restart or community switch (F6/F8 — "trigger a re-sync… do not hard-brick").
        if (this.activeCommunity) {
          this.activeCommunity = {...this.activeCommunity, ...v};
        }
        return v;
      }
      default:
        return null;
    }
  }

  /**
   * Accept a kind-30079 space-key delivery IF its sender is the group owner/admin (per relay-signed
   * 39000/39001), then unwrap + cache the key. SENDER AUTH is confidentiality-critical: a 30079 from
   * any pubkey would let a hostile peer inject a key (MITM) or lock us out. If the owner/admin set
   * isn't known yet we DROP — reprocessPendingKeyDeliveries() retries from the persisted store once
   * that state arrives, so a delivery that raced ahead of the group state isn't lost forever.
   *
   * Trust boundary (per the shipped "encrypted-at-rest" model): the owner/admin set is relay-signed,
   * so a malicious relay could forge it — fully hiding content from a hostile relay is out of scope
   * for NIP-29 relay-managed groups (the relay also controls membership). The guarantee here is: the
   * relay only ever stores ciphertext, and arbitrary pubkeys / non-members cannot inject a key.
   */
  private processKeyDelivery(event: Event): void {
    if (!this.identity || !this.myPubkey) return;
    const delivery = parseKeyDelivery(event);
    if (!delivery || delivery.recipient !== this.myPubkey) return;
    const owner = groupStateOf(this.deps.store, delivery.spaceId)?.owner;
    const admins = groupAdminsOf(this.deps.store, delivery.spaceId);
    const senderIsOwner = !!owner && delivery.sender === owner;
    const senderIsAdmin = admins.includes(delivery.sender);
    if (!senderIsOwner && !senderIsAdmin) return; // unauth or unknown owner/admin set → drop (retried on state sync)
    // For a NEW epoch always accept; for a same-epoch already cached, only a more-authoritative
    // delivery (owner's, else newer) may overwrite, so a stale/duplicate can't clobber a good key.
    const cacheKey = `${delivery.spaceId}:${delivery.epoch}`;
    if (this._spaceKeyCache.has(cacheKey) && !this.shouldReplaceSpaceKey(cacheKey, delivery, senderIsOwner, event.created_at)) {
      return;
    }
    const senderPk = delivery.sender;
    const createdAt = event.created_at;
    const spaceId = delivery.spaceId;
    const epoch = delivery.epoch;
    void this.identity
      .unwrapSpaceKey(delivery.blob, senderPk)
      .then(async key => {
        // Only after a VALID (authorized + unwrappable) delivery: mark the space encrypted locally
        // (so outgoingSeal stays fail-closed even if 39000 is stripped) and cache the key.
        this._spaceKeyDeliveryMeta.set(cacheKey, {fromOwner: senderIsOwner, createdAt});
        await addEncryptedSpace(spaceId);
        await this.cacheSpaceKey(spaceId, epoch, key);
      })
      .then(() => this.emit())
      .catch(() => {
        /* not for us / tampered — ignore */
      });
  }

  /**
   * Re-run processKeyDelivery over every persisted kind-30079 addressed to me for `spaceId`. Called
   * when the group's 39000/39001 state arrives (live) and from hydrateSpaceKeys (startup/open), so a
   * delivery dropped while the owner/admin set was unknown is accepted the moment it can be verified —
   * otherwise it'd be lost forever (onEvent fires once, the store dedupes by id, `since` blocks a
   * re-stream), bricking a freshly-added member. Idempotent.
   */
  private reprocessPendingKeyDeliveries(spaceId: string): void {
    if (!this.identity || !this.myPubkey) return;
    for (const ev of this.deps.store.query({kinds: [Kind.SpaceKeyDelivery]})) {
      const d = parseKeyDelivery(ev);
      if (d && d.recipient === this.myPubkey && d.spaceId === spaceId) this.processKeyDelivery(ev);
    }
  }

  /**
   * Call for each individual event received from the relay.
   * Refreshes the feed (same as notifyStoreChanged) and fires local notifications
   * for gift-wrapped DMs, channel broadcasts, and replies to the user's own posts.
   */
  handleIncomingEvent(event: Event): void {
    this.notifyStoreChanged();
    this.learnNameFrom(event);

    // P4 double-spend witness (kind-1986): corroborate + id-fetch the other side if we're missing it.
    // It is never a renderable feed item, and the local detector — not the witness — decides what
    // hides, so consume it here and return (notifyStoreChanged above already refreshed the feed).
    if (event.kind === KIND_SPEND_WITNESS) {
      this.consumeSpendWitness(event);
      return;
    }

    // Live organizer config (kind-30078 from the active organizer): tag policy, labels, post
    // rules, reason buckets. Each is cached on the active community so it survives a restart.
    const orgConfigHex = this.activeOrganizerHex();
    if (
      event.kind === KIND_ORG_CONFIG &&
      orgConfigHex &&
      event.pubkey === orgConfigHex
    ) {
      const d = event.tags.find(t => t[0] === 'd')?.[1];
      // Governance union anti-rollback (P2 §1.7, attack H): with mirrors unioned, more than one
      // relay can deliver an org-config event for the same `d`. Read it as MAX(created_at) per
      // (author, d) so a stale or withholding mirror replaying an OLDER doc — an expired ban, a
      // since-widened roster, a since-shrunk mirror list — can never roll a live community back to
      // it. This in-memory watermark is session-only; `stiq:mirrors` additionally checks the
      // DURABLE `mirrorsOrgAt` field inside applyOrgConfig, since that specific d-tag must stay
      // rollback-safe across a restart too.
      // Key the watermark by (organizer pubkey | d), NOT d alone: this map is session-lived and
      // NOT cleared on community switch, so a d-tag watermark set while viewing one community must
      // not gate another community's organizer for the same d. kind-30078 created_at is self-signed
      // and unvalidated, so a foreign (or future-dated) community could otherwise freeze this one's
      // live governance for the whole session — a cross-tenant DoS.
      if (d !== undefined) {
        const prevAt = this._orgConfigAt.get(`${event.pubkey}|${d}`);
        if (prevAt !== undefined && prevAt > event.created_at) {
          return;
        }
      }
      const patch = this.applyOrgConfig(d, event.content, event.created_at);
      if (patch) {
        // Advance the per-d watermark ONLY now that the doc actually parsed to a real patch. Doing it
        // BEFORE applyOrgConfig let a MALFORMED doc carrying a high created_at (applyOrgConfig → null,
        // nothing applied) still bump the watermark and then permanently BLOCK a later legitimate doc
        // whose (lower but still-newer-than-the-last-good) created_at now trips the rollback guard.
        if (d !== undefined) this._orgConfigAt.set(`${event.pubkey}|${d}`, event.created_at);
        void this.communities?.active().then(active => {
          if (!active) return;
          // Assert ONLY the org-config change (patch, incl. mirrorsOrg) against the freshest stored
          // record; OMIT the known-good/user mirror lists so communityStore.upsert's absent-stays-
          // absent guard preserves them. Otherwise this snapshot could clobber a concurrent
          // recordKnownGoodMirror() persist (a different read-modify-write on active()) — §7 race.
          const next = {...active, ...patch};
          delete next.mirrorsKnownGood;
          delete next.mirrorsUser;
          void this.communities?.upsert(next);
        });
        // A durable stiq:mirrors adoption must reach the LIVE transport without a reconnect
        // (synthesis §1.9): the patch above already merged the new mirrorsOrg into this.activeCommunity,
        // so pushMirrorsLive() recomputes effectiveMirrors + the onion-auth set synchronously — the
        // same live-adoption path a user add/mute takes.
        if (d === MIRRORS_D_TAG && this.activeCommunity) {
          this.pushMirrorsLive();
        }
        // T1.4/F6 — a live stiq:token-keys re-sync just updated this.activeCommunity's purpose keys
        // (applyOrgConfig, above): rebind every wallet's fingerprint and re-run C5 now, with the FRESH
        // keys, so a member whose invite was mis-provisioned self-heals the moment the organizer
        // republishes a corrected key set — not a permanent brick.
        if (d === TOKEN_KEYS_D_TAG) {
          this.rebindPurposeKeyFingerprints();
        }
        this.emit();
        return;
      }
    }

    // Identity carriers (kind-30078, member d-tags — see profile/identityDoc). A peer's relay-blind
    // beacon lets us learn their name/gradient without them posting; our OWN encrypted profile from
    // another device converges our local identity across devices. Neither is a feed kind, so they
    // never render as posts.
    if (event.kind === Kind.AppData) {
      const identityD = event.tags.find(t => t[0] === 'd')?.[1];
      if (identityD === D_IDENTITY_BEACON) {
        // Skip our own beacon: self identity renders from local storage, not the learned peer book.
        if (event.pubkey !== this.myPubkey) {
          this.learnNameFromContent(event.pubkey, event.content, event.created_at);
          this.emit();
        }
        return;
      }
      if (identityD === D_IDENTITY_PROFILE) {
        if (event.pubkey === this.myPubkey) void this.adoptEncryptedProfile(event);
        return;
      }
      // Space-invites doc (kind-30078, d="space-invites:<groupId>" — KIND_SPACE_INVITES is the SAME
      // numeric kind as the identity docs above, so it lands here too). This doc's own arrival is
      // exactly the trigger autoApproveInvited was missing (it previously ran only off 9021/39004
      // arrival): without this, a doc that lands or finally decrypts AFTER the pending event that
      // would have swept it never gets a second chance. Any admin's device reacts, not just the
      // author's — every admin needs the invited+pending member promoted, not only whoever sent the
      // invite.
      if (identityD?.startsWith(SPACE_INVITES_D_PREFIX)) {
        const gid = identityD.slice(SPACE_INVITES_D_PREFIX.length);
        if (gid && this.myPubkey && isGroupAdminOf(this.deps.store, gid, this.myPubkey)) {
          this.autoApproveInvited(gid);
        }
        return;
      }
      // Key-redelivery request (d="space-key-request:<spaceId>"): a stranded member of a private
      // space asking its admins to re-send the current epoch key — the delivery they were owed
      // never arrived, and the _deliveredKeyTo watermark means no other path will ever re-send it.
      // Arrives on the group's own scoped sub (buildSpaceKeyRecoveryFilters). Fully guarded inside
      // (admin + roster + created_at dedupe); see maybeRedeliverSpaceKey.
      if (identityD?.startsWith(SPACE_KEY_REQUEST_D_PREFIX)) {
        this.maybeRedeliverSpaceKey(event);
        return;
      }
    }

    // Private-space E2E key delivery (kind 30079) addressed to me: authenticate the sender, unwrap
    // with my secret key, and cache the key so the space's new-epoch messages start decrypting.
    if (event.kind === Kind.SpaceKeyDelivery) {
      this.processKeyDelivery(event);
      return;
    }
    // When a group's owner/admin state (39000/39001) arrives, RE-PROCESS any key deliveries that were
    // dropped earlier because the sender couldn't yet be verified — so a 30079 that raced ahead of the
    // group state isn't lost (which would otherwise brick a freshly-added member's access).
    if (event.kind === GroupKind.Metadata || event.kind === GroupKind.Admins) {
      const sid = event.tags.find(t => t[0] === 'd')?.[1];
      if (sid) this.reprocessPendingKeyDeliveries(sid);
    }

    // Membership handoff: a 39002 listing ME fulfils my outstanding join request (the space then
    // surfaces as a normal inbox row); a 39004/9021 arrival triggers the invited-accept
    // auto-approve sweep for spaces I administer.
    if (event.kind === GroupKind.Members) {
      this.reconcileMyJoinRequests(event);
      this.maybeRekeyOnMemberLeave(event);
      this.maybeDeliverKeyToNewMembers(event);
    }
    if (event.kind === GroupKind.Pending || event.kind === GroupKind.JoinRequest) {
      const gid = event.kind === GroupKind.Pending ? stateGroupId(event) : eventGroupId(event);
      if (gid) this.autoApproveInvited(gid);
    }
    // Fresh relay roster state (39001 admins / 39002 members / 39004 pending) is authoritative:
    // retire any optimistic overlay entries it now reflects (+ GC stale intent). The state event's
    // own notifyStoreChanged/save→emit already re-renders, so no extra emit is needed here.
    if (
      event.kind === GroupKind.Admins ||
      event.kind === GroupKind.Members ||
      event.kind === GroupKind.Pending
    ) {
      const gid = stateGroupId(event);
      if (gid) this.reconcileRosterOverlay(gid);
    }

    // A moderator's mute list (kind-10000) may newly remove a DM peer → auto-block. Regroup the
    // inbox so their conversation hides immediately; their already-received history is kept (hidden,
    // restorable if the user un-blocks), and future DMs are deleted on arrival by refreshInbox. No
    // decrypt needed — just re-run the grouping over the cache. Falls through so the feed/thread
    // moderation caches (keyed on versionOf) also refresh. The map read below is version-cached.
    if (event.kind === Kind.MuteList && this.enrolled) {
      this.rebuildInboxFromCache();
      this.emitDeferred();
    }

    if (event.kind === Kind.GiftWrap) {
      // Coalesce rapid gift-wrap bursts (relay replay, DM sync) into a single refreshInbox call.
      // Each incoming wrap resets the 250 ms window; only the last one in a burst actually fires.
      // When the timer fires, refreshInbox processes ALL pending wraps at once (via seenWrapIds).
      // DM notifications fire after that consolidated refresh.
      // User-initiated refreshes (sendDM) call refreshInbox directly — unaffected by this timer.
      if (this._refreshInboxTimer !== undefined) {
        clearTimeout(this._refreshInboxTimer);
      }
      this._refreshInboxTimer = setTimeout(() => {
        this._refreshInboxTimer = undefined;
        void this.refreshInbox().then(() => {
          if (!this.myPubkey) return;
          for (const conv of this.inbox) {
            const latest = this.latestIncoming(conv.messages);
            if (latest) {
              void notifyDm(latest.sender, this.displayNames.nameFor(latest.sender) ?? '', latest.createdAt);
            }
          }
        });
      }, AppRuntime.RELAY_EMIT_THROTTLE_MS);
      return;
    }

    if (event.kind === Kind.LiveChat && this.myPubkey) {
      // An EDIT of an existing broadcast is not new activity — never raise a "posted in" push for
      // it (deriveNotifications applies the same rule to the notification centre).
      if (editTargetId(event) !== null) return;
      const channelId = event.tags.find(t => t[0] === 'a')?.[1];
      if (channelId) {
        const ch = this.listChannels().find(c => c.id === channelId);
        // SCOPED_CHANNEL_SYNC: only a channel the member is actually a part of may raise a live push
        // — the same rule deriveNotifications applies to the notification centre, and for the same
        // two reasons. The sharper one here: under scoped sync this call site now ALSO sees the
        // scoped sub's DECOY channels, so without this gate cover traffic would fire real system
        // notifications for channels the member never joined. Flag off: unchanged, every known
        // channel notifies.
        if (ch && (!SCOPED_CHANNEL_SYNC || this.channelSyncSet().includes(channelId))) {
          // NIP-53 Live Activities are the only channels this call site sees — always 'public'.
          void notifyChannel(channelId, ch.name, 'public', event.created_at);
        }
      }
      return;
    }

    // Both comment representations (NIP-22 conflict resolution, see feed/comments.ts): kind-1111
    // comments (any non-note root) and hybrid kind-1 'stiq-comment' notes (root is a plain post —
    // the majority case, since ordinary user posts are Kind.Post). Hybrid comments do NOT carry
    // NIP-22 uppercase 'E'/'P' root tags — commentRootId()/commentRootAuthor() resolve the
    // root id/author across both shapes instead of reading an 'E'/'P' tag directly.
    // Notify when I authored the thread ROOT (reply to my post) OR the immediate PARENT (reply to my
    // comment, even inside someone else's thread) — mirrors deriveNotifications' widened gate. A
    // single `if` fires at most once per event, so root===me && parent===me still notifies exactly once.
    if ((event.kind === Kind.Comment || (event.kind === Kind.Post && isStiqComment(event))) && this.myPubkey) {
      // Exclude my own reply to my own post/comment (event.pubkey === me) — a self-reply must never notify me.
      const rootAuthorPubkey = commentRootAuthor(event);
      const parentAuthorPubkey = commentParentAuthor(event);
      const isForMe = rootAuthorPubkey === this.myPubkey || parentAuthorPubkey === this.myPubkey;
      // Resolve the real author from stiq_attr, never the throwaway event.pubkey a blind comment is
      // signed by — so my OWN reply is correctly skipped (its throwaway ≠ my npub) and a peer's push
      // carries their real display name instead of the blank "Someone replied". (Same rule as the
      // notification-centre derivation above and the embed-card fix.)
      const commenter = this.resolveIdentity(event);
      if (isForMe && commenter.pubkey !== this.myPubkey) {
        const rootId = commentRootId(event);
        if (rootId) {
          const rootItem = this.feedItemFor(rootId);
          const postType = rootItem ? this.postTypeOfFeedItem(rootItem) : undefined;
          void notifyComment(rootId, commenter.name ?? '', postType, event.created_at);
        }
      }
    }
  }

  /** The user's configured Blossom upload endpoint ('' = uploads disabled). */
  getBlossomEndpoint(): string {
    return this.mediaSettings.getEndpoint();
  }

  /** Persist a new Blossom upload endpoint (normalized; '' disables uploads). */
  async setBlossomEndpoint(url: string): Promise<void> {
    await this.mediaSettings.setEndpoint(url);
    this.emit(); // refresh any UI that reflects upload availability
  }

  /** The user's Tor connection preferences (mode + advanced overrides). */
  getTorConnectionPrefs(): TorConnectionPrefs {
    return this.torSettings.getPrefs();
  }

  /** Persist new Tor connection preferences (normalized). The caller triggers the reconnect. */
  async setTorConnectionPrefs(prefs: TorConnectionPrefs): Promise<void> {
    await this.torSettings.setPrefs(prefs);
    this.emit(); // refresh the Settings status row (mode label)
  }

  /** The user's preferred external browser launch id ('' = none chosen). */
  getPreferredBrowser(): string {
    return this.browserSettings.getPreferred();
  }

  /** Persist the preferred external browser (package id / scheme id; '' clears it). */
  async setPreferredBrowser(id: string): Promise<void> {
    await this.browserSettings.setPreferred(id);
    this.emit(); // refresh the Settings row + the hand-off resolution
  }

  // ── Fine-grained cache deletion (Settings → Storage → Manage data) ───────────────────────────────
  // The two knobs are TYPE (rendered media vs cached events) and DATE RANGE (older-than cutoff). All
  // three methods are SAFE BY CONSTRUCTION: rendered media is an in-memory RAM cache, and the event
  // path deletes ONLY non-exempt received feed events (nostr/cacheExempt.ts) — never identity keys,
  // the wallet, drafts, the outbox, DMs, joined groups, organizer config, or any durable state.

  /**
   * Clear the in-memory rendered-media cache (decoded inline pixel-art + Tor-fetched images) and
   * return how many entries were dropped. The SOURCE events are untouched — media re-renders on the
   * next tap (a remote image re-fetches over Tor). Mounted image/picture cards revert to their
   * placeholder via the cache's subscription.
   */
  clearRenderedMedia(): number {
    return clearRenderedMedia();
  }

  /**
   * Delete cached RECEIVED community feed events matching `opts` (non-exempt timeline kinds only),
   * refresh the feed, and return how many rows were removed. Never touches DMs, drafts, the outbox,
   * the wallet, identity keys, joined groups, organizer config, or any durable state — the store
   * enforces this structurally (see EventStore.deleteCachedEvents / nostr/cacheExempt.ts).
   */
  clearCachedEvents(opts: CacheDeleteOpts = {}): number {
    const removed = this.deps.store.deleteCachedEvents?.(opts) ?? 0;
    if (removed > 0) this.emit(); // the version bump already invalidated the feed cache; re-render it
    return removed;
  }

  /** Cheap preview for the Manage-data UI: how many cached deletable events match `opts` (0 when the
   *  store can't count). Never mutates. */
  cachedEventCount(opts: CacheDeleteOpts = {}): number {
    return this.deps.store.cachedEventCount?.(opts) ?? 0;
  }

  /**
   * Upload an image (base64) over Tor to the configured Blossom host. Returns the NIP-94 imeta
   * (url + sha256 + BlurHash) and remembers it so a subsequent post() referencing the URL
   * attaches the imeta tag automatically. Throws when uploads aren't configured/available.
   */
  /** imeta for any uploaded media whose URL appears in the post body. */
  private mediaForContent(content: string): ImageMeta[] {
    const out: ImageMeta[] = [];
    for (const [url, meta] of this.uploadedMedia) {
      if (content.includes(url)) {
        out.push(meta);
      }
    }
    return out;
  }

  // ── Optimistic compose placeholders (instant render before the blind draw+sign) ────────────────
  /** Fresh temp id for an optimistic compose placeholder (mirrors sendDM's echo id). */
  private localComposeId(): string {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Monotonic ceiling for own-post publish instants so two posts in the same ms still order. */
  private _lastOwnPostMs = 0;
  /**
   * LOCAL-ONLY, session-only map: (placeholder or real) event id → the true local instant (ms) the
   * viewer published one of their OWN posts. Fed to buildFeed → FeedItem.sortAt so the feed renders
   * your own rapid posts in the order you made them, even though each post's WIRE created_at is
   * bucket-fuzzed (blindPost.fuzzBlindCreatedAt, audit #48) and can therefore invert for posts made
   * seconds apart. This is derived purely from Date.now() and is NEVER written onto an event, sent to
   * a relay, or persisted — so the timing-correlation defense on the wire is fully intact.
   */
  private readonly _ownPostOrder = new Map<string, number>();

  /**
   * Record the true local publish order of one of OUR OWN posts, keyed by `id` (the compose
   * placeholder id at compose time; transferred onto the real event id when it signs). Strictly
   * monotonic — even two posts in the same millisecond get distinct, increasing keys — so a rapid
   * burst never ties. Bounded to the most recent 512 own posts (older entries fall back to createdAt,
   * cosmetically irrelevant by then).
   */
  private recordOwnPostOrder(id: string): void {
    const ms = Math.max(this._lastOwnPostMs + 1, Date.now());
    this._lastOwnPostMs = ms;
    this._ownPostOrder.set(id, ms);
    if (this._ownPostOrder.size > 512) {
      const oldest = this._ownPostOrder.keys().next().value;
      if (oldest !== undefined) this._ownPostOrder.delete(oldest);
    }
  }

  /**
   * LOCAL-ONLY, session-only map: real signed event id → the `local-…` placeholder id it replaced
   * (recorded at the swap in signPendingWrite, for EVERY write type in the union). Powers
   * {@link stableListKey}: a list keyed through it keeps the SAME React key across the
   * optimistic-placeholder → real-event id swap, so your just-sent comment / channel message /
   * group reply never unmounts+remounts (the visible "flicker" the feed already fixed via
   * FeedList.feedItemKey/sortAt — this is the same cure for every other list). Bounded like
   * _ownPostOrder; an evicted entry re-keys a row once, hundreds of items back, unnoticed.
   */
  private readonly _swapKeys = new Map<string, string>();

  /**
   * Stable React list key for an event id: the placeholder id this event replaced (if it was one of
   * our own optimistic writes) or the id itself. Arrow property so the function identity is stable
   * for the life of the runtime — safe to hand straight to keyExtractor-deriving props.
   */
  readonly stableListKey = (id: string): string => this._swapKeys.get(id) ?? id;

  /**
   * Render an optimistic placeholder Event from an unsigned template so the feed shows the write
   * INSTANTLY — before the (possibly seconds-long, Tor-bound) blind draw+sign. Authored by my pubkey
   * with a PLACEHOLDER signature: store.save renders it and `awaitingSign` drives its send ring, but
   * it is NEVER routed through the outbox / deliver() (its signature is invalid), exactly as sendDM
   * shows its echo without publishing an unsigned event. `reason` (T0.3) is calm copy shown next to a
   * 'failed' status — omitted for the default 'sending' render.
   */
  private renderPlaceholder(id: string, unsigned: UnsignedEvent, status: 'sending' | 'failed' = 'sending', reason?: string): void {
    const placeholder: Event = {...unsigned, id, pubkey: this.myPubkey ?? '', sig: ''};
    this.deps.store.save(placeholder);
    this.awaitingSign.set(id, {status, reason});
    this._awaitingSignVersion++;
    // Save + awaitingSign ran synchronously, so getSnapshot() ALREADY reflects the write — but the
    // getSnapshot→buildFeed rebuild that an emit triggers is heavy (full reaction/post/comment scan +
    // per-post work across the whole feed). On the old architecture render shares the JS thread with
    // touch dispatch, so running it synchronously here freezes the tap (UI-freeze A1). Defer it to the
    // next macrotask instead: the tap returns immediately and the optimistic highlight lands one frame
    // later. See scheduleOptimisticEmit.
    this.scheduleOptimisticEmit();
  }

  /** Pending next-macrotask emit for the optimistic-write placeholder path; cleared on dispose. */
  private _placeholderEmitTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Emit on the NEXT macrotask instead of synchronously — used by renderPlaceholder so a user's
   * optimistic write (vote/comment/post) never runs its full feed rebuild on the touch handler
   * (UI-freeze A1). Uses the same setTimeout(0) yield idiom as scheduleScorePass/warmKindChunked
   * (AppRuntime does not import react-native, so InteractionManager isn't available here). This is
   * NOT the throttled/scroll-parked relay path (emitDeferred): a user's own write must always land
   * promptly, so it is a plain one-tick coalesce — a burst of rapid placeholders folds into one
   * rebuild. Idempotent while a flush is already pending.
   */
  private scheduleOptimisticEmit(): void {
    if (this._placeholderEmitTimer !== undefined) return;
    this._placeholderEmitTimer = setTimeout(() => {
      this._placeholderEmitTimer = undefined;
      this.emit();
    }, 0);
    // Don't let this off-tap emit keep the process alive (mirrors scheduleScorePass).
    (this._placeholderEmitTimer as unknown as {unref?: () => void}).unref?.();
  }

  /** Drop an optimistic placeholder: remove the rendered event + its send indicator (caller emits). */
  private discardPlaceholder(id: string): void {
    this.deps.store.remove?.(id);
    this.awaitingSign.delete(id);
    this._awaitingSignVersion++;
  }

  /** Remove a post recovery intent from the in-memory queue by placeholder id (no persist). */
  private removeRecoveryIntent(id: string): void {
    const i = this.pendingPosts.findIndex(p => p.id === id);
    if (i >= 0) this.pendingPosts.splice(i, 1);
  }

  /**
   * Drop the current (outgoing) account's optimistic compose placeholders + its IN-MEMORY recovery
   * queue. Called on any account/community swap BEFORE the store swap (so A's un-signed placeholders
   * never linger into B's view) and on dispose. The PERSISTED per-account recovery queue
   * (pendingComposeKey) is untouched — it belongs to the outgoing account and is rehydrated when that
   * account is next active (loadPendingCompose in loadWorkspaceState).
   */
  private clearComposePlaceholders(): void {
    for (const id of this.awaitingSign.keys()) this.deps.store.remove?.(id);
    this.awaitingSign.clear();
    this._awaitingSignVersion++;
    this.pendingPosts.length = 0;
  }

  /** Cached merge of the last sendStatusSnapshot() build, keyed on the (outbox, awaitingSign)
   *  mutation-version pair it was built from — see sendStatusSnapshot(). */
  private _sendStatusCache: {outboxVersion: number; awaitingSignVersion: number; value: Map<string, SendStatus>} | undefined;

  /**
   * Outbox send statuses merged with the optimistic compose placeholders' (see awaitingSign), for
   * the snapshot's `sendStatus`. outbox.statuses() is now version-cached and SHARED (P2-2 / C2), so
   * it must never be mutated here; this builds its own copy, but ONLY when either the outbox or
   * awaitingSign has actually mutated since the last call — otherwise it returns the same Map
   * instance as last time, so an unrelated emit doesn't change `sendStatus`'s identity and defeat
   * FeedList's `React.memo`'d cells.
   */
  private sendStatusSnapshot(): Map<string, SendStatus> {
    const outboxVersion = this.outbox.version();
    const cached = this._sendStatusCache;
    if (cached && cached.outboxVersion === outboxVersion && cached.awaitingSignVersion === this._awaitingSignVersion) {
      return cached.value;
    }
    const statuses = new Map(this.outbox.statuses());
    for (const [id, entry] of this.awaitingSign) statuses.set(id, entry.status);
    this._sendStatusCache = {outboxVersion, awaitingSignVersion: this._awaitingSignVersion, value: statuses};
    return statuses;
  }

  /** Cached merge of the last sendReasonsSnapshot() build — same (outbox, awaitingSign) version pair as
   *  sendStatusSnapshot's cache (see it for why this is cached at all). */
  private _sendReasonsCache: {outboxVersion: number; awaitingSignVersion: number; value: Map<string, string>} | undefined;

  /**
   * Outbox rejection reasons (Outbox.reason) merged with the optimistic compose placeholders' calm
   * exhaustion reason (awaitingSign, T0.3), for the snapshot's `sendReasons` — mirrors
   * sendStatusSnapshot's merge + cache shape exactly, so a feed/comment/channel/group write that fails
   * at SIGN time (before it ever reaches the outbox) shows a reason next to its "failed" ring instead
   * of a bare, unexplained ✕ (F3/F4).
   */
  private sendReasonsSnapshot(): Map<string, string> {
    const outboxVersion = this.outbox.version();
    const cached = this._sendReasonsCache;
    if (cached && cached.outboxVersion === outboxVersion && cached.awaitingSignVersion === this._awaitingSignVersion) {
      return cached.value;
    }
    const reasons = new Map(this.outbox.reasons());
    // Token-family rejections recorded while the last draw TIMED OUT get the transport-honest copy
    // instead of "You're out of tokens" (2026-07-28 outage: EVENT frames rode the surviving WS while
    // draws died, so a send could reach the relay token-less and be rejected as a quota problem the
    // member didn't have). Recency check matches exhaustionReason's TTL. Evaluated at snapshot time,
    // so the substitution follows the same cache invalidation as the reasons themselves — a TTL
    // expiry alone doesn't rebuild the cache, which is acceptable: the next outbox/sign change does.
    const f = this._lastDrawFailure;
    if (f?.timedOut && Date.now() - f.at < AppRuntime.DRAW_FAILURE_REASON_TTL_MS) {
      for (const [id, reason] of reasons) {
        if (isTokenFamilyRejection(reason)) reasons.set(id, DRAW_TIMEOUT_TOKEN_REASON);
      }
    }
    for (const [id, entry] of this.awaitingSign) {
      if (entry.reason !== undefined) reasons.set(id, entry.reason);
    }
    this._sendReasonsCache = {outboxVersion, awaitingSignVersion: this._awaitingSignVersion, value: reasons};
    return reasons;
  }

  /** Persist the ACTIVE account's post recovery queue under its slot-scoped ENCRYPTED key (the body
   *  is sensitive — never a global/plaintext key). Best-effort; never throws. */
  private async persistPendingCompose(): Promise<void> {
    const storage = this.deps.secureStorage;
    const slotId = this.activeSlotId;
    if (!storage || !slotId) return; // un-enrolled/legacy → nothing durable to persist
    try {
      if (this.pendingPosts.length) {
        await storage.setItem(pendingComposeKey(slotId), JSON.stringify(this.pendingPosts));
      } else {
        await storage.removeItem(pendingComposeKey(slotId));
      }
    } catch {
      // best effort — a lost write only costs re-recovering on the next post
    }
  }

  /**
   * Rehydrate this account's durable post recovery queue on cold load / switch-back, re-rendering
   * each failed post's placeholder (with Retry) so it shows immediately — mirrors loadSentMessages
   * for DMs. Only the MATCHING slot's queue is read (per-account key). Best-effort; never throws.
   */
  private async loadPendingCompose(slotId?: string): Promise<void> {
    const storage = this.deps.secureStorage;
    if (!storage || !slotId) return;
    try {
      const raw = await storage.getItem(pendingComposeKey(slotId));
      if (!raw) return;
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return;
      for (const raw2 of arr as unknown[]) {
        const it = this.coercePendingWrite(raw2);
        if (!it) continue;
        this.pendingPosts.push(it);
        try {
          // Re-render the failed placeholder from the SAME per-type builder the live path uses
          // (unsignedForPending) so a recovered comment/pinned rehydrates as itself, not as a post.
          // Every persisted entry got here via signPendingWrite's BlindTokensExhausted catch, so the
          // SAME calm reason applies (T0.3) — reused via a throwaway instance rather than a duplicated
          // literal, so the two stay byte-identical if the message ever changes.
          this.renderPlaceholder(it.id, this.unsignedForPending(it), 'failed', new BlindTokensExhausted().message); // store.save dedupes if already cached
        } catch {
          // an unbuildable (e.g. empty / malformed) intent just isn't re-rendered — harmless
        }
      }
    } catch {
      // ignore a corrupt/absent queue
    }
  }

  /**
   * Validate + normalize one persisted recovery-queue entry into a typed PendingWrite, or null if it's
   * malformed. Defends the drain/rehydrate path against a corrupt blob: a `comment` intent must carry
   * valid root + parent refs, a `pinned` intent a valid postRef, a `channel`/`channelEdit` intent a
   * channelId (+ originalId for the edit), a `group`/`groupEdit`/`groupReply` intent a groupId (+
   * originalId / parentId for the edit / reply); anything else (including a legacy entry with no
   * `type`) is treated as a post. Never throws.
   *
   * The post FALLTHROUGH is why every type needs its own branch here, and why a missing one would be
   * worse than a crash: an unrecognised `type` is not rejected, it is silently rebuilt as a kind-1
   * note. A `channel`/`group` intent with no branch would therefore recover from a restart by
   * publishing the broadcast/message into the PUBLIC FEED — right body, right author, wrong surface, no
   * error anywhere.
   */
  private coercePendingWrite(raw: unknown): PendingWrite | null {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.id !== 'string' || typeof it.content !== 'string') return null;
    // `blobIds` must survive a restart intact or a recovered picture post could publish while its
    // blobs stay behind — so a non-array, or an array with a non-string in it, is rejected wholesale
    // rather than silently narrowed to the entries that happened to parse.
    const blobIds =
      Array.isArray(it.blobIds) && it.blobIds.every(v => typeof v === 'string')
        ? (it.blobIds as string[])
        : undefined;
    const base = {
      id: it.id,
      content: it.content,
      cid: typeof it.cid === 'string' ? it.cid : undefined,
      slotId: typeof it.slotId === 'string' ? it.slotId : undefined,
      ...(blobIds && blobIds.length > 0 ? {blobIds} : {}),
    };
    const asRef = (v: unknown): EventRef | null => {
      if (!v || typeof v !== 'object') return null;
      const r = v as Record<string, unknown>;
      return typeof r.id === 'string' && typeof r.pubkey === 'string' && typeof r.kind === 'number'
        ? {id: r.id, pubkey: r.pubkey, kind: r.kind}
        : null;
    };
    if (it.type === 'comment') {
      const root = asRef(it.root);
      const parent = asRef(it.parent);
      return root && parent ? {...base, type: 'comment', root, parent} : null;
    }
    if (it.type === 'pinned') {
      const postRef = asRef(it.postRef);
      return postRef ? {...base, type: 'pinned', postRef} : null;
    }
    if (it.type === 'channel') {
      // No channelId ⇒ unaddressable: reject rather than fall through to the post branch below,
      // which would republish a broadcast as a feed post (see this method's doc).
      return typeof it.channelId === 'string' && it.channelId
        ? {...base, type: 'channel', channelId: it.channelId}
        : null;
    }
    if (it.type === 'channelEdit') {
      // promotedFeedId must survive rehydration too — it's what unsignedForPending uses to re-append
      // the ['promoted', feedId] tag (withPromotedTag) on the REAL signed edit, not just the
      // placeholder. Dropping it here would silently strip the tag from a promote-edit that survives
      // a restart (see promoteChannelPost / PendingChannelEditWrite.promotedFeedId).
      return typeof it.channelId === 'string' && it.channelId && typeof it.originalId === 'string' && it.originalId
        ? {
            ...base,
            type: 'channelEdit',
            channelId: it.channelId,
            originalId: it.originalId,
            promotedFeedId: typeof it.promotedFeedId === 'string' ? it.promotedFeedId : undefined,
          }
        : null;
    }
    if (it.type === 'group') {
      // No groupId ⇒ unaddressable: reject rather than fall through to the post branch below, which
      // would publish a private/group message straight into the PUBLIC FEED (see this method's doc).
      return typeof it.groupId === 'string' && it.groupId
        ? {...base, type: 'group', groupId: it.groupId, replyTo: typeof it.replyTo === 'string' ? it.replyTo : undefined}
        : null;
    }
    if (it.type === 'groupEdit') {
      // Same reasoning as the channelEdit branch above — promotedFeedId must survive rehydration.
      return typeof it.groupId === 'string' && it.groupId && typeof it.originalId === 'string' && it.originalId
        ? {
            ...base,
            type: 'groupEdit',
            groupId: it.groupId,
            originalId: it.originalId,
            promotedFeedId: typeof it.promotedFeedId === 'string' ? it.promotedFeedId : undefined,
          }
        : null;
    }
    if (it.type === 'groupReply') {
      return typeof it.groupId === 'string' && it.groupId && typeof it.parentId === 'string' && it.parentId
        ? {...base, type: 'groupReply', groupId: it.groupId, parentId: it.parentId}
        : null;
    }
    if (it.type === 'reaction') {
      // Malformed ⇒ reject rather than fall through to the post branch below, which would publish a
      // reaction's bare content as a public feed NOTE (same rationale as channel/group above).
      const scope = it.scope === 'feed' || it.scope === 'channel' || it.scope === 'group' ? it.scope : null;
      return scope && typeof it.targetId === 'string' && it.targetId && typeof it.targetPubkey === 'string' && it.targetPubkey
        ? {
            ...base,
            type: 'reaction',
            scope,
            targetId: it.targetId,
            targetPubkey: it.targetPubkey,
            groupId: typeof it.groupId === 'string' ? it.groupId : undefined,
          }
        : null;
    }
    // promoteSource must survive rehydration too, or a promoted feed post queued during a drought
    // that outlives the app process would come back after restart as a PLAIN post — signPendingWrite
    // would have no recipe left to chain the source channel/group edit off of once this post signs,
    // silently dropping step 2 forever with no error anywhere (mirrors the channelEdit/groupEdit
    // promotedFeedId reasoning right above).
    const rawSrc = it.promoteSource && typeof it.promoteSource === 'object' ? (it.promoteSource as Record<string, unknown>) : null;
    const promoteSource =
      rawSrc &&
      (rawSrc.kind === 'channel' || rawSrc.kind === 'group') &&
      typeof rawSrc.originalId === 'string' &&
      rawSrc.originalId &&
      typeof rawSrc.content === 'string' &&
      (rawSrc.kind === 'channel' ? typeof rawSrc.channelId === 'string' && rawSrc.channelId : typeof rawSrc.groupId === 'string' && rawSrc.groupId)
        ? {
            kind: rawSrc.kind as 'channel' | 'group',
            channelId: typeof rawSrc.channelId === 'string' ? rawSrc.channelId : undefined,
            groupId: typeof rawSrc.groupId === 'string' ? rawSrc.groupId : undefined,
            originalId: rawSrc.originalId as string,
            content: rawSrc.content as string,
          }
        : undefined;
    return {
      ...base,
      type: 'post',
      tags: Array.isArray(it.tags) ? (it.tags as string[]) : [],
      title: typeof it.title === 'string' ? it.title : undefined,
      label: it.label as PostLabel | undefined,
      contentWarning: typeof it.contentWarning === 'string' ? it.contentWarning : undefined,
      ...(promoteSource ? {promoteSource} : {}),
    };
  }

  async post(content: string, tags: string[] = [], title?: string, label?: PostLabel, contentWarning?: string): Promise<void> {
    if (!this.identity) {
      return;
    }
    // Publish-durability FIX (#3/#5) — reorder so the post is RENDERED + durable BEFORE the blind
    // draw+sign, which can await a token draw over Tor for seconds. The old order awaited the sign
    // FIRST, so a fresh empty wallet blocked the UI with no optimistic item + no send bar, and a
    // failure/pull-refresh mid-draw lost the post (it lived only in an in-memory queue). Now:
    //   1) build the unsigned template (throws on empty content — reject before rendering anything),
    //   2) render a durable placeholder + 'sending' ring INSTANTLY,
    //   3) draw+sign AFTER (awaited in this async body). This method's OWN returned promise therefore
    //      still only settles once the whole draw settles — callers that want the true outcome (tests,
    //      comment()/setPinnedComment()'s own callers) can still await it. The COMPOSER, however, does
    //      NOT await this promise: App.tsx's onSubmit wrapper calls post() fire-and-forget (attaches
    //      only a `.catch` for the Alert, per postFailureAlert) precisely so the multi-second draw
    //      below never blocks the composer's "Posting…" overlay — the durable placeholder rendered
    //      just below is already enough for the composer to close. (A prior version of this comment
    //      claimed that fire-and-forget wiring existed here already, in App.tsx — it did not; App.tsx
    //      used to `await` this promise and hold the composer hostage to the whole draw. That was the
    //      "publish tap hangs for seconds" bug; the fix lives in App.tsx's onSubmit, not here.) The
    //      (cid, slotId) captured here is the silo guard: a switch during the draw drops the write
    //      instead of leaking A's post into B.
    //
    // `content` arrives fully reassembled (ComposerScreen.doPublish resolves its mediaRefs
    // placeholders back to real base64 before calling onSubmit), so any inline picture/voice bytes
    // are in hand HERE. Splitting them out into blob events (LAZY_MEDIA_BLOBS) nevertheless happens
    // one level down, in signPendingWrite → mintMediaBlobs, and deliberately so: (a) it must run
    // AFTER the placeholder below, or the author would wait on a Tor token draw to see their own
    // post — the exact stall this round removed; and (b) signPendingWrite is also the RECOVERY entry
    // point (drainPendingPosts), so putting it there means a post recovered after a restart splits
    // by the same code as a fresh one instead of a second, drifting copy. The placeholder therefore
    // renders from the INLINE body (instant, bytes already local) while the wire event references
    // blobs — which is invisible to the author, whose blobs are saved locally at mint time.
    const body = this.withMyName(content);
    // A title makes it a NIP-23 long-form article (kind 30023); otherwise a plain kind-1 note.
    const unsigned = title
      ? buildArticle(title, body, tags, undefined, label)
      : buildPost(body, tags, this.mediaForContent(content), contentWarning, label);
    const intent: PendingPostWrite = {
      type: 'post',
      id: this.localComposeId(),
      content,
      tags,
      title,
      label,
      contentWarning,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    // Capture the true local publish order NOW (before the seconds-long Tor draw) so the optimistic
    // placeholder — and the real event it becomes — sort by when you actually posted, not by the
    // bucket-fuzzed wire created_at. Local-only; see recordOwnPostOrder / _ownPostOrder.
    this.recordOwnPostOrder(intent.id);
    await this.queuePendingWrite(intent, unsigned);
  }

  /**
   * Shared tail of every {@link PendingWrite} send (T4.3): render the optimistic placeholder, then
   * hand the intent to {@link signPendingWrite} for the draw+sign — which owns the ENTIRE durable
   * treatment (silo guard, 'failed'+Retry+calm-reason on a BlindTokensExhausted drought, queueing for
   * drainPendingPosts, same-event outbox retry on a relay reject). Every send type in the union
   * (post/comment/pinned/channel broadcast+edit/group post+edit+reply) used to repeat this exact two-
   * line sequence at its own call site — copy-pasted, not shared, which is how F2/F3 happened (one
   * copy got the fix, the others didn't). Routing every call site through this ONE method means a
   * future write type inherits the full treatment by construction instead of by remembering to copy
   * it right.
   *
   * `unsigned`, when passed, is used AS-IS for the placeholder instead of re-deriving it via
   * {@link unsignedForPending} — post() already builds its unsigned template once (to size/attach
   * media) and reuses it here rather than paying to rebuild an identical one.
   */
  private async queuePendingWrite(intent: PendingWrite, unsigned?: UnsignedEvent): Promise<void> {
    this.noteWriteQueued(intent.id, intent.type ?? 'post'); // perf: lifecycle timeline starts here
    this.renderPlaceholder(intent.id, unsigned ?? this.unsignedForPending(intent));
    await this.signPendingWrite(intent);
  }

  /**
   * Draw+sign a queued write's placeholder `intent.id` (the Tor-bound draw happens HERE, after the
   * optimistic render), then SWAP it for the real signed event — or, on a final token exhaustion,
   * leave it 'failed' (Retry) and keep its intent queued for auto-recovery. Handles every write type in
   * the union (post / comment / pinned / channel broadcast+edit / group post+edit+reply); ONLY the sign
   * step differs per type (see signPendingEvent), everything else — silo guard, swap, publish,
   * durable-on-failure — is shared. A BLIND write's draw is its own signature's; a bound-npub SPACE
   * write (channel/group) can reach exhaustion TWO ways — its own signature's space-write spend
   * (spaceTokenTagsFor, once space_tokens_required is on) and, for a channel broadcast, its media's
   * separate post-wallet draw (mintMediaBlobs) — but from here on down neither distinction matters,
   * which is the point of them all queueing here (T0.2/T0.3).
   * feedSigner (its getter) already draws-and-retries once internally; a BlindTokensExhausted here
   * means that draw failed too (offline / per-epoch cap hit). RE-THROWS on final exhaustion — the
   * blindSilo.regression.test.ts contract depends on the caller (post/comment/setPinnedComment)
   * rejecting. post()'s OWN promise still carries that rejection (unchanged) — what changed is that
   * the COMPOSER stopped awaiting post()'s promise (see post()'s comment + App.tsx's onSubmit, which
   * now calls post() fire-and-forget and routes a rejection to the one-shot Alert itself via
   * postFailureAlert, instead of relying on the composer's `await` to surface it).
   *
   * MANDATORY SILO GUARD: `intent.cid`/`intent.slotId` were captured BEFORE the (seconds-long) draw.
   * If the active pair changed (a community/account switch happened mid-draw), DROP: never deliver
   * A's write into B (wrong attribution + a cross-silo identity link). This is the same invariant
   * drainPendingPosts enforces; without it the reorder would REINTRODUCE a cross-account leak. It is
   * checked TWICE — once after minting this write's media blobs and once after signing the event —
   * because minting draws tokens over Tor too, and A's picture bytes must no more land in B's store
   * than A's post must land in B's feed.
   *
   * LAZY MEDIA BLOBS (ON since 2026-07-15): the body's inline media is split out into its own blob events
   * first (mintMediaBlobs), and the post is then published with a DELIVERY DEPENDENCY on them
   * (publishOptimistic's `dependsOn` → deliver()'s gate), so a post is never sent to the relay ahead
   * of the picture it shows. Flag off ⇒ mintMediaBlobs is a no-op and `dependsOn` is empty, so this
   * method behaves byte-identically to pre-2026-07-15 (the supported rollback).
   */
  private async signPendingWrite(intent: PendingWrite): Promise<void> {
    try {
      // Split this body's inline media out into their own blob events BEFORE signing the post, so
      // the post's body can reference blobs that provably exist. Byte-identical no-op with
      // LAZY_MEDIA_BLOBS off (or no media in the body): `intent` is not touched and no blob is
      // signed, so everything below runs on exactly the content it always did.
      await this.mintMediaBlobs(intent);
      // Silo guard, first of two — minting can DRAW blind tokens over Tor, which takes seconds, so a
      // switch can land here just as easily as during the post's own draw below. Bail before signing
      // the post rather than spending B's identity on A's write; the same guard body runs below.
      if (intent.cid !== this.activeCid || intent.slotId !== this.activeSlotId) {
        this._writeTimeline.delete(intent.id); // perf: write abandoned (silo switch) — nothing to time
        this.dropMintedBlobs(intent);
        this.discardPlaceholder(intent.id);
        this.removeRecoveryIntent(intent.id);
        this.emit();
        await this.persistPendingCompose();
        return;
      }
      const event = await this.signPendingEvent(intent);
      this.noteWriteSigned(intent.id, event.id); // perf: queue→sign delta, re-keyed to the real event id
      // Silo guard — re-check the captured (community, account) is still active after the draw.
      if (intent.cid !== this.activeCid || intent.slotId !== this.activeSlotId) {
        this._writeTimeline.delete(event.id); // perf: write abandoned (silo switch) — nothing to time
        this.dropMintedBlobs(intent); // never leave A's media bytes sitting in B's store
        // Switched away mid-draw: drop the write. clearComposePlaceholders already purged the
        // placeholder from A's (swapped-away) store; this remove is a no-op on the new store (belt-
        // and-braces). Never deliver `event` into the now-active account.
        this.discardPlaceholder(intent.id);
        this.removeRecoveryIntent(intent.id);
        this.emit();
        await this.persistPendingCompose();
        return;
      }
      // Resolve this write's blobs BEFORE anything is swapped or published, so the strict check
      // inside mintedBlobs can still fail the write cleanly (nothing published, placeholder intact
      // for the catch to drop). Empty for every write with no blobs — i.e. every write, flag off.
      const mediaBlobs = this.mintedBlobs(intent);
      // Swap: drop the placeholder, then publish the REAL signed event (→ outbox + deliver). Keeping
      // publishOptimistic the LAST await preserves the deliver()-before-caller-continuation microtask
      // ordering the optimistic tests rely on.
      this.discardPlaceholder(intent.id);
      this.removeRecoveryIntent(intent.id);
      // Carry the placeholder's local publish-order key onto the REAL event id so the placeholder→real
      // swap keeps the SAME sort position — no downward jump when the fuzzed created_at lands.
      const seq = this._ownPostOrder.get(intent.id);
      if (seq !== undefined) {
        this._ownPostOrder.set(event.id, seq);
        this._ownPostOrder.delete(intent.id);
      }
      // Remember which placeholder this real id replaced so list keys survive the swap (see
      // stableListKey) — for every write type, not just feed posts.
      this._swapKeys.set(event.id, intent.id);
      if (this._swapKeys.size > 512) {
        const oldest = this._swapKeys.keys().next().value;
        if (oldest !== undefined) this._swapKeys.delete(oldest);
      }
      // Queue this write's media blobs FIRST and make the post's delivery DEPEND on theirs (see
      // publishOptimistic's `dependsOn` + deliver()'s gate): the post is not sent to the relay until
      // every blob it references has landed there, so a reader can never meet a post whose picture
      // does not exist. Both rounds are optimistic — the blobs are already in the local store, so the
      // author's own picture renders instantly off `peek()` with no fetch — and both ride the SAME
      // durable outbox, so a crash between them recovers exactly as a plain post does.
      // No-op with LAZY_MEDIA_BLOBS off: `blobIds` is empty, `mintedBlobs` is [], and
      // `publishOptimistic(event, [])` is byte-identical to `publishOptimistic(event)`.
      for (const blob of mediaBlobs) {
        await this.publishOptimistic(blob);
      }
      // Mark this post as worth confirming out loud if it lands (see announceOnConfirm). The blob
      // loop above deliberately registers NOTHING — a blob is not the post, and it lands first.
      //
      // Registered BEFORE publishing rather than after — deliberately, though not observably.
      // publishOptimistic fires deliver() off unawaited and confirmDelivery only announces ids it
      // already knows, so a confirmation arriving before this line would be dropped in silence. That
      // cannot happen today: deliver() yields twice (applySendJitter, then the publish itself) before
      // it can confirm, so this function always resumes first — a mutant swapping these two lines
      // passes the whole suite. But that is an accident of the call graph, not a contract anything
      // defends, and it would change silently. Registering first costs nothing and doesn't rely on it.
      if ((intent.type ?? 'post') === 'post') this.announceOnConfirm.add(event.id);
      // Every blob is now IN the outbox, which is what makes deliver()'s "an id the outbox no longer
      // knows was delivered and swept" rule sound for this post's dependencies.
      await this.publishOptimistic(event, intent.blobIds);
      // Meter the picture allowance off the (possibly blob-rewritten) body. Unchanged either way:
      // a blob reference carries its payload's real size in the token's `w=` field, so
      // extractInlinePictures' weightBytes reports the SAME bytes it reported when they rode inline
      // (see feed/mediaBlob.ts payloadWeightBytes — the whole reason `w=` exists).
      this.accountPictures(intent.content);
      // promoteChannelPost's step 2 (T4.4): THIS feed post just signed — live, or (rehydrated via
      // coercePendingWrite) after a restart that outlived the whole drought. Either way, `event.id` is
      // now known, so derive and queue the source channel/group's in-place 'promoted' edit off
      // `promoteSource` — the SAME durable 'channelEdit'/'groupEdit' variant a plain author edit uses,
      // via its promotedFeedId field, so it gets its OWN full placeholder/failed/Retry/drainPendingPosts
      // treatment independent of this post's. Wrapped in its own try/catch: a drought on THIS half
      // (signPendingWrite's own recursive call already queues + persists it as 'failed' before
      // rethrowing) must never be mistaken for a failure of the feed post that already landed above.
      const promoteSource = (intent as PendingPostWrite).promoteSource;
      if (promoteSource) {
        const editIntent: PendingChannelEditWrite | PendingGroupEditWrite =
          promoteSource.kind === 'channel'
            ? {
                type: 'channelEdit',
                id: this.localComposeId(),
                channelId: promoteSource.channelId!,
                originalId: promoteSource.originalId,
                content: promoteSource.content,
                promotedFeedId: event.id,
                cid: intent.cid,
                slotId: intent.slotId,
              }
            : {
                type: 'groupEdit',
                id: this.localComposeId(),
                groupId: promoteSource.groupId!,
                originalId: promoteSource.originalId,
                content: promoteSource.content,
                promotedFeedId: event.id,
                cid: intent.cid,
                slotId: intent.slotId,
              };
        try {
          await this.queuePendingWrite(editIntent);
        } catch {
          // Durable on its own (queued + persisted 'failed'+Retry by the recursive signPendingWrite
          // call above) — swallow here so a drought on the EDIT half never fails the feed post's own
          // promise, which already succeeded.
        }
      }
      await this.persistPendingCompose();
    } catch (e) {
      if (e instanceof BlindTokensExhausted) {
        // Durable: keep the placeholder rendered as 'failed' (Retry) and queue the intent for auto-
        // recovery (drainPendingPosts, called on reconnect / drawTokens / pull-to-refresh). The write
        // is NEVER lost — it's rendered, has a Retry, and its raw params are persisted per-account.
        // The calm reason (T0.3) rides along so feed/comment/channel/group exhaustion shows WHY, not
        // a bare "failed" — see sendReasonsSnapshot.
        // T5.1/F18: a diagnostic-only line (the ring buffer already covers draw-resume/C5/media
        // events — this was the one gap, since exhaustion previously only ever THREW, never logged).
        // Purely additive: no effect on the durable-queue behavior below.
        log.warn('wallet', `${intent.type ?? 'post'} write exhausted its ${e.purpose ?? 'post'} tokens — queued for retry`);
        // exhaustionReason, not e.message: when the wallet is empty because the community's keys
        // changed (stale-key draw failures), the placeholder says THAT — not "check your connection".
        this.awaitingSign.set(intent.id, {status: 'failed', reason: this.exhaustionReason(e)});
        this._awaitingSignVersion++;
        if (!this.pendingPosts.some(p => p.id === intent.id)) this.pendingPosts.push(intent);
        this.emit();
        await this.persistPendingCompose();
      } else {
        // Any OTHER error (empty content, community-key mismatch, …) is not a token issue: drop the
        // optimistic placeholder and propagate exactly as before. Any blob minted before the throw
        // goes with it — nothing will ever reference it now, and none of them were published.
        this._writeTimeline.delete(intent.id); // perf: write truly abandoned — nothing to time
        this.dropMintedBlobs(intent);
        this.discardPlaceholder(intent.id);
        this.removeRecoveryIntent(intent.id);
        this.emit();
        await this.persistPendingCompose();
      }
      throw e;
    }
  }

  /**
   * Draw+sign the real event for a queued write, per its type. A POST goes through the blind publish
   * assembly (throwaway-attributed, fuzzed created_at); a COMMENT / PINNED comment is attributable and
   * signed via feedSigner over the same unsigned template the placeholder was built from (see
   * unsignedForPending). This is the ONLY per-type branch in the pending-write pipeline.
   *
   * CHANNEL (broadcast/edit) and GROUP (post/edit/reply) writes are signed by the BOUND NPUB rather
   * than feedSigner, and that is not an oversight to tidy up later: the relay's GroupGuard authorises
   * these kinds by the author's role/membership, and handleBlindPost REJECTS a token-bearing one
   * outright (e.g. "not permitted on the blind-post token path" for 1311) precisely so nobody can
   * launder one past those role checks behind a throwaway key. Signing them blind would make every one
   * of them unpublishable. A bound-npub signature is not tokenless, though (T0.2/T0.3): the `identity`
   * pre-sign hook (spaceTokenTagsFor) still attaches a space-write token proof to it once the relay
   * requires one — see PendingChannelWrite's doc. A channel broadcast's MEDIA additionally splits into
   * blind blobs — those are kind-30351 events with their own signer, decided in mintMediaBlobs and
   * wholly independent of what signs the body that references them.
   */
  private signPendingEvent(intent: PendingWrite): Promise<Event> {
    if (intent.type === 'comment') {
      return this.feedSigner.sign(buildPostComment(this.withMyName(intent.content), intent.root, intent.parent));
    }
    if (intent.type === 'pinned') {
      return this.feedSigner.sign(buildPinnedComment(intent.content, intent.postRef));
    }
    if (intent.type === 'reaction') {
      const unsigned = this.unsignedForPending(intent);
      // 'feed'/'channel' ride the SAME blind path a vote always has (feedSigner). 'group' is npub-
      // signed (GroupGuard) with a bearer posting token attached when the relay demands one and space
      // tokens haven't taken over — exactly what reactToGroupMessage did inline before this pipeline.
      if (intent.scope !== 'group') return this.feedSigner.sign(unsigned);
      return this.bearerReactionTokenTags(unsigned).then(bearer =>
        this.identity!.sign(bearer ? {...unsigned, tags: [...unsigned.tags, ...bearer]} : unsigned),
      );
    }
    if (
      intent.type === 'channel' ||
      intent.type === 'channelEdit' ||
      intent.type === 'group' ||
      intent.type === 'groupEdit' ||
      intent.type === 'groupReply'
    ) {
      return this.identity!.sign(this.unsignedForPending(intent));
    }
    const body = this.withMyName(intent.content);
    return intent.title
      ? publishArticle(this.feedSigner, intent.title, body, intent.tags, undefined, intent.label)
      : publishPost(this.feedSigner, body, intent.tags, this.mediaForContent(intent.content), intent.contentWarning, intent.label);
  }

  // ── lazy media blobs: publish-side split (gated on LAZY_MEDIA_BLOBS; ON since 2026-07-15) ──────

  /**
   * The payloads {@link mintMediaBlobs} would move out of `content`, in body order — a DRY RUN that
   * signs, stores and publishes nothing.
   *
   * It collects them through mediaBlob's ONE token grammar: re-deriving that grammar here with a
   * second regex is exactly the divergent re-implementation this codebase keeps re-learning, so
   * instead we run the real splitter with a throwaway signer and discard the body it produces. Cheap
   * next to the Tor draw the real mint then does, and it is what lets the split stay ASYNC (the blind
   * draw is) behind splitMediaBlobs' synchronous `signBlob` seam.
   *
   * Empty — without even running the regex — whenever LAZY_MEDIA_BLOBS is off, since
   * splitMediaBlobsIfEnabled short-circuits before touching the body. That is what keeps this free on
   * the send tap for every caller in the flag-off build.
   */
  private blobPayloadsFor(content: string): string[] {
    const payloads: string[] = [];
    splitMediaBlobsIfEnabled(content, (blob: UnsignedMediaBlob) => {
      payloads.push(blob.content);
      return MINT_PROBE_BLOB;
    });
    return payloads;
  }

  /**
   * Whether this community can mint blobs AT ALL — i.e. whether the blind signer is live. Only it
   * mints the fresh throwaway key per event that an addressable, tagless kind-30351 blob must have to
   * avoid silently replacing its siblings; see {@link mintMediaBlobs}. False ⇒ media stays inline.
   */
  private get canMintMediaBlobs(): boolean {
    return !!this.contentSigner && !!getActiveCommunityKey();
  }

  /**
   * Move every inline media payload in `intent.content` out into its OWN blob event (kind 30351,
   * feed/mediaBlob.ts), rewriting the body to reference them. Mutates `intent` in place — `content`
   * becomes the referencing body and `blobIds` records the blobs, so the whole durable recovery
   * pipeline (persistPendingCompose → loadPendingCompose → unsignedForPending → drainPendingPosts)
   * carries the split forward with no extra bookkeeping and re-entry is a no-op.
   *
   * NO-OP, byte-identical to pre-2026-07-15, when LAZY_MEDIA_BLOBS is off, when the body carries no inline
   * media, or when the body was already split (a re-queued intent) — in every one of those cases
   * `intent` is returned untouched and not a single blob is signed.
   *
   * ## Every blob gets its OWN throwaway key. This is not a nicety.
   *
   * Kind 30351 sits in NIP-01's ADDRESSABLE range (30000-39999), where a relay keeps only the newest
   * event per (kind, pubkey, d-tag) — and a blob is deliberately TAGLESS, so its d-tag is ''. Two
   * blobs signed by the SAME key are therefore the same address: the second SILENTLY DELETES the
   * first, and a two-picture post loses a picture with nothing anywhere reporting an error. The
   * client's own store agrees (`isReplaceableOrAddressable` covers the same range, so COMPACTION_V2's
   * pruneSupersededReplaceable would collapse them locally too). Distinct keys are what make a
   * multi-picture post possible at all.
   *
   * The blind signer gives that for free and is the ONLY signer here that does: a blind event is
   * signed by its spent token's own secret, so `event.pubkey === hex(token0.token)` (blindPost.ts
   * assembleBlindEvent), and a token is spent exactly once — one fresh key per blob, by construction.
   * The npub FALLBACK does not: with no community key loaded, BlindSigner delegates to plain identity
   * signing and every blob this device ever made would share the one real npub. So an un-blind
   * community keeps its media INLINE (today's behaviour, first-class forever on the read path) rather
   * than publishing blobs that eat each other — see the guard below. Distinctness is then ASSERTED,
   * not assumed: the check in the sign loop is the invariant; this comment is only its explanation.
   *
   * ## The blob's signer is NOT the referencing event's signer
   *
   * This method signs every blob with `feedSigner`, whatever `intent` is. That is why a CHANNEL
   * broadcast can split its media even though the broadcast itself is signed by the bound npub
   * (signPendingEvent): a blob is a SEPARATE kind-30351 event, and the relay gates it on ITS OWN kind,
   * not on the kind of whatever references it. So the unique-key property survives the mix intact —
   * the 1311 keeps its bound npub and GroupGuard's role check, the blobs keep their per-token
   * throwaway keys, and neither constrains the other. "This surface is bound-npub, therefore its media
   * can't have unique keys" is a category error: it conflates the two events.
   *
   * What DOES follow from the mix is a real cost worth naming: a broadcast's pictures now spend blind
   * tokens, where inline ones spent none. That is the same budget a feed picture already spends, and a
   * drought degrades identically (placeholder → 'failed' → Retry → drainPendingPosts), because
   * PendingChannelWrite routes broadcasts through exactly that machinery.
   *
   * Relay note (must be true before LAZY_MEDIA_BLOBS is flipped): blobs ride the blind-token path, so
   * the relay needs 30351 in BOTH its allow-list AND `blindContentKinds` — see config.ts's flag doc.
   * Channels need NOTHING further: 1311 must stay OUT of `blindContentKinds` (it is excluded on
   * purpose, and this split does not tokenize it), so the anti-evasion guard is untouched here.
   */
  private async mintMediaBlobs(intent: PendingWrite): Promise<void> {
    // Pass 1 — DRY RUN. See blobPayloadsFor.
    const payloads = this.blobPayloadsFor(intent.content);
    if (payloads.length === 0) return; // flag off / no media / already split — nothing to do

    // The blind signer is the only signer that mints a fresh throwaway key per event (see above).
    // Without a community key we would sign every blob with the one real npub, so they would delete
    // each other on the relay AND deanonymize this device's media. Keep the bytes inline instead —
    // the read path renders an inline token exactly as it always has, so this costs nothing but the
    // lazy fetch, and it is the only fallback that cannot lose a picture.
    if (!this.canMintMediaBlobs) {
      log.warn('media', 'lazy media blobs: community is not blind — keeping media inline this post');
      return;
    }

    // Pass 2 — sign. Each payload becomes its own blob, signed with its own throwaway key, and is
    // saved LOCALLY straight away: that is what makes the author's own picture render instantly from
    // `peek()` with no fetch, and what lets a token-exhausted post rehydrate its placeholder with the
    // picture intact after a restart (a blob's kind is cache-exempt, so the store keeps it).
    const signed: Event[] = [];
    const keys = new Set<string>();
    for (const payload of payloads) {
      const blob = await this.feedSigner.sign(buildMediaBlobEvent(payload));
      if (keys.has(blob.pubkey)) {
        // Unreachable (a spent token is spent once) — but this is the invariant the addressable-kind
        // collision turns on, so it is CHECKED rather than trusted. Abandon the split and let the
        // media ride inline: publishing these would silently drop a picture, and throwing would lose
        // the user's whole post over a signer bug. Blobs already signed are dropped unpublished; the
        // tokens they spent are the cost of finding out.
        log.warn('media', 'lazy media blobs: signer reused a key — keeping media inline this post');
        for (const s of signed) this.deps.store.remove?.(s.id);
        return;
      }
      keys.add(blob.pubkey);
      signed.push(blob);
      this.deps.store.save(blob);
    }

    // Pass 3 — rewrite the body against the pre-signed blobs, consuming them in the same body order
    // pass 1 collected them (same function, same input, deterministic). splitMediaBlobs writes each
    // blob's id into its token's tail, so the body now provably references blobs that exist.
    let next = 0;
    const {blobs, body} = splitMediaBlobsIfEnabled(intent.content, () => signed[next++]!);
    /* istanbul ignore next — same splitter, same input as pass 1, so this cannot disagree */
    if (blobs.length !== signed.length) {
      log.warn('media', 'lazy media blobs: split pass disagreed — keeping media inline this post');
      for (const s of signed) this.deps.store.remove?.(s.id);
      return;
    }
    intent.content = body;
    intent.blobIds = blobs.map(b => b.id);
  }

  /**
   * The already-signed blob events `intent.blobIds` names, read back from the local store — where
   * mintMediaBlobs saved them, and where they stay: a blob's kind is cache-exempt, so neither the
   * retention prune nor a user cache-clear can drop one (nostr/cacheExempt.ts).
   *
   * THROWS if any id fails to resolve, and that is load-bearing rather than defensive noise. The
   * delivery gate reads "this dependency is no longer in the outbox" as "it was delivered and swept"
   * (blobsBlocking) — sound ONLY because a blob is always queued before the post naming it. Returning
   * a short list here would break exactly that premise: the missing blob would never be queued, the
   * gate would score it landed, and the post would ship referencing bytes that exist nowhere — the
   * one outcome this whole design exists to prevent. So this fails the write instead.
   *
   * Unreachable in practice (same session: just saved; after a restart: exempt from every deletion
   * path). If it ever does fire, the picture bytes are already gone, so the post could not have been
   * published intact anyway — and losing the text with a visible "couldn't post" beats publishing a
   * permanently broken picture to everyone, silently.
   */
  private mintedBlobs(intent: PendingWrite): Event[] {
    const out: Event[] = [];
    for (const id of intent.blobIds ?? []) {
      const blob = this.deps.store.getById(id);
      if (!blob || blob.kind !== KIND_MEDIA_BLOB) {
        throw new Error(`media blob ${id.slice(0, 8)}… is missing — refusing to publish the write that references it`);
      }
      out.push(blob);
    }
    return out;
  }

  /** Drop an intent's minted-but-unpublished blobs from the local store (silo guard / hard failure).
   *  Safe unconditionally: this only ever runs on a path that also discards the write, and a blob is
   *  only added to the outbox AFTER both it and its post have signed — so nothing here was ever
   *  published, and no other body can reference it. */
  private dropMintedBlobs(intent: PendingWrite): void {
    for (const id of intent.blobIds ?? []) this.deps.store.remove?.(id);
    intent.blobIds = undefined;
  }

  /**
   * Build the UNSIGNED template used for a pending write's optimistic placeholder AND its restart
   * rehydration (loadPendingCompose). For a POST this is the plain note/article shape (the real event
   * is blind-assembled at sign time in signPendingEvent); for every other type it is the EXACT unsigned
   * that will be signed. Single source of truth so the placeholder always matches its type — e.g. a
   * channel placeholder carries the same `a` root tag as the real broadcast (channelMessages filters on
   * it) and a group placeholder the same `h` tag, so each shows up in its own space and nowhere else.
   *
   * GROUP variants re-derive `enc` from {@link outgoingSeal} FRESH on every call, rather than
   * persisting the key on the intent — recovery (drainPendingPosts) can run well after compose, once a
   * space key that wasn't available yet has arrived, and `SpaceKey` isn't JSON-safe to persist anyway.
   * Mirrors how a channel/group placeholder always re-runs `withMyName` fresh instead of freezing the
   * display name at compose time.
   */
  private unsignedForPending(intent: PendingWrite): UnsignedEvent {
    if (intent.type === 'comment') {
      return buildPostComment(this.withMyName(intent.content), intent.root, intent.parent);
    }
    if (intent.type === 'pinned') {
      return buildPinnedComment(intent.content, intent.postRef);
    }
    if (intent.type === 'channel') {
      return buildChannelMessage(intent.channelId, this.withMyName(intent.content));
    }
    if (intent.type === 'channelEdit') {
      const edit = buildChannelMessageEdit(intent.channelId, intent.originalId, this.withMyName(intent.content));
      // promoteChannelPost's in-place marker (T4.3) — see PendingChannelEditWrite.promotedFeedId.
      return intent.promotedFeedId ? withPromotedTag(edit, intent.promotedFeedId) : edit;
    }
    if (intent.type === 'group') {
      const {enc} = this.outgoingSeal(intent.groupId);
      return buildGroupChat(intent.groupId, this.withMyName(intent.content), intent.replyTo, enc);
    }
    if (intent.type === 'groupEdit') {
      const {enc} = this.outgoingSeal(intent.groupId);
      const edit = buildGroupChatEdit(intent.groupId, intent.originalId, this.withMyName(intent.content), enc);
      return intent.promotedFeedId ? withPromotedTag(edit, intent.promotedFeedId) : edit;
    }
    if (intent.type === 'groupReply') {
      const {enc} = this.outgoingSeal(intent.groupId);
      // Public groups keep bare content (no name header) — byte-identical to before this write had a
      // durable pipeline; only a PRIVATE space's reply carries the identity header, mirroring
      // replyToGroupMessage's original conditional.
      const body = enc ? this.withMyName(intent.content) : intent.content;
      return buildGroupReply(intent.groupId, intent.parentId, body, enc);
    }
    if (intent.type === 'reaction') {
      // 'feed' and 'channel' are wire-IDENTICAL (kind-7, e+p tags, no h tag) — buildEmojiReaction's
      // shape covers both (it is byte-identical to buildReaction/buildRetraction for the same inputs).
      // Only 'group' differs (adds the h tag) — buildGroupReaction.
      return intent.scope === 'group'
        ? buildGroupReaction(intent.groupId!, intent.targetId, intent.targetPubkey, intent.content)
        : buildEmojiReaction(intent.targetId, intent.targetPubkey, intent.content);
    }
    return intent.title
      ? buildArticle(intent.title, this.withMyName(intent.content), intent.tags ?? [], undefined, intent.label)
      : buildPost(this.withMyName(intent.content), intent.tags ?? [], this.mediaForContent(intent.content), intent.contentWarning, intent.label);
  }

  /**
   * Re-attempt every write (post / comment / pinned comment / channel broadcast) that failed at compose
   * time because the blind wallet was still exhausted after feedSigner's internal draw-and-retry (see
   * signPendingWrite) — for a broadcast, that means its MEDIA BLOBS couldn't be minted; its own
   * bound-npub signature never spends a token. Called from onRelayConnected (a (re)connect is exactly
   * when a proactive top-up
   * lands), drawTokens() right after a successful draw, AND refreshFeed() (pull-to-refresh actively
   * recovers a queued write). The recovery queue is PERSISTED per-account, so a write survives an app
   * restart too. Each intent is drained before re-attempting so a persistent drought can't grow the
   * queue unboundedly; a still-exhausted intent lands right back on it via signPendingWrite's catch.
   *
   * SILO SAFETY: only re-sign an intent whose captured (community, account) still equals the ACTIVE
   * pair; DROP any that don't (drop its placeholder, do not re-sign). An intent composed in
   * community/account A must never be re-signed with B's feedSigner and published into B. The queue is
   * per-account (rehydrated only for the active slot) + cleared on switch, so this filter is defense-
   * in-depth for a drain racing a switch mid-flight.
   */
  private async drainPendingPosts(): Promise<void> {
    if (!this.pendingPosts.length || !this.identity) return;
    const queued = this.pendingPosts.splice(0, this.pendingPosts.length);
    for (const intent of queued) {
      if (intent.cid !== this.activeCid || intent.slotId !== this.activeSlotId) {
        this.discardPlaceholder(intent.id); // drop the stale placeholder from the now-active store
        this.emit();
        continue;
      }
      this.awaitingSign.set(intent.id, {status: 'sending'}); // flip the failed placeholder back to 'sending'
      this._awaitingSignVersion++;
      this.emit();
      try {
        await this.signPendingWrite(intent);
      } catch {
        // Still exhausted (signPendingWrite re-queued + re-failed + persisted) — swallow in the
        // background drain; never throw into its caller (onRelayConnected / drawTokens / refreshFeed).
      }
    }
    await this.persistPendingCompose(); // reconcile the persisted queue with the post-drain in-memory set
  }

  /**
   * Optimistically render an unsigned feed write INSTANTLY, then draw+sign AFTER and swap the
   * placeholder for the real signed event — or, on failure, drop the placeholder and propagate.
   * Enforces the (cid, slotId) SILO GUARD across the seconds-long draw: a switch mid-draw DROPS the
   * write (never delivered into the other account) rather than leaking it. These writes are NOT queued
   * for durable recovery — an RSVP re-tap is a cheap idempotent no-op — so the win here is just the
   * instant render + the silo guard. `sign` is invoked once to produce the real signed event. Returns
   * the delivered event, or null when the silo guard dropped it.
   *
   * Only the event RSVP toggles still ride this. Two flows used to and deliberately no longer do:
   * - Reactions (vote / channel / group emoji taps): kind-7 is a blind content kind here, so a tapped ✦
   *   could need a blind token same as any post, and this method's catch DISCARDS the placeholder — a
   *   dry wallet made the like show, then vanish. They now queue on the durable PendingWrite pipeline
   *   (see sendReaction / PendingReactionWrite).
   * - promoteChannelPost's feed post (T4.3→T4.4): riding this made the whole promotion un-recoverable
   *   on a drought; it moved onto the durable 'post' PendingWrite pipeline via the intent's
   *   `promoteSource` field (see PendingPostWrite's doc and signPendingWrite's promoteSource branch).
   */
  private async signOptimisticWrite(unsigned: UnsignedEvent, sign: () => Promise<Event>): Promise<Event | null> {
    const cid = this.activeCid;
    const slotId = this.activeSlotId;
    const id = this.localComposeId();
    this.renderPlaceholder(id, unsigned);
    try {
      const event = await sign();
      if (cid !== this.activeCid || slotId !== this.activeSlotId) {
        this.discardPlaceholder(id); // switched away mid-draw — never deliver into the other account
        this.emit();
        return null;
      }
      this.discardPlaceholder(id);
      await this.publishOptimistic(event);
      return event;
    } catch (e) {
      this.discardPlaceholder(id);
      this.emit();
      throw e;
    }
  }

  /**
   * Shared durable-reaction sender for vote()/reactToChannelMessage()/reactToGroupMessage()
   * (T-reactions — see PendingReactionWrite's doc): builds a PendingReactionWrite and hands it to
   * {@link queuePendingWrite}, the SAME durable pipeline post/comment/channel/group writes ride. A
   * token-drought no longer DISCARDS the optimistic tap (signOptimisticWrite's catch used to, which is
   * the vanishing-like bug this exists to fix) — it stays rendered 'failed' (Retry) and is re-signed by
   * drainPendingPosts on reconnect / draw / pull-refresh, exactly like a queued comment. The returned
   * promise still REJECTS on exhaustion (signPendingWrite rethrows), so callers/tests that expect a
   * failed vote/reaction to reject keep seeing that.
   *
   * DEDUPE (latest-intent-wins): if a reaction for this exact (scope, target, viewer) is STILL
   * queued — a prior tap failed and hasn't drained yet — this DISCARDS that stale placeholder (store +
   * awaitingSign + its pendingPosts entry) and queues a FRESH intent in its place, rather than leaving
   * a second write queued alongside it. It discards rather than reusing the old placeholder's id
   * because the event store's `save` is add-only (a repeat `save` under an id already present is a
   * silent no-op) — reusing the id would leave the SUPERSEDED content ('+') rendered even though the
   * NEW intent ('✖', say) is what actually gets signed and sent. A like→retract→like re-tap collapses
   * to the single latest intent this way, mirroring how scoreReactions/tallyEmojiReactions count only
   * the latest reaction per resolved voter — so the optimistic tally stays consistent with what will
   * actually reach the relay.
   */
  private async sendReaction(
    scope: 'feed' | 'channel' | 'group',
    targetId: string,
    targetPubkey: string,
    unsigned: UnsignedEvent,
    groupId?: string,
  ): Promise<void> {
    const cid = this.activeCid;
    const slotId = this.activeSlotId;
    const existing = this.pendingPosts.find(
      (p): p is PendingReactionWrite =>
        p.type === 'reaction' && p.scope === scope && p.targetId === targetId && p.cid === cid && p.slotId === slotId,
    );
    if (existing) {
      this.discardPlaceholder(existing.id); // drop the superseded placeholder (store + awaitingSign)
      this.removeRecoveryIntent(existing.id);
    }
    const intent: PendingReactionWrite = {
      type: 'reaction',
      id: this.localComposeId(),
      content: unsigned.content,
      cid,
      slotId,
      scope,
      targetId,
      targetPubkey,
      groupId,
    };
    await this.queuePendingWrite(intent, unsigned);
  }

  /**
   * Promote a channel/broadcast post into a real feed thread (No.5 — "enable replies"). Publishes the
   * (possibly edited) content as a feed post, then edits the original channel message in place so it
   * carries the final text + a `['promoted', <feedId>]` marker — framing it as "shared to the feed"
   * and routing taps to the discussion. Author-only (the UI gates the action on isMine).
   *
   * BOTH signatures are durable end to end (T4.4), including across an app restart mid-drought. Step
   * 1 (the feed post) used to ride signOptimisticWrite — the SAME instant-placeholder treatment as
   * vote(), which is exactly wrong here: signOptimisticWrite is deliberately NOT queued for recovery
   * (a vote is a cheap idempotent re-tap with nothing else riding on it), so a token drought on this
   * step threw straight out of this method with NOTHING durable behind it — no feed post, no queued
   * retry, and step 2 below was never even reached. Silent to the author: "allow replies" just did
   * nothing. It now queues on the ordinary 'post' PendingWrite pipeline (the exact one post() uses),
   * carrying the step-2 recipe on a `promoteSource` field so the chain survives a restart: the moment
   * signPendingWrite has this post's real signed event id in hand — live, or after coercePendingWrite
   * rehydrates and drainPendingPosts re-signs it post-restart — it derives and queues step 2 itself
   * (see signPendingWrite's promoteSource branch). Step 2 (the in-place edit) queues on the SAME
   * 'channelEdit'/'groupEdit' PendingWrite variant a plain editChannelMessage/editGroupMessage uses
   * (via the promotedFeedId field), so a drought on ITS OWN space-write signature gets the identical
   * optimistic-placeholder + 'failed'+Retry+calm-reason + drainPendingPosts treatment, independent of
   * step 1's outcome (T4.3 — this part predates T4.4 and is unchanged).
   */
  async promoteChannelPost(
    message: Event,
    content: string,
    tags: string[] = [],
    title?: string,
    label?: PostLabel,
    contentWarning?: string,
  ): Promise<void> {
    if (!this.identity) return;
    // Promotion is offered in PRIVATE spaces too (author-only via the card's isMine gate): the
    // author publishing their OWN words to the public feed is a deliberate choice, same display +
    // mechanism as a public channel. The one hard rule: the in-place EDIT of the private source
    // must re-seal under the space key — a plaintext write into an E2E space is hidden by
    // decrypt-on-read (the message would vanish). Resolve WHICH durable edit shape this source
    // message needs FIRST, fail-closed BEFORE the public post goes out, so a keyless space never
    // half-promotes — mirrors editChannelMessage/editGroupMessage's own fail-closed pre-check
    // (unsignedForPending re-derives the real seal fresh at sign time; this is only the early gate).
    let channelId: string | undefined;
    let groupId: string | undefined;
    if (message.kind === Kind.LiveChat) {
      const coord = messageChannelId(message);
      if (!coord) return;
      channelId = coord;
    } else if (message.kind === GroupKind.Chat) {
      const gid = eventGroupId(message);
      if (!gid) return;
      if (this.outgoingSeal(gid).blocked) throw new Error('this space is still unlocking — try again shortly');
      groupId = gid;
    } else {
      return;
    }
    // 1) Publish the canonical feed thread (article if titled, else a plain note) through the SAME
    // durable pipeline post() uses — placeholder rendered instantly, draw+sign after, 'failed'+Retry
    // + persisted-per-account + drainPendingPosts-recovered on a drought, exactly like any other post.
    // `promoteSource` is what lets signPendingWrite chain step 2 off THIS intent once it signs — live
    // or post-restart — instead of step 2 being built here and lost the moment step 1 throws.
    const intent: PendingPostWrite = {
      type: 'post',
      id: this.localComposeId(),
      content,
      tags,
      title,
      label,
      contentWarning,
      cid: this.activeCid,
      slotId: this.activeSlotId,
      promoteSource: channelId
        ? {kind: 'channel', channelId, originalId: message.id, content}
        : {kind: 'group', groupId: groupId!, originalId: message.id, content},
    };
    const unsigned = title
      ? buildArticle(title, this.withMyName(content), tags, undefined, label)
      : buildPost(this.withMyName(content), tags, this.mediaForContent(content), contentWarning);
    // Same true-local-publish-order tracking a plain post() gets (audit #48) — a promoted post's wire
    // created_at is fuzzed exactly like any other blind feed post, so it needs the same fix.
    this.recordOwnPostOrder(intent.id);
    await this.queuePendingWrite(intent, unsigned);
  }

  /**
   * DURABLE (T-reactions — see PendingReactionWrite's doc): a token drought no longer discards the
   * optimistic ✦/arrow — it stays 'failed'+Retry and drains on reconnect/draw/pull-refresh via
   * sendReaction, exactly like a queued comment. Kind 7 is blind here, so this vote's own signature
   * can need a posting token same as any post.
   */
  async vote(postId: string, authorPubkey: string, direction: VoteDirection): Promise<void> {
    if (!this.identity) {
      return;
    }
    // Tapping the same direction again retracts the vote (NIP-25 latest-reaction-wins). Read the
    // viewer's current vote from the version-cached target→reactions map (reactionTally) — an O(1)
    // lookup of just this post's reactions — instead of store.query({kinds:[Reaction]}).filter(...),
    // which copied+sorted the ENTIRE kind-7 bucket (up to REACTION_RETENTION=8000) on every single
    // tap before the filter narrowed it (UI-freeze A1). The map is bucketed once per kind-7 version
    // and shared with getEventScore/getReactionsByTarget, so repeated votes are free; a new reaction
    // (the placeholder we save just below) bumps the version and rebuilds it. Semantics are identical:
    // myVoteFor still sees ALL reactions on the post (not just myPubkey's), as the latest-wins logic
    // requires, and the map does not need to be sorted (myVoteFor picks the max created_at itself).
    const current = this.myPubkey
      ? myVoteFor(this.reactionTally().get(postId) ?? [], this.myPubkey)
      : null;
    // Build the unsigned reaction/retraction ONCE and reuse it for BOTH the optimistic placeholder
    // and the real sign, so the arrow highlights INSTANTLY instead of blocking on a token draw.
    const unsigned =
      current === direction
        ? buildRetraction(postId, authorPubkey)
        : buildReaction(postId, authorPubkey, direction);
    await this.sendReaction('feed', postId, authorPubkey, unsigned);
  }

  /** Publish or update the pinned/accompanying comment on one of the author's own posts. Rendered
   *  optimistically BEFORE the blind draw+sign, then durably recovered on a token drought exactly like
   *  a post: on final exhaustion it stays 'failed' (Retry) + persisted per-account, and is re-signed by
   *  drainPendingPosts on reconnect / draw / pull-refresh — never lost. See signPendingWrite. */
  async setPinnedComment(postId: string, postAuthorPubkey: string, postKind: number, content: string): Promise<void> {
    if (!this.identity) return;
    const postRef: EventRef = {id: postId, pubkey: postAuthorPubkey, kind: postKind};
    const intent: PendingPinnedWrite = {
      type: 'pinned',
      id: this.localComposeId(),
      content,
      postRef,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    this.recordOwnPostOrder(intent.id);
    await this.queuePendingWrite(intent);
  }

  /**
   * Post a comment, signed by the user (attributable). NIP-22 conflict resolution:
   * a comment on a kind-1 note is published as a kind-1 NIP-10 reply tagged 'stiq-comment';
   * comments on other roots (articles, polls, channel messages) stay kind-1111.
   * Signed (not anonymous) so content owners can moderate/block specific commenters.
   *
   * Rendered optimistically BEFORE the blind draw+sign, and — like a post — DURABLY recovered: a token
   * drought leaves the comment 'failed' (Retry) + persisted per-account (survives an app restart) and
   * re-signed by drainPendingPosts on reconnect / draw / pull-refresh, instead of discarding the typed
   * content. See signPendingWrite. The (cid, slotId) silo guard is captured on the intent.
   */
  async comment(content: string, root: EventRef, parent: EventRef): Promise<void> {
    if (!this.identity) {
      return;
    }
    const intent: PendingCommentWrite = {
      type: 'comment',
      id: this.localComposeId(),
      content,
      root,
      parent,
      cid: this.activeCid,
      slotId: this.activeSlotId,
    };
    this.recordOwnPostOrder(intent.id);
    await this.queuePendingWrite(intent);
    this.accountPictures(content);
  }

  dispose(): void {
    this.autolock.dispose();
    for (const timer of this.confirmTimers) clearTimeout(timer);
    this.confirmTimers.clear();
    for (const timer of this.resendTimers.values()) clearTimeout(timer);
    this.resendTimers.clear();
    // Drop any in-flight/failed optimistic compose placeholders + the in-memory recovery queue on
    // teardown (the persisted per-account queue stays for the next launch).
    this.awaitingSign.clear();
    this._awaitingSignVersion++;
    this.pendingPosts.length = 0;
    if (this._deferredTimer !== undefined) {
      clearTimeout(this._deferredTimer);
      this._deferredTimer = undefined;
    }
    if (this._deferHeavyTimer !== undefined) {
      clearTimeout(this._deferHeavyTimer);
      this._deferHeavyTimer = undefined;
    }
    if (this._scorePassTimer !== undefined) {
      clearTimeout(this._scorePassTimer);
      this._scorePassTimer = undefined;
    }
    if (this._epochUnlockTimer !== undefined) {
      clearTimeout(this._epochUnlockTimer);
      this._epochUnlockTimer = undefined;
    }
    // Bump the generation so an in-flight reaction-bucket/item-cache score-pass warm can't flip
    // _feedScored or emit() after this runtime is torn down (mirrors the switch guard above).
    this._scorePassGen++;
    // P1-3/A3: mirrors the bump above — stop an in-flight community-switch structural warm
    // (warmSwitchKindsChunked) from emitting against a torn-down runtime too.
    this._switchWarmGen++;
    // Finding #2 phase-split: mirrors the bumps above — stop a still-in-flight un-enrolled init
    // phase 2 from touching/emitting against a torn-down runtime.
    this._initPhase2Gen++;
    if (this._placeholderEmitTimer !== undefined) {
      clearTimeout(this._placeholderEmitTimer);
      this._placeholderEmitTimer = undefined;
    }
    if (this._refreshInboxTimer !== undefined) {
      clearTimeout(this._refreshInboxTimer);
      this._refreshInboxTimer = undefined;
    }
    if (this._scrollExpiryTimer !== undefined) {
      clearTimeout(this._scrollExpiryTimer);
      this._scrollExpiryTimer = undefined;
    }
    // Flush any pending debounced persists so nothing is lost on shutdown.
    void this.flushSentMessages();
    void this.flushFailedWraps();
    void this.displayNames.flush();
    void this.gradients.flush();
  }

  private _deferredTimer: ReturnType<typeof setTimeout> | undefined;

  // Deferred variant: coalesces rapid relay-event bursts (initial sync, firehose) into at most one
  // render per RELAY_EMIT_THROTTLE_MS — a TRAILING, non-resetting coalesce (see emitDeferred): the
  // first call in a burst arms ONE timer, every call before it fires is a no-op, and that deadline is
  // never pushed back out by later calls. That SHAPE, not the specific number below, is what actually
  // bounds render count under load: a 500-event EOSE backlog delivered inside one window still costs
  // exactly ONE render; spread across N windows it costs N renders — never 500, and never starved
  // indefinitely either, since the first event's deadline always holds regardless of how many more
  // arrive behind it. Tightening this constant only trades a little coalescing margin for latency; it
  // cannot reopen the "hundreds of renders" failure mode the throttle exists to prevent.
  //
  // 80ms (~5 frames @60Hz) is the number: fast enough that a live update reads as arriving "by
  // itself" rather than "batched in" (the point of this whole workstream — nothing should ever need a
  // pull-to-refresh to appear), while still collapsing anything hotter than ~12/s into one render.
  // This is NOT a rerun of the "100ms" finding the next paragraph would otherwise bring to mind: that
  // measurement was of UNTHROTTLED per-event emission — every relay message rendering immediately,
  // back to back, with no coalescing window and no guaranteed idle gap at all, during a firehose
  // sending roughly one message every 100ms. This constant IS the coalescing window: no matter how
  // hot the burst, there is always at least 80ms of guaranteed idle time between renders for touch
  // dispatch to run, and anything arriving faster than that folds into one render instead of
  // multiplying. If a future profile shows the per-render cost itself is still too high at this
  // cadence, the fix is cutting that cost (memoize harder / render less per snapshot), not widening
  // this window back up.
  private static readonly RELAY_EMIT_THROTTLE_MS = 80;
  /**
   * Stale-flag cap for {@link relaySyncing} — which now feeds ONLY the snapshot's `syncing` indicator
   * (see its doc; sync no longer widens the emit throttle above, see emitDeferred): a syncing window
   * older than this is treated as over even if no setRelaySyncing(false) ever arrived (e.g. the relay
   * dropped mid-sync and no onSynced fired), so a missed clear can't leave the "Syncing…" indicator on
   * forever.
   */
  private static readonly RELAY_SYNCING_MAX_MS = 60_000;
  /**
   * Stale-flag cap for the scroll park below (same backstop role as RELAY_SYNCING_MAX_MS): a scroll
   * that never reports settling (a missed onScrollEndDrag/onMomentumScrollEnd) can't wedge deferred
   * emits forever — auto-clears and flushes after this many ms of continuous _scrolling.
   */
  private static readonly RELAY_SCROLL_MAX_MS = 1_200;
  /** Date.now() when the current relay sync round started; undefined = not syncing. */
  private _relaySyncingSince: number | undefined;
  /**
   * App is backgrounded (no UI visible) — deferred emits park until foreground. Unlike its sibling
   * parks (relaySyncing's RELAY_SYNCING_MAX_MS, _scrolling's RELAY_SCROLL_MAX_MS) this one has NO
   * self-expiry timer, and that is deliberate, not a gap: a sync round and a scroll gesture are both
   * short, bounded interactions, so force-clearing them after a fixed backstop when the real signal
   * never arrives is safe. Backgrounding has no such bound — a user legitimately leaving the app for
   * hours or days is the ORDINARY case, not an edge case, and a timer that force-flipped this back to
   * "foreground" after some fixed window would render the invisible tree this park exists to avoid,
   * for every normal background session that outlives it. What actually needed hardening here (see
   * setAppBackgrounded) was making the EVENTUAL real foreground signal flush immediately with no
   * extra delay, and stopping a render from leaking through WHILE genuinely backgrounded via a timer
   * that happened to already be armed the instant before backgrounding began.
   */
  private _appBackgrounded = false;
  /** A deferred emit arrived while backgrounded; flush one emitDeferred on foreground. */
  private _emitPendingWhileBackgrounded = false;
  /** Feed list is mid-drag/fling (MainScreen onScrollBeginDrag..settle) — deferred emits park. */
  private _scrolling = false;
  /** A deferred emit arrived while scrolling; flush one emitDeferred on settle. */
  private _emitPendingWhileScrolling = false;
  /** RELAY_SCROLL_MAX_MS backstop timer; cleared on any explicit setScrolling call. */
  private _scrollExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Relay sync-in-progress signal (App.tsx: set true when the relay (re)connects and opens its
   * subscriptions, false on onSynced / relay teardown). Feeds ONLY the snapshot's `syncing` indicator
   * (the quiet "Syncing…" UI, M7) — it no longer widens the deferred emit throttle (see emitDeferred's
   * doc: the backlog burst now gets the SAME tight cadence as everything else, since a fresh sync is
   * exactly when the user most wants to see content land). Self-expires after RELAY_SYNCING_MAX_MS as
   * a backstop so a missed clear can't leave the indicator on forever.
   */
  setRelaySyncing(syncing: boolean): void {
    this._relaySyncingSince = syncing ? Date.now() : undefined;
  }

  private relaySyncing(): boolean {
    return (
      this._relaySyncingSince !== undefined &&
      Date.now() - this._relaySyncingSince < AppRuntime.RELAY_SYNCING_MAX_MS
    );
  }

  /**
   * Backgrounded signal (App.tsx AppState handler). While backgrounded, relay-driven DEFERRED emits
   * park (nothing is on screen — a full snapshot build + tree render is pure wasted battery); the
   * first foreground transition flushes at most ONE coalesced deferred emit so the UI catches up.
   * Urgent emits (user actions) still run — they can't happen while backgrounded anyway.
   *
   * Foreground is also a retry trigger for a stuck auto-unlock (see {@link reviveStuckEpochUnlocks}):
   * the member just looked at the app again, which is exactly when a permanent gray bar should heal
   * itself rather than wait for the next incidental feed rebuild.
   */
  setAppBackgrounded(backgrounded: boolean): void {
    this._appBackgrounded = backgrounded;
    if (backgrounded) {
      // A relay event that landed just BEFORE backgrounding may have already armed _deferredTimer —
      // emitDeferred's early-return-if-backgrounded guard only stops NEW calls, it can't retract a
      // timer that's already ticking. Left alone, that timer fires DURING backgrounding: a full
      // snapshot build + whole-tree render for a screen nobody can see, exactly the waste this park
      // exists to prevent. Cancel it and fold its intent into the pending flag instead — nothing is
      // lost, it rides the guaranteed foreground flush below instead of firing blind mid-background.
      if (this._deferredTimer !== undefined) {
        clearTimeout(this._deferredTimer);
        this._deferredTimer = undefined;
        this._emitPendingWhileBackgrounded = true;
      }
      return;
    }
    this.reviveStuckEpochUnlocks('app foreground');
    if (this._emitPendingWhileBackgrounded) {
      this._emitPendingWhileBackgrounded = false;
      // emit(), not emitDeferred(): a background stretch can be seconds or days, so whatever was
      // parked may already be stale — "flush the moment it foregrounds" means zero EXTRA delay on top
      // of that. Routing back through emitDeferred() would tack another throttle window onto it for
      // no reason (nothing is parking it anymore — _appBackgrounded is already false above) and would
      // leave the flush hostage to whatever _scrolling happens to read at that instant. Ordering is
      // trivially preserved either way: this is a full rebuild from the store (the actual source of
      // truth, which kept accepting writes the whole time — only the PUSH to listeners was ever
      // parked), not a replay of individually-queued events, so there is nothing to reorder or drop no
      // matter how long the park lasted or how much landed during it.
      this.emit(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Events surface — kind-31923 docs, kind-31925 interested RSVPs, and the encrypted DM
  // application rail (events/eventFrames.ts). The relay sees the public doc + anonymous RSVPs and
  // nothing else: applications, approvals, declines, the guest list, and the exact-location
  // reveal all ride NIP-17 gift wraps, so the privacy invariants hold by construction.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /** My RSVP per event coordinate (viewer side). Holds the post-approval reveal payload — the only
   * copy of an exact address a guest ever has. Persisted per slot (eventStateItem). */
  private readonly myEventRsvps = new Map<string, MyEventRsvp>();
  /** Host-side decisions per coordinate → applicant pubkey. Persisted; the application queue
   * itself is re-folded from the decrypted DM history each session (ingestEventFrame). */
  private readonly eventDecisions = new Map<string, Map<string, EventDecision>>();
  /** Session folds from received DM frames (host side). */
  private readonly eventApplications = new Map<string, Map<string, EventApplicationRecord>>();
  private readonly eventWaitlists = new Map<string, Map<string, EventWaitlistRecord>>();
  private _eventDocsCache?: {ver: number; docs: Map<string, EventDocView>};
  private _eventTallyCache?: {ver: number; tallies: Map<string, InterestedTally>};
  private readonly requestedEventCoords = new Set<string>();
  /** Throttle for {@link republishMyEventDocs} — once per (re)connect cycle, not once per call. */
  private _lastEventSweepAt = 0;

  private applyEventState(raw: string | null): void {
    this.myEventRsvps.clear();
    this.eventDecisions.clear();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        rsvps?: Record<string, MyEventRsvp>;
        decisions?: Record<string, Record<string, EventDecision>>;
      } | null;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [coord, r] of Object.entries(parsed.rsvps ?? {})) {
        if (r && typeof r === 'object' && typeof r.at === 'number' && r.state) this.myEventRsvps.set(coord, r);
      }
      for (const [coord, m] of Object.entries(parsed.decisions ?? {})) {
        const per = new Map<string, EventDecision>();
        for (const [pk, dec] of Object.entries(m ?? {})) {
          if (dec && (dec.d === 'approved' || dec.d === 'declined') && typeof dec.at === 'number') per.set(pk, dec);
        }
        if (per.size) this.eventDecisions.set(coord, per);
      }
    } catch {
      // corrupt → start empty
    }
  }

  private async saveEventState(): Promise<void> {
    if (!this.deps.secureStorage) return;
    try {
      const rsvps: Record<string, MyEventRsvp> = {};
      for (const [k, v] of this.myEventRsvps) rsvps[k] = v;
      const decisions: Record<string, Record<string, EventDecision>> = {};
      for (const [k, m] of this.eventDecisions) decisions[k] = Object.fromEntries(m);
      await this.deps.secureStorage.setItem(this.eventStateItem(), JSON.stringify({rsvps, decisions}));
    } catch {
      // best effort
    }
  }

  private eventHostPk(coordinate: string): string {
    return coordinate.split(':')[1] ?? '';
  }

  /** The `d` identifier — everything after the second colon (a d-tag may itself contain colons). */
  private eventDTag(coordinate: string): string {
    const first = coordinate.indexOf(':');
    const second = first >= 0 ? coordinate.indexOf(':', first + 1) : -1;
    return second >= 0 ? coordinate.slice(second + 1) : '';
  }

  private static nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Latest parsed 31923 per coordinate, version-cached (reactionTally idiom). */
  private eventDocs(): Map<string, EventDocView> {
    const ver = this.storeVersionOf([KIND_EVENT]);
    const c = this._eventDocsCache;
    if (ver !== undefined && c && c.ver === ver) return c.docs;
    const docs = new Map<string, EventDocView>();
    for (const [coord, ev] of foldLatestEventDocs(this.deps.store.query({kinds: [KIND_EVENT], unordered: true}))) {
      const doc = parseEventDoc(ev);
      if (doc) docs.set(coord, doc);
    }
    if (ver !== undefined) this._eventDocsCache = {ver, docs};
    return docs;
  }

  /** Interested tallies per coordinate, deduped per real author, version-cached. */
  private eventTallies(): Map<string, InterestedTally> {
    const ver = this.storeVersionOf([KIND_EVENT_RSVP]);
    const c = this._eventTallyCache;
    if (ver !== undefined && c && c.ver === ver) return c.tallies;
    const tallies = interestedTallies(
      this.deps.store.query({kinds: [KIND_EVENT_RSVP], unordered: true}),
      ev => resolveAuthorPubkey(ev),
      this.myPubkey ?? null,
    );
    if (ver !== undefined) this._eventTallyCache = {ver, tallies};
    return tallies;
  }

  /**
   * Lazily fetch an event doc we've only seen referenced (an embed token) — fetchNaddr idiom,
   * INCLUDING its un-blacklist-on-failure half: `fetchByFilter` is fire-and-forget, so without the
   * timed release below one failed/timed-out attempt (common over Tor) would dedupe this coordinate
   * FOREVER and strand the event card on "Fetching event…" for the rest of the session.
   */
  private fetchEventDoc(coordinate: string): void {
    if (this.requestedEventCoords.has(coordinate)) return;
    const pk = this.eventHostPk(coordinate);
    const d = this.eventDTag(coordinate);
    if (!/^[0-9a-f]{64}$/.test(pk) || !d) return;
    this.requestedEventCoords.add(coordinate);
    this.deps.fetchByFilter?.([{kinds: [KIND_EVENT], authors: [pk], '#d': [d]}]);
    const timer = setTimeout(() => {
      const resolved = this.deps.store
        .query({kinds: [KIND_EVENT], authors: [pk]})
        .some(e => e.tags.some(t => t[0] === 'd' && t[1] === d));
      if (!resolved) this.requestedEventCoords.delete(coordinate);
    }, FETCH_TIMEOUT_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
  }

  /** Live card state for an embed (the events/eventCardState.ts resolver backend). */
  eventLive(coordinate: string): EventCardLive | null {
    const doc = this.eventDocs().get(coordinate);
    if (!doc) this.fetchEventDoc(coordinate);
    const tally = this.eventTallies().get(coordinate);
    const mine = this.myEventRsvps.get(coordinate);
    if (!doc && !tally && !mine) return null;
    return {
      interestedCount: tally?.count ?? 0,
      attendingCount: doc?.going ?? 0,
      status: doc ? eventStatusOf(doc, AppRuntime.nowSec()) : 'upcoming',
      rsvp: mine?.state ?? null,
    };
  }

  /** The parsed public doc for a coordinate (lazy-fetching when unknown). */
  getEventDocView(coordinate: string): EventDocView | null {
    const doc = this.eventDocs().get(coordinate) ?? null;
    if (!doc) this.fetchEventDoc(coordinate);
    return doc;
  }

  /** My RSVP record (state + waitlist position + post-approval reveal). */
  myEventRsvpFor(coordinate: string): MyEventRsvp | null {
    return this.myEventRsvps.get(coordinate) ?? null;
  }

  /** A self-contained `stiq:event:` embed token for a known event (Copy card / Forward / attach). */
  eventEmbedTokenFor(coordinate: string): string | null {
    const doc = this.eventDocs().get(coordinate);
    if (!doc) return null;
    const p = doc.public;
    return encodeEventEmbed({
      addr: doc.addr,
      title: p.title || undefined,
      description: p.description,
      type: p.type,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      tz: p.tz,
      recurrence: p.recurrence,
      area: p.area,
      hostName: p.hostName,
      hostGrad: p.hostGrad,
      cover: p.cover,
      capacityMode: p.capacityMode,
      capacity: p.capacity,
      waitlistEnabled: p.waitlistEnabled,
      tag: p.tag,
      external: p.external,
      externalSource: p.externalSource,
      externalLink: p.externalLink,
      autoAddLabel: p.autoAdd?.label,
    });
  }

  /**
   * Self-contained embed token for an event that may not be PUBLISHED yet — encoded straight from
   * the draft (public view: hide flags applied by publicInputFromDraft). The address uses the
   * draft's id, which publishEvent keeps, so a card saved to the embeds list before publishing
   * upgrades live the moment the doc lands. Null when the draft has no id yet or no identity.
   */
  eventEmbedTokenForDraft(draft: EventDraft): string | null {
    if (!this.myPubkey || !draft.id) return null;
    const p = this.publicInputFromDraft(draft);
    return encodeEventEmbed({
      addr: {pubkey: this.myPubkey, d: draft.id},
      title: p.title || undefined,
      description: p.description,
      type: p.type,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      tz: p.tz,
      recurrence: p.recurrence,
      area: p.area,
      hostName: p.hostName,
      hostGrad: p.hostGrad,
      cover: p.cover,
      capacityMode: p.capacityMode,
      capacity: p.capacity,
      waitlistEnabled: p.waitlistEnabled,
      tag: p.tag,
      external: p.external,
      externalSource: p.externalSource,
      externalLink: p.externalLink,
      autoAddLabel: p.autoAdd?.label,
    });
  }

  private eventIdentityFor(pk: string): {name: string; npub: string; grad: GradientSpec | string} {
    let npub = pk;
    try {
      npub = nip19.npubEncode(pk);
    } catch {
      // keep hex
    }
    const name = this.displayNames.nameFor(pk) ?? `${npub.slice(0, 12)}…${npub.slice(-4)}`;
    return {name, npub, grad: this.gradients.gradientFor(pk) ?? ''};
  }

  // ── DM frame ingest (called from ingestDecrypted) ─────────────────────────────────────────────

  private ingestEventFrame(f: EventFrame, sender: string, at: number): void {
    const me = this.myPubkey;
    if (!me || sender === me) return;
    const hostPk = this.eventHostPk(f.a);
    if (hostPk === me) {
      // I host this event — applicant-side frames fold into the host queue.
      switch (f.t) {
        case 'apply': {
          let per = this.eventApplications.get(f.a);
          if (!per) {
            per = new Map();
            this.eventApplications.set(f.a, per);
          }
          const cur = per.get(sender);
          if (!cur || at > cur.at) per.set(sender, {note: f.note, at, withdrawn: false});
          break;
        }
        case 'withdraw': {
          let per = this.eventApplications.get(f.a);
          if (!per) {
            per = new Map();
            this.eventApplications.set(f.a, per);
          }
          const cur = per.get(sender);
          if (!cur || at >= cur.at) per.set(sender, {note: cur?.note, at, withdrawn: true});
          break;
        }
        case 'wl-join': {
          let per = this.eventWaitlists.get(f.a);
          if (!per) {
            per = new Map();
            this.eventWaitlists.set(f.a, per);
          }
          const cur = per.get(sender);
          // Keep the EARLIEST join time (queue position is first-come), but un-leave on a re-join.
          if (!cur) per.set(sender, {at, left: false});
          else if (at >= cur.at && cur.left) per.set(sender, {at: cur.at, left: false});
          break;
        }
        case 'wl-leave': {
          const cur = this.eventWaitlists.get(f.a)?.get(sender);
          if (cur && at >= cur.at) cur.left = true;
          break;
        }
        default:
          break; // host-authored frame types never arrive addressed to the host
      }
      return;
    }
    if (sender === hostPk) {
      // A frame from the host about MY application.
      const cur = this.myEventRsvps.get(f.a);
      const newer = !cur || at >= cur.at;
      switch (f.t) {
        case 'approve':
          if (newer) {
            this.myEventRsvps.set(f.a, {
              state: 'approved',
              reveal: f.reveal,
              autoAddLabel: f.autoAddLabel,
              groupId: f.groupId,
              channelId: f.channelId,
              at,
            });
            if (f.groupId) void this.adoptEventGroup(f.groupId);
            // A channel auto-add is guest-side by construction (channels are open-subscribe):
            // the host's frame names the channel, and joining = adding it to my NIP-51 list.
            if (f.channelId) void this.subscribeChannel(f.channelId).catch(() => {});
            void this.saveEventState();
          }
          break;
        case 'decline':
          // Declined — back to interested (applying marked us interested; nothing is revealed).
          if (newer) {
            this.myEventRsvps.set(f.a, {state: 'interested', at});
            void this.saveEventState();
          }
          break;
        case 'restore':
          // Host undid a decision — back to pending; drop any reveal we were holding.
          if (newer) {
            this.myEventRsvps.set(f.a, {state: 'applied', at});
            void this.saveEventState();
          }
          break;
        case 'wl-pos': {
          if (cur?.state === 'waitlist') {
            cur.pos = f.pos;
            void this.saveEventState();
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** An approval added me to a private group I never sent a join request for — open its tracking
   * (joined-set + scoped sub via the existing machinery) so the space + its key delivery arrive. */
  private async adoptEventGroup(groupId: string): Promise<void> {
    try {
      await this.trackGroup(groupId);
    } catch {
      // re-synced on a later connect
    }
  }

  // ── Viewer actions ────────────────────────────────────────────────────────────────────────────

  /** Toggle the one-tap Interested state (only meaningful while not applied/approved/waitlisted).
   * Optimistic locally; the 31925 publish rides the feed signer (blind path when required). */
  async toggleEventInterested(coordinate: string): Promise<void> {
    if (!this.identity) return;
    const cur = this.myEventRsvps.get(coordinate);
    if (cur && cur.state !== 'interested') return;
    const on = !cur;
    if (on) this.myEventRsvps.set(coordinate, {state: 'interested', at: AppRuntime.nowSec()});
    else this.myEventRsvps.delete(coordinate);
    void this.saveEventState();
    this.emit();
    const unsigned = buildRsvpTemplate(coordinate, on, AppRuntime.nowSec()) as UnsignedEvent;
    try {
      await this.signOptimisticWrite(unsigned, () => this.feedSigner.sign(unsigned));
    } catch {
      // token drought — the local state stands; a re-tap re-publishes
    }
  }

  /** Apply to attend (also marks interested — STATES §1). Sends the apply frame to the host. */
  async applyToEvent(coordinate: string, note: string): Promise<void> {
    if (!this.identity) return;
    const host = this.eventHostPk(coordinate);
    if (!host) return;
    const wasInterested = this.myEventRsvps.get(coordinate)?.state === 'interested';
    this.myEventRsvps.set(coordinate, {state: 'applied', at: AppRuntime.nowSec()});
    void this.saveEventState();
    this.emit();
    if (!wasInterested) {
      const unsigned = buildRsvpTemplate(coordinate, true, AppRuntime.nowSec()) as UnsignedEvent;
      void this.signOptimisticWrite(unsigned, () => this.feedSigner.sign(unsigned)).catch(() => {});
    }
    const doc = this.eventDocs().get(coordinate);
    const title = doc?.public.title || 'your event';
    const token = this.eventEmbedTokenFor(coordinate);
    const trimmed = note.trim();
    const frame = encodeEventFrame({t: 'apply', a: coordinate, note: trimmed || undefined});
    const text = `🙋 Application — ${title}${trimmed ? `\n${trimmed}` : ''}${token ? `\n${token}` : ''}`;
    await this.sendDM(host, text, undefined, undefined, frame);
  }

  /** Withdraw a pending application → back to null (and retract the interested RSVP, per the DC). */
  async withdrawEventApplication(coordinate: string): Promise<void> {
    if (!this.identity) return;
    const host = this.eventHostPk(coordinate);
    this.myEventRsvps.delete(coordinate);
    void this.saveEventState();
    this.emit();
    const unsigned = buildRsvpTemplate(coordinate, false, AppRuntime.nowSec()) as UnsignedEvent;
    void this.signOptimisticWrite(unsigned, () => this.feedSigner.sign(unsigned)).catch(() => {});
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const frame = encodeEventFrame({t: 'withdraw', a: coordinate});
    if (host) await this.sendDM(host, `↩ Application withdrawn — ${title}`, undefined, undefined, frame);
  }

  async joinEventWaitlist(coordinate: string): Promise<void> {
    if (!this.identity) return;
    const host = this.eventHostPk(coordinate);
    this.myEventRsvps.set(coordinate, {state: 'waitlist', at: AppRuntime.nowSec()});
    void this.saveEventState();
    this.emit();
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const frame = encodeEventFrame({t: 'wl-join', a: coordinate});
    if (host) await this.sendDM(host, `⊕ Joined the waitlist — ${title}`, undefined, undefined, frame);
  }

  async leaveEventWaitlist(coordinate: string): Promise<void> {
    if (!this.identity) return;
    const host = this.eventHostPk(coordinate);
    this.myEventRsvps.delete(coordinate);
    void this.saveEventState();
    this.emit();
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const frame = encodeEventFrame({t: 'wl-leave', a: coordinate});
    if (host) await this.sendDM(host, `↩ Left the waitlist — ${title}`, undefined, undefined, frame);
  }

  // ── Host: queue + roster getters ──────────────────────────────────────────────────────────────

  private eventWaitlistActive(coordinate: string): {pk: string; at: number}[] {
    const per = this.eventWaitlists.get(coordinate);
    if (!per) return [];
    const decisions = this.eventDecisions.get(coordinate);
    const out: {pk: string; at: number}[] = [];
    for (const [pk, rec] of per) {
      if (rec.left) continue;
      if (decisions?.get(pk)?.d === 'approved') continue; // promoted off the list
      out.push({pk, at: rec.at});
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Applications for an event I host (pending first, newest first inside each group). */
  eventApplicationsFor(coordinate: string): ManagedApplication[] {
    const per = this.eventApplications.get(coordinate);
    if (!per) return [];
    const decisions = this.eventDecisions.get(coordinate);
    const out: ManagedApplication[] = [];
    for (const [pk, rec] of per) {
      if (rec.withdrawn) continue;
      const iso = new Date(rec.at * 1000).toISOString();
      out.push({
        id: pk,
        applicant: this.eventIdentityFor(pk),
        note: rec.note,
        submittedAt: iso,
        decision: decisions?.get(pk)?.d ?? null,
        timeLabel: eventRelTimeShort(iso),
      });
    }
    return out.sort((a, b) => {
      const ap = a.decision === null ? 0 : 1;
      const bp = b.decision === null ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.submittedAt.localeCompare(a.submittedAt);
    });
  }

  /** Organizer-only guest list (approved), joinedAt = decision time. */
  eventGuestsFor(coordinate: string): ManagedGuest[] {
    const decisions = this.eventDecisions.get(coordinate);
    if (!decisions) return [];
    const out: ManagedGuest[] = [];
    for (const [pk, dec] of decisions) {
      if (dec.d !== 'approved') continue;
      const iso = new Date(dec.at * 1000).toISOString();
      out.push({who: this.eventIdentityFor(pk), joinedAt: iso, sinceLabel: eventRelTimeShort(iso)});
    }
    return out.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  eventWaitlistFor(coordinate: string): {who: {name: string; npub: string; grad: GradientSpec | string}; position: number}[] {
    return this.eventWaitlistActive(coordinate).map((w, i) => ({who: this.eventIdentityFor(w.pk), position: i + 1}));
  }

  eventStatsFor(coordinate: string): {interested: number; pending: number; going: number; waitlist: number} {
    const tally = this.eventTallies().get(coordinate);
    let pending = 0;
    const decisions = this.eventDecisions.get(coordinate);
    const apps = this.eventApplications.get(coordinate);
    if (apps) {
      for (const [pk, rec] of apps) {
        if (!rec.withdrawn && !decisions?.get(pk)) pending++;
      }
    }
    const counts = this.eventHostCounts(coordinate);
    return {interested: tally?.count ?? 0, pending, going: counts.going, waitlist: counts.waitlist};
  }

  private eventHostCounts(coordinate: string): {going: number; waitlist: number; cancelled: boolean} {
    let going = 0;
    const decisions = this.eventDecisions.get(coordinate);
    if (decisions) {
      for (const dec of decisions.values()) {
        if (dec.d === 'approved') going++;
      }
    }
    return {
      going,
      waitlist: this.eventWaitlistActive(coordinate).length,
      cancelled: this.eventDocs().get(coordinate)?.cancelled ?? false,
    };
  }

  // ── Host: publish / edit / cancel / decide ────────────────────────────────────────────────────

  /** The public (hide-flags-applied, external-stripped) doc payload for a host-side draft. */
  private publicInputFromDraft(draft: EventDraft): PublicEventInput {
    const hidden = draft.hidden ?? {};
    const external = !!draft.external;
    const type = draft.type ?? 'inperson';
    const loc = draft.location;
    const coverGradient =
      typeof draft.cover?.gradient === 'string' ? decodeGradient(draft.cover.gradient) : draft.cover?.gradient;
    const input: PublicEventInput = {
      title: (draft.title ?? '').trim(),
      type,
      recurrence: draft.recurrence ?? 'none',
      waitlistEnabled: !!draft.waitlistEnabled,
      cover: {mode: draft.cover?.mode ?? 'gradient', gradient: coverGradient, image: draft.cover?.image},
      external,
    };
    if (!hidden.desc && draft.description?.trim()) input.description = draft.description.trim();
    if (!hidden.tag && draft.tag?.trim()) input.tag = draft.tag.trim().replace(/^#/, '');
    if (draft.startsAt) input.startsAt = draft.startsAt;
    if (draft.endsAt) input.endsAt = draft.endsAt;
    if (draft.tz) input.tz = draft.tz;
    if ((type === 'inperson' || type === 'hybrid') && !hidden.loc && loc?.area?.trim()) {
      input.area = loc.area.trim();
      if (loc.approxRadiusKm) input.approxRadiusKm = loc.approxRadiusKm;
    }
    if (type === 'ama' && loc?.channel) input.channel = loc.channel;
    if (!external && !hidden.cap && draft.capacityMode) {
      input.capacityMode = draft.capacityMode;
      if (draft.capacityMode === 'limit' && draft.capacity) input.capacity = draft.capacity;
    }
    if (!external && draft.autoAdd) input.autoAdd = {...draft.autoAdd};
    if (external) {
      input.externalSource = draft.externalSource?.trim() || undefined;
      input.externalLink = draft.externalLink?.trim() || undefined;
    }
    input.hostName = this.displayNames.getMyName() || undefined;
    const myGrad = this.myPubkey ? this.gradients.gradientFor(this.myPubkey) : undefined;
    input.hostGrad = myGrad ?? decodeGradient(this.gradients.myWire());
    return input;
  }

  /**
   * Publish (or republish, for an edit) an event from its draft. Creates the auto-add private
   * group on first publish, saves the LIVE record (the host-local source of truth that keeps the
   * private exact-location fields — those never enter the doc), and returns the coordinate.
   */
  /**
   * A cover image arrives from the editor as a full inline pic token (multi-KB base64) — but the
   * doc wire and the embed both cap `ci` at 500 chars, sized for a COMPACT blob-backed ref
   * (`[[pic:…;w=…;STIQBLOB<id>]]`). Mint the cover its own kind-30351 blob through the same
   * machinery post bodies use (one throwaway key per blob — see mintMediaBlobs' doc for why), and
   * return the cover rewritten to reference it. Falls back to the original cover (image simply
   * dropped from the published doc by the wire cap) when the community can't mint blobs.
   */
  private async mintEventCoverBlob(cover: NonNullable<EventDraft['cover']>): Promise<NonNullable<EventDraft['cover']>> {
    const img = cover.image;
    if (cover.mode !== 'image' || !img || img.length <= 500) return cover;
    const payloads = this.blobPayloadsFor(img);
    if (payloads.length !== 1 || !this.canMintMediaBlobs) {
      if (payloads.length > 0) log.warn('events', 'cover image cannot mint a blob — publishing without it');
      return cover;
    }
    const blob = await this.feedSigner.sign(buildMediaBlobEvent(payloads[0]!));
    this.deps.store.save(blob);
    const {blobs, body} = splitMediaBlobsIfEnabled(img, () => blob);
    if (blobs.length !== 1 || body.length > 500) return cover;
    await this.publishOptimistic(blob);
    return {...cover, image: body};
  }

  /**
   * Blob-split the description's inline media (pictures/voice) exactly as a post body would be —
   * mintMediaBlobs' machinery: one throwaway key per blob, blind signer only, re-entry no-op on a
   * republish (already-split refs mint nothing). The doc wire clamps `de` hard, so media that
   * cannot mint (community not blind / signer fault) is DROPPED from the published description
   * (bodyForMeasure strips the tokens, prose kept) — never sliced into an undecodable token.
   */
  private async mintEventDescriptionBlobs(desc: string): Promise<string> {
    const payloads = this.blobPayloadsFor(desc);
    if (payloads.length === 0) return desc;
    if (!this.canMintMediaBlobs) {
      log.warn('events', 'description media cannot mint blobs — publishing prose only');
      return bodyForMeasure(desc).trim();
    }
    const signed: Event[] = [];
    const keys = new Set<string>();
    for (const payload of payloads) {
      const blob = await this.feedSigner.sign(buildMediaBlobEvent(payload));
      if (keys.has(blob.pubkey)) {
        log.warn('events', 'description blob signer reused a key — publishing prose only');
        for (const s of signed) this.deps.store.remove?.(s.id);
        return bodyForMeasure(desc).trim();
      }
      keys.add(blob.pubkey);
      signed.push(blob);
      this.deps.store.save(blob);
    }
    let next = 0;
    const {blobs, body} = splitMediaBlobsIfEnabled(desc, () => signed[next++]!);
    if (blobs.length !== signed.length) {
      for (const s of signed) this.deps.store.remove?.(s.id);
      return bodyForMeasure(desc).trim();
    }
    for (const b of signed) await this.publishOptimistic(b);
    return body;
  }

  async publishEvent(draft: EventDraft, opts?: {notifyGoing?: boolean}): Promise<string | null> {
    if (!this.identity || !this.myPubkey) return null;
    const d = draft.id || newEventDraftId();
    let working: EventDraft = {...draft, id: d, isDraft: false};
    if (working.cover) working = {...working, cover: await this.mintEventCoverBlob(working.cover)};
    if (working.description?.trim()) {
      working = {...working, description: await this.mintEventDescriptionBlobs(working.description)};
    }
    if (!working.external && working.autoAdd?.target === 'group' && !working.autoAdd.groupId) {
      const gname = working.autoAdd.groupName?.trim() || working.autoAdd.label.replace(/^#/, '') || 'Event guests';
      const gid = await this.createGroup({name: gname, private: true, closed: true});
      if (gid) working = {...working, autoAdd: {...working.autoAdd, groupId: gid}};
    }
    const coordinate = eventCoordinate({pubkey: this.myPubkey, d});
    const input = this.publicInputFromDraft(working);
    const counts = this.eventHostCounts(coordinate);
    const tmpl = buildEventDocTemplate({
      d,
      content: buildEventDocContent(input),
      going: input.capacityMode ? counts.going : 0,
      waitlistCount: counts.waitlist,
      cancelled: counts.cancelled,
      nowSec: AppRuntime.nowSec(),
    });
    const signed = await this.identity.sign(tmpl);
    await this.publishOptimistic(signed);
    await this.eventDrafts.save({id: d, updatedAt: Date.now(), draft: working});
    this.emit();
    if (opts?.notifyGoing) {
      const title = input.title || 'Untitled event';
      const token = this.eventEmbedTokenFor(coordinate);
      void this.fanoutToEventGuests(coordinate, `📅 Updated — ${title}${token ? `\n${token}` : ''}`);
    }
    return coordinate;
  }

  /** Cancel an event I host: republish with the cancelled tag + notify everyone going/waitlisted.
   * The auto-add group chat deliberately STAYS (STATES §4). Irreversible. */
  async cancelEvent(coordinate: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const d = this.eventDTag(coordinate);
    const entry = await this.eventDrafts.get(d);
    const doc = this.eventDocs().get(coordinate);
    const input = entry ? this.publicInputFromDraft(entry.draft) : doc?.public;
    if (!input) return;
    const counts = this.eventHostCounts(coordinate);
    const tmpl = buildEventDocTemplate({
      d,
      content: buildEventDocContent(input),
      going: input.capacityMode ? counts.going : 0,
      waitlistCount: counts.waitlist,
      cancelled: true,
      nowSec: AppRuntime.nowSec(),
    });
    const signed = await this.identity.sign(tmpl);
    await this.publishOptimistic(signed);
    this.emit();
    const title = input.title || 'Untitled event';
    void this.fanoutToEventGuests(coordinate, `⚠ Cancelled — ${title}. Everyone going has been notified.`);
  }

  /** Republish the doc with current host-authoritative counts (after approve/undo/waitlist moves). */
  private async republishEventDoc(coordinate: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const d = this.eventDTag(coordinate);
    const entry = await this.eventDrafts.get(d);
    const doc = this.eventDocs().get(coordinate);
    const input = entry ? this.publicInputFromDraft(entry.draft) : doc?.public;
    if (!input) return;
    const counts = this.eventHostCounts(coordinate);
    const tmpl = buildEventDocTemplate({
      d,
      content: buildEventDocContent(input),
      going: input.capacityMode ? counts.going : 0,
      waitlistCount: counts.waitlist,
      cancelled: counts.cancelled,
      nowSec: AppRuntime.nowSec(),
    });
    try {
      const signed = await this.identity.sign(tmpl);
      await this.publishOptimistic(signed);
    } catch {
      // next decision republishes with fresh counts
    }
    this.emit();
  }

  /**
   * Host republish sweep (the 2026-07-21 incident fix): kind-31923 docs are addressable, so
   * `publishOptimistic`'s normal outbox-retry-on-reconnect path does not cover them the way it
   * covers a regular post — a doc rejected before the relay allowed kind 31923 (or dropped for any
   * other reason) just silently never existed on the relay, with nothing re-sending it. Republishing
   * every event I HOST that is no longer a draft is safe to repeat (addressable ⇒ idempotent), so a
   * plain sweep on every relay (re)connect — throttled to once per connect cycle — plus one fired
   * when the host opens the events management surface is enough; no "does the relay already have
   * it" check is worth building. Same signing path as {@link publishEvent} (npub, never blind).
   */
  async republishMyEventDocs(force = false): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    const now = Date.now();
    if (!force && now - this._lastEventSweepAt < 60_000) return;
    this._lastEventSweepAt = now;
    try {
      const entries = await this.eventDrafts.list();
      const mine = entries.filter(e => e.draft.isDraft === false && e.id);
      for (const entry of mine) {
        const coordinate = eventCoordinate({pubkey: this.myPubkey, d: entry.id});
        await this.republishEventDoc(coordinate);
      }
    } catch {
      // best-effort — the next reconnect or surface-open retries
    }
  }

  private async fanoutToEventGuests(coordinate: string, text: string): Promise<number> {
    const decisions = this.eventDecisions.get(coordinate);
    const recipients = new Set<string>();
    if (decisions) {
      for (const [pk, dec] of decisions) {
        if (dec.d === 'approved') recipients.add(pk);
      }
    }
    for (const w of this.eventWaitlistActive(coordinate)) recipients.add(w.pk);
    recipients.delete(this.myPubkey ?? '');
    for (const pk of recipients) {
      try {
        await this.sendDM(pk, text);
      } catch {
        // sendDM never rejects by contract; defensive
      }
    }
    return recipients.size;
  }

  /** Approve an applicant (or offer a waitlisted person their spot — same act): record the
   * decision, add them to the auto-add space, send the approve frame carrying the private reveal,
   * bump the host-authoritative going count, and re-position the remaining waitlist. */
  async approveEventApplicant(coordinate: string, pk: string): Promise<void> {
    if (!this.identity || !this.myPubkey) return;
    let per = this.eventDecisions.get(coordinate);
    if (!per) {
      per = new Map();
      this.eventDecisions.set(coordinate, per);
    }
    per.set(pk, {d: 'approved', at: AppRuntime.nowSec()});
    void this.saveEventState();
    this.emit();
    const d = this.eventDTag(coordinate);
    const entry = await this.eventDrafts.get(d);
    const draft = entry?.draft;
    const auto = draft && !draft.external ? draft.autoAdd : undefined;
    if (auto?.target === 'group' && auto.groupId) {
      try {
        await this.addGroupMember(auto.groupId, pk);
      } catch {
        // roster op retries on relay reconnect
      }
    }
    const type = draft?.type ?? 'inperson';
    const loc = draft?.location;
    const reveal: EventReveal = {};
    if ((type === 'inperson' || type === 'hybrid') && loc?.exactAddress) reveal.exactAddress = loc.exactAddress;
    if ((type === 'inperson' || type === 'hybrid') && loc?.entryNotes) reveal.entryNotes = loc.entryNotes;
    if ((type === 'online' || type === 'hybrid') && loc?.streamLink) reveal.streamLink = loc.streamLink;
    const frame = encodeEventFrame({
      t: 'approve',
      a: coordinate,
      reveal: reveal.exactAddress || reveal.entryNotes || reveal.streamLink ? reveal : undefined,
      autoAddLabel: auto?.label,
      groupId: auto?.target === 'group' ? auto.groupId : undefined,
      channelId: auto?.target === 'channel' ? auto.channelId : undefined,
    });
    const title = draft?.title || this.eventDocs().get(coordinate)?.public.title || 'the event';
    const token = this.eventEmbedTokenFor(coordinate);
    await this.sendDM(pk, `✓ You're in — ${title}${token ? `\n${token}` : ''}`, undefined, undefined, frame);
    await this.republishEventDoc(coordinate);
    void this.fanoutWaitlistPositions(coordinate);
  }

  /** Decline an applicant — notified with zero event details beyond the title they already had. */
  async declineEventApplicant(coordinate: string, pk: string): Promise<void> {
    if (!this.identity) return;
    let per = this.eventDecisions.get(coordinate);
    if (!per) {
      per = new Map();
      this.eventDecisions.set(coordinate, per);
    }
    per.set(pk, {d: 'declined', at: AppRuntime.nowSec()});
    void this.saveEventState();
    this.emit();
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const frame = encodeEventFrame({t: 'decline', a: coordinate});
    await this.sendDM(pk, `Update on ${title} — your request wasn't accepted this time.`, undefined, undefined, frame);
  }

  /** Undo a decision: the applicant returns to pending. An undone APPROVAL also removes them from
   * the auto-add group (key rotation included — kickGroupMember's existing machinery). */
  async undoEventDecision(coordinate: string, pk: string): Promise<void> {
    if (!this.identity) return;
    const per = this.eventDecisions.get(coordinate);
    const prev = per?.get(pk);
    if (!per || !prev) return;
    per.delete(pk);
    void this.saveEventState();
    this.emit();
    if (prev.d === 'approved') {
      const d = this.eventDTag(coordinate);
      const entry = await this.eventDrafts.get(d);
      const auto = entry?.draft && !entry.draft.external ? entry.draft.autoAdd : undefined;
      if (auto?.target === 'group' && auto.groupId) {
        try {
          await this.kickGroupMember(auto.groupId, pk);
        } catch {
          // roster op retries on reconnect
        }
      }
    }
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const frame = encodeEventFrame({t: 'restore', a: coordinate});
    await this.sendDM(pk, `↩ ${title} — your application is pending again.`, undefined, undefined, frame);
    if (prev.d === 'approved') await this.republishEventDoc(coordinate);
  }

  /** Offer a waitlisted person their spot = approve them (they leave the waitlist by promotion). */
  async offerEventSpot(coordinate: string, npub: string): Promise<void> {
    let pk = npub;
    try {
      const dec = nip19.decode(npub);
      if (dec.type === 'npub') pk = dec.data as string;
    } catch {
      // already hex
    }
    await this.approveEventApplicant(coordinate, pk);
  }

  /** Tell each remaining active waitlister their (possibly new) position. */
  private async fanoutWaitlistPositions(coordinate: string): Promise<void> {
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    const active = this.eventWaitlistActive(coordinate);
    for (let i = 0; i < active.length; i++) {
      const w = active[i];
      if (!w) continue;
      const frame = encodeEventFrame({t: 'wl-pos', a: coordinate, pos: i + 1});
      try {
        await this.sendDM(w.pk, `⊕ Waitlist update — you're #${i + 1} for ${title}.`, undefined, undefined, frame);
      } catch {
        // defensive; sendDM never rejects by contract
      }
    }
  }

  /** Message everyone going + waitlisted. Returns the recipient count ("Sent to N"). */
  async messageEventGuests(coordinate: string, message: string): Promise<number> {
    const title = this.eventDocs().get(coordinate)?.public.title || 'the event';
    return this.fanoutToEventGuests(coordinate, `📣 ${title} — ${message.trim()}`);
  }

  /**
   * Scroll signal (MainScreen FeedList: true on onScrollBeginDrag, false on onScrollEndDrag /
   * onMomentumScrollEnd — both firing is fine, this is idempotent). While scrolling, relay-driven
   * DEFERRED emits park: a full snapshot build + whole-tree render mid-drag is exactly what makes the
   * list jump under the user's finger during a sync burst. Settling flushes at most ONE coalesced
   * deferred emit so the feed catches up. Self-expires after RELAY_SCROLL_MAX_MS so a missed
   * scroll-end callback can never wedge emits permanently. Urgent emits (the user's own optimistic
   * post/vote/comment) are untouched — see emit().
   */
  setScrolling(scrolling: boolean): void {
    this._scrolling = scrolling;
    if (this._scrollExpiryTimer !== undefined) {
      clearTimeout(this._scrollExpiryTimer);
      this._scrollExpiryTimer = undefined;
    }
    if (scrolling) {
      // Same pre-armed-timer race as setAppBackgrounded(true) (see its doc): a relay event just
      // before the drag began may have already armed _deferredTimer, which would otherwise fire
      // MID-DRAG and jump the list under the user's finger — precisely what this park exists to
      // prevent. Cancel it and fold into the pending flag so settling still flushes it, same as any
      // other parked change.
      if (this._deferredTimer !== undefined) {
        clearTimeout(this._deferredTimer);
        this._deferredTimer = undefined;
        this._emitPendingWhileScrolling = true;
      }
      this._scrollExpiryTimer = setTimeout(() => {
        this._scrollExpiryTimer = undefined;
        this.setScrolling(false); // liveness backstop — no scroll-end callback ever arrived
      }, AppRuntime.RELAY_SCROLL_MAX_MS);
      return;
    }
    if (this._emitPendingWhileScrolling) {
      this._emitPendingWhileScrolling = false;
      this.emitDeferred();
    }
  }

  private emitDeferred(): void {
    if (this._appBackgrounded) {
      this._emitPendingWhileBackgrounded = true; // park — flushed by setAppBackgrounded(false)
      return;
    }
    if (this._scrolling) {
      this._emitPendingWhileScrolling = true; // park — flushed by setScrolling(false) or self-expiry
      return;
    }
    if (this._deferredTimer !== undefined) return;
    this._deferredTimer = setTimeout(() => {
      this._deferredTimer = undefined;
      this.emit(false); // relay firehose — non-urgent
    }, AppRuntime.RELAY_EMIT_THROTTLE_MS);
  }

  private emit(urgent = true): void {
    // Urgent (user-action) emits are never parked, and this fresh snapshot already reflects whatever
    // a concurrent scroll had parked — clear the flag so settle doesn't fire a redundant catch-up.
    if (urgent) this._emitPendingWhileScrolling = false;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot, urgent);
    }
  }
}

// ── Events surface record shapes (module-level; used by the class fields above) ────────────────

/** My RSVP for one event. `reveal` is the post-approval private payload — the only copy a guest
 * holds; deleting the record forgets it. */
interface MyEventRsvp {
  state: Exclude<RsvpState, null>;
  pos?: number;
  reveal?: EventReveal;
  autoAddLabel?: string;
  groupId?: string;
  channelId?: string;
  at: number;
}

interface EventDecision {
  d: 'approved' | 'declined';
  at: number;
}

interface EventApplicationRecord {
  note?: string;
  at: number;
  withdrawn?: boolean;
}

interface EventWaitlistRecord {
  at: number;
  left?: boolean;
}
