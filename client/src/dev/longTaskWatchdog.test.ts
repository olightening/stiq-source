import {installLongTaskWatchdog} from './longTaskWatchdog';

/**
 * Tests drive the watchdog with fully injected time/timer/log so they don't depend on jest's fake
 * timers matching real Date.now() drift — each `tick()` call is one simulated timer fire, and
 * `advance(ms)` moves the stubbed clock forward by exactly `ms` before that fire, letting each test
 * assert precisely how much "blocked" time the tick should report.
 */
function makeHarness() {
  let clock = 0;
  const advance = (ms: number) => {
    clock += ms;
  };
  const pending: Array<{fn: () => void; ms: number}> = [];
  const setTimer = jest.fn((fn: () => void, ms: number) => {
    const entry = {fn, ms};
    pending.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimer = jest.fn((handle: ReturnType<typeof setTimeout>) => {
    const idx = pending.indexOf(handle as unknown as {fn: () => void; ms: number});
    if (idx >= 0) pending.splice(idx, 1);
  });
  const logs: string[] = [];
  const log = jest.fn((message: string) => logs.push(message));

  /** Fires the single most-recently-scheduled timer (the watchdog only ever has one in flight). */
  const fireNextTick = () => {
    const entry = pending.shift();
    if (!entry) throw new Error('no pending timer to fire');
    entry.fn();
  };

  return {
    now: () => clock,
    advance,
    setTimer,
    clearTimer,
    log,
    logs,
    fireNextTick,
    pendingCount: () => pending.length,
  };
}

describe('installLongTaskWatchdog', () => {
  it('is a no-op (never schedules a timer) when thresholdMs is 0', () => {
    const h = makeHarness();
    const handle = installLongTaskWatchdog({
      thresholdMs: 0,
      intervalMs: 50,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });
    expect(h.setTimer).not.toHaveBeenCalled();
    expect(h.pendingCount()).toBe(0);
    handle.uninstall(); // should not throw even though nothing was ever scheduled
    expect(h.clearTimer).not.toHaveBeenCalled();
  });

  it('is a no-op when thresholdMs is negative', () => {
    const h = makeHarness();
    installLongTaskWatchdog({
      thresholdMs: -5,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });
    expect(h.setTimer).not.toHaveBeenCalled();
  });

  it('does not log when a tick fires on schedule (no overshoot)', () => {
    const h = makeHarness();
    installLongTaskWatchdog({
      thresholdMs: 100,
      intervalMs: 50,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });
    expect(h.pendingCount()).toBe(1);

    // Tick fires exactly on time: elapsed === intervalMs → blockedMs === 0.
    h.advance(50);
    h.fireNextTick();
    expect(h.log).not.toHaveBeenCalled();

    // A small overshoot under the threshold still should not log.
    h.advance(50 + 40); // interval(50) + 40ms overshoot, threshold is 100
    h.fireNextTick();
    expect(h.log).not.toHaveBeenCalled();
  });

  it('logs with the correct blocked-ms when overshoot exceeds the threshold', () => {
    const h = makeHarness();
    installLongTaskWatchdog({
      thresholdMs: 100,
      intervalMs: 50,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });

    // Simulate the JS thread being blocked: the tick fires 300ms after the previous one instead
    // of the expected 50ms → blockedMs = 300 - 50 = 250, which exceeds the 100ms threshold.
    h.advance(300);
    h.fireNextTick();

    expect(h.log).toHaveBeenCalledTimes(1);
    const message = h.logs[0];
    expect(message).toContain('[STIQ-LONGTASK]');
    expect(message).toContain('250ms');
  });

  it('resets its baseline after each tick, so only fresh stalls are reported', () => {
    const h = makeHarness();
    installLongTaskWatchdog({
      thresholdMs: 100,
      intervalMs: 50,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });

    h.advance(400); // big stall → logs once
    h.fireNextTick();
    expect(h.log).toHaveBeenCalledTimes(1);

    h.advance(50); // next tick right on schedule → no further log
    h.fireNextTick();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling further ticks after uninstall', () => {
    const h = makeHarness();
    const handle = installLongTaskWatchdog({
      thresholdMs: 100,
      intervalMs: 50,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      log: h.log,
    });
    expect(h.pendingCount()).toBe(1);

    handle.uninstall();
    expect(h.clearTimer).toHaveBeenCalledTimes(1);
    expect(h.pendingCount()).toBe(0);

    // Calling uninstall again must be safe (idempotent) even though the timer's gone already.
    handle.uninstall();
    expect(h.clearTimer).toHaveBeenCalledTimes(1);
  });
});
