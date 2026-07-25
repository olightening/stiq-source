/**
 * Contract registry — the client half of the shared `/contracts` source of truth.
 *
 * One TS module so client constants can never drift from the relay/organizer. Everything the
 * client and relay must AGREE on — Nostr kind numbers, the `stiq_*` tag vocabulary, and the
 * protocol scalars (token width, mailbox TTL, epoch length) — is declared HERE exactly once.
 * Modules that used to declare these inline now import them from this file; a few keep a
 * back-compat re-export so their existing importers don't break (see events.ts, protocol.ts,
 * blindTokenSource.ts, enrollment.ts, exchange.ts, drawExchange.ts, readUnlock.ts).
 *
 * This module is a LEAF: it imports only a type from nostr-tools, never from the app, so any
 * module can depend on it without a cycle.
 */
import type {Event} from 'nostr-tools/pure';

export type {Event};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Kind registry — every Nostr kind the client uses, mapped to the standards in proto/README.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const Kind = {
  /** Profile metadata (NIP-01 kind 0). */
  Metadata: 0,
  /** Post — single-community feed item (NIP-01), carries `t` tags (NIP-12). */
  Post: 1,
  /** Long-form article (NIP-23). A titled post; addressable via naddr. */
  Article: 30023,
  /** Channel create (NIP-28). Owned by the creator npub (§3.7). */
  ChannelCreate: 40,
  /** Channel metadata update (NIP-28). */
  ChannelMeta: 41,
  /** Channel message — owner broadcast (NIP-28). */
  ChannelMessage: 42,
  /** Reaction — up/down vote (NIP-25). */
  Reaction: 7,
  /** Deletion request (NIP-09) — `a`/`e` tags name the events to retract. */
  Delete: 5,
  /** Comment — threaded reply (NIP-22). */
  Comment: 1111,
  /** Report — moderation "remove" (NIP-56). */
  Report: 1984,
  /** Gift wrap — sealed DM envelope (NIP-17). */
  GiftWrap: 1059,
  /** Poll (NIP-88). Content is the question; `option` tags carry the choices. */
  Poll: 1068,
  /** Poll response/vote (NIP-88). `e` tags the poll, `response` tags the chosen option id(s). */
  PollResponse: 1018,
  /** Channel subscriptions — NIP-51 replaceable list (kind 10009), `a` tags = subscribed channels. */
  ChannelSubscriptions: 10009,
  /** NIP-53 live activity — addressable channel definition (kind 30311). Replaces NIP-28 kind 40. */
  LiveActivity: 30311,
  /** NIP-53 live chat message (kind 1311) — `a`-tags its channel. Replaces NIP-28 kind 42. */
  LiveChat: 1311,
  /** NIP-51 mute list (kind 10000) — used here as a content owner's commenter block list. */
  MuteList: 10000,
  /** NIP-51 bookmark list (kind 10003) — `e` tags = saved post ids. */
  Bookmarks: 10003,
  /**
   * NIP-78 application-specific data (kind 30078), addressable/replaceable by `d` tag. The
   * organizer publishes the moderation root of trust here, signed by the organizer key:
   *   d="stiq:moderators" → current moderator roster (`p` tags)
   *   d="stiq:limits"     → rate-limit policy (JSON content)
   * See moderation/organizerConfig.ts.
   */
  AppData: 30078,
  /** Set per-post interaction preferences (kind 9009). */
  SetInteractions: 9009,
  /**
   * Private-space E2E key delivery (#8). An addressable kind-30079 event the organizer publishes
   * ONE PER REMAINING MEMBER on rotation (and on out-of-band delivery). Addressed with `['p', member]`,
   * scoped with `['h', spaceId]` + `['ke', epoch]`, `d`-tagged `<spaceId>:<epoch>:<member>` so a
   * re-send replaces rather than duplicates. Content = the space key NIP-44-wrapped to that member
   * (getConversationKey(orgSK, memberPK)). The relay only ever sees ciphertext.
   */
  SpaceKeyDelivery: 30079,
  /**
   * Draft access request — a request to view a shared `stiq:draft:` embed (feed/draftAccess.ts).
   * Mirrors the shape of `GroupKind.JoinRequest` (9021) but is deliberately NOT that number or in
   * its 9000–9022 NIP-29 range, since a draft is not a NIP-29 group and must never be routed through
   * the relay's group state machine. Tags `[['d', draftId], ['p', ownerPubkey]]`; content is
   * NIP-44-sealed to the owner (same `sealForPeer`/`openFromPeer` primitive the join-request flow
   * uses), plaintext payload `{v:1, n?: requesterDisplayName}`. Regular kind — the relay treats it
   * as an ordinary opaque event (no group-state enforcement applies); ships client-enforced only,
   * same posture as kind-1111 comments.
   */
  DraftAccessRequest: 1987,
  /**
   * Draft access delivery — the owner's response to an approved {@link DraftAccessRequest}: the full
   * frozen draft snapshot at approval time, NIP-44-sealed directly to the requester's pubkey (no
   * symmetric-key indirection — a draft is a static snapshot, not an ongoing encrypted channel, so
   * there's no key to re-wrap on rotation the way `SpaceKeyDelivery` needs). Parameterized-
   * replaceable (30000-range), `d = "draft-delivery:<draftId>:<requesterPubkey>"`, tags
   * `[['d', ...], ['p', requesterPubkey]]`. A later revoke does not retract an already-delivered
   * event — see `feed/draftAccess.ts`'s revoke doc for the forward-secrecy-not-retroactive posture.
   */
  DraftDelivery: 30500,
} as const;

export type KindValue = (typeof Kind)[keyof typeof Kind];

/** Relay-emitted per-post interaction state (kind 39005). Not in the Kind enum as it is relay-generated and addressable. */
export const PostState = 39005;

/**
 * NIP-A0 inline voice kinds. A standalone voice note (1222) and a voice reply (1244). They ride the
 * feed firehose like posts/comments. Named here so the feed/subscription/ingest lists stop carrying
 * them as bare literals (the drift risk this registry exists to remove).
 */
export const KIND_VOICE_MESSAGE = 1222;
export const KIND_VOICE_COMMENT = 1244;

/**
 * EVENTS (NIP-52 numbers). KIND_EVENT (31923) is the ADDRESSABLE event doc, signed by the
 * host's real npub (attribution is the point), `d` = event id. Content = JSON of the PUBLIC
 * StiqEvent fields ONLY — never the exact address / entry notes / stream link / roster; those
 * ride the encrypted DM rail post-approval. Host-authoritative aggregate tags (`going`,
 * `waitlist`, `cancelled`) update by addressable republish; clients fold latest-per-(pubkey,d).
 * KIND_EVENT_RSVP (31925) is the viewer's "interested" RSVP — blind-path like reactions when
 * blind_required, deduped latest-per-real-author; the count is a client-side tally. Both are
 * 30000-range → cache-exempt, and ride the feed firehose like Article/LiveActivity.
 */
export const KIND_EVENT = 31923;
export const KIND_EVENT_RSVP = 31925;

/**
 * MEDIA BLOB (kind 30351) — the standalone carrier for ONE lazily-fetched inline-media payload.
 *
 * A body no longer has to carry its media inline: a `[[pic:…]]` / `[[voice:…]]` token may instead
 * end in a blob REFERENCE tail (`STIQBLOB<64-hex event id>`; see feed/mediaBlob.ts), and the bytes
 * live in a kind-30351 event fetched BY ID only when the viewer actually taps the chip. Everything
 * needed to draw the idle chip (res/colours/label; mime/duration/waveform) stays in the token, so a
 * feed render still costs nothing.
 *
 * ONE GENERIC KIND, NOT ONE PER MODALITY — deliberate, on two grounds:
 *   • Engineering: pictures and voice differ ONLY in how their payload is interpreted, which is the
 *     token's job, not the carrier's. A per-modality kind would fork the transport and invite the
 *     divergent re-implementation this repo has repeatedly suffered.
 *   • Relay-blindness: the relay already learns that a post carries *some* media (it can see the
 *     reference); a shared kind means it cannot also learn WHICH modality. A `KIND_PICTURE` /
 *     `KIND_VOICE` split would hand it that distinction for free, permanently.
 * A blob therefore carries NO modality tag and NO reference back to its post — the post points at
 * the blob, never the reverse, so the relay cannot join them from the blob side alone.
 *
 * NOTE (30351 repurposed): this number was reserved as a Stiq-Pictures-specific "pixel-art kind"
 * that nothing ever published. It is now the generic blob carrier. A deprecated `KIND_PICTURE`
 * alias briefly survived here for subscriptionPlan's sake; that importer has since moved to this
 * name and the alias is GONE, so 30351 has exactly one name again.
 *
 * NEVER add this to FEED_KINDS / SUBSCRIBED_KINDS — see {@link FETCH_ONLY_KINDS}. Putting a blob
 * kind on the firehose would stream every picture and voice clip in the community to every phone
 * whether or not anyone taps: precisely the bug the blob split exists to fix.
 */
export const KIND_MEDIA_BLOB = 30351;

/** Double-spend witness (kind 1986): a self-verifying conflict proof naming two DISTINCT events
 *  that each validly spend the SAME holder-bound token (P4). Advisory + VERIFY-NEVER-TRUST — a
 *  consumer re-derives the conflict from the referenced events before hiding a loser, so a false
 *  witness hides nothing. Signed by a bound member; the relay admits it like a report (it is in
 *  DefaultAllowedKinds). Regular/stored kind (NIP-16 1000-9999), not replaceable. Rides the feed
 *  firehose so mirrors/clients share the signal. See blind/spendWitness.ts. */
export const KIND_SPEND_WITNESS = 1986;

/**
 * NIP-29 group kinds (mirrors relay/internal/groups and channels/groups.ts `GroupKind`). Chat
 * (9/11/12) + member actions (9000–9022) + relay-emitted state (39000–39004). Canonical here so the
 * ingest allow-list and group code share one definition.
 * TODO(contract): channels/groups.ts `GroupKind` should import from here.
 */
export const GroupKind = {
  Chat: 9,
  Thread: 11,
  Reply: 12,
  AddUser: 9000,
  RemoveUser: 9001,
  EditMetadata: 9002,
  Create: 9007,
  Delete: 9008,
  JoinRequest: 9021,
  LeaveRequest: 9022,
  Metadata: 39000,
  Admins: 39001,
  Members: 39002,
  Roles: 39003,
  Pending: 39004,
} as const;

// ── Credential / mailbox kinds (NIP-44 organizer mailbox round-trips) ──
/** One-time membership binding published on first connect (enrollment.ts). */
export const KIND_MEMBERSHIP_BINDING = 9011;
/** Automated credential exchange over the mailbox (onboarding/exchange.ts). */
export const KIND_ENROLL_REQUEST = 9020;
export const KIND_ENROLL_RESPONSE = 9023;
/** Epoch posting/read-token draw (blind/drawExchange.ts). */
export const KIND_DRAW_REQUEST = 9024;
export const KIND_DRAW_RESPONSE = 9025;
/** Read-token unlock / content-epoch-key delivery (blind/readUnlock.ts). */
export const KIND_UNLOCK_REQUEST = 9026;
export const KIND_UNLOCK_RESPONSE = 9027;

/**
 * Kind of the internal author "attestation" that lives ENCRYPTED inside a `stiq_attr` tag. It is
 * a normal Nostr event signed by the author's real key, but it is NEVER published to a relay on
 * its own — it only ever travels as ciphertext, so its kind is arbitrary and outside every
 * subscribed range. It binds the real npub to a blind post's throwaway key (see blind/attribution).
 */
export const KIND_ATTESTATION = 27_555;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Kind lists — feed content, firehose ingest gate, and group ingest allow-list.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Feed content kinds — pulled incrementally on the main feed subscription. Mostly visible community
 * content a member publishes, plus the advisory anti-abuse signals that ride the SAME firehose but
 * are never rendered as posts: moderation reports (1984) and the P4 double-spend witness (1986).
 * This is the ONE canonical feed-content list: subscriptionPlan imports it as FEED_KINDS. Voice kinds
 * now come from the named constants above (no bare literals).
 *
 * NOTE — three lists, three jobs (do not collapse into one):
 *   • FEED_KINDS       — what the feed REQ asks for (this list).
 *   • SUBSCRIBED_KINDS — the INGEST gate for the main connection = FEED_KINDS + the kinds other
 *                        plan subs request on that same connection (DMs, organizer config,
 *                        space-key deliveries).
 *   • AppRuntime.FEED_KINDS — the STORE-READ set buildFeed scans; it additionally reads MuteList and
 *                        omits LiveChat/LiveActivity/voice-reply and the double-spend witness (1986).
 *                        It is a superset in one dimension and subset in another, so it can't be the
 *                        same array without changing behavior.
 *
 * This array is the UNSCOPED baseline and never varies at runtime — nothing here reads a config
 * flag, so this module stays the dependency-free LEAF its header promises. The membership-scoped
 * channel path (config's SCOPED_CHANNEL_SYNC) does not mutate it; it selects
 * {@link FEED_KINDS_SCOPED_CHANNELS} instead, and that choice is made one layer up in
 * nostr/subscriptionPlan.ts, which already depends on config.
 */
export const FEED_KINDS: number[] = [
  Kind.Post, //           1     — notes + stiq-comment hybrid
  Kind.Reaction, //       7     — up/down votes + reactions
  Kind.Comment, //        1111  — NIP-22 comments
  Kind.Report, //         1984  — moderation reports / hides
  KIND_SPEND_WITNESS, //  1986  — P4 double-spend witness (advisory; verify-never-trust, not rendered)
  // Draft access requests (Phase 5§D, feed/draftAccess.ts): sealed to the owner, so — exactly like
  // KIND_SPEND_WITNESS above and kind-1111 comments — it rides the open firehose and is never
  // rendered as a feed item; only the intended owner's client can decrypt the content. No dedicated
  // scoped subscription is needed for it (contrast DraftDelivery below, which IS `#p`-scoped).
  Kind.DraftAccessRequest, // 1987 — request to view a shared draft (see FEED_STORE_READ_KINDS omit)
  Kind.Article, //        30023 — titled long-form posts
  Kind.Poll, //           1068  — NIP-88 polls
  Kind.PollResponse, //   1018  — NIP-88 poll votes
  KIND_VOICE_MESSAGE, //  1222  — NIP-A0 voice note
  KIND_VOICE_COMMENT, //  1244  — NIP-A0 voice reply
  Kind.LiveChat, //       1311  — NIP-53 channel messages (see FEED_KINDS_SCOPED_CHANNELS)
  Kind.LiveActivity, //   30311 — NIP-53 channel definitions (open/visible by design)
  // Events surface. Both ride the firehose exactly like the channel-definition kind above: an
  // event doc must arrive for members who merely SEE its embed in a post/DM (the card upgrades
  // live), and RSVPs must arrive for the interested tally. NEITHER joins FEED_STORE_READ_KINDS —
  // an event is an EMBED inside a post, never a feed item of its own (README fact #1), so
  // buildFeed must not scan these kinds; events/eventsStore.ts reads them from the store itself.
  KIND_EVENT, //          31923 — NIP-52 event doc (addressable, host-signed)
  KIND_EVENT_RSVP, //     31925 — event "interested" RSVP (blind-path, tallied client-side)
];

/**
 * The NIP-53 channel-MESSAGE kinds — the ones that carry a channel's actual traffic, as opposed to
 * its definition. Named as a list (not a bare `Kind.LiveChat`) so the scoped-channel path has one
 * home to grow if NIP-53 ever adds a second message kind, exactly like {@link GROUP_KINDS} covers
 * a group's 9/11/12.
 *
 * The 1311 / 30311 asymmetry is the whole point of the scoped-channel design, so it is worth
 * stating once, here:
 *   • 30311 (LiveActivity) is a channel's DEFINITION — one small addressable event per channel, of
 *     which the relay returns only the latest per coordinate. Every discovery surface reads it from
 *     the cache (the directory, a member's owned channels on their profile, the per-channel
 *     notification toggles), so it must arrive for channels the member has NOT joined. It stays on
 *     the firehose, always. Scoping it would break discovery to save almost nothing.
 *   • 1311 (LiveChat) is a channel's MESSAGES — unbounded, and today every member downloads every
 *     channel's messages over Tor whether or not they are in that channel. That is the weight.
 */
export const CHANNEL_CHAT_KINDS: number[] = [
  Kind.LiveChat, //       1311  — NIP-53 channel messages
];

/**
 * FEED_KINDS with the channel-message kinds removed — the firehose set when config's
 * SCOPED_CHANNEL_SYNC is ON. A DERIVED subset (never a hand-maintained second literal), so a kind
 * added to FEED_KINDS can never silently miss this list.
 *
 * 1311 is NOT dropped from {@link SUBSCRIBED_KINDS}, and that is deliberate rather than an
 * oversight. SUBSCRIBED_KINDS is the INGEST gate for the whole connection, not the feed REQ's kind
 * list — RelayClient checks every arriving event against it regardless of which subId delivered it.
 * Under scoped sync 1311 still arrives on that connection, just on the plan's `channels` sub (and on
 * the per-channel `channel:<coord>` subs) instead of the `feed` sub — precisely the relationship
 * GiftWrap/AppData/SpaceKeyDelivery already have with their own plan subs. So it belongs in the
 * ingest gate either way, and needs no GROUP_KINDS-style side list. Dropping it from
 * SUBSCRIBED_KINDS would instead make RelayClient REJECT every channel message the new scoped subs
 * fetch — silently, since a rejected event merely never reaches the store.
 */
export const FEED_KINDS_SCOPED_CHANNELS: number[] = FEED_KINDS.filter(
  k => !CHANNEL_CHAT_KINDS.includes(k),
);

/**
 * Store-READ kind set that AppRuntime.buildFeed (+ buildModeratedFeed) scans from the local cache.
 * This is NOT a subscription/REQ list — it is the third of the "three lists, three jobs" above and
 * differs from FEED_KINDS on purpose:
 *   • ADDS MuteList (10000) — buildFeed reads content owners' commenter block lists from the store.
 *   • OMITS LiveChat (1311), LiveActivity (30311), voice-reply (1244), and the double-spend witness
 *     (1986) — the feed builder does not render those from the store scan. The witness is a
 *     verify-never-trust anti-abuse signal (blind/spendWitness.ts), never a renderable feed item.
 * Its membership MUST stay byte-identical to AppRuntime's historical private FEED_KINDS literal (it is
 * imported there verbatim). C9 WARNING: this must NEVER be fed into the feed REQ — pulling MuteList
 * over the firehose would stream every member's mute list to every client. Kept here (not inlined in
 * AppRuntime) only so the store-read set has ONE declared home alongside the other kind lists.
 */
export const FEED_STORE_READ_KINDS: number[] = [
  Kind.Post, //           1     — posts + stiq-comment hybrid
  Kind.Article, //        30023 — titled long-form posts
  Kind.Poll, //           1068  — NIP-88 polls
  KIND_VOICE_MESSAGE, //  1222  — NIP-A0 voice note
  Kind.Reaction, //       7     — up/down votes + reactions
  Kind.Comment, //        1111  — NIP-22 comments
  Kind.PollResponse, //   1018  — NIP-88 poll votes
  Kind.Report, //         1984  — moderation reports / hides
  Kind.MuteList, //       10000 — content owners' commenter block lists (store-read only)
];

/**
 * Kinds the client accepts on the MAIN CONNECTION — the ingest gate. This is FEED_KINDS plus the
 * kinds that ALSO arrive on that connection but are not feed content:
 *   • GiftWrap (1059)         — DM inbox (Step 16/17) over the same connection.
 *   • AppData (30078)         — organizer moderation config (roster + limits).
 *   • SpaceKeyDelivery (30079)— private-space E2E key delivery, addressed by `#p == me`.
 *
 * "Main connection", NOT "the firehose REQ": RelayClient checks every arriving event against this
 * set whatever subId delivered it, and several of these kinds have always come from their own
 * scoped plan subs (`dm`, `org-config`, `space-keys`) rather than the broad `feed` sub. Under
 * config's SCOPED_CHANNEL_SYNC, LiveChat (1311) joins them — requested by the plan's `channels` sub
 * instead of `feed` — which is why it stays in this list even though it leaves
 * {@link FEED_KINDS_SCOPED_CHANNELS}.
 *
 * Channels (NIP-28 kinds 40/41/42) and profiles (kind 0) are deliberately EXCLUDED: the relay's
 * RequireScopedDiscovery (§3.8) rejects any subscription touching those kinds unless scoped by
 * author/id/#e, to prevent enumeration; they are fetched via separate scoped subscriptions.
 *
 * Membership is a SET (used via `.includes()` and as an unordered REQ `kinds` filter), so deriving
 * it by concatenation — order-independent — matches the previous hand-written list exactly.
 */
export const SUBSCRIBED_KINDS: number[] = [
  ...FEED_KINDS,
  Kind.GiftWrap, //       1059  — DMs (inbox rides the firehose connection)
  Kind.AppData, //        30078 — organizer moderation config
  Kind.SpaceKeyDelivery, //30079 — private-space E2E key delivery, `#p == me`
  Kind.DraftDelivery, //  30500 — draft access delivery, `#p == me` (see subscriptionPlan.ts)
];

export function isSubscribedKind(kind: number): boolean {
  return SUBSCRIBED_KINDS.includes(kind);
}

/**
 * Kinds accepted on INGEST but never requested by the firehose — fetched only by explicit id, on
 * demand. The same shape as {@link GROUP_KINDS} (an ingest allow-list that is never a REQ target),
 * for the opposite reason: a group kind is off-firehose because the relay demands a scoped query; a
 * media blob is off-firehose because pulling it eagerly is the entire bug (a 48KB picture / 200KB
 * voice clip arriving over Tor for every post in the feed, tapped or not).
 *
 * The ONLY path that may bring one of these in is RelayClient.fetchById — a short, id-scoped REQ
 * issued when a viewer taps a media chip (media/mediaBlobService.ts). It is deliberately absent from
 * FEED_KINDS, FEED_STORE_READ_KINDS and SUBSCRIBED_KINDS; `contracts.firehose.test.ts` pins that.
 */
export const FETCH_ONLY_KINDS: number[] = [
  KIND_MEDIA_BLOB, // 30351 — lazily-fetched picture/voice payload (feed/mediaBlob.ts)
];

/**
 * NIP-29 group kinds (chat + relay-generated state). These are NEVER on the feed firehose — the
 * relay requires a group-scoped query — but the client must still accept them when they arrive on an
 * explicitly-opened, group-scoped subscription, so they are an ingest allow-list separate from
 * SUBSCRIBED_KINDS.
 */
export const GROUP_KINDS: number[] = [
  GroupKind.Chat,
  GroupKind.Thread,
  GroupKind.Reply,
  GroupKind.Metadata,
  GroupKind.Admins,
  GroupKind.Members,
  GroupKind.Roles,
  GroupKind.Pending,
  // Raw join requests (9021): the relay's 39004 carries pending PUBKEYS only — the sealed intro
  // note + request timestamp live on the stored 9021 itself, which admins pull back on the same
  // group-scoped sub (`#h`). Without this entry ingestEvent drops them at the door.
  GroupKind.JoinRequest,
  Kind.Reaction,
  Kind.SetInteractions,
  PostState,
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tag vocabulary — the `stiq_*` protocol tags and their sub-tags (see blind/protocol.ts docs).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Tag carrying the base64 anti-spam token (shared with the legacy kind-9011 binding). */
export const TAG_TOKEN = 'stiq_token';
/** Tag carrying the base64 issuer blind signature over the token. */
export const TAG_SIG = 'stiq_sig';
/**
 * Tag carrying one token's base64 BIP-340 holder-proof signature (P3 holder-bound tokens; see
 * blind/holderProof). Positional: for a spent token at index i>=1, exactly one `stiq_spend` tag
 * proves that token's secret `q_i` signed {@link SPEND_DOMAIN}-bound digest over the event's own
 * pubkey. Token 0 needs no proof — it IS the event's throwaway signer (event.pubkey == Q0), so its
 * holder proof is the event's own BIP-340 signature. Excluded from chargeable weight on both sides
 * (relay weight.go, client blind/tokenCost.ts) so proofs never self-price.
 */
export const TAG_SPEND = 'stiq_spend';
/** Tag carrying the base64 NIP-44 ciphertext of the author attestation (see blind/attribution). */
export const TAG_ATTR = 'stiq_attr';
/**
 * Media-domain claim on a blind media-blob post (kind 30351): its value (`picture` / `audio`) tells
 * the content-blind relay which per-media WRITE-issuer key set to verify the attached tokens against
 * (asks #3/#4, media token domain separation). Absent ⇒ the general posting keys, so a blob paying
 * from the post wallet verifies exactly as before. MUST match the relay's `tagDomain` (membership.go).
 */
export const TAG_DOM = 'stiq_dom';

/**
 * Content-encryption markers on a blind post whose BODY is sealed under a content epoch key (see
 * blind/contentKey). `['encrypted','nip44']` marks the content as NIP-44 ciphertext and `['ke', E]`
 * names the epoch key needed to decrypt it — matching the private-space convention so the relay
 * cannot tell a members-only post apart from any other encrypted event. Absent on a plaintext post.
 */
export const TAG_ENC = 'encrypted';
export const ENC_NIP44 = 'nip44';
export const TAG_KE = 'ke';

/** Attestation sub-tag committing to the post's throwaway pubkey (prevents replay). */
export const ATTR_BIND = 'bind';
/** Attestation sub-tag carrying the author's chosen display name. */
export const ATTR_NAME = 'nm';
/** Attestation sub-tag carrying the author's gradient-identity wire form. */
export const ATTR_GRAD = 'g';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Token wire contract (T4.1/F13) — purpose/domain vocabularies mirrored EXACTLY from the
// issuer/relay (TOKEN_FIXING_PLAN.md Appendix A). THREE DISTINCT VOCABULARIES — do not conflate:
//   • Purpose        — the client draw / issuer signing-key-selection string (the wire `purpose` at
//                       blind/drawExchange.ts; organizer's `signKeyByPurpose` selects a key by it).
//   • FingerprintKey — the relay's NIP-11 `issuer_key_fingerprints` (and `issuer_keys`) object keys,
//                       snake_case. NOTE `Posting` (`'posting'`) ≠ purpose `Post` (`'post'`) — a
//                       genuinely different spelling, not a typo (Appendix A).
//   • StiqDom        — the `stiq_dom` tag VALUE on a media-blob post (the tag NAME itself is
//                       {@link TAG_DOM} above).
// Before this section each vocabulary was a bare literal re-typed at every call site — the one wire
// constant this registry didn't already own (F13). Declared once here; every other module imports.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The WIRE `purpose` string a token draw requests (blind/drawExchange.ts `DrawRequestPayload.purpose`)
 * and the key the organizer's `signKeyByPurpose` map selects a signing key by
 * (organizer-server.mjs:1572) — values MUST match the organizer verbatim. Eight domains
 * (TOKEN_PATHWAY_ANALYSIS.md Part 0): `Enroll` is the trust-root credential purpose (presented at
 * every draw, never itself drawn — not wallet-pooled); the other seven are spendable, one WRITE/READ
 * pair each for post/picture/audio plus `SpaceWrite` (tokens-everywhere: channel/group/DM content).
 */
export const Purpose = {
  Enroll: 'enroll',
  Post: 'post',
  Read: 'read',
  PictureWrite: 'picture-write',
  PictureRead: 'picture-read',
  AudioWrite: 'audio-write',
  AudioRead: 'audio-read',
  SpaceWrite: 'space-write',
} as const;
export type PurposeValue = (typeof Purpose)[keyof typeof Purpose];

/**
 * The relay's NIP-11 `issuer_key_fingerprints` / `issuer_keys` object keys (relay
 * capabilities.go:89-98,153-164) — snake_case, a DISTINCT vocabulary from {@link Purpose} above (see
 * the section note re: `Posting` vs `Post`). Read defensively off an untyped NIP-11 document
 * (nostr/capabilities.ts) — TS cannot check a JSON property name against a type, so these exist to
 * give that parsing ONE canonical string source rather than a hand-typed property access per field.
 */
export const FingerprintKey = {
  Enroll: 'enroll',
  Posting: 'posting',
  Binding: 'binding',
  SpaceWrite: 'space_write',
  Picture: 'picture',
  Audio: 'audio',
  Read: 'read',
} as const;

/**
 * `stiq_dom` media-routing values (relay membership.go:94-95) — the value carried by the
 * {@link TAG_DOM} tag on a blind media-blob post, naming which media WRITE-issuer key set the relay
 * verifies the attached tokens against. See blind/blindSigner.ts `MediaTokenRouter` /
 * AppRuntime.routeMediaToken (the assignment site) and nostr/capabilities.ts `mediaWriteDomains` /
 * `media_write_domains` (the relay-advertised counterpart these values are compared against).
 */
export const StiqDom = {
  Picture: 'picture',
  Audio: 'audio',
} as const;
export type StiqDomValue = (typeof StiqDom)[keyof typeof StiqDom];

/**
 * Machine-readable draw-failure codes. `StaleBlindKey` rides the organizer's 9025 error reply as an
 * additive `code` field next to the human `error` string (issuer/mailbox.mjs — see
 * CLIENT_C5_FINGERPRINT_CONTRACT.md "Draw error code contract"); it means the batch was blinded under
 * a key that is NOT the organizer's current signing key for the requested purpose (the RSASP1
 * "signature representative out of range" family — the 2026-07-21 wrong-key incident). The other two
 * are CLIENT-detected twins of the same condition: `UnblindFailed` when the organizer's signatures
 * don't verify under the key we blinded with (the organizer holds the right key, we don't), and
 * `MisProvisioned` when the C5 gate refuses to draw at all because the purpose key is absent. All
 * three share one remedy: re-fetch `stiq:token-keys`, rebuild the purpose keys, retry the draw once
 * (AppRuntime's healed-draw path).
 */
export const DrawErrorCode = {
  StaleBlindKey: 'stale-blind-key',
  UnblindFailed: 'unblind-failed',
  MisProvisioned: 'mis-provisioned',
} as const;
export type DrawErrorCodeValue = (typeof DrawErrorCode)[keyof typeof DrawErrorCode];

/**
 * Kind of the member-signed reader-auth (censorable reads, #4) that rides INSIDE the NIP-44 read-draw
 * payload — NEVER published to the relay as its own event. Must equal the organizer's
 * `KIND_READ_AUTH` verbatim (issuer/organizer-server.mjs:294) or the organizer can't recover the
 * signer's pubkey from it.
 */
export const KIND_READ_AUTH = 9028;

/**
 * The bound-npub SPACE content kinds that pay space-write tokens under enforcement (tokens-
 * everywhere) — channel messages (1311; legacy 42) and group chat/thread/reply (9/11/12). MUST match
 * the relay's spaceContentKinds (policy/membership.go:206) and the attributed-space set the ratelimit
 * exempts (`ratelimit.go:544-548`). Kind-7 (reaction) is deliberately NOT a member of this plain list
 * even though it's ALSO space content when h-tagged — see {@link isSpaceContentKind}, which folds in
 * that one extra condition; an untagged kind-7 is a blind feed vote and must stay off this list.
 */
export const SPACE_CONTENT_KINDS: number[] = [
  Kind.ChannelMessage, // 42    — legacy NIP-28 channel message
  Kind.LiveChat, //       1311  — NIP-53 channel message
  GroupKind.Chat, //      9     — NIP-29 group chat
  GroupKind.Thread, //    11    — NIP-29 group thread
  GroupKind.Reply, //     12    — NIP-29 group reply
];

/**
 * True for a bound-npub SPACE content event that pays space-write tokens under enforcement — the
 * client's mirror of the relay's spaceContentKinds + h-tagged-kind-7 rule ({@link SPACE_CONTENT_KINDS}
 * doc; `ratelimit.go`'s `isAttributedSpaceContent`). An h-tagged kind-7 is a channel/group reaction and
 * IS space content; an UNTAGGED kind-7 is a blind feed vote and stays false.
 */
export function isSpaceContentKind(unsigned: {kind: number; tags?: string[][]}): boolean {
  if (SPACE_CONTENT_KINDS.includes(unsigned.kind)) {
    return true;
  }
  if (unsigned.kind === Kind.Reaction) {
    return (unsigned.tags ?? []).some(t => t[0] === 'h');
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scalars — protocol constants the client and relay/organizer must agree on.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Random token width (bytes). Enrollment credentials and posting/read tokens share it so the
 *  relay verifier is unchanged across all token kinds. */
export const TOKEN_BYTES = 32;

/**
 * Domain-separation prefix for the P3 holder-proof digest (blind/holderProof `spendMessage`):
 * `digest = sha256(utf8(SPEND_DOMAIN) || event.pubkey_bytes)`, a 32-byte digest bound to the
 * event's own pubkey (never `event.id` — that would create a tag-in-preimage circularity). 13
 * ASCII bytes. Must stay byte-identical to the relay's `spendDomain` const (policy/membership.go)
 * or every holder proof fails to verify.
 */
export const SPEND_DOMAIN = 'stiq-spend-v1';

/** NIP-40 expiration window for mailbox events: the relay may drop the event after this, so a
 *  request/response mailbox self-purges. Shared by enrollment, draw, and read-unlock exchanges. */
export const MAILBOX_TTL_SECONDS = 48 * 3600;

/**
 * Epoch length for token issuance (seconds). Tokens are drawn per-epoch and the organizer caps how
 * many a member may draw each epoch; a day is a reasonable default (short enough to bound the
 * spent-set / hoarding, long enough that a phone tops up rarely).
 */
export const EPOCH_SECONDS = 86_400;

/** The current issuance epoch (a day index). */
export function currentEpoch(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / EPOCH_SECONDS);
}
