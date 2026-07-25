/**
 * Per-source read state — drives the unread-count bubbles on the Channels list.
 *
 * Distinct from the notification high-water marks in notifications.ts: those advance whenever a
 * local notification *fires* (and only when a provider is registered). This tracks when the user
 * actually *opened* a conversation, so "unread" means "messages newer than the last time you looked",
 * independent of whether notifications are enabled.
 *
 * Source IDs reuse the notification key scheme so a row can be addressed consistently:
 *   dm:<peerPubkey> · ch:<channelId> · grp:<groupId>
 *
 * The last-seen map is mirrored in memory after the first load so the list can read it
 * synchronously while it renders; writes persist to AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'stiq.read.seen';

// Active account (KeyRing slot) — read/seen + notification-center state is namespaced PER ACCOUNT so
// two identities on one device never share "seen"/"read" marks (finding D1: cross-account read-state
// bleed). Undefined ⇒ the pre-silo GLOBAL keys (also the one-time upgrade baseline). setNotifReadSlot()
// flips it and drops the in-memory caches so the next access reloads the new account's state.
let _slot: string | undefined;
const keyFor = (base: string): string => (_slot ? `${base}.${_slot}` : base);

let _loaded = false;
const _seen = new Map<string, number>();

/** Source-id builders (mirror notifications.ts mute/HWM keys). */
export const dmSeenId  = (peerPubkey: string): string => `dm:${peerPubkey}`;
export const chSeenId  = (channelId:  string): string => `ch:${channelId}`;
export const grpSeenId = (groupId:    string): string => `grp:${groupId}`;

/** Load persisted read state into memory once. Safe to await repeatedly. */
export async function ensureReadStateLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(keyFor(SEEN_KEY));
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
        _seen.set(k, v);
      }
    }
  } catch { /* fresh state is fine */ }
}

/** Last-seen unix-seconds for a source (0 if never opened). Synchronous — call after load. */
export function lastSeen(sourceId: string): number {
  return _seen.get(sourceId) ?? 0;
}

/**
 * Mark a source seen up to `ts` (its newest message's created_at). Monotonic — never moves
 * backwards. Returns true if the high-water mark advanced (so the caller can refresh the badge).
 */
export async function markSeen(sourceId: string, ts: number): Promise<boolean> {
  await ensureReadStateLoaded();
  if (ts <= (_seen.get(sourceId) ?? 0)) return false;
  _seen.set(sourceId, ts);
  const obj: Record<string, number> = {};
  for (const [k, v] of _seen) obj[k] = v;
  try { await AsyncStorage.setItem(keyFor(SEEN_KEY), JSON.stringify(obj)); } catch { /* best effort */ }
  return true;
}

/**
 * Unread count for a source: messages newer than the seen watermark, excluding the viewer's own.
 * `msgs` is the source's message list (any order); `selfPubkey` is omitted from the count. `floor`
 * clamps the lower bound to a community's first-entry timestamp (Point 7) so history posted before
 * the member joined never counts — even when it streams in AFTER the join. Default 0 keeps the
 * legacy behavior for every caller that doesn't pass one.
 */
export function unreadCount(
  sourceId: string,
  msgs: ReadonlyArray<{created_at: number; pubkey: string}>,
  selfPubkey?: string | null,
  floor = 0,
): number {
  const since = Math.max(lastSeen(sourceId), floor);
  let n = 0;
  for (const m of msgs) {
    if (m.created_at > since && m.pubkey !== selfPubkey) n++;
  }
  return n;
}

/**
 * Badge for a community space: the real post-join unread count, or — on first community entry, for a
 * space the member hasn't opened yet — a single "1" newcomer nudge (Point 7). `floor` is the
 * community's firstEnteredAt(): 0 (an established/untracked member) disables the nudge entirely, so
 * the badge is just the plain unread count. Opening a space advances lastSeen to >= floor (see
 * MainScreen.markSourceSeen), which clears the nudge even for a space that has no messages yet.
 */
export function spaceBadge(
  sourceId: string,
  msgs: ReadonlyArray<{created_at: number; pubkey: string}>,
  selfPubkey: string | null | undefined,
  floor: number,
): number {
  const real = unreadCount(sourceId, msgs, selfPubkey, floor);
  if (real > 0) return real;
  return floor > 0 && lastSeen(sourceId) < floor ? 1 : 0;
}

// ─── Notification-center read state ─────────────────────────────────────────────
//
// Per-item read tracking for the notification center (design: tap a row → its unread dot clears;
// ✓✓ → everything clears; the bell badge counts what's still unread). Two pieces:
//   · `allBefore` — a monotonic watermark; anything created at/before it is read. Advanced by
//     Mark-all-read. Seeded from the legacy "last opened" key so an upgrade doesn't relight
//     every historical notification.
//   · a bounded id-set of individually-read notifications (row taps). The derived list caps at
//     100 rows, so the set is pruned FIFO well above that — never unbounded growth.

const NOTIF_READ_KEY = 'stiq.notif.read';
/** Pre-redesign single watermark ("center last opened") — read once as a migration seed. */
const LEGACY_NOTIF_OPENED_KEY = 'stiq.notif.opened';
const MAX_READ_IDS = 300;

let _notifReadLoaded = false;
let _readAllBefore = 0;
/** Insertion-ordered ids (for FIFO pruning) mirrored in a Set (for O(1) lookup). */
let _readIds: string[] = [];
let _readIdSet = new Set<string>();

/** Load the persisted read state into memory once. Safe to await repeatedly. */
export async function ensureNotifReadLoaded(): Promise<void> {
  if (_notifReadLoaded) return;
  _notifReadLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(keyFor(NOTIF_READ_KEY));
    if (raw) {
      const parsed = JSON.parse(raw) as {before?: unknown; ids?: unknown};
      if (typeof parsed.before === 'number' && !Number.isNaN(parsed.before)) {
        _readAllBefore = parsed.before;
      }
      if (Array.isArray(parsed.ids)) {
        _readIds = parsed.ids.filter((v): v is string => typeof v === 'string').slice(-MAX_READ_IDS);
        _readIdSet = new Set(_readIds);
      }
    }
    // Migration: the old model marked everything read whenever the center was opened. Carry that
    // watermark forward so an upgraded install doesn't wake up with every old row unread.
    const legacy = await AsyncStorage.getItem(LEGACY_NOTIF_OPENED_KEY);
    if (legacy != null) {
      const n = Number(legacy);
      if (!Number.isNaN(n) && n > _readAllBefore) _readAllBefore = n;
    }
  } catch { /* fresh state is fine */ }
}

async function persistNotifRead(): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(NOTIF_READ_KEY), JSON.stringify({before: _readAllBefore, ids: _readIds}));
  } catch { /* best effort — in-memory mirror already updated */ }
}

/**
 * Switch the active account for read/seen + notification-center state. Drops the in-memory caches so
 * the next access reloads the new account's persisted state (finding D1). Idempotent — a no-op when the
 * slot is unchanged. The pre-redesign global `stiq.notif.opened` watermark is still read as a one-time
 * per-account baseline seed (see ensureNotifReadLoaded), so an upgrade doesn't relight old rows.
 */
export function setNotifReadSlot(slotId: string | undefined): void {
  if (slotId === _slot) return;
  _slot = slotId;
  _loaded = false;
  _seen.clear();
  _notifReadLoaded = false;
  _readAllBefore = 0;
  _readIds = [];
  _readIdSet = new Set();
}

/** Whether the notification (`id`, created at `ts`) has been read. Synchronous — call after load. */
export function isNotifRead(id: string, ts: number): boolean {
  return ts <= _readAllBefore || _readIdSet.has(id);
}

/** Mark one notification read (row tap). Idempotent. */
export async function markNotifRead(id: string): Promise<void> {
  await ensureNotifReadLoaded();
  if (_readIdSet.has(id)) return;
  _readIdSet.add(id);
  _readIds.push(id);
  if (_readIds.length > MAX_READ_IDS) {
    const dropped = _readIds.splice(0, _readIds.length - MAX_READ_IDS);
    for (const d of dropped) _readIdSet.delete(d);
  }
  await persistNotifRead();
}

/** Mark everything at/before `ts` read (✓✓ Mark-all-read). Monotonic — never moves backwards. */
export async function markAllNotifsRead(ts: number): Promise<void> {
  await ensureNotifReadLoaded();
  if (ts <= _readAllBefore) return;
  _readAllBefore = ts;
  // Individually-read ids at/before the watermark are now redundant; the derived list never
  // outlives the watermark by much, so simply reset the set.
  _readIds = [];
  _readIdSet = new Set();
  await persistNotifRead();
}
