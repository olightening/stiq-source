/**
 * Durable feed-state snapshot (T16-S3) — a tiny per-community blob that lets aggressive compaction
 * (COMPACTION_V2) run without ever blanking the cold-boot feed or forcing a big historical re-fetch
 * over Tor.
 *
 * The problem it defends: compaction v2 adds an age-expiry pass that CAN clear a low-volume kind's
 * only cached rows. The count-cap prune never lowers a kind's high-water (it keeps the newest N), but
 * age-expiry could, and the subscription planner derives its incremental `since` from the store's
 * high-water — so a compaction that empties a kind would drop `since` back to the cold horizon and
 * re-stream a large window over Tor. This snapshot records, BEFORE compaction can shrink them, the
 * per-kind high-water marks (plus the newest post ids) so the planner can FLOOR `since` at the
 * snapshot even after the rows are gone, and a cold boot can seed the first REQ/negentropy window.
 *
 * SHIP-DARK: nothing writes a snapshot unless COMPACTION_V2 is on and a real compaction happened —
 * SqliteEventStore fires its compaction observer (setCompactionObserver) only then — so with the flag
 * off this module is entirely inert. The store stays storage-agnostic: it never imports SecureStorage;
 * the App wiring calls {@link buildFeedSnapshot} + {@link saveFeedSnapshot} inside that observer.
 *
 * PERSISTENCE: mirrors bridgeCache.ts — best-effort reads/writes against the Keystore-backed secure
 * store, never throwing, tolerant of a corrupt/absent blob (yields null). Per-community namespaced
 * (like eventsCacheKey) so switching communities never mixes snapshots.
 *
 * DURESS-WIPE (wiring note for the integrator): the snapshot is per-community relay-PUBLIC metadata
 * (high-water ints + public event ids — no plaintext, no secret), but it should still be enumerated by
 * the identity-reset / duress wipe alongside the per-community event cache, exactly like the bridge
 * cache. SecureStorage exposes no key enumeration, so the wipe path (AppRuntime duress targets +
 * removeCommunity) must call {@link clearFeedSnapshot}(storage, cid) per community — the same pattern
 * clearAllNetworkClassBridges uses. NOTE: the key name lives here (self-contained) rather than in
 * app/workspaceKeys.ts; if that file later grows a `feedSnapshotKey`/`LEGACY_FEED_SNAPSHOT`, re-export
 * from there so the per-community namespace has one home. Exposed now so the wipe path can adopt it
 * without editing this module again.
 */
import type {EventStore} from './store';
import type {SecureStorage} from '../keys/keystore';
import {Kind} from './events';

/** Persisted feed-state snapshot: per-kind high-water + the newest post ids at snapshot time. */
export interface FeedSnapshot {
  /** Date.now() when the snapshot was taken (staleness / debugging). */
  savedAt: number;
  /** kind → newest cached created_at (unix seconds) at snapshot time. */
  highWater: Record<number, number>;
  /** Newest kind-1 post ids (newest first), capped at the build limit. */
  postIds: string[];
}

/** Default number of newest post ids retained in a snapshot. */
const DEFAULT_SNAPSHOT_LIMIT = 200;

/** Secure-storage key holding the (community, account) feed snapshot (mirrors eventsCacheKey's
 *  per-(cid, slot) namespacing, finding #4 — the snapshot mirrors that account's store high-water, so
 *  applying account A's floor to account B's fresh store would make B under-fetch). `slotId` optional
 *  so the pre-per-account per-cid key still resolves. */
export const feedSnapshotKey = (cid: string, slotId?: string): string =>
  slotId ? `stiq.feed.snapshot.${cid}.${slotId}` : `stiq.feed.snapshot.${cid}`;
/** Pre-silo / un-enrolled global snapshot key (cid omitted). */
export const LEGACY_FEED_SNAPSHOT = 'stiq.feed.snapshot';

const snapshotItemFor = (cid?: string, slotId?: string): string =>
  cid ? feedSnapshotKey(cid, slotId) : LEGACY_FEED_SNAPSHOT;

/**
 * Build a feed snapshot from the store's CURRENT contents. Pure and deterministic (no I/O; the only
 * non-determinism is `savedAt`): records max(created_at) per feed kind into `highWater` (kinds with no
 * cached rows are omitted), and the newest `limit` kind-1 post ids into `postIds` (newest first, via
 * the store's created_at DESC ordering).
 */
export function buildFeedSnapshot(
  store: EventStore,
  feedKinds: number[],
  limit: number = DEFAULT_SNAPSHOT_LIMIT,
): FeedSnapshot {
  const highWater: Record<number, number> = {};
  for (const kind of feedKinds) {
    const hw = store.latestCreatedAt([kind]);
    if (hw !== undefined) highWater[kind] = hw;
  }
  const cap = Math.max(0, Math.trunc(limit));
  const postIds = store.query({kinds: [Kind.Post], limit: cap}).map(e => e.id);
  return {savedAt: Date.now(), highWater, postIds};
}

/** Persist `snap` for the (community, account) pair (omit `cid` for the global blob). Best-effort;
 *  never throws. */
export async function saveFeedSnapshot(
  storage: SecureStorage,
  cid: string | undefined,
  snap: FeedSnapshot,
  slotId?: string,
): Promise<void> {
  try {
    await storage.setItem(snapshotItemFor(cid, slotId), JSON.stringify(snap));
  } catch {
    // best effort — the snapshot is a pure optimization; a lost write only costs a re-fetch
  }
}

/** Load the (community, account) snapshot, or null when absent / corrupt / malformed. Never throws. */
export async function loadFeedSnapshot(
  storage: SecureStorage,
  cid?: string,
  slotId?: string,
): Promise<FeedSnapshot | null> {
  try {
    const raw = await storage.getItem(snapshotItemFor(cid, slotId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FeedSnapshot> | null;
    if (
      !parsed ||
      typeof parsed.savedAt !== 'number' ||
      !parsed.highWater ||
      typeof parsed.highWater !== 'object' ||
      !Array.isArray(parsed.postIds)
    ) {
      return null;
    }
    // Defensive re-validation so a tampered blob can't inject junk downstream (JSON object keys are
    // strings — coerce each back to a numeric kind and keep only finite number values).
    const highWater: Record<number, number> = {};
    for (const [k, v] of Object.entries(parsed.highWater)) {
      const kind = Number(k);
      if (Number.isFinite(kind) && typeof v === 'number' && Number.isFinite(v)) {
        highWater[kind] = v;
      }
    }
    const postIds = parsed.postIds.filter((id): id is string => typeof id === 'string');
    return {savedAt: parsed.savedAt, highWater, postIds};
  } catch {
    return null;
  }
}

/**
 * Drop the (community, account) snapshot — the duress / identity-reset hook (see the module doc's
 * DURESS-WIPE note). Omitting `slotId` drops the pre-per-account per-cid snapshot. Best-effort;
 * never throws.
 */
export async function clearFeedSnapshot(
  storage: SecureStorage,
  cid?: string,
  slotId?: string,
): Promise<void> {
  try {
    await storage.removeItem(snapshotItemFor(cid, slotId));
  } catch {
    // best effort
  }
}
