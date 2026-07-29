/**
 * Feed view-model (PLAN.md §2 / Step 12). Turns cached events into render-ready items,
 * applying the moderation filter (Step 9). The same source feeds the main list and the
 * Moderation Log.
 */
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import type {EventStore} from '../nostr/store';
import {buildModeratedFeed} from '../moderation/filter';
import type {AutoModConfig} from '../moderation/autoModeration';
import {postTags} from './tags';
import {scoreReactions, myVote as myVoteFor, reactionTarget, type VoteDirection} from './voting';
import {LABEL_NAMESPACE, isPostLabel, type PostLabel} from './labels';
import type {ModerationOverlay} from '../moderation/modActions';
import {postIdentifier} from './identifier';
import {Kind} from '../nostr/events';
import {imageMetaFromEvent, type ImageMeta} from '../nostr/imeta';
import {commentRootId} from './comments';
import {isPinnedComment} from './pinned';
import {decodeGradientHeader, decodeNameHeader, type DisplayNameStore} from '../profile/displayName';
import type {GradientStore} from '../profile/gradientIdentity';
import type {GradientSpec} from '../media/gradient';
import {parseVoiceMessage, type VoiceMessage} from './voice';
import {resolveAuthor, resolveAuthorPubkey, isUnverifiedBlindPost} from '../blind/identity';
import {resolveContent, isSealedContent, contentLockState, contentEpochOf} from '../blind/blindPost';
import {isEpochUnlockUnavailable} from '../blind/unlockState';

export interface FeedItem {
  id: string;
  authorPubkey: string;
  author: string; // npub
  /** Locally-resolved display name (relay-blind phonebook, longest-held-wins). Undefined when
   * unknown or when this author is not the rightful owner of the name they claim. */
  authorName?: string;
  /** The author's crafted gradient identity, if they've published one (relay-blind, latest-wins).
   * Undefined → the renderer derives a stable gradient from the author's pubkey. */
  authorGradient?: GradientSpec;
  /** Nostr event kind (1 = note, 30023 = NIP-23 article). */
  kind: number;
  /** Shareable NIP-19 identifier (nevent for notes, naddr for articles). */
  identifier: string;
  /** Article title (NIP-23 `title` tag). Undefined for plain kind-1 posts. */
  title?: string;
  /** Article summary (NIP-23 `summary` tag), if present. */
  summary?: string;
  /** Post type label (insight/question/discussion/personal/fun), from the NIP-32 `l` tag. */
  label?: PostLabel;
  content: string;
  tags: string[];
  createdAt: number;
  /**
   * LOCAL-ONLY sort key for the viewer's OWN posts (ms since epoch, captured at publish). The wire
   * `created_at` is bucket-fuzzed for timing-correlation resistance (blindPost.fuzzBlindCreatedAt,
   * audit #48), so two of your own posts made seconds apart can draw INVERTED created_at values and
   * sort out of order. `sortAt` records their true local publish order and is used ONLY by sortFeed.
   * It is never signed, sent, or persisted, and is `undefined` for every other author (→ sort falls
   * back to `createdAt`). See AppRuntime._ownPostOrder.
   */
  sortAt?: number;
  /** Aggregated vote score (Step 13). 0 when built without a store. */
  score: number;
  /** The viewer's current vote on this post, if any. Drives the highlighted arrow + retraction. */
  myVote?: VoteDirection | null;
  /** Number of threaded replies (kind 1111). Omitted when not computed. */
  commentCount?: number;
  /**
   * One Unix timestamp (seconds) per DISTINCT commenter — their latest comment — used for the
   * Rising sort's discussion velocity. Deliberately not a timestamp per comment: that would let a
   * single author's comment spree read as a crowd. See prepareFeedItems.
   */
  commentTimestamps?: number[];
  /** First embedded image URL extracted from content or `imeta` tags. */
  imageUrl?: string;
  /** Structured NIP-94 `imeta` images on the event (BlurHash + sha256 for secure preview/fetch). */
  images?: ImageMeta[];
  /** Unix timestamps (seconds) of each counted vote — used for velocity-based Rising sort. */
  voteTimestamps?: number[];
  /** NIP-36 content warning reason string, if the event has a `content-warning` tag. */
  contentWarning?: string;
  /** Present when the event is a NIP-A0 voice message (kind 1222). Drives the voice player. */
  voice?: VoiceMessage;
  /** True when this post's body is sealed under a content epoch key this device hasn't unlocked.
   * The body (and any media) is withheld and the UI offers to spend a read-token to unlock it. */
  locked?: boolean;
  /** The content epoch a locked post is sealed under (its `ke` tag) — the argument the unlock tap
   * passes to AppRuntime.unlockContentEpoch. Present only when `locked` and the epoch is well-formed;
   * a locked post with a stripped/malformed `ke` has no epoch to unlock, so no affordance is offered. */
  lockedEpoch?: number;
}

export interface ModeratedLogItem {
  item: FeedItem;
  moderatorNpub: string;
}

export interface Feed {
  items: FeedItem[];
  log: ModeratedLogItem[];
}

const IMAGE_URL_RE = /!\[.*?\]\((https?:\/\/\S+?)\)|(?<![(\[])https?:\/\/\S+?\.(?:jpg|jpeg|png|gif|webp)(?:[?#]\S*)?(?=\s|$)/i;

// ── Identity-stable caches ──────────────────────────────────────────────────────
// buildFeed runs on every snapshot. Without these, every post got a brand-new FeedItem object
// each rebuild, so React.memo on PostCard could never skip — the whole list re-rendered on every
// relay event. These caches return the SAME FeedItem reference when a post's rendered inputs are
// unchanged, so React skips untouched cards and only the post that actually changed re-renders.

// npub encoding is deterministic per pubkey and bech32 encoding is not cheap; cache it forever.
const _npubCache = new Map<string, string>();
function npubOf(hex: string): string {
  let v = _npubCache.get(hex);
  if (v === undefined) {
    v = nip19.npubEncode(hex);
    _npubCache.set(hex, v);
  }
  return v;
}

// Post events are immutable (id = hash of content), so only DERIVED values change: score,
// commentCount, myVote, resolved name/gradient, and poll tally. The cache key captures exactly
// those; on a hit we reuse the existing object (stable reference) instead of rebuilding.
const _itemCache = new Map<string, {key: string; item: FeedItem}>();

/**
 * Clear the module-level per-post FeedItem cache. Post ids are globally unique so entries can't
 * literally collide across communities, but on a community switch the whole feed is replaced and
 * the outgoing community's items are dead weight — dropping them keeps the map from carrying a
 * second community's worth of stale objects. Called by AppRuntime.activateWorkspace().
 */
export function clearItemCache(): void {
  _itemCache.clear();
}

function extractImageUrl(event: Event): string | undefined {
  // Prefer imeta tag (NIP-92)
  const imeta = event.tags.find(t => t[0] === 'imeta');
  if (imeta) {
    const urlPart = imeta.find(p => p.startsWith('url '));
    if (urlPart) return urlPart.slice(4);
  }
  const match = IMAGE_URL_RE.exec(event.content);
  return match ? (match[1] ?? match[0]) : undefined;
}

function extractTitle(event: Event): string | undefined {
  // NIP-14 `subject` (legacy kind-1 titled posts) or NIP-23 `title` (kind 30023 articles).
  const titleTag = event.tags.find(t => (t[0] === 'subject' || t[0] === 'title') && t[1]);
  return titleTag?.[1];
}

function extractSummary(event: Event): string | undefined {
  return event.tags.find(t => t[0] === 'summary' && t[1])?.[1];
}

function extractLabel(event: Event): PostLabel | undefined {
  const tag = event.tags.find(t => t[0] === 'l' && t[2] === LABEL_NAMESPACE && t[1]);
  const value = tag?.[1];
  return value && isPostLabel(value) ? value : undefined;
}

export function toFeedItem(
  event: Event,
  score = 0,
  commentCount?: number,
  myVote?: VoteDirection | null,
  voteTimestamps?: number[],
  authorName?: string,
  authorGradient?: GradientSpec,
  /** Local-only publish-order key for one of the viewer's own posts (see FeedItem.sortAt). */
  sortAt?: number,
  /** One timestamp per distinct commenter (see FeedItem.commentTimestamps). */
  commentTimestamps?: number[],
): FeedItem {
  // For a blind post the real author lives in the encrypted attribution, not event.pubkey (the
  // throwaway signer). resolveAuthorPubkey returns the real npub for a decrypted blind post and
  // event.pubkey for everything else, so non-blind posts are unaffected.
  const authorPubkey = resolveAuthorPubkey(event);
  // Members-only body: a sealed post's content lives as NIP-44 ciphertext until its epoch is
  // unlocked. Resolve it up front so every content-derived field (image, voice, name header) reads
  // PLAINTEXT — never ciphertext. When still locked, the body is withheld (empty) and media is
  // suppressed so nothing leaks; the `locked` flag drives the unlock affordance. Plaintext posts
  // (the dark-ship default) pass through with viewEvent === event.
  const sealed = isSealedContent(event);
  const resolved = resolveContent(event);
  const locked = sealed && resolved.locked;
  // The epoch a locked post is sealed under (null for a stripped/malformed `ke` → nothing to unlock).
  const lockedEpoch = locked ? contentEpochOf(event) : null;
  const viewEvent = sealed ? {...event, content: locked ? '' : resolved.text} : event;
  // `identifier` (a nip19 bech32 nevent encode) is read ONLY when the user taps share/copy-link
  // (PostCard/MainScreen handlers), never during list render — yet the cold-start buildFeed computed
  // it eagerly for EVERY visible post. Make it a memoized lazy getter so the first feed paint skips N
  // bech32 encodes; the whole FeedItem is cached in _itemCache and reused across snapshots, so the
  // memo persists (and each item's identifier is still computed at most once, on first actual use).
  let _identifier: string | undefined;
  return {
    id: event.id,
    authorPubkey,
    author: npubOf(authorPubkey),
    authorName,
    authorGradient,
    kind: event.kind,
    get identifier(): string {
      return (_identifier ??= postIdentifier(event));
    },
    title: extractTitle(event),
    summary: extractSummary(event),
    label: extractLabel(event),
    // Strip the relay-blind display-name header so it never leaks into body text / search.
    content: decodeNameHeader(viewEvent.content).text,
    tags: postTags(event),
    createdAt: event.created_at,
    ...(sortAt !== undefined ? {sortAt} : {}),
    score,
    commentCount,
    commentTimestamps,
    myVote,
    // Withhold media on a locked post — imeta/URLs would otherwise leak from the plaintext tags.
    imageUrl: locked ? undefined : extractImageUrl(viewEvent),
    images: locked ? undefined : imageMetaFromEvent(event),
    voteTimestamps,
    voice: locked ? undefined : parseVoiceMessage(viewEvent) ?? undefined,
    contentWarning: event.tags.find(t => t[0] === 'content-warning')?.[1],
    // Locked marker + the epoch to unlock. lockedEpoch is null for a stripped/malformed `ke`, in
    // which case there is nothing to unlock and it is left undefined (no affordance offered).
    ...(locked ? {locked: true, ...(lockedEpoch !== null ? {lockedEpoch} : {})} : {}),
  };
}

/**
 * Shared per-build setup: resolves the visible posts + moderation log, learns every author's
 * embedded name/gradient, buckets reactions by target post (skipped under `skipScores`,
 * POSTS-FIRST), and counts comments per root. Extracted so `buildFeed`'s own per-item loop and the
 * chunked scored-item pre-warm (`warmScoredItemsChunked`, B3 fix) run the EXACT same setup once —
 * a warmed `_itemCache` entry and a live rebuild's entry are then guaranteed byte-identical.
 */
function prepareFeedItems(
  store: EventStore,
  npubs: readonly string[] | undefined,
  viewerPubkey: string | undefined,
  names: DisplayNameStore | undefined,
  grads: GradientStore | undefined,
  autoCfg: AutoModConfig | undefined,
  skipScores: boolean,
) {
  const {visible, moderationLog, stiqComments} = buildModeratedFeed(store, npubs, autoCfg);

  // Pass 1: learn every author's embedded display name + gradient (claim time = event created_at)
  // BEFORE resolving any item, so longest-held-wins (names) and latest-wins (gradients — see
  // gradientIdentity.record(): a newer sighting from the same pubkey always replaces) ownership is
  // correct regardless of feed order.
  if (names || grads) {
    for (const post of visible) {
      // Blind posts carry name/gradient inside the encrypted attestation (keyed on the real
      // author); non-blind posts carry them in the plaintext SOH header (keyed on event.pubkey).
      const author = resolveAuthor(post);
      if (names) {
        const name = author.blind ? author.name : decodeNameHeader(post.content).name;
        if (name) void names.learn(author.pubkey, name, post.created_at);
      }
      if (grads) {
        const wire = author.blind ? author.gradient : decodeGradientHeader(post.content);
        if (wire) void grads.learn(author.pubkey, wire, post.created_at);
      }
    }
  }
  const resolveName = (pubkey: string): string | undefined => {
    if (!names) return undefined;
    return pubkey === viewerPubkey ? names.getMyName() || undefined : names.nameFor(pubkey);
  };
  const resolveGradient = (pubkey: string): GradientSpec | undefined => {
    if (!grads) return undefined;
    return pubkey === viewerPubkey ? grads.getMyGradient() ?? undefined : grads.gradientFor(pubkey);
  };

  // One pass over all reactions, bucketed by target post (not gated on viewerPubkey so vote
  // timestamps are available for velocity-based Rising sort). POSTS-FIRST: skipped entirely under
  // `skipScores` so the reaction bucket — the largest kind — is never warmed/parsed on the critical
  // path; a follow-up scored pass fills the scores in and re-emits.
  const reactionsByPost = new Map<string, Event[]>();
  if (!skipScores) {
    // unordered: bucketed by target below; scoreReactions/myVoteFor pick latest-per-voter by
    // created_at COMPARISON, not array position (P0-3/C1) — this is the largest bucket
    // (REACTION_RETENTION=8000), read on every un-skipped feed build.
    for (const r of store.query({kinds: [Kind.Reaction], unordered: true})) {
      const target = reactionTarget(r);
      if (!target) continue;
      const bucket = reactionsByPost.get(target);
      if (bucket) bucket.push(r);
      else reactionsByPost.set(target, [r]);
    }
  }

  // Build a post→commentCount map across BOTH comment forms: kind-1111 and hybrid
  // kind-1 'stiq-comment' notes (NIP-22 conflict resolution). The stiq-comments are already
  // split off by buildModeratedFeed's own combined Post/Article/Poll/Voice query above (C3 fix) —
  // reusing them here avoids a second full Post-kind query+sort of the same bucket.
  // Author's-note pins are not comments — keep them out of the "N ideas" count.
  // unordered: only feeds the commutative countMap++ / per-author max below (neither can be
  // affected by input order).
  const allComments = [
    ...store.query({kinds: [Kind.Comment], unordered: true}).filter(c => !isPinnedComment(c)),
    ...stiqComments,
  ];
  const countMap = new Map<string, number>();
  // Distinct COMMENTERS per post → each one's latest comment time, which is what the Rising sort
  // reads as discussion velocity. Mirrors scoreReactions' one-vote-per-real-voter dedup, including
  // `resolveAuthorPubkey` (it recovers a blind comment's real author from the encrypted
  // attribution, not the throwaway signer). Without this, one person's 50 comments read as 50×
  // the engagement of one person's 1 — a ranking lever anyone can pull on their own post.
  // `countMap` stays the RAW total: the card shows "N ideas", which counts comments, not people.
  const commenterLatest = new Map<string, Map<string, number>>();
  for (const c of allComments) {
    const root = commentRootId(c);
    if (!root) {
      continue;
    }
    // Unverified comments (attribution stripped OR resolving off the member roll) are hidden from
    // every thread (partitionThread) — so they must not inflate "N ideas" or the Rising discussion
    // velocity either; a counted-but-invisible comment reads as phantom engagement and is exactly
    // the sock-puppet lever the roll closes. Both predicates defer to false pre-roll/pre-key.
    if (isUnverifiedBlindPost(c)) {
      continue;
    }
    countMap.set(root, (countMap.get(root) ?? 0) + 1);
    let byAuthor = commenterLatest.get(root);
    if (!byAuthor) {
      byAuthor = new Map<string, number>();
      commenterLatest.set(root, byAuthor);
    }
    const author = resolveAuthorPubkey(c);
    const prev = byAuthor.get(author);
    if (prev === undefined || c.created_at > prev) {
      byAuthor.set(author, c.created_at);
    }
  }
  const commentTsMap = new Map<string, number[]>();
  for (const [root, byAuthor] of commenterLatest) {
    commentTsMap.set(root, [...byAuthor.values()]);
  }

  return {visible, moderationLog, reactionsByPost, countMap, commentTsMap, resolveName, resolveGradient};
}

type FeedBuildContext = ReturnType<typeof prepareFeedItems>;

/**
 * Score one post and return its (possibly cached) `FeedItem`, writing a fresh entry into
 * `_itemCache` on a miss — the exact per-item body `buildFeed`'s own loop ran inline before this
 * was extracted so `warmScoredItemsChunked` (B3 fix) could call it too. A cache hit/miss/write here
 * behaves identically regardless of caller.
 */
function scoreFeedItem(
  post: Event,
  ctx: FeedBuildContext,
  viewerPubkey: string | undefined,
  modOverlay: ModerationOverlay | undefined,
  skipScores: boolean,
  ownOrder: ReadonlyMap<string, number> | undefined,
): FeedItem {
  const reactions = ctx.reactionsByPost.get(post.id) ?? [];
  const scored = scoreReactions(reactions);
  const commentCount = ctx.countMap.get(post.id);
  const commentTimestamps = ctx.commentTsMap.get(post.id);
  const myVote = viewerPubkey ? myVoteFor(reactions, viewerPubkey) : undefined;
  const authorPk = resolveAuthorPubkey(post);
  const name = ctx.resolveName(authorPk);
  const gradient = ctx.resolveGradient(authorPk);

  // Identity key: everything that affects how this (immutable) post renders. On a match we
  // return the cached object so its reference is stable and React.memo skips the PostCard.
  // A moderator re-tag overrides the post's own type label. Part of the cache key so a
  // re-tag (or its reversal back to the author's label) re-renders this card.
  const modLabel = modOverlay?.modLabels.get(post.id);

  // Local-only publish-order key for the viewer's own posts (immutable per id). Undefined for
  // every other author → the item sorts by createdAt as before.
  const ownMs = ownOrder?.get(post.id);

  const gradKey = gradient ? `${gradient.type}${gradient.angle}${gradient.stops.join('')}` : '';
  // Distinct-commenter count + newest comment time. `commentCount` alone can't stand in for these:
  // one commenter replying twice leaves the count at 2 while the Rising velocity this drives moves,
  // and a delete+reply keeps the count identical while the timing shifts. Cheap (one pass over the
  // distinct commenters, not the comments) and only ever grows the key.
  const cTs = commentTimestamps;
  const commentKey = cTs ? `${cTs.length}:${cTs.reduce((m, t) => (t > m ? t : m), 0)}` : '';
  // Lock state is part of the key so unlocking a sealed post's epoch (L→u) rebuilds its card.
  // A still-locked epoch additionally keys on the auto-unlock REFUSAL bit ('L' vs 'Lx'): PostCard is
  // React.memo'd on the cached item's identity, so without a key change the pending→unavailable flip
  // (organizer refused the background unlock) would never repaint the card off the same item object.
  // The `skipScores` marker guarantees the scored follow-up pass rebuilds every item — even the
  // equal-up/down edge where `score` stays 0 but `voteTimestamps` must fill in for Rising sort.
  // `ownMs` is in the key so an own placeholder's key transfers cleanly onto the real event.
  const lockState = contentLockState(post);
  const lockEpoch = lockState === 'L' ? contentEpochOf(post) : null;
  const lockKey =
    lockState === 'L' && lockEpoch !== null && isEpochUnlockUnavailable(lockEpoch) ? 'Lx' : lockState;
  const key = `${scored.score}|${commentCount ?? ''}|${commentKey}|${myVote ?? ''}|${name ?? ''}|${gradKey}|${modLabel ?? ''}|${lockKey}${skipScores ? '|ns' : ''}|${ownMs ?? ''}`;
  const cached = _itemCache.get(post.id);
  if (cached && cached.key === key) {
    return cached.item;
  }

  const item = toFeedItem(post, scored.score, commentCount, myVote, scored.voteTimestamps, name, gradient, ownMs, commentTimestamps);
  if (modLabel) item.label = modLabel;
  _itemCache.set(post.id, {key, item});
  return item;
}

/**
 * Rows of the visible feed scored per macrotask by {@link warmScoredItemsChunked}: small enough
 * that one chunk's `toFeedItem()` work (regex content scan, name decode, image/voice meta, tag
 * scans) stays well under a frame budget, large enough that a large community's feed drains in a
 * handful of yields. `toFeedItem` is heavier per-row than sqliteStore's raw SELECT+JSON.parse warm
 * (WARM_CHUNK_ROWS, sqliteStore.ts, 500 rows), so this chunk is smaller.
 */
export const ITEM_WARM_CHUNK_ROWS = 60;

/**
 * Chunked, yielding pre-warm of the SCORED `_itemCache` entry for every currently visible post
 * (B3 fix — the scored follow-up pass used to rebuild every visible item in one synchronous shot).
 * `AppRuntime.scheduleScorePass()` calls this AFTER the reaction bucket itself is chunk-warmed and
 * BEFORE flipping `_feedScored`/emitting, so the eventual single scored `buildFeed()` finds every
 * item's cache entry already computed and just returns it — instead of running `toFeedItem()` for
 * the WHOLE feed in one uninterrupted block. Uses the exact same setup (`prepareFeedItems`) and
 * per-item scoring (`scoreFeedItem`) `buildFeed` itself uses, so a warmed entry and the live
 * rebuild's entry key identically: this only SPREADS the same work across more macrotasks, it never
 * changes it, and the final feed is byte-identical to an unchunked build.
 *
 * `shouldContinue` is checked before every chunk (and once up front) so a stale pass — superseded
 * by a community switch or teardown — stops before touching a workspace it no longer owns.
 */
export async function warmScoredItemsChunked(
  store: EventStore,
  npubs: readonly string[] | undefined,
  viewerPubkey: string | undefined,
  names: DisplayNameStore | undefined,
  grads: GradientStore | undefined,
  modOverlay: ModerationOverlay | undefined,
  autoCfg: AutoModConfig | undefined,
  ownOrder: ReadonlyMap<string, number> | undefined,
  shouldContinue: () => boolean,
  chunkRows = ITEM_WARM_CHUNK_ROWS,
): Promise<void> {
  if (!shouldContinue()) return;
  const ctx = prepareFeedItems(store, npubs, viewerPubkey, names, grads, autoCfg, /* skipScores */ false);
  const rows = Math.max(1, Math.trunc(chunkRows));
  for (let i = 0; i < ctx.visible.length; i += rows) {
    if (!shouldContinue()) return;
    const end = Math.min(i + rows, ctx.visible.length);
    for (const post of ctx.visible.slice(i, end)) {
      scoreFeedItem(post, ctx, viewerPubkey, modOverlay, /* skipScores */ false, ownOrder);
    }
    if (end < ctx.visible.length) {
      // Real macrotask yield — same idiom as SqliteEventStore.warmKindChunked — so queued touch
      // dispatch on the old-arch bridge gets to run before the next chunk.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
}

/** Build the renderable feed (main list + moderation log) from the cache, with vote scores. */
export function buildFeed(
  store: EventStore,
  npubs?: readonly string[],
  viewerPubkey?: string,
  names?: DisplayNameStore,
  grads?: GradientStore,
  /** Live moderator overlay: re-tag label overrides applied per item. (Pin-to-top ordering is
   *  applied at the display layer after the hot/new sort, not here.) */
  modOverlay?: ModerationOverlay,
  /** Organizer rule config; when present, posts the rules auto-hide are dropped from the feed. */
  autoCfg?: AutoModConfig,
  /**
   * POSTS-FIRST: when `skipScores` is set, the (largest) kind-7 reaction bucket is NOT queried at
   * all, so the structural feed (posts/comments/articles) builds without warming + parsing every
   * cached reaction. Every item's `score` defaults to 0, `myVote` to null, and `voteTimestamps` to
   * empty until a follow-up scored pass (skipScores off) recomputes and re-emits. The item shape is
   * identical either way; only the derived vote values differ.
   */
  opts?: {skipScores?: boolean},
  /**
   * LOCAL-ONLY map of the viewer's own post id → true local publish instant (ms). Populates each own
   * post's `FeedItem.sortAt` so the feed renders your own rapid posts in the order you actually made
   * them, despite the wire `created_at` being bucket-fuzzed (audit #48). Never touches the event; any
   * id absent from the map (every other author, and your own posts from a prior session) falls back
   * to `createdAt`. See AppRuntime._ownPostOrder.
   */
  ownOrder?: ReadonlyMap<string, number>,
): Feed {
  const skipScores = opts?.skipScores === true;
  const ctx = prepareFeedItems(store, npubs, viewerPubkey, names, grads, autoCfg, skipScores);

  const items = ctx.visible.map(post => scoreFeedItem(post, ctx, viewerPubkey, modOverlay, skipScores, ownOrder));

  // Prune cache entries for posts no longer visible so it can't grow without bound across a long
  // session (moderated/expired posts, etc.). Only when it has drifted well past the live set.
  if (_itemCache.size > ctx.visible.length * 2 + 64) {
    const live = new Set(ctx.visible.map(p => p.id));
    for (const id of _itemCache.keys()) {
      if (!live.has(id)) _itemCache.delete(id);
    }
  }

  return {
    items,
    log: ctx.moderationLog.map(entry => ({
      item: toFeedItem(
        entry.post,
        0,
        undefined,
        undefined,
        undefined,
        ctx.resolveName(resolveAuthorPubkey(entry.post)),
        ctx.resolveGradient(resolveAuthorPubkey(entry.post)),
      ),
      moderatorNpub: entry.moderatorNpub,
    })),
  };
}

/** Filter feed items to those carrying a given tag (Step 15 will build the tag bar on this). */
export function itemsWithTag(items: FeedItem[], tag: string): FeedItem[] {
  return items.filter(item => item.tags.includes(tag));
}
