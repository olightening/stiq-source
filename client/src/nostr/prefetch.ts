/**
 * Priority-content prefetch for the low-bandwidth degraded sync mode (T10-S6).
 *
 * PURE orchestration over two EXISTING RelayClient fetch methods — it opens no new transport, holds
 * no state, and imports nothing from the app (only the ReqFilter TYPE, so it stays a leaf and can't
 * form an import cycle). When a metered / slow circuit is likely (SYNC_LOW_BANDWIDTH), the caller runs
 * this AHEAD of the general feed reconcile so the two things a member most wants on first glance — the
 * active space's PINNED message and the ORGANIZER's most recent announcements — land first, before the
 * bulk feed (and its media) trickles in.
 *
 * NEW and currently UNUSED (App.tsx wiring is a later subtask); kept a pure importable helper so the
 * wiring is a separate step. Defensive: it no-ops for absent targets and NEVER throws if a relay method
 * is missing (so a bare RelayClient shape — e.g. the background sync task's client — can't crash on it).
 */
import type {ReqFilter} from './protocol';

/**
 * The minimal RelayClient surface {@link prefetchPriorityContent} drives, expressed structurally so
 * this module never imports the concrete RelayClient (no cycle). Both methods are the real chunked,
 * de-duped RelayClient.fetchById / fetchByFilter, safe to call eagerly.
 */
export interface PrefetchRelay {
  fetchById(ids: string[]): void;
  fetchByFilter(filters: ReqFilter[]): void;
}

/** What to pull ahead of the general reconcile. All fields optional; absent = skip that pull. */
export interface PriorityContentTargets {
  /** The active space's pinned message id (SpaceSettings.pinnedMessageId). */
  pinnedMessageId?: string;
  /** The organizer's Nostr pubkey — pull their most recent authored posts (announcements). */
  organizerPubkey?: string;
  /** Kind of organizer post to fetch (default {@link DEFAULT_ORGANIZER_POST_KIND} = Post/1). */
  postKind?: number;
  /** Max organizer posts to pull (default {@link DEFAULT_ORGANIZER_POST_LIMIT} = 10). */
  limit?: number;
}

const DEFAULT_ORGANIZER_POST_KIND = 1;
const DEFAULT_ORGANIZER_POST_LIMIT = 10;

/**
 * Issue the priority pulls: `fetchById` for the pinned message, `fetchByFilter` for the organizer's
 * most recent posts. No-ops when both targets are absent. Never throws — each pull is guarded so a
 * partial relay shape (missing fetchById/fetchByFilter) simply skips that pull, and any pull that does
 * fail is harmlessly re-covered by the general reconcile that follows.
 *
 * `relay` is typed as a Partial so a structurally-incomplete client is a compile-time-legal, run-time-safe
 * argument (the defensive acceptance criterion).
 */
export function prefetchPriorityContent(
  relay: Partial<PrefetchRelay>,
  targets: PriorityContentTargets,
): void {
  if (targets.pinnedMessageId && typeof relay.fetchById === 'function') {
    try {
      relay.fetchById([targets.pinnedMessageId]);
    } catch {
      /* best-effort prefetch — the general reconcile still covers this id */
    }
  }
  if (targets.organizerPubkey && typeof relay.fetchByFilter === 'function') {
    const filter: ReqFilter = {
      authors: [targets.organizerPubkey],
      kinds: [targets.postKind ?? DEFAULT_ORGANIZER_POST_KIND],
      limit: targets.limit ?? DEFAULT_ORGANIZER_POST_LIMIT,
    };
    try {
      relay.fetchByFilter([filter]);
    } catch {
      /* best-effort prefetch — the general reconcile still covers these posts */
    }
  }
}
