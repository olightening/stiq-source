/**
 * On-device sync diagnostics ring buffer (T10-S3). Captures the {@link ReconcileStats} emitted by
 * RelayClient's optional `onReconciled` callback so a LOCAL debug screen can show recent
 * reconciliation round counts / wall time / delta sizes.
 *
 * SHIP-DARK / on-device only: nothing here is EVER published to the relay — it is a purely local
 * diagnostic surface. The relay stays author/content-blind; no telemetry leaves the device. App.tsx's
 * `onReconciled` handler is the only writer (it calls {@link recordSyncStat}); the SyncDebugScreen is
 * the only reader (via {@link getSyncStats} / {@link subscribeSyncStats}).
 *
 * A LEAF module: it imports only the ReconcileStats TYPE from RelayClient, so any consumer can depend
 * on it without an import cycle.
 */
import type {ReconcileStats} from './RelayClient';

/** A recorded reconciliation stat. Structurally identical to {@link ReconcileStats}. */
export interface SyncStatEntry extends ReconcileStats {}

/** Max entries retained; the oldest is evicted (shift) once the ring is full. */
const RING_MAX = 50;

/** Newest-last ring of recorded stats. */
const ring: ReconcileStats[] = [];
/** Change subscribers (e.g. the debug screen re-rendering on each record/clear). */
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb();
    } catch {
      /* a throwing subscriber must not break recording or the other subscribers */
    }
  }
}

/**
 * Record one reconciliation stat (newest-last), evicting the oldest when the ring is full, then
 * notify subscribers. Called by App.tsx's onReconciled handler.
 */
export function recordSyncStat(stat: ReconcileStats): void {
  ring.push(stat);
  if (ring.length > RING_MAX) {
    ring.shift(); // drop the oldest — a bounded ring never grows without limit
  }
  notify();
}

/** A frozen snapshot of the recorded stats, oldest-first / newest-last. Immutable to callers. */
export function getSyncStats(): readonly ReconcileStats[] {
  return Object.freeze(ring.slice());
}

/** Subscribe to record/clear notifications; returns an unsubscribe function. */
export function subscribeSyncStats(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Empty the ring buffer and notify subscribers (e.g. the debug screen's Clear action). */
export function clearSyncStats(): void {
  ring.length = 0;
  notify();
}
