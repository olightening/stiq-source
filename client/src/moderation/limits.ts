/**
 * Client-side rate-limit pre-check (Phase B). The relay is the hard enforcer (it rejects
 * events past the cap so storage/cost is truly bounded); this module gives a friendly
 * heads-up BEFORE publishing, so a user sees "you've hit your daily post limit" instead of a
 * bare relay rejection. It reads the same organizer policy (currentLimits) and counts the
 * user's OWN recent events from the local cache.
 *
 * Categories mirror the relay (ratelimit.go): post = kind-1 feed note, comment = kind-1111 +
 * hybrid kind-1 'stiq-comment', channel = kind-42 / kind-1311 / kind-31923 (an event doc is
 * republished on every edit/approval, management-op cadence — the relay caps it in the channel
 * window; 31925 RSVPs mirror reactions: uncategorized, blind-token-priced instead).
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import {KIND_EVENT} from '../contracts';
import type {EventStore} from '../nostr/store';
import {isStiqComment} from '../feed/comments';
import type {Limits, WindowLimits} from './organizerConfig';

export type LimitCategory = 'posts' | 'comments' | 'channel';

const DAY = 86400;

export interface QuotaWindow {
  /** Remaining writes in the window before the relay rejects (Infinity = unlimited). */
  remaining: number;
  /** The configured cap (0 / undefined source → Infinity). */
  limit: number;
  used: number;
}

export interface Quota {
  daily: QuotaWindow;
  weekly: QuotaWindow;
  monthly: QuotaWindow;
  /** True when any window is exhausted — publishing should be blocked. */
  blocked: boolean;
  /** The most restrictive exhausted window label, for messaging. */
  blockedWindow?: 'daily' | 'weekly' | 'monthly';
}

/** Map an event to a rate-limit category, or null when uncapped. */
export function limitCategory(event: Event): LimitCategory | null {
  switch (event.kind) {
    case Kind.Post:
      return isStiqComment(event) ? 'comments' : 'posts';
    case Kind.Comment:
      return 'comments';
    case Kind.ChannelMessage:
    case Kind.LiveChat:
    case KIND_EVENT:
      return 'channel';
    default:
      return null;
  }
}

function windowFor(category: LimitCategory, limits: Limits): WindowLimits | undefined {
  return limits[category];
}

function makeWindow(limit: number | undefined, used: number): QuotaWindow {
  const cap = limit && limit > 0 ? limit : Infinity;
  return {limit: cap === Infinity ? Infinity : cap, used, remaining: Math.max(0, cap - used)};
}

/**
 * Compute the current user's quota for a category. `nowSec` defaults to now; injectable for
 * tests. Counts the user's own events of that category in the cache across the three windows.
 */
export function quotaFor(
  store: EventStore,
  myPubkey: string,
  category: LimitCategory,
  limits: Limits | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Quota {
  const win = limits ? windowFor(category, limits) : undefined;
  let daily = 0;
  let weekly = 0;
  let monthly = 0;
  for (const ev of store.query({authors: [myPubkey]})) {
    if (limitCategory(ev) !== category) continue;
    const age = nowSec - ev.created_at;
    if (age < 0) continue;
    if (age < DAY) daily++;
    if (age < 7 * DAY) weekly++;
    if (age < 30 * DAY) monthly++;
  }
  const q: Quota = {
    daily: makeWindow(win?.daily, daily),
    weekly: makeWindow(win?.weekly, weekly),
    monthly: makeWindow(win?.monthly, monthly),
    blocked: false,
  };
  // Most restrictive first: daily, then weekly, then monthly.
  for (const w of ['daily', 'weekly', 'monthly'] as const) {
    if (q[w].remaining <= 0 && q[w].limit !== Infinity) {
      q.blocked = true;
      q.blockedWindow = w;
      break;
    }
  }
  return q;
}

/** A short user-facing message when a quota window is exhausted, or null when free to post. */
export function limitMessage(quota: Quota, category: LimitCategory): string | null {
  if (!quota.blocked || !quota.blockedWindow) return null;
  const noun = category === 'posts' ? 'post' : category === 'comments' ? 'comment' : 'channel message';
  return `You've reached your ${quota.blockedWindow} ${noun} limit. Please try again later.`;
}
