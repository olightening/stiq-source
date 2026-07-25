/**
 * Harness validation for the FMD on-device bench (T18-S6). This asserts the timing harness itself
 * behaves (resolves, positive means, correct shape) — the REAL low-end-phone numbers come from
 * running the flag-gated hook on device and reading `[FMD-bench]` from logcat, not from CI.
 */
import {benchFmd} from './bench';
import {FMD_GAMMA} from './fmd';

describe('FMD bench harness (T18-S6)', () => {
  it('benchFmd(10) resolves with positive means and the requested iteration count', async () => {
    const r = await benchFmd(10);
    expect(r.iterations).toBe(10);
    expect(r.gamma).toBe(FMD_GAMMA);
    expect(r.n).toBe(4);
    expect(r.flagMsMean).toBeGreaterThan(0);
    expect(r.testMsMean).toBeGreaterThan(0);
    // p95 is a real, finite, non-negative sample and never below zero.
    expect(Number.isFinite(r.flagMsP95)).toBe(true);
    expect(Number.isFinite(r.testMsP95)).toBe(true);
    expect(r.flagMsP95).toBeGreaterThanOrEqual(0);
    expect(r.testMsP95).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('honours a smaller gamma/n and clamps n to gamma', async () => {
    const r = await benchFmd(4, 6, 99);
    expect(r.iterations).toBe(4);
    expect(r.gamma).toBe(6);
    expect(r.n).toBe(6); // n clamped to gamma
    expect(r.flagMsMean).toBeGreaterThan(0);
  }, 30000);
});
