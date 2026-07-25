/**
 * Cross-driver guard for the single in-process Tor daemon.
 *
 * There are two Tor drivers: the FOREGROUND app (App.tsx — the latest connection-modes cascade) and
 * the BACKGROUND WorkManager sync (syncTask.ts — a separate, simpler driver). Both reach the SAME
 * native TorService, which runs tor in-process. If the background sync stops/starts Tor while the
 * foreground app owns a live circuit, the two race on the one daemon and tor's in-process re-init
 * trips the `hs_circuitmap` assertion (an abort), which is exactly what stalls onboarding.
 *
 * This module-level state is the deterministic guard. HeadlessJS shares the app's JS runtime while
 * the process is alive, so the state the foreground sets/tracks here IS visible to runBackgroundSync,
 * and vice versa. If the OS killed the app and WorkManager spun up a fresh headless JS context, every
 * signal below starts at its "nobody owns Tor" default (correct — the foreground genuinely isn't
 * running).
 *
 * CONTRACT (foreground → background): `foregroundOwnsTorNow()` is true ONLY while the foreground is
 * both (a) mounted — its Tor-owning effect is alive — AND (b) genuinely visible/active right now, per
 * `AppState`. Sampling (a) alone is wrong: App.tsx's bootstrap effect has an empty dep array, so it
 * stays mounted (and never calls `setForegroundOwnsTor(false)`) for the whole app-process lifetime,
 * including while the app sits backgrounded — that would suppress the headless sync exactly when it's
 * supposed to run. Tracking live `AppState` here (instead of sampling it once at task start) fixes
 * that: the guard flips false the instant the app leaves 'active', so a WorkManager wake while
 * backgrounded is free to bring Tor up itself. `syncTask.ts` re-checks this immediately before EVERY
 * native start, not just once at task entry, since the app can resume mid-task.
 *
 * CONTRACT (background → foreground): `backgroundSyncOwnsTorNow()` is true from the moment
 * `runBackgroundSync` decides to actually drive Tor (past its own `foregroundOwnsTorNow()` gate)
 * until its `finally` releases it — even across the awaits inside a single Tor connect attempt.
 * App.tsx's foreground-resume handler checks this before reconnecting: if the background task
 * currently owns the daemon, resuming must not race it with a second concurrent startTor() from a
 * different TorManager instance. It asks the background task to abort at its next checkpoint
 * (`requestBackgroundSyncAbort`) and waits (bounded) for the release signal before running its own
 * cascade — see `waitForBackgroundSyncRelease`.
 *
 * Background delivery is inherently BEST-EFFORT: Android's Doze/App-Standby/WorkManager throttling
 * can delay or skip a scheduled sync regardless of this guard. This module only arbitrates the ONE
 * shared daemon between the two drivers — it does not attempt to defeat those OS-level limits.
 */
import {AppState, type AppStateStatus} from 'react-native';
import type {TorManager} from './TorManager';

/** Whether App.tsx's Tor-owning effect is currently mounted (set at its mount, cleared at unmount). */
let foregroundEffectMounted = false;

/**
 * Live foreground/background state, updated on every `AppState` change — not sampled once. Seeded
 * from the current OS state at module load so a cold start that begins backgrounded isn't
 * mis-reported as foreground.
 */
let liveAppState: AppStateStatus = AppState.currentState;
AppState.addEventListener('change', next => {
  liveAppState = next;
});

/** The foreground app marks that its Tor-owning effect is mounted (see contract above). */
export function setForegroundOwnsTor(owns: boolean): void {
  foregroundEffectMounted = owns;
}

/** True only while the foreground app is genuinely active AND driving Tor — see contract above. */
export function foregroundOwnsTorNow(): boolean {
  return foregroundEffectMounted && liveAppState === 'active';
}

// ── Background → foreground direction ───────────────────────────────────────────────────────────

/** Whether the headless background sync currently owns the shared Tor daemon (see contract above). */
let backgroundSyncActive = false;

/** Fired whenever `setBackgroundSyncOwnsTor(false)` runs, so a waiting foreground can resume promptly
 *  instead of only finding out at the next poll. */
const releaseListeners = new Set<() => void>();

/** True while a headless request to abort the current background sync attempt is outstanding. The
 *  background task clears this itself at the start of each run, so a stale request from a run that
 *  already finished can never block a later, unrelated one. */
let backgroundAbortRequested = false;

/** The background sync marks that it is actively driving Tor (past its own ownership gate). */
export function setBackgroundSyncOwnsTor(owns: boolean): void {
  backgroundSyncActive = owns;
  if (!owns) {
    for (const listener of releaseListeners) {
      listener();
    }
  }
}

/** True while the headless background sync currently owns the shared Tor daemon. */
export function backgroundSyncOwnsTorNow(): boolean {
  return backgroundSyncActive;
}

/** The foreground calls this to ask a currently-running background sync to abort at its next
 *  checkpoint (before its next native Tor start) instead of racing a concurrent startTor(). */
export function requestBackgroundSyncAbort(): void {
  backgroundAbortRequested = true;
}

/** The background sync checks this immediately before every native Tor start. */
export function shouldBackgroundSyncAbort(): boolean {
  return backgroundAbortRequested;
}

/** The background sync clears any stale abort request at the start of a fresh run. */
export function clearBackgroundSyncAbort(): void {
  backgroundAbortRequested = false;
}

// ── Dormant-daemon adoption (foreground → background-sync direction, T4) ─────────────────────────

/**
 * The single in-process Tor daemon the FOREGROUND left signalled DORMANT but ALIVE on backgrounding
 * (App.tsx enter(): SIGNAL DORMANT + close the relay, but NO disconnect — so the daemon, its control
 * socket, and its SOCKS proxy all stay up). While this is non-null, a WorkManager sync that wakes in
 * the SAME still-alive JS process can ADOPT this daemon — SIGNAL ACTIVE, drain over it, SIGNAL DORMANT
 * again — instead of cold-starting a SECOND daemon and racing the first on tor's in-process re-init.
 *
 * Null whenever there is nothing to adopt: the foreground is active (it clears this on resume via
 * exit()), the daemon was force-killed (teardown fallback clears it), or the OS killed the whole app
 * and WorkManager spun up a FRESH headless JS context (this module reloads at its null default, so the
 * sync correctly cold-starts its own daemon). Because the DORMANT daemon is never `disconnect()`ed,
 * its TorManager keeps reporting `connected`/`isLive()` and a live SOCKS proxy, so the adopting sync
 * can open a relay socket straight over it (requireTorTransport succeeds) with no reconnect.
 */
let dormantDaemon: TorManager | null = null;

/** The foreground publishes the live-but-dormant daemon here (enter()), and clears it (null) the
 *  instant it reclaims Tor on resume or force-kills it in the teardown fallback. */
export function setDormantDaemon(manager: TorManager | null): void {
  dormantDaemon = manager;
}

/** The daemon a WorkManager sync may adopt this run, or null to cold-start its own. See above. */
export function adoptableDormantDaemon(): TorManager | null {
  return dormantDaemon;
}

/**
 * Resolves once the background sync releases Tor ownership, or `timeoutMs` elapses — whichever
 * comes first. Resolves immediately if nothing currently owns it. Used by the foreground-resume
 * handler so it waits for a genuinely in-flight background attempt to let go rather than starting a
 * second, racing Tor daemon.
 */
export function waitForBackgroundSyncRelease(timeoutMs: number): Promise<void> {
  if (!backgroundSyncActive) {
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      releaseListeners.delete(onRelease);
      clearTimeout(timer);
      resolve();
    };
    const onRelease = (): void => finish();
    releaseListeners.add(onRelease);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// ── Foreground-side race guard (TS-3/TS-4/TS-5 regression lock) ────────────────────────────────────

/**
 * Runs `action` immediately if nothing currently owns the shared Tor daemon. If the background sync
 * currently owns it, asks it to abort at its next checkpoint (`requestBackgroundSyncAbort`) and waits
 * (bounded by `timeoutMs`, default 10s — the same bound App.tsx's other callers use) for it to
 * release ownership before running `action` — so a foreground caller (dormancy `enter()`, the
 * `StiqTorNetworkChange` live path, dormancy `exit()`/resume) never starts a second, concurrent Tor
 * operation on top of an in-flight background one and stomps it.
 *
 * `isStillValid`, if given, is re-checked right before `action` runs (both on the immediate path and
 * after the wait): if it returns false, `action` is skipped. This matters for the awaited path
 * specifically — by the time the wait resolves, the situation that motivated the call may no longer
 * hold (e.g. the app already resumed to the foreground through a different path while this was
 * pending), and re-running `action` against stale state would itself be a race.
 *
 * This is the single coordination primitive behind the three foreground call sites that must yield to
 * a live background sync rather than racing it; see App.tsx's dormancy `enter()`, the network-change
 * handler, and `resumeFromDormant()`.
 */
export function runYieldingToBackgroundSync(
  action: () => void,
  opts?: {timeoutMs?: number; isStillValid?: () => boolean},
): void {
  const isStillValid = opts?.isStillValid ?? (() => true);
  if (!backgroundSyncOwnsTorNow()) {
    if (isStillValid()) {
      action();
    }
    return;
  }
  requestBackgroundSyncAbort();
  void (async () => {
    await waitForBackgroundSyncRelease(opts?.timeoutMs ?? 10_000);
    if (isStillValid()) {
      action();
    }
  })();
}
