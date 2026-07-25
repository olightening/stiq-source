/**
 * Auto-lock controller (PLAN.md §3.5 / Step 10).
 *
 * A general-purpose inactivity-timeout + lock-state machine: touch() refreshes the timer while
 * unlocked, and the timer locks after `timeoutMs` of inactivity; unlock() opens the app after a
 * successful PIN check; lock() is immediate (idle timeout, or any explicit caller). This holds
 * only lock STATE — it never touches keys or data. There is no biometric unlock path anywhere in
 * this codebase (an older version of this comment implied one — it does not exist).
 *
 * `timeoutMs` defaults to AUTO_LOCK_MS (config.ts — 5 min, not the previously-stated "60s", which
 * was stale). Pass `Infinity` to disable the idle timeout entirely: arm() then never schedules a
 * timer, so once unlocked the state stays 'unlocked' until an explicit lock() call. STIQ's
 * production wiring (App.tsx) does exactly this by default as of the 2026-07-15 bug round — user
 * decision: the PIN re-locks only on a genuine cold start, never on an idle timer or on
 * backgrounding (see config.ts's `IDLE_LOCK_ENABLED` / `LOCK_ON_BACKGROUND` and
 * BUGROUND_COORDINATION.md). The timer/arm/disarm mechanics below are untouched by that decision
 * and fully restorable — every test in autolock.test.ts still constructs `AutoLock` with a real
 * finite timeout and it behaves exactly as before.
 */
import {AUTO_LOCK_MS} from '../config';

export type LockState = 'locked' | 'unlocked';

export class AutoLock {
  private state: LockState = 'locked';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(state: LockState) => void>();

  constructor(private readonly timeoutMs: number = AUTO_LOCK_MS) {}

  getState(): LockState {
    return this.state;
  }

  onChange(listener: (state: LockState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Open the app (after a successful unlock) and arm the inactivity timer. */
  unlock(): void {
    this.setState('unlocked');
    this.arm();
  }

  /** Lock immediately (idle timeout, or any explicit caller — e.g. App.tsx on backgrounding,
   *  when LOCK_ON_BACKGROUND is enabled). */
  lock(): void {
    this.disarm();
    this.setState('locked');
  }

  /** Register user activity; refreshes the inactivity timer while unlocked. */
  touch(): void {
    if (this.state === 'unlocked') {
      this.arm();
    }
  }

  /** Stop any pending timer (e.g. on teardown). */
  dispose(): void {
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    // A non-finite timeout (Infinity — see the class doc comment) means "never auto-lock on
    // idle": leave no timer scheduled. Passing Infinity/NaN straight to setTimeout would NOT be a
    // safe no-op — WHATWG platforms coerce a non-finite delay to 0, which would fire IMMEDIATELY,
    // the opposite of "disabled" — so this guards that explicitly rather than relying on it.
    if (!Number.isFinite(this.timeoutMs)) {
      return;
    }
    this.timer = setTimeout(() => this.lock(), this.timeoutMs);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private setState(next: LockState): void {
    if (next === this.state) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
