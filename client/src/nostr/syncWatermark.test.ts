import type {SecureStorage} from '../keys/keystore';
import {
  loadWatermark,
  saveWatermark,
  clearWatermark,
  setWatermarkRuntime,
  getWatermarkRuntime,
  clearWatermarkRuntime,
} from './syncWatermark';

/** Fake hardware-backed KV over a Map — mirrors SecureStorage exactly, holds any string. */
class FakeSecureStorage implements SecureStorage {
  readonly map = new Map<string, string>();
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

// Prefix is a private module const; reconstruct the exact persisted key to plant a corrupt blob.
const keyFor = (cid: string) => `stiq.sync.watermark.${cid}`;

describe('syncWatermark — persisted store', () => {
  it('loadWatermark returns null for an unseen cid', async () => {
    const storage = new FakeSecureStorage();
    expect(await loadWatermark(storage, 'community-a')).toBeNull();
  });

  it('save → load round-trips the reconciledThrough number', async () => {
    const storage = new FakeSecureStorage();
    await saveWatermark(storage, 'community-a', 1_700_000_000);
    expect(await loadWatermark(storage, 'community-a')).toBe(1_700_000_000);
  });

  it('saveWatermark is monotonic — an older value is ignored, a newer one advances', async () => {
    const storage = new FakeSecureStorage();
    await saveWatermark(storage, 'community-a', 1_700_000_000);
    await saveWatermark(storage, 'community-a', 1_600_000_000); // older → ignored
    expect(await loadWatermark(storage, 'community-a')).toBe(1_700_000_000);
    await saveWatermark(storage, 'community-a', 1_700_000_000); // equal → ignored
    expect(await loadWatermark(storage, 'community-a')).toBe(1_700_000_000);
    await saveWatermark(storage, 'community-a', 1_800_000_000); // newer → advances
    expect(await loadWatermark(storage, 'community-a')).toBe(1_800_000_000);
  });

  it('loadWatermark returns null on a corrupt JSON blob', async () => {
    const storage = new FakeSecureStorage();
    storage.map.set(keyFor('community-a'), '{not valid json');
    expect(await loadWatermark(storage, 'community-a')).toBeNull();
  });

  it('loadWatermark returns null when the stored record lacks a numeric reconciledThrough', async () => {
    const storage = new FakeSecureStorage();
    storage.map.set(keyFor('community-a'), JSON.stringify({reconciledThrough: 'nope', savedAt: 1}));
    expect(await loadWatermark(storage, 'community-a')).toBeNull();
  });

  it('clearWatermark removes the persisted entry (load → null afterward)', async () => {
    const storage = new FakeSecureStorage();
    await saveWatermark(storage, 'community-a', 1_700_000_000);
    await clearWatermark(storage, 'community-a');
    expect(await loadWatermark(storage, 'community-a')).toBeNull();
  });

  it('watermarks are per-cid — one community does not leak into another', async () => {
    const storage = new FakeSecureStorage();
    await saveWatermark(storage, 'community-a', 1_700_000_000);
    expect(await loadWatermark(storage, 'community-b')).toBeNull();
  });
});

describe('syncWatermark — synchronous runtime mirror', () => {
  beforeEach(() => clearWatermarkRuntime()); // isolate the module-level Map between tests

  it('getWatermarkRuntime reflects the last setWatermarkRuntime without awaiting', () => {
    expect(getWatermarkRuntime('community-a')).toBeUndefined();
    setWatermarkRuntime('community-a', 1_700_000_000);
    expect(getWatermarkRuntime('community-a')).toBe(1_700_000_000);
  });

  it('setWatermarkRuntime keeps the MAX seen (never lowers)', () => {
    setWatermarkRuntime('community-a', 1_700_000_000);
    setWatermarkRuntime('community-a', 1_600_000_000); // older → ignored
    expect(getWatermarkRuntime('community-a')).toBe(1_700_000_000);
    setWatermarkRuntime('community-a', 1_800_000_000); // newer → advances
    expect(getWatermarkRuntime('community-a')).toBe(1_800_000_000);
  });

  it('clearWatermarkRuntime(cid) drops just that community', () => {
    setWatermarkRuntime('community-a', 1);
    setWatermarkRuntime('community-b', 2);
    clearWatermarkRuntime('community-a');
    expect(getWatermarkRuntime('community-a')).toBeUndefined();
    expect(getWatermarkRuntime('community-b')).toBe(2);
  });

  it('clearWatermarkRuntime() with no cid empties the whole mirror (duress / reset)', () => {
    setWatermarkRuntime('community-a', 1);
    setWatermarkRuntime('community-b', 2);
    clearWatermarkRuntime();
    expect(getWatermarkRuntime('community-a')).toBeUndefined();
    expect(getWatermarkRuntime('community-b')).toBeUndefined();
  });
});
