/**
 * Event reminders — schedule/cancel/reschedule a notifee TRIGGER notification (exact-timestamp local
 * alarm, NOT displayNotification) for one event, plus a small persisted record so the rest of the app
 * can re-derive "is a reminder set, and for when" without asking notifee (which has no cheap "list my
 * triggers" query on the JS side after a cold start).
 *
 * Mirrors two existing idioms rather than inventing new ones:
 *  - The duck-typed, guarded `require('@notifee/react-native')` App.tsx uses (see its comment there):
 *    @notifee/react-native throws AT REQUIRE-TIME when its native module isn't compiled into the APK
 *    (e.g. an older build), so a static `import notifee from '@notifee/react-native'` here would crash
 *    every screen that merely imports this module on such a build. Every export below degrades to a
 *    safe false/null/{} instead — never throws.
 *  - The SecureStorage-backed, try/catch-around-JSON.parse-only JSON store in feed/drafts.ts. These are
 *    plain functions rather than a class (per the frozen signatures), so the storage backend is wired
 *    in via a `setReminderStorage()` provider — the SAME injection idiom App.tsx already uses for
 *    `setNotificationProvider`/`setMediaService`/`setLinkChecker`.
 *
 * Notifications are TITLE-ONLY (product decision — matches notifications/notifications.ts's product
 * lock): no event description/location/host ever rides in a reminder notification, only its title.
 *
 * Tap-routing convention (matched, not invented): the app's live notification press handler
 * (App.tsx's handleNotifeePress) decodes the notifee `data` payload via
 * notifications/notifications.ts's `decodeNavTarget()`, which switches on a flat `kind` discriminator
 * — `{kind:'dm',peer}`, `{kind:'channel',channelId,channelType}`, `{kind:'post',rootId}`,
 * `{kind:'group_requests',groupId}` — produced by the mirror-image `encodeNavTarget()`. That `NavTarget`
 * union and its codec live in notifications/notifications.ts, which is NOT one of this slice's files
 * (and `events/types.ts` is frozen), so an `'event'` member can't be added to that closed union here.
 * This module matches the SAME wire shape by hand instead: `{kind: 'event', coordinate}`. See this
 * slice's report for the exact (small) follow-up the integrator needs to wire the tap through.
 */
import type {ReminderUnit} from './types';
import type {SecureStorage} from '../keys/keystore';
import {sha256Hex} from '../util/hash';
import {utf8Encode} from '../util/utf8';

// ─── notifee (guarded require — see module doc) ───────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let notifee: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TriggerType: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const notifeeModule = require('@notifee/react-native');
  notifee = notifeeModule.default;
  TriggerType = notifeeModule.TriggerType;
} catch {
  /* native module not linked — reminders silently no-op, mirrors App.tsx's own notifee guard */
}

/** Dedicated Android notification channel for event reminders — mirrors App.tsx's dm/channel/comment
 *  channel creation: bare {id, name}, no explicit importance override (same importance idiom). */
const CHANNEL_ID = 'event-reminder';
const CHANNEL_NAME = 'Event Reminders';

let channelReady = false;
async function ensureChannel(): Promise<void> {
  if (channelReady || !notifee) return;
  await notifee.createChannel({id: CHANNEL_ID, name: CHANNEL_NAME});
  channelReady = true;
}

// ─── storage (provider-injected — mirrors setNotificationProvider/setMediaService/setLinkChecker) ──

let _storage: SecureStorage | null = null;

/**
 * Register the SecureStorage backend reminder records persist to. Call once at startup (e.g.
 * alongside setNotificationProvider in App.tsx) with the SAME SecureStorage instance the rest of the
 * app uses. Until this is called, scheduling/cancelling still work (they only touch notifee), but
 * getReminder/listReminders read back nothing and a schedule won't survive a relaunch.
 */
export function setReminderStorage(storage: SecureStorage | null): void {
  _storage = storage;
}

/** Device-global (not per-slot — see this slice's report) storage key for the reminders map. */
const REMINDERS_KEY = 'stiq:events:reminders';

export interface ReminderRecord {
  n: number;
  unit: ReminderUnit;
  at: number;
}

async function readAll(): Promise<Record<string, ReminderRecord>> {
  if (!_storage) return {};
  try {
    const raw = await _storage.getItem(REMINDERS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ReminderRecord>;
  } catch {
    return {};
  }
}

async function writeAll(all: Record<string, ReminderRecord>): Promise<void> {
  if (!_storage) return;
  await _storage.setItem(REMINDERS_KEY, JSON.stringify(all));
}

// ─── id derivation ──────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic, notifee-safe notification id for an event's reminder, derived from its coordinate
 * (a NIP-01 "kind:pubkey:d" address — long and colon-bearing, not something worth handing to the
 * native notification id verbatim). Same coordinate -> same id, so scheduling a new trigger for a
 * coordinate that already has one REPLACES it (notifee's same-id-replaces contract) instead of
 * stacking duplicates — this is what makes scheduleEventReminder naturally idempotent per coordinate.
 */
export function reminderNotificationId(coordinate: string): string {
  return `evt-reminder-${sha256Hex(utf8Encode(coordinate)).slice(0, 16)}`;
}

// ─── pure math ──────────────────────────────────────────────────────────────────────────────────

function unitMs(unit: ReminderUnit): number {
  switch (unit) {
    case 'minutes':
      return 60_000;
    case 'hours':
      return 60 * 60_000;
    case 'days':
      return 24 * 60 * 60_000;
    case 'weeks':
      return 7 * 24 * 60 * 60_000;
  }
}

/**
 * Timestamp (ms since epoch) of (startsAt − n·unit) — the moment a reminder should fire. Pure: no
 * notifee/storage access, safe to unit-test directly. Returns null when `startsAtIso` doesn't parse,
 * `n` isn't a positive finite number, or the computed moment is already at/before `nowMs` (defaults to
 * `Date.now()`) — notifee's TIMESTAMP trigger requires a future timestamp, and a reminder that would
 * fire in the past should simply not be scheduled rather than firing immediately or erroring.
 */
export function computeTriggerAt(
  startsAtIso: string,
  n: number,
  unit: ReminderUnit,
  nowMs?: number,
): number | null {
  const startMs = Date.parse(startsAtIso);
  if (!Number.isFinite(startMs)) return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  const at = startMs - n * unitMs(unit);
  const now = nowMs ?? Date.now();
  if (at <= now) return null;
  return at;
}

// ─── schedule / cancel / reschedule ────────────────────────────────────────────────────────────

export interface ScheduleReminderInput {
  coordinate: string;
  title: string;
  startsAtIso: string;
  n: number;
  unit: ReminderUnit;
}

/**
 * Schedule a title-only notifee TRIGGER notification (exact timestamp — createTriggerNotification,
 * NOT displayNotification) for one event, and persist the record so getReminder/listReminders can
 * re-derive it later. Resolves `false` — NEVER throws — when notifee's native module isn't linked, the
 * computed trigger time is invalid/already past (see computeTriggerAt), or the native call rejects.
 *
 * Android 12+ (API 31+) note: `alarmManager.allowWhileIdle` schedules through AlarmManager's exact,
 * Doze-bypassing path, which needs the SCHEDULE_EXACT_ALARM permission — see this slice's report for
 * the exact manifest line. This module does not, and must not, touch the manifest itself.
 */
export async function scheduleEventReminder(input: ScheduleReminderInput): Promise<boolean> {
  if (!notifee) return false;
  const at = computeTriggerAt(input.startsAtIso, input.n, input.unit);
  if (at === null) return false;

  try {
    await ensureChannel();
    await notifee.createTriggerNotification(
      {
        id: reminderNotificationId(input.coordinate),
        title: input.title,
        data: {kind: 'event', coordinate: input.coordinate},
        android: {
          channelId: CHANNEL_ID,
          pressAction: {id: 'default'},
        },
      },
      {
        type: TriggerType.TIMESTAMP,
        timestamp: at,
        alarmManager: {allowWhileIdle: true},
      },
    );
  } catch {
    return false;
  }

  const all = await readAll();
  all[input.coordinate] = {n: input.n, unit: input.unit, at};
  await writeAll(all);
  return true;
}

/** Cancel a coordinate's trigger notification (id derived the same deterministic way) and drop its
 *  persisted record. Never throws — cancelling an already-fired/absent trigger is treated as a no-op. */
export async function cancelEventReminder(coordinate: string): Promise<void> {
  if (notifee) {
    try {
      await notifee.cancelTriggerNotification(reminderNotificationId(coordinate));
    } catch {
      /* already fired/cancelled, or native module absent — nothing to undo */
    }
  }
  const all = await readAll();
  if (coordinate in all) {
    delete all[coordinate];
    await writeAll(all);
  }
}

/** Cancel + reschedule — used when the reminder offset or the event's start time changes. */
export async function rescheduleEventReminder(input: ScheduleReminderInput): Promise<boolean> {
  await cancelEventReminder(input.coordinate);
  return scheduleEventReminder(input);
}

// ─── read back ──────────────────────────────────────────────────────────────────────────────────

/** The persisted reminder for one event, or null when none is set (or setReminderStorage was never
 *  called). */
export async function getReminder(coordinate: string): Promise<ReminderRecord | null> {
  const all = await readAll();
  return all[coordinate] ?? null;
}

/** Every persisted reminder, keyed by event coordinate. Empty when none are set (or
 *  setReminderStorage was never called). */
export async function listReminders(): Promise<Record<string, ReminderRecord>> {
  return readAll();
}
