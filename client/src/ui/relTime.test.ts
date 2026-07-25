import {relTimeShort, relTimeAgo, relTime} from './relTime';

const NOW = 1_700_000_000_000; // fixed wall clock (ms)
const nowS = Math.floor(NOW / 1000);

describe('relTimeShort', () => {
  it('buckets seconds → "now"', () => {
    expect(relTimeShort(nowS - 30, NOW)).toBe('now');
    expect(relTimeShort(nowS, NOW)).toBe('now');
  });
  it('buckets minutes/hours/days', () => {
    expect(relTimeShort(nowS - 120, NOW)).toBe('2m');
    expect(relTimeShort(nowS - 7200, NOW)).toBe('2h');
    expect(relTimeShort(nowS - 172800, NOW)).toBe('2d');
  });
  it('buckets >30d → months', () => {
    expect(relTimeShort(nowS - 5_184_000, NOW)).toBe('2mo');
  });
});

describe('relTimeAgo', () => {
  it('adds the "ago" suffix and "just now" floor', () => {
    expect(relTimeAgo(nowS - 30, NOW)).toBe('just now');
    expect(relTimeAgo(nowS - 120, NOW)).toBe('2m ago');
    expect(relTimeAgo(nowS - 7200, NOW)).toBe('2h ago');
    expect(relTimeAgo(nowS - 172800, NOW)).toBe('2d ago');
  });
  it('caps at days (no month rollover)', () => {
    expect(relTimeAgo(nowS - 5_184_000, NOW)).toBe('60d ago');
  });
});

describe('relTime styles', () => {
  it("'short' rolls over to months", () => {
    expect(relTime(nowS - 30, 'short', NOW)).toBe('now');
    expect(relTime(nowS - 5_184_000, 'short', NOW)).toBe('2mo');
  });
  it("'short-days' caps at days (channels/comments)", () => {
    expect(relTime(nowS - 30, 'short-days', NOW)).toBe('now');
    expect(relTime(nowS - 172800, 'short-days', NOW)).toBe('2d');
    expect(relTime(nowS - 5_184_000, 'short-days', NOW)).toBe('60d');
  });
  it("'ago' matches relTimeAgo verbose form", () => {
    expect(relTime(nowS - 30, 'ago', NOW)).toBe('just now');
    expect(relTime(nowS - 120, 'ago', NOW)).toBe('2m ago');
  });
  it("'log' rounds minutes and clamps negatives (moderation log)", () => {
    // 30s → round(0.5)=1 → "1m" (differs from floor styles which say "now")
    expect(relTime(nowS - 30, 'log', NOW)).toBe('1m');
    // 20s → round(0.33)=0 → "now"
    expect(relTime(nowS - 20, 'log', NOW)).toBe('now');
    expect(relTime(nowS - 120, 'log', NOW)).toBe('2m');
    expect(relTime(nowS - 7200, 'log', NOW)).toBe('2h');
    expect(relTime(nowS - 172800, 'log', NOW)).toBe('2d');
    // future timestamp clamps to "now" rather than a negative age
    expect(relTime(nowS + 600, 'log', NOW)).toBe('now');
  });
});
