import {SEND_JITTER_MAX_MS, SEND_JITTER_MIN_MS, sendJitterMs} from './sendJitter';

describe('sendJitterMs', () => {
  it('returns the floor at rng=0', () => {
    expect(sendJitterMs(() => 0)).toBe(SEND_JITTER_MIN_MS);
  });

  it('returns (essentially) the ceiling as rng→1', () => {
    const v = sendJitterMs(() => 0.999999);
    expect(v).toBeLessThanOrEqual(SEND_JITTER_MAX_MS);
    expect(v).toBeGreaterThanOrEqual(SEND_JITTER_MAX_MS - 1);
  });

  it('stays within [MIN, MAX] for a sweep of rng values and is always an integer', () => {
    for (let i = 0; i <= 100; i++) {
      const r = i / 100;
      const v = sendJitterMs(() => r);
      expect(v).toBeGreaterThanOrEqual(SEND_JITTER_MIN_MS);
      expect(v).toBeLessThanOrEqual(SEND_JITTER_MAX_MS);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
