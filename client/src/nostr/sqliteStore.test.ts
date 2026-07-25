import type {Event} from 'nostr-tools/pure';
import {
  SqliteEventStore,
  REACTION_RETENTION,
  TIMELINE_RETENTION,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type SqliteDb,
} from './sqliteStore';
import {SwappableEventStore} from './store';
import {isReplaceableOrAddressable, isEphemeralKind} from './cacheExempt';

/**
 * A minimal fake of the native SQLite driver. It stores whole events keyed by id so it can answer
 * the store's real queries (SELECT raw ... WHERE kind = ?, SELECT COUNT(*), SELECT DISTINCT kind,
 * SELECT MAX(created_at), SELECT 1 ... WHERE id = ?) — enough to exercise the memory-first mirror:
 * the store must SELECT a kind's bucket exactly once (then serve from RAM), keep version counters
 * correct on dedupe, and expose close(). It logs every SQL statement so tests can assert on the
 * execute call pattern (e.g. that a warm bucket triggers no further SELECT).
 */
class FakeSqliteDb implements SqliteDb {
  private rows = new Map<string, Event>();
  /**
   * Pending inserts buffered between `BEGIN IMMEDIATE;` and `COMMIT;`/`ROLLBACK;`, so a real
   * mid-transaction failure test (saveNewBatch throwing partway through) is faithful: an insert
   * that ran before the throw must not be visible to has()/getById unless COMMIT actually applies
   * it — matching real SQLite instead of writing straight through regardless of the transaction.
   */
  private txBuffer: Map<string, Event> | null = null;
  /** Every SQL string passed to execute(), oldest first. Tests assert on this. */
  readonly log: string[] = [];
  closed = false;

  execute(sql: string, params: unknown[] = []): {rows: {_array: unknown[]}; rowsAffected: number} {
    this.log.push(sql);
    const none = {rows: {_array: [] as unknown[]}, rowsAffected: 0};

    if (sql === 'BEGIN IMMEDIATE;') {
      this.txBuffer = new Map();
      return none;
    }
    if (sql === 'COMMIT;') {
      if (this.txBuffer) {
        for (const [id, e] of this.txBuffer) this.rows.set(id, e);
        this.txBuffer = null;
      }
      return none;
    }
    if (sql === 'ROLLBACK;') {
      this.txBuffer = null; // discard whatever was buffered — never applied to `rows`
      return none;
    }

    if (sql.includes('INSERT OR IGNORE')) {
      const id = params[0] as string;
      const isNew = !this.rows.has(id) && !this.txBuffer?.has(id);
      // Store the row even when the fake reports rowsAffected 0 (the device failure mode): the store's
      // has()-based dedupe must still see it. insertRowsAffected lets a subclass simulate a driver that
      // never reports affected rows for an INSERT.
      if (isNew) {
        const event = JSON.parse(params[7] as string) as Event; // params[7] = raw event JSON
        (this.txBuffer ?? this.rows).set(id, event);
      }
      return {rows: {_array: []}, rowsAffected: this.insertRowsAffected(isNew)};
    }
    // ── Retention-prune statements (checked before the generic COUNT/kind/DELETE branches) ──────
    // Per-kind population for the prune's one enumeration scan: SELECT kind, COUNT(*) ... GROUP BY kind.
    if (sql.includes('GROUP BY kind')) {
      const counts = new Map<number, number>();
      for (const e of this.rows.values()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      return {rows: {_array: [...counts].map(([kind, n]) => ({kind, n}))}, rowsAffected: 0};
    }
    // ── COMPACTION_V2 statements (matched before the generic raw `WHERE kind = ?` branch below) ──────
    // Collapse pass reads (id, pubkey, created_at, tags) for one kind.
    if (sql.startsWith('SELECT id, pubkey, created_at, tags FROM events WHERE kind')) {
      const kind = params[0] as number;
      const matches = [...this.rows.values()].filter(e => e.kind === kind);
      return {
        rows: {
          _array: matches.map(e => ({
            id: e.id,
            pubkey: e.pubkey,
            created_at: e.created_at,
            tags: JSON.stringify(e.tags),
          })),
        },
        rowsAffected: 0,
      };
    }
    // NIP-40 expiry does ONE scan reading (id, kind, tags) across the whole table.
    if (sql.startsWith('SELECT id, kind, tags FROM events')) {
      return {
        rows: {
          _array: [...this.rows.values()].map(e => ({
            id: e.id,
            kind: e.kind,
            tags: JSON.stringify(e.tags),
          })),
        },
        rowsAffected: 0,
      };
    }
    // ── Scoped cache-clear statements (created_at cutoff) — matched BEFORE the prune's window scans,
    //    which share the `... WHERE kind` prefix. Used by deleteCachedEvents / cachedEventCount. ──────
    if (sql.startsWith('SELECT id FROM events WHERE kind = ? AND created_at <')) {
      const [kind, cutoff] = params as [number, number];
      const ids = [...this.rows.values()]
        .filter(e => e.kind === kind && e.created_at < cutoff)
        .map(e => e.id);
      return {rows: {_array: ids.map(id => ({id}))}, rowsAffected: 0};
    }
    if (sql.startsWith('DELETE FROM events WHERE kind = ? AND created_at <')) {
      const [kind, cutoff] = params as [number, number];
      let n = 0;
      for (const [id, e] of [...this.rows]) {
        if (e.kind === kind && e.created_at < cutoff) {
          this.rows.delete(id);
          n++;
        }
      }
      return {rows: {_array: []}, rowsAffected: n};
    }
    // The doomed window: ids of a kind's rows OLDER than the newest `offset` (created_at DESC).
    if (sql.startsWith('SELECT id FROM events WHERE kind')) {
      const ids = this.doomedIds(params[0] as number, params[1] as number);
      return {rows: {_array: ids.map(id => ({id}))}, rowsAffected: 0};
    }
    // Bulk trim: DELETE the same doomed window (kind = ?, IN (subquery ... OFFSET ?)).
    if (sql.startsWith('DELETE FROM events WHERE kind')) {
      const ids = this.doomedIds(params[0] as number, params[2] as number);
      for (const id of ids) this.rows.delete(id);
      return {rows: {_array: []}, rowsAffected: ids.length};
    }
    // Chunked collapse/expiry delete — matched BEFORE the single-id delete (whose prefix it shares).
    if (sql.startsWith('DELETE FROM events WHERE id IN')) {
      let n = 0;
      for (const id of params as string[]) if (this.rows.delete(id)) n++;
      return {rows: {_array: []}, rowsAffected: n};
    }
    if (sql.startsWith('DELETE FROM events WHERE id')) {
      const removed = this.rows.delete(params[0] as string);
      return {rows: {_array: []}, rowsAffected: removed ? 1 : 0};
    }
    if (sql.startsWith('DELETE FROM events')) {
      this.rows.clear();
      return none;
    }
    if (sql.includes('COUNT(*)')) {
      return {rows: {_array: [{n: this.rows.size}]}, rowsAffected: 0};
    }
    if (sql.includes('DISTINCT kind')) {
      const kinds = [...new Set([...this.rows.values()].map(e => e.kind))];
      return {rows: {_array: kinds.map(kind => ({kind}))}, rowsAffected: 0};
    }
    if (sql.includes('MAX(created_at)')) {
      const vals = [...this.rows.values()].map(e => e.created_at);
      return {rows: {_array: [{m: vals.length ? Math.max(...vals) : null}]}, rowsAffected: 0};
    }
    if (sql.includes('SELECT 1 FROM events WHERE id')) {
      return {rows: {_array: this.rows.has(params[0] as string) ? [{}] : []}, rowsAffected: 0};
    }
    if (sql.includes('SELECT kind FROM events WHERE id')) {
      const e = this.rows.get(params[0] as string);
      return {rows: {_array: e ? [{kind: e.kind}] : []}, rowsAffected: 0};
    }
    if (sql.includes('WHERE id = ?')) {
      const e = this.rows.get(params[0] as string);
      return {rows: {_array: e ? [{raw: JSON.stringify(e)}] : []}, rowsAffected: 0};
    }
    if (sql.includes('WHERE kind = ?')) {
      const kind = params[0] as number;
      const matches = [...this.rows.values()].filter(e => e.kind === kind);
      return {rows: {_array: matches.map(e => ({raw: JSON.stringify(e)}))}, rowsAffected: 0};
    }
    return none; // CREATE TABLE/INDEX and everything else
  }

  close(): void {
    this.closed = true;
  }

  /** SELECT statements that read a kind's RAW bucket, i.e. the parse-heavy path memory-first
   * eliminates. Matches only the warm load (`SELECT raw ...`), not the prune's id-only window scan. */
  bucketSelects(): number {
    return this.log.filter(s => s.includes('SELECT raw FROM events WHERE kind = ?')).length;
  }

  /** Rows of `kind` OLDER than the newest `offset`, created_at DESC — the prune's doomed set. */
  private doomedIds(kind: number, offset: number): string[] {
    return [...this.rows.values()]
      .filter(e => e.kind === kind)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(offset)
      .map(e => e.id);
  }

  /** How many rows the fake currently holds (for asserting prune outcomes against the durable table). */
  rowCount(): number {
    return this.rows.size;
  }
  /** rowsAffected a faithful driver reports for an INSERT OR IGNORE (1 new / 0 dup). Overridable. */
  protected insertRowsAffected(isNew: boolean): number {
    return isNew ? 1 : 0;
  }
}

/**
 * A driver that ALWAYS reports rowsAffected: 0 for an INSERT — the on-device failure mode that
 * killed optimistic UI globally. Before the fix, save() gated its version bump on rowsAffected > 0,
 * so a driver like this (op-sqlite executeSync under SQLCipher, or the adapter's `?? 0` fallback
 * when the field is missing) meant NO bump → versionOf(FEED_KINDS) never moved → the feed cache
 * kept serving a stale reference → the new post/vote rendered only after a full reload. The store
 * must now decide "new row" from an indexed PK existence check, independent of what the driver says.
 */
class RowsAffectedZeroSqliteDb extends FakeSqliteDb {
  protected override insertRowsAffected(): number {
    return 0; // pretend the driver never reports affected rows for inserts
  }
}

/**
 * A driver that throws on the Nth `INSERT OR IGNORE` it sees (1-indexed) — simulates a mid-batch SQL
 * failure so a test can assert saveNewBatch's rollback leaves the RAM mirror in lockstep with the
 * (unwound) durable table, instead of ahead of it.
 */
class ThrowingOnNthInsertSqliteDb extends FakeSqliteDb {
  private insertCount = 0;
  constructor(private readonly throwOnNth: number) {
    super();
  }

  override execute(
    sql: string,
    params: unknown[] = [],
  ): {rows: {_array: unknown[]}; rowsAffected: number} {
    if (sql.includes('INSERT OR IGNORE')) {
      this.insertCount++;
      if (this.insertCount === this.throwOnNth) {
        throw new Error('simulated mid-batch insert failure');
      }
    }
    return super.execute(sql, params);
  }
}

const ev = (id: string, kind: number, created_at = 1): Event => ({
  id,
  pubkey: 'p',
  created_at,
  kind,
  tags: [],
  content: '',
  sig: 's',
});

/** `ev` with explicit tags (d-tag / NIP-40 expiration) for the compaction passes. */
const evT = (id: string, kind: number, created_at: number, tags: string[][]): Event => ({
  ...ev(id, kind, created_at),
  tags,
});

/** Same event with a non-default pubkey (per-pubkey isolation in the collapse pass). */
const evP = (
  id: string,
  kind: number,
  created_at: number,
  pubkey: string,
  tags: string[][] = [],
): Event => ({...evT(id, kind, created_at, tags), pubkey});

describe('SqliteEventStore version counters (feed-cache invalidation)', () => {
  it('saveNew skips the duplicate SELECT after RelayClient already checked has()', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    db.log.length = 0; // ignore schema/count bootstrap

    expect(store.saveNew(ev('known-new', 1))).toBe(true);
    expect(db.log.filter(sql => sql.includes('SELECT 1 FROM events WHERE id'))).toHaveLength(0);
    expect(db.log.filter(sql => sql.includes('INSERT OR IGNORE'))).toHaveLength(1);
    expect(store.getById('known-new')).toEqual(ev('known-new', 1));
  });

  it('saveNewBatch stores N new events in one transaction, identically to N saveNew calls', () => {
    const events = [ev('batch-a', 1), ev('batch-b', 1), ev('batch-c', 7)];

    const viaSaveNew = new SqliteEventStore(new FakeSqliteDb());
    for (const e of events) viaSaveNew.saveNew(e);

    const db = new FakeSqliteDb();
    const viaBatch = new SqliteEventStore(db);
    db.log.length = 0; // ignore schema/count bootstrap
    const stored = viaBatch.saveNewBatch(events);

    expect(stored).toEqual(events); // every event was new → all reported stored, same order
    expect(viaBatch.size()).toBe(viaSaveNew.size());
    expect(viaBatch.versionOf([1])).toBe(viaSaveNew.versionOf([1]));
    expect(viaBatch.versionOf([7])).toBe(viaSaveNew.versionOf([7]));
    for (const e of events) expect(viaBatch.getById(e.id)).toEqual(viaSaveNew.getById(e.id));

    // ONE transaction wraps all three inserts — not one BEGIN/COMMIT per event.
    expect(db.log.filter(sql => sql === 'BEGIN IMMEDIATE;')).toHaveLength(1);
    expect(db.log.filter(sql => sql === 'COMMIT;')).toHaveLength(1);
    expect(db.log.filter(sql => sql.includes('INSERT OR IGNORE'))).toHaveLength(3);
  });

  it('skips an already-present event in the batch — no double-insert, no double-bump', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(ev('existing', 1)); // already durable before the batch runs
    const v = store.versionOf([1]);

    db.log.length = 0;
    const stored = store.saveNewBatch([ev('existing', 1), ev('fresh', 1)]);

    expect(stored).toEqual([ev('fresh', 1)]); // the duplicate is silently skipped, in place
    expect(store.versionOf([1])).toBe(v + 1); // one bump, not two
    expect(store.getById('fresh')).toEqual(ev('fresh', 1));
    // No INSERT is even attempted for the duplicate — the has() gate runs BEFORE insert.
    expect(db.log.filter(sql => sql.includes('INSERT OR IGNORE'))).toHaveLength(1);
  });

  it('saveNewBatch is a no-op for an empty array — no transaction opened', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    db.log.length = 0;
    expect(store.saveNewBatch([])).toEqual([]);
    expect(db.log).toHaveLength(0);
  });

  it('rolls back the RAM mirror in lockstep with the DB on a mid-batch insert failure', () => {
    // Fail on the 3rd INSERT so the batch's first two events would (pre-fix) already have their
    // RAM-mirror mutations applied inline before the throw — exactly the split state under test.
    const db = new ThrowingOnNthInsertSqliteDb(3);
    const store = new SqliteEventStore(db);
    const events = [ev('rb-a', 1), ev('rb-b', 1), ev('rb-c', 7)];
    const sizeBefore = store.size();
    const v1Before = store.versionOf([1]);
    const v7Before = store.versionOf([7]);

    expect(() => store.saveNewBatch(events)).toThrow('simulated mid-batch insert failure');

    // NONE of the batch is considered stored afterward — not even the events whose INSERT ran
    // before the throw — so has()/getById/size/versionOf never run ahead of the rolled-back DB.
    for (const e of events) {
      expect(store.has(e.id)).toBe(false);
      expect(store.getById(e.id)).toBeUndefined();
    }
    expect(store.size()).toBe(sizeBefore);
    expect(store.versionOf([1])).toBe(v1Before);
    expect(store.versionOf([7])).toBe(v7Before);
    expect(db.log.filter(sql => sql === 'ROLLBACK;')).toHaveLength(1);
    expect(db.log.filter(sql => sql === 'COMMIT;')).toHaveLength(0);
  });

  it('bumps versionOf on a new save so upstream caches recompute', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    const v0 = store.versionOf([1]);
    expect(store.save(ev('a', 1))).toBe(true);
    expect(store.versionOf([1])).toBe(v0 + 1); // a new kind-1 event advances the kind-1 counter
    expect(store.version()).toBeGreaterThan(0);
  });

  it('does NOT bump when a duplicate id is ignored (rowsAffected 0)', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('a', 1));
    const v = store.versionOf([1]);
    expect(store.save(ev('a', 1))).toBe(false); // INSERT OR IGNORE dedupe
    expect(store.versionOf([1])).toBe(v); // unchanged — nothing was added
  });

  it('tracks counters per kind so an unrelated write does not invalidate the feed', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('a', 1));
    const feedV = store.versionOf([1]);
    store.save(ev('b', 7)); // a reaction — different kind
    expect(store.versionOf([1])).toBe(feedV); // kind-1 (feed) view is unchanged
    expect(store.kindVersion(7)).toBe(1);
    expect(store.versionOf([1, 7])).toBe(feedV + 1); // combined view sees the reaction
  });

  // The on-device regression: op-sqlite's executeSync returned rowsAffected 0 (or the adapter's
  // `?? 0` fell back) for the INSERT, so the old `rowsAffected > 0` bump gate never fired and
  // optimistic UI died EVERYWHERE. save() must now bump from an indexed PK check, not the driver's
  // report, so it's correct even against a driver that never reports affected rows for inserts.
  describe('with a driver that reports rowsAffected: 0 for INSERTs (the device failure mode)', () => {
    it('STILL bumps versionOf and returns true for a genuinely new id', () => {
      const store = new SqliteEventStore(new RowsAffectedZeroSqliteDb());
      const v0 = store.versionOf([1]);
      expect(store.save(ev('a', 1))).toBe(true); // new id → optimistic insert
      expect(store.versionOf([1])).toBe(v0 + 1); // feed cache key MOVES → feed rebuilds
      expect(store.version()).toBeGreaterThan(0);
    });

    it('STILL returns false and does NOT bump for a duplicate id', () => {
      const store = new SqliteEventStore(new RowsAffectedZeroSqliteDb());
      store.save(ev('a', 1));
      const v = store.versionOf([1]);
      expect(store.save(ev('a', 1))).toBe(false); // dedupe by PK existence, not rowsAffected
      expect(store.versionOf([1])).toBe(v); // no cache thrash on a relay echo of our own event
    });

    it('drives optimistic feed invalidation end to end through SwappableEventStore', () => {
      const wrap = new SwappableEventStore(new SqliteEventStore(new RowsAffectedZeroSqliteDb()));
      const v0 = wrap.versionOf([1]);
      expect(wrap.save(ev('a', 1))).toBe(true);
      expect(wrap.versionOf([1])).toBeGreaterThan(v0); // AppRuntime._cachedBuildFeed would rebuild
    });
  });

  it('signals a change on clear()', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('a', 1));
    const g = store.version();
    store.clear();
    expect(store.version()).toBeGreaterThan(g);
  });

  // remove() lets cancelSend drop a user-cancelled optimistic write from the on-device cache. Before
  // this, SqliteEventStore had NO remove, so SwappableEventStore.remove()->inner.remove?.() was a
  // no-op: a cancelled post lingered in the encrypted DB and on the feed until a reload.
  describe('remove() (cancelSend on the sqlite store)', () => {
    it('deletes the row and bumps the kind version so the feed drops it', () => {
      const store = new SqliteEventStore(new FakeSqliteDb());
      store.save(ev('a', 1));
      const v = store.versionOf([1]);
      expect(store.remove('a')).toBe(true);
      expect(store.has('a')).toBe(false);
      expect(store.versionOf([1])).toBe(v + 1); // feed cache invalidates → cancelled post disappears
    });

    it('returns false and does not bump for an id that is not present', () => {
      const store = new SqliteEventStore(new FakeSqliteDb());
      store.save(ev('a', 1));
      const v = store.versionOf([1]);
      expect(store.remove('missing')).toBe(false);
      expect(store.versionOf([1])).toBe(v);
    });

    it('bumps the REMOVED event’s own kind, not kind-1', () => {
      const store = new SqliteEventStore(new FakeSqliteDb());
      store.save(ev('r', 7)); // a reaction
      const feedV = store.versionOf([1]);
      expect(store.remove('r')).toBe(true);
      expect(store.kindVersion(7)).toBe(2); // save + remove both bumped kind 7
      expect(store.versionOf([1])).toBe(feedV); // kind-1 feed view untouched
    });
  });

  // The on-device wiring: makeStore wraps the sqlite store in SwappableEventStore, and
  // AppRuntime._cachedBuildFeed keys on wrap.versionOf(FEED_KINDS). This is the composition
  // that regressed — the wrapper's passthrough returned a constant when the inner had no
  // versionOf — so pin it end to end.
  it('advances versionOf through SwappableEventStore with a sqlite inner', () => {
    const wrap = new SwappableEventStore(new SqliteEventStore(new FakeSqliteDb()));
    const v0 = wrap.versionOf([1]);
    expect(wrap.save(ev('a', 1))).toBe(true);
    expect(wrap.versionOf([1])).toBeGreaterThan(v0); // feed cache key moves → feed rebuilds
    const v1 = wrap.versionOf([1]);
    expect(wrap.save(ev('a', 1))).toBe(false); // duplicate is ignored…
    expect(wrap.versionOf([1])).toBe(v1); // …and does not thrash the cache
  });
});

describe('SqliteEventStore memory-first mirror', () => {
  it('warms a kind bucket with ONE SELECT, then serves further queries from RAM', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(ev('a', 1));
    store.save(ev('b', 1));
    const before = db.bucketSelects();
    // First kind-1 query warms the bucket via exactly one SELECT (a save populates the RAM bucket but
    // can't MARK the kind warm — older durable rows may exist — so the first read still loads once).
    store.query({kinds: [1]});
    expect(db.bucketSelects()).toBe(before + 1);
    const afterWarm = db.bucketSelects();
    // Every subsequent read is served from RAM: no more bucket SELECTs.
    store.query({kinds: [1]});
    store.query({kinds: [1]});
    store.getPosts();
    expect(db.bucketSelects()).toBe(afterWarm);
  });

  it('warms from durable rows a query has never touched (cold reopen)', () => {
    // Pre-populate the DB, then hand it to a FRESH store (simulates reopening the file).
    const db = new FakeSqliteDb();
    const seed = new SqliteEventStore(db);
    seed.save(ev('a', 1));
    seed.save(ev('b', 1));

    const store = new SqliteEventStore(db); // cold: nothing warmed yet
    const before = db.bucketSelects();
    const first = store.query({kinds: [1]});
    expect(first.map(e => e.id).sort()).toEqual(['a', 'b']); // read straight from the durable file
    expect(db.bucketSelects()).toBe(before + 1); // exactly one warming SELECT
    store.query({kinds: [1]});
    expect(db.bucketSelects()).toBe(before + 1); // and never again
  });

  it('preserves created_at DESC ordering and limit', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('old', 1, 10));
    store.save(ev('new', 1, 30));
    store.save(ev('mid', 1, 20));
    expect(store.query({kinds: [1]}).map(e => e.id)).toEqual(['new', 'mid', 'old']);
    expect(store.query({kinds: [1], limit: 2}).map(e => e.id)).toEqual(['new', 'mid']);
  });

  it('unordered:true returns the SAME set but skips the DESC sort (P0-3/C1)', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    // Saved out of created_at order, so natural (insertion) order differs from sorted DESC order —
    // proves the sort is actually skipped, not coincidentally identical.
    store.save(ev('old', 1, 10));
    store.save(ev('new', 1, 30));
    store.save(ev('mid', 1, 20));

    const sorted = store.query({kinds: [1]});
    const unordered = store.query({kinds: [1], unordered: true});

    // Same set of events either way.
    expect(new Set(unordered.map(e => e.id))).toEqual(new Set(sorted.map(e => e.id)));
    // Default (unset) behavior is unchanged: still DESC by created_at.
    expect(sorted.map(e => e.id)).toEqual(['new', 'mid', 'old']);
    // unordered:true is NOT sorted — it comes back in natural (insertion/storage) order, which here
    // differs from the DESC order, proving the sort was actually skipped.
    expect(unordered.map(e => e.id)).toEqual(['old', 'new', 'mid']);
  });

  it('unordered:true is ignored when limit is also set (limit needs the sort)', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('old', 1, 10));
    store.save(ev('new', 1, 30));
    store.save(ev('mid', 1, 20));
    // limit means "top-N by recency" — must still return the newest N, even if unordered was set.
    expect(store.query({kinds: [1], unordered: true, limit: 2}).map(e => e.id)).toEqual(['new', 'mid']);
  });

  it('filters by author', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    const mine = {...ev('a', 1), pubkey: 'me'};
    const theirs = {...ev('b', 1), pubkey: 'you'};
    store.save(mine);
    store.save(theirs);
    expect(store.query({kinds: [1], authors: ['me']}).map(e => e.id)).toEqual(['a']);
  });

  it('makes a save visible in the next query without a re-parse', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.query({kinds: [1]}); // warm the (empty) bucket
    const afterWarm = db.bucketSelects();
    store.save(ev('a', 1)); // lands in the warm bucket directly
    expect(store.query({kinds: [1]}).map(e => e.id)).toEqual(['a']);
    expect(db.bucketSelects()).toBe(afterWarm); // no re-SELECT — served from the mirror
  });

  it('getById works cold (kind never warmed) and warm', () => {
    const db = new FakeSqliteDb();
    const seed = new SqliteEventStore(db);
    seed.save(ev('a', 1));

    const store = new SqliteEventStore(db); // fresh, nothing warmed
    expect(store.getById('a')?.id).toBe('a'); // cold single-row fall-through
    expect(store.getById('missing')).toBeUndefined();

    store.save(ev('b', 1)); // now 'b' is in RAM
    expect(store.getById('b')?.id).toBe('b'); // warm fast path
  });

  it('keeps size() correct across save, dedupe, reopen and clear', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    expect(store.size()).toBe(0);
    store.save(ev('a', 1));
    store.save(ev('b', 7));
    expect(store.size()).toBe(2);
    store.save(ev('a', 1)); // duplicate → no growth
    expect(store.size()).toBe(2);

    const reopened = new SqliteEventStore(db); // bootstraps COUNT(*) from the durable file
    expect(reopened.size()).toBe(2);

    store.clear();
    expect(store.size()).toBe(0);
  });

  it('latestCreatedAt uses warmed buckets and stays warm', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(ev('a', 1, 100));
    store.save(ev('b', 1, 200));
    store.save(ev('c', 7, 500));
    expect(store.latestCreatedAt([1])).toBe(200);
    expect(store.latestCreatedAt([1, 7])).toBe(500);
    expect(store.latestCreatedAt()).toBe(500); // no-kinds path → MAX() aggregate over all
  });

  it('clear() resets the in-memory mirror as well as the durable table', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('a', 1));
    expect(store.query({kinds: [1]})).toHaveLength(1);
    store.clear();
    expect(store.query({kinds: [1]})).toHaveLength(0);
    expect(store.getById('a')).toBeUndefined();
  });

  it('close() releases the native handle', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    expect(db.closed).toBe(false);
    store.close();
    expect(db.closed).toBe(true);
  });
});

describe('SqliteEventStore.remove (gift-wrap pruning, finding #3)', () => {
  it('removes a WARM event: durable row + RAM mirror gone, versionOf bumps, size shrinks', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(ev('a', 1059));
    store.save(ev('b', 1059));
    store.query({kinds: [1059]}); // warm the bucket so 'a' is in the RAM mirror
    const v = store.versionOf([1059]);

    expect(store.remove('a')).toBe(true);
    expect(store.versionOf([1059])).toBe(v + 1); // per-kind counter moved → caches recompute
    expect(store.has('a')).toBe(false);
    expect(store.getById('a')).toBeUndefined();
    expect(store.query({kinds: [1059]}).map(e => e.id)).toEqual(['b']); // mirror updated, no re-SELECT
    expect(store.size()).toBe(1);
  });

  it('removes a COLD event (kind never warmed): resolves the kind first so versionOf STILL bumps', () => {
    // Seed the durable file, then reopen with a FRESH store that has warmed nothing — the event is
    // only on disk, not in the RAM mirror. remove() must look the kind up before deleting, because
    // versionOf() sums per-kind counters ONLY: a global-only bump would leave every versionOf-keyed
    // cache (feed/overlay/channels) serving the removed event forever.
    const db = new FakeSqliteDb();
    const seed = new SqliteEventStore(db);
    seed.save(ev('a', 1059));

    const store = new SqliteEventStore(db); // cold: byId/byKind empty, nothing warmed
    const v = store.versionOf([1059]);

    expect(store.remove('a')).toBe(true);
    expect(store.versionOf([1059])).toBe(v + 1); // the cold path still bumps the PER-KIND counter
    expect(store.has('a')).toBe(false);
    expect(store.query({kinds: [1059]})).toEqual([]); // a later warm doesn't resurrect it
    expect(store.size()).toBe(0);
  });

  it('returns false (and bumps nothing) for a missing id', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('a', 1059));
    const v = store.versionOf([1059]);
    const g = store.version();
    expect(store.remove('nope')).toBe(false);
    expect(store.versionOf([1059])).toBe(v);
    expect(store.version()).toBe(g);
    expect(store.size()).toBe(1);
  });

  it('propagates through SwappableEventStore so wrapped versionOf advances on remove', () => {
    const wrap = new SwappableEventStore(new SqliteEventStore(new FakeSqliteDb()));
    wrap.save(ev('a', 1059));
    const v = wrap.versionOf([1059]);
    expect(wrap.remove('a')).toBe(true);
    expect(wrap.versionOf([1059])).toBeGreaterThan(v); // the on-device composition invalidates too
  });
});

// The store's internal PRUNE_DELAY_MS is not exported; the scheduling test only needs to advance PAST
// it, so mirror the value here (kept in sync with sqliteStore.ts).
const PRUNE_DELAY_MS_TEST = 5000;

// Bounded retention (off-boot prune). The durable cache was unbounded/unpruned, so cold start scaled
// with app age: warmKind SELECT+JSON.parse's EVERY row of a kind on first touch, and kind-7 reactions
// accumulate worst. A one-shot prune (scheduled ~5s off the boot critical path) trims the OLDEST rows
// of high-volume timeline kinds to generous caps, keeping the newest, while NEVER touching DMs or any
// durable state event.
describe('SqliteEventStore bounded retention prune', () => {
  /** Save `count` events of `kind` with created_at = i (so i is also its recency rank). id = pfx+i. */
  const seedKind = (store: SqliteEventStore, kind: number, count: number, pfx: string): void => {
    for (let i = 0; i < count; i++) store.save(ev(`${pfx}${i}`, kind, i));
  };

  it(
    'trims kind-7 to REACTION_RETENTION and other timeline kinds to TIMELINE_RETENTION, keeping the newest',
    async () => {
      const db = new FakeSqliteDb();
      const store = new SqliteEventStore(db);
      seedKind(store, 7, REACTION_RETENTION + 5, 'r'); // reactions: 5 over the (larger) cap
      seedKind(store, 1, TIMELINE_RETENTION + 4, 'p'); // posts: 4 over the timeline cap
      const reactV = store.versionOf([7]);
      const postV = store.versionOf([1]);

      const pruned = await store.pruneRetention();
      expect(pruned).toBe(5 + 4); // exactly the overflow rows of both kinds

      // Reactions capped, oldest dropped, newest survive.
      expect(store.query({kinds: [7]})).toHaveLength(REACTION_RETENTION);
      expect(store.has('r0')).toBe(false); // oldest 5 (created_at 0..4) pruned
      expect(store.has('r4')).toBe(false);
      expect(store.has('r5')).toBe(true); // newest REACTION_RETENTION kept
      expect(store.has(`r${REACTION_RETENTION + 4}`)).toBe(true);

      // Posts capped the same way at the smaller cap.
      expect(store.query({kinds: [1]})).toHaveLength(TIMELINE_RETENTION);
      expect(store.has('p0')).toBe(false);
      expect(store.has('p3')).toBe(false); // oldest 4 (created_at 0..3) pruned
      expect(store.has('p4')).toBe(true);
      expect(store.has(`p${TIMELINE_RETENTION + 3}`)).toBe(true);

      // Durable table and size() both reflect the trim, and both kinds' version counters bumped once
      // so downstream feed/channel caches recompute.
      expect(db.rowCount()).toBe(REACTION_RETENTION + TIMELINE_RETENTION);
      expect(store.size()).toBe(REACTION_RETENTION + TIMELINE_RETENTION);
      expect(store.versionOf([7])).toBe(reactV + 1);
      expect(store.versionOf([1])).toBe(postV + 1);
    },
    20000,
  );

  it('NEVER prunes exempt kinds even far past the cap (DMs + all durable state)', async () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    // One representative from each exempt family, each OVER the timeline cap so a naive prune would
    // trim it: gift-wrap DMs (1059), reports (1984 — moderation state), replaceable list (10000),
    // addressable state (30078). Losing any of these is unacceptable.
    const exemptKinds = [1059, 1984, 10000, 30078];
    for (const k of exemptKinds) seedKind(store, k, TIMELINE_RETENTION + 2, `k${k}_`);
    const versions = exemptKinds.map(k => store.versionOf([k]));

    const pruned = await store.pruneRetention();
    expect(pruned).toBe(0); // nothing trimmed

    exemptKinds.forEach((k, i) => {
      expect(store.query({kinds: [k]})).toHaveLength(TIMELINE_RETENTION + 2); // fully retained
      expect(store.has(`k${k}_0`)).toBe(true); // even the OLDEST row of an exempt kind survives
      expect(store.versionOf([k])).toBe(versions[i]); // no bump — the kind was never touched
    });
    expect(db.rowCount()).toBe(exemptKinds.length * (TIMELINE_RETENTION + 2));
  });

  it('does nothing when every kind is under its cap', async () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    seedKind(store, 7, 10, 'r');
    seedKind(store, 1, 10, 'p');
    const g = store.version();
    expect(await store.pruneRetention()).toBe(0);
    expect(store.version()).toBe(g); // no version churn when nothing is pruned
    expect(store.size()).toBe(20);
  });

  it('prunes a COLD store (durable-only) without warming/parsing any bucket', async () => {
    // Seed the durable file via one store, then reopen a FRESH store that has warmed nothing — the
    // overflow rows exist only on disk, not in the RAM mirror. The prune must trim the durable table
    // using id + count scans ONLY (no SELECT raw / JSON.parse), so it never pays the warm cost it
    // exists to shrink.
    const db = new FakeSqliteDb();
    const seed = new SqliteEventStore(db);
    seedKind(seed, 1, TIMELINE_RETENTION + 3, 'p');

    const store = new SqliteEventStore(db); // cold: byId/byKind empty, nothing warmed
    expect(db.bucketSelects()).toBe(0);
    const pruned = await store.pruneRetention();
    expect(pruned).toBe(3);
    expect(db.bucketSelects()).toBe(0); // prune warmed nothing — no raw-bucket SELECT

    expect(store.size()).toBe(TIMELINE_RETENTION);
    expect(db.rowCount()).toBe(TIMELINE_RETENTION);
    // A later query warms from the ALREADY-trimmed durable rows and sees only the newest, oldest first.
    const posts = store.query({kinds: [1]});
    expect(db.bucketSelects()).toBe(1);
    expect(posts).toHaveLength(TIMELINE_RETENTION);
    expect(posts[0]!.id).toBe(`p${TIMELINE_RETENTION + 2}`); // newest survivor
    expect(store.has('p0')).toBe(false); // oldest 3 pruned on disk, never resurrected
  });

  it('keeps the warm RAM mirror consistent with the durable table after a prune', async () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    seedKind(store, 1, TIMELINE_RETENTION + 2, 'p');
    store.query({kinds: [1]}); // warm the bucket so the mirror holds all rows
    const selectsAfterWarm = db.bucketSelects();

    await store.pruneRetention();
    // Served straight from the (now-trimmed) mirror — no extra warming SELECT.
    const posts = store.query({kinds: [1]});
    expect(db.bucketSelects()).toBe(selectsAfterWarm);
    expect(posts).toHaveLength(TIMELINE_RETENTION);
    expect(posts.some(p => p.id === 'p0')).toBe(false); // pruned row gone from the mirror too
    expect(store.getById('p0')).toBeUndefined();
  });

  it('propagates the prune bump through SwappableEventStore', async () => {
    const inner = new SqliteEventStore(new FakeSqliteDb());
    const wrap = new SwappableEventStore(inner);
    for (let i = 0; i < TIMELINE_RETENTION + 1; i++) wrap.save(ev(`p${i}`, 1, i));
    const v = wrap.versionOf([1]);
    await inner.pruneRetention();
    expect(wrap.versionOf([1])).toBeGreaterThan(v); // the on-device composition invalidates too
  });

  it('schedules the prune ~5s off the boot path, and close() cancels a pending one', () => {
    jest.useFakeTimers();
    try {
      const spy = jest
        .spyOn(SqliteEventStore.prototype, 'pruneRetention')
        .mockResolvedValue(0);

      // Fires on its own ~5s after construction — never on the critical path.
      const store = new SqliteEventStore(new FakeSqliteDb());
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(PRUNE_DELAY_MS_TEST);
      expect(spy).toHaveBeenCalledTimes(1);
      store.close();

      // close() before the timer fires cancels it (so it can't touch a released DB handle).
      spy.mockClear();
      const closedEarly = new SqliteEventStore(new FakeSqliteDb());
      closedEarly.close();
      jest.advanceTimersByTime(PRUNE_DELAY_MS_TEST * 3);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});

// User-driven scoped cache-clear (Settings → Manage data → deleteCachedEvents). Unlike the retention
// prune (count-capped, keeps the newest N), this deletes by DATE RANGE + kind — but shares the SAME
// exempt set, so it must NEVER delete a DM or any durable-state event, and must keep the durable
// table, size(), the RAM mirror, and the per-kind version counters all in lockstep.
describe('SqliteEventStore.deleteCachedEvents (scoped cache-clear)', () => {
  /** Save deletable posts/reactions across ages + one ancient event of every exempt kind. */
  const seed = (store: SqliteEventStore): void => {
    store.save(ev('p-old', 1, 100));
    store.save(ev('p-new', 1, 1000));
    store.save(ev('r-old', 7, 200));
    store.save(ev('r-new', 7, 1000));
    for (const k of [0, 5, 40, 1059, 1984, 10000, 30078]) store.save(ev(`x${k}`, k, 1));
  };

  it('deletes only NON-EXEMPT rows older than the cutoff, keeping newer + every exempt kind', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    seed(store);
    const sizeBefore = store.size();

    expect(store.deleteCachedEvents({olderThanSeconds: 500})).toBe(2); // p-old + r-old

    expect(store.has('p-old')).toBe(false);
    expect(store.has('r-old')).toBe(false);
    expect(store.has('p-new')).toBe(true);
    expect(store.has('r-new')).toBe(true);
    for (const k of [0, 5, 40, 1059, 1984, 10000, 30078]) expect(store.has(`x${k}`)).toBe(true);
    // Durable table + size() both reflect exactly the two removals — RAM mirror and disk agree.
    expect(db.rowCount()).toBe(sizeBefore - 2);
    expect(store.size()).toBe(sizeBefore - 2);
  });

  it('bumps only the touched kinds so the feed cache invalidates', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    seed(store);
    const v1 = store.versionOf([1]);
    const v7 = store.versionOf([7]);
    const vDm = store.versionOf([1059]);
    store.deleteCachedEvents({olderThanSeconds: 500});
    expect(store.versionOf([1])).toBe(v1 + 1);
    expect(store.versionOf([7])).toBe(v7 + 1);
    expect(store.versionOf([1059])).toBe(vDm); // the exempt DM kind was never touched
  });

  it('is strictly-less-than the cutoff at the boundary', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('at', 1, 1000));
    store.save(ev('below', 1, 999));
    expect(store.deleteCachedEvents({olderThanSeconds: 1000})).toBe(1);
    expect(store.has('at')).toBe(true);
    expect(store.has('below')).toBe(false);
  });

  it('with no cutoff clears ALL non-exempt rows but keeps every exempt one', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    seed(store);
    expect(store.deleteCachedEvents()).toBe(4);
    expect(store.query({kinds: [1]})).toHaveLength(0);
    expect(store.query({kinds: [7]})).toHaveLength(0);
    for (const k of [0, 5, 40, 1059, 1984, 10000, 30078]) expect(store.has(`x${k}`)).toBe(true);
  });

  it('restricts to requested kinds, intersected with the non-exempt set', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    seed(store);
    expect(store.deleteCachedEvents({kinds: [7, 1059]})).toBe(2); // reactions go; the DM is exempt
    expect(store.query({kinds: [7]})).toHaveLength(0);
    expect(store.query({kinds: [1]})).toHaveLength(2);
    expect(store.has('x1059')).toBe(true);
  });

  it('cachedEventCount previews the same set without mutating, and excludes exempt kinds', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    seed(store);
    expect(store.cachedEventCount({olderThanSeconds: 500})).toBe(2);
    expect(store.cachedEventCount()).toBe(4); // all deletable; 7 exempt events excluded
    expect(store.size()).toBe(11); // 4 deletable + 7 exempt — counting changed nothing
  });

  it('deletes from a COLD store (durable-only) and keeps size() correct', () => {
    const db = new FakeSqliteDb();
    const seedStore = new SqliteEventStore(db);
    seed(seedStore);

    const store = new SqliteEventStore(db); // reopened: nothing warmed
    expect(store.deleteCachedEvents({olderThanSeconds: 500})).toBe(2);
    expect(db.rowCount()).toBe(9);
    expect(store.size()).toBe(9);
    // A later warm reads the already-trimmed durable rows.
    expect(store.query({kinds: [1]}).map(e => e.id)).toEqual(['p-new']);
  });

  it('propagates through SwappableEventStore', () => {
    const inner = new SqliteEventStore(new FakeSqliteDb());
    const wrap = new SwappableEventStore(inner);
    inner.save(ev('p-old', 1, 100));
    inner.save(ev('dm', 1059, 1));
    const v = wrap.versionOf([1]);
    expect(wrap.cachedEventCount()).toBe(1);
    expect(wrap.deleteCachedEvents()).toBe(1);
    expect(wrap.versionOf([1])).toBeGreaterThan(v);
    expect(inner.has('p-old')).toBe(false);
    expect(inner.has('dm')).toBe(true);
  });
});

// ── Compaction v2 (COMPACTION_V2, T16-S1) ──────────────────────────────────────────────────────────
// The engine adds two passes on top of the count-cap prune: (1) collapse SUPERSEDED replaceable/
// addressable versions (keep newest per pubkey+kind+d-tag), and (2) expire transient rows by age /
// NIP-40. Both are gated behind COMPACTION_V2 in pruneRetention, but the private passes are exercised
// directly here so the engine is covered regardless of the shipped flag value (which defaults dark).
// The flag-OFF invariant — pruneRetention is byte-for-byte today's behavior — is proven separately.

/** Reach the private compaction passes without loosening their visibility in production code. */
interface CompactionInternals {
  pruneSupersededReplaceable(): number;
  expireEphemeral(nowSeconds: number): number;
}
const internals = (store: SqliteEventStore): CompactionInternals =>
  store as unknown as CompactionInternals;

describe('SqliteEventStore compaction kind predicates', () => {
  it('isReplaceableOrAddressable covers 0/3 and the replaceable/addressable ranges only', () => {
    for (const k of [0, 3, 10000, 15000, 19999, 30000, 30078, 39999]) {
      expect(isReplaceableOrAddressable(k)).toBe(true);
    }
    for (const k of [1, 4, 7, 9999, 20000, 25000, 29999, 40000]) {
      expect(isReplaceableOrAddressable(k)).toBe(false);
    }
  });

  it('isEphemeralKind covers only the 20000-29999 range', () => {
    for (const k of [20000, 25000, 29999]) expect(isEphemeralKind(k)).toBe(true);
    for (const k of [0, 1, 19999, 30000, 30078]) expect(isEphemeralKind(k)).toBe(false);
  });
});

describe('SqliteEventStore.pruneSupersededReplaceable (superseded-version collapse)', () => {
  it('deletes the older version, keeps the newest, shrinks size by 1, bumps the kind once', () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(evT('old', 30078, 100, [['d', 'stiq:space-settings']]));
    store.save(evT('new', 30078, 200, [['d', 'stiq:space-settings']]));
    const sizeBefore = store.size();
    const v = store.versionOf([30078]);

    expect(internals(store).pruneSupersededReplaceable()).toBe(1);
    expect(store.has('old')).toBe(false); // strictly-older version collapsed
    expect(store.has('new')).toBe(true); //  newest per (pubkey,kind,d) retained
    expect(store.size()).toBe(sizeBefore - 1); // exactly one row removed
    expect(db.rowCount()).toBe(1); // durable table agrees
    expect(store.versionOf([30078])).toBe(v + 1); // bumped exactly once → feed cache invalidates
  });

  it('keeps addressable rows with DIFFERENT d-tags and DIFFERENT pubkeys (no cross-address delete)', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('a-old', 30078, 100, [['d', 'one']]));
    store.save(evT('a-new', 30078, 200, [['d', 'one']])); // supersedes a-old (same address)
    store.save(evT('a-d2', 30078, 50, [['d', 'two']])); //   different d-tag → its own address
    store.save(evP('b-one', 30078, 10, 'q', [['d', 'one']])); // different pubkey → its own address

    expect(internals(store).pruneSupersededReplaceable()).toBe(1); // only a-old is superseded
    expect(store.has('a-old')).toBe(false);
    expect(store.has('a-new')).toBe(true);
    expect(store.has('a-d2')).toBe(true); //  distinct d-tag survives
    expect(store.has('b-one')).toBe(true); // distinct pubkey survives
  });

  it('breaks a created_at tie by keeping the lexicographically-GREATER id', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('aaa', 30078, 100, [['d', 'x']]));
    store.save(evT('zzz', 30078, 100, [['d', 'x']])); // same created_at → greater id wins
    expect(internals(store).pruneSupersededReplaceable()).toBe(1);
    expect(store.has('zzz')).toBe(true);
    expect(store.has('aaa')).toBe(false);
  });

  it('collapses a plain replaceable (kind-10000) with no d-tag by pubkey', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('mute-old', 10000, 100, [])); // no d-tag → empty-address bucket
    store.save(evT('mute-new', 10000, 200, []));
    expect(internals(store).pruneSupersededReplaceable()).toBe(1);
    expect(store.has('mute-old')).toBe(false);
    expect(store.has('mute-new')).toBe(true);
  });

  it('never touches a LONE replaceable/addressable row, a DM, or a non-replaceable kind', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('dm', 1059, 1, [['d', 'x']])); // DM — not replaceable, never considered
    store.save(evT('mute', 10000, 1, [])); //         lone mute list — group of one
    store.save(evT('cfg', 30078, 5, [['d', 'space']])); // lone config — group of one
    store.save(ev('post', 1, 9)); //                  plain timeline kind — not replaceable

    expect(internals(store).pruneSupersededReplaceable()).toBe(0); // nothing collapsed
    for (const id of ['dm', 'mute', 'cfg', 'post']) expect(store.has(id)).toBe(true);
  });

  it('propagates the collapse bump through SwappableEventStore', () => {
    const inner = new SqliteEventStore(new FakeSqliteDb());
    const wrap = new SwappableEventStore(inner);
    inner.save(evT('old', 30078, 100, [['d', 'x']]));
    inner.save(evT('new', 30078, 200, [['d', 'x']]));
    const v = wrap.versionOf([30078]);
    expect(internals(inner).pruneSupersededReplaceable()).toBe(1);
    expect(wrap.versionOf([30078])).toBeGreaterThan(v);
  });
});

describe('SqliteEventStore.expireEphemeral (age + NIP-40 expiry)', () => {
  it('removes age-expired and NIP-40-expired non-exempt rows, keeping fresh + future + exempt', () => {
    const now = 10_000;
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(ev('fresh', 1, now - 10)); //                                    9990 — kept
    store.save(ev('stale', 1, now - 5000)); //                                  5000 — age-expired
    store.save(evT('exp', 1, now - 1, [['expiration', String(now - 100)]])); // NIP-40 expired
    store.save(evT('future', 1, now - 1, [['expiration', String(now + 100)]])); // future — kept
    store.save(ev('dm', 1059, now - 5000)); //                                  exempt — never expired
    store.setRetentionPolicy({maxAgeSeconds: 1000}); // cutoff = now - 1000 = 9000

    expect(internals(store).expireEphemeral(now)).toBe(2); // stale (age) + exp (NIP-40)
    expect(store.has('stale')).toBe(false);
    expect(store.has('exp')).toBe(false);
    expect(store.has('fresh')).toBe(true);
    expect(store.has('future')).toBe(true);
    expect(store.has('dm')).toBe(true); // an exempt kind is never age- or NIP-40-expired
  });

  it('with maxAgeSeconds UNSET removes only NIP-40-expired rows (no age cutoff)', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(ev('ancient', 1, 1)); //                       very old, no expiration → kept
    store.save(evT('exp', 1, 5, [['expiration', '10']])); //  NIP-40 expired at t=10
    // DEFAULT_RETENTION_POLICY has no maxAgeSeconds, so the age pass is skipped entirely.
    expect(store.versionOf([1])).toBeGreaterThan(0);
    expect(internals(store).expireEphemeral(1000)).toBe(1);
    expect(store.has('ancient')).toBe(true);
    expect(store.has('exp')).toBe(false);
  });

  it('bumps the touched kind so the feed cache invalidates after expiry', () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('exp', 1, 5, [['expiration', '10']]));
    const v = store.versionOf([1]);
    expect(internals(store).expireEphemeral(1000)).toBe(1);
    expect(store.versionOf([1])).toBe(v + 1);
    expect(store.size()).toBe(0);
  });
});

describe('SqliteEventStore retention policy (setRetentionPolicy + defaults)', () => {
  it('DEFAULT_RETENTION_POLICY preserves the historical caps with no age bound or collapse', () => {
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      reactionCap: REACTION_RETENTION,
      timelineCap: TIMELINE_RETENTION,
      collapseReplaceable: false,
    });
    expect(DEFAULT_RETENTION_POLICY.maxAgeSeconds).toBeUndefined();
  });

  it('setRetentionPolicy shallow-merges and changes the caps used by the NEXT pruneRetention', async () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    for (let i = 0; i < 12; i++) store.save(ev(`p${i}`, 1, i)); // 12 posts
    for (let i = 0; i < 10; i++) store.save(ev(`r${i}`, 7, i)); // 10 reactions

    const smallTimeline: Partial<RetentionPolicy> = {timelineCap: 5};
    store.setRetentionPolicy(smallTimeline);
    store.setRetentionPolicy({reactionCap: 3}); // merge — timelineCap:5 must survive

    const pruned = await store.pruneRetention(); // count-cap loop is flag-independent
    expect(pruned).toBe(12 - 5 + (10 - 3)); // both caps applied → 7 + 7
    expect(store.query({kinds: [1]})).toHaveLength(5);
    expect(store.query({kinds: [7]})).toHaveLength(3);
    expect(store.has('p11')).toBe(true); // newest kept
    expect(store.has('p0')).toBe(false); // oldest trimmed
  });

  it('a store built with a policy arg starts from those caps', async () => {
    const store = new SqliteEventStore(new FakeSqliteDb(), {timelineCap: 4});
    for (let i = 0; i < 9; i++) store.save(ev(`p${i}`, 1, i));
    expect(await store.pruneRetention()).toBe(5); // 9 - 4
    expect(store.query({kinds: [1]})).toHaveLength(4);
  });
});

describe('SqliteEventStore compaction ships dark (COMPACTION_V2 = false)', () => {
  // The shipped config pins COMPACTION_V2 = false, so pruneRetention must run ONLY today's count-cap
  // prune: the new passes never fire, and replaceable/addressable kinds (exempt) are left fully intact.
  it('pruneRetention leaves superseded replaceable versions untouched when the flag is off', async () => {
    const db = new FakeSqliteDb();
    const store = new SqliteEventStore(db);
    store.save(evT('old', 30078, 100, [['d', 's']]));
    store.save(evT('new', 30078, 200, [['d', 's']]));
    const size = store.size();
    const v = store.versionOf([30078]);

    expect(await store.pruneRetention()).toBe(0); // flag off → collapse pass never runs
    expect(store.has('old')).toBe(true); // BOTH versions still present
    expect(store.has('new')).toBe(true);
    expect(store.size()).toBe(size);
    expect(store.versionOf([30078])).toBe(v); // no bump — nothing was touched
    expect(db.rowCount()).toBe(2);
  });

  it('pruneRetention does not expire an old NIP-40 row when the flag is off', async () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    store.save(evT('exp', 1, 5, [['expiration', '10']])); // long past, but flag gates expiry off
    store.setRetentionPolicy({maxAgeSeconds: 1}); // even an aggressive age bound stays inert
    expect(await store.pruneRetention()).toBe(0);
    expect(store.has('exp')).toBe(true);
  });
});

// ── Compaction observer (T16-S3 durable feed-state snapshot hook) ──────────────────────────────────
// pruneRetention fires setCompactionObserver's callback at its END, but ONLY when COMPACTION_V2 is on
// AND a real compaction removed rows. The shipped flag is false, so with the default import the observer
// must NEVER fire (ship-dark: zero snapshot side effects). The flag-ON fire path is exercised via module
// isolation (jest.doMock('../config', { COMPACTION_V2: true }) + a fresh require).
describe('SqliteEventStore.setCompactionObserver (T16-S3)', () => {
  it('does NOT fire when the flag is off, even though a count-cap prune removed rows', async () => {
    const store = new SqliteEventStore(new FakeSqliteDb());
    for (let i = 0; i < TIMELINE_RETENTION + 3; i++) store.save(ev(`p${i}`, 1, i));
    let calls = 0;
    store.setCompactionObserver(() => {
      calls++;
    });
    const pruned = await store.pruneRetention();
    expect(pruned).toBe(3); // the count-cap prune DID remove rows…
    expect(calls).toBe(0); //  …but the observer stays silent with COMPACTION_V2 off (ship-dark)
  }, 20000);

  it('fires once (with the store) after a real compaction when COMPACTION_V2 is on', async () => {
    jest.resetModules();
    jest.doMock('../config', () => ({...jest.requireActual('../config'), COMPACTION_V2: true}));
    try {
      const {SqliteEventStore: FlagOnStore} = require('./sqliteStore') as typeof import('./sqliteStore');
      const store = new FlagOnStore(new FakeSqliteDb());
      const seen: unknown[] = [];
      store.setCompactionObserver(s => seen.push(s));
      store.save(evT('old', 30078, 100, [['d', 's']]));
      store.save(evT('new', 30078, 200, [['d', 's']])); // supersedes 'old' → collapse removes 1
      const pruned = await store.pruneRetention();
      expect(pruned).toBe(1);
      expect(seen).toHaveLength(1); // fired exactly once…
      expect(seen[0]).toBe(store); //  …with the store instance
    } finally {
      jest.dontMock('../config');
      jest.resetModules();
    }
  });

  it('does NOT fire when the flag is on but nothing was pruned', async () => {
    jest.resetModules();
    jest.doMock('../config', () => ({...jest.requireActual('../config'), COMPACTION_V2: true}));
    try {
      const {SqliteEventStore: FlagOnStore} = require('./sqliteStore') as typeof import('./sqliteStore');
      const store = new FlagOnStore(new FakeSqliteDb());
      let calls = 0;
      store.setCompactionObserver(() => {
        calls++;
      });
      store.save(ev('lone', 1, 1)); // under caps, nothing to collapse/expire
      expect(await store.pruneRetention()).toBe(0);
      expect(calls).toBe(0);
    } finally {
      jest.dontMock('../config');
      jest.resetModules();
    }
  });

  it('clears the observer when set to undefined', async () => {
    jest.resetModules();
    jest.doMock('../config', () => ({...jest.requireActual('../config'), COMPACTION_V2: true}));
    try {
      const {SqliteEventStore: FlagOnStore} = require('./sqliteStore') as typeof import('./sqliteStore');
      const store = new FlagOnStore(new FakeSqliteDb());
      let calls = 0;
      store.setCompactionObserver(() => {
        calls++;
      });
      store.setCompactionObserver(undefined); // deregister
      store.save(evT('old', 30078, 100, [['d', 's']]));
      store.save(evT('new', 30078, 200, [['d', 's']]));
      expect(await store.pruneRetention()).toBe(1); // compaction still happens…
      expect(calls).toBe(0); //                        …but no observer is notified
    } finally {
      jest.dontMock('../config');
      jest.resetModules();
    }
  });
});
