import {
  SYNC_FLEX_MINUTES,
  SYNC_PERIOD_MAX_MINUTES,
  SYNC_PERIOD_MIN_MINUTES,
  SYNC_STARTUP_JITTER_MAX_MS,
  randomizedSyncPeriodMinutes,
  syncStartupJitterMs,
} from './syncSchedule';

describe('randomizedSyncPeriodMinutes', () => {
  it('returns the band floor at rng=0 and ceiling as rng→1', () => {
    expect(randomizedSyncPeriodMinutes(() => 0)).toBe(SYNC_PERIOD_MIN_MINUTES);
    expect(randomizedSyncPeriodMinutes(() => 0.9999)).toBe(SYNC_PERIOD_MAX_MINUTES);
  });

  it('always yields an integer within [15, 26] over the rng [0,1) domain', () => {
    // rng contract matches Math.random: [0, 1). i/100 for i in 0..99 stays strictly below 1.
    for (let i = 0; i < 100; i++) {
      const v = randomizedSyncPeriodMinutes(() => i / 100);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(SYNC_PERIOD_MIN_MINUTES);
      expect(v).toBeLessThanOrEqual(SYNC_PERIOD_MAX_MINUTES);
    }
  });
});

describe('syncStartupJitterMs', () => {
  it('stays within [0, SYNC_STARTUP_JITTER_MAX_MS]', () => {
    expect(syncStartupJitterMs(() => 0)).toBe(0);
    expect(syncStartupJitterMs(() => 1)).toBe(SYNC_STARTUP_JITTER_MAX_MS);
    for (let i = 0; i <= 100; i++) {
      const v = syncStartupJitterMs(() => i / 100);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(SYNC_STARTUP_JITTER_MAX_MS);
    }
  });
});

describe('sync schedule constants', () => {
  it('keeps the flex window at the existing 5 minutes', () => {
    expect(SYNC_FLEX_MINUTES).toBe(5);
  });
});
