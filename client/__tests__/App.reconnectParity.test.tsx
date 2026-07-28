/**
 * App.tsx-level proof of the FOREGROUND-RESUME content-freshness contract (reconnect parity).
 *
 * The bug this pins: App.tsx has two resume paths and only the DEAD one refreshed content.
 *   • Legacy (`TOR_DORMANCY` off) — the AppState 'active' handler's still-live branch calls
 *     `runtime.refreshFeed()` as a backstop for a relay that silently dropped our standing feed REQ
 *     without ever closing the socket.
 *   • Dormancy (`TOR_DORMANCY` ON, the shipped default — config.ts) — `exit()` →
 *     `resumeFromDormant()`; when the daemon is live AND the relay socket is still open there is
 *     nothing to reconnect, and that branch only topped up the TOKEN WALLET
 *     (`foregroundLowWaterRefill`). No content step at all. So in every shipped build a foreground
 *     resume did nothing about a stale feed and the reader had to pull to refresh by hand.
 *
 * The harness fakes exactly two seams so `startRelay()` can really run under jest — the Tor manager
 * (`createTorManager`) and the relay socket (`createTorRelaySocket`) — and spies the REAL
 * `AppRuntime.prototype` methods, so what is asserted is App.tsx's own wiring rather than a stand-in.
 * `activeRelayUrl` must be stubbed because `RELAY_ONION_WS` is `''` in this build (config.ts) and
 * `startRelay()` correctly refuses to dial an empty URL.
 */
import 'react-native';
import React from 'react';
import {AppState} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import type {ConnectionState} from '../src/connection';

// ── Fake relay socket ───────────────────────────────────────────────────────────────────────────
// The RelaySocket surface (src/nostr/socket.ts). It deliberately never fires `onOpen`, so no REQ is
// ever written: this suite is about WHICH dial/refresh decision App.tsx makes, not about wire
// traffic, and an un-opened socket keeps MirrorSet/RelayClient inert while still being a live,
// non-null `relay` from App.tsx's point of view — the exact state the resume branch reads.
type FakeSocket = {closed: boolean; fireClose(): void};

const sockets: FakeSocket[] = [];
const mockSocketFactory = jest.fn((): unknown => {
  let closeCb: (() => void) | undefined;
  const rec: FakeSocket = {closed: false, fireClose: () => closeCb?.()};
  sockets.push(rec);
  return {
    send: () => {},
    onMessage: () => {},
    onOpen: () => {},
    onClose: (cb: () => void) => { closeCb = cb; },
    close: () => { rec.closed = true; },
  };
});

jest.mock('../src/nostr/torSocket', () => ({
  __esModule: true,
  createTorRelaySocket: () => mockSocketFactory(),
}));

// ── Fake Tor manager ────────────────────────────────────────────────────────────────────────────
type FakeTor = {
  state: ConnectionState;
  live: boolean;
  listeners: Set<(s: ConnectionState) => void>;
  push(s: ConnectionState): void;
};
let mockTor: FakeTor;

const makeMockTor = (): FakeTor => {
  const listeners = new Set<(s: ConnectionState) => void>();
  const m: FakeTor = {
    state: 'offline',
    live: false,
    listeners,
    push(s: ConnectionState) {
      m.state = s;
      // isLive() is state==='connected' && socks!==null; a dormant daemon still reports both, which
      // is precisely why App.tsx cannot use it to detect dormancy.
      m.live = s === 'connected';
      for (const l of [...listeners]) l(s);
    },
  };
  return m;
};

jest.mock('../src/tor', () => {
  const actual = jest.requireActual('../src/tor');
  return {
    ...actual,
    createTorManager: () => ({
      connect: async () => {},
      disconnect: async () => {},
      getState: () => mockTor.state,
      isLive: () => mockTor.live,
      isOnionAuthActive: () => true,
      onBootstrap: () => () => {},
      onChange: (cb: (s: ConnectionState) => void) => {
        mockTor.listeners.add(cb);
        return () => mockTor.listeners.delete(cb);
      },
    }),
  };
});

// The native dormancy signals (StiqArti SIGNAL DORMANT/ACTIVE). Absent under jest, and doEnter()
// treats "can't signal" as "tear the daemon down instead" — so without this the dormancy branch is
// unreachable in a test and only the teardown fallback would ever run.
jest.mock('../src/tor/dormancy', () => ({
  __esModule: true,
  torDormant: () => true,
  torActive: () => true,
}));

import App from '../App';
import {AppRuntime} from '../src/app/AppRuntime';

const RELAY = `ws://${'r'.repeat(56)}.onion`;

/** setup() is async (store creation, then activeRelayUrl) — drain enough microtasks to get past the
 *  manager.onChange registration, which sits well before attemptInit(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('App.tsx — foreground resume refreshes content (reconnect parity)', () => {
  let refreshFeed: jest.SpyInstance;
  let refill: jest.SpyInstance;
  let appStateCbs: ((s: string) => void)[];
  let tree: renderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    mockTor = makeMockTor();
    sockets.length = 0;
    mockSocketFactory.mockClear();
    appStateCbs = [];
    // The RN preset's AppState is a static no-op, so capture the listeners registered DURING mount
    // (App.tsx's setup effect among them) and drive them directly. Module-scope listeners registered
    // at import time (foregroundLock) are already in place and unaffected.
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((ev: string, cb: (s: string) => void) => {
      if (ev === 'change') appStateCbs.push(cb);
      return {remove: () => {}};
    }) as never);
    jest.spyOn(AppRuntime.prototype, 'activeRelayUrl').mockResolvedValue(RELAY);
    refreshFeed = jest.spyOn(AppRuntime.prototype, 'refreshFeed').mockResolvedValue(undefined);
    refill = jest
      .spyOn(AppRuntime.prototype, 'foregroundLowWaterRefill')
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    if (tree) act(() => tree!.unmount());
    tree = undefined;
    jest.restoreAllMocks();
  });

  /** Mount App and get its relay socket up: Tor reports connected → startRelay() dials. */
  async function mountConnected(): Promise<void> {
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await settle(); });
    await act(async () => { mockTor.push('connected'); await settle(); });
    // Precondition, not the claim: the relay is up, so the resume path below is the still-live one.
    expect(mockSocketFactory).toHaveBeenCalledTimes(1);
  }

  async function foreground(): Promise<void> {
    await act(async () => {
      for (const cb of appStateCbs) cb('active');
      await settle();
    });
  }

  it('a still-live foreground resume asks the runtime to refresh the feed', async () => {
    await mountConnected();
    expect(refreshFeed).not.toHaveBeenCalled(); // nothing has resumed yet

    // A focus return with the daemon live and the relay socket still open: the branch where NOTHING
    // reconnects. Before the fix this only topped up the token wallet and left the feed stale.
    await foreground();

    expect(refreshFeed).toHaveBeenCalled();
  });

  it('that resume does NOT re-dial the relay — the refresh is a resync, not a reconnect', async () => {
    await mountConnected();
    await foreground();

    // Regression firewall: "make the feed fresh on resume" must never be implemented by bouncing the
    // socket on every focus return (a dialog dismissal, the notification shade). One dial only — and
    // the wallet top-up this branch already did still runs.
    expect(mockSocketFactory).toHaveBeenCalledTimes(1);
    expect(refill).toHaveBeenCalled();
  });

  /**
   * The second half of reconnect parity: a relay dial must never happen while Tor is deliberately
   * IDLED. `enter()` keeps the daemon alive (no disconnect()), so `manager.isLive()` still returns
   * true throughout dormancy and startRelay()'s original guard could not tell the two apart. A dial
   * that lands here opens a socket over a daemon that is not building circuits — it can never carry
   * a frame, but it DOES set `relay` non-null, and resumeFromDormant() reads a non-null relay as
   * "already connected, nothing to do". The foreground then resumes onto a socket that is dead by
   * construction with nothing scheduled to replace it until the 90s data watchdog fires.
   */
  it('does not dial the relay while the daemon is dormant', async () => {
    // Dormancy is gated on being enrolled (the AppState 'background' handler returns early during
    // onboarding). enrolled rides the runtime snapshot, and emit() re-reads getSnapshot(), so
    // decorating that one method is enough to put the app in its post-enrollment state.
    const realSnapshot = AppRuntime.prototype.getSnapshot;
    jest.spyOn(AppRuntime.prototype, 'getSnapshot').mockImplementation(function (this: AppRuntime) {
      return {...realSnapshot.call(this), enrolled: true};
    });

    await mountConnected();

    jest.useFakeTimers();
    try {
      await act(async () => {
        // enter() is deferred through runYieldingToBackgroundSync with `isStillValid: () =>
        // AppState.currentState === 'background'`, so the static RN mock's 'active' must be moved too
        // — otherwise doEnter() is skipped and dormancy silently never happens.
        Object.defineProperty(AppState, 'currentState', {value: 'background', configurable: true});
        for (const cb of appStateCbs) cb('background');
        // The background grace period (30s on Android) before enter() idles the daemon.
        jest.advanceTimersByTime(31_000);
        await settle();
      });
      // Dormancy really did enter: enter() closes the relay socket. (If this fails the rest of the
      // assertion below would be vacuously true, so it is checked explicitly.)
      expect(sockets[0]?.closed).toBe(true);

      // Any startRelay() caller that lands while dormant — here the Tor manager re-reporting
      // 'connected', which the onChange handler acts on because `relay` is now null.
      await act(async () => {
        mockTor.push('connected');
        await settle();
      });

      expect(mockSocketFactory).toHaveBeenCalledTimes(1); // still just the pre-dormancy dial
    } finally {
      jest.useRealTimers();
      Object.defineProperty(AppState, 'currentState', {value: 'active', configurable: true});
    }
  });
});
