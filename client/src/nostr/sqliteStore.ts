/**
 * SqliteEventStore — persistent cache implementing EventStore (PLAN.md Step 5).
 *
 * SCAFFOLD: the SQLite driver (op-sqlite / react-native-quick-sqlite) is native and cannot
 * run in jest, so the in-memory store is used in tests. Wire this up during the native
 * build. The schema below is the contract.
 *
 *   CREATE TABLE IF NOT EXISTS events (
 *     id          TEXT PRIMARY KEY,
 *     pubkey      TEXT NOT NULL,
 *     created_at  INTEGER NOT NULL,
 *     kind        INTEGER NOT NULL,
 *     tags        TEXT NOT NULL,   -- JSON
 *     content     TEXT NOT NULL,
 *     sig         TEXT NOT NULL,
 *     raw         TEXT NOT NULL    -- full event JSON
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_events_kind_created ON events(kind, created_at DESC);
 *   CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
 *
 * Notes:
 *  - INSERT OR IGNORE on id provides dedupe; the boolean `save` returns is `changes > 0`.
 *  - This cache holds ONLY public events and gift-wrapped (encrypted) DMs. Decrypted DM
 *    plaintext is never written here (PLAN.md §4.1 / Step 16), and the whole cache is wiped
 *    by the duress flow (Step 11).
 *
 * MEMORY-FIRST (perf): SQLite is the durable write-behind, but reads are served from an
 * in-memory per-kind index (the same shape InMemoryEventStore keeps). Previously every
 * query() ran a synchronous SELECT and JSON.parse'd the `raw` of EVERY matching row on
 * EVERY call — and AppRuntime.getSnapshot fires ~6+ full-bucket queries per emit (up to
 * 4/s during sync) while buildFeed fires ~9 kind queries per rebuild, so thousands of
 * redundant JSON.parse allocations/sec churned the single JS thread's GC. Now each kind's
 * bucket is SELECT'd + parsed ONCE (lazily, on first touch) and thereafter served parse-free
 * from RAM. Communities are hundreds-to-low-thousands of events, so a full mirror is cheap.
 */
import type {Event} from 'nostr-tools/pure';
import type {EventStore, FeedQuery, CacheDeleteOpts} from './store';
import {isCacheExempt, isReplaceableOrAddressable} from './cacheExempt';
import {COMPACTION_V2} from '../config';

// ─── Bounded retention (off-boot prune) ──────────────────────────────────────────────────────────
// The durable cache was unbounded and unpruned, so cold start scaled with app age: warmKind() runs
// SELECT+JSON.parse over EVERY row of a kind on first touch, and kind-7 reactions accumulate fastest,
// so a months-old install parsed tens of thousands of rows before first paint. A one-shot prune
// (scheduled OFF the boot critical path — see scheduleRetentionPrune) trims the OLDEST rows of the
// high-volume timeline kinds down to the caps below, keeping the newest, so warmKind() stays cheap
// forever. Caps are GENEROUS BY DESIGN: this is an offline-first client, so a user must keep a deep
// local scrollback of the history they'd actually scroll to even after weeks offline.

/** Reactions (NIP-25 kind 7) accumulate fastest — one per vote — so they get the largest bucket. */
export const REACTION_RETENTION = 8000;
/**
 * Rows parsed per macrotask by {@link SqliteEventStore.warmKindChunked}: small enough that one chunk
 * (SELECT + JSON.parse) stays well under a frame budget on a mid-range device, large enough that the
 * biggest bucket (REACTION_RETENTION) drains in a handful of yields.
 */
export const WARM_CHUNK_ROWS = 500;
/** Every other prunable (non-exempt) timeline kind: posts, comments, channel/group messages, etc. */
export const TIMELINE_RETENTION = 3000;

/**
 * Mutable retention policy read at prune time (COMPACTION_V2). The two caps replace the formerly
 * hardcoded {@link REACTION_RETENTION}/{@link TIMELINE_RETENTION} constants; the optional age bound
 * and the collapse toggle drive the new compaction passes. DEFAULTS reproduce today's behavior exactly
 * (no age bound), so a store built without a policy — or with the COMPACTION_V2 flag off — prunes
 * byte-for-byte as it does today. T16-S2 hot-updates this from an organizer stiq:storage doc.
 */
export interface RetentionPolicy {
  /** Count cap for kind-7 reactions (the largest bucket). */
  reactionCap: number;
  /** Count cap for every other prunable (non-exempt) timeline kind. */
  timelineCap: number;
  /** Max age (unix-seconds) beyond which non-exempt rows are age-expired. Unset = no age bound. */
  maxAgeSeconds?: number;
  /** Whether superseded replaceable/addressable versions may be collapsed. */
  collapseReplaceable: boolean;
}

/** Defaults preserve today's caps with no age bound and no collapse toggle set. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  reactionCap: REACTION_RETENTION,
  timelineCap: TIMELINE_RETENTION,
  collapseReplaceable: false,
};

/** Delay before the one-shot retention prune fires, so it never competes with first paint / warm. */
const PRUNE_DELAY_MS = 5000;

// The prune and the user-driven scoped cache-clear share ONE exempt predicate ({@link isCacheExempt},
// nostr/cacheExempt.ts) so "what a cache clear must never touch" can never drift between them: DMs
// (gift wraps) plus every durable/replaceable/addressable STATE event are always kept. Re-exported
// here so existing callers/tests can keep importing the retention name.
const isRetentionExempt = isCacheExempt;

/**
 * The addressable d-tag of a row's stored `tags` JSON: the value of the first `['d', …]` tag, or ''
 * (the empty-address bucket, which covers plain replaceable kinds like 0/3/10000 that carry no d-tag).
 * Tolerant of malformed JSON — a row that won't parse is grouped under the empty address rather than
 * throwing, so one bad row can't abort a whole collapse pass.
 */
function dTagOf(tagsJson: string): string {
  try {
    const tags = JSON.parse(tagsJson) as unknown[];
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (Array.isArray(t) && t[0] === 'd') return typeof t[1] === 'string' ? t[1] : '';
      }
    }
  } catch {
    // fall through to the empty address
  }
  return '';
}

/**
 * The NIP-40 `expiration` unix-seconds value from a row's stored `tags` JSON, or undefined when the
 * event carries no (finite) expiration tag. Tolerant of malformed JSON.
 */
function expirationOf(tagsJson: string): number | undefined {
  try {
    const tags = JSON.parse(tagsJson) as unknown[];
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (Array.isArray(t) && t[0] === 'expiration' && t[1] != null) {
          const v = Number(t[1]);
          if (Number.isFinite(v)) return v;
        }
      }
    }
  } catch {
    // no usable expiration
  }
  return undefined;
}

// The minimal surface we need from the native SQLite driver.
export interface SqliteDb {
  execute(sql: string, params?: unknown[]): {rows: {_array: unknown[]}; rowsAffected: number};
  /** Release the underlying native handle. Optional — absent on the jest/in-memory adapter. */
  close?(): void;
}

export class SqliteEventStore implements EventStore {
  // Per-kind + global version counters — the SAME O(1) mutation-tracking InMemoryEventStore exposes,
  // so upstream feed/channel caches (AppRuntime._cachedBuildFeed keys on versionOf(FEED_KINDS)) can
  // detect a change and recompute. WITHOUT these, versionOf is absent → SwappableEventStore's
  // passthrough returns a constant `base`, feedVer never advances on save, and an optimistic post is
  // silently swallowed by a stale feed-cache hit (renders only after a full reload). In-memory and
  // reset per store instance: they track intra-session changes, and a fresh instance (app restart /
  // community swap) always rebuilds the feed from scratch, so starting at 0 is correct.
  private _globalVersion = 0;
  private readonly _kindVersions = new Map<number, number>();

  // ---------------------------------------------------------------------------
  // In-memory mirror (parse-free reads). `byKind` mirrors the durable rows; a kind's bucket is
  // populated lazily the first time it is touched (SELECT + parse once), then `_warm` marks it so
  // subsequent reads never hit SQLite. `byId` is the union of every warm bucket plus every event
  // saved this session, used by getById's fast path. `_size` tracks the durable COUNT(*) so size()
  // stays correct without re-querying (bootstrapped once, maintained incrementally on save/clear).
  // ---------------------------------------------------------------------------
  private readonly byKind = new Map<number, Map<string, Event>>();
  private readonly byId = new Map<string, Event>();
  private readonly _warm = new Set<number>();
  private _size = 0;

  // Handle for the one-shot retention prune (scheduleRetentionPrune), so close()/clear() can cancel a
  // pending run before the DB handle is released. `_closed` short-circuits a prune that fires (or is
  // mid-yield) after the store is torn down, so it never touches a released native handle.
  private _pruneTimer: ReturnType<typeof setTimeout> | undefined;
  private _closed = false;

  // In-flight chunked warms (warmKindChunked), one per kind, so concurrent callers coalesce on the
  // same pass instead of double-parsing the bucket. `_clearGen` is bumped by clear(): a wholesale
  // wipe mid-warm must ABORT the pass (never mark the kind warm over a half-indexed mirror).
  private readonly _chunkWarms = new Map<number, Promise<void>>();
  private _clearGen = 0;

  // Mutable retention policy (COMPACTION_V2). Defaults reproduce today's caps; read at prune time so a
  // setRetentionPolicy() between prunes (T16-S2 org hot-update) takes effect on the NEXT run.
  private policy: RetentionPolicy;

  // Optional post-compaction observer (T16-S3). Fired at the END of a pruneRetention that actually
  // removed rows, and ONLY when COMPACTION_V2 is on. App wiring builds + persists a durable feed-state
  // snapshot in it so aggressive compaction never blanks the cold-boot feed. Undefined by default →
  // inert (ship-dark: the flag-off store never fires it, so there are no snapshot writes at all).
  private compactionObserver?: (store: SqliteEventStore) => void;

  constructor(private readonly db: SqliteDb, policy?: Partial<RetentionPolicy>) {
    this.policy = {...DEFAULT_RETENTION_POLICY, ...(policy ?? {})};
    this.db.execute(
      `CREATE TABLE IF NOT EXISTS events (
         id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
         kind INTEGER NOT NULL, tags TEXT NOT NULL, content TEXT NOT NULL,
         sig TEXT NOT NULL, raw TEXT NOT NULL);`,
    );
    this.db.execute(
      'CREATE INDEX IF NOT EXISTS idx_events_kind_created ON events(kind, created_at DESC);',
    );
    // Plain (kind) index: warmKindChunked paginates on `WHERE kind=? AND rowid>? ORDER BY rowid`,
    // which the composite (kind, created_at DESC) index above doesn't serve well (rowid isn't its
    // trailing column). IF NOT EXISTS makes this self-apply to existing DBs — no migration needed.
    this.db.execute('CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);');
    // Bootstrap the durable row count once so size() is correct even for a reopened file that
    // already holds rows. Maintained incrementally by save()/clear() thereafter.
    const row = this.db.execute('SELECT COUNT(*) AS n FROM events;').rows._array[0] as
      | {n: number}
      | undefined;
    this._size = row?.n ?? 0;
    this.scheduleRetentionPrune();
  }

  /**
   * Shallow-merge `policy` into the active retention policy; the change takes effect on the NEXT
   * pruneRetention (caps are read per-run). Used by T16-S2 to apply an organizer-published
   * stiq:storage doc to a live per-community store without reopening it. No prune is triggered here.
   */
  setRetentionPolicy(policy: Partial<RetentionPolicy>): void {
    this.policy = {...this.policy, ...policy};
  }

  /**
   * Register (or clear, with undefined) the post-compaction observer fired at the END of a
   * pruneRetention that actually compacted rows — ONLY when COMPACTION_V2 is on. T16-S3 wires this to
   * build + persist a durable feed-state snapshot (feedSnapshot.ts) so compaction never blanks the
   * cold-boot feed or forces a big Tor re-fetch. The store stays storage-agnostic: it never imports
   * SecureStorage; the observer owns all persistence I/O.
   */
  setCompactionObserver(cb: ((store: SqliteEventStore) => void) | undefined): void {
    this.compactionObserver = cb;
  }

  /** Retention cap for a prunable kind, read from the mutable policy (reactions get the larger bucket). */
  private retentionCapFor(k: number): number {
    return k === 7 ? this.policy.reactionCap : this.policy.timelineCap; // kind 7 = NIP-25 reaction
  }

  /** Insert `event` into the in-memory mirror (id-keyed Maps dedupe). */
  private index(event: Event): void {
    this.byId.set(event.id, event);
    let bucket = this.byKind.get(event.kind);
    if (!bucket) {
      bucket = new Map();
      this.byKind.set(event.kind, bucket);
    }
    bucket.set(event.id, event);
  }

  /**
   * Ensure kind `k`'s bucket is loaded from SQLite. Runs exactly one SELECT+parse per kind for the
   * store's lifetime; a warm kind is served entirely from RAM afterwards. Events saved this session
   * are already in the bucket via index(); the id-keyed Map dedupes them against the loaded rows, so
   * warming after saves neither double-counts nor loses a local write.
   */
  private warmKind(k: number): void {
    if (this._warm.has(k)) return;
    const rows = this.db.execute('SELECT raw FROM events WHERE kind = ?;', [k]).rows._array as {
      raw: string;
    }[];
    for (const r of rows) this.index(JSON.parse(r.raw) as Event);
    this._warm.add(k);
  }

  /**
   * Warm kind `k`'s bucket like {@link warmKind}, but in bounded row chunks with a yield between
   * chunks, so a huge bucket (kind-7 reactions can hold up to {@link REACTION_RETENTION} rows) never
   * SELECTs + JSON.parses in ONE macrotask — the single biggest measured JS-thread block of the
   * post-unlock scored feed pass. Chunks paginate on the table's implicit `rowid` (stable across
   * mid-warm DELETEs, unlike LIMIT/OFFSET, which would skip or re-read rows as earlier ones vanish).
   *
   * DELETE-RACE GUARD: every targeted delete path (remove / pruneKind / deleteIdsForKind /
   * deleteKindOlderThan) removes ids from the durable table AND the RAM mirror in the same
   * synchronous block, so a row this warm already indexed that is deleted between chunks is scrubbed
   * from the mirror by that same delete, and a row deleted before its chunk is SELECTed simply never
   * appears — no resurrection either way. Rows saved mid-warm get higher rowids and may be re-read by
   * a later chunk; the id-keyed Map dedupes them (same property the sync warm relies on). The only
   * WHOLESALE mutations are clear() (duress wipe) and close(): `_clearGen`/_closed abort the pass
   * without marking the kind warm, so a later read re-warms from the (now-empty or reopened) truth.
   *
   * Coalesces: concurrent calls for the same kind share one in-flight pass. A sync warmKind() racing
   * ahead of this simply completes the bucket first — the pass sees `_warm` and stops re-indexing.
   */
  warmKindChunked(k: number, chunkRows = WARM_CHUNK_ROWS): Promise<void> {
    if (this._warm.has(k) || this._closed) return Promise.resolve();
    const inFlight = this._chunkWarms.get(k);
    if (inFlight) return inFlight;
    const rows = Math.max(1, Math.trunc(chunkRows));
    const run = (async (): Promise<void> => {
      const gen = this._clearGen;
      let afterRowid = -1;
      for (;;) {
        if (this._closed || this._clearGen !== gen) return; // wiped/closed mid-warm — never mark warm
        if (this._warm.has(k)) return; // a sync warmKind() completed the bucket while we yielded
        const chunk = this.db.execute(
          'SELECT rowid AS r, raw FROM events WHERE kind = ? AND rowid > ? ORDER BY rowid LIMIT ?;',
          [k, afterRowid, rows],
        ).rows._array as {r: number; raw: string}[];
        for (const row of chunk) this.index(JSON.parse(row.raw) as Event);
        if (chunk.length < rows) break; // short chunk = bucket drained
        afterRowid = chunk[chunk.length - 1]!.r;
        await new Promise<void>(resolve => setTimeout(resolve, 0)); // let touch/render run
      }
      if (!this._closed && this._clearGen === gen) this._warm.add(k);
    })().finally(() => this._chunkWarms.delete(k));
    this._chunkWarms.set(k, run);
    return run;
  }

  /** Increment the per-kind + global counters for `kind`. O(1). */
  private bumpKind(kind: number): void {
    this._globalVersion++;
    this._kindVersions.set(kind, (this._kindVersions.get(kind) ?? 0) + 1);
  }

  /** Monotonic global mutation counter (any kind). */
  version(): number {
    return this._globalVersion;
  }

  /** Current version for a single kind (0 if never mutated). */
  kindVersion(kind: number): number {
    return this._kindVersions.get(kind) ?? 0;
  }

  /** Combined counter that changes iff any of `kinds` was added/removed since the last read. */
  versionOf(kinds: number[]): number {
    let sum = 0;
    for (const k of kinds) sum += this._kindVersions.get(k) ?? 0;
    return sum;
  }

  /**
   * Release the native SQLCipher connection. Called on a community switch when this store is swapped
   * out (AppRuntime.swapActiveStore) so op-sqlite handles don't leak one-per-switch, and by the
   * headless background sync when its task ends. No-op when the driver doesn't expose close
   * (jest/in-memory). The in-memory mirror is dropped with the instance — nothing references it after.
   */
  close(): void {
    this._closed = true;
    if (this._pruneTimer !== undefined) {
      clearTimeout(this._pruneTimer);
      this._pruneTimer = undefined;
    }
    this.db.close?.();
  }

  /**
   * Arm the one-shot retention prune. It runs {@link PRUNE_DELAY_MS} AFTER construction — deliberately
   * OFF the boot critical path — so a long-lived cache never makes cold start scale with app age, yet
   * first paint and the initial warm never wait on it. Fire-and-forget: a cache is best-effort, so any
   * failure (e.g. the DB closed underneath it) is swallowed. `unref` (present under Node/jest) keeps
   * the pending timer from holding the process open; on-device setTimeout has no unref and the prune
   * simply fires. Tests drive pruneRetention() directly instead of waiting on this timer.
   */
  private scheduleRetentionPrune(): void {
    const timer = setTimeout(() => {
      this._pruneTimer = undefined;
      void this.pruneRetention().catch(() => {});
    }, PRUNE_DELAY_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
    this._pruneTimer = timer;
  }

  /**
   * Trim the OLDEST rows of every high-volume, non-exempt timeline kind down to its retention cap
   * ({@link retentionCapFor}), keeping the newest. Exempt kinds — DMs plus all durable state, see
   * {@link isRetentionExempt} — are never touched. Runs entirely off the durable store using ids +
   * counts only (NO `raw`, NO JSON.parse), so it never pays the warm cost it exists to shrink; YIELDS
   * to the event loop between kinds so trimming a huge bucket can't jank a frame; and keeps the
   * in-memory mirror, `_size` and the per-kind version counters in lockstep so downstream feed/channel
   * caches invalidate exactly as they do on save()/remove(). Returns the number of rows pruned. Public
   * so tests can drive it deterministically (the constructor otherwise schedules it on a timer).
   */
  async pruneRetention(): Promise<number> {
    if (this._closed) return 0;
    // One cheap index-only scan for the per-kind population — no rows are materialized or parsed.
    const counts = this.db.execute('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind;').rows
      ._array as {kind: number; n: number}[];
    let pruned = 0;
    for (const {kind, n} of counts) {
      if (this._closed) break;
      if (isRetentionExempt(kind)) continue;
      const cap = this.retentionCapFor(kind);
      if (n <= cap) continue;
      const dropped = this.pruneKind(kind, cap);
      if (dropped > 0) {
        pruned += dropped;
        // Yield between kinds so a big prune can't block a touch/frame in one synchronous burst.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    // COMPACTION_V2 (ship-dark): AFTER the count-cap trim, collapse superseded replaceable/addressable
    // versions and expire transient rows (age + NIP-40). Gated on the flag so the flag-OFF store runs
    // exactly today's count-cap prune with no new SQL and no extra deletions. Each new pass yields once
    // so a large collapse/expiry can't jank a frame — same discipline as the per-kind loop above.
    if (COMPACTION_V2 && !this._closed) {
      pruned += this.pruneSupersededReplaceable();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      pruned += this.expireEphemeral(Math.floor(Date.now() / 1000));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    // COMPACTION_V2 durable feed-state snapshot hook (T16-S3): after a real compaction removed rows,
    // notify the (optional, injected) observer so App wiring can build + persist a feed snapshot —
    // recording the per-kind high-water + newest post ids BEFORE aggressive age-expiry could shrink
    // them, so a cold boot never blanks the feed nor re-streams a big window over Tor. Gated on the flag
    // so the flag-OFF store never fires it (ship-dark: no snapshot writes, byte-identical to today) and
    // skipped entirely when nothing was pruned (no needless re-serialize).
    if (COMPACTION_V2 && pruned > 0 && !this._closed) {
      this.compactionObserver?.(this);
    }
    return pruned;
  }

  /**
   * Delete kind `k`'s rows older than the newest `cap`, then bring the RAM mirror, `_size` and the
   * per-kind version counter back in step. Selects only the doomed ids (never `raw`), and DELETEs via
   * the SAME ordered-window subquery rather than an id list — so it stays within SQLite's bound-
   * variable limit no matter how many rows are trimmed. Returns how many rows were removed.
   */
  private pruneKind(k: number, cap: number): number {
    // The oldest rows beyond the newest `cap` (LIMIT -1 = "no limit", OFFSET skips the kept newest).
    const doomed = this.db.execute(
      'SELECT id FROM events WHERE kind = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?;',
      [k, cap],
    ).rows._array as {id: string}[];
    if (doomed.length === 0) return 0;
    this.db.execute(
      'DELETE FROM events WHERE kind = ? AND id IN (SELECT id FROM events WHERE kind = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?);',
      [k, k, cap],
    );
    // Drop the trimmed ids from the mirror. `bucket` is present only when the kind is warm (or has
    // session saves); a cold kind's mirror never held these rows, so the deletes are no-ops there.
    const bucket = this.byKind.get(k);
    for (const {id} of doomed) {
      this.byId.delete(id);
      bucket?.delete(id);
    }
    this._size = Math.max(0, this._size - doomed.length);
    this.bumpKind(k); // invalidate downstream feed/channel caches, exactly like save()/remove()
    return doomed.length;
  }

  /**
   * COMPACTION_V2 pass 1 — collapse SUPERSEDED replaceable/addressable versions. Under Nostr semantics
   * only the newest event per (pubkey, kind[, d-tag]) is authoritative, so strictly-older versions are
   * dead weight. For each replaceable/addressable kind present ({@link isReplaceableOrAddressable}) we
   * group its rows by pubkey + d-tag, keep the winner (max created_at; ties broken by the
   * lexicographically-GREATER id, the Nostr replaceable tiebreak used here), and delete every OTHER id.
   *
   * SAFE next to {@link isRetentionExempt}: it removes ONLY strictly-older versions, so the newest
   * member of an exempt range (10000-19999 lists, 30000-39999 config) is always kept — a lone/newest
   * row (a group of one) is never touched. Deletes doomed ids in chunks within SQLite's bound-variable
   * limit, mirrors the removals into byId/byKind, decrements `_size`, and bumps each touched kind's
   * version counter EXACTLY once so downstream feed/channel caches invalidate. Returns rows removed.
   */
  private pruneSupersededReplaceable(): number {
    const kinds = (this.db.execute('SELECT DISTINCT kind FROM events;').rows._array as {
      kind: number;
    }[])
      .map(r => r.kind)
      .filter(isReplaceableOrAddressable);
    let removed = 0;
    for (const kind of kinds) {
      if (this._closed) break;
      const rows = this.db.execute(
        'SELECT id, pubkey, created_at, tags FROM events WHERE kind = ?;',
        [kind],
      ).rows._array as {id: string; pubkey: string; created_at: number; tags: string}[];
      // Group each address (pubkey + d-tag) so only its newest version is retained.
      const groups = new Map<string, {id: string; created_at: number}[]>();
      for (const r of rows) {
        const key = `${r.pubkey} ${dTagOf(r.tags)}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({id: r.id, created_at: r.created_at});
      }
      const doomed: string[] = [];
      for (const g of groups.values()) {
        if (g.length < 2) continue; // sole row for an address is the newest — never collapsed
        let winner = g[0]!;
        for (const e of g) {
          // newest wins; a created_at tie is broken by the lexicographically-greater id
          if (
            e.created_at > winner.created_at ||
            (e.created_at === winner.created_at && e.id > winner.id)
          ) {
            winner = e;
          }
        }
        for (const e of g) if (e.id !== winner.id) doomed.push(e.id);
      }
      removed += this.deleteIdsForKind(kind, doomed);
    }
    return removed;
  }

  /**
   * COMPACTION_V2 pass 2 — age/NIP-40 expiry of TRANSIENT rows. Two removals, both restricted to
   * NON-exempt kinds ({@link deletableKinds}, which already drops DMs + every durable-state family):
   *   1. If `policy.maxAgeSeconds` is set, delete every non-exempt row with created_at older than
   *      `nowSeconds - maxAgeSeconds`, reusing {@link deleteKindOlderThan} per kind. Unset = skip (so
   *      with no age bound this pass removes ONLY NIP-40-expired rows).
   *   2. A single extra scan drops any non-exempt row carrying a NIP-40 `expiration` tag whose value
   *      is already in the past (< nowSeconds), regardless of age.
   * Every removal keeps the RAM mirror, `_size` and the per-kind version counters in lockstep. Returns
   * the total rows removed.
   */
  private expireEphemeral(nowSeconds: number): number {
    let removed = 0;
    const kinds = this.deletableKinds(undefined); // non-exempt kinds present in the durable store
    // 1. Age-based expiry (only when an age bound is configured).
    if (this.policy.maxAgeSeconds != null) {
      const cutoff = nowSeconds - this.policy.maxAgeSeconds;
      for (const kind of kinds) {
        if (this._closed) break;
        removed += this.deleteKindOlderThan(kind, cutoff);
      }
    }
    // 2. NIP-40 expiration — one scan; group the already-expired ids by kind for lock-step bookkeeping.
    const scan = this.db.execute('SELECT id, kind, tags FROM events;').rows._array as {
      id: string;
      kind: number;
      tags: string;
    }[];
    const expiredByKind = new Map<number, string[]>();
    for (const r of scan) {
      if (isRetentionExempt(r.kind)) continue; // never expire a DM or a durable-state event
      const exp = expirationOf(r.tags);
      if (exp !== undefined && exp < nowSeconds) {
        let ids = expiredByKind.get(r.kind);
        if (!ids) expiredByKind.set(r.kind, (ids = []));
        ids.push(r.id);
      }
    }
    for (const [kind, ids] of expiredByKind) {
      if (this._closed) break;
      removed += this.deleteIdsForKind(kind, ids);
    }
    return removed;
  }

  /**
   * Delete `ids` (all of kind `k`) from the durable table in chunks within SQLite's bound-variable
   * limit, then bring the RAM mirror, `_size` and the per-kind version counter back in step (exactly
   * as pruneKind/deleteKindOlderThan do). Bumps the kind's version ONCE when anything was removed, so
   * downstream feed/channel caches invalidate. No-op (returns 0) for an empty id list. Shared by the
   * COMPACTION_V2 collapse + NIP-40 expiry passes.
   */
  private deleteIdsForKind(k: number, ids: string[]): number {
    if (ids.length === 0) return 0;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const placeholders = chunk.map(() => '?').join(',');
      this.db.execute(`DELETE FROM events WHERE id IN (${placeholders});`, chunk);
    }
    const bucket = this.byKind.get(k);
    for (const id of ids) {
      this.byId.delete(id);
      bucket?.delete(id);
    }
    this._size = Math.max(0, this._size - ids.length);
    this.bumpKind(k);
    return ids.length;
  }

  /**
   * User-driven scoped cache-clear (Settings → Manage data). Delete cached RECEIVED community feed
   * events matching `opts`, returning how many rows were removed.
   *
   * SAFETY: only NON-EXEMPT timeline kinds are ever touched — DMs (gift wraps), moderation reports,
   * and every durable/replaceable/addressable STATE event ({@link isCacheExempt}) are always kept,
   * exactly as the retention prune keeps them, so a "clear cache" can never delete a DM, drop a
   * channel/group definition, forget organizer config, or resurrect moderated content. Identity keys,
   * the blind-token wallet, drafts, the outbox, and joined-groups live OUTSIDE the event store, so
   * they are structurally untouchable here.
   *
   *   olderThanSeconds — only events with created_at STRICTLY less than this unix-seconds cutoff are
   *                      removed (so "older than N days" keeps everything more recent). Omit to match
   *                      any age (clear the whole non-exempt cache).
   *   kinds            — restrict deletion to these kinds (still intersected with the non-exempt set).
   *                      Omit to clear every non-exempt timeline kind.
   */
  deleteCachedEvents(opts: CacheDeleteOpts = {}): number {
    if (this._closed) return 0;
    const cutoff = opts.olderThanSeconds ?? Number.MAX_SAFE_INTEGER;
    let removed = 0;
    for (const kind of this.deletableKinds(opts.kinds)) {
      removed += this.deleteKindOlderThan(kind, cutoff);
    }
    return removed;
  }

  /** Cheap preview: how many cached deletable (non-exempt) events match `opts`. Never mutates. */
  cachedEventCount(opts: CacheDeleteOpts = {}): number {
    if (this._closed) return 0;
    const cutoff = opts.olderThanSeconds ?? Number.MAX_SAFE_INTEGER;
    let n = 0;
    for (const kind of this.deletableKinds(opts.kinds)) {
      n += (
        this.db.execute('SELECT id FROM events WHERE kind = ? AND created_at < ?;', [kind, cutoff])
          .rows._array as unknown[]
      ).length;
    }
    return n;
  }

  /**
   * The kinds a scoped clear may delete: the requested `kinds` (or every kind present in the durable
   * store when omitted), minus every exempt kind. Never returns an exempt kind, so no caller can
   * accidentally ask this store to delete a DM or a state event.
   */
  private deletableKinds(kinds?: readonly number[]): number[] {
    const present =
      kinds ??
      (this.db.execute('SELECT DISTINCT kind FROM events;').rows._array as {kind: number}[]).map(
        r => r.kind,
      );
    return present.filter(k => !isRetentionExempt(k));
  }

  /**
   * Delete kind `k`'s rows with created_at STRICTLY less than `cutoff`, then bring the RAM mirror,
   * `_size` and the per-kind version counter back in step (so downstream feed/channel caches
   * invalidate exactly as they do on save()/remove()/prune). Returns how many rows were removed.
   */
  private deleteKindOlderThan(k: number, cutoff: number): number {
    const doomed = this.db.execute('SELECT id FROM events WHERE kind = ? AND created_at < ?;', [
      k,
      cutoff,
    ]).rows._array as {id: string}[];
    if (doomed.length === 0) return 0;
    this.db.execute('DELETE FROM events WHERE kind = ? AND created_at < ?;', [k, cutoff]);
    const bucket = this.byKind.get(k);
    for (const {id} of doomed) {
      this.byId.delete(id);
      bucket?.delete(id);
    }
    this._size = Math.max(0, this._size - doomed.length);
    this.bumpKind(k);
    return doomed.length;
  }

  private insert(event: Event): void {
    this.db.execute(
      `INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        JSON.stringify(event),
      ],
    );
  }

  save(event: Event): boolean {
    // Decide "is this a NEW row?" with an indexed PRIMARY-KEY existence check BEFORE the insert,
    // NOT from the driver's rowsAffected. This is the linchpin of ALL optimistic UI: a new save must
    // bumpKind so AppRuntime._cachedBuildFeed's versionOf(FEED_KINDS) advances and the feed rebuilds
    // (post/vote appear immediately). Gating the bump on `res.rowsAffected > 0` made that whole chain
    // hostage to the native driver reporting affected rows for an INSERT OR IGNORE — if op-sqlite's
    // executeSync ever returns rowsAffected 0/undefined for an insert (driver/SQLCipher/host-object
    // quirk, or the factory adapter's `?? 0` fallback), every optimistic render silently dies until a
    // cold reload. `has()` is an O(1) lookup on the id PK index, so this stays cheap and is correct
    // regardless of what the driver reports.
    const existed = this.has(event.id);
    this.insert(event);
    if (!existed) {
      this._size++;
      this.index(event); // keep the in-memory mirror in lockstep with the durable row
      this.bumpKind(event.kind); // keep feed/channel caches invalidating on new events
    }
    return !existed;
  }

  /**
   * RelayClient already performs the indexed existence check before signature verification. Since
   * that check and this synchronous call cannot interleave on JS, avoid repeating the same SELECT
   * inside save() for every first-sync event.
   */
  saveNew(event: Event): boolean {
    this.insert(event);
    this._size++;
    this.index(event);
    this.bumpKind(event.kind);
    return true;
  }

  /**
   * Batch fast path for RelayClient's inbound drain: store multiple events with only ONE durable
   * round-trip (`BEGIN IMMEDIATE; ... COMMIT;`) instead of one autocommitting INSERT per event —
   * during a sync burst that was one fsync per row. Rolls back (and rethrows) on error, so a batch
   * either commits in full or leaves the durable table untouched.
   *
   * Unlike saveNew() (which trusts the caller's just-taken has() check), each event here is re-gated
   * on has() before it's queued for insert: a burst can legitimately contain an id already durable
   * from an earlier tick, or — rarer — the same id twice within one tick. The has() gate alone can't
   * catch that second case, though: none of this batch is durable yet while the list is being built,
   * so a local `seen` set of ids queued so far in THIS batch does the intra-batch half of the dedupe.
   *
   * Atomicity covers BOTH the durable table and the RAM mirror, not just the former: the transaction
   * contains ONLY the raw INSERTs, and `_size`/`index`/`bumpKind` are applied in a second pass AFTER
   * COMMIT succeeds. If any INSERT throws, ROLLBACK undoes the SQL and the RAM mirror was never
   * touched in the first place — so a mid-batch failure can never leave byId/byKind/_size/version
   * counters describing rows the durable table doesn't actually have. Returns the subset of `events`
   * that were newly stored (same relative order), so a caller that fires per-event listeners knows
   * exactly which ones actually changed the store.
   */
  saveNewBatch(events: Event[]): Event[] {
    const toInsert: Event[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (this.has(event.id) || seen.has(event.id)) continue; // already durable, or dup within this batch
      seen.add(event.id);
      toInsert.push(event);
    }
    if (toInsert.length === 0) return [];
    this.db.execute('BEGIN IMMEDIATE;');
    try {
      for (const event of toInsert) {
        this.insert(event);
      }
      this.db.execute('COMMIT;');
    } catch (err) {
      this.db.execute('ROLLBACK;');
      throw err; // durable table AND RAM mirror both untouched — no split between them
    }
    for (const event of toInsert) {
      this._size++;
      this.index(event);
      this.bumpKind(event.kind);
    }
    return toInsert;
  }

  /**
   * Delete one event by id: durable SQL DELETE + in-memory mirror removal + version bump, so upstream
   * caches invalidate exactly as they do on save(). Used to prune permanently-undecryptable gift wraps
   * that have aged past the NIP-59 backdating window (AppRuntime.pruneStaleWraps, finding #3). Returns
   * false when the id wasn't present. A cold (un-warmed) kind still deletes AND invalidates correctly:
   * the kind is resolved with a single-row SELECT before the DELETE, because versionOf() sums PER-KIND
   * counters only — a global-only bump would silently leave every versionOf-keyed cache (feed/overlay/
   * channels) serving the removed event. `_size` is kept accurate only when the row actually existed
   * (rowsAffected), so a reopened file's count never drifts.
   */
  remove(id: string): boolean {
    // Resolve the kind BEFORE deleting: from the RAM mirror when warm, else a single-row lookup.
    const cached = this.byId.get(id);
    let kind = cached?.kind;
    if (kind === undefined) {
      const row = this.db.execute('SELECT kind FROM events WHERE id = ?;', [id]).rows._array[0] as
        | {kind: number}
        | undefined;
      kind = row?.kind;
    }
    const res = this.db.execute('DELETE FROM events WHERE id = ?;', [id]);
    const removed = res.rowsAffected > 0;
    if (!removed) return false;
    this._size = Math.max(0, this._size - 1);
    this.byId.delete(id);
    if (kind !== undefined) {
      this.byKind.get(kind)?.delete(id);
      this.bumpKind(kind); // per-kind bump — the counter versionOf() actually reads
    } else {
      // Defensive: unreachable when rowsAffected > 0 (the pre-DELETE lookup must have seen the row),
      // but never let a successful delete go completely unsignalled.
      this._globalVersion++;
    }
    return true;
  }

  has(id: string): boolean {
    if (this.byId.has(id)) return true;
    return this.db.execute('SELECT 1 FROM events WHERE id = ?;', [id]).rows._array.length > 0;
  }

  getById(id: string): Event | undefined {
    // Fast path: any warmed bucket (or an event saved this session) already holds it in RAM.
    const cached = this.byId.get(id);
    if (cached) return cached;
    // Cold fall-through: getById must work for kinds not yet warmed. A single-row lookup is cheaper
    // than warming the whole containing bucket for one id.
    const row = this.db.execute('SELECT raw FROM events WHERE id = ?;', [id]).rows._array[0] as
      | {raw: string}
      | undefined;
    return row ? (JSON.parse(row.raw) as Event) : undefined;
  }

  query(q: FeedQuery): Event[] {
    let events: Event[];
    if (q.kinds?.length) {
      // Warm each requested kind once, then gather from RAM — no SELECT, no parse on the hot path.
      events = [];
      for (const kind of q.kinds) {
        this.warmKind(kind);
        const bucket = this.byKind.get(kind);
        if (bucket) {
          for (const e of bucket.values()) events.push(e);
        }
      }
    } else {
      // No kinds filter: semantics require ALL events. Warm every kind present in the durable store
      // (DISTINCT kind is a cheap index scan), then serve the union from RAM.
      const kinds = this.db.execute('SELECT DISTINCT kind FROM events;').rows._array as {
        kind: number;
      }[];
      for (const {kind} of kinds) this.warmKind(kind);
      events = [...this.byId.values()];
    }
    if (q.authors?.length) {
      // Set membership avoids an O(authors) scan per event for multi-author queries.
      const authors = q.authors.length > 3 ? new Set(q.authors) : null;
      events = events.filter(e => (authors ? authors.has(e.pubkey) : q.authors!.includes(e.pubkey)));
    }
    // Skip the sort when the caller opted out (see FeedQuery.unordered) — but `limit` means "top-N by
    // recency", so a limited query always needs the sort even if `unordered` was set on it.
    if (!q.unordered || q.limit != null) {
      events.sort((a, b) => b.created_at - a.created_at); // preserve created_at DESC ordering
    }
    if (q.limit != null) {
      events = events.slice(0, Math.trunc(q.limit));
    }
    return events;
  }

  getPosts(limit?: number): Event[] {
    return this.query({kinds: [1], limit});
  }

  latestCreatedAt(kinds?: number[]): number | undefined {
    let max: number | undefined;
    if (kinds?.length) {
      for (const kind of kinds) {
        this.warmKind(kind);
        const bucket = this.byKind.get(kind);
        if (!bucket) continue;
        for (const e of bucket.values()) {
          if (max === undefined || e.created_at > max) max = e.created_at;
        }
      }
      return max;
    }
    // No kinds filter: a single MAX() aggregate is cheaper than warming the whole store.
    const row = this.db.execute('SELECT MAX(created_at) AS m FROM events;').rows._array[0] as
      | {m: number | null}
      | undefined;
    return row && row.m != null ? row.m : undefined;
  }

  size(): number {
    return this._size;
  }

  clear(): void {
    this.db.execute('DELETE FROM events;');
    this.byKind.clear();
    this.byId.clear();
    this._warm.clear();
    this._clearGen++; // abort any in-flight chunked warm — it must never mark a wiped kind warm
    this._size = 0;
    this._kindVersions.clear();
    this._globalVersion++; // signal observers that the store changed
  }
}
