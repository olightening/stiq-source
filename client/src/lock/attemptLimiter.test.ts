import {
  PinAttemptLimiter,
  FREE_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from './attemptLimiter';
import {InMemorySecureStorage} from '../keys/keystore';

describe('PinAttemptLimiter (finding #21)', () => {
  it('allows the free attempts, then imposes an escalating lockout', async () => {
    let now = 1_000_000;
    const limiter = new PinAttemptLimiter(new InMemorySecureStorage(), () => now);

    // The free allowance imposes no lockout.
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      await limiter.recordFailure();
      expect(await limiter.isLockedOut()).toBe(false);
    }

    // The next failure arms the first lockout window.
    await limiter.recordFailure();
    expect(await limiter.isLockedOut()).toBe(true);
    const first = await limiter.lockoutRemainingMs();
    expect(first).toBeGreaterThan(0);

    // Once the window elapses, the lockout lifts.
    now += first;
    expect(await limiter.isLockedOut()).toBe(false);

    // A further failure escalates to a strictly LONGER window than the first.
    await limiter.recordFailure();
    expect(await limiter.lockoutRemainingMs()).toBeGreaterThan(first);
  });

  it('policy: 5 free attempts, then 30s doubling each round, capped at 30 minutes', async () => {
    expect(FREE_ATTEMPTS).toBe(5);
    expect(BASE_BACKOFF_MS).toBe(30_000);
    expect(MAX_BACKOFF_MS).toBe(30 * 60_000);

    let now = 0;
    const limiter = new PinAttemptLimiter(new InMemorySecureStorage(), () => now);

    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      await limiter.recordFailure();
      expect(await limiter.isLockedOut()).toBe(false);
    }

    // Round 1 (the 6th total failure): exactly the 30s base window.
    await limiter.recordFailure();
    expect(await limiter.lockoutRemainingMs()).toBe(30_000);
    now += 30_000;

    // Round 2: doubles to 60s.
    await limiter.recordFailure();
    expect(await limiter.lockoutRemainingMs()).toBe(60_000);
    now += 60_000;

    // Round 3: doubles again to 120s.
    await limiter.recordFailure();
    expect(await limiter.lockoutRemainingMs()).toBe(120_000);
    now += 120_000;
  });

  it('never exceeds the 30-minute cap even after many more failures, and never locks out permanently', async () => {
    let now = 0;
    const limiter = new PinAttemptLimiter(new InMemorySecureStorage(), () => now);

    for (let i = 0; i < FREE_ATTEMPTS; i++) await limiter.recordFailure();

    // Grind through enough rounds that uncapped doubling would blow way past 30 minutes.
    for (let round = 0; round < 12; round++) {
      await limiter.recordFailure();
      const remaining = await limiter.lockoutRemainingMs();
      expect(remaining).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      now += remaining; // always advance past the window — never a permanent lockout.
      expect(await limiter.isLockedOut()).toBe(false);
    }
  });

  it('clears the counter and any lockout on success', async () => {
    let now = 5_000;
    const limiter = new PinAttemptLimiter(new InMemorySecureStorage(), () => now);
    for (let i = 0; i <= FREE_ATTEMPTS; i++) await limiter.recordFailure();
    expect(await limiter.isLockedOut()).toBe(true);

    await limiter.recordSuccess();
    expect(await limiter.isLockedOut()).toBe(false);
    expect(await limiter.lockoutRemainingMs()).toBe(0);
  });

  it('persists the counter across instances (an app restart cannot reset it)', async () => {
    const now = 10;
    const storage = new InMemorySecureStorage();
    // Each failure is recorded by a FRESH limiter, simulating the app being killed between guesses.
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      await new PinAttemptLimiter(storage, () => now).recordFailure();
    }
    expect(await new PinAttemptLimiter(storage, () => now).isLockedOut()).toBe(true);
  });

  it('reset() forgets the counter entirely', async () => {
    const now = 42;
    const storage = new InMemorySecureStorage();
    const limiter = new PinAttemptLimiter(storage, () => now);
    for (let i = 0; i <= FREE_ATTEMPTS; i++) await limiter.recordFailure();
    expect(await limiter.isLockedOut()).toBe(true);

    await limiter.reset();
    expect(await limiter.isLockedOut()).toBe(false);
    // A brand-new instance also sees a clean slate (the persisted blob is gone).
    expect(await new PinAttemptLimiter(storage, () => now).isLockedOut()).toBe(false);
  });
});
