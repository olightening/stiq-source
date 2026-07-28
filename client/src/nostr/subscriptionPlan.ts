/**
 * Subscription planning — turns the local cache state into the set of REQ filters the
 * client opens on each (re)connect. Two goals beyond "get the events":
 *
 *  1. The standing live feed REQ is LIMIT-ONLY, never `since`-bounded (see {@link buildLiveFeedFilter}).
 *     khatru (the relay this client targets) applies the REQ filter's `since` to EVERY
 *     live-broadcast event, not just the initial stored-event page (khatru's listener.go applies
 *     go-nostr filter matching uniformly) — so a since-bounded standing REQ would silently DROP
 *     newly-published events whose `created_at` happens to fall below the connect-time `since`:
 *     back-dated blind posts (created_at fuzzed backward — see blindPost.ts), a resent/delayed
 *     post, or ordinary clock skew. A Nostr REQ with a `since`/`limit` returns its initial page and
 *     then STAYS OPEN, streaming every new matching event as it's published — that live tail is the
 *     feed's only delivery mechanism, so it must never be omitted, and it must never risk dropping
 *     a live event by carrying a `since`. Incremental catch-up (asking only for what a warm cache
 *     is missing) still happens — via {@link buildFeedFilter} — but ONLY in the NIP-77
 *     reconciliation / gap-repair pass and in `requestOlder` scroll-back, where a `since`/`until`
 *     window is applied to a ONE-SHOT historical query, not to a subscription that stays open for
 *     future broadcasts. An optional NIP-77 reconciliation (RelayClient's `negentropy` option,
 *     gated by config's NEGENTROPY_SYNC) runs ADDITIONALLY on a warm cache, on its OWN subId,
 *     purely as a gap-repair pass — never in place of the live `feed` sub.
 *
 *  2. Identity-scoped privacy (PLAN.md §4): several subscriptions are inherently tied to the
 *     member's real npub — the DM inbox (gift wraps, kind 1059, tagged `#p == me`), the NIP-51
 *     self-lists (`authors == me`), and private-space key deliveries (kind 30079, `#p == me`).
 *     Asking the relay for any of these unscoped-to-me tells it which npub is behind the
 *     connection — and this is the SAME connection blind posts are published on, so the relay
 *     could otherwise link a member's real identity to their throwaway-key posts (audit #1).
 *     Every such subscription therefore carries a SHARED per-identity DECOY cover set: `me` mixed
 *     with member pubkeys harvested from feed authors, so `me` is one of k+1 candidates. The set
 *     is DETERMINISTIC per identity (not re-rolled per connection), so a relay logging the
 *     #p/authors arrays across reconnects sees a constant set and cannot isolate `me` by
 *     intersection (audit #19); it uses no Math.random, so there is no PRNG state to reconstruct
 *     and replay (audit #25). The decoy CANDIDATE pool is also FROZEN per identity (S6): decoys are
 *     ranked over a one-time snapshot, never the live (growing) feed-author set, so cover-set
 *     membership can't drift as new authors arrive — otherwise a relay intersecting the arrays
 *     across pool growth could subtract the drifting decoys and re-isolate the invariant `me`. When
 *     too few members are known to camouflage (cold start), each sub falls back to a form that still
 *     never pins `me` (unscoped firehose, or omitted).
 *
 * Pure and synchronous so it can run inside RelayClient's onOpen and be unit-tested without a
 * socket. The cover set is stable across reconnects for a given identity AND as the live
 * feed-author pool grows (the decoy candidate pool is frozen — S6).
 */
import type {EventStore} from './store';
import {warnKindDrift, type Subscription, type SubscriptionPlan} from './RelayClient';
import type {ReqFilter} from './protocol';
import {Kind} from './events';
import {
  FEED_KINDS,
  FEED_KINDS_SCOPED_CHANNELS,
  CHANNEL_CHAT_KINDS,
  SUBSCRIBED_KINDS,
  KIND_VOICE_MESSAGE,
  KIND_VOICE_COMMENT,
  KIND_MEDIA_BLOB,
  SPACE_KEY_REQUEST_D_PREFIX,
} from '../contracts';
import {KIND_TAG_POLICY} from '../feed/tagPolicy';
import {D_IDENTITY_BEACON, D_IDENTITY_PROFILE} from '../profile/identityDoc';
import {COLD_FEED_LIMIT, SCOPED_CHANNEL_SYNC} from '../config';

/**
 * Feed content kinds pulled incrementally on the main subscription (DMs handled separately). This
 * MUST cover every kind a member can publish as visible community content — otherwise one user's
 * posts of that kind never reach anyone else (the relay stores them, but no one ever REQs them).
 * The canonical list now lives in the contract module ({@link ../contracts}); the ingest gate
 * SUBSCRIBED_KINDS is derived from it there, and the render/store-read set AppRuntime.FEED_KINDS is
 * being reconciled to it separately. Re-exported here so existing importers keep referencing it via
 * this module.
 */
export {FEED_KINDS};

/**
 * The kind set the UNSCOPED firehose actually asks for — the ONE place the SCOPED_CHANNEL_SYNC
 * decision is made, so every wire filter downstream inherits it and none of them can drift apart.
 *
 * Flag ON is the committed default as of 2026-07-15.
 * Flag OFF → the `FEED_KINDS` array itself (identity, not a copy): byte-identical to pre-bug-8, and
 * still a supported rollback (covered by nostr/subscriptionPlan.channels.off.test.ts via a config mock).
 * Flag ON  → `FEED_KINDS_SCOPED_CHANNELS` — FEED_KINDS minus the channel-message kinds, which move
 * to the membership-scoped `channels` sub built in {@link createFeedAndDmPlan}.
 *
 * Every REQ that names the firehose universe MUST source it here, and so must every store-side
 * snapshot paired with one (notably the negentropy reconcile's getItems — see
 * {@link buildReconcileFilter}: a bound mismatch makes the two sides fingerprint different universes
 * and corrupts the round). The call sites are buildLiveFeedFilter / buildFeedFilter /
 * buildReconcileFilter here, plus App.tsx's `reconcileKinds`, `feedIsWarm` and `requestOlderFeed`.
 */
export const FIREHOSE_FEED_KINDS: number[] = SCOPED_CHANNEL_SYNC
  ? FEED_KINDS_SCOPED_CHANNELS
  : FEED_KINDS;

/**
 * The MEDIA-heavy feed kinds excluded from the low-bandwidth text-only reconcile: NIP-A0 voice note
 * (1222) / voice reply (1244) and the generic media-blob carrier (30351). Derived from the contract
 * constants (never bare literals). 30351 is deliberately never in FEED_KINDS — it is fetch-on-tap
 * only (contracts' FETCH_ONLY_KINDS) — so filtering it is a defensive no-op that stays correct if a
 * media kind is ever added to the feed.
 */
const TEXT_ONLY_EXCLUDED_KINDS: readonly number[] = [
  KIND_VOICE_MESSAGE,
  KIND_VOICE_COMMENT,
  KIND_MEDIA_BLOB,
];

/**
 * The firehose kinds with the media-heavy kinds removed — the kind set the LOW-BANDWIDTH degraded
 * reconcile uses (gated behind SYNC_LOW_BANDWIDTH at the App.tsx call site) so a metered / slow Tor
 * circuit fetches text posts/comments/reactions/reports/articles/polls FIRST and defers the large
 * voice events. Kept text: Post(1)/Reaction(7)/Comment(1111)/Report(1984)/spend-witness(1986)/
 * Article(30023)/Poll(1068)/PollResponse(1018)/LiveActivity(30311), plus LiveChat(1311) only while
 * SCOPED_CHANNEL_SYNC is OFF (with it ON, 1311 is not on the firehose at all, so it cannot be part
 * of a firehose reconcile's universe).
 *
 * Derived from {@link FIREHOSE_FEED_KINDS}, NOT from FEED_KINDS — the two flags are independent and
 * a low-bandwidth reconcile must still respect channel scoping. Both the wire reconcile filter and
 * the getItems snapshot must use this identical set in lockstep (see {@link buildReconcileFilter}'s
 * `kinds` override) or the two sides fingerprint different universes.
 */
export const TEXT_ONLY_FEED_KINDS: number[] = FIREHOSE_FEED_KINDS.filter(
  k => !TEXT_ONLY_EXCLUDED_KINDS.includes(k),
);

/**
 * NIP-17 lets a gift wrap's `created_at` be back-dated up to ~2 days to obscure timing, so a
 * `since` derived from stored wraps must reach back at least that far or it would miss
 * legitimately-recent DMs. We subtract this fuzz window (plus the caller's overlap) for the DM
 * subscription only.
 *
 * This window CANNOT safely shrink: because a wrap's timestamp is randomized, a genuinely-new DM
 * can arrive with a created_at up to 2 days old, and a narrower `since` would skip it. The cost of
 * re-streaming the window on every reconnect is now bandwidth-only, not CPU: RelayClient.ingest()
 * dedupes on store.has(id) BEFORE the schnorr verify (audit #17), so a re-delivered wrap already in
 * the cache is dropped without re-verifying. (A full NIP-77 reconciliation of kind 1059 would remove
 * even the bandwidth cost, but that is out of scope here.)
 */
const DM_TIMESTAMP_FUZZ_SECONDS = 2 * 24 * 60 * 60;

/** Minimum real members needed before scoped+decoy cover is safe; below this, use firehose. */
const MIN_DECOY_POOL = 3;

/**
 * Largest FROZEN decoy candidate snapshot kept per identity (S6). Decoys are ranked/selected from
 * this frozen snapshot rather than the live feed-author set, so cover-set membership can't drift as
 * new authors arrive. Capped so a large warm cache doesn't freeze (or persist) thousands of pubkeys;
 * the relay only ever sees the `count` selected decoys, so a bigger frozen pool buys no extra cover.
 */
const FROZEN_DECOY_POOL_MAX = 32;

/**
 * Module-scoped fallback store for the frozen per-identity decoy snapshot (S6), keyed by `me`. Lives
 * in module scope so the snapshot outlives the fresh plan closure App.tsx builds on every RelayClient
 * reconnect (each reconnect calls createFeedAndDmPlan anew). Callers can pass `frozenDecoyStore` to
 * extend stability across app restarts via secure/local storage.
 *
 * Keys are NAMESPACED because two different decoy universes are frozen per identity: the npub pool
 * (key `me`) covering the DM / self-list / space-key subs, and the channel-coordinate pool (key
 * {@link channelPoolKey}(me)) covering the scoped `channels` sub. Sharing one key would let a pool of
 * pubkeys be handed back as "channel coordinates" (and vice versa) — the freeze is first-write-wins,
 * so whichever sub ran first would silently poison the other.
 */
const frozenDecoyPools = new Map<string, readonly string[]>();

/** Namespaced frozen-pool key for the channel-coordinate decoy universe — see {@link frozenDecoyPools}. */
function channelPoolKey(me: string): string {
  return `chan:${me}`;
}

export interface FeedAndDmPlanOptions {
  store: EventStore;
  /** The user's hex pubkey, or undefined when locked / not enrolled (then no DM sub). */
  getMyPubkey: () => string | undefined;
  /** Organizer Nostr pubkey; when set, subscribes to kind-30078 for live tag policy updates. */
  getOrganizerPubkey?: () => string | undefined;
  /**
   * The channel coordinates (`30311:<owner>:<d>`) the member is actually IN — followed via their
   * NIP-51 kind-10009 list, owned, or administered (AppRuntime.channelSyncIds). These are the REAL
   * values the `channels` sub's cover set hides. A GETTER because membership changes while the app
   * runs; the plan re-reads it on every (re)connect.
   *
   * Omitted → NO `channels` sub is emitted at all and kind 1311 is simply not synced on this
   * connection. That is the correct default for a caller with no channel UI: background/syncTask.ts
   * passes neither this nor {@link getKnownChannelIds}, exactly as it wires no `subscribeGroup` for
   * NIP-29 groups. Inert unless config's SCOPED_CHANNEL_SYNC is ON.
   */
  getJoinedChannelIds?: () => readonly string[];
  /**
   * Every channel coordinate this device knows exists (AppRuntime.knownChannelIds, derived from the
   * cached kind-30311 definitions, which stay on the firehose). The DECOY CANDIDATE universe for the
   * `channels` sub: a decoy must be a channel the relay can plausibly believe we read, and a
   * coordinate we've never seen a definition for is not that.
   *
   * Passed in as a getter rather than scanned from the store here on purpose — deriving a coordinate
   * needs channels/channels.ts's `parseChannel`, and importing it into this module would both risk an
   * import cycle and duplicate the delete-aware (kind-5) channel-list rules AppRuntime already owns.
   * Same shape as getMyPubkey/getOrganizerPubkey, and it keeps this module pure + socket-free.
   */
  getKnownChannelIds?: () => readonly string[];
  /** Cold-sync bound applied to the feed when the cache is empty. */
  feedLimit?: number;
  /**
   * Cold-sync bound applied to the self identity-enc firehose when no decoy cover is available —
   * ALSO the pagination page size for the self-profile sub (see {@link DEFAULT_SELF_PROFILE_LIMIT}):
   * the sub pages backward through history in chunks of this size rather than one unbounded burst,
   * so lowering it shrinks the per-tick cost without shrinking what is eventually discoverable.
   */
  selfProfileLimit?: number;
  /** Cooperative pause between older self-profile identity-enc pages. */
  selfProfilePageDelayMs?: number;
  /** Seconds subtracted from the high-water mark to absorb relay lag / clock skew. */
  overlapSeconds?: number;
  /** Target number of decoy recipients mixed into the DM request (cover traffic). */
  decoyCount?: number;
  /** Maximum gift wraps delivered in one history page. */
  dmPageSize?: number;
  /** Cooperative pause between older gift-wrap pages. */
  dmPageDelayMs?: number;
  /**
   * Test seam for decoy selection. When set, it selects both the decoys and the array order; the
   * production default is a deterministic, per-identity keyed selection (no Math.random, stable
   * across reconnects — see buildCoverSet).
   */
  sample?: <T>(arr: readonly T[], n: number) => T[];
  /**
   * Persistence seam for the FROZEN per-identity decoy snapshot (S6). When provided, the frozen
   * candidate pool survives app restarts — wire it to secure/local storage so cover-set membership
   * is stable across restarts, not just reconnects. `load` returns the stored snapshot for `me` (or
   * undefined if none frozen yet); `save` persists a freshly-frozen snapshot. When omitted, the
   * snapshot lives in module scope and stays stable across reconnects within one process. Also a
   * test seam for isolating the frozen store per test.
   */
  frozenDecoyStore?: {
    load: (me: string) => readonly string[] | undefined;
    save: (me: string, decoys: readonly string[]) => void;
  };
  /**
   * The relay's advertised allow-list (`caps.allowedKinds`). A GETTER because caps are negotiated
   * once per (re)connect — after this plan is built — so it must be read live when the plan runs. Used
   * only to WARN (never reject) when the client's firehose kinds drift from what the relay serves
   * (C6). Absent / caps fallback (a superset of the client's kinds) → no warning, unchanged behaviour.
   */
  getAllowedKinds?: () => readonly number[];
  /**
   * Durable feed-state snapshot floor (T16-S3): a per-kind high-water map (from feedSnapshot.ts)
   * seeded on cold boot so an aggressive compaction that age-expired a low-volume kind's only rows
   * can't drop the incremental `since` back to the cold horizon and re-stream a large window over
   * Tor. Threaded into the since-derived subscriptions via {@link highWaterSince} (the floor only
   * ever RAISES `since` and only for kinds actually present in the snapshot). Omitted ⇒ byte-identical
   * to today; the standing live feed REQ stays limit-only regardless (it never carries a `since`).
   */
  snapshotHighWater?: Record<number, number>;
}

const DEFAULT_OVERLAP_SECONDS = 300;
const DEFAULT_DECOY_COUNT = 4;
/** Cold-sync bound for the feed. Sourced from config so the feed REQ, a fresh group's chat
 * resubscription, and the older-page primitive all default to the same "latest ~50" shape. */
const DEFAULT_FEED_LIMIT = COLD_FEED_LIMIT;
const DEFAULT_DM_PAGE_SIZE = 25;
const DEFAULT_DM_PAGE_DELAY_MS = 50;
/**
 * Cold-sync PAGE SIZE for the self identity-enc firehose (audit finding #4/heaviness-audit #4: this
 * sub, unscoped and uncapped-in-spirit at the old 500, was the single largest event burst in the
 * whole cold plan — 10x the feed's own COLD_FEED_LIMIT). On a fresh device (empty cache, no cover
 * yet) the self-profile sub can't be author-scoped without leaking `me`, so it firehoses every
 * member's identity-enc profile and adopts only the one that decrypts (ours).
 *
 * Lowered to match {@link COLD_FEED_LIMIT} — no single page of this sub is any heavier than the
 * feed's own already-accepted cold burst — and, unlike a bare `limit` (which would silently cap
 * discovery at whichever N events the relay judges newest and could miss our own doc in a community
 * with more than N members who've edited their profile more recently than we last did), this sub
 * carries the SAME pagination treatment as the `dm` sub below (`pagination: {pageSize, delayMs}`):
 * RelayClient pages backward via `until` until a page comes back short, so the FULL set of published
 * identity-enc docs is still reachable regardless of community size — only PACED across ticks rather
 * than delivered as one synchronous verify/insert storm. Identity-doc discovery is therefore strictly
 * MORE reliable than the old hard cap, not less, while the felt cost per tick drops ~10x.
 */
const DEFAULT_SELF_PROFILE_LIMIT = COLD_FEED_LIMIT;
/** Cooperative pause between self-profile identity-enc pages — mirrors {@link DEFAULT_DM_PAGE_DELAY_MS}. */
const DEFAULT_SELF_PROFILE_PAGE_DELAY_MS = DEFAULT_DM_PAGE_DELAY_MS;

/**
 * Newest cached `created_at` for `kinds` minus `overlap`, or undefined for a cold cache.
 *
 * `snapshotHighWater` (T16-S3, optional) is a durable per-kind floor: when aggressive compaction
 * (COMPACTION_V2) age-expires a low-volume kind's ONLY cached rows, the live store high-water would
 * drop back to the cold horizon and re-stream a large window over Tor. Flooring `latest` at the
 * snapshot's recorded high-water for any of `kinds` prevents that regression. It only ever RAISES
 * `latest` (max), and is entirely inert when omitted (the default path is byte-identical).
 */
export function highWaterSince(
  store: EventStore,
  kinds: number[],
  overlapSeconds: number,
  snapshotHighWater?: Record<number, number>,
): number | undefined {
  let latest = store.latestCreatedAt(kinds);
  if (snapshotHighWater) {
    for (const kind of kinds) {
      const snap = snapshotHighWater[kind];
      if (snap !== undefined && (latest === undefined || snap > latest)) {
        latest = snap;
      }
    }
  }
  if (latest === undefined) {
    return undefined;
  }
  return Math.max(0, latest - overlapSeconds);
}

/**
 * NIP-29 group chat kinds (message / thread root / reply). Reactions (kind 7) are intentionally
 * EXCLUDED from the high-water calculation: kind 7 is shared with the feed, so the store's global
 * kind-7 high-water mark is polluted by feed reactions and would produce a `since` far newer than
 * the group's own reaction history — silently dropping older group reactions on resubscribe.
 */
const GROUP_CHAT_KINDS = [9, 11, 12];

/**
 * Incremental `since` for a single group's chat resubscription: the newest cached chat message
 * (kinds 9/11/12) tagged with this `#h` group id, minus `overlapSeconds`, or undefined when we
 * hold no chat for it yet (a fresh device must still receive the full history). Computed PER GROUP
 * (not a global chat high-water mark) so a quiet group can't inherit an active group's newer HWM
 * and miss its own backlog. Re-requested messages within the overlap dedupe on id in ingest().
 */
export function groupChatSince(
  store: EventStore,
  groupId: string,
  overlapSeconds: number,
): number | undefined {
  let latest: number | undefined;
  for (const kind of GROUP_CHAT_KINDS) {
    for (const ev of store.query({kinds: [kind]})) {
      // `#h` scopes the event to its group; skip chat belonging to other joined groups.
      if (ev.tags.some(t => t[0] === 'h' && t[1] === groupId)) {
        if (latest === undefined || ev.created_at > latest) latest = ev.created_at;
      }
    }
  }
  return latest === undefined ? undefined : Math.max(0, latest - overlapSeconds);
}

/**
 * Incremental `since` for a single channel's chat resubscription: the newest cached kind-1311
 * message carrying this channel's `#a` coordinate, minus `overlapSeconds`, or undefined when we hold
 * none for it yet (an unjoined channel opened from a profile / space embed / deep link must still
 * receive history). The channel twin of {@link groupChatSince}, and per-channel for the same reason
 * it is per-group: a global kind-1311 high-water would let a busy channel's newer HWM suppress a
 * quiet channel's entire backlog.
 *
 * Used ONLY by the per-channel `channel:<coord>` sub opened while a channel view is on screen — the
 * paging/history sub, exactly like `subscribeGroup`'s chatFilter. The STANDING `channels` sub is
 * limit-only and never carries a `since` (see {@link buildChannelChatFilter}).
 */
export function channelChatSince(
  store: EventStore,
  channelId: string,
  overlapSeconds: number,
): number | undefined {
  let latest: number | undefined;
  for (const kind of CHANNEL_CHAT_KINDS) {
    for (const ev of store.query({kinds: [kind]})) {
      // `a` scopes the message to its channel coordinate; skip chat belonging to other channels.
      if (ev.tags.some(t => t[0] === 'a' && t[1] === channelId)) {
        if (latest === undefined || ev.created_at > latest) latest = ev.created_at;
      }
    }
  }
  return latest === undefined ? undefined : Math.max(0, latest - overlapSeconds);
}

/**
 * The filter set for an OPEN space view's scoped chat sub (`channel:<coord>` / `group:<id>`):
 * the incremental since tail PLUS a newest-first bounded backfill page, in one REQ.
 *
 * WHY TWO FILTERS (2026-07-28 field bug — "posts inside channels are not loading for some channels
 * while loading for others"): {@link channelChatSince}/{@link groupChatSince} derive `since` from
 * the newest CACHED message, but a newest message does not imply contiguous history below it. Three
 * producers cache newest-only strays with a hole underneath:
 *   • the standing `channels` sub's SHARED limit page — newest-N across the whole cover set, so
 *     after any offline window (the arti CBT outage made it a two-day one) each busy channel gets a
 *     thin newest slice and nothing else;
 *   • the retention prune — 1311 and 9/11/12 are count-capped GLOBALLY keeping the newest, so a
 *     busy space evicts a quiet space's older rows locally;
 *   • the member's own echoed posts during a degraded window.
 * A since-only resub then never asks below the stray, and these kinds are OUTSIDE the NIP-77
 * reconcile universe (FIREHOSE_FEED_KINDS drops 1311 under SCOPED_CHANNEL_SYNC; group kinds were
 * never in it), so the hole NEVER heals — that space reads "not loading" forever, while a space
 * whose watermark predates the hole (or a true-cold one) loads fine. That asymmetry is exactly the
 * field report.
 *
 * The backfill page bounds the heal at `limit` (the same bound the feed's cold page accepts); the
 * since tail keeps completeness ABOVE the watermark (a backlog deeper than `limit` since last sync
 * still arrives in full). Both filters stay on the open REQ, and a live event matches both — khatru
 * forwards it once per sub. Re-delivered events dedupe on store.has(id) BEFORE the schnorr verify
 * (RelayClient.ingest, audit #17), so the overlap costs bandwidth only, never CPU. Cold
 * (`since === undefined`) emits the single limit-only filter — byte-identical to the previous
 * behaviour.
 */
export function buildOpenChatFilters(
  kinds: number[],
  tagKey: '#a' | '#h',
  id: string,
  since: number | undefined,
  limit = DEFAULT_FEED_LIMIT,
): ReqFilter[] {
  const backfill: ReqFilter = {kinds, limit};
  backfill[tagKey] = [id];
  if (since === undefined) return [backfill];
  const tail: ReqFilter = {kinds, since};
  tail[tagKey] = [id];
  return [tail, backfill];
}

/**
 * Ceiling on the space-scoped kind-30079 backfill below. Deliveries are addressable per
 * (author, `<spaceId>:<epoch>:<member>`), so what the relay holds for one space is bounded by
 * members × epochs × keying admins — 100 comfortably covers the current epoch of any
 * realistically-sized private space while keeping a worst-case REQ small over Tor.
 */
const SPACE_KEY_FETCH_LIMIT = 100;

/**
 * The two space-key RECOVERY filters that ride a group's on-open scoped subscription, healing the
 * two ways a private space goes permanently dark (2026-07-28, OPEN_ITEMS §3.1):
 *
 *  1. `{kinds:[30079], '#h': [spaceId]}` — re-fetch the space's key deliveries ON OPEN. The
 *     standing `space-keys` sub is since-bounded by the newest cached 30079 ACROSS ALL SPACES
 *     (highWaterSince has no per-space memory), so one newer delivery anywhere pins `since` above
 *     an older delivery this member never received — the exact since-poisoning shape
 *     {@link buildOpenChatFilters} fixed for messages, healed the same way: ask again, scoped and
 *     bounded, and let ingest's id-dedupe make the overlap bandwidth-only. Space-scoped via `#h`
 *     (never `#p:[me]` — an unmixed `#p` REQ would deanonymize the member; deliveries addressed
 *     to others are NIP-44-sealed to THEIR keys and simply fail to unwrap here, like DM decoys).
 *
 *  2. `{kinds:[30078], '#d': ["space-key-request:<spaceId>"]}` — the redelivery REQUESTS from
 *     stranded members (see channels/membership buildSpaceKeyRequest). Exact-`d` match: every
 *     requester uses the same `d` value for a given space (addressable per author), so this needs
 *     no limit — the relay holds at most one live doc per member. Reaching a keyed ADMIN when they
 *     open the space is the entire delivery path for requests, mirroring the liveness of the
 *     39002-driven key backfill.
 */
export function buildSpaceKeyRecoveryFilters(spaceId: string): ReqFilter[] {
  return [
    {kinds: [Kind.SpaceKeyDelivery], '#h': [spaceId], limit: SPACE_KEY_FETCH_LIMIT},
    {kinds: [Kind.AppData], '#d': [`${SPACE_KEY_REQUEST_D_PREFIX}${spaceId}`]},
  ];
}

/**
 * Incremental `since` for the self identity-enc profile resubscription: the newest cached
 * kind-30078 `d="identity-enc"` event authored by `me`, minus `overlapSeconds`, or undefined when
 * we hold none yet (a fresh device must still pull the full profile). Scoped to `me` — NOT a global
 * kind-30078 high-water — because kind 30078 also carries identity beacons / space-settings /
 * org-config whose newer timestamps would otherwise push `since` past our own not-yet-adopted
 * profile and silently skip it on backfill (same pollution hazard groupChatSince avoids for kind 7).
 * Only our own profile is ever adopted (adoptEncryptedProfile decrypts self-ciphertext), so bounding
 * to our own last profile never excludes a strictly-newer one.
 */
export function selfProfileSince(
  store: EventStore,
  me: string,
  overlapSeconds: number,
): number | undefined {
  let latest: number | undefined;
  for (const ev of store.query({kinds: [Kind.AppData]})) {
    if (ev.pubkey !== me) continue;
    if (!ev.tags.some(t => t[0] === 'd' && t[1] === D_IDENTITY_PROFILE)) continue;
    if (latest === undefined || ev.created_at > latest) latest = ev.created_at;
  }
  return latest === undefined ? undefined : Math.max(0, latest - overlapSeconds);
}

/**
 * Distinct feed-author pubkeys (excluding the user) usable as DM cover-traffic decoys. These
 * are members the relay already knows posted, so querying their inbox is indistinguishable
 * from a real query.
 */
export function decoyPool(store: EventStore, exclude: string | undefined): string[] {
  const seen = new Set<string>();
  for (const post of store.query({kinds: [Kind.Post]})) {
    if (post.pubkey !== exclude) {
      seen.add(post.pubkey);
    }
  }
  return [...seen];
}

/**
 * The historical/incremental feed filter: ask only for events `since` the cache high-water mark,
 * or a bounded `limit` on a cold cache. This is NOT used for the standing live feed REQ (see
 * {@link buildLiveFeedFilter} for why) — it now serves only ONE-SHOT historical queries: the
 * NIP-77 reconciliation window/fallback filter (RelayClient) and getItems' recent-delta window
 * (App.tsx), where a `since` bound is safe because the query terminates rather than staying open
 * for future broadcasts.
 */
export function buildFeedFilter(
  store: EventStore,
  overlapSeconds = DEFAULT_OVERLAP_SECONDS,
  feedLimit = DEFAULT_FEED_LIMIT,
  snapshotHighWater?: Record<number, number>,
): ReqFilter {
  const filter: ReqFilter = {kinds: FIREHOSE_FEED_KINDS};
  const since = highWaterSince(store, FIREHOSE_FEED_KINDS, overlapSeconds, snapshotHighWater);
  if (since !== undefined) {
    filter.since = since;
  } else {
    filter.limit = feedLimit;
  }
  return filter;
}

/**
 * Rolling floor for a routine (watermarked) reconcile: never reconcile further back than this many
 * seconds ago, even if the persisted watermark is older. Bounds the fingerprint universe a warm
 * refresh touches so routine syncs stay a small recent window rather than the full cold horizon. A
 * one-week floor absorbs a device that's been offline for days without re-reconciling the whole
 * history. (T10 — negentropy Tor-RTT tuning; gated behind SYNC_TOR_TUNING at the App.tsx call site.)
 */
export const SYNC_ROUTINE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * The routine reconcile-window filter (NIP-77 gap-repair) — like {@link buildFeedFilter} it is a
 * ONE-SHOT historical query (never the standing live REQ), but it bounds routine refreshes to a
 * recent window instead of the full cold horizon so a warm sync costs fewer Tor round-trips.
 *
 * Logic:
 *   - Base filter is `{kinds: FEED_KINDS}`.
 *   - `hw` is the cache high-water `since` (undefined on a cold cache).
 *   - When a `watermarkSince` is supplied (the persisted per-community reconcile watermark): use
 *     `max(watermarkSince - overlap, hw ?? 0)` and clamp it UP to the rolling-window floor
 *     (`now - windowSeconds`) so the window is at most `windowSeconds` wide; assign `filter.since`.
 *   - No watermark but a warm store (`hw` defined): `filter.since = hw` — identical to buildFeedFilter.
 *   - No watermark AND cold store: `filter.limit = feedLimit` — identical to buildFeedFilter cold,
 *     preserving today's cold-cache behavior.
 * NEVER sets both `since` and `limit`.
 *
 * The optional `kinds` override (default FEED_KINDS) drives BOTH the wire filter's `kinds` AND the
 * high-water computation, so the low-bandwidth path can pass {@link TEXT_ONLY_FEED_KINDS} and keep the
 * two sides reconciling the identical universe (the getItems snapshot at the App.tsx call site MUST be
 * given the SAME kind set — a bound mismatch would corrupt the round).
 *
 * NEW and currently UNUSED (App.tsx wiring is a later subtask): buildFeedFilter stays the negFallback
 * regression firewall, so introducing this changes no runtime behavior until it is wired behind the
 * SYNC_TOR_TUNING flag.
 */
export function buildReconcileFilter(
  store: EventStore,
  opts: {
    overlapSeconds?: number;
    feedLimit?: number;
    watermarkSince?: number;
    windowSeconds?: number;
    kinds?: number[];
    /** T16-S3 durable snapshot floor — never let the reconcile `since` regress below a compaction-
     *  blanked kind's last-known high-water (see {@link highWaterSince}). Inert when omitted. */
    snapshotHighWater?: Record<number, number>;
  },
): ReqFilter {
  const overlap = opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  const feedLimit = opts.feedLimit ?? DEFAULT_FEED_LIMIT;
  const windowSeconds = opts.windowSeconds ?? SYNC_ROUTINE_WINDOW_SECONDS;
  const kinds = opts.kinds ?? FIREHOSE_FEED_KINDS;

  const filter: ReqFilter = {kinds};
  const hw = highWaterSince(store, kinds, overlap, opts.snapshotHighWater);

  if (opts.watermarkSince !== undefined) {
    let since = Math.max(opts.watermarkSince - overlap, hw ?? 0);
    // Clamp UP to the rolling-window floor: a watermark older than the window still only reconciles
    // the last `windowSeconds`, never the whole backlog.
    const windowFloor = Math.floor(Date.now() / 1000) - windowSeconds;
    since = Math.max(since, windowFloor);
    filter.since = since;
  } else if (hw !== undefined) {
    // Warm store, no watermark yet: same incremental `since` as buildFeedFilter.
    filter.since = hw;
  } else {
    // True cold cache (no watermark AND no stored high-water): bounded page, exactly like
    // buildFeedFilter cold. Never both since + limit.
    filter.limit = feedLimit;
  }
  return filter;
}

/**
 * The standing LIVE feed REQ filter — deliberately LIMIT-ONLY, never `since`-bounded.
 *
 * WHY: khatru (the relay this client targets) applies the REQ filter's `since` to every
 * live-broadcast event, not only the initial backlog page it replays on subscribe (listener.go
 * runs the same go-nostr filter.go matching for both) — so a `since` on this subscription would
 * silently DROP any newly-published event whose `created_at` falls below the connect-time
 * `since`. That happens more than in theory:
 *   - blind posts intentionally back-date `created_at` by up to BLIND_TS_BUCKET_SECONDS
 *     (see blindPost.ts) as a timing-correlation defense;
 *   - a post can be resent/delayed (queued while offline, retried after a failed publish);
 *   - ordinary clock skew between the poster's device and the relay.
 * Any of these can land a live, brand-new event at a `created_at` under `since`, and khatru would
 * never forward it to this connection — a silent drop, not a delay, since the REQ stays open and
 * won't re-offer it later.
 *
 * Time-windowing (incremental `since` / bounded scroll-back `until`) still exists — it belongs
 * ONLY to the NIP-77 gap-repair pass and `requestOlder` history paging (both one-shot historical
 * queries, not a subscription kept open for future events). See {@link buildFeedFilter} for that.
 */
export function buildLiveFeedFilter(feedLimit = DEFAULT_FEED_LIMIT): ReqFilter {
  return {kinds: FIREHOSE_FEED_KINDS, limit: feedLimit};
}

/**
 * The standing MEMBERSHIP-SCOPED channel-chat REQ filter (SCOPED_CHANNEL_SYNC) — `cover` is the
 * `#a` cover set of channel coordinates, or null below the decoy floor.
 *
 * LIMIT-ONLY, never `since`-bounded, for exactly the reason {@link buildLiveFeedFilter} spells out:
 * this is a STANDING sub that khatru keeps open and streams live matches on, and khatru applies a
 * REQ's `since` to every live-broadcast event rather than only the backlog page. A `since` here
 * would silently drop a channel message posted by a member whose clock runs behind ours. Channel
 * messages are signed with the member's bound npub rather than blind-posted (blind/protocol.ts), so
 * they are not deliberately back-dated the way blind feed posts are — but resends and ordinary clock
 * skew are more than enough, and today these events ride the limit-only `feed` REQ and are never
 * dropped. Scoping WHO we ask about must not quietly change WHETHER we get told.
 *
 * (The per-channel `channel:<coord>` sub opened on channel-open is a different animal and does carry
 * an incremental `since` — see AppRuntime.openChannel — exactly as `subscribeGroup` does for a
 * group's chat. That one exists to page in an opened channel's history; this one is the live tail.)
 */
export function buildChannelChatFilter(
  cover: readonly string[] | null,
  feedLimit = DEFAULT_FEED_LIMIT,
): ReqFilter {
  const filter: ReqFilter = {kinds: CHANNEL_CHAT_KINDS, limit: feedLimit};
  if (cover) filter['#a'] = [...cover];
  return filter;
}

/**
 * Deterministic 32-bit FNV-1a of a string. NOT a security hash — used only to RANK decoy
 * candidates by a key that depends on the member's own pubkey, so the ranking is stable across
 * reconnects yet not reproducible by a relay that does not know `me`.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build the SHARED per-identity cover set `[me, ...decoys]` for the npub-scoped subscriptions
 * (audit #1/#19/#25).
 *
 * The decoys are a STABLE subset of `pool` selected by ranking each candidate on fnv1a(me|candidate)
 * and taking the lowest `count`. Because the selection depends only on `me` and the pool — never on
 * Math.random or a per-connection draw — the same cover set accompanies `me` on every reconnect, so a
 * relay intersecting the #p/authors arrays across reconnects recovers the whole set, not just `me`
 * (audit #19), and there is no reconstructible PRNG state to replay (audit #25). The final order is
 * likewise keyed so `me` is not pinned to index 0. The same set is reused for the DM, self-lists and
 * space-key subs on one connection, so intersecting those subs against each other also yields the
 * whole set, never just `me`.
 *
 * The caller MUST pass a `pool` that is itself stable across reconnects: ranking over a live, growing
 * feed-author set would let a newly-arrived author out-rank (and displace) a currently-selected decoy,
 * drifting the emitted set while `me` stays invariant. createFeedAndDmPlan therefore freezes the
 * candidate pool per identity before calling here (S6).
 *
 * `sample`, when supplied (tests), overrides both the decoy selection and the ordering.
 */
export function buildCoverSet(
  me: string,
  pool: readonly string[],
  count: number,
  sample?: <T>(arr: readonly T[], n: number) => T[],
): string[] {
  return buildCoverSetFor(me, [me], pool, count, sample);
}

/**
 * The GENERAL form of {@link buildCoverSet}: hide `mine` — one OR MORE real values — inside `mine`
 * plus `count` decoys drawn from `pool`, ranked and ordered by a key derived from `key`.
 *
 * {@link buildCoverSet} is the `mine = [me]` case and delegates straight here, so there is exactly
 * ONE decoy mechanism in this file (one fnv1a ranking, one ordering rule, one frozen-pool concept)
 * rather than a second one grown alongside it — this repo has a recorded history of the same element
 * being re-implemented divergently, and a cover set that drifts from its sibling is a privacy bug,
 * not a style problem.
 *
 * The generalization exists for the membership-scoped `channels` sub, whose secret is not a single
 * npub but a SET of channel coordinates: `mine` = the coordinates the member is actually in, `pool`
 * = the other channels the community is known to have, and `key` stays the member's own pubkey so
 * the decoy choice is per-identity, stable across reconnects, and not reproducible by a relay that
 * does not know `me`. The relay sees `|mine| + count` coordinates and cannot tell which are real.
 *
 * `key` and `mine` are separate parameters ON PURPOSE: for the DM/self-list/space-key subs they
 * coincide (`key === me === mine[0]`), but the channel sub's secret has no single canonical element
 * to rank by, and ranking by (say) mine[0] would make the emitted set depend on which channel the
 * member happened to join first.
 */
export function buildCoverSetFor(
  key: string,
  mine: readonly string[],
  pool: readonly string[],
  count: number,
  sample?: <T>(arr: readonly T[], n: number) => T[],
): string[] {
  const k = Math.max(1, count);
  // A value in `mine` must never also be offered as a decoy — it would waste a cover slot and, worse,
  // a duplicate entry in the emitted array marks that value as real to anyone reading the REQ.
  const real = new Set(mine);
  const candidates = pool.filter(p => !real.has(p));
  if (sample) {
    const decoys = sample(candidates, k);
    return sample([...mine, ...decoys], decoys.length + mine.length);
  }
  const byKey = (sep: string) => (a: string, b: string) =>
    fnv1a(key + sep + a) - fnv1a(key + sep + b) || (a < b ? -1 : a > b ? 1 : 0);
  const decoys = [...candidates].sort(byKey(':')).slice(0, Math.min(k, candidates.length));
  return [...mine, ...decoys].sort(byKey('|'));
}

/**
 * Build a plan with a single limit-only standing feed subscription (see {@link buildLiveFeedFilter}
 * for why it carries no `since`) plus, when enrolled, a DM subscription that is either
 * scoped+decoyed (warm, enough members known) or an unscoped firehose (cold, can't camouflage
 * yet). The feed sub is ALWAYS present — it is both the initial sync and the live delivery tail
 * (see the module doc); a caller wanting incremental time-windowed gap-repair layers that on
 * separately via RelayClient's `negentropy` option (its own subId, never this one).
 */
export function createFeedAndDmPlan(opts: FeedAndDmPlanOptions): SubscriptionPlan {
  const overlap = opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  const feedLimit = opts.feedLimit ?? DEFAULT_FEED_LIMIT;
  const selfProfileLimit = Math.max(1, Math.trunc(opts.selfProfileLimit ?? DEFAULT_SELF_PROFILE_LIMIT));
  const selfProfilePageDelayMs = Math.max(
    0,
    Math.trunc(opts.selfProfilePageDelayMs ?? DEFAULT_SELF_PROFILE_PAGE_DELAY_MS),
  );
  const decoyCount = opts.decoyCount ?? DEFAULT_DECOY_COUNT;
  const dmPageSize = Math.max(1, Math.trunc(opts.dmPageSize ?? DEFAULT_DM_PAGE_SIZE));
  const dmPageDelayMs = Math.max(0, Math.trunc(opts.dmPageDelayMs ?? DEFAULT_DM_PAGE_DELAY_MS));

  // Memoize the DISTINCT-author decoy pool across reconnects, keyed on the kind-1 bucket version
  // (O(1)). The pool only changes when a new post arrives; the plan runs on every socket open, and
  // decoyPool iterates the whole (uncapped) kind-1 bucket each call — only the scan is skipped, so
  // the deterministic per-identity cover set (buildCoverSet) stays stable across reconnects. When the
  // store predates the version API (no kindVersion), fall back to recomputing every call.
  const versionedStore = opts.store as {kindVersion?: (kind: number) => number};
  let cachedPool: string[] | undefined;
  let cachedPoolVersion: number | undefined;
  let cachedPoolMe: string | undefined;
  const cachedDecoyPool = (me: string): string[] => {
    const v = versionedStore.kindVersion?.(Kind.Post);
    if (v === undefined) return decoyPool(opts.store, me); // no version counter — can't memoize
    if (cachedPool === undefined || v !== cachedPoolVersion || me !== cachedPoolMe) {
      cachedPool = decoyPool(opts.store, me); // excludes `me`, so re-derive if `me` changed too
      cachedPoolVersion = v;
      cachedPoolMe = me;
    }
    return cachedPool;
  };

  // Freeze the decoy CANDIDATE pool per identity (S6). The emitted decoys are ranked over this frozen
  // snapshot — never the live, growing feed-author set — so cover-set membership is identical across
  // reconnects AND as new authors arrive. Without it, a newly-arrived author with a smaller keyed hash
  // displaces a currently-selected decoy, drifting the #p/authors arrays while the real `me` stays
  // invariant, and a relay intersecting across pool growth could subtract the drift and re-isolate
  // `me`. Backed by module scope by default (survives the fresh plan closure App.tsx builds per
  // reconnect) or by `frozenDecoyStore` (survives app restarts). Only called once already eligible
  // (>= MIN_DECOY_POOL live authors), so the snapshot always holds enough candidates — `me` is never
  // frozen alone — and the existing cold-start fallbacks (firehose / omit) are untouched.
  const loadFrozenDecoys = opts.frozenDecoyStore?.load ?? ((me: string) => frozenDecoyPools.get(me));
  const saveFrozenDecoys =
    opts.frozenDecoyStore?.save ??
    ((me: string, decoys: readonly string[]) => {
      frozenDecoyPools.set(me, decoys);
    });
  // `key` is the NAMESPACED frozen-pool key, not always the bare pubkey: `me` for the npub universe,
  // channelPoolKey(me) for the channel-coordinate universe (see frozenDecoyPools).
  const frozenCandidatePool = (key: string, live: readonly string[]): readonly string[] => {
    const existing = loadFrozenDecoys(key);
    if (existing && existing.length > 0) return existing;
    // First eligibility: snapshot the first N distinct live candidates once and freeze them.
    const snapshot = live.slice(0, FROZEN_DECOY_POOL_MAX);
    saveFrozenDecoys(key, snapshot);
    return snapshot;
  };

  // Allowed-kinds lockstep (C6): warn once per drifted kind for the life of this plan (App rebuilds
  // the plan per reconnect, so the set resets then). Compares the canonical firehose kind set — NOT
  // the self-scoped list kinds (10000/10003/10009), which the relay's content allow-list needn't carry.
  const warnedPlanKinds = new Set<number>();

  return () => {
    const subs: Subscription[] = [];

    // 0. Warn (never reject) when the relay's advertised allow-list omits a kind we subscribe to.
    if (opts.getAllowedKinds) {
      warnKindDrift(SUBSCRIBED_KINDS, opts.getAllowedKinds(), 'feed-plan', warnedPlanKinds);
    }

    // 1. Feed: the standing live REQ — LIMIT-ONLY (newest-first), deliberately NEVER `since`-bounded.
    //    khatru applies the REQ filter's `since` to every live-broadcast event, not just the
    //    initial page, so a `since` here would silently drop newly-published events whose
    //    created_at falls below it (back-dated blind posts, delayed/resent posts, clock skew —
    //    see buildLiveFeedFilter's doc comment). ALWAYS present: this is the ONLY delivery
    //    mechanism for posts/comments/channel messages/reactions reaching other members (the REQ
    //    stays open and streams new matches after its initial page). Time-windowing (incremental
    //    `since`) is NOT applied here — it lives only in the NIP-77 gap-repair pass
    //    (buildFeedFilter, its own subId, see RelayClient) and in requestOlder scroll-back, both
    //    one-shot historical queries rather than a subscription kept open for future events.
    subs.push({subId: 'feed', filter: buildLiveFeedFilter(feedLimit)});

    // 2/3/3b. Identity-scoped subs (DM inbox, self-lists, space-key deliveries) — only when we know
    //   who we are. Each would otherwise reveal the member's real npub to the relay on the SAME
    //   connection blind posts are published on, linking real identity to throwaway-key posts (audit
    //   #1). They share ONE deterministic, per-identity DECOY cover set (audit #1/#19/#25): mixing
    //   `me` with `me`-keyed decoys drawn from feed authors, stable across reconnects. When too few
    //   members are known to camouflage, each degrades to a form that still never pins `me`.
    const me = opts.getMyPubkey();
    if (me) {
      // Eligibility gates on the LIVE pool (cold-start safety: never emit cover, hence never pin
      // `me`, until >= MIN_DECOY_POOL members are known). The decoys themselves are ranked over the
      // FROZEN candidate snapshot (S6) so membership can't drift as the live pool grows.
      const live = cachedDecoyPool(me);
      const cover =
        live.length >= MIN_DECOY_POOL && decoyCount > 0
          ? buildCoverSet(me, frozenCandidatePool(me, live), decoyCount, opts.sample)
          : null;

      // 2. DMs: gift wraps (kind 1059) tagged `#p == recipient`. Cover-mixed when warm; unscoped
      //    firehose when cold (leaks nothing about the recipient). RelayClient keeps the bounded
      //    root sub live for new wraps and backfills older history with short-lived pages.
      const dmFilter: Subscription['filter'] = {kinds: [Kind.GiftWrap], limit: dmPageSize};
      const dmSince = highWaterSince(
        opts.store,
        [Kind.GiftWrap],
        overlap + DM_TIMESTAMP_FUZZ_SECONDS,
        opts.snapshotHighWater,
      );
      if (dmSince !== undefined) dmFilter.since = dmSince;
      if (cover) dmFilter['#p'] = cover;
      subs.push({
        subId: 'dm',
        filter: dmFilter,
        pagination: {pageSize: dmPageSize, delayMs: dmPageDelayMs},
      });

      // 3. Self lists (NIP-51 bookmarks/subscriptions/mutes). `authors == me` leaks the npub, so mix
      //    in the SAME decoy authors when warm. A decoy's own list events are inert to us — every
      //    consumer reads them filtered by `authors:[me]` or by the moderator set — and are
      //    replaceable (per-pubkey), so they never overwrite ours; the limit scales with the author
      //    count so the user's own lists aren't crowded out. When cover isn't available we OMIT this
      //    sub rather than leak `me`: a brand-new member has no lists yet, and a cache-cleared member
      //    re-syncs on the next warm reconnect.
      if (cover) {
        subs.push({
          subId: 'self-lists',
          filter: {
            kinds: [Kind.ChannelSubscriptions, Kind.Bookmarks, Kind.MuteList],
            authors: cover,
            limit: Math.max(10, cover.length * 5),
          },
        });
      }

      // 3b. Private-space E2E key deliveries (kind 30079) addressed to me, `#p == me`. Mix in the
      //     SAME decoy set when warm — deliveries addressed to decoys are NIP-44-encrypted to THEIR
      //     keys and simply fail to unwrap here, exactly like DM decoys. When cover isn't available,
      //     fall back to an unscoped (since-bounded) firehose so a rotated key is never missed and
      //     `me` is never revealed. since-bounded so a reconnect doesn't re-stream every delivery.
      const keyFilter: Subscription['filter'] = {kinds: [Kind.SpaceKeyDelivery]};
      const keySince = highWaterSince(
        opts.store,
        [Kind.SpaceKeyDelivery],
        overlap,
        opts.snapshotHighWater,
      );
      if (keySince !== undefined) {
        keyFilter.since = keySince;
      } else if (!cover) {
        // heaviness-audit #4/#6: a TRUE cold cache (no prior delivery cached, so no `since`) with no
        // decoy cover yet (so no `#p` scope either) left this filter as bare `{kinds:[30079]}` — the
        // one genuinely unbounded cold REQ in the whole plan. Give it the same cold-fallback `limit`
        // its sibling cold REQs already carry (feed/self-profile), so a fresh device's key-delivery
        // sub can never become a fully unscoped, unbounded firehose. Warm paths are untouched: a
        // `since` above, or a `#p` cover set below, already bounds the request without needing this.
        keyFilter.limit = feedLimit;
      }
      if (cover) keyFilter['#p'] = cover;
      subs.push({subId: 'space-keys', filter: keyFilter});

      // 3b2. Draft access deliveries (kind 30500, feed/draftAccess.ts — Phase 5§D) addressed to me,
      //      `#p == me`. Shaped IDENTICALLY to the space-keys sub just above, for the same reason: a
      //      bare `#p:[me]` REQ on this same connection would reveal the real npub behind it, exactly
      //      like an unmixed space-key or DM sub would. Mixed with the SAME decoy cover set when warm
      //      (a delivery addressed to a decoy is NIP-44-sealed to THEIR pubkey and simply fails to
      //      decrypt here); an unscoped, since-bounded firehose fallback when cold, so a fresh device
      //      never misses an approval and `me` is never revealed either way. Per
      //      [[stiq-8point-round2-2026-07-19]]: this — like every scoped sub — must only (re)open from
      //      here, on every plan send (i.e. from RelayClient's onSubscribed), never pre-opened once and
      //      left stale across a reconnect.
      const draftDeliveryFilter: Subscription['filter'] = {kinds: [Kind.DraftDelivery]};
      const draftDeliverySince = highWaterSince(
        opts.store,
        [Kind.DraftDelivery],
        overlap,
        opts.snapshotHighWater,
      );
      if (draftDeliverySince !== undefined) {
        draftDeliveryFilter.since = draftDeliverySince;
      } else if (!cover) {
        // Same cold-start bound as the space-keys sub above (heaviness-audit #4/#6): no prior delivery
        // cached (no `since`) and no decoy cover yet (no `#p`) would otherwise leave this as the one
        // genuinely unbounded cold REQ of the pair.
        draftDeliveryFilter.limit = feedLimit;
      }
      if (cover) draftDeliveryFilter['#p'] = cover;
      subs.push({subId: 'draft-deliveries', filter: draftDeliveryFilter});

      // 3c. Self identity-enc profile (kind-30078, `d="identity-enc"`) — multi-device convergence.
      //     Our OWN NIP-44 self-encrypted profile, published by another device of the SAME identity,
      //     is adopted here (adoptEncryptedProfile decrypts + converges local name/gradient). Nothing
      //     else delivers this carrier: the feed sub omits 30078 and the org-config sub is scoped to
      //     the organizer, so without this sub a second device never RECEIVES the profile. `#d` bounds
      //     the pull to identity-enc only (30078 also carries beacons / space-settings / org-config).
      //
      //     `authors:[me]` ALONE would reveal our real npub to the relay on the SAME connection blind
      //     posts ride, linking real identity to throwaway-key posts (audit #1). So, exactly like the
      //     DM / self-lists / space-key subs:
      //       • WARM (cover available): `authors: cover` — the SAME shared per-identity decoy set, so
      //         `me` is one of k+1 and intersecting subs (or reconnects) never isolates it. A decoy's
      //         identity-enc is encrypted to THEIR key and fails to decrypt here (adopt no-ops), just
      //         like DM/space-key decoys. since-bounded off our own last profile so a reconnect doesn't
      //         re-stream — the live sub still delivers anything published after connect.
      //       • COLD (no cover — the KEY fresh-device case: same identity, empty cache, can't yet
      //         camouflage): unscoped-by-author firehose bounded by `limit`, leaking NOTHING about `me`
      //         (exactly like the DM cold firehose). It pulls every member's identity-enc; we adopt only
      //         ours (the one that decrypts). NEVER `authors:[me]` alone in either path.
      //
      //     PAGED exactly like the `dm` sub above (heaviness-audit #4): this was the single largest
      //     event burst in the whole cold plan (an unscoped, uncapped-in-spirit firehose). Wrapping it
      //     in the SAME `pagination` treatment pages the history backward in `selfProfileLimit`-sized
      //     chunks instead of one synchronous burst — the root sub stays live for future events, and
      //     older pages are fetched with a cooperative pause between them. This is strictly MORE
      //     reliable for discovery than a bare `limit` alone (a hard cap can never reach further back
      //     than its first page; pagination keeps paging until the relay returns a short page), while
      //     capping the cost any single tick pays. On the warm path this is a no-op in practice (the
      //     cover set is a handful of authors with at most one addressable doc each, so the first page
      //     always satisfies it) — it only does real work on the cold, unscoped, first-join path.
      const profileFilter: Subscription['filter'] = {
        kinds: [Kind.AppData],
        '#d': [D_IDENTITY_PROFILE],
      };
      if (cover) {
        profileFilter.authors = cover;
        const profileSince = selfProfileSince(opts.store, me, overlap);
        if (profileSince !== undefined) profileFilter.since = profileSince;
      } else {
        profileFilter.limit = selfProfileLimit;
      }
      subs.push({
        subId: 'self-profile',
        filter: profileFilter,
        pagination: {pageSize: selfProfileLimit, delayMs: selfProfilePageDelayMs},
      });

      // 3c-bis. Identity BEACONS (kind-30078, `d="identity"`) — every member's PUBLIC relay-blind
      //     identity carrier (SOH-header content; profile/identityDoc). announceIdentity has
      //     published one on every name/gradient edit since the carriers shipped, and ingest has
      //     always known how to learn from them (handleIncomingEvent → learnNameFromContent) — but
      //     NO sub ever requested the d-tag, so a peer only learned an updated identity when its
      //     author next authored a post (the SOH header riding it). That was the "I changed my
      //     gradient and nobody ever sees it" field bug. Addressable → one doc per author (latest
      //     replaces), so the full pull is bounded by community size, each doc ~a hundred bytes.
      //     Deliberately NO `since` and NO `authors`:
      //       • no since: a `since` derived from the newest cached beacon is the same
      //         since-poisoning trap buildOpenChatFilters heals for chat — a member whose beacon
      //         predates our newest sighting would stay unreachable forever (30078 is outside the
      //         NIP-77 reconcile). Re-pulling the tiny addressable set per plan rebuild is
      //         bandwidth-only: dedupe-pre-verify drops the re-streams.
      //       • no authors: we WANT every member's beacon, and an author-unscoped REQ leaks
      //         nothing about `me` (same property as the cold identity-enc firehose above).
      //     PAGED like self-profile so a large community's cold pull never lands as one burst.
      subs.push({
        subId: 'identity-beacons',
        filter: {kinds: [Kind.AppData], '#d': [D_IDENTITY_BEACON], limit: selfProfileLimit},
        pagination: {pageSize: selfProfileLimit, delayMs: selfProfilePageDelayMs},
      });

      // 3d. Channel chat (kind 1311), MEMBERSHIP-SCOPED — the standing live tail for the channels
      //     this member is actually in (bug 8; SCOPED_CHANNEL_SYNC). Until now 1311 sat in
      //     FEED_KINDS, so the single unscoped `feed` REQ pulled EVERY channel's messages from every
      //     channel in the community, joined or not, over Tor. That is the weight the user hit.
      //
      //     Shaped exactly like the DM sub above, for the same reason and with the same machinery:
      //       • WARM (>= MIN_DECOY_POOL other channels known): `#a` carries the member's real
      //         coordinates mixed with `me`-keyed decoys drawn from a FROZEN candidate snapshot, so
      //         the emitted array is identical on every reconnect (no intersection attack, S6/#19)
      //         and uses no Math.random (nothing to reconstruct and replay, #25). The relay sees
      //         |joined| + decoyCount coordinates and cannot tell a real one from a decoy.
      //       • BELOW THE FLOOR (a community with almost no channels — nowhere to hide): degrade to
      //         the UNSCOPED `{kinds:[1311], limit}` firehose, which is what ships today and leaks
      //         nothing about this member. NEVER a bare `#a: [<my channels>]`, which would hand the
      //         relay exact membership — the same rule that keeps the DM sub off a bare `#p: [me]`.
      //
      //     Kind 30311 (channel DEFINITIONS) stays on the firehose in both branches: it is what the
      //     directory / profile / notification-toggle surfaces read for channels the member has NOT
      //     joined, so scoping it would break discovery (see contracts' CHANNEL_CHAT_KINDS).
      //
      //     Omitted entirely when the member is in NO channels: there is nothing to fetch, and the
      //     `#a` array's LENGTH would reveal "in zero channels" regardless. Also omitted when the
      //     host wires no channel getters (background/syncTask.ts) — see getJoinedChannelIds.
      const joinedChannels = SCOPED_CHANNEL_SYNC ? opts.getJoinedChannelIds?.() ?? [] : [];
      if (joinedChannels.length > 0) {
        // Decoy candidates are the channels we know exist but are NOT in. buildCoverSetFor also
        // filters `mine` out of the pool, but doing it here keeps the FROZEN snapshot itself free of
        // our own coordinates — otherwise joining a channel later would silently shrink the frozen
        // pool's usable size.
        const joinedSet = new Set(joinedChannels);
        const liveChannelPool = (opts.getKnownChannelIds?.() ?? []).filter(id => !joinedSet.has(id));
        const channelCover =
          liveChannelPool.length >= MIN_DECOY_POOL && decoyCount > 0
            ? buildCoverSetFor(
                me,
                joinedChannels,
                frozenCandidatePool(channelPoolKey(me), liveChannelPool),
                decoyCount,
                opts.sample,
              )
            : null;
        subs.push({subId: 'channels', filter: buildChannelChatFilter(channelCover, feedLimit)});
      }
    }

    // 4. Organizer config: fetch the organizer's kind-30078 events for live updates. The
    //    organizer publishes several addressable docs under this kind, one per `d` tag —
    //    stiq:moderators, stiq:limits, stiq:tag-policy, stiq:labels, stiq:post-rules,
    //    stiq:reasons, … A bare limit:1 would only return whichever was published most recently,
    //    so the others (notably the moderator roster) would never reach members — moderation
    //    wouldn't propagate. Fetch enough to cover all current addressable docs (the relay keeps
    //    the latest per d), with headroom for new config types.
    const organizerPubkey = opts.getOrganizerPubkey?.();
    if (organizerPubkey) {
      subs.push({
        subId: 'org-config',
        filter: {kinds: [KIND_TAG_POLICY], authors: [organizerPubkey], limit: 30},
      });
    }

    return subs;
  };
}
