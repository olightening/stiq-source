/**
 * Last-working-bridge cache (PLAN.md — shorten Tor connection time).
 *
 * Persists the exact transport + bridge set that last bootstrapped successfully, so the next
 * launch can reconnect straight away instead of running the ~40s moat → CDN77 → GitHub fetch
 * cascade. Only sets that actually reached `connected` are saved; a warm attempt that fails
 * drops the cache so we never loop on dead bridges.
 *
 * Bridge lines are public addresses (not secrets), but we reuse the Keystore-backed secure
 * store because it's the app's persistent KV — nothing here needs AsyncStorage. The cache is
 * wiped on a duress reset along with the rest of secure storage.
 */
import type {SecureStorage} from '../keys/keystore';
import type {TransportType} from './types';
// NetworkClass is defined once in daemonControl.ts (the native binding, T2-S2); import it here so
// the per-class cache and its callers share the single canonical union — no drift between files.
import type {NetworkClass} from './daemonControl';

const CACHE_ITEM = 'stiq.tor.bridges';
/** Ignore caches older than this — rotated bridges go stale, and warm-fail→cold recovers. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Sustainable fetched-bridge cache (separate from the last-working cache above).
 *
 * `saveCachedBridges` only records the ONE set that actually bootstrapped. But fetching fresh
 * bridges (moat → CDN77 → GitHub) is the fragile, network-dependent step — and WebTunnel bridges
 * in particular come ONLY from moat, which is often blocked on the very networks that need them.
 * So we also persist every freshly-fetched set per transport, with a shorter refresh TTL: a later
 * launch where moat is blocked can still reuse the WebTunnel/obfs4 bridges we fetched earlier
 * instead of being forced straight down to the bundled obfs4 pool. Refreshed opportunistically
 * once the TTL lapses.
 */
const FETCHED_PREFIX = 'stiq.tor.fetched.';
const FETCHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface FetchedEntry {
  bridgeLines: string[];
  savedAt: number;
}

/** Cached freshly-fetched bridges for a transport, or null if absent/expired/corrupt. */
export async function loadFetchedBridges(
  storage: SecureStorage,
  transport: TransportType,
): Promise<string[] | null> {
  try {
    const raw = await storage.getItem(FETCHED_PREFIX + transport);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<FetchedEntry>;
    if (
      !parsed ||
      !Array.isArray(parsed.bridgeLines) ||
      parsed.bridgeLines.length === 0 ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > FETCHED_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed.bridgeLines;
  } catch {
    return null;
  }
}

/** Persist a freshly-fetched bridge set for a transport. Best-effort; ignores empty sets. */
export async function saveFetchedBridges(
  storage: SecureStorage,
  transport: TransportType,
  bridgeLines: string[],
): Promise<void> {
  if (bridgeLines.length === 0) {
    return;
  }
  try {
    const payload: FetchedEntry = {bridgeLines, savedAt: Date.now()};
    await storage.setItem(FETCHED_PREFIX + transport, JSON.stringify(payload));
  } catch {
    // best effort
  }
}

export interface CachedBridges {
  transport: TransportType;
  bridgeLines: string[];
  savedAt: number;
}

/** The last bridge set that bootstrapped, or null when absent/expired/corrupt. */
export async function loadCachedBridges(
  storage: SecureStorage,
): Promise<CachedBridges | null> {
  try {
    const raw = await storage.getItem(CACHE_ITEM);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedBridges>;
    if (
      !parsed ||
      typeof parsed.transport !== 'string' ||
      !Array.isArray(parsed.bridgeLines) ||
      // 'direct' is a valid cached mode with no bridges; every other transport needs ≥1.
      (parsed.transport !== 'direct' && parsed.bridgeLines.length === 0) ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      return null;
    }
    return {
      transport: parsed.transport as TransportType,
      bridgeLines: parsed.bridgeLines,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a transport + bridge set known to have bootstrapped. Best-effort. */
export async function saveCachedBridges(
  storage: SecureStorage,
  transport: TransportType,
  bridgeLines: string[],
): Promise<void> {
  // 'direct' has no bridges but is still worth caching as the preferred fast path.
  if (bridgeLines.length === 0 && transport !== 'direct') {
    return;
  }
  try {
    const payload: CachedBridges = {transport, bridgeLines, savedAt: Date.now()};
    await storage.setItem(CACHE_ITEM, JSON.stringify(payload));
  } catch {
    // best effort
  }
}

/** Drop the cache (e.g. when the cached bridges fail to connect). Best-effort. */
export async function clearCachedBridges(storage: SecureStorage): Promise<void> {
  try {
    await storage.removeItem(CACHE_ITEM);
  } catch {
    // best effort
  }
}

/**
 * Per-network-CLASS last-working cache (T2 — guided auto-fallback ladder, per-network memory).
 *
 * The single global {@link CachedBridges} above remembers the ONE transport + bridge set that last
 * bootstrapped, regardless of network. But the transport that works on home Wi-Fi is often NOT the
 * one that works on a censored cellular carrier, so a single global cache thrashes as the user moves
 * between networks. These entries remember the last-working set keyed by a COARSE, privacy-safe
 * network class (wifi/cellular/ethernet/vpn/other — never SSID/BSSID/location), so a relaunch on a
 * known class warm-starts the transport that actually worked there. Same {@link CachedBridges} shape
 * and {@link MAX_AGE_MS} staleness rule as the global cache.
 *
 * Keys live UNDER the `stiq.tor.bridges` namespace (`stiq.tor.bridges.net.<class>`) so the whole
 * per-class layer is wiped together with the global cache on a duress / identity reset — see
 * {@link clearAllNetworkClassBridges} for the wiring contract.
 */
const NETCLASS_ITEM_PREFIX = 'stiq.tor.bridges.net.';

// Re-export the canonical NetworkClass (sourced from ./daemonControl above) so existing importers of
// `bridgeCache`'s NetworkClass keep working while there is a single definition.
export type {NetworkClass};

/**
 * The classes we are willing to PERSIST. 'unknown' is deliberately excluded — a device that can't
 * classify its network must never poison a shared bucket (and 'unknown' is what every non-Android /
 * jest build returns). This is also the exhaustive list {@link clearAllNetworkClassBridges} iterates,
 * since SecureStorage has no key enumeration to sweep the `stiq.tor.bridges.net.` prefix.
 */
const PERSISTABLE_NETWORK_CLASSES: readonly NetworkClass[] = [
  'wifi',
  'cellular',
  'ethernet',
  'vpn',
  'other',
];

/** The storage key for a network class's last-working cache. */
export function netClassCacheKey(netClass: NetworkClass): string {
  return NETCLASS_ITEM_PREFIX + netClass;
}

/**
 * The last bridge set that bootstrapped on this network CLASS, or null when absent/expired/corrupt.
 * Enforces the SAME {@link MAX_AGE_MS} staleness window as {@link loadCachedBridges}. Does NOT fall
 * back to the legacy global key — the App.tsx caller (T2-S4) does that fallback explicitly so the
 * precedence (per-class first, then global) is visible at the call site.
 */
export async function loadCachedBridgesForClass(
  storage: SecureStorage,
  netClass: NetworkClass,
): Promise<CachedBridges | null> {
  try {
    const raw = await storage.getItem(netClassCacheKey(netClass));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedBridges>;
    if (
      !parsed ||
      typeof parsed.transport !== 'string' ||
      !Array.isArray(parsed.bridgeLines) ||
      // 'direct' is a valid cached mode with no bridges; every other transport needs ≥1.
      (parsed.transport !== 'direct' && parsed.bridgeLines.length === 0) ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      return null;
    }
    return {
      transport: parsed.transport as TransportType,
      bridgeLines: parsed.bridgeLines,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a transport + bridge set known to have bootstrapped on this network CLASS. Best-effort.
 * Refuses netClass==='unknown' (returns early) so a device that can't classify its network never
 * poisons a shared bucket. Mirrors {@link saveCachedBridges}: 'direct' may cache with no bridges.
 */
export async function saveCachedBridgesForClass(
  storage: SecureStorage,
  netClass: NetworkClass,
  transport: TransportType,
  lines: string[],
): Promise<void> {
  // A device that can't classify its network never persists — see PERSISTABLE_NETWORK_CLASSES.
  if (netClass === 'unknown') {
    return;
  }
  // 'direct' has no bridges but is still worth caching as the preferred fast path.
  if (lines.length === 0 && transport !== 'direct') {
    return;
  }
  try {
    const payload: CachedBridges = {transport, bridgeLines: lines, savedAt: Date.now()};
    await storage.setItem(netClassCacheKey(netClass), JSON.stringify(payload));
  } catch {
    // best effort
  }
}

/** Drop ONE network class's cache (e.g. when its cached bridges fail to connect). Best-effort. */
export async function clearCachedBridgesForClass(
  storage: SecureStorage,
  netClass: NetworkClass,
): Promise<void> {
  try {
    await storage.removeItem(netClassCacheKey(netClass));
  } catch {
    // best effort
  }
}

/**
 * Drop EVERY per-network-class cache — the duress / identity-reset hook for the per-class layer.
 * SecureStorage exposes no key enumeration, so we remove each persistable class key explicitly.
 *
 * DURESS-WIPE WIRING (T2-S3): the identity-reset path that clears the global cache —
 * `AppRuntime.duressWipeTargets().extra()`, shared by the duress PIN and the Settings emergency
 * `wipeAllData()` — must call this alongside {@link clearCachedBridges}(storage) so a reset wipes the
 * global last-working cache AND every per-class entry together (the module docstring's "wiped on a
 * duress reset" promise). Ship-dark: nothing WRITES per-class entries until the T2-S4 guided walker
 * lands, so there is nothing to strand until then; this function is exposed now so the wipe path can
 * adopt it in that same subtask without editing bridgeCache.ts again.
 */
export async function clearAllNetworkClassBridges(storage: SecureStorage): Promise<void> {
  for (const netClass of PERSISTABLE_NETWORK_CLASSES) {
    await clearCachedBridgesForClass(storage, netClass);
  }
}
