/**
 * PinAttemptLimiter — persistent brute-force throttle for PIN entry (security finding #21).
 *
 * Every PIN surface (lock screen, vault unlock, key-backup re-entry) verifies through
 * {@link PinVault.verify}, so the limiter lives inside it as the single chokepoint that covers all
 * of them. A consecutive-failure counter is persisted in hardware-backed SecureStorage — so killing
 * and reopening the app cannot reset it — and, past a small free-retry allowance, imposes an
 * escalating lockout window during which every attempt is rejected WITHOUT checking the PIN. A
 * correct PIN clears the counter.
 *
 * The clock is injected so the escalation is unit-testable without real time, and there is no
 * sleeping: lockout is enforced by comparing `now()` to a stored `lockedUntil`, which keeps verify
 * non-blocking and deterministic.
 */
import type {SecureStorage} from '../keys/keystore';

const ATTEMPTS_ITEM = 'stiq.pin.attempts';

/** Wrong attempts allowed with no delay before the escalating lockout kicks in. */
export const FREE_ATTEMPTS = 5;

/** First lockout window (ms), applied at consecutive-failure count FREE_ATTEMPTS+1. */
export const BASE_BACKOFF_MS = 30_000;

/**
 * Ceiling on the escalating lockout (ms) — 30 minutes. However many times a user keeps failing,
 * the window never grows past this, and there is NEVER a permanent lockout (product decision: a
 * lost/forgotten PIN must never brick the app). A correct PIN — including the duress PIN, which is
 * exempt from this gate entirely, see PinVault.verify — clears the counter.
 */
export const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Lockout window (ms) for the `over`-th failure past the free allowance (over = 1, 2, 3, …): starts
 * at BASE_BACKOFF_MS and DOUBLES each subsequent round, capped at MAX_BACKOFF_MS. An attacker in
 * physical possession is throttled to a handful of guesses/hour — turning even a 4-digit space
 * (10^4) into a multi-year online brute force — without ever locking a legitimate user out for good.
 */
function backoffForRound(over: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (over - 1), MAX_BACKOFF_MS);
}

interface AttemptState {
  fails: number;
  lockedUntil: number;
}

export class PinAttemptLimiter {
  /** In-memory mirror of the persisted counter (loaded lazily, then kept in sync on write). */
  private state: AttemptState | null = null;

  constructor(
    private readonly storage: SecureStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async load(): Promise<AttemptState> {
    if (this.state) return this.state;
    try {
      const raw = await this.storage.getItem(ATTEMPTS_ITEM);
      const parsed = raw ? (JSON.parse(raw) as Partial<AttemptState>) : null;
      this.state = {
        fails: typeof parsed?.fails === 'number' ? parsed.fails : 0,
        lockedUntil: typeof parsed?.lockedUntil === 'number' ? parsed.lockedUntil : 0,
      };
    } catch {
      // A corrupt/unreadable counter fails safe to "no prior failures" — it never bricks unlock.
      this.state = {fails: 0, lockedUntil: 0};
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    try {
      await this.storage.setItem(ATTEMPTS_ITEM, JSON.stringify(this.state));
    } catch {
      // Best effort — an unwritable counter must not hard-fail unlock.
    }
  }

  /** Ms until the lockout lifts (0 when not locked out). Exposed so a UI can show a countdown. */
  async lockoutRemainingMs(): Promise<number> {
    const s = await this.load();
    return Math.max(0, s.lockedUntil - this.now());
  }

  /** True while a lockout window is active — verify should reject WITHOUT checking the PIN. */
  async isLockedOut(): Promise<boolean> {
    return (await this.lockoutRemainingMs()) > 0;
  }

  /** Record a wrong PIN; arms/extends the escalating lockout once past the free allowance. */
  async recordFailure(): Promise<void> {
    const s = await this.load();
    s.fails += 1;
    const over = s.fails - FREE_ATTEMPTS;
    if (over > 0) {
      s.lockedUntil = this.now() + backoffForRound(over);
    }
    await this.persist();
  }

  /** Record a correct PIN; clears the counter and any active lockout. */
  async recordSuccess(): Promise<void> {
    this.state = {fails: 0, lockedUntil: 0};
    await this.persist();
  }

  /** Forget the persisted counter (duress/kill-switch wipe, or a deliberate PIN reset). */
  async reset(): Promise<void> {
    this.state = {fails: 0, lockedUntil: 0};
    try {
      await this.storage.removeItem(ATTEMPTS_ITEM);
    } catch {
      // Best effort.
    }
  }
}
