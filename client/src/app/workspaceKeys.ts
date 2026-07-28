/**
 * workspaceKeys — the single source of truth for per-community / per-identity storage-key naming
 * (multi-community silo, see [[stiq-multicommunity-silo]] and PLAN.md §3.3).
 *
 * STIQ lets a member be enrolled in several communities at once and switch between them. A switch
 * changes EVERYTHING — npub, display name, gradient, feed, channels, DMs — with a complete silo:
 * no state from community A ever bleeds into community B. That silo is implemented by namespacing
 * every persisted value under one of two axes:
 *
 *   • SLOT  — the KeyRing slot id (a UUID, one per enrolled identity = one ACCOUNT). Used for every
 *             identity-bound SECRET and per-account state: the credential, the self display
 *             name/gradient, the DM sent/reaction/blocklist caches, drafts, the self-profile
 *             timestamp, the blind-token wallet, the outbox (events signed by this account's npub),
 *             joined groups + encrypted-space membership (NIP-29 membership is per-npub), and the
 *             per-period picture-allowance spend. These MUST NOT bleed between accounts even when two
 *             accounts share one community, so they are namespaced by the account's slot. The secret
 *             signing key itself is already slot-namespaced by KeyStore (`stiq_privkey_<slotId>`, see
 *             keystore.ts:namespacedSkItem).
 *   • CID   — the community id (the relay onion host, `communityId(relayUrl)`). Used ONLY for the
 *             per-community PUBLIC layer: the event cache (its own encrypted DB file per community)
 *             and the name/gradient "phonebook" of OTHER members. These cache relay-PUBLIC content
 *             (the shared community feed + learned npub→name/gradient), so sharing them across the
 *             accounts of one community links nothing private and per-slot duplication would be pure
 *             storage/resync cost. This is the intentional per-community public layer.
 *
 * Multiple accounts (slots) can be enrolled in the SAME community, so the two axes are genuinely
 * distinct. The `LEGACY_*` constants are the pre-silo GLOBAL keys, and the `PREV_*_CID` helpers are
 * the earlier per-CID locations of the now-per-slot items; both exist so the one-time migrations
 * (app/migration.ts) can copy an existing user's data into the current slot's namespace without loss.
 */

// ── Legacy (pre-silo) global keys — read only by the migration, never written after v1. ──
export const LEGACY_SK_ITEM = 'stiq.identity.sk';
export const LEGACY_RELAY_ITEM = 'stiq.identity.relay';
export const LEGACY_CRED_TOKEN_ITEM = 'stiq.identity.cred.token';
export const LEGACY_CRED_SIG_ITEM = 'stiq.identity.cred.sig';
export const LEGACY_IDENTITY_AT_ITEM = 'stiq.identity.self.at';
export const LEGACY_DISPLAYNAME_SELF = 'stiq.displayName.self';
export const LEGACY_DISPLAYNAME_BOOK = 'stiq.displayName.book.v2';
export const LEGACY_GRADIENT_SELF = 'stiq.gradient.self.v1';
export const LEGACY_GRADIENT_BOOK = 'stiq.gradient.book.v1';
export const LEGACY_DRAFTS = 'stiq:drafts';
export const LEGACY_DM_SENT = 'stiq.dm.sent';
export const LEGACY_DM_REACTIONS = 'stiq.dm.reactions';
export const LEGACY_DM_FAILED_WRAPS = 'stiq.dm.failedWraps';
export const LEGACY_DM_BLOCKLIST = 'stiq_dm_blocklist';
export const LEGACY_OUTBOX = 'stiq.outbox';
export const LEGACY_GROUPS_JOINED = 'stiq.groups.joined';
export const LEGACY_SPACES_ENCRYPTED = 'stiq.spaces.encrypted';
export const LEGACY_EVENTS_CACHE = 'stiq.events.cache';
export const LEGACY_SQLITE_DB = 'stiq-cache.db';
export const LEGACY_SQLITE_DBKEY_ITEM = 'stiq.cache.dbkey';
/** Pre-slot GLOBAL picture-allowance spend (media/pictureAllowance.ts) — migrated into the active slot. */
export const LEGACY_PICTURE_SPEND = 'stiq.pictures.spend';
/** Pre-slot GLOBAL community-key mirror (blind/communityKey.ts) — dropped; wiped by the migration/duress. */
export const LEGACY_COMMUNITY_KEY = 'stiq.community.key';

// ── PREVIOUS per-CID locations (v1 silo) of items now namespaced per SLOT — read ONLY by the
//    per-slot migration (migrateCidToSlot); never written after. ─────────────────────────────────
export const PREV_OUTBOX_CID = (cid: string): string => `stiq.outbox.${cid}`;
export const PREV_GROUPS_JOINED_CID = (cid: string): string => `stiq.groups.joined.${cid}`;
export const PREV_SPACES_ENCRYPTED_CID = (cid: string): string => `stiq.spaces.encrypted.${cid}`;

// ── SLOT-namespaced keys (per identity). ────────────────────────────────────────────────
export const credTokenKey = (slotId: string): string => `stiq_cred_token_${slotId}`;
export const credSigKey = (slotId: string): string => `stiq_cred_sig_${slotId}`;
export const identityRelayKey = (slotId: string): string => `stiq.identity.relay.${slotId}`;
export const identityAtKey = (slotId: string): string => `stiq.identity.self.at.${slotId}`;
export const displayNameSelfKey = (slotId: string): string => `stiq.displayName.self.${slotId}`;
export const gradientSelfKey = (slotId: string): string => `stiq.gradient.self.v1.${slotId}`;
export const draftsKey = (slotId: string): string => `stiq:drafts:${slotId}`;
export const dmSentKey = (slotId: string): string => `stiq.dm.sent.${slotId}`;
export const dmReactionsKey = (slotId: string): string => `stiq.dm.reactions.${slotId}`;
/** SLOT-namespaced negative decrypt cache (undecryptable gift-wrap ids). Public ids only — no plaintext. */
export const dmFailedWrapsKey = (slotId: string): string => `stiq.dm.failedWraps.${slotId}`;
/** Events surface state — per ACCOUNT: my RSVPs (incl. any post-approval reveal payloads, which are
 *  SECRETS — exact addresses live here) + my host-side application decisions. Keyed by the event's
 *  31923 coordinate, which is globally unique, so no per-community split is needed. */
export const eventStateKey = (slotId?: string): string =>
  slotId ? `stiq.events.state.${slotId}` : 'stiq.events.state';
export const dmBlocklistKey = (slotId: string): string => `stiq_dm_blocklist.${slotId}`;
/** LOCAL, device-only feed author-mute set — per ACCOUNT (a mute is "hide this author from ME").
 *  PURELY local: nothing is ever published to the relay (no kind-10000 mute list, no event of any
 *  kind), so it leaks nothing and never touches relay-blindness. Namespaced per slot so a mute in
 *  one account never bleeds into a sibling account, mirroring the DM blocklist. */
export const mutedAuthorsKey = (slotId: string): string => `stiq.feed.mutedAuthors.${slotId}`;
/** Outbox (pending optimistic sends) — per ACCOUNT: the events are signed by this slot's npub, so a
 *  sibling account in the same community must never republish them (attribution leak). */
export const outboxKey = (slotId: string): string => `stiq.outbox.slot.${slotId}`;
/** Joined NIP-29 group ids — per ACCOUNT (group membership is per-npub). */
export const groupsJoinedKey = (slotId: string): string => `stiq.groups.joined.slot.${slotId}`;
/** My outstanding join requests — per ACCOUNT (a 9021 is signed by one npub). A DECLINE never
 *  clears this: the requester keeps rendering "pending" by design (silent-decline contract). */
export const joinRequestsKey = (slotId?: string): string =>
  slotId ? `stiq.joinreqs.slot.${slotId}` : 'stiq.joinreqs';
/** Space invites dismissed with "Not now" — per ACCOUNT (the invite DM was addressed to one npub). */
export const invitesDismissedKey = (slotId?: string): string =>
  slotId ? `stiq.invites.dismissed.slot.${slotId}` : 'stiq.invites.dismissed';
/** Encrypted-space id set — per ACCOUNT (only the account that joined a space may treat it encrypted). */
export const spacesEncryptedKey = (slotId: string): string => `stiq.spaces.encrypted.slot.${slotId}`;
/** Per-(space,member) highest space-key epoch THIS admin device already delivered (30079) — the
 *  dedupe behind the member-arrival key backfill. Per ACCOUNT: deliveries are signed by one npub. */
export const spaceKeysDeliveredKey = (slotId?: string): string =>
  slotId ? `stiq.spacekeys.delivered.slot.${slotId}` : 'stiq.spacekeys.delivered';
/** Last EXPLICITLY-advertised relay enforcement flags — per COMMUNITY (enforcement is a property
 *  of the community's relay, shared by every account in it, never of one identity slot). The
 *  sticky half of capability negotiation: a failed/absent NIP-11 fetch must never downgrade what
 *  the community is known to enforce (see nostr/capabilities.ts explicitEnforcedFlags). Plain
 *  booleans/numbers — no secret — so AsyncStorage is the right home. */
export const stickyEnforcementKey = (cid?: string): string =>
  cid ? `stiq.caps.enforced.sticky.${cid}` : 'stiq.caps.enforced.sticky';
/** Per-period picture-allowance spend — per ACCOUNT (a metered budget belongs to one npub). */
export const pictureSpendKey = (slotId: string): string => `stiq.pictures.spend.${slotId}`;
/** Durable recovery queue of token-exhausted compose intents (raw post bodies) awaiting an auto
 *  re-sign — per ACCOUNT: the body is sensitive and belongs to one npub, so it rides an encrypted
 *  slot-scoped key exactly like the outbox (never a global/plaintext key). */
export const pendingComposeKey = (slotId: string): string => `stiq.pending.compose.slot.${slotId}`;
/** Draft-access requests THIS OWNER has silently denied (Phase 5§D) — per ACCOUNT (a
 *  `DraftAccessRequest` is addressed to one npub's owner-key, and denying it publishes no relay-side
 *  signal, so nothing else would ever stop the same request from re-appearing). Keyed
 *  `${draftId}:${requesterPubkey}` → the denied request's `at`; a strictly newer re-request
 *  re-surfaces in `getDraftAccessQueue` (see feed/draftAccess.ts). */
export const draftAccessDeniedKey = (slotId?: string): string =>
  slotId ? `stiq.draftaccess.denied.slot.${slotId}` : 'stiq.draftaccess.denied';

// ── Event-store keys — now per-(CID, SLOT) for COMPLETE per-account isolation (finding #4). The
//    encrypted event-cache DB used to be namespaced by community id ONLY and SHARED across the
//    accounts of one community, so two accounts in the same community shared one cache holding BOTH
//    the public feed AND each account's kind-1059 DM gift-wraps — account B's downloaded posts +
//    DM wraps physically sat in account A's file. Appending the account SLOT gives each account its
//    OWN store file / SQLCipher key / fallback cache blob. `slotId` is an OPTIONAL trailing param so
//    the legacy/no-slot path (and the one-time wipe migration that must recompute the OLD per-cid
//    names) still resolves byte-identically. The store is a re-syncable cache, so a per-account file
//    simply re-syncs from the relay — no content migration.
//
//    The phonebooks below stay per-CID: they cache only PUBLIC learned npub→name/gradient (no private
//    data leaks by sharing them across a community's accounts), so a per-slot duplicate would be pure
//    storage/resync cost.
export const eventsCacheKey = (cid: string, slotId?: string): string =>
  slotId ? `stiq.events.cache.${cid}.${slotId}` : `stiq.events.cache.${cid}`;
export const sqliteDbKeyItem = (cid: string, slotId?: string): string =>
  slotId ? `stiq.cache.dbkey.${cid}.${slotId}` : `stiq.cache.dbkey.${cid}`;
export const displayNameBookKey = (cid: string): string => `stiq.displayName.book.v2.${cid}`;
export const gradientBookKey = (cid: string): string => `stiq.gradient.book.v1.${cid}`;

// ── Device-global index (NOT siloed): which account slot was last active in each community, so a
//    community switch restores the last account used there rather than an arbitrary first match. ──
export const COMMUNITY_ACTIVE_SLOT_MAP = 'stiq.community.activeSlot';

/**
 * Per-(community, account) SQLCipher database FILE name. The community id is an onion host
 * (`[a-z2-7]{56}.onion`); the dot is replaced so the file name stays a single clean token, and any
 * other unexpected character is stripped defensively (the slot id — a UUID — is sanitised the same
 * way). Sanitisation is centralised here so the store, the wipe migration (which recomputes the OLD
 * per-cid name), and `removeCommunity`/`removeIdentity` (which delete the file) all agree on the
 * exact name. `slotId` is OPTIONAL: omitting it yields the pre-per-account per-cid name, which the
 * migration uses to wipe the now-orphaned legacy file and the un-enrolled path uses as-is.
 */
export const sqliteDbFile = (cid: string, slotId?: string): string =>
  slotId
    ? `stiq-cache-${cid.replace(/[^a-z0-9]+/gi, '_')}__${slotId.replace(/[^a-z0-9]+/gi, '_')}.db`
    : `stiq-cache-${cid.replace(/[^a-z0-9]+/gi, '_')}.db`;
