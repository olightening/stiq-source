/**
 * Local-only, memory-only leveled logger.
 *
 * PRIVACY: this never touches the network and never writes to disk — it's a bounded in-memory
 * ring buffer only, purely for on-device debugging (e.g. a future "copy diagnostics" screen). No
 * remote services see it, and nothing here should be wired to one; that would leak diagnostics
 * off the anonymous device to a place the relay/organizer could correlate to a user.
 *
 * Echoes to the console only when `__DEV__` (a Metro dev build), so release builds stay silent.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const MAX_ENTRIES = 200;
const ring: LogEntry[] = [];

function fmt(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') {
        return a;
      }
      if (a instanceof Error) {
        return a.message;
      }
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function record(level: LogLevel, scope: string, args: unknown[]): void {
  const entry: LogEntry = {ts: Date.now(), level, scope, msg: fmt(args)};
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) {
    ring.splice(0, ring.length - MAX_ENTRIES);
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const line = `[${scope}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line, ...args);
  }
}

/** Returns a snapshot (oldest-first) of the ring buffer's current contents. */
export function getRecentLogs(): LogEntry[] {
  return ring.slice();
}

/** Clears the ring buffer. Exposed for tests; not needed in normal app operation. */
export function clearRecentLogs(): void {
  ring.length = 0;
}

export const log = {
  info(scope: string, ...args: unknown[]): void {
    record('info', scope, args);
  },
  warn(scope: string, ...args: unknown[]): void {
    record('warn', scope, args);
  },
  error(scope: string, ...args: unknown[]): void {
    record('error', scope, args);
  },
};
