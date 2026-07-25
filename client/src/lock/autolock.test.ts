import {AutoLock} from './autolock';
import {AUTO_LOCK_MS, IDLE_LOCK_ENABLED, LOCK_ON_BACKGROUND} from '../config';

describe('AutoLock', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts locked and unlocks', () => {
    const lock = new AutoLock(60_000);
    expect(lock.getState()).toBe('locked');
    lock.unlock();
    expect(lock.getState()).toBe('unlocked');
  });

  it('locks after the inactivity timeout', () => {
    const lock = new AutoLock(60_000);
    const states: string[] = [];
    lock.onChange(s => states.push(s));

    lock.unlock();
    jest.advanceTimersByTime(59_000);
    expect(lock.getState()).toBe('unlocked');
    jest.advanceTimersByTime(2_000);
    expect(lock.getState()).toBe('locked');
    expect(states).toEqual(['unlocked', 'locked']);
  });

  it('touch() refreshes the inactivity timer', () => {
    const lock = new AutoLock(60_000);
    lock.unlock();
    jest.advanceTimersByTime(50_000);
    lock.touch(); // activity
    jest.advanceTimersByTime(50_000); // 100s total, but only 50s since touch
    expect(lock.getState()).toBe('unlocked');
    jest.advanceTimersByTime(11_000);
    expect(lock.getState()).toBe('locked');
  });

  it('touch() does nothing while locked', () => {
    const lock = new AutoLock(60_000);
    lock.touch();
    expect(lock.getState()).toBe('locked');
  });

  it('lock() is immediate and idempotent for state', () => {
    const lock = new AutoLock(60_000);
    lock.unlock();
    lock.lock();
    expect(lock.getState()).toBe('locked');
    lock.dispose();
  });

  // Infinity ("disabled idle lock") — the sentinel App.tsx wires by default as of the 2026-07-15
  // bug round (see config.ts's IDLE_LOCK_ENABLED). These pin the mechanism the whole "lock on cold
  // start only, no idle timer" fix relies on: arm() must genuinely never schedule a timer, not
  // just schedule one with a very long delay (which would still eventually fire).
  describe('Infinity timeoutMs (idle-lock disabled)', () => {
    it('never locks no matter how much foreground time elapses', () => {
      const lock = new AutoLock(Infinity);
      lock.unlock();
      // Far beyond any realistic session — including the default AUTO_LOCK_MS many times over —
      // and still unlocked, because arm() never scheduled a timer at all.
      jest.advanceTimersByTime(AUTO_LOCK_MS * 1000);
      expect(lock.getState()).toBe('unlocked');
    });

    it('touch() while unlocked stays a harmless no-op (still no live timer)', () => {
      const lock = new AutoLock(Infinity);
      lock.unlock();
      lock.touch();
      lock.touch();
      jest.advanceTimersByTime(AUTO_LOCK_MS * 1000);
      expect(lock.getState()).toBe('unlocked');
    });

    it('a fresh instance still starts locked (cold start is unaffected by the idle-lock sentinel)', () => {
      expect(new AutoLock(Infinity).getState()).toBe('locked');
    });

    it('lock() still works immediately — disabling the idle timer does not disable manual/explicit lock', () => {
      const lock = new AutoLock(Infinity);
      lock.unlock();
      lock.lock();
      expect(lock.getState()).toBe('locked');
    });
  });

  // Production wiring pin (bug round 2026-07-15). These assert the actual default VALUES App.tsx
  // reads to decide what to wire into `new AppRuntime({autoLockMs: ...})` and the AppState
  // 'background' handler — see App.tsx and config.ts's LOCK_ON_BACKGROUND/IDLE_LOCK_ENABLED doc
  // comments for the full reasoning. If either flips back to `true`, the pre-round idle-lock /
  // lock-on-background behavior is restored byte-identical (AutoLock's own mechanics, tested
  // above and in the rest of this file, are untouched either way).
  describe('production defaults (config.ts)', () => {
    it('LOCK_ON_BACKGROUND defaults off — backgrounding must not lock', () => {
      expect(LOCK_ON_BACKGROUND).toBe(false);
    });

    it('IDLE_LOCK_ENABLED defaults off — no inactivity-timeout lock', () => {
      expect(IDLE_LOCK_ENABLED).toBe(false);
    });

    it('the value App.tsx actually wires into AutoLock (mirrored here) never idle-locks', () => {
      const autoLockMs = IDLE_LOCK_ENABLED ? AUTO_LOCK_MS : Number.POSITIVE_INFINITY;
      const lock = new AutoLock(autoLockMs);
      lock.unlock();
      jest.advanceTimersByTime(AUTO_LOCK_MS * 1000);
      expect(lock.getState()).toBe('unlocked');
    });
  });
});
