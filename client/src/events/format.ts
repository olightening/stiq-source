/**
 * Events formatting — pure string derivations for the events surface, ported from the DC
 * prototypes (EventsOrganizer.dc.html fmtWhen/recurLabel/copyText, EventDetail.dc.html addIcs,
 * the CSV builder) so the RN build renders the exact strings the design ships.
 *
 * Phase 0 (frozen): fmtWhen / fmtWhenFromIso / tzShort / whenLine / recurLabel.
 * Agent A2 extends this file with copyCardText / buildIcs / buildGuestCsv / reminderLabel /
 * relTimeShort + format.test.ts. The Phase-0 signatures are FROZEN — extend, don't change.
 */
import type {Attendee, ReminderUnit, Waitlister} from './types';
import {relTime} from '../ui/relTime';

export interface CardWhen {
  month: string; // 'NOV' | '—' (TBD)
  day: string; // '8' | '·' (TBD)
  dateLabel: string; // 'Sat, Nov 8' | 'Add a date'
  timeLabel: string; // '19:00 CET' | 'Add a time'
}

const M = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const Ml = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The tz short label shown next to a time: "CET (UTC+1)" → "CET". */
export function tzShort(tzLabel?: string): string {
  return (tzLabel || '').split(' ')[0] || '';
}

/**
 * Exact port of the DC's fmtWhen (EventsOrganizer.dc.html:649-665): editor text fields
 * ("YYYY-MM-DD", "HH:MM") → the card's month/day tile + when-line, with the TBD fallbacks.
 */
export function fmtWhen(dateStr?: string, timeStr?: string, tzLabel?: string): CardWhen {
  let month = '—';
  let day = '·';
  let dateLabel = 'Add a date';
  if (dateStr) {
    const p = dateStr.split('-');
    if (p.length === 3) {
      const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      if (!isNaN(dt.getTime())) {
        month = M[dt.getMonth()] ?? '—';
        day = String(dt.getDate());
        dateLabel = `${D[dt.getDay()] ?? ''}, ${Ml[dt.getMonth()] ?? ''} ${dt.getDate()}`;
      }
    }
  }
  const tz = tzShort(tzLabel);
  const timeLabel = timeStr ? timeStr + (tz ? ' ' + tz : '') : 'Add a time';
  return {month, day, dateLabel, timeLabel};
}

/** fmtWhen off an ISO datetime ("2025-11-08T19:00[:ss…]"). Undefined/dateless → TBD. */
export function fmtWhenFromIso(iso?: string, tzLabel?: string): CardWhen {
  if (!iso || iso.length < 10) return fmtWhen(undefined, undefined, tzLabel);
  const dateStr = iso.slice(0, 10);
  const timeStr = iso.length >= 16 && iso.charAt(10) === 'T' ? iso.slice(11, 16) : undefined;
  return fmtWhen(dateStr, timeStr, tzLabel);
}

/** One-line when ("Sat, Nov 8 · 19:00 CET" — TBD variants included, matching the editor preview). */
export function whenLine(w: CardWhen): string {
  return `${w.dateLabel} · ${w.timeLabel}`;
}

/** Recurrence → card chip label (DC recurLabel, enum-keyed for production). */
export function recurLabel(r?: 'none' | 'weekly' | 'monthly'): string {
  if (r === 'weekly') return 'Weekly';
  if (r === 'monthly') return 'Monthly';
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Copy card text — DC copyText port (EventsOrganizer.dc.html:673-682)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Input for the human-readable "Copy card" text (DC copyText, EventsOrganizer.dc.html:673-682). */
export interface CopyCardInput {
  title?: string;
  dateLabel: string;
  timeLabel: string;
  hasTime: boolean; // DC appends " · timeLabel" only when a time is set
  area?: string; // omitted when hidden/empty
  description?: string; // omitted when hidden/empty
  tag?: string; // omitted when hidden/empty
  external?: boolean;
  externalSource?: string;
  externalLink?: string;
}

/**
 * Exact port of the DC's copyText (EventsOrganizer.dc.html:673-682) — the plain-text "Copy event
 * card" body pasted into any chat/channel. The DC gates area/description/tag on a per-field
 * `hidden` flag checked against the caller's own state; CopyCardInput fields instead arrive
 * already resolved by the caller (omitted when hidden/empty), so here each is gated — and, unlike
 * the DC (which only trims description), rendered — as "non-empty after trim" for whitespace
 * safety, since this text is pasted verbatim into chats.
 */
export function copyCardText(e: CopyCardInput): string {
  const L: string[] = [];
  L.push(e.title || 'Untitled event');
  L.push(e.dateLabel + (e.hasTime ? ' · ' + e.timeLabel : ''));
  const area = (e.area || '').trim();
  if (area) L.push('📍 ' + area);
  const description = (e.description || '').trim();
  if (description) {
    L.push('');
    L.push(description);
  }
  const tag = (e.tag || '').trim();
  if (tag) {
    L.push('');
    L.push('#' + tag);
  }
  if (e.external) {
    L.push('');
    L.push(
      '↗ Shared event — organized by ' +
        (e.externalSource || 'someone else') +
        (e.externalLink ? ' · ' + e.externalLink : ''),
    );
  }
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// .ics export — DC addIcs port (EventDetail.dc.html:334-352)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface IcsInput {
  id: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  area?: string;
  description?: string;
}

/**
 * RFC 5545 TEXT escaping (backslash first, then semicolon/comma, then newlines → literal "\n").
 * The DC's addIcs fixture is 100% hardcoded and never exercises this path — its literal strings
 * happen to need no escaping — but real titles/descriptions will.
 */
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * "YYYY-MM-DD[THH:MM[:SS]…]" → "YYYYMMDDTHHMMSSZ". Reformats the wall-clock digits verbatim — no
 * `new Date()` timezone reinterpretation — mirroring fmtWhenFromIso's string-slicing above (the
 * app stores startsAt/endsAt as a naive local-wall-clock ISO paired with a separate `tz` display
 * label, so parsing it through the runtime's own timezone would silently shift the hour). The
 * trailing "Z" mirrors the DC's DTSTART/DTEND shape; it is not a real UTC conversion. Missing or
 * undated input → ''.
 */
function icsStamp(iso?: string): string {
  if (!iso || iso.length < 10) return '';
  const datePart = iso.slice(0, 10).replace(/-/g, '');
  if (datePart.length !== 8) return '';
  let timePart = '000000';
  if (iso.length >= 16 && iso.charAt(10) === 'T') {
    const hh = iso.slice(11, 13);
    const mm = iso.slice(14, 16);
    const ss = iso.length >= 19 && iso.charAt(16) === ':' ? iso.slice(17, 19) : '00';
    timePart = hh + mm + ss;
  }
  return `${datePart}T${timePart}Z`;
}

/**
 * DTSTAMP is the moment of .ics generation (RFC 5545) — unlike startsAt/endsAt this genuinely is
 * "now" in UTC, so `new Date()` + UTC getters is correct (no wall-clock/tz ambiguity to preserve).
 */
function icsNowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Port of the DC's addIcs (EventDetail.dc.html:334-352) — same VCALENDAR/VEVENT skeleton,
 * property order and CRLF line join; the DC's hardcoded fixture values are replaced by the input
 * fields. `endsAt` falls back to `startsAt` when absent (the DC's fixture always shows a DTEND
 * and there's no documented default-duration rule, so this keeps a zero-length event rather than
 * inventing one). LOCATION/DESCRIPTION are omitted entirely (no empty property line) when their
 * input is absent/blank.
 */
export function buildIcs(e: IcsInput): string {
  const start = icsStamp(e.startsAt);
  const end = icsStamp(e.endsAt) || start;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Stiq//Events//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${e.id}@stiq`,
    `DTSTAMP:${icsNowStamp()}`,
  ];
  if (start) lines.push(`DTSTART:${start}`);
  if (end) lines.push(`DTEND:${end}`);
  lines.push(`SUMMARY:${icsEscape(e.title || 'Untitled event')}`);
  const area = (e.area || '').trim();
  if (area) lines.push(`LOCATION:${icsEscape(area)}`);
  const description = (e.description || '').trim();
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Guest .csv export — DC exportCsv port (EventsOrganizer.dc.html:883-887)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Port of the DC's exportCsv (EventsOrganizer.dc.html:883-887) — identical header row, quoting
 * (every cell double-quoted, embedded quotes doubled) and CRLF row join. The DC's fixture only
 * ever exports the confirmed-guest ("going") list; this signature additionally folds in the
 * waitlist, so — kept to the same 4-column shape rather than growing a column — waitlist rows use
 * status "waitlist" and repurpose the "joined" column (no join date exists yet) to carry the
 * queue position instead. `grad` is never serialized; the DC's row shape omits it too.
 */
export function buildGuestCsv(guests: Attendee[], waitlist: Waitlister[]): string {
  const rows: string[][] = [['name', 'npub', 'status', 'joined']];
  for (const g of guests) rows.push([g.who.name, g.who.npub, 'going', g.joinedAt]);
  for (const w of waitlist) rows.push([w.who.name, w.who.npub, 'waitlist', String(w.position)]);
  return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reminder chip label (COPY.md — Event detail → Approved)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const REMINDER_UNIT_SINGULAR: Record<ReminderUnit, string> = {
  minutes: 'minute',
  hours: 'hour',
  days: 'day',
  weeks: 'week',
};

/** "Reminder set — {N} {unit} before it starts" (COPY.md, verbatim), singular unit only at N===1. */
export function reminderLabel(n: number, unit: ReminderUnit): string {
  const unitLabel = n === 1 ? REMINDER_UNIT_SINGULAR[unit] : unit;
  return `Reminder set — ${n} ${unitLabel} before it starts`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Relative time — application submittedAt
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "now"/"5m"/"3h"/"2d"/"4mo" relative age for an application's `submittedAt`. Reuses the app's
 * single relative-time formatter (ui/relTime, 'short' style) instead of inventing a new bucket
 * scheme — matching the closest existing analog, the channel join-request row's
 * `relTimeShort(rq.at)` in channels/components/GroupView.tsx (also 'short'-style, via ui/relTime).
 * `submittedAt` is a real instant (unlike startsAt/endsAt it has no paired `tz` display label), so
 * parsing it with `Date.parse` — rather than the string-slicing `icsStamp`/`fmtWhenFromIso` use —
 * is safe here.
 */
export function relTimeShort(iso: string, nowMs: number = Date.now()): string {
  const ts = Math.floor(Date.parse(iso) / 1000);
  return relTime(ts, 'short', nowMs);
}
