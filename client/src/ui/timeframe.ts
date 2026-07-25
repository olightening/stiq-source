/**
 * Shared time-frame model for search across every surface (feed, channels, groups, DMs).
 *
 * A `TimeSelection` is what the UI holds; `selectionToRange` turns it into a concrete
 * `{from,to}` window in unix seconds. Keeping presets as a *selection* (not a frozen range)
 * lets "Past 7 days" stay relative to now each time it's applied, while a custom range pins
 * exact endpoints. All parsing/formatting is in the device's local time zone — the user picks
 * wall-clock dates, so the window must match wall-clock too.
 */

export interface TimeRange {
  from: number; // unix seconds, inclusive
  to: number;   // unix seconds, inclusive
}

export type PresetKey = 'hour' | 'day' | 'week' | 'month';

export interface Preset {
  key: PresetKey;
  label: string; // full label, shown in the sheet
  short: string; // compact label, shown on the search-bar button
  seconds: number;
}

export const PRESETS: readonly Preset[] = [
  {key: 'hour',  label: 'Past hour',     short: '1h',  seconds: 3600},
  {key: 'day',   label: 'Past 24 hours', short: '24h', seconds: 86400},
  {key: 'week',  label: 'Past 7 days',   short: '7d',  seconds: 604800},
  {key: 'month', label: 'Past 30 days',  short: '30d', seconds: 2592000},
];

export type TimeSelection =
  | {kind: 'all'}
  | {kind: 'preset'; preset: PresetKey}
  | {kind: 'custom'; from: number; to: number | null}; // to=null → open-ended (up to now)

export const ALL_TIME: TimeSelection = {kind: 'all'};

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Concrete window for the current selection, or null for "any time" (no filtering). */
export function selectionToRange(sel: TimeSelection, now: number = nowSec()): TimeRange | null {
  switch (sel.kind) {
    case 'all':
      return null;
    case 'preset': {
      const p = PRESETS.find(x => x.key === sel.preset);
      return p ? {from: now - p.seconds, to: now} : null;
    }
    case 'custom':
      return {from: sel.from, to: sel.to ?? now};
  }
}

/** Filters items to those whose timestamp (unix seconds) falls within the range. */
export function filterByTime<T>(
  items: readonly T[],
  getSeconds: (item: T) => number,
  range: TimeRange | null,
): readonly T[] {
  if (!range) return items;
  return items.filter(item => {
    const t = getSeconds(item);
    return t >= range.from && t <= range.to;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "Jan 5" (local). Includes the year when it differs from the current year. */
function shortStamp(sec: number, now: number = nowSec()): string {
  const d = new Date(sec * 1000);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now * 1000).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** Compact label for the search-bar button. */
export function selectionLabel(sel: TimeSelection): string {
  switch (sel.kind) {
    case 'all':
      return 'Any time';
    case 'preset':
      return PRESETS.find(p => p.key === sel.preset)?.short ?? 'Any time';
    case 'custom':
      return sel.to == null
        ? `Since ${shortStamp(sel.from)}`
        : `${shortStamp(sel.from)} – ${shortStamp(sel.to)}`;
  }
}

/** True when the selection actually narrows results (drives the button's active styling). */
export function isActive(sel: TimeSelection): boolean {
  return sel.kind !== 'all';
}

/** Local "YYYY-MM-DD" for a unix-seconds timestamp. */
export function fmtDate(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local "HH:MM" for a unix-seconds timestamp. */
export function fmtTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Parses a local "YYYY-MM-DD" date with an optional "HH:MM" time into unix seconds, or null when
 * the date is malformed / nonexistent (e.g. 2026-02-31). A blank time defaults to 00:00, unless
 * `endOfDay` is set (23:59:59) so an inclusive "to" covers the whole day.
 */
export function parseDateTime(dateStr: string, timeStr: string, endOfDay = false): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);

  let hh = endOfDay ? 23 : 0;
  let mm = endOfDay ? 59 : 0;
  const ss = endOfDay ? 59 : 0;
  const t = timeStr.trim();
  if (t) {
    const tm = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!tm) return null;
    hh = Number(tm[1]);
    mm = Number(tm[2]);
    if (hh > 23 || mm > 59) return null;
  }

  const d = new Date(year, month - 1, day, hh, mm, ss, 0);
  // Reject dates JS silently rolled over (e.g. month 13, day 32).
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return Math.floor(d.getTime() / 1000);
}
