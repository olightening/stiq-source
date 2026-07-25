/**
 * Per-community sync watermark (T10 — tune NIP-77 negentropy for Tor RTTs).
 *
 * Records how far a community's feed has been reconciled ("reconciledThrough", a unix-seconds
 * timestamp) so a routine refresh can reconcile only a recent window instead of re-fingerprinting
 * the full cold horizon on every open. Persisted per community id (cid) under the
 * `stiq.sync.watermark.<cid>` key, following the SecureStorage KV pattern in tor/bridgeCache.ts
 * (JSON blob, best-effort try/catch, wiped on a duress reset along with the rest of secure storage).
 *
 * The persisted store is async, but subscriptionPlan.buildReconcileFilter is SYNCHRONOUS (it runs
 * inside RelayClient.onOpen and cannot await SecureStorage). So — exactly like tor/torSettings.ts
 * mirrors its prefs into a live module-level accessor — this module keeps a synchronous runtime
 * mirror (`runtimeWatermarks`) that the plan reads without awaiting; the async store is the durable
 * backing that seeds/persists it.
 *
 * The watermark is MONOTONIC: saveWatermark only ever advances it, so an out-of-order or stale
 * reconciliation round can never move it backward (which would silently re-widen the sync window).
 *
 * NOTE (later integration subtask): both the persisted store (clearWatermark) and the runtime mirror
 * (clearWatermarkRuntime) should be enrolled in the duress-wipe / identity-reset / community-removal
 * paths so a wiped identity leaves no sync-progress residue. That wiring is intentionally NOT done
 * here — this module only makes the clear primitives available for that integration to call.
 */
import type {SecureStorage} from '../keys/keystore';

/** Namespace prefix for the per-community watermark key (one entry per cid). */
const WATERMARK_PREFIX = 'stiq.sync.watermark.';

/** Persisted per-community watermark. `reconciledThrough` is unix-seconds; `savedAt` is ms. */
interface WatermarkRecord {
  reconciledThrough: number;
  savedAt: number;
}

/**
 * The persisted reconcile watermark (unix-seconds) for a community, or null when absent/corrupt.
 * Best-effort: any storage error or malformed blob resolves to null (treated as "no watermark").
 */
export async function loadWatermark(
  storage: SecureStorage,
  cid: string,
): Promise<number | null> {
  try {
    const raw = await storage.getItem(WATERMARK_PREFIX + cid);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<WatermarkRecord>;
    if (
      !parsed ||
      typeof parsed.reconciledThrough !== 'number' ||
      !Number.isFinite(parsed.reconciledThrough)
    ) {
      return null;
    }
    return parsed.reconciledThrough;
  } catch {
    return null;
  }
}

/**
 * Advance the persisted watermark for a community. MONOTONIC — persists only when
 * `reconciledThrough` is strictly greater than the stored value (or none is stored yet), so an
 * out-of-order round can never lower it. Best-effort; storage errors are swallowed.
 */
export async function saveWatermark(
  storage: SecureStorage,
  cid: string,
  reconciledThrough: number,
): Promise<void> {
  try {
    const existing = await loadWatermark(storage, cid);
    if (existing !== null && reconciledThrough <= existing) {
      return; // never lower the watermark
    }
    const payload: WatermarkRecord = {reconciledThrough, savedAt: Date.now()};
    await storage.setItem(WATERMARK_PREFIX + cid, JSON.stringify(payload));
  } catch {
    // best effort
  }
}

/** Drop a community's persisted watermark (duress reset / community removal). Best-effort. */
export async function clearWatermark(storage: SecureStorage, cid: string): Promise<void> {
  try {
    await storage.removeItem(WATERMARK_PREFIX + cid);
  } catch {
    // best effort
  }
}

/**
 * Synchronous runtime mirror of the watermarks, keyed by cid. Exists because buildReconcileFilter
 * is synchronous and cannot await SecureStorage (same reason torSettings.ts mirrors prefs into a
 * live accessor). Seeded from loadWatermark and advanced by setWatermarkRuntime as rounds complete.
 */
const runtimeWatermarks = new Map<string, number>();

/** Store the runtime watermark for a community, keeping the MAX seen (never lowers). */
export function setWatermarkRuntime(cid: string, reconciledThrough: number): void {
  const existing = runtimeWatermarks.get(cid);
  if (existing === undefined || reconciledThrough > existing) {
    runtimeWatermarks.set(cid, reconciledThrough);
  }
}

/** The runtime watermark for a community, or undefined when none is mirrored yet. */
export function getWatermarkRuntime(cid: string): number | undefined {
  return runtimeWatermarks.get(cid);
}

/** Clear one community's runtime watermark, or ALL of them when called with no cid. */
export function clearWatermarkRuntime(cid?: string): void {
  if (cid === undefined) {
    runtimeWatermarks.clear();
  } else {
    runtimeWatermarks.delete(cid);
  }
}
