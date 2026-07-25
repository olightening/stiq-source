/**
 * Opt-in, dev/diagnostic long-task watchdog (P2-4, UI_FREEZE_DIAGNOSIS_ONDEVICE_2026-07-12.md §4).
 *
 * PURPOSE: RN old-architecture (`newArchEnabled=false`, see BUILDING.md) runs touch dispatch,
 * timers, ingest, and rebuilds on ONE JS thread/message queue. A long synchronous task on that
 * thread starves everything else — including the touch that's about to feel "frozen, then it all
 * fires at once". This module measures that stall directly instead of re-theorizing about which
 * code path caused it: schedule a repeating timer at a fixed interval and compare the ACTUAL
 * wall-clock gap between ticks against the EXPECTED interval. Timers share the same queue as
 * everything else, so any overshoot is exactly how long some prior synchronous task blocked the
 * thread before this tick could run.
 *
 * MECHANISM: `setTimeout(tick, INTERVAL_MS)`, self-rescheduling. On each fire:
 *   blockedMs = (now - lastTickAt) - INTERVAL_MS
 * If `blockedMs > thresholdMs`, log it. This is the same "measure the timer drift" technique used
 * to detect event-loop lag in Node; it costs one Date.now() + one subtraction per tick in the
 * common (no-stall) path — no allocation, no closure creation beyond the one made at install time.
 *
 * LOGGING: prefers `global.nativeLoggingHook` (present in Hermes; Metro strips `console.*` calls
 * from release bundles, but `nativeLoggingHook` still reaches logcat — see UI_FREEZE_DIAGNOSIS_
 * ONDEVICE_2026-07-12.md §6.1), falling back to `console.warn` when it's absent (e.g. under jest).
 * Every line carries the `[STIQ-LONGTASK]` marker so a device log grep finds it immediately.
 *
 * ZERO COST WHEN DISABLED: `installLongTaskWatchdog()` reads `LONGTASK_WATCHDOG_MS` and returns
 * immediately without starting any timer when it's `<= 0` (the shipped default — see config.ts).
 * Production builds pay literally nothing: no timer, no tick function retained, no interval.
 */
import {LONGTASK_WATCHDOG_MS} from '../config';

/** Matches the Hermes/RN global surfaced by `global.nativeLoggingHook` (undeclared in RN's own
 * typings). Feature-detected below so this module never assumes react-native internals. */
type NativeLoggingHook = (message: string, level?: number) => void;

function emit(message: string): void {
  const hook = (global as {nativeLoggingHook?: NativeLoggingHook}).nativeLoggingHook;
  if (typeof hook === 'function') {
    hook(message, 2 /* RCTLogLevelWarning */);
    return;
  }
  console.warn(message);
}

export interface LongTaskWatchdogOptions {
  /** Blocked-ms threshold above which a tick logs. Defaults to LONGTASK_WATCHDOG_MS. */
  thresholdMs?: number;
  /** Tick interval in ms. Kept well below the threshold so overshoot is measured precisely. */
  intervalMs?: number;
  /** Injectable for tests: defaults to Date.now / global.setTimeout / global.clearTimeout. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Injectable log sink for tests; defaults to the nativeLoggingHook/console.warn pair above. */
  log?: (message: string) => void;
}

/** Handle returned by installLongTaskWatchdog(); call `.uninstall()` to stop the timer. */
export interface LongTaskWatchdogHandle {
  uninstall: () => void;
}

const NOOP_HANDLE: LongTaskWatchdogHandle = {uninstall: () => {}};

const DEFAULT_INTERVAL_MS = 50;

/**
 * Installs the watchdog when `LONGTASK_WATCHDOG_MS` (or `options.thresholdMs`) is a positive
 * number; otherwise a complete no-op (no timer scheduled) — returns a no-op handle either way so
 * callers don't need to branch.
 */
export function installLongTaskWatchdog(options: LongTaskWatchdogOptions = {}): LongTaskWatchdogHandle {
  const thresholdMs = options.thresholdMs ?? LONGTASK_WATCHDOG_MS;
  if (!(thresholdMs > 0)) {
    return NOOP_HANDLE; // OFF — never starts a timer, zero runtime cost.
  }
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const logFn = options.log ?? emit;

  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt = now();

  const tick = (): void => {
    if (stopped) return;
    const nowMs = now();
    const blockedMs = nowMs - lastTickAt - intervalMs;
    if (blockedMs > thresholdMs) {
      logFn(`[STIQ-LONGTASK] JS thread blocked ~${Math.round(blockedMs)}ms`);
    }
    lastTickAt = nowMs;
    handle = setTimer(tick, intervalMs);
  };

  handle = setTimer(tick, intervalMs);

  return {
    uninstall: () => {
      stopped = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
  };
}
