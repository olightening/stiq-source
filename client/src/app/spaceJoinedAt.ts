/**
 * Per-account "when did I join this space" stamps — a purely local UI signal, never published.
 *
 * The Spaces list sorts by newest cached message; a space you just joined has NO cached history
 * (it streams in over Tor after the subscribe), so without this it sorted at the 0 floor, dead
 * last under every DM and space — which read as "Sub did nothing". Recording the join moment lets
 * the row surface at the top immediately and decay naturally as it ages.
 *
 * Same contract as {@link feedSortPrefs} / {@link communityEntry}: in-memory mirror loaded once
 * (AppRuntime.loadWorkspaceState eagerly loads it on init AND every account switch, before the
 * splash lifts), synchronous reads, best-effort async writes, keyed per identity slot.
 *
 * NEVER put this on the wire: publishing join timing would leak subscription behaviour to the relay.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'stiq.space.joinedAt';
/** Bound the map so a heavy joiner can't grow this key without limit; oldest stamps evict first. */
const MAX_ENTRIES = 200;

let _slot: string | undefined;
let _loaded = false;
let _map: Record<string, number> = {};

const keyFor = (): string => (_slot ? `${KEY}.${_slot}` : KEY);

/** Switch the active account slot; drops the mirror so the next access reloads. */
export function setSpaceJoinedAtSlot(slotId: string | undefined): void {
  if (slotId === _slot) return;
  _slot = slotId;
  _loaded = false;
  _map = {};
}

/** Load persisted stamps into memory once. Safe to await repeatedly. */
export async function ensureSpaceJoinedAtLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  const slotAtRead = _slot;
  try {
    const raw = await AsyncStorage.getItem(keyFor());
    if (slotAtRead !== _slot) return; // slot switched mid-read — this load is stale
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return;
    const disk: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) disk[id] = at;
    }
    // A mark recorded WHILE this read was in flight wins — a hydration must never clobber the
    // stamp of a space the member just joined.
    _map = {...disk, ..._map};
  } catch {
    /* fresh state is fine */
  }
}

/** Unix seconds when this account joined `spaceId`; 0 = no record. Synchronous — call after load. */
export function joinedAt(spaceId: string): number {
  return _map[spaceId] ?? 0;
}

/**
 * Stamp the join moment. The mirror moves SYNCHRONOUSLY — the emit that follows a subscribe renders
 * in the same tick and must already see it; the disk write is fire-and-forget.
 *
 * A genuine re-join re-stamps (it IS new to the member again). Call sites are already guarded to
 * fire only on a real (re)join.
 */
export function markJoined(spaceId: string, nowSec: number): void {
  if (!spaceId || !(nowSec > 0)) return;
  _map[spaceId] = nowSec;
  const ids = Object.keys(_map);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => (_map[a] ?? 0) - (_map[b] ?? 0));
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete _map[id];
  }
  AsyncStorage.setItem(keyFor(), JSON.stringify(_map)).catch(() => {
    /* best effort — the in-memory mirror already updated */
  });
}
