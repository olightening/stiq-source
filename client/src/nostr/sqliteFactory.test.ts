import {InMemorySecureStorage} from '../keys/keystore';
import {sqliteDbKeyItem} from '../app/workspaceKeys';
import {
  ensureCacheKey,
  createEncryptedEventStore,
  wipeEncryptedCache,
  wipeLegacyCidStore,
  CACHE_DB_KEY_ITEM,
} from './sqliteFactory';

const CID = 'a'.repeat(56) + '.onion';
const SLOT_1 = 'slot-1111';
const SLOT_2 = 'slot-2222';

describe('sqliteFactory key management', () => {
  it('mints a 256-bit hex key on first use and reuses it after', async () => {
    const storage = new InMemorySecureStorage();
    const first = await ensureCacheKey(storage);
    expect(first).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    const second = await ensureCacheKey(storage);
    expect(second).toBe(first); // stable across calls
    expect(await storage.getItem(CACHE_DB_KEY_ITEM)).toBe(first);
  });

  it('falls back to null when the native SQLite module is absent (jest)', async () => {
    const storage = new InMemorySecureStorage();
    // op-sqlite isn't linked under jest, so the factory degrades instead of throwing.
    await expect(createEncryptedEventStore(storage)).resolves.toBeNull();
    // The new trailing slotId param is optional and still degrades to null under jest.
    await expect(createEncryptedEventStore(storage, CID, SLOT_1)).resolves.toBeNull();
  });

  it('drops the SQLCipher key on a duress wipe', async () => {
    const storage = new InMemorySecureStorage();
    await ensureCacheKey(storage);
    expect(await storage.getItem(CACHE_DB_KEY_ITEM)).not.toBeNull();
    await wipeEncryptedCache(storage);
    expect(await storage.getItem(CACHE_DB_KEY_ITEM)).toBeNull();
  });

  // Finding #4 — the SQLCipher key (like the DB file) is now per-(community, ACCOUNT): two accounts in
  // ONE community must never share a key, so account B can never decrypt account A's cache.
  it('mints DISTINCT keys per (cid, slot) so same-community accounts never share a cache key', async () => {
    const storage = new InMemorySecureStorage();
    const k1 = await ensureCacheKey(storage, CID, SLOT_1);
    const k2 = await ensureCacheKey(storage, CID, SLOT_2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).not.toBe(k1); // separate accounts → separate keys
    // …and each is stored under its own per-(cid, slot) item.
    expect(await storage.getItem(sqliteDbKeyItem(CID, SLOT_1))).toBe(k1);
    expect(await storage.getItem(sqliteDbKeyItem(CID, SLOT_2))).toBe(k2);
    // The legacy per-cid item is untouched by the per-account keys.
    expect(await storage.getItem(sqliteDbKeyItem(CID))).toBeNull();
  });

  it('wipeEncryptedCache(cid, slot) drops only that account key — a sibling account keeps its own', async () => {
    const storage = new InMemorySecureStorage();
    await ensureCacheKey(storage, CID, SLOT_1);
    const k2 = await ensureCacheKey(storage, CID, SLOT_2);
    await wipeEncryptedCache(storage, CID, SLOT_1);
    expect(await storage.getItem(sqliteDbKeyItem(CID, SLOT_1))).toBeNull(); // wiped
    expect(await storage.getItem(sqliteDbKeyItem(CID, SLOT_2))).toBe(k2); // sibling intact
  });

  it('wipeLegacyCidStore drops the orphaned pre-per-account per-cid key (migration cleanup)', async () => {
    const storage = new InMemorySecureStorage();
    await ensureCacheKey(storage, CID); // the OLD per-cid key (no slot)
    expect(await storage.getItem(sqliteDbKeyItem(CID))).not.toBeNull();
    await wipeLegacyCidStore(storage, CID);
    expect(await storage.getItem(sqliteDbKeyItem(CID))).toBeNull();
  });
});
