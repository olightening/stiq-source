/**
 * Outbox — delivery tracking for optimistic writes (PLAN.md §3.5, optimistic design).
 *
 * The app saves a signed event to the local cache and re-renders BEFORE the relay confirms
 * it (true optimistic UI). The Outbox tracks which of those events are still unacknowledged
 * so the UI can show a "sending…/failed" marker, and so they can be retried when Tor
 * reconnects. It mirrors the persist-then-retry pattern already used for the binding event
 * (onboarding/pendingBind.ts), but generalized to any event and keyed by id.
 *
 * Persistence is optional: with a SecureStorage the queue survives a crash/restart; without
 * one (e.g. unit tests, pre-native builds) it is purely in-memory. The queue is wiped by the
 * duress wipe along with the rest of secure storage.
 */
import type {Event} from 'nostr-tools/pure';
import type {SecureStorage} from '../keys/keystore';
import {LEGACY_OUTBOX, outboxKey} from '../app/workspaceKeys';

/**
 * Delivery lifecycle for an optimistic write, surfaced as a progress ring:
 *  - 'sending'   the event is signed and in flight to the relay over Tor (ring ~2/5)
 *  - 'accepted'  the relay returned OK (ring ~4/5)
 *  - 'confirmed' the event was echoed back to us via subscription — fully delivered (ring 5/5)
 *  - 'failed'    the publish timed out or threw with no relay answer — ambiguous (red; retry/cancel)
 *  - 'rejected'  the relay returned an OK frame with accepted=false — a genuine per-event
 *                rejection carrying a human reason (red; retry/cancel). TERMINAL: unlike 'failed'
 *                it is NOT auto-resent on reconnect, because re-sending the same signed event with
 *                its now-stale blind token only earns the same rejection and wastes Tor bandwidth.
 *
 * Confirmed entries are removed shortly after (the ring fills then disappears). Everything except
 * 'confirmed' and the terminal 'rejected' is retried when Tor reconnects; both terminal states are
 * kept so the optimistic local copy stays visible with its failed/Retry/Cancel controls.
 */
export type SendStatus = 'sending' | 'accepted' | 'confirmed' | 'failed' | 'rejected';

interface OutboxEntry {
  event: Event;
  status: SendStatus;
  /** Relay's rejection reason (only set alongside status 'rejected'), surfaced next to "failed". */
  reason?: string;
  /**
   * Only meaningful while status is 'sending': true when this entry is queued because the relay
   * isn't connected yet (deliver()'s `result.offline` branch — Tor still building the circuit, or
   * the socket dropped), as opposed to actively in flight over an open publish() call. Render-only
   * distinction (M7 — legible sync): "Queued — connecting…" vs "Sending…". Never changes retry/resend
   * behavior — unsent()/deliver() are untouched.
   */
  offline?: boolean;
  /**
   * Ids of OTHER outbox events that must land at the relay before this one may be sent — today, the
   * media blobs a post's body references (AppRuntime.signPendingWrite / feed/mediaBlob.ts).
   *
   * A two-event write can half-land, and one direction is unfixable after the fact: a post that
   * ships while its blob does not is a permanently broken picture for every reader. Ordering the
   * SIGN step (blob first, so a body can never reference a blob that failed to sign) closes only
   * half of it — DELIVERY is a separate, later, retrying concern, and the relay can accept the post
   * while the blob's own Tor round-trip is still failing. Recording the dependency HERE, on the
   * queue entry, is what makes the order durable: the outbox is already persisted per-account and
   * reloaded on restart/switch, so a crash mid-publish rehydrates the blobs, the post, AND the fact
   * that one waits on the others — with no parallel bookkeeping to drift out of sync.
   *
   * Read by AppRuntime.deliver()'s gate. Absent on every other write (and on any entry persisted
   * before this field existed), which is exactly "no dependencies — send immediately", so nothing
   * else in the outbox changes behaviour.
   */
  dependsOn?: string[];
}

export class Outbox {
  private entries = new Map<string, OutboxEntry>();
  /** Storage key — per ACCOUNT (identity slot): the queued events are signed by this slot's npub, so
   *  a sibling account in the same community must never adopt and republish them. */
  private key: string;

  /**
   * Monotonic mutation counter — bumped every time `entries` actually changes (add / a real status
   * or reason or offline-flag change / remove / reload / load). statuses()/reasons()/
   * queuedOfflineIds() cache their built Map/Set against this counter so back-to-back calls with no
   * intervening mutation return the SAME object identity — otherwise every call (including from
   * emits unrelated to the outbox) allocated a fresh Map/Set, which defeated `React.memo` on every
   * mounted feed cell (P2-2 / C2: AppRuntime.sendStatusSnapshot + FeedList's renderItem both depend
   * on these snapshots).
   */
  private mutationVersion = 0;
  private statusesCache: {version: number; value: Map<string, SendStatus>} | null = null;
  private reasonsCache: {version: number; value: Map<string, string>} | null = null;
  private queuedOfflineCache: {version: number; value: ReadonlySet<string>} | null = null;

  constructor(private readonly storage: SecureStorage | null = null, slotId?: string) {
    this.key = slotId ? outboxKey(slotId) : LEGACY_OUTBOX;
  }

  /** Current mutation counter — lets a caller (AppRuntime.sendStatusSnapshot) cache its own derived
   *  snapshot alongside this one and skip a rebuild when neither has changed. */
  version(): number {
    return this.mutationVersion;
  }

  /**
   * Re-point at a different account (identity slot) and reload its persisted queue (community/account
   * switch). The outbox is identity-scoped — a pending send was signed by one slot's npub — so
   * switching swaps the whole queue. In-memory entries are dropped before the new one loads.
   */
  async reload(slotId?: string): Promise<void> {
    this.entries = new Map();
    this.mutationVersion++;
    this.key = slotId ? outboxKey(slotId) : LEGACY_OUTBOX;
    await this.load();
  }

  /** Rehydrate unacknowledged events persisted before a crash/restart. */
  async load(): Promise<void> {
    if (!this.storage) {
      return;
    }
    try {
      const json = await this.storage.getItem(this.key);
      if (!json) {
        return;
      }
      const arr = JSON.parse(json) as OutboxEntry[];
      this.entries = new Map(arr.map(entry => [entry.event.id, entry]));
      this.mutationVersion++;
    } catch {
      // A missing, corrupt, or unreadable queue must never break startup — start clean. The
      // encrypted blob can fail to decrypt (e.g. a partial write), and getItem rejects then;
      // swallowing it here also keeps the rest of init() (display names, gradients, …) running.
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) {
      return;
    }
    await this.storage.setItem(this.key, JSON.stringify([...this.entries.values()]));
  }

  /** Record a freshly published event as in-flight (2/5). `offline` starts unset (falsy) — this is
   *  the original send, actively attempting the network, not a queued-offline re-send.
   *
   *  `dependsOn` names outbox events that must land BEFORE this one is sent (see
   *  {@link OutboxEntry.dependsOn}); omitted — the case for every write but a blob-carrying post —
   *  leaves the entry byte-identical to before this parameter existed. */
  async add(event: Event, dependsOn?: readonly string[]): Promise<void> {
    this.entries.set(event.id, {
      event,
      status: 'sending',
      ...(dependsOn && dependsOn.length > 0 ? {dependsOn: [...dependsOn]} : {}),
    });
    this.mutationVersion++;
    await this.persist();
  }

  /** The ids `id` must see land before it may be sent — empty for every ordinary write. */
  dependenciesOf(id: string): readonly string[] {
    return this.entries.get(id)?.dependsOn ?? [];
  }

  /** The still-queued events that are waiting on `id` to land (the inverse of {@link dependenciesOf}).
   *  Linear over the queue, which holds only unacknowledged writes — a handful at most. */
  dependentsOf(id: string): Event[] {
    const out: Event[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dependsOn?.includes(id)) out.push(entry.event);
    }
    return out;
  }

  private async setStatus(id: string, status: SendStatus): Promise<void> {
    const entry = this.entries.get(id);
    if (entry && entry.status !== status) {
      entry.status = status;
      this.mutationVersion++;
      await this.persist();
    }
  }

  /**
   * Re-queue an entry as still in flight. Used when a publish attempt finds the relay offline
   * (Tor not connected yet / connection dropped): the write isn't a failure, it's waiting for a
   * relay, so it keeps the quiet "sending" indicator and is retried on the next reconnect.
   *
   * `offline` records WHY it's still 'sending' — true when this call is deliver()'s offline branch
   * (queued, waiting for a relay), false/omitted for the initial in-flight send (add()'s implicit
   * 'sending'). Purely descriptive for the UI (queuedOfflineIds()); doesn't change status semantics
   * or retry behavior. setStatus()'s own no-op guard only checks `status`, so this sets both fields
   * directly to make sure a changed `offline` flag still persists even when status was already
   * 'sending'.
   */
  async markSending(id: string, offline = false): Promise<void> {
    const entry = this.entries.get(id);
    if (entry && (entry.status !== 'sending' || entry.offline !== offline)) {
      entry.status = 'sending';
      entry.offline = offline;
      this.mutationVersion++;
      await this.persist();
    }
  }

  /** Relay returned OK (4/5) — keep the entry until the event is echoed back to us. */
  async markAccepted(id: string): Promise<void> {
    await this.setStatus(id, 'accepted');
  }

  /** The event was echoed back via subscription (5/5) — fully delivered. */
  async markConfirmed(id: string): Promise<void> {
    await this.setStatus(id, 'confirmed');
  }

  /** Publish timed out / threw with no relay answer — ambiguous, keep for auto-retry on reconnect. */
  async markFailed(id: string): Promise<void> {
    await this.setStatus(id, 'failed');
  }

  /**
   * The relay returned an OK frame with accepted=false — a genuine per-event rejection. TERMINAL:
   * unsent() excludes it, so it is never auto-resent on reconnect (re-sending the same event with its
   * stale token just earns the same "no"). The entry is kept, with its reason, so the UI keeps showing
   * the optimistic copy with failed/Retry/Cancel; the reason is surfaced next to "failed".
   */
  async markRejected(id: string, reason?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry && (entry.status !== 'rejected' || entry.reason !== reason)) {
      entry.status = 'rejected';
      entry.reason = reason;
      this.mutationVersion++;
      await this.persist();
    }
  }

  /** Drop an entry entirely (confirmed cleanup, or a user-cancelled send). */
  async remove(id: string): Promise<void> {
    if (this.entries.delete(id)) {
      this.mutationVersion++;
      await this.persist();
    }
  }

  /**
   * Events still needing delivery — to (auto-)retry on reconnect. Excludes both terminal states:
   * 'confirmed' (delivered) and 'rejected' (the relay said no; re-sending is futile and wastes Tor).
   * A 'rejected' entry can still be retried manually via eventFor()/retry() — just never automatically.
   */
  unsent(): Event[] {
    return [...this.entries.values()]
      .filter(entry => entry.status !== 'confirmed' && entry.status !== 'rejected')
      .map(entry => entry.event);
  }

  /** Look up an entry's event by id regardless of status (for a user-initiated retry of a rejected send). */
  eventFor(id: string): Event | undefined {
    return this.entries.get(id)?.event;
  }

  /** Per-id status snapshot for the UI (sending/failed/rejected indicators). Version-cached (see
   *  `mutationVersion`): repeated calls with no intervening mutation return the SAME Map instance, so
   *  a consumer keying re-render on object identity (FeedList's renderItem) doesn't churn on an
   *  unrelated emit. Callers only ever read the returned Map — never mutate the cached instance. */
  statuses(): Map<string, SendStatus> {
    if (this.statusesCache && this.statusesCache.version === this.mutationVersion) {
      return this.statusesCache.value;
    }
    const value = new Map([...this.entries.entries()].map(([id, entry]) => [id, entry.status]));
    this.statusesCache = {version: this.mutationVersion, value};
    return value;
  }

  /** Per-id rejection reasons for the UI (only entries the relay rejected with a reason).
   *  Version-cached the same way as statuses(). */
  reasons(): Map<string, string> {
    if (this.reasonsCache && this.reasonsCache.version === this.mutationVersion) {
      return this.reasonsCache.value;
    }
    const out = new Map<string, string>();
    for (const [id, entry] of this.entries) {
      if (entry.reason !== undefined) out.set(id, entry.reason);
    }
    this.reasonsCache = {version: this.mutationVersion, value: out};
    return out;
  }

  /**
   * Ids currently 'sending' because they're queued offline (deliver()'s `result.offline` branch —
   * relay/Tor not connected yet), rather than actively in flight over an open publish() call. Render
   * hint only (M7): distinguishes "Queued — connecting…" from "Sending…" in the UI. An id leaves this
   * set the instant it moves to any other status (accepted/confirmed/failed/rejected).
   * Version-cached the same way as statuses().
   */
  queuedOfflineIds(): ReadonlySet<string> {
    if (this.queuedOfflineCache && this.queuedOfflineCache.version === this.mutationVersion) {
      return this.queuedOfflineCache.value;
    }
    const out = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (entry.status === 'sending' && entry.offline) out.add(id);
    }
    this.queuedOfflineCache = {version: this.mutationVersion, value: out};
    return out;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}
