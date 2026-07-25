/**
 * Local feed search — filters already-cached FeedItems by a query string and optional
 * time range. No relay query; honors §3.8 no-directory guarantee.
 */
import type {FeedItem} from './feed';

export interface TimeRange {
  from: number; // unix seconds (inclusive)
  to: number;   // unix seconds (inclusive)
}

/** Preset time ranges keyed by display label. */
export const TIME_RANGE_PRESETS: Record<string, () => TimeRange> = {
  'Past hour':  () => { const now = Math.floor(Date.now() / 1000); return {from: now - 3600, to: now}; },
  'Past 24h':   () => { const now = Math.floor(Date.now() / 1000); return {from: now - 86400, to: now}; },
  'Past 7 days':() => { const now = Math.floor(Date.now() / 1000); return {from: now - 604800, to: now}; },
  'Past 30 days':() => { const now = Math.floor(Date.now() / 1000); return {from: now - 2592000, to: now}; },
};

export const TIME_RANGE_LABELS = Object.keys(TIME_RANGE_PRESETS) as (keyof typeof TIME_RANGE_PRESETS)[];

/**
 * Returns items matching the query string (case-insensitive) and optional time range.
 * An empty query returns all items (time-filtered if a range is given).
 */
export function searchFeed(items: FeedItem[], query: string, timeRange?: TimeRange | null): FeedItem[] {
  const q = query.trim().toLowerCase();
  let result = items;

  if (timeRange) {
    result = result.filter(item => item.createdAt >= timeRange.from && item.createdAt <= timeRange.to);
  }

  if (!q) return result;

  return result.filter(
    item =>
      item.content.toLowerCase().includes(q) ||
      item.title?.toLowerCase().includes(q) ||
      item.author.toLowerCase().includes(q) ||
      item.tags.some(t => t.toLowerCase().includes(q)),
  );
}
