/**
 * MirrorSet — multi-relay client transport (federation P2, synthesis §1).
 *
 * Owns <= MAX_MIRRORS independent {@link RelayClient} children, ALL sharing the ONE
 * SwappableEventStore the app already threads through. Reads union for free: RelayClient.ingest
 * dedupes on `store.has(id)` before verify/save, so `onEvent` fires exactly once per unique event
 * id no matter which child (primary or a secondary) sees it first — this file adds NO dedup of its
 * own on top of that (a second MirrorSet-level filter would just mask the store's own invalidation).
 *
 * MirrorSet re-exports RelayClient's public surface verbatim, so the single seam swap at
 * `App.tsx:1511` (`new RelayClient(...)` -> `new MirrorSet(...)`) compiles with zero other call-site
 * changes. With zero secondary mirrors this class is byte-identical to using a bare RelayClient.
 *
 * Roles:
 *   - PRIMARY  — exactly the RelayClient built from the socket/options the caller passes into the
 *                constructor. Its socket's lifecycle (watchdog, onClose -> onRelayDown, escalation
 *                ladder) stays OWNED BY THE CALLER (App.tsx) end to end — MirrorSet never registers
 *                its own onOpen/onClose on the primary socket (both slots are single-subscriber; a
 *                second registration here would silently clobber the caller's own hook) and never
 *                re-creates or escalates it.
 *   - SECONDARY — built by MirrorSet itself via `opts.createSocket(url)`, lazily and staggered after
 *                the primary's first sync. Runs a RECONCILE-ONLY plan (same verify/inboundBatchSize/
 *                negentropy/getAllowedKinds as the primary, but the live REQ plan is swapped for
 *                `secondaryPlan` — org-config only) and periodically drains the NIP-77 feed delta via
 *                `resyncFeed()`. A secondary whose reconcile pulls in a FEED_KINDS event the primary
 *                never delivered is evidence the primary is withholding; MirrorSet then promotes that
 *                secondary to a full live-plan child (without ever demoting the original primary,
 *                which has no API for that — its harmless duplicate delivery just dedups in-store).
 *
 * Because MirrorSet builds secondary sockets itself, and RelayClient's constructor unconditionally
 * calls `socket.onOpen`/`socket.onMessage` (both single-subscriber, overwrite-on-second-call per the
 * RelaySocket contract), a secondary's raw socket is wrapped in {@link multiplexSocket} so BOTH
 * RelayClient's own registration and MirrorSet's connectivity bookkeeping can observe open/close
 * without clobbering each other. The primary socket is never wrapped — it is handed to RelayClient
 * completely unmodified, per the ownership rule above.
 */
import {
  RelayClient,
  type RelayClientOptions,
  type PublishResult,
  type SubscriptionPlan,
  type NegentropySyncOptions,
} from './RelayClient';
import type {RelaySocket} from './socket';
import type {EventStore} from './store';
import type {Event} from 'nostr-tools/pure';
import type {ReqFilter} from './protocol';
import {FEED_KINDS} from '../contracts';
import {relayBackoffMs} from './reconnectBackoff';
import {onionHostOf} from '../tor/onionAuth';

export interface MirrorSpec {
  url: string;
  onionAuthKey?: string | null;
}

export interface MirrorSetOptions {
  /** Full RelayClient options for the PRIMARY child — exactly the block App.tsx builds today. */
  primaryOptions: RelayClientOptions;
  /** Build a Tor-routed socket for a secondary mirror URL. */
  createSocket: (url: string) => RelaySocket;
  /** Secondaries to run reconcile-only. Already de-duped/cap-ordered by effectiveMirrors, primary excluded. */
  secondaryMirrors: readonly MirrorSpec[];
  /** Reconcile-only live plan for secondaries (org-config authors:[op] sub; NO feed/DM). Default () => []. */
  secondaryPlan?: SubscriptionPlan;
  /** May we ATTEMPT this secondary now (auth loadable)? Default: public onions only (no onionAuthKey). */
  mirrorAuthLoadable?: (spec: MirrorSpec) => boolean;
  /** Feed kinds for withholding-delta attribution. Default FEED_KINDS (includes kind-1984 moderation). */
  feedKinds?: readonly number[];
  /** ms between lazy staggered secondary connects after primary sync. Default 2500. */
  secondaryConnectDelayMs?: number;
  /**
   * Bounded wall-clock deadline (ms) after which the secondaries connect even if the primary never
   * syncs. A connected-but-WITHHOLDING primary (socket open, `onSynced` never fires) would otherwise
   * disable cross-mirror reconciliation entirely — the whole anti-censorship point — because
   * `startSecondaries()` is normally armed only from the primary's `onSynced`. Default 25_000.
   */
  secondaryStartDeadlineMs?: number;
  /** ms between periodic background reconciles of each connected secondary. Default 300_000. */
  reconcileIntervalMs?: number;
  /**
   * Feed events a SECONDARY reconciles over — the app's FULL display horizon, NOT the primary's
   * incremental high-water window. A withholding primary that dropped OLDER posts is only caught if
   * secondaries reconcile the whole displayed feed, so secondaries get their OWN negentropy filter
   * ({@link fullHorizonNegentropy}) bounded by this limit rather than inheriting the primary's `since`.
   * Default 500 (mirrors subscriptionPlan.ts DEFAULT_FEED_LIMIT, the feed display bound).
   */
  secondaryReconcileLimit?: number;
  /** User "preferred relay" pin — never flagged withholding / never demoted. */
  pinnedPrimaryUrl?: string;
  /**
   * Best-effort label for the PRIMARY's own URL (e.g. the community's configured `relayUrl`). This is
   * an SB-added optional field, not otherwise derivable: the constructor only receives an already-open
   * `RelaySocket`, which carries no URL, so without this hint MirrorSet cannot compare the primary
   * against `pinnedPrimaryUrl` or label it in {@link MirrorSetOptions.onWithholding}. Omitting it is
   * safe — the primary is then simply never treated as pinned (still eligible for withholding-triggered
   * promotion) and `onWithholding` reports an empty `withholdingUrl`.
   */
  primaryUrl?: string;
  /** UX hook fired when the primary is flagged withholding (a secondary contributed feed deltas). */
  onWithholding?: (info: {withholdingUrl: string; promotedUrl: string | null}) => void;
  /**
   * Known-good capture (synthesis §1.2 / MF-1). Fired with a secondary's {@link MirrorSpec} the moment
   * that secondary is CONFIRMED honest — it delivered a RECENT FEED_KINDS delta the primary's live sub
   * should have served (see {@link isRecentWithholdingDelta}); this is also the point any promotion is
   * triggered, so a promoted mirror is always captured too. The host upserts the spec into the active
   * community's structurally-un-evictable `mirrorsKnownGood` tier so a later org `stiq:mirrors` de-list
   * can never retract a mirror this device has SEEN serve valid community content. Absent → no capture
   * (N=1 / tests): known-good stays empty and the fix is inert, byte-identical to before.
   */
  onMirrorObservedGood?: (spec: MirrorSpec) => void;
}

const DEFAULT_SECONDARY_CONNECT_DELAY_MS = 2_500;
const DEFAULT_RECONCILE_INTERVAL_MS = 300_000;
const DEFAULT_SECONDARY_START_DEADLINE_MS = 25_000;
/** Mirrors subscriptionPlan.ts DEFAULT_FEED_LIMIT (the feed display bound). Kept in sync by intent. */
const DEFAULT_SECONDARY_RECONCILE_LIMIT = 500;

/** De-dup key for a mirror url: its v3 onion host (ws:// vs wss:// vs trailing-slash are one relay). */
function hostKey(url: string): string {
  return onionHostOf(url) ?? url.trim().toLowerCase();
}

/**
 * Derive a SECONDARY child's negentropy options from the primary's, widening the reconcile window to
 * the app's FULL display horizon. The primary reconciles only its incremental `since` window
 * (highWater − overlap); spreading that onto secondaries (the old bug) meant a primary that withheld
 * OLDER posts was never caught, because the secondary only ever reconciled the same live-overlap
 * window. Here the primary's `since` is stripped and a bounded `limit` applied, so a secondary
 * reconciles the whole displayed feed and pulls in ANY FEED_KINDS event (member content AND kind-1984
 * moderation) present on that honest mirror, regardless of when it was posted. The primary's
 * `getItems` (which reads FEED_KINDS from the shared store) is reused verbatim — with no `since` it
 * simply returns the full local set, bounded by the same `limit`, so both sides reconcile the same
 * window. Pure; exported for unit testing the horizon invariant.
 */
export function fullHorizonNegentropy(
  base: NegentropySyncOptions,
  feedKinds: readonly number[],
  limit: number,
): NegentropySyncOptions {
  const fullHorizon = (): ReqFilter => {
    // Strip the primary's incremental `since` — secondaries reconcile the full display horizon.
    const rest: ReqFilter = {...(typeof base.filter === 'function' ? base.filter() : base.filter)};
    delete rest.since;
    return {...rest, kinds: rest.kinds ?? [...feedKinds], limit: rest.limit ?? limit};
  };
  return {...base, filter: fullHorizon, fallbackFilter: fullHorizon};
}

/** Duck-typed circuit-isolation escape hatch RelayClient looks for on a socket (torSocket.ts). */
interface PublishCircuitProvider {
  openPublishCircuit(): RelaySocket | null;
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as {unref?: () => void}).unref?.();
}

/**
 * Wrap a raw socket so its single-subscriber `onOpen`/`onClose` slots become multi-subscriber. Needed
 * only for SECONDARY sockets: RelayClient's own constructor claims `onOpen`/`onMessage` on whatever
 * socket it is given, and MirrorSet also needs `onOpen`/`onClose` for its own connectivity bookkeeping
 * on the same socket. `onMessage` is passed straight through (RelayClient is the sole consumer).
 * Preserves the "replay immediately if already open/closed" semantics late subscribers rely on
 * (torSocket.ts), and forwards `openPublishCircuit` when the raw socket exposes it (blind-post circuit
 * isolation must keep working for writes fanned out to a secondary).
 */
function multiplexSocket(raw: RelaySocket): RelaySocket {
  const openCbs = new Set<() => void>();
  const closeCbs = new Set<() => void>();
  let isOpen = false;
  let isClosed = false;
  raw.onOpen(() => {
    isOpen = true;
    for (const cb of [...openCbs]) cb();
  });
  raw.onClose(() => {
    isClosed = true;
    isOpen = false;
    for (const cb of [...closeCbs]) cb();
  });
  const wrapped: RelaySocket & Partial<PublishCircuitProvider> = {
    send: data => raw.send(data),
    onMessage: cb => raw.onMessage(cb),
    onOpen: cb => {
      openCbs.add(cb);
      if (isOpen) cb();
    },
    onClose: cb => {
      closeCbs.add(cb);
      if (isClosed) cb();
    },
    close: () => raw.close(),
  };
  const circuitProvider = raw as Partial<PublishCircuitProvider>;
  if (typeof circuitProvider.openPublishCircuit === 'function') {
    wrapped.openPublishCircuit = () => circuitProvider.openPublishCircuit!();
  }
  return wrapped;
}

interface ChildEntry {
  url: string;
  /** Absent for the primary (it isn't built from a MirrorSpec). */
  spec?: MirrorSpec;
  client: RelayClient;
  socket: RelaySocket;
  isPrimary: boolean;
  /** True once this secondary has been promoted to a full live-plan child. */
  isPromoted: boolean;
  connected: boolean;
  synced: boolean;
  /** Options this child was (re)built with — reused verbatim on reconnect. */
  options: RelayClientOptions;
  unsubs: Array<() => void>;
  /** Set just before a deliberate teardown (promotion rebuild / MirrorSet.close) so the socket's
   * onClose handler skips scheduling an auto-reconnect for an instance we're intentionally discarding. */
  torndown: boolean;
  failureStreak: number;
  reconcileTimer?: ReturnType<typeof setInterval>;
}

export class MirrorSet {
  private readonly store: EventStore;
  private readonly opts: MirrorSetOptions;
  private readonly feedKinds: readonly number[];
  private readonly secondaryConnectDelayMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly secondaryReconcileLimit: number;
  private readonly secondaryStartDeadlineMs: number;

  private readonly primary: ChildEntry;
  private secondaries: ChildEntry[] = [];
  /** The current secondary-mirror SET (mutable): the constructor snapshot, replaced by
   *  {@link updateSecondaryMirrors} so a durably-adopted mirror is used without a reconnect. */
  private secondaryMirrors: readonly MirrorSpec[];
  /** The secondary (if any) currently running the full live plan after a withholding promotion. */
  private promotedEntry: ChildEntry | null = null;
  /**
   * A promotion has been triggered and its full-live-plan child has NOT yet opened its socket (MF-5b).
   * Set SYNCHRONOUSLY in {@link promoteSecondary} — independent of `promotedEntry.connected`, which
   * stays false for the seconds until the promoted Tor socket opens — and checked first in
   * {@link onWithholdingSignal} so that during that connect window a second (or third) secondary also
   * holding a delta cannot each fire its own promotion, orphaning extra full-plan firehoses with no
   * demote path. Cleared when the promoted socket opens or on its teardown/close.
   */
  private promotionPending = false;
  /**
   * The startup deadline fired before the primary ever synced (MF-4): a connected-but-never-syncing
   * (stall-withholding) primary can't produce `primary.client.isSynced() === true`, so promotion —
   * gated on that in {@link onWithholdingSignal} — would be unreachable and withheld posts would only
   * surface on the slow periodic reconcile. Once set, a RECENT secondary delta may promote WITHOUT the
   * isSynced() precondition. False-promoting an honest-but-slow primary here is harmless (the promoted
   * child just dedups; a user pin still backstops a preferred relay). Never cleared once set — a
   * primary that later syncs simply re-enables the normal isSynced() path alongside this one.
   */
  private primaryNeverSynced = false;

  private secondariesStarted = false;
  private aggregateSynced = false;
  private closed = false;
  private readonly pendingConnectTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Bounded wall-clock arm for startSecondaries() when the primary never syncs (withholding). */
  private startupDeadlineTimer?: ReturnType<typeof setTimeout>;
  /**
   * Consecutive `createSocket` failures for a secondary URL BEFORE it ever produced a socket (so
   * there is no {@link ChildEntry} yet to hold a per-instance `failureStreak` on) — see
   * {@link connectSecondary}'s try/catch. Keyed by url; cleared the moment that url next opens.
   */
  private readonly preConnectFailureStreak = new Map<string, number>();

  private readonly eventListeners = new Set<(event: Event) => void>();
  private readonly seenListeners = new Set<(event: Event) => void>();
  private readonly syncListeners = new Set<() => void>();
  private readonly subErrorListeners = new Set<(err: {subId: string; message: string}) => void>();
  private readonly noticeListeners = new Set<(message: string) => void>();
  /** Forwarded from the sub-carrying child only (scoped subs live on primary-or-promoted). */
  private readonly scopedEoseListeners = new Set<(subId: string) => void>();
  /** Forwarded from the sub-carrying child only (primary-or-promoted, same as scopedEoseListeners
   *  above) — a reconcile-only secondary's plan send must never fabricate a resubscribe trigger. */
  private readonly subscribedListeners = new Set<() => void>();

  constructor(primarySocket: RelaySocket, store: EventStore, opts: MirrorSetOptions) {
    this.store = store;
    this.opts = opts;
    this.feedKinds = opts.feedKinds ?? FEED_KINDS;
    this.secondaryConnectDelayMs = Math.max(
      0,
      Math.trunc(opts.secondaryConnectDelayMs ?? DEFAULT_SECONDARY_CONNECT_DELAY_MS),
    );
    this.reconcileIntervalMs = Math.max(
      1_000,
      Math.trunc(opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS),
    );
    this.secondaryReconcileLimit = Math.max(
      1,
      Math.trunc(opts.secondaryReconcileLimit ?? DEFAULT_SECONDARY_RECONCILE_LIMIT),
    );
    this.secondaryStartDeadlineMs = Math.max(
      0,
      Math.trunc(opts.secondaryStartDeadlineMs ?? DEFAULT_SECONDARY_START_DEADLINE_MS),
    );
    this.secondaryMirrors = opts.secondaryMirrors;

    this.primary = {
      url: opts.primaryUrl ?? '',
      client: new RelayClient(primarySocket, store, opts.primaryOptions),
      socket: primarySocket,
      isPrimary: true,
      isPromoted: false,
      connected: false, // never observed (see multiplexSocket doc) — unused for the primary
      synced: false,
      options: opts.primaryOptions,
      unsubs: [],
      torndown: false,
      failureStreak: 0,
    };
    this.wireChildListeners(this.primary);

    // Anti-censorship (synthesis §1.5): a connected-but-never-syncing (withholding) primary must NOT
    // disable cross-mirror reconciliation. Arm a bounded wall-clock deadline that starts the
    // secondaries even if the primary's `onSynced` never fires. Only when there are secondaries to
    // start — a zero-mirror build has nothing to arm (and would otherwise leave a dangling timer).
    if (this.secondaryMirrors.length > 0) this.armStartupDeadline();
  }

  /** Arm the wall-clock deadline that starts secondaries when the primary never syncs. Idempotent —
   *  a no-op once secondaries have started, the set is empty, or a deadline is already pending.
   *  startSecondaries() is itself idempotent, so the deadline and the primary's onSynced can't
   *  double-start; whichever fires first wins and the other becomes a no-op. */
  private armStartupDeadline(): void {
    if (
      this.closed ||
      this.secondariesStarted ||
      this.startupDeadlineTimer !== undefined ||
      this.secondaryMirrors.length === 0
    ) {
      return;
    }
    this.startupDeadlineTimer = setTimeout(() => {
      this.startupDeadlineTimer = undefined;
      // The primary never synced by the deadline (MF-4): treat it as withholding so a RECENT secondary
      // delta can promote past it even though isSynced() will never become true.
      this.primaryNeverSynced = true;
      this.startSecondaries();
    }, this.secondaryStartDeadlineMs);
    unref(this.startupDeadlineTimer);
  }

  private clearStartupDeadline(): void {
    if (this.startupDeadlineTimer !== undefined) {
      clearTimeout(this.startupDeadlineTimer);
      this.startupDeadlineTimer = undefined;
    }
  }

  // ───────────────────────────── RelayClient-compatible public surface ─────────────────────────────

  publish(event: Event): Promise<PublishResult> {
    const connectedSecondaries = this.secondaries.filter(s => s.connected);
    if (connectedSecondaries.length === 0) {
      // Single-target fast path: byte-identical to a bare RelayClient (exact result passthrough,
      // including its precise `message` text) when there are no live secondaries — e.g. always, at
      // MAX_MIRRORS=1 (dark rollout).
      return this.primary.client.publish(event);
    }
    const targets = [this.primary.client, ...connectedSecondaries.map(s => s.client)];
    return new Promise<PublishResult>(resolve => {
      let settled = false;
      let remaining = targets.length;
      let sawOffline = false;
      let definitiveRejection: PublishResult | null = null;
      for (const client of targets) {
        client.publish(event).then(result => {
          if (settled) return;
          if (result.accepted) {
            settled = true;
            resolve(result);
            return;
          }
          if (result.offline) {
            sawOffline = true;
          } else {
            definitiveRejection = definitiveRejection ?? result;
          }
          remaining--;
          if (remaining === 0 && !settled) {
            settled = true;
            resolve(
              sawOffline || definitiveRejection === null
                ? {accepted: false, message: 'offline', offline: true}
                : definitiveRejection,
            );
          }
        });
      }
    });
  }

  count(filter: ReqFilter, timeoutMs?: number): Promise<number | null> {
    return this.primary.client.count(filter, timeoutMs);
  }

  fetchById(ids: string[]): void {
    this.primary.client.fetchById(ids);
  }

  fetchByFilter(filters: ReqFilter[]): void {
    this.primary.client.fetchByFilter(filters);
  }

  /** The child that actually carries the live subscription plan right now: the promoted secondary
   *  once a withholding primary has been routed around (while it stays connected), else the original
   *  primary. subscribeScoped/closeSub MUST target this — onSubscribed already fires from
   *  primary-OR-promoted (wireChildListeners), so a caller re-opening a scoped sub in reaction to it
   *  (AppRuntime.onRelaySubscribed → resubscribeGroups/Channels) has to land on whichever child just
   *  fired, not the primary a promotion has already shown unreliable. Derived live (not cached) so it
   *  always prefers the promoted mirror while one is active; the `?.connected` guard mirrors
   *  resyncFeed's style for the narrow window before the promoted socket opens. */
  private activeChild(): ChildEntry {
    return this.promotedEntry?.connected ? this.promotedEntry : this.primary;
  }

  subscribeScoped(subId: string, filters: ReqFilter[]): void {
    this.activeChild().client.subscribeScoped(subId, filters);
  }

  closeSub(subId: string): void {
    this.activeChild().client.closeSub(subId);
  }

  /** Scroll-back pagination (bug #3) is a PRIMARY-only concern — secondaries are reconcile-only and
   *  never stream older feed/channel/group history, so this delegates to the primary child alone. */
  requestOlder(opts: {subKey: string; filter: ReqFilter; until: number; limit?: number}): void {
    this.primary.client.requestOlder(opts);
  }

  /** Primary pull-to-refresh + fan `resyncFeed()` to every connected secondary; resolves on the PRIMARY round. */
  resyncFeed(timeoutMs?: number): Promise<void> {
    for (const s of this.secondaries) {
      if (s.connected) void s.client.resyncFeed();
    }
    return this.primary.client.resyncFeed(timeoutMs);
  }

  onEvent(cb: (event: Event) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onSeen(cb: (event: Event) => void): () => void {
    this.seenListeners.add(cb);
    return () => this.seenListeners.delete(cb);
  }

  onSynced(cb: () => void): () => void {
    this.syncListeners.add(cb);
    return () => this.syncListeners.delete(cb);
  }

  onSubError(cb: (err: {subId: string; message: string}) => void): () => void {
    this.subErrorListeners.add(cb);
    return () => this.subErrorListeners.delete(cb);
  }

  /** Forwarded from the sub-carrying child only (primary or promoted — scoped subs live there, see
   *  activeChild): a scoped subscription finished replaying its stored history. */
  onScopedEose(cb: (subId: string) => void): () => void {
    this.scopedEoseListeners.add(cb);
    return () => this.scopedEoseListeners.delete(cb);
  }

  onNotice(cb: (message: string) => void): () => void {
    this.noticeListeners.add(cb);
    return () => this.noticeListeners.delete(cb);
  }

  /** Fires after the primary (or a promoted replacement) sends its subscription plan on an OPEN
   *  socket — the moment scoped subs must be (re)opened to stick (see RelayClient.onSubscribed). */
  onSubscribed(cb: () => void): () => void {
    this.subscribedListeners.add(cb);
    return () => this.subscribedListeners.delete(cb);
  }

  isSynced(): boolean {
    return this.primary.client.isSynced() || this.secondaries.some(s => s.client.isSynced());
  }

  cachedPosts(limit?: number): Event[] {
    return this.primary.client.cachedPosts(limit);
  }

  close(): void {
    this.closed = true;
    this.clearStartupDeadline();
    for (const timer of this.pendingConnectTimers) clearTimeout(timer);
    this.pendingConnectTimers.clear();
    this.preConnectFailureStreak.clear();
    for (const entry of [...this.secondaries]) {
      this.teardownEntry(entry);
    }
    this.secondaries = [];
    this.promotedEntry = null;
    this.promotionPending = false;
    for (const unsub of this.primary.unsubs) unsub();
    this.primary.unsubs = [];
    this.primary.client.close(); // -> primarySocket.close() -> the caller's own onClose (onRelayDown)
  }

  // ───────────────────────────────────── internal wiring ─────────────────────────────────────

  private wireChildListeners(entry: ChildEntry): void {
    entry.unsubs.push(entry.client.onEvent(event => this.handleChildEvent(entry, event)));
    entry.unsubs.push(
      entry.client.onSeen(event => {
        for (const cb of this.seenListeners) cb(event);
      }),
    );
    entry.unsubs.push(
      entry.client.onSubError(err => {
        for (const cb of this.subErrorListeners) cb(err);
      }),
    );
    entry.unsubs.push(
      entry.client.onNotice(message => {
        for (const cb of this.noticeListeners) cb(message);
      }),
    );
    entry.unsubs.push(entry.client.onSynced(() => this.handleChildSynced(entry)));
    entry.unsubs.push(
      // Guarded at FIRE time (not wiring time) so a secondary that gets promoted mid-session starts
      // forwarding, while a reconcile-only secondary's plan send never triggers a scoped resubscribe
      // (those REQs would land on the primary and just churn duplicate frames over Tor).
      entry.client.onSubscribed(() => {
        if (!entry.isPrimary && !entry.isPromoted) return;
        for (const cb of this.subscribedListeners) cb();
      }),
    );
    entry.unsubs.push(
      // Same fire-time guard as onSubscribed: only the sub-carrying child holds scoped subs, so a
      // reconcile-only secondary can never fabricate a "history synced" signal.
      entry.client.onScopedEose(subId => {
        if (!entry.isPrimary && !entry.isPromoted) return;
        for (const cb of this.scopedEoseListeners) cb(subId);
      }),
    );
  }

  /** Forward every child's newly-stored event once (store.has dedup already guarantees "once per id"
   * across the whole MirrorSet), then — for a reconcile-only secondary only — attribute a RECENT
   * FEED_KINDS delivery as evidence the primary withheld it. */
  private handleChildEvent(entry: ChildEntry, event: Event): void {
    for (const cb of this.eventListeners) cb(event);
    if (this.closed || entry.isPrimary || entry.isPromoted) return;
    if (!this.feedKinds.includes(event.kind)) return;
    // MF-5a: a full-horizon secondary legitimately BACK-FILLS older history the primary's incremental
    // live window never covered (interrupted sync, the 2000-event cap, cross-mirror divergence). That
    // older delta is union-ingested above (correctness unaffected) but must NOT be misread as
    // censorship — only a RECENT delta, one the connected primary should have delivered live, counts as
    // a withholding signal. Gating here (not merely inside onWithholdingSignal) also spares the fan-out
    // reconcile storm an ordinary history back-fill would otherwise trigger.
    if (!this.isRecentWithholdingDelta(event)) return;
    // MF-1: this secondary just served a recent FEED_KINDS event the primary didn't — it is a
    // CONFIRMED-honest mirror. Capture it as known-good (the host makes it structurally un-evictable)
    // BEFORE any promotion decision, so even a pinned/unpromotable primary still records the honest
    // mirror. Promotion (below) only ever follows this point, so a promoted mirror is captured too.
    if (entry.spec) this.opts.onMirrorObservedGood?.(entry.spec);
    this.onWithholdingSignal(entry);
  }

  /** The primary's current live/high-water window start — the `since` its negentropy filter resolves
   *  to — or undefined when the primary runs no negentropy or is on a cold (no-`since`) full reconcile.
   *  Pure read of the option's filter (does NOT touch the primary's live NIP-77 session). */
  private primaryWindowSince(): number | undefined {
    const neg = this.opts.primaryOptions.negentropy;
    if (!neg) return undefined;
    const resolved = typeof neg.filter === 'function' ? neg.filter() : neg.filter;
    return resolved.since;
  }

  /** True when `event` falls at/after the primary's live/high-water window (MF-5a) — a RECENT event a
   *  connected primary should have delivered live, so a secondary serving it as new-to-store is real
   *  withholding evidence. With no window boundary (cold cache / no negentropy) recency can't be judged,
   *  so treat it as a candidate; the promotion gate (isSynced / never-synced) still bounds false
   *  positives and a mis-promotion is only a harmless dedup'd duplicate. */
  private isRecentWithholdingDelta(event: Event): boolean {
    const since = this.primaryWindowSince();
    return since === undefined || event.created_at >= since;
  }

  private handleChildSynced(entry: ChildEntry): void {
    if (!entry.synced) {
      entry.synced = true;
      if (!this.aggregateSynced) {
        this.aggregateSynced = true;
        for (const cb of this.syncListeners) cb();
      }
    }
    if (entry.isPrimary) {
      this.startSecondaries();
    } else if (!entry.isPromoted) {
      // Reconcile-only secondary: drain the bounded NIP-77 feed delta right away, then keep it
      // topped up on a periodic cadence for as long as it stays connected.
      void entry.client.resyncFeed();
      this.startReconcileTimer(entry);
    }
  }

  private startReconcileTimer(entry: ChildEntry): void {
    if (entry.reconcileTimer) return;
    entry.reconcileTimer = setInterval(() => {
      if (entry.connected) void entry.client.resyncFeed();
    }, this.reconcileIntervalMs);
    unref(entry.reconcileTimer);
  }

  /** Lazy, staggered secondary connect after the primary's FIRST sync (reach: §1.6) — or after the
   *  wall-clock startup deadline when the primary is withholding (never syncs, §1.5). */
  private startSecondaries(): void {
    if (this.secondariesStarted || this.closed) return;
    this.clearStartupDeadline();
    this.secondariesStarted = true;
    const loadable = this.opts.mirrorAuthLoadable ?? (spec => spec.onionAuthKey == null);
    let index = 0;
    for (const spec of this.secondaryMirrors) {
      if (!loadable(spec)) continue;
      const delay = index * this.secondaryConnectDelayMs;
      index++;
      const timer = setTimeout(() => {
        this.pendingConnectTimers.delete(timer);
        this.connectSecondary(spec, this.secondaryClientOptions(), false);
      }, delay);
      unref(timer);
      this.pendingConnectTimers.add(timer);
    }
  }

  /**
   * Adopt a fresh secondary-mirror set at runtime (synthesis §1.9) — after a durable `stiq:mirrors`
   * apply or a user mirror-add — WITHOUT waiting for the next relay reconnect. Diffs by onion host
   * against the current secondary children: newcomers are lazily connected (subject to the same
   * auth-loadable gate as the initial staggered connect, so an auth-gated mirror whose key the daemon
   * isn't yet running defers until the reconnect that writes it), children still listed are left
   * untouched (their live sockets + reconcile timers keep running), and children no longer listed are
   * torn down. The new set also becomes the one a later reconnect / promotion rebuild uses. Idempotent;
   * a no-op when the set is unchanged, and safe to call before startSecondaries() has run (it just
   * updates the pending set the deadline / primary-sync will consume).
   */
  updateSecondaryMirrors(specs: readonly MirrorSpec[]): void {
    if (this.closed) return;
    this.secondaryMirrors = specs;
    if (!this.secondariesStarted) {
      // startSecondaries() will consume the updated set (on the primary's sync or the deadline). If
      // the initial set was empty no deadline was armed, so arm one now for the withholding case.
      this.armStartupDeadline();
      return;
    }
    const wantHosts = new Set(specs.map(s => hostKey(s.url)));
    // Drop children no longer listed (teardownEntry marks torndown so onClose won't auto-reconnect).
    for (const entry of [...this.secondaries]) {
      // MF-1 belt-and-suspenders: NEVER tear down the currently-promoted (live) mirror even if a fresh
      // org `stiq:mirrors` list omits its host. A mirror we promoted is one we've SEEN serve honest
      // content; the org must not be able to retract it via a de-list. (It is also being captured into
      // the un-evictable mirrorsKnownGood tier, so the recomputed spec set normally still contains it —
      // this guards the window before that capture round-trips through storage.)
      if (entry === this.promotedEntry) continue;
      if (!wantHosts.has(hostKey(entry.url))) this.teardownEntry(entry);
    }
    // Connect newcomers not already represented by an existing child (by host) and loadable now.
    const loadable = this.opts.mirrorAuthLoadable ?? (spec => spec.onionAuthKey == null);
    const haveHosts = new Set(this.secondaries.map(s => hostKey(s.url)));
    let index = 0;
    for (const spec of specs) {
      if (haveHosts.has(hostKey(spec.url))) continue;
      if (!loadable(spec)) continue;
      const delay = index * this.secondaryConnectDelayMs;
      index++;
      const timer = setTimeout(() => {
        this.pendingConnectTimers.delete(timer);
        this.connectSecondary(spec, this.secondaryClientOptions(), false);
      }, delay);
      unref(timer);
      this.pendingConnectTimers.add(timer);
    }
  }

  /** `{...primaryOptions, plan: secondaryPlan, negentropy: <full-horizon>}` — keeps
   * verify/inboundBatchSize/getAllowedKinds, swaps the live plan for the reconcile-only org-config sub
   * (§1.4/§1.7), and widens the negentropy reconcile from the primary's incremental `since` window to
   * the FULL display horizon so a primary that withheld OLDER posts is still caught (see
   * {@link fullHorizonNegentropy}). */
  private secondaryClientOptions(): RelayClientOptions {
    const base = this.opts.primaryOptions;
    return {
      ...base,
      plan: this.opts.secondaryPlan ?? (() => []),
      negentropy: base.negentropy
        ? fullHorizonNegentropy(base.negentropy, this.feedKinds, this.secondaryReconcileLimit)
        : undefined,
    };
  }

  /**
   * Build (or rebuild, after a failure) one SECONDARY child.
   *
   * `createSocket` dials Tor exactly like the primary's own connect path does (App.tsx's
   * `startRelay`), and throws SYNCHRONOUSLY when Tor is momentarily offline (torSocket.ts's
   * `requireTorTransport`). `startRelay` wraps that call in a try/catch for exactly this reason; this
   * one didn't — so a secondary's staggered start, a promotion, or (worst of all) THIS FUNCTION'S OWN
   * onClose-driven auto-retry below firing while Tor was still mid-reconnect threw UNCAUGHT out of a
   * bare `setTimeout` callback, with no caller anywhere in a position to catch it. Retried on the SAME
   * `relayBackoffMs` schedule a post-connect failure gets, keyed by url in
   * {@link preConnectFailureStreak} since there is no ChildEntry yet to hold a per-instance streak on.
   * `isPromoted` is threaded through the retry so a promotion in flight (`promotionPending`) still
   * resolves once Tor is back, instead of being silently abandoned mid-promotion.
   */
  private connectSecondary(spec: MirrorSpec, options: RelayClientOptions, isPromoted: boolean): void {
    // Every path into this function except promoteSecondary()'s own immediate call is timer-scheduled
    // (the initial stagger, a newcomer stagger, a post-close backoff retry, or the pre-connect retry
    // below), so `this.secondaryMirrors` — the CURRENT set — may have changed underneath any of them
    // by the time they actually fire. That matters most for the pre-connect retry just below: a
    // synchronous createSocket() throw means NO ChildEntry exists yet for this url (see
    // preConnectFailureStreak's doc comment), so updateSecondaryMirrors's de-list loop — which walks
    // ChildEntrys — can never see or cancel this armed closure. Left unchecked it would keep retrying
    // the OLD spec on its backoff schedule and could connect a mirror the organizer has since removed
    // — a trust problem (operators drop a mirror for a reason), not just untidiness. Re-checking live
    // membership here, right before doing anything, closes that gap for every deferred entry path in
    // one place. This mirrors close()'s own ordering rule (it sets `this.closed` before clearing any
    // timers) — updateSecondaryMirrors assigns `this.secondaryMirrors` before it tears down or skips
    // anything, so a read of it here always sees whatever the most recent call decided.
    if (this.closed || !this.secondaryMirrors.some(s => hostKey(s.url) === hostKey(spec.url))) {
      this.preConnectFailureStreak.delete(spec.url);
      return;
    }
    let rawSocket: RelaySocket;
    try {
      rawSocket = this.opts.createSocket(spec.url);
    } catch {
      if (this.closed) return; // never (re)arm a retry once torn down
      const streak = (this.preConnectFailureStreak.get(spec.url) ?? 0) + 1;
      this.preConnectFailureStreak.set(spec.url, streak);
      const timer = setTimeout(() => {
        this.pendingConnectTimers.delete(timer);
        this.connectSecondary(spec, options, isPromoted);
      }, relayBackoffMs(streak));
      unref(timer);
      this.pendingConnectTimers.add(timer);
      return;
    }
    this.preConnectFailureStreak.delete(spec.url);
    const socket = multiplexSocket(rawSocket);
    const client = new RelayClient(socket, this.store, options);
    const entry: ChildEntry = {
      url: spec.url,
      spec,
      client,
      socket,
      isPrimary: false,
      isPromoted,
      connected: false,
      synced: false,
      options,
      unsubs: [],
      torndown: false,
      failureStreak: 0,
    };
    this.wireChildListeners(entry);
    socket.onOpen(() => {
      entry.connected = true;
      entry.failureStreak = 0;
      // MF-5b: the promoted child is now live — the promotion has settled, so re-open onWithholdingSignal
      // (the steady-state `promotedEntry?.connected` guard takes over from here).
      if (entry === this.promotedEntry) this.promotionPending = false;
    });
    socket.onClose(() => {
      entry.connected = false;
      const idx = this.secondaries.indexOf(entry);
      if (idx >= 0) this.secondaries.splice(idx, 1);
      if (entry.reconcileTimer) {
        clearInterval(entry.reconcileTimer);
        entry.reconcileTimer = undefined;
      }
      // Minor (MF-5b): if the CLOSING child was the promoted live one, release the promotion bookkeeping
      // (mirror teardownEntry) so a stale promotedEntry pointer / stuck pending flag can't block a later
      // failover promotion. It auto-reconnects below (isPromoted preserved) and re-registers as the
      // promoted entry on the next connectSecondary.
      if (entry === this.promotedEntry) {
        this.promotedEntry = null;
        this.promotionPending = false;
      }
      if (entry.torndown || this.closed) return; // deliberate teardown — no auto-reconnect
      entry.failureStreak++;
      const delay = relayBackoffMs(entry.failureStreak);
      const timer = setTimeout(() => {
        this.pendingConnectTimers.delete(timer);
        this.connectSecondary(spec, options, isPromoted);
      }, delay);
      unref(timer);
      this.pendingConnectTimers.add(timer);
    });
    this.secondaries.push(entry);
    if (isPromoted) this.promotedEntry = entry;
  }

  private teardownEntry(entry: ChildEntry): void {
    entry.torndown = true;
    if (entry.reconcileTimer) {
      clearInterval(entry.reconcileTimer);
      entry.reconcileTimer = undefined;
    }
    const idx = this.secondaries.indexOf(entry);
    if (idx >= 0) this.secondaries.splice(idx, 1);
    if (this.promotedEntry === entry) {
      this.promotedEntry = null;
      this.promotionPending = false; // MF-5b: tearing down the promoted entry clears its in-flight flag
    }
    for (const unsub of entry.unsubs) unsub();
    entry.unsubs = [];
    try {
      entry.client.close();
    } catch {
      /* socket already gone */
    }
  }

  /** True iff the ORIGINAL primary is the user's pinned preferred relay — the only entity this
   * MirrorSet ever flags withholding (promoted secondaries are excluded from delta accounting, so
   * they can never trigger a second promotion of themselves). Never blocks when either side of the
   * comparison is unknown (see {@link MirrorSetOptions.primaryUrl}). */
  private isPrimaryPinned(): boolean {
    const pin = this.opts.pinnedPrimaryUrl;
    return pin !== undefined && this.opts.primaryUrl !== undefined && pin === this.opts.primaryUrl;
  }

  /** A reconcile-only secondary just delivered a FEED_KINDS event the primary's live sub never
   * produced. Fan an immediate extra reconcile to every other connected reconcile-only secondary
   * (drain any further backlog fast), then — unless already promoted, the primary isn't confirmed up,
   * or the primary is the user's pin — promote this secondary to a full live-plan child (§1.5). */
  private onWithholdingSignal(secondary: ChildEntry): void {
    for (const other of this.secondaries) {
      if (other !== secondary && other.connected && !other.isPromoted) {
        void other.client.resyncFeed();
      }
    }
    // MF-5b: a promotion is already in flight (its child hasn't opened yet). Bail so the connect
    // window can't fan out multiple promotions that overwrite `promotedEntry` and orphan firehoses.
    if (this.promotionPending) return;
    if (this.promotedEntry?.connected) return;
    // MF-4: the normal gate requires a synced primary, but a connected-but-never-syncing primary
    // (deadline fired → primaryNeverSynced) is exactly the stall-withhold case we MUST route around,
    // so allow promotion on a recent delta without isSynced() once that flag is set.
    if (!this.primary.client.isSynced() && !this.primaryNeverSynced) return;
    if (this.isPrimaryPinned()) return;
    this.promoteSecondary(secondary);
  }

  private promoteSecondary(secondary: ChildEntry): void {
    const spec = secondary.spec;
    if (!spec) return;
    // MF-5b: mark the promotion in flight SYNCHRONOUSLY, before the new socket exists, so any other
    // secondary delta arriving before that socket opens is bailed in onWithholdingSignal. Cleared when
    // the promoted socket opens (connectSecondary.onOpen) or on its teardown/close.
    this.promotionPending = true;
    const promotedUrl = spec.url;
    this.teardownEntry(secondary);
    this.connectSecondary(spec, this.opts.primaryOptions, true);
    this.opts.onWithholding?.({withholdingUrl: this.opts.primaryUrl ?? '', promotedUrl});
  }
}
