import {InMemorySecureStorage} from '../keys/keystore';
import {
  loadCachedBridges,
  saveCachedBridges,
  clearCachedBridges,
  loadFetchedBridges,
  saveFetchedBridges,
  loadCachedBridgesForClass,
  saveCachedBridgesForClass,
  clearCachedBridgesForClass,
  clearAllNetworkClassBridges,
  netClassCacheKey,
} from './bridgeCache';

const BRIDGES = ['webtunnel 1.2.3.4:443 AA...'];

describe('bridgeCache', () => {
  it('returns null when nothing is cached', async () => {
    const storage = new InMemorySecureStorage();
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('round-trips a saved bridge set', async () => {
    const storage = new InMemorySecureStorage();
    await saveCachedBridges(storage, 'webtunnel', BRIDGES);
    const loaded = await loadCachedBridges(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.transport).toBe('webtunnel');
    expect(loaded!.bridgeLines).toEqual(BRIDGES);
    expect(loaded!.savedAt).toBeGreaterThan(0);
  });

  it('returns null after clearCachedBridges', async () => {
    const storage = new InMemorySecureStorage();
    await saveCachedBridges(storage, 'obfs4', BRIDGES);
    await clearCachedBridges(storage);
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('returns null when the cache is older than 14 days', async () => {
    const storage = new InMemorySecureStorage();
    const stale = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const payload = {transport: 'obfs4', bridgeLines: BRIDGES, savedAt: stale};
    await storage.setItem('stiq.tor.bridges', JSON.stringify(payload));
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('returns null when the stored JSON is corrupt', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem('stiq.tor.bridges', 'not-json{{{');
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('returns null when bridgeLines is empty in stored data', async () => {
    const storage = new InMemorySecureStorage();
    const payload = {transport: 'obfs4', bridgeLines: [], savedAt: Date.now()};
    await storage.setItem('stiq.tor.bridges', JSON.stringify(payload));
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('does not save when bridgeLines is empty', async () => {
    const storage = new InMemorySecureStorage();
    await saveCachedBridges(storage, 'webtunnel', []);
    expect(await loadCachedBridges(storage)).toBeNull();
  });

  it('overwrites a previous cache with a new save', async () => {
    const storage = new InMemorySecureStorage();
    await saveCachedBridges(storage, 'obfs4', ['obfs4-bridge']);
    await saveCachedBridges(storage, 'webtunnel', BRIDGES);
    const loaded = await loadCachedBridges(storage);
    expect(loaded!.transport).toBe('webtunnel');
    expect(loaded!.bridgeLines).toEqual(BRIDGES);
  });

  describe('fetched-bridge cache', () => {
    it('round-trips fetched bridges per transport', async () => {
      const storage = new InMemorySecureStorage();
      await saveFetchedBridges(storage, 'webtunnel', BRIDGES);
      expect(await loadFetchedBridges(storage, 'webtunnel')).toEqual(BRIDGES);
      // Keyed by transport — a different transport is independent.
      expect(await loadFetchedBridges(storage, 'obfs4')).toBeNull();
    });

    it('ignores empty sets on save', async () => {
      const storage = new InMemorySecureStorage();
      await saveFetchedBridges(storage, 'webtunnel', []);
      expect(await loadFetchedBridges(storage, 'webtunnel')).toBeNull();
    });

    it('expires fetched bridges after the refresh TTL (24h)', async () => {
      const storage = new InMemorySecureStorage();
      const stale = Date.now() - 25 * 60 * 60 * 1000;
      await storage.setItem(
        'stiq.tor.fetched.webtunnel',
        JSON.stringify({bridgeLines: BRIDGES, savedAt: stale}),
      );
      expect(await loadFetchedBridges(storage, 'webtunnel')).toBeNull();
    });

    it('returns null on corrupt stored data', async () => {
      const storage = new InMemorySecureStorage();
      await storage.setItem('stiq.tor.fetched.obfs4', 'not-json{{{');
      expect(await loadFetchedBridges(storage, 'obfs4')).toBeNull();
    });
  });

  describe('per-network-class cache', () => {
    it('keys entries under the stiq.tor.bridges namespace', () => {
      // Sub-namespace of the global key so one duress sweep of `stiq.tor.bridges*` catches all.
      expect(netClassCacheKey('wifi')).toBe('stiq.tor.bridges.net.wifi');
    });

    it('round-trips a per-class set and isolates classes', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'wifi', 'webtunnel', BRIDGES);
      const loaded = await loadCachedBridgesForClass(storage, 'wifi');
      expect(loaded).not.toBeNull();
      expect(loaded!.transport).toBe('webtunnel');
      expect(loaded!.bridgeLines).toEqual(BRIDGES);
      expect(loaded!.savedAt).toBeGreaterThan(0);
      // A wifi entry is NOT returned for cellular — classes are isolated.
      expect(await loadCachedBridgesForClass(storage, 'cellular')).toBeNull();
      // …and does not leak into the legacy global cache either.
      expect(await loadCachedBridges(storage)).toBeNull();
    });

    it('keeps distinct classes independent', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'wifi', 'obfs4', ['wifi-bridge']);
      await saveCachedBridgesForClass(storage, 'cellular', 'webtunnel', ['cell-bridge']);
      expect((await loadCachedBridgesForClass(storage, 'wifi'))!.transport).toBe('obfs4');
      expect((await loadCachedBridgesForClass(storage, 'cellular'))!.transport).toBe('webtunnel');
    });

    it('caches the direct rung with no bridges', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'ethernet', 'direct', []);
      const loaded = await loadCachedBridgesForClass(storage, 'ethernet');
      expect(loaded!.transport).toBe('direct');
      expect(loaded!.bridgeLines).toEqual([]);
    });

    it('never persists the "unknown" class', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'unknown', 'webtunnel', BRIDGES);
      expect(await loadCachedBridgesForClass(storage, 'unknown')).toBeNull();
    });

    it('does not save a non-direct class with empty bridge lines', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'wifi', 'webtunnel', []);
      expect(await loadCachedBridgesForClass(storage, 'wifi')).toBeNull();
    });

    it('expires a per-class entry older than MAX_AGE_MS (14 days)', async () => {
      jest.useFakeTimers();
      try {
        const storage = new InMemorySecureStorage();
        await saveCachedBridgesForClass(storage, 'wifi', 'webtunnel', BRIDGES);
        expect(await loadCachedBridgesForClass(storage, 'wifi')).not.toBeNull();
        // Advance the clock past the 14-day staleness window shared with the global cache.
        jest.advanceTimersByTime(15 * 24 * 60 * 60 * 1000);
        expect(await loadCachedBridgesForClass(storage, 'wifi')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('clearCachedBridgesForClass drops only that class', async () => {
      const storage = new InMemorySecureStorage();
      await saveCachedBridgesForClass(storage, 'wifi', 'webtunnel', BRIDGES);
      await saveCachedBridgesForClass(storage, 'cellular', 'obfs4', ['cell-bridge']);
      await clearCachedBridgesForClass(storage, 'wifi');
      expect(await loadCachedBridgesForClass(storage, 'wifi')).toBeNull();
      expect(await loadCachedBridgesForClass(storage, 'cellular')).not.toBeNull();
    });

    it('clearAllNetworkClassBridges wipes every class (duress-wipe coverage)', async () => {
      const storage = new InMemorySecureStorage();
      // A device that has roamed across several networks accumulates one entry per class.
      await saveCachedBridgesForClass(storage, 'wifi', 'webtunnel', BRIDGES);
      await saveCachedBridgesForClass(storage, 'cellular', 'obfs4', ['cell-bridge']);
      await saveCachedBridgesForClass(storage, 'ethernet', 'direct', []);
      await saveCachedBridgesForClass(storage, 'vpn', 'webtunnel', ['vpn-bridge']);
      await saveCachedBridgesForClass(storage, 'other', 'obfs4', ['other-bridge']);

      // The identity-reset hook the duress wipe must call.
      await clearAllNetworkClassBridges(storage);

      for (const netClass of ['wifi', 'cellular', 'ethernet', 'vpn', 'other'] as const) {
        expect(await loadCachedBridgesForClass(storage, netClass)).toBeNull();
      }
    });
  });
});
