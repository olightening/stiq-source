/**
 * Event cache. The app reads the feed from here, so it renders offline regardless of the
 * Tor connection. The in-memory store below is the test double and the fallback cache; the
 * persistent SQLite implementation (sqliteStore.ts) implements the same interface.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from './events';
import type {SecureStorage} from '../keys/keystore';
import {LEGACY_EVENTS_CACHE, eventsCacheKey} from '../app/workspaceKeys';
import {isCacheExempt} from './cacheExempt';

export interface FeedQuery {
  kinds?: number[];
  authors?: string[];
  limit?: number;
  /**
   * Opt OUT of the default created_at DESC sort (perf; see UI_FREEZE_DIAGNOSIS_ONDEVICE_2026-07-12.md
   * finding C1). Every full-bucket query() pays an O(n log n) sort even when the caller discards
   * order (builds a Map/Set, counts, or re-sorts downstream) — set `unordered: true` ONLY when the
   * caller has verified it doesn't rely on the returned order. Default (unset/false) is UNCHANGED:
   * results are still sorted newest-first. Must never be combined with `limit` (limit means "top-N by
   * recency", which requires the sort) — implementations sort regardless of this flag whenever `limit`
   * is set.
   */
  unordered?: boolean;
}

/**
 * Criteria for a user-driven scoped cache-clear (Settings → Manage data). Both are optional:
 *   olderThanSeconds — only events with created_at STRICTLY less than this unix-seconds cutoff match
 *                      ("older than N days"); omit to match any age.
 *   kinds            — restrict to these kinds (always intersected with the non-exempt set); omit to
 *                      target every non-exempt timeline kind.
 * Exempt kinds (DMs + all durable state, see nostr/cacheExempt.ts) are NEVER matched regardless.
 */
export interface CacheDeleteOpts {
  olderThanSeconds?: number;
  kinds?: readonly number[];
}

export interface EventStore {
  /** Store an event. Returns false if it was already present (deduped by id). */
  save(event: Event): boolean;
  /**
   * Optional fast path for a caller that synchronously confirmed `has(id) === false`.
   * Implementations may skip their own duplicate lookup; semantics otherwise match save().
   */
  saveNew?(event: Event): boolean;
  /**
   * Optional batch fast path for a caller that already applied saveNew's has()-gate to each event
   * this tick: store multiple events with one durable round-trip instead of one per event. An
   * implementation still re-gates each event on has() (a batch can legitimately contain a duplicate
   * of an id already durable, or repeated within the same batch); returns the subset of `events` that
   * were newly stored, in the same relative order, so the caller knows exactly which to notify.
   */
  saveNewBatch?(events: Event[]): Event[];
  has(id: string): boolean;
  getById(id: string): Event | undefined;
  /** Matching events, newest first. */
  query(q: FeedQuery): Event[];
  /** Convenience: feed posts (kind 1), newest first. */
  getPosts(limit?: number): Event[];
  /**
   * Newest `created_at` among stored events matching `kinds` (all kinds if omitted), or
   * undefined when nothing matches. Drives the incremental-sync high-water mark: the next
   * subscription asks the relay only for events `since` this value (minus a small overlap),
   * so a warm cache replays nothing it already holds.
   */
  latestCreatedAt(kinds?: number[]): number | undefined;
  size(): number;
  /** Remove a single cached event by id (e.g. a user-cancelled optimistic write). Optional. */
  remove?(id: string): boolean;
  /**
   * Scoped cache-clear: delete cached RECEIVED feed events (NON-EXEMPT timeline kinds only) matching
   * `opts`, returning how many were removed. NEVER deletes DMs, moderation reports, or durable state
   * (see nostr/cacheExempt.ts). Optional so partial mocks stay valid; the concrete stores implement it.
   */
  deleteCachedEvents?(opts?: CacheDeleteOpts): number;
  /** Cheap preview of {@link deleteCachedEvents}: how many non-exempt events match `opts`. Optional. */
  cachedEventCount?(opts?: CacheDeleteOpts): number;
  /** Remove every cached event (used by the duress wipe, Step 11). */
  clear(): void;
}

export class InMemoryEventStore implements EventStore {
  protected byId = new Map<string, Event>();
  /**
   * Per-kind index: kind → (id → Event). Almost every read is kind-scoped (the feed alone fires
   * ~13 kind queries per snapshot, up to ~10×/s during the relay firehose). Without this index
   * each `query` copied+sorted the ENTIRE store, so cost scaled with total cache size and the
   * giant short-lived arrays churned the GC into intermittent pauses — the felt "sometimes laggy".
   * Indexing by kind makes each query touch only its kind's events (most kinds hold a handful).
   */
  private byKind = new Map<number, Map<string, Event>>();

  // ---------------------------------------------------------------------------
  // Version counters — O(1) mutation tracking for upstream cache-invalidation.
  // A caller snapshots kindVersion(k) or versionOf(kinds), then later compares
  // to the new value; inequality means at least one relevant event was added or
  // removed since the snapshot, so a recompute is warranted.
  // ---------------------------------------------------------------------------
  private _globalVersion = 0;
  private _kindVersions = new Map<number, number>();

  /** Increment both the per-kind counter and the global counter for `kind`. O(1). */
  private bumpKind(kind: number): void {
    this._globalVersion++;
    this._kindVersions.set(kind, (this._kindVersions.get(kind) ?? 0) + 1);
  }

  /** Current version for a single kind. Returns 0 if the kind has never been mutated. */
  kindVersion(kind: number): number {
    return this._kindVersions.get(kind) ?? 0;
  }

  /**
   * A cheap combined value that changes iff any of the given kinds changed since the last call.
   * Callers compare the return value across two points in time:
   *   const v = store.versionOf([1, 6]);
   *   // ... later ...
   *   if (store.versionOf([1, 6]) !== v) { recompute(); }
   * The value is a simple sum of per-kind counters — not cryptographically stable, but
   * guaranteed to differ whenever any of the named kinds is mutated (counters only go up).
   */
  versionOf(kinds: number[]): number {
    let sum = 0;
    for (const k of kinds) {
      sum += this._kindVersions.get(k) ?? 0;
    }
    return sum;
  }

  /** Global monotone counter incremented on every successful save or remove. */
  version(): number {
    return this._globalVersion;
  }

  /** Add an event to the per-kind index. Protected so subclasses loading a cache can reuse it. */
  protected index(event: Event): void {
    let bucket = this.byKind.get(event.kind);
    if (!bucket) {
      bucket = new Map();
      this.byKind.set(event.kind, bucket);
    }
    bucket.set(event.id, event);
  }

  private deindex(event: Event): void {
    const bucket = this.byKind.get(event.kind);
    if (bucket) {
      bucket.delete(event.id);
      if (bucket.size === 0) this.byKind.delete(event.kind);
    }
  }

  save(event: Event): boolean {
    if (this.byId.has(event.id)) {
      return false;
    }
    this.byId.set(event.id, event);
    this.index(event);
    this.bumpKind(event.kind); // increment per-kind + global version counters
    return true;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  getById(id: string): Event | undefined {
    return this.byId.get(id);
  }

  remove(id: string): boolean {
    const event = this.byId.get(id);
    if (!event) return false;
    this.byId.delete(id);
    this.deindex(event);
    this.bumpKind(event.kind); // increment per-kind + global version counters
    return true;
  }

  /**
   * Scoped cache-clear (see EventStore.deleteCachedEvents). Collect the doomed ids first (byId is not
   * mutated during collection), then remove() each — so byId/byKind stay consistent and each removed
   * kind's version counter bumps, invalidating the feed/overlay caches exactly as a save would.
   * NON-EXEMPT kinds ONLY: DMs and every durable-state kind ({@link isCacheExempt}) are always kept.
   */
  deleteCachedEvents(opts: CacheDeleteOpts = {}): number {
    const cutoff = opts.olderThanSeconds ?? Number.MAX_SAFE_INTEGER;
    const kindFilter = opts.kinds ? new Set(opts.kinds) : null;
    const doomed: string[] = [];
    for (const e of this.byId.values()) {
      if (isCacheExempt(e.kind)) continue;
      if (kindFilter && !kindFilter.has(e.kind)) continue;
      if (e.created_at < cutoff) doomed.push(e.id);
    }
    for (const id of doomed) this.remove(id);
    return doomed.length;
  }

  /** Cheap preview of {@link deleteCachedEvents}: count matching non-exempt events without deleting. */
  cachedEventCount(opts: CacheDeleteOpts = {}): number {
    const cutoff = opts.olderThanSeconds ?? Number.MAX_SAFE_INTEGER;
    const kindFilter = opts.kinds ? new Set(opts.kinds) : null;
    let n = 0;
    for (const e of this.byId.values()) {
      if (isCacheExempt(e.kind)) continue;
      if (kindFilter && !kindFilter.has(e.kind)) continue;
      if (e.created_at < cutoff) n++;
    }
    return n;
  }

  query(q: FeedQuery): Event[] {
    let events: Event[];
    if (q.kinds) {
      // Gather only the requested kinds' buckets instead of scanning the whole store.
      events = [];
      for (const kind of q.kinds) {
        const bucket = this.byKind.get(kind);
        if (bucket) {
          for (const e of bucket.values()) events.push(e);
        }
      }
    } else {
      // No kinds filter: unavoidable full-scan path — semantics require all events.
      events = [...this.byId.values()];
    }
    if (q.authors) {
      // Set membership avoids an O(authors) scan per event for multi-author queries.
      const authors = q.authors.length > 3 ? new Set(q.authors) : null;
      events = events.filter(e => (authors ? authors.has(e.pubkey) : q.authors!.includes(e.pubkey)));
    }
    // Skip the sort when the caller opted out (see FeedQuery.unordered) — but `limit` means "top-N by
    // recency", so a limited query always needs the sort even if `unordered` was set on it.
    if (!q.unordered || q.limit != null) {
      events.sort((a, b) => b.created_at - a.created_at);
    }
    if (q.limit != null) {
      events = events.slice(0, q.limit);
    }
    return events;
  }

  getPosts(limit?: number): Event[] {
    return this.query({kinds: [Kind.Post], limit});
  }

  latestCreatedAt(kinds?: number[]): number | undefined {
    let max: number | undefined;
    if (kinds) {
      // Use the per-kind index so we only iterate the relevant buckets instead of
      // scanning the entire byId map (which previously made this O(total events)
      // even when each kind bucket is tiny).
      for (const kind of kinds) {
        const bucket = this.byKind.get(kind);
        if (!bucket) continue;
        for (const event of bucket.values()) {
          if (max === undefined || event.created_at > max) {
            max = event.created_at;
          }
        }
      }
    } else {
      // No kinds filter: scan everything (unavoidable full-scan path).
      for (const event of this.byId.values()) {
        if (max === undefined || event.created_at > max) {
          max = event.created_at;
        }
      }
    }
    return max;
  }

  size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
    this.byKind.clear();
    this._kindVersions.clear();
    this._globalVersion++; // signal to observers that the store changed
  }
}

/** Cap the persisted blob: keep the newest N events so the file can't grow without bound. */
const MAX_PERSISTED_EVENTS = 2000;
/** Coalesce a burst of incoming events into one write. */
const FLUSH_DEBOUNCE_MS = 1500;
/**
 * Yield back to the JS event loop after serializing this many events, so flushing a large
 * (up to MAX_PERSISTED_EVENTS) cache never stalls the thread in one synchronous burst.
 */
const SERIALIZE_YIELD_EVERY = 250;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Serialize `events` to exactly the JSON text `JSON.stringify(events)` would produce, but
 * incrementally — one event at a time, yielding back to the event loop every
 * {@link SERIALIZE_YIELD_EVERY} events — so a large flush doesn't block the JS thread in a
 * single synchronous stall. Exported for the equivalence test.
 */
export async function serializeEventsCooperatively(events: Event[]): Promise<string> {
  const parts: string[] = new Array(events.length);
  for (let i = 0; i < events.length; i++) {
    parts[i] = JSON.stringify(events[i]);
    if ((i + 1) % SERIALIZE_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  return `[${parts.join(',')}]`;
}

/**
 * Persistent event cache backed by the hardware-encrypted SecureStorage (one AES-256-GCM
 * file). Used when the SQLCipher/op-sqlite store isn't available so the feed still survives an
 * app restart instead of living only in RAM. Reads are in-memory (fast); writes are debounced
 * and capped. Encrypted at rest by the Keystore master key, so a seized device can't read it.
 */
export class PersistentEventStore extends InMemoryEventStore {
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** True while a flush (serialize + storage write) is in flight. */
  private flushRunning = false;
  /**
   * Set when a flush is requested while one is already running, so the in-flight flush
   * re-serializes and re-writes exactly once more after it finishes instead of a second
   * flush overlapping the first (which could otherwise write torn/interleaved state).
   */
  private flushDirty = false;

  private constructor(
    private readonly storage: SecureStorage,
    /** Secure-storage key holding this community's JSON-serialized event cache. */
    private readonly cacheItem: string,
  ) {
    super();
  }

  /**
   * Load the (community, account) previously persisted events, then return a ready store. Each
   * ACCOUNT gets its own encrypted cache blob (`stiq.events.cache.<cid>.<slot>`) for COMPLETE
   * per-account isolation (finding #4) — so two accounts in one community never mix their feeds/DM
   * gift-wraps; omitting `cid` targets the legacy global blob (pre-silo / un-enrolled), omitting only
   * `slotId` the pre-per-account per-cid blob. Never throws.
   */
  static async create(
    storage: SecureStorage,
    cid?: string,
    slotId?: string,
  ): Promise<PersistentEventStore> {
    const store = new PersistentEventStore(storage, cid ? eventsCacheKey(cid, slotId) : LEGACY_EVENTS_CACHE);
    try {
      const raw = await storage.getItem(store.cacheItem);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          for (const e of arr) {
            if (e && typeof (e as Event).id === 'string') {
              store.byId.set((e as Event).id, e as Event);
              store.index(e as Event); // keep the per-kind index consistent with the loaded cache
            }
          }
        }
      }
    } catch {
      // corrupt/absent cache — start empty
    }
    return store;
  }

  override save(event: Event): boolean {
    const added = super.save(event);
    if (added) {
      this.scheduleFlush();
    }
    return added;
  }

  override remove(id: string): boolean {
    const removed = super.remove(id);
    if (removed) this.scheduleFlush();
    return removed;
  }

  override clear(): void {
    super.clear();
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    void this.storage.removeItem(this.cacheItem).catch(() => undefined);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return; // a flush is already pending; it will capture this event too
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushRunning) {
      // A flush is already serializing/writing; mark dirty so it re-runs once more after it
      // completes rather than a second write racing (and possibly interleaving with) the first.
      this.flushDirty = true;
      return;
    }
    this.flushRunning = true;
    try {
      do {
        this.flushDirty = false;
        try {
          const newest = this.query({limit: MAX_PERSISTED_EVENTS});
          const serialized = await serializeEventsCooperatively(newest);
          await this.storage.setItem(this.cacheItem, serialized);
        } catch {
          // best effort — the in-memory copy is still served this session
        }
      } while (this.flushDirty);
    } finally {
      this.flushRunning = false;
    }
  }
}

/** The subset of the concrete store's version API that upstream cache-invalidation duck-types on. */
interface VersionedStore {
  version?(): number;
  versionOf?(kinds: number[]): number;
  kindVersion?(kind: number): number;
}

/**
 * SwappableEventStore — an EventStore facade whose backing store can be swapped at runtime.
 *
 * The community switch replaces the ENTIRE event cache (each community has its own encrypted DB
 * file). Both the AppRuntime and the RelayClient hold the store by reference, so rather than
 * rebuild every consumer on a switch, they hold THIS wrapper and the switch just calls
 * {@link setInner}. The relay writes and the feed reads then transparently follow the active
 * community's store. (The switch tears the relay down before swapping and rebuilds it after, so no
 * write is ever in flight across a swap.)
 *
 * The version counters (`version`/`versionOf`/`kindVersion`) that drive the feed/channel caches are
 * passed through with a monotone base added, so a swap ALWAYS registers as a change upstream even
 * though the incoming inner store's counters start at 0 — the cache can never mistake community B's
 * fresh store for an unchanged community A.
 */
export class SwappableEventStore implements EventStore {
  private base = 0;

  constructor(private inner: EventStore) {}

  /** The current backing store (e.g. to persist/flush it before a swap). */
  get current(): EventStore {
    return this.inner;
  }

  /** Swap the backing store (community switch). Advances the version base so caches recompute. */
  setInner(inner: EventStore): void {
    this.base = this.version() + 1;
    this.inner = inner;
  }

  save(event: Event): boolean {
    return this.inner.save(event);
  }
  saveNew(event: Event): boolean {
    return this.inner.saveNew?.(event) ?? this.inner.save(event);
  }
  saveNewBatch(events: Event[]): Event[] {
    if (this.inner.saveNewBatch) return this.inner.saveNewBatch(events);
    return events.filter(event => this.inner.saveNew?.(event) ?? this.inner.save(event));
  }
  has(id: string): boolean {
    return this.inner.has(id);
  }
  getById(id: string): Event | undefined {
    return this.inner.getById(id);
  }
  query(q: FeedQuery): Event[] {
    return this.inner.query(q);
  }
  getPosts(limit?: number): Event[] {
    return this.inner.getPosts(limit);
  }
  latestCreatedAt(kinds?: number[]): number | undefined {
    return this.inner.latestCreatedAt(kinds);
  }
  size(): number {
    return this.inner.size();
  }
  remove(id: string): boolean {
    return this.inner.remove?.(id) ?? false;
  }
  deleteCachedEvents(opts?: CacheDeleteOpts): number {
    return this.inner.deleteCachedEvents?.(opts) ?? 0;
  }
  /**
   * Chunked, yielding bucket warm (SqliteEventStore.warmKindChunked) — resolves immediately for a
   * backing store without one (in-memory/jest, where every bucket is already RAM).
   */
  warmKindChunked(kind: number, chunkRows?: number): Promise<void> {
    const inner = this.inner as {warmKindChunked?: (k: number, c?: number) => Promise<void>};
    return inner.warmKindChunked?.(kind, chunkRows) ?? Promise.resolve();
  }
  cachedEventCount(opts?: CacheDeleteOpts): number {
    return this.inner.cachedEventCount?.(opts) ?? 0;
  }
  clear(): void {
    this.inner.clear();
  }

  // Version passthrough (+base) so duck-typed cache invalidation keeps working across swaps.
  version(): number {
    return this.base + ((this.inner as VersionedStore).version?.() ?? 0);
  }
  versionOf(kinds: number[]): number {
    return this.base + ((this.inner as VersionedStore).versionOf?.(kinds) ?? 0);
  }
  kindVersion(kind: number): number {
    return this.base + ((this.inner as VersionedStore).kindVersion?.(kind) ?? 0);
  }
}
