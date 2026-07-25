/**
 * Trailing-edge coalescer for high-frequency Tor bootstrap PROGRESS lines.
 *
 * The Tor daemon emits a burst of PROGRESS=/SUMMARY= lines during bootstrap, and each one was
 * flushed straight into React state (App.tsx setTorBootstrap), re-rendering the whole App → AppShell
 * tree on every tick — a full-tree re-render storm landing right in the cold-open / unlock window
 * (#6 transient jank), even on the lock screen which doesn't consume the percent at all.
 *
 * This coalesces that stream, mirroring AppRuntime.emitDeferred's invariant: at most one flush per
 * `throttleMs`, always carrying the LATEST value pushed during the window (never an earlier one, so
 * the bar only ever moves forward). Two states bypass the throttle and flush IMMEDIATELY so the bar
 * can never look stuck:
 *   - the FIRST push (so the bar isn't blank for throttleMs at the start of an attempt), and
 *   - percent >= 100 (bootstrap complete — the terminal value must land at once).
 * Terminal connection states (connected/error) are delivered by the separate, already-synchronous
 * onChange listener, so they never route through here.
 */
export interface BootstrapLike {
  percent: number;
}

export interface BootstrapCoalescer<T extends BootstrapLike> {
  /** Feed one PROGRESS line in. Flushes immediately on the first push or at percent≥100, else
   *  schedules a single trailing flush carrying whatever the latest value is when it fires. */
  push: (p: T) => void;
  /** Drop any pending/queued flush WITHOUT flushing — for a hard reset (Tor disconnected/offline),
   *  so a stale queued percent can't overwrite a just-cleared bar, and the next attempt's first
   *  push flushes immediately again. */
  reset: () => void;
  /** Cancel any pending flush; call on teardown. */
  dispose: () => void;
}

export function createBootstrapCoalescer<T extends BootstrapLike>(
  flush: (p: T) => void,
  throttleMs = 150,
): BootstrapCoalescer<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: T | undefined;
  let hasFlushed = false;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  return {
    push(p: T): void {
      // First line of an attempt, or the completion line — show it at once (no throttle wait).
      if (!hasFlushed || p.percent >= 100) {
        clear();
        hasFlushed = true;
        flush(p);
        return;
      }
      pending = p; // trailing-edge: always overwrite with the newest value seen this window
      if (timer !== undefined) return; // a flush is already scheduled
      timer = setTimeout(() => {
        timer = undefined;
        const latest = pending!;
        pending = undefined;
        flush(latest);
      }, throttleMs);
    },
    reset(): void {
      clear();
      hasFlushed = false;
    },
    dispose(): void {
      clear();
    },
  };
}
