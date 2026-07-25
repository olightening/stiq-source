/**
 * Feed sorting + tag filtering. All computed over the already-built (cached) feed items —
 * switching sort/tag reorders with no refetch.
 *
 *   Rising  = freshness + vote velocity + comments + score, scaled by post type and length.
 *   New     = newest first by creation time.
 *   Top     = highest net score (used in search).
 */
import type {FeedItem} from './feed';
import {Kind} from '../nostr/events';
import {bodyForMeasure} from './inlineMedia';
import {wordCount} from './postRules';

export type SortMode = 'hot' | 'new' | 'top';

export interface FeedView {
  /** Multi-select tag filter — an item must carry ALL of these (AND). */
  tags?: string[];
  sort: SortMode;
}

// ── Organizer-tunable Rising ranking (kind-30078, d=stiq:ranking) ───────────────
export const KIND_RANKING = 30078;
export const RANKING_D_TAG = 'stiq:ranking';

/**
 * The post types the organizer can promote independently. Deliberately the same 2-way split as
 * `postRules.PostKind` and auto-moderation (`ev.kind === Kind.Article ? 'article' : 'note'`) — the
 * community already reasons about posts as "note vs article" everywhere else, so Rising uses the
 * same vocabulary rather than inventing a third one. Inline pictures/voice ride INSIDE a note or an
 * article body (there is no picture kind), so they are covered by their carrier's weight.
 */
export type RankingPostKind = 'note' | 'article';

/** Per-type multiplier on a post's whole Rising score. 1 = neutral. */
export type TypeWeights = Record<RankingPostKind, number>;

/**
 * Four independent engagement signals — each with its own weight and, where it has a clock, its own
 * half-life. Every signal is measured on the SAME log scale, so the weights are directly
 * comparable: at equal weight, votes and comments contribute equally. See {@link risingScore}.
 */
export interface RankingConfig {
  /**
   * Weight of freshness — a post's own age, on its OWN clock, independent of any vote. 0 removes
   * it, restoring the historical shape where age only ever reached the score through the
   * timestamps of a post's votes (so a post with no votes had no recency at all).
   */
  timeWeight: number;
  /** Half-life (hours) of freshness. Independent of every other half-life. */
  timeHalfLifeHours: number;
  /** Weight of recent-vote velocity. 0 = votes do not affect Rising. */
  voteWeight: number;
  /** Half-life (hours) of a VOTE's weight. Lower = recent votes dominate. */
  halfLifeHours: number;
  /** Weight of recent-discussion velocity (distinct commenters). 0 = comments do not affect Rising. */
  commentWeight: number;
  /** Half-life (hours) of a COMMENT's weight. Independent of the vote half-life. */
  commentHalfLifeHours: number;
  /** Weight of the post's all-time score. 0 = pure velocity. */
  scoreWeight: number;
  /** Weight of the prose-length boost. 0 = length does not affect Rising. */
  lengthWeight: number;
  /** Per-type multipliers — e.g. `{note: 1, article: 1.5}` promotes articles over notes. */
  typeWeights: TypeWeights;
}

/**
 * `timeWeight` and `voteWeight` ship LIVE; comments, length and type ship as NO-OPS (0 / 0 / 1.0),
 * so a community that has not tuned them sees nothing from them, and a `stiq:ranking` doc published
 * before those fields existed keeps working untouched.
 *
 * The vote half-life and score weight keep their historical values (λ=0.00005 ≈ 3.85 h, and 0.1).
 * `timeWeight: 0` restores the pre-freshness shape.
 */
export const DEFAULT_RANKING: RankingConfig = {
  timeWeight: 1,
  timeHalfLifeHours: 6,
  voteWeight: 1,
  halfLifeHours: 3.85,
  commentWeight: 0,
  commentHalfLifeHours: 6,
  scoreWeight: 0.1,
  lengthWeight: 0,
  typeWeights: {note: 1, article: 1},
};

interface RankingWire {
  hl?: number;
  sw?: number;
  tw?: number;
  thl?: number;
  vw?: number;
  cw?: number;
  chl?: number;
  lw?: number;
  ty?: {n?: number; a?: number};
}

export function encodeRanking(r: RankingConfig): RankingWire {
  return {
    hl: r.halfLifeHours,
    sw: r.scoreWeight,
    tw: r.timeWeight,
    thl: r.timeHalfLifeHours,
    vw: r.voteWeight,
    cw: r.commentWeight,
    chl: r.commentHalfLifeHours,
    lw: r.lengthWeight,
    ty: {n: r.typeWeights.note, a: r.typeWeights.article},
  };
}

/**
 * Read one numeric field, falling back to THAT FIELD's own default when it is absent or malformed
 * (the `postRules.parseTypeRule` convention) — so a doc published before a field existed still gets
 * a sane value for it without dragging the other fields to a global default.
 */
function num(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}

export function parseRanking(raw: unknown): RankingConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as RankingWire;
  const ty = w.ty && typeof w.ty === 'object' ? w.ty : {};
  return {
    // Every half-life divides (λ = ln2/hl), so they must be strictly positive — a 0 would yield λ=∞.
    halfLifeHours: num(w.hl, DEFAULT_RANKING.halfLifeHours, Number.MIN_VALUE),
    scoreWeight: num(w.sw, DEFAULT_RANKING.scoreWeight, 0),
    timeWeight: num(w.tw, DEFAULT_RANKING.timeWeight, 0),
    timeHalfLifeHours: num(w.thl, DEFAULT_RANKING.timeHalfLifeHours, Number.MIN_VALUE),
    voteWeight: num(w.vw, DEFAULT_RANKING.voteWeight, 0),
    commentWeight: num(w.cw, DEFAULT_RANKING.commentWeight, 0),
    commentHalfLifeHours: num(w.chl, DEFAULT_RANKING.commentHalfLifeHours, Number.MIN_VALUE),
    lengthWeight: num(w.lw, DEFAULT_RANKING.lengthWeight, 0),
    typeWeights: {
      note: num(ty.n, DEFAULT_RANKING.typeWeights.note, 0),
      article: num(ty.a, DEFAULT_RANKING.typeWeights.article, 0),
    },
  };
}

/** Parse a kind-30078 event's content into a RankingConfig (null if malformed). */
export function parseRankingEvent(content: string): RankingConfig | null {
  try {
    return parseRanking(JSON.parse(content));
  } catch {
    return null;
  }
}

const LN2 = Math.log(2);

/**
 * Exponential decay to `1/2` every `halfLifeHours`, over a DISTANCE in time (seconds).
 *
 * Symmetric on purpose: a timestamp in the future decays exactly like one equally far in the past.
 * Nothing in this stack validates `created_at` — the relay registers no timestamp RejectEvent hook,
 * the client's verifier checks only id+signature, and `fuzzBlindCreatedAt` clamps solely against
 * its own caller-supplied input — so a patched client can date a post a year ahead. Under a
 * `Math.max(0, ·)` clamp that post would sit at freshness exactly 1.0 for a year, unbeatable.
 * Measuring distance instead makes future-dating strictly self-defeating, with no cross-layer
 * validation to negotiate.
 */
function decay(deltaSeconds: number, halfLifeHours: number): number {
  return Math.exp((-LN2 / (halfLifeHours * 3600)) * Math.abs(deltaSeconds));
}

/** Summed decayed weight of a set of event timestamps — the "velocity" of a signal. */
function velocity(timestamps: number[] | undefined, now: number, halfLifeHours: number): number {
  if (!timestamps || timestamps.length === 0) return 0;
  return timestamps.reduce((sum, ts) => sum + decay(now - ts, halfLifeHours), 0);
}

/**
 * Classify a post for the per-type multiplier. Mirrors auto-moderation's rule
 * (`autoModeration.ts`: `ev.kind === Kind.Article ? 'article' : 'note'`) so a post that the rest of
 * the app calls an article is the same thing Rising promotes as one.
 */
export function rankingPostKind(item: FeedItem): RankingPostKind {
  return item.kind === Kind.Article ? 'article' : 'note';
}

/**
 * Memoized prose word count, keyed on the FeedItem object. Feed items are immutable and cached by
 * identity (`feed._itemCache`), so a body is measured at most once however often the feed re-sorts,
 * and entries fall out with the item itself. This matters because `bodyForMeasure` regex-strips
 * inline media, and a picture/voice body carries megabytes of base64 — re-measuring that on every
 * reorder would block the JS thread.
 */
const _wordsMemo = new WeakMap<FeedItem, number>();

function proseWords(item: FeedItem): number {
  let words = _wordsMemo.get(item);
  if (words === undefined) {
    // Measure PROSE only — strip inline picture/voice tokens so a base64 blob's thousands of
    // characters don't read as a long, high-effort post (matches autoModeration's length gate).
    words = wordCount(bodyForMeasure(item.content));
    _wordsMemo.set(item, words);
  }
  return words;
}

/**
 * "Rising" score, tuned by the organizer's RankingConfig.
 *
 * Four independent engagement signals, summed, then scaled by two editorial multipliers:
 *
 *   ( tw·freshness + vw·log(1+voteVel) + cw·log(1+commentVel) + sw·log(1+score) )
 *     × typeWeight × (1 + lw·log(1+words))
 *
 *   • freshness  — the post's own age, on its own half-life. Independent of votes: this is what
 *                  lets a just-published post rise before anyone has voted on it. Bounded to [0,1].
 *   • voteVel    — decayed count of recent UPvotes (Stiq has no downvotes), on the vote half-life.
 *   • commentVel — decayed count of recent DISTINCT COMMENTERS, on the comment half-life. Distinct,
 *                  because one person replying 50 times is one person talking, not a crowd.
 *   • score      — the post's all-time approval, keeping proven posts visible below rising ones.
 *
 * EVERY signal is log-damped onto the same scale. That is the point: the earlier model summed a RAW
 * decayed vote count (linear, unbounded — 200 recent votes meant 200 points) against log-damped
 * comments and a freshness term bounded to 1.0. Votes therefore drowned everything else by two
 * orders of magnitude, and the weights meant nothing to whoever was tuning them — "timeWeight 1"
 * bought 0.5% of a busy post's score. In log space the weights are commensurable and a weight of 1
 * means the same thing to every signal. Reddit's hot ranking damps its vote count the same way, for
 * the same reason. Velocities still decay to 0, so old posts fall away regardless of how they were
 * damped.
 *
 * Every term is non-negative (there are no downvotes, and `score` is floored at 0), so the
 * multipliers can never invert an ordering. They scale the whole sum rather than adding to it, so
 * "articles rank 1.5×" holds at every level of engagement instead of handing dead posts a flat
 * bonus — a 1.5× multiplier on nearly nothing is still nearly nothing.
 */
function risingScore(item: FeedItem, now: number, ranking: RankingConfig): number {
  // Freshness reads the wire `createdAt` (seconds), NOT sortFeed's `at()` recency key: `sortAt` is
  // MILLISECONDS and local-only (own posts), so feeding it here would mix units and read every own
  // post as absurdly future-dated. The own-post created_at fuzz (audit #48) is seconds-scale —
  // noise against an hours-scale half-life.
  const freshness = ranking.timeWeight * decay(now - item.createdAt, ranking.timeHalfLifeHours);
  const voteVel = velocity(item.voteTimestamps, now, ranking.halfLifeHours);
  const commentVel = velocity(item.commentTimestamps, now, ranking.commentHalfLifeHours);

  const engagement =
    freshness +
    ranking.voteWeight * Math.log(1 + voteVel) +
    ranking.commentWeight * Math.log(1 + commentVel) +
    // Floored at 0: a negative score is unreachable through the UI (no downvotes) but a hostile
    // client can still emit '-' reactions, and log(1 + score) is NaN once score ≤ -1 — one NaN in
    // the comparator would scramble the whole feed order.
    ranking.scoreWeight * Math.log(1 + Math.max(0, item.score));

  // Both multipliers are 1.0 under DEFAULT_RANKING, so an untuned community is unaffected. The
  // lengthWeight===0 short-circuit also keeps the default path clear of proseWords' body scan.
  const typeWeight = ranking.typeWeights[rankingPostKind(item)] ?? 1;
  const lengthBoost =
    ranking.lengthWeight === 0 ? 1 : 1 + ranking.lengthWeight * Math.log(1 + proseWords(item));

  return engagement * typeWeight * lengthBoost;
}

export function sortFeed(
  items: FeedItem[],
  mode: SortMode,
  now: number = Math.floor(Date.now() / 1000),
  ranking: RankingConfig = DEFAULT_RANKING,
): FeedItem[] {
  const sorted = items.slice();
  // Effective recency key: the viewer's own posts carry a LOCAL-ONLY `sortAt` (true publish order in
  // ms) because their wire `created_at` is bucket-fuzzed and can invert for rapid own posts (audit
  // #48). Everyone else has sortAt undefined → falls back to createdAt. See FeedItem.sortAt.
  const at = (i: FeedItem): number => i.sortAt ?? i.createdAt;
  // Deterministic, stable tie-break for equal timestamps (event id is a globally-unique content hash),
  // so the feed order is stable across rebuilds instead of depending on stable-sort array order.
  const byId = (a: FeedItem, b: FeedItem): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  switch (mode) {
    case 'new':
      sorted.sort((a, b) => at(b) - at(a) || byId(a, b));
      break;
    case 'top':
      sorted.sort((a, b) => b.score - a.score || at(b) - at(a) || byId(a, b));
      break;
    case 'hot': {
      // Precompute each item's score once (O(N)) so the comparator does O(1) map lookups
      // instead of recomputing risingScore O(N log N) times. Output order is identical.
      const scores = new Map<string, number>(sorted.map(it => [it.id, risingScore(it, now, ranking)]));
      sorted.sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
      break;
    }
  }
  return sorted;
}

/** Filter by the selected tag(s) (AND, if any), then sort. */
export function arrangeFeed(
  items: FeedItem[],
  view: FeedView,
  now?: number,
  ranking?: RankingConfig,
): FeedItem[] {
  const selected = view.tags ?? [];
  // OR semantics: a post is kept when it carries ANY of the selected tags (a union), not all of
  // them. Selecting more tags widens the feed rather than narrowing it to the intersection.
  const filtered =
    selected.length > 0
      ? items.filter(item => selected.some(t => item.tags.includes(t)))
      : items;
  return sortFeed(filtered, view.sort, now, ranking);
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Distinct tags across the feed with counts, most common first. */
export function feedTags(items: FeedItem[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({tag, count}))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
