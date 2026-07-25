/**
 * Organizer-defined moderation reason buckets — the "categories" a moderator (or the channel
 * owner, or the automatic layer) must pick when removing a post, comment, or channel message.
 * Replaces the build-time NIP-56 report-type list.
 *
 * Delivered as a kind-30078 doc (d=stiq:reasons) signed by the organizer. A removal references
 * a bucket by its stable `id` (3rd element of the report's `e` tag), so renaming or recoloring
 * a bucket never rewrites past removals; a deleted bucket renders by id with a neutral chip.
 *
 * The doc also carries `reportThreshold`: once that many DISTINCT members report one item it is
 * auto-hidden pending moderator review (0 = no member-report auto-hide).
 */

export const KIND_REASONS = 30078;
export const REASONS_D_TAG = 'stiq:reasons';

export interface ReasonBucket {
  /** Stable slug stored on the removal; never reused after delete. */
  id: string;
  /** Display name. */
  name: string;
  /** Hex accent color, surfaced in the mod log and on the "removed" banner. */
  color: string;
  order: number;
}

export interface ReasonsConfig {
  buckets: ReasonBucket[];
  /** Distinct member reports that auto-hide an item pending review. 0 = disabled. */
  reportThreshold: number;
}

/** Sensible starter set (the fallback when the organizer has not published a roster yet). */
export const DEFAULT_REASONS: ReasonsConfig = {
  buckets: [
    {id: 'spam', name: 'Spam', color: '#c77b7b', order: 0},
    {id: 'harassment', name: 'Harassment', color: '#b5563f', order: 1},
    {id: 'off-topic', name: 'Off-topic', color: '#9b8cc6', order: 2},
    {id: 'illegal', name: 'Illegal', color: '#c79583', order: 3},
    {id: 'other', name: 'Other', color: '#8a8f98', order: 4},
  ],
  reportThreshold: 0,
};

/** Compact on-wire shape (kind-30078 content). */
interface ReasonBucketWire {
  id?: string;
  nm?: string;
  c?: string;
  o?: number;
}
interface ReasonsWire {
  bk?: ReasonBucketWire[];
  th?: number;
}

export function encodeReasons(r: ReasonsConfig): ReasonsWire {
  return {
    bk: r.buckets.map(b => ({id: b.id, nm: b.name, c: b.color, o: b.order})),
    th: r.reportThreshold,
  };
}

export function parseReasons(raw: unknown): ReasonsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as ReasonsWire;
  if (!Array.isArray(w.bk)) return null;
  const buckets: ReasonBucket[] = [];
  for (const b of w.bk) {
    if (!b || typeof b.id !== 'string' || !b.id) continue;
    buckets.push({
      id: b.id,
      name: typeof b.nm === 'string' && b.nm ? b.nm : b.id,
      color: typeof b.c === 'string' && b.c ? b.c : '#8a8f98',
      order: typeof b.o === 'number' && Number.isFinite(b.o) ? b.o : buckets.length,
    });
  }
  buckets.sort((a, b) => a.order - b.order);
  return {
    buckets,
    reportThreshold:
      typeof w.th === 'number' && w.th > 0 && Number.isFinite(w.th) ? Math.floor(w.th) : 0,
  };
}

/** Parse a kind-30078 event's content into a ReasonsConfig (null if malformed). */
export function parseReasonsEvent(content: string): ReasonsConfig | null {
  try {
    return parseReasons(JSON.parse(content));
  } catch {
    return null;
  }
}

const NEUTRAL_COLOR = '#8a8f98';

/**
 * Resolve a bucket id to its display name + color. An unknown / deleted id falls back to the
 * raw id with a neutral color, so past removals keep rendering after a bucket is removed.
 */
export function bucketMetaFor(
  id: string | undefined,
  cfg: ReasonsConfig,
): {id: string; name: string; color: string} {
  if (!id) return {id: 'other', name: 'Other', color: NEUTRAL_COLOR};
  const found = cfg.buckets.find(b => b.id === id);
  return found
    ? {id: found.id, name: found.name, color: found.color}
    : {id, name: id, color: NEUTRAL_COLOR};
}
