/**
 * warmKindChunked — the chunked, yielding bucket warm that replaces the sync warmKind's one-macrotask
 * SELECT + JSON.parse of an entire (up to REACTION_RETENTION-row) bucket on the scored-feed pass.
 * Covers: chunk pagination on rowid, coalescing of concurrent warms, the clear()-mid-warm abort
 * (delete-race guard: a duress wipe must never leave a half-indexed bucket marked warm), mid-warm
 * targeted deletes (no resurrection), and mid-warm saves (id-dedupe, no double count).
 */
import type {Event} from 'nostr-tools/pure';
import {SqliteEventStore, WARM_CHUNK_ROWS, type SqliteDb} from './sqliteStore';
import {SwappableEventStore} from './store';

/**
 * Minimal fake driver for the chunked-warm SQL surface. Rows carry a synthetic monotonically
 * increasing rowid (insertion order), exactly like a real SQLite rowid table, so the pagination
 * (`WHERE kind = ? AND rowid > ? ORDER BY rowid LIMIT ?`) is exercised for real.
 */
class ChunkFakeDb implements SqliteDb {
  private rows = new Map<string, {rowid: number; event: Event}>();
  private nextRowid = 1;
  /** How many chunked-warm SELECTs ran (to assert the chunk count). */
  chunkSelects = 0;

  execute(sql: string, params: unknown[] = []): {rows: {_array: unknown[]}; rowsAffected: number} {
    const none = {rows: {_array: [] as unknown[]}, rowsAffected: 0};
    if (sql.includes('INSERT OR IGNORE')) {
      const id = params[0] as string;
      if (!this.rows.has(id)) {
        this.rows.set(id, {rowid: this.nextRowid++, event: JSON.parse(params[7] as string) as Event});
      }
      return {rows: {_array: []}, rowsAffected: 1};
    }
    if (sql.includes('SELECT rowid AS r, raw FROM events')) {
      this.chunkSelects++;
      const [kind, after, limit] = params as [number, number, number];
      const matches = [...this.rows.values()]
        .filter(r => r.event.kind === kind && r.rowid > after)
        .sort((a, b) => a.rowid - b.rowid)
        .slice(0, limit)
        .map(r => ({r: r.rowid, raw: JSON.stringify(r.event)}));
      return {rows: {_array: matches}, rowsAffected: 0};
    }
    if (sql.includes('SELECT raw FROM events WHERE kind')) {
      const kind = params[0] as number;
      const matches = [...this.rows.values()]
        .filter(r => r.event.kind === kind)
        .map(r => ({raw: JSON.stringify(r.event)}));
      return {rows: {_array: matches}, rowsAffected: 0};
    }
    if (sql.includes('COUNT(*)')) {
      return {rows: {_array: [{n: this.rows.size}]}, rowsAffected: 0};
    }
    if (sql.includes('SELECT 1 FROM events WHERE id')) {
      return {rows: {_array: this.rows.has(params[0] as string) ? [{}] : []}, rowsAffected: 0};
    }
    if (sql.includes('SELECT kind FROM events WHERE id')) {
      const r = this.rows.get(params[0] as string);
      return {rows: {_array: r ? [{kind: r.event.kind}] : []}, rowsAffected: 0};
    }
    if (sql.startsWith('DELETE FROM events WHERE id')) {
      const removed = this.rows.delete(params[0] as string);
      return {rows: {_array: []}, rowsAffected: removed ? 1 : 0};
    }
    if (sql.startsWith('DELETE FROM events')) {
      this.rows.clear();
      return none;
    }
    if (sql.includes('DISTINCT kind')) {
      const kinds = [...new Set([...this.rows.values()].map(r => r.event.kind))];
      return {rows: {_array: kinds.map(kind => ({kind}))}, rowsAffected: 0};
    }
    return none; // CREATE TABLE/INDEX etc.
  }
}

const ev = (id: string, kind = 7, created_at = 1): Event => ({
  id,
  pubkey: 'p',
  created_at,
  kind,
  tags: [],
  content: '',
  sig: 's',
});

/** Store pre-seeded with `n` kind-7 rows (written through save so the fake assigns rowids). */
function seeded(n: number): {store: SqliteEventStore; db: ChunkFakeDb} {
  const db = new ChunkFakeDb();
  const seedStore = new SqliteEventStore(db);
  for (let i = 0; i < n; i++) seedStore.save(ev(`r${i}`));
  // A FRESH store over the same db: its mirror is cold, so the warm actually reads the durable rows.
  const store = new SqliteEventStore(db);
  db.chunkSelects = 0;
  return {store, db};
}

describe('SqliteEventStore.warmKindChunked', () => {
  it('warms the full bucket across multiple bounded chunks and marks the kind warm', async () => {
    const {store, db} = seeded(1050);
    await store.warmKindChunked(7, 500);
    // 1050 rows at 500/chunk = chunks of 500, 500, 50 (the short chunk terminates the loop).
    expect(db.chunkSelects).toBe(3);
    expect(store.query({kinds: [7]})).toHaveLength(1050);
    // The bucket is marked warm: querying again runs NO further bucket SELECT (sync or chunked).
    const before = db.chunkSelects;
    store.query({kinds: [7]});
    expect(db.chunkSelects).toBe(before);
  });

  it('default chunk size is WARM_CHUNK_ROWS', async () => {
    const {store, db} = seeded(WARM_CHUNK_ROWS + 1);
    await store.warmKindChunked(7);
    expect(db.chunkSelects).toBe(2); // one full chunk + the short terminating chunk
    expect(store.query({kinds: [7]})).toHaveLength(WARM_CHUNK_ROWS + 1);
  });

  it('coalesces concurrent warms of the same kind into one pass', async () => {
    const {store, db} = seeded(600);
    const a = store.warmKindChunked(7, 500);
    const b = store.warmKindChunked(7, 500);
    expect(b).toBe(a); // second caller shares the in-flight promise
    await Promise.all([a, b]);
    expect(db.chunkSelects).toBe(2);
    expect(store.query({kinds: [7]})).toHaveLength(600);
  });

  it('resolves immediately for an already-warm kind (no SELECT at all)', async () => {
    const {store, db} = seeded(10);
    store.query({kinds: [7]}); // sync warm
    const selects = db.chunkSelects;
    await store.warmKindChunked(7, 5);
    expect(db.chunkSelects).toBe(selects);
  });

  it('clear() mid-warm aborts the pass — the wiped kind is NEVER marked warm over stale rows', async () => {
    const {store} = seeded(1200);
    const warm = store.warmKindChunked(7, 500); // will yield after the first chunk
    store.clear(); // duress wipe between chunks
    await warm;
    // The wipe must win: nothing resurrected from the aborted pass's already-indexed first chunk.
    expect(store.query({kinds: [7]})).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it('a targeted delete between chunks is not resurrected by the finished warm', async () => {
    const {store} = seeded(700);
    const warm = store.warmKindChunked(7, 500);
    // r0 was in the FIRST chunk (already indexed when this runs on the yield boundary); r600 is in
    // the second, not yet read. Both must be gone from the final warm bucket.
    await Promise.resolve(); // let the first chunk index synchronously inside warmKindChunked
    store.remove('r0');
    store.remove('r600');
    await warm;
    const ids = new Set(store.query({kinds: [7]}).map(e => e.id));
    expect(ids.has('r0')).toBe(false);
    expect(ids.has('r600')).toBe(false);
    expect(ids.size).toBe(698);
  });

  it('a save during the warm is not double-counted (id-keyed dedupe)', async () => {
    const {store} = seeded(600);
    const warm = store.warmKindChunked(7, 500);
    store.save(ev('fresh')); // lands in the mirror now AND gets a rowid a later chunk may re-read
    await warm;
    const all = store.query({kinds: [7]});
    expect(all).toHaveLength(601);
    expect(all.filter(e => e.id === 'fresh')).toHaveLength(1);
  });

  it('close() mid-warm aborts without touching the released handle further', async () => {
    const {store, db} = seeded(1200);
    const warm = store.warmKindChunked(7, 500);
    store.close();
    const selectsAtClose = db.chunkSelects;
    await warm;
    expect(db.chunkSelects).toBe(selectsAtClose); // no further chunk SELECT after close
  });

  it('SwappableEventStore passes through, and resolves for stores without a chunked warm', async () => {
    const {store} = seeded(20);
    const wrap = new SwappableEventStore(store);
    await wrap.warmKindChunked(7, 10);
    expect(wrap.query({kinds: [7]})).toHaveLength(20);
    // A backing store without warmKindChunked (duck-typed absent) resolves immediately.
    const bare = new SwappableEventStore({
      save: () => true,
      has: () => false,
      getById: () => undefined,
      query: () => [],
      getPosts: () => [],
      latestCreatedAt: () => undefined,
      size: () => 0,
      clear: () => undefined,
    });
    await expect(bare.warmKindChunked(7)).resolves.toBeUndefined();
  });
});
