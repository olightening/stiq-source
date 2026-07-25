/**
 * Persistent, encrypted event cache factory (PLAN.md Step 5 + §4).
 *
 * Wires SqliteEventStore to the native op-sqlite driver with SQLCipher encryption at rest.
 * The DB key is 32 random bytes generated on first run and held in the Keystore-backed secure
 * store, so the cache file is unreadable if the device is seized — and the key is dropped on a
 * duress wipe (see wipeEncryptedCache). When the native module is absent (jest, non-Android
 * builds) the factory returns null and the caller falls back to the in-memory store, so the
 * app still runs (just without persistence).
 */
import {SqliteEventStore, type SqliteDb, type RetentionPolicy} from './sqliteStore';
import type {SecureStorage} from '../keys/keystore';
import {randomBytes} from '../util/random';
import {bytesToHex} from '../util/hex';
import {
  LEGACY_SQLITE_DB,
  LEGACY_SQLITE_DBKEY_ITEM,
  sqliteDbFile,
  sqliteDbKeyItem,
} from '../app/workspaceKeys';

export const DB_NAME = LEGACY_SQLITE_DB;
export const CACHE_DB_KEY_ITEM = LEGACY_SQLITE_DBKEY_ITEM;

/** The DB file name for a (community, account) pair — its own encrypted cache — or the legacy shared
 *  file. Passing `cid` with no `slotId` yields the pre-per-account per-cid name (used by the wipe
 *  migration to delete the now-orphaned legacy file). */
const dbFileFor = (cid?: string, slotId?: string): string =>
  cid ? sqliteDbFile(cid, slotId) : LEGACY_SQLITE_DB;
/** The secure-storage key item holding a (community, account) SQLCipher key, or the legacy shared item. */
const dbKeyItemFor = (cid?: string, slotId?: string): string =>
  cid ? sqliteDbKeyItem(cid, slotId) : LEGACY_SQLITE_DBKEY_ITEM;

/** op-sqlite's synchronous result; `rows` shape varies by version, so we normalize it. */
interface OpSqliteResult {
  rows?: unknown[] | {_array?: unknown[]};
  rowsAffected?: number;
}
interface OpSqliteDb {
  executeSync(sql: string, params?: unknown[]): OpSqliteResult;
  delete?(): void;
  close?(): void;
}
interface OpSqliteModule {
  open(opts: {name: string; encryptionKey?: string}): OpSqliteDb;
}

/** Lazy-load op-sqlite; returns undefined when the native module isn't linked. */
function loadOpSqlite(): OpSqliteModule | undefined {
  try {
    // require (not import) so Metro/jest only touch the native module on device.
    return require('@op-engineering/op-sqlite') as OpSqliteModule;
  } catch {
    return undefined;
  }
}

/** Adapt op-sqlite's synchronous API to the SqliteDb contract SqliteEventStore expects. */
function adapt(db: OpSqliteDb): SqliteDb {
  return {
    execute(sql, params = []) {
      const res = db.executeSync(sql, params);
      const raw = res.rows;
      const _array = Array.isArray(raw) ? raw : (raw?._array ?? []);
      return {rows: {_array}, rowsAffected: res.rowsAffected ?? 0};
    },
    close: db.close ? () => db.close?.() : undefined,
  };
}

/** Read the (community, account) SQLCipher key (hex), or mint and persist a fresh 256-bit one. */
export async function ensureCacheKey(
  storage: SecureStorage,
  cid?: string,
  slotId?: string,
): Promise<string> {
  const item = dbKeyItemFor(cid, slotId);
  const existing = await storage.getItem(item);
  if (existing) {
    return existing;
  }
  const key = bytesToHex(randomBytes(32));
  await storage.setItem(item, key);
  return key;
}

/**
 * Open the (community, account) encrypted persistent event store (its own DB file
 * `stiq-cache-<cid>__<slot>.db` — one per account for COMPLETE per-account isolation, finding #4),
 * or return null when op-sqlite isn't available (so the app degrades to the in-memory store instead
 * of crashing). Omitting `cid` opens the legacy shared file (pre-silo / un-enrolled); omitting only
 * `slotId` keeps the pre-per-account per-cid file.
 *
 * `policy` (T16-S2) seeds the store's mutable RetentionPolicy at open, so cold boot prunes with the
 * organizer-tuned caps BEFORE the first prune fires (App.tsx passes
 * `COMPACTION_V2 ? toRetentionPolicy(active?.storagePolicy) : undefined`). Optional and forwarded
 * verbatim to the constructor, so the flag-off / un-tuned path stays byte-identical to today.
 */
export async function createEncryptedEventStore(
  storage: SecureStorage,
  cid?: string,
  slotId?: string,
  policy?: Partial<RetentionPolicy>,
): Promise<SqliteEventStore | null> {
  const op = loadOpSqlite();
  if (!op) {
    return null;
  }
  try {
    const key = await ensureCacheKey(storage, cid, slotId);
    // Phase 6.3b (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md): `op.open` runs SQLCipher's key
    // derivation SYNCHRONOUSLY on the JS thread (op-sqlite is sync-JSI by design — it cannot move
    // off-thread), a one-off ~100-300ms block on cold open and on every community switch. The
    // switch UI keeps painting the outgoing community's stale snapshot (AppRuntime.switching →
    // _lastSnapshot), so the block is invisible as long as the LAST frame before it is fresh —
    // this macrotask yield guarantees React commits + paints that frame before the KDF lands.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const db = op.open({name: dbFileFor(cid, slotId), encryptionKey: key});
    return new SqliteEventStore(adapt(db), policy);
  } catch {
    return null;
  }
}

/**
 * Drop the (community, account) SQLCipher key and delete its cache file so the (encrypted) events
 * can't be recovered even forensically. Used by BOTH the duress wipe (omit `cid` → legacy file, plus
 * the runtime iterates communities × their slots) and `removeCommunity`/`removeIdentity` (leaving a
 * community/account). Best-effort; never throws.
 */
export async function wipeEncryptedCache(
  storage: SecureStorage,
  cid?: string,
  slotId?: string,
): Promise<void> {
  try {
    await storage.removeItem(dbKeyItemFor(cid, slotId));
  } catch {
    // ignore
  }
  const op = loadOpSqlite();
  if (!op) {
    return;
  }
  try {
    // Re-open is unnecessary: op-sqlite can delete a DB file by name. Open then delete to be
    // robust across versions that only expose instance-level delete().
    const db = op.open({name: dbFileFor(cid, slotId)});
    db.delete?.();
    db.close?.();
  } catch {
    // ignore — the key is already gone, so the ciphertext is unreadable regardless
  }
}

/**
 * One-time cleanup for finding #4: wipe the ORPHANED pre-per-account per-cid store — the file +
 * SQLCipher key that existed before the event cache was namespaced by the account slot. Computes the
 * OLD per-cid names (slotId undefined) so the leftover ciphertext + key can't be recovered. Called by
 * the wipe migration (once per known community) and by `removeCommunity`. Best-effort; never throws.
 */
export async function wipeLegacyCidStore(storage: SecureStorage, cid: string): Promise<void> {
  await wipeEncryptedCache(storage, cid); // slotId undefined → the OLD per-cid file + key
}
