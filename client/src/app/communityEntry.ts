/**
 * Per-(account, community) first-entry signal — the one timestamp that powers the Updates tab's
 * first-run behavior: land on Updates (Point 1), the welcome countdown (Point 6), and the
 * hide-pre-join-history + "1" newcomer nudge (Point 7).
 *
 * `firstEnteredAt` is written ONCE, at the JOIN/ENROLL moment (AppRuntime.enroll) — never on a cold
 * start or a community switch. So an already-joined member (no record) reads 0, and every new
 * behavior keyed on it is a clean no-op: no redirect, no welcome, no history clamp. Only a genuine
 * new join sets it to `now`.
 *
 * Mirrors dockPrefs.ts: in-memory mirror loaded once (synchronous reads before first paint —
 * AppRuntime.loadWorkspaceState switches the slot+cid and eagerly loads it), async best-effort
 * writes, keys namespaced per account (KeyRing slot) AND community (cid).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const ENTERED_KEY = 'stiq.community.enteredAt';

let _slot: string | undefined;
let _cid: string | undefined;
const keyFor = (): string => `${ENTERED_KEY}.${_slot ?? 'g'}.${_cid ?? 'g'}`;

let _loaded = false;
let _enteredAt = 0;
/** True only for the activation that JUST recorded a first entry — stable across recordEntry's own
 *  write, reset when the (slot,cid) changes. Drives MainScreen's land-on-Updates trigger. */
let _wasFirst = false;

/** Switch the active (account, community); drops the mirror so the next access reloads. */
export function setCommunityEntrySlot(slot: string | undefined, cid: string | undefined): void {
  if (slot === _slot && cid === _cid) return;
  _slot = slot;
  _cid = cid;
  _loaded = false;
  _enteredAt = 0;
  _wasFirst = false;
}

/** Load persisted state into memory once. Safe to await repeatedly. */
export async function ensureCommunityEntryLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(keyFor());
    const n = raw ? Number(raw) : 0;
    _enteredAt = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    _enteredAt = 0;
  }
}

/** First-entry unix seconds; 0 = no record (an existing/untracked member). Synchronous — call after load. */
export function firstEnteredAt(): number {
  return _enteredAt;
}

/** Whether THIS activation is the community's first-ever entry. Synchronous — call after load. */
export function wasFirstEntry(): boolean {
  return _wasFirst;
}

/**
 * Record the first entry (join/enroll). Flips {@link wasFirstEntry} true for this activation, and
 * stamps {@link firstEnteredAt} ONCE — a second call never moves the stored timestamp, so the
 * welcome countdown and the unread floor stay anchored to the true first entry.
 */
export function recordEntry(nowSec: number): void {
  _wasFirst = true;
  if (_enteredAt > 0 || !(nowSec > 0)) return;
  _enteredAt = nowSec;
  AsyncStorage.setItem(keyFor(), String(nowSec)).catch(() => {
    /* best effort — the in-memory mirror already updated */
  });
}
