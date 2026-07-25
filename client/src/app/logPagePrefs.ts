/**
 * Log-page member preferences — the tuck-away note dismissal + the mod-log layout choice.
 *
 * The note-collapse contract (design STATES §2): "Tuck away" persists the CURRENT note version;
 * the card renders collapsed exactly while the stored dismissal matches the live note's version,
 * so a NEW note (a different version) auto-reopens the card, and "reopen" clears the dismissal.
 * Dismissals are kept as a small bounded set — one device can sit in several communities, and
 * tucking community A's note must not reopen community B's (each note has its own version).
 *
 * Mirrors readState.ts: in-memory mirror loaded once (synchronous reads before first paint —
 * AppRuntime.loadWorkspaceState switches the slot + eagerly loads on init/account-switch so there
 * is no flash of the wrong state), async best-effort writes, per-account (KeyRing slot) keys.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const DISMISSED_KEY = 'stiq.log.noteDismissed';
const LAYOUT_KEY = 'stiq.log.layout';
/** Dismissals are pruned FIFO — far above any real community count on one device. */
const MAX_DISMISSED = 16;

export type LogLayout = 'grouped' | 'timeline';

let _slot: string | undefined;
const keyFor = (base: string): string => (_slot ? `${base}.${_slot}` : base);

let _loaded = false;
let _dismissed: string[] = [];
let _dismissedSet = new Set<string>();
let _layout: LogLayout = 'grouped';

/** Load persisted state into memory once. Safe to await repeatedly. */
export async function ensureLogPagePrefsLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const [rawDismissed, rawLayout] = await Promise.all([
      AsyncStorage.getItem(keyFor(DISMISSED_KEY)),
      AsyncStorage.getItem(keyFor(LAYOUT_KEY)),
    ]);
    if (rawDismissed) {
      const parsed: unknown = JSON.parse(rawDismissed);
      if (Array.isArray(parsed)) {
        _dismissed = parsed.filter((v): v is string => typeof v === 'string').slice(-MAX_DISMISSED);
        _dismissedSet = new Set(_dismissed);
      }
    }
    if (rawLayout === 'timeline' || rawLayout === 'grouped') _layout = rawLayout;
  } catch {
    /* fresh state is fine */
  }
}

/** Switch the active account slot; drops the in-memory mirror so the next access reloads. */
export function setLogPagePrefsSlot(slotId: string | undefined): void {
  if (slotId === _slot) return;
  _slot = slotId;
  _loaded = false;
  _dismissed = [];
  _dismissedSet = new Set();
  _layout = 'grouped';
}

async function persistDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(DISMISSED_KEY), JSON.stringify(_dismissed));
  } catch {
    /* best effort — the in-memory mirror already updated */
  }
}

/** Whether the note with this version is tucked away. Synchronous — call after load. */
export function isNoteDismissed(version: string): boolean {
  return _dismissedSet.has(version);
}

/** Tuck away: persist the dismissal for this note version. Idempotent. */
export async function dismissNote(version: string): Promise<void> {
  await ensureLogPagePrefsLoaded();
  if (_dismissedSet.has(version)) return;
  _dismissedSet.add(version);
  _dismissed.push(version);
  if (_dismissed.length > MAX_DISMISSED) {
    const dropped = _dismissed.splice(0, _dismissed.length - MAX_DISMISSED);
    for (const d of dropped) _dismissedSet.delete(d);
  }
  await persistDismissed();
}

/** Reopen: CLEAR the stored dismissal (an explicit opt-back-in, not a session toggle). */
export async function undismissNote(version: string): Promise<void> {
  await ensureLogPagePrefsLoaded();
  if (!_dismissedSet.has(version)) return;
  _dismissedSet.delete(version);
  _dismissed = _dismissed.filter(v => v !== version);
  await persistDismissed();
}

/** The persisted mod-log layout preference (STATES §9: a member UI pref, not organizer config). */
export function logLayoutPref(): LogLayout {
  return _layout;
}

export async function setLogLayoutPref(layout: LogLayout): Promise<void> {
  await ensureLogPagePrefsLoaded();
  if (layout === _layout) return;
  _layout = layout;
  try {
    await AsyncStorage.setItem(keyFor(LAYOUT_KEY), layout);
  } catch {
    /* best effort */
  }
}
