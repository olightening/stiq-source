/**
 * Regression coverage for the cross-driver Tor guard (see foregroundLock.ts for the full contract).
 *
 * The bug this guards against: `foregroundOwnsTorNow()` used to be a plain flag flipped only at
 * App.tsx's mount/unmount, so it stayed `true` for the whole lifetime of an alive-but-backgrounded
 * process — exactly when the headless background sync is supposed to run. The fix tracks live
 * `AppState` inside this module, so we mock `react-native`'s `AppState` here to drive it directly
 * (the RN jest preset's own AppState mock is a static no-op, so real transitions must be simulated).
 */
let appStateChangeCb: ((state: string) => void) | undefined;

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn((_event: string, cb: (state: string) => void) => {
      appStateChangeCb = cb;
      return {remove: jest.fn()};
    }),
  },
}));

import {
  foregroundOwnsTorNow,
  setForegroundOwnsTor,
  backgroundSyncOwnsTorNow,
  setBackgroundSyncOwnsTor,
  requestBackgroundSyncAbort,
  shouldBackgroundSyncAbort,
  clearBackgroundSyncAbort,
  waitForBackgroundSyncRelease,
  runYieldingToBackgroundSync,
  setDormantDaemon,
  adoptableDormantDaemon,
} from './foregroundLock';
import type {TorManager} from './TorManager';

describe('foregroundLock', () => {
  beforeEach(() => {
    // Simulate App.tsx's mount-once effect: the Tor-owning effect is alive for the whole test.
    setForegroundOwnsTor(true);
    appStateChangeCb?.('active');
  });

  it('is true while genuinely foregrounded (AppState active) and the effect is mounted', () => {
    expect(foregroundOwnsTorNow()).toBe(true);
  });

  it('flips false the instant the app backgrounds — even though the effect stays mounted', () => {
    // This is the exact bug scenario: App.tsx never calls setForegroundOwnsTor(false) here (its
    // effect has an empty dep array and stays mounted), yet the guard must still release Tor so
    // the headless WorkManager task can proceed.
    appStateChangeCb?.('background');
    expect(foregroundOwnsTorNow()).toBe(false);
  });

  it('is also false for the transient "inactive" state', () => {
    appStateChangeCb?.('inactive');
    expect(foregroundOwnsTorNow()).toBe(false);
  });

  it('returns to true once the app is foregrounded again', () => {
    appStateChangeCb?.('background');
    expect(foregroundOwnsTorNow()).toBe(false);
    appStateChangeCb?.('active');
    expect(foregroundOwnsTorNow()).toBe(true);
  });

  it('stays false while active if the Tor-owning effect was never mounted', () => {
    setForegroundOwnsTor(false);
    appStateChangeCb?.('active');
    expect(foregroundOwnsTorNow()).toBe(false);
  });
});

describe('background sync ownership (background → foreground direction)', () => {
  afterEach(() => {
    // Leave the module in its default "nobody owns anything" state for later tests/files.
    setBackgroundSyncOwnsTor(false);
    clearBackgroundSyncAbort();
  });

  it('reports ownership only while the background sync has marked itself as owning Tor', () => {
    expect(backgroundSyncOwnsTorNow()).toBe(false);
    setBackgroundSyncOwnsTor(true);
    expect(backgroundSyncOwnsTorNow()).toBe(true);
    setBackgroundSyncOwnsTor(false);
    expect(backgroundSyncOwnsTorNow()).toBe(false);
  });

  it('lets the foreground request an abort that the background sync can observe and clear', () => {
    expect(shouldBackgroundSyncAbort()).toBe(false);
    requestBackgroundSyncAbort();
    expect(shouldBackgroundSyncAbort()).toBe(true);
    // A fresh background-sync run clears any stale request before proceeding.
    clearBackgroundSyncAbort();
    expect(shouldBackgroundSyncAbort()).toBe(false);
  });

  it('waitForBackgroundSyncRelease resolves immediately when nothing owns Tor', async () => {
    expect(backgroundSyncOwnsTorNow()).toBe(false);
    // Should not hang — resolves without needing a release signal or the timeout to fire.
    await expect(waitForBackgroundSyncRelease(50)).resolves.toBeUndefined();
  });

  it('waitForBackgroundSyncRelease resolves as soon as the background sync releases ownership', async () => {
    setBackgroundSyncOwnsTor(true);
    let resolved = false;
    const pending = waitForBackgroundSyncRelease(5_000).then(() => {
      resolved = true;
    });
    // Give the pending promise a tick to prove it does NOT resolve on its own while still owned.
    await Promise.resolve();
    expect(resolved).toBe(false);

    setBackgroundSyncOwnsTor(false);
    await pending;
    expect(resolved).toBe(true);
  });

  it('waitForBackgroundSyncRelease falls back to the timeout if ownership is never released', async () => {
    jest.useFakeTimers();
    try {
      setBackgroundSyncOwnsTor(true);
      let resolved = false;
      const pending = waitForBackgroundSyncRelease(1_000).then(() => {
        resolved = true;
      });
      jest.advanceTimersByTime(999);
      await Promise.resolve();
      expect(resolved).toBe(false);

      jest.advanceTimersByTime(1);
      await pending;
      expect(resolved).toBe(true);
      // Ownership itself is untouched by the timeout firing — only the wait gives up.
      expect(backgroundSyncOwnsTorNow()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('runYieldingToBackgroundSync (TS-3/TS-4/TS-5 regression lock)', () => {
  // The three App.tsx call sites this guards — dormancy enter(), the StiqTorNetworkChange live
  // path, and resumeFromDormant()/exit() — all reduce to the same shape: run an action now unless a
  // background sync currently owns the shared Tor daemon, in which case ask it to abort and wait
  // (bounded) before running the action, re-validating right before it actually runs.
  afterEach(() => {
    setBackgroundSyncOwnsTor(false);
    clearBackgroundSyncAbort();
  });

  it('runs the action immediately when nothing owns the background sync', () => {
    const action = jest.fn();
    runYieldingToBackgroundSync(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(shouldBackgroundSyncAbort()).toBe(false);
  });

  it('skips the action on the immediate path when isStillValid returns false', () => {
    const action = jest.fn();
    runYieldingToBackgroundSync(action, {isStillValid: () => false});
    expect(action).not.toHaveBeenCalled();
  });

  it('requests an abort and defers the action until the background sync releases ownership', async () => {
    setBackgroundSyncOwnsTor(true);
    const action = jest.fn();
    runYieldingToBackgroundSync(action);
    // Synchronous return — the caller (a fire-and-forget App.tsx handler) never awaits this.
    expect(action).not.toHaveBeenCalled();
    expect(shouldBackgroundSyncAbort()).toBe(true);

    setBackgroundSyncOwnsTor(false);
    // Let the pending waitForBackgroundSyncRelease promise chain settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does NOT run the action if isStillValid goes false while waiting for release (stale-guard)', async () => {
    // This is exactly the enter()-vs-exit() race: the app resumed to the foreground (exit() already
    // ran) while enter() was still waiting on a background sync it asked to abort. Re-running the
    // deferred action at that point would stomp the resume that already happened.
    setBackgroundSyncOwnsTor(true);
    let stillBackgrounded = true;
    const action = jest.fn();
    runYieldingToBackgroundSync(action, {isStillValid: () => stillBackgrounded});

    stillBackgrounded = false; // simulate exit() winning the race before release
    setBackgroundSyncOwnsTor(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
  });

  it('falls back to running the action after the bounded timeout if release never comes', async () => {
    jest.useFakeTimers();
    try {
      setBackgroundSyncOwnsTor(true);
      const action = jest.fn();
      runYieldingToBackgroundSync(action, {timeoutMs: 1_000});
      expect(action).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1_000);
      // Flush the microtask queue so the post-await continuation (which calls action()) runs.
      await Promise.resolve();
      await Promise.resolve();
      expect(action).toHaveBeenCalledTimes(1);
      // The stale background-sync ownership itself is untouched — only the wait gave up.
      expect(backgroundSyncOwnsTorNow()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // Restored to 10s after a brief, incorrectly-justified 2s cut: syncTask.ts's ABORT_POLL_MS (500ms)
  // checkpoint only runs in the DRAIN block, AFTER a connect has already succeeded — a background sync
  // mid-connect() (bounded by WARM_TIMEOUT_MS=45s warm, ~80s on the cold cascade) has no abort
  // checkpoint at ALL and cannot release early no matter how long this waits; TorManager.connect() has
  // no knowledge of shouldBackgroundSyncAbort(). Even the drain-phase release this WOULD help isn't a
  // flat 500ms: it still runs native stopTor()/arti_stop(), which gives its own graceful drain up to a
  // 2s STOP_BUDGET (arti-ffi/src/lib.rs) before it aborts tasks outright. See the full rationale on
  // runYieldingToBackgroundSync in foregroundLock.ts. This assertion is the regression lock on that
  // value, so it moves with it deliberately rather than being relaxed.
  it('defaults the wait to 10s when no timeoutMs is given', async () => {
    jest.useFakeTimers();
    try {
      setBackgroundSyncOwnsTor(true);
      const action = jest.fn();
      runYieldingToBackgroundSync(action);

      jest.advanceTimersByTime(9_999);
      await Promise.resolve();
      await Promise.resolve();
      expect(action).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('dormant-daemon adoption (T4, foreground → background-sync)', () => {
  // A stand-in for the live-but-dormant TorManager the foreground publishes. Only its identity
  // matters here — adoptableDormantDaemon() hands back exactly what setDormantDaemon() stored.
  const fakeDaemon = {} as TorManager;

  afterEach(() => {
    setDormantDaemon(null); // leave the module at its "nothing to adopt" default for later files
  });

  it('has nothing to adopt by default (cold headless context / dormancy off)', () => {
    expect(adoptableDormantDaemon()).toBeNull();
  });

  it('hands a background sync the exact daemon the foreground published for adoption', () => {
    setDormantDaemon(fakeDaemon);
    expect(adoptableDormantDaemon()).toBe(fakeDaemon);
  });

  it('clears the adoptable handle when the foreground reclaims Tor (exit) or force-kills it', () => {
    setDormantDaemon(fakeDaemon);
    expect(adoptableDormantDaemon()).toBe(fakeDaemon);
    setDormantDaemon(null);
    expect(adoptableDormantDaemon()).toBeNull();
  });
});
