import {FIRST_PROGRESS_GRACE_MS, TorManager, requireTorTransport} from './TorManager';
import {ScriptedTorBackend, UnavailableTorBackend} from './backend.fake';
import {defaultBridgeLines} from './bridges';
import {setActiveRelayOnion} from './onionAuth';
import type {TorReachConfig} from './types';

/**
 * A ScriptedTorBackend that ALSO implements the optional `installReach` (TorManager.installReach()'s
 * live-update path — see backend.ts). Kept local to this file rather than added to backend.fake.ts:
 * ScriptedTorBackend itself must stay exactly as every other suite constructs it (no installReach),
 * so a backend that HAS it is its own small subclass instead of a shared-fixture change.
 */
class ReachCapableBackend extends ScriptedTorBackend {
  installReachFn = jest.fn((_config: TorReachConfig): Promise<void> => Promise.resolve());
  installReach(config: TorReachConfig): Promise<void> {
    return this.installReachFn(config);
  }
}

describe('TorManager', () => {
  it('connects via a bridge on successful bootstrap and exposes the SOCKS proxy', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 45},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

    const final = await manager.connect();

    expect(final).toBe('connected');
    expect(manager.getState()).toBe('connected');
    expect(manager.getSocksProxy()).toEqual({host: '127.0.0.1', port: 9050});
    // Defaults to the obfs4 transport (PLAN.md §3.2).
    expect(backend.lastConfig?.transport).toBe('obfs4');
    expect(requireTorTransport(manager)).toEqual({host: '127.0.0.1', port: 9050});
  });

  it('goes offline with NO clearnet fallback when the backend errors', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'error', message: 'bridge unreachable'},
    ]);
    const manager = new TorManager(backend);

    const final = await manager.connect();

    expect(final).toBe('offline');
    expect(manager.getSocksProxy()).toBeNull();
    expect(() => requireTorTransport(manager)).toThrow(/offline/);
  });

  it('goes offline when no native Tor module is installed', async () => {
    const manager = new TorManager(new UnavailableTorBackend());
    expect(await manager.connect()).toBe('offline');
    expect(manager.getSocksProxy()).toBeNull();
  });

  it('goes offline when Tor is force-failed by bootstrap timeout', async () => {
    jest.useFakeTimers();
    try {
      // Never emits connected/error — simulates a hung bootstrap.
      const backend = new ScriptedTorBackend([
        {kind: 'starting'},
        {kind: 'bootstrapping', percent: 10},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 5000});

      const pending = manager.connect();
      expect(manager.getState()).toBe('connecting-bridge');
      jest.advanceTimersByTime(5000);

      expect(await pending).toBe('offline');
      expect(manager.getSocksProxy()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors a per-attempt bootstrap timeout override (warm path)', async () => {
    jest.useFakeTimers();
    try {
      const backend = new ScriptedTorBackend([
        {kind: 'starting'},
        {kind: 'bootstrapping', percent: 10},
      ]);
      // Long constructor default, short per-attempt override for the warm path.
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 5 * 60_000});

      const pending = manager.connect({bootstrapTimeoutMs: 45_000});
      // Before the override deadline: still bootstrapping.
      jest.advanceTimersByTime(44_000);
      expect(manager.getState()).toBe('connecting-bridge');
      // Crossing the override deadline forces offline (not the 5-min default).
      jest.advanceTimersByTime(2_000);
      expect(await pending).toBe('offline');
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits the full state sequence to subscribers', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 80},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    const seen: string[] = [];
    manager.onChange(s => seen.push(s));

    await manager.connect();

    expect(seen).toEqual(['starting-tor', 'connecting-bridge', 'connected']);
  });

  it('extends the bootstrap deadline while Tor keeps making forward progress', async () => {
    jest.useFakeTimers();
    try {
      const backend = new ScriptedTorBackend([]); // emit manually to interleave with the clock
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 5000});

      const pending = manager.connect();
      backend.emit({kind: 'starting'});
      // Each progress step lands within 5s of the previous one, re-arming the deadline. Total
      // elapsed (12s) far exceeds the 5s single-shot deadline, yet the attempt stays alive.
      backend.emit({kind: 'bootstrapping', percent: 20});
      jest.advanceTimersByTime(4000);
      backend.emit({kind: 'bootstrapping', percent: 50});
      jest.advanceTimersByTime(4000);
      backend.emit({kind: 'bootstrapping', percent: 80});
      jest.advanceTimersByTime(4000);
      expect(manager.getState()).toBe('connecting-bridge');

      backend.emit({kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
      expect(await pending).toBe('connected');
    } finally {
      jest.useRealTimers();
    }
  });

  it('still times out when progress stalls after an initial advance', async () => {
    jest.useFakeTimers();
    try {
      const backend = new ScriptedTorBackend([]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 5000});

      const pending = manager.connect();
      backend.emit({kind: 'starting'});
      backend.emit({kind: 'bootstrapping', percent: 20}); // arms the 5s no-progress deadline
      // No further progress — the deadline elapses and the attempt goes offline to escalate.
      jest.advanceTimersByTime(5000);

      expect(await pending).toBe('offline');
      expect(manager.getSocksProxy()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports real bootstrap progress (percent + summary) to onBootstrap subscribers', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 25, summary: 'Loading relay descriptors'},
      {kind: 'bootstrapping', percent: 80, summary: 'Building circuits'},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    const progress: Array<{percent: number; summary?: string}> = [];
    manager.onBootstrap(p => progress.push(p));

    await manager.connect();

    // The live percentages flow through, and connect pins the bar to 100.
    expect(progress).toEqual([
      {percent: 25, summary: 'Loading relay descriptors'},
      {percent: 80, summary: 'Building circuits'},
      {percent: 100, summary: 'Building circuits'},
    ]);
    expect(manager.getBootstrap()).toEqual({percent: 100, summary: 'Building circuits'});
  });

  it('resets bootstrap progress to null when an attempt is superseded by disconnect', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 40},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    await manager.connect();
    expect(manager.getBootstrap()).not.toBeNull();

    await manager.disconnect();

    expect(manager.getBootstrap()).toBeNull();
  });

  it('clears the SOCKS proxy after disconnect', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    await manager.connect();
    expect(manager.getSocksProxy()).not.toBeNull();

    await manager.disconnect();

    expect(manager.getState()).toBe('disconnected');
    expect(manager.getSocksProxy()).toBeNull();
  });

  it('stops the native backend when connect() supersedes a still in-flight connect() attempt', async () => {
    // Regression: connect()'s supersede() used to clear only JS-side state (timeout/subscription/
    // promise) and never told the native backend to stop — asymmetric with disconnect(). That let a
    // connect() which interrupts another in-flight connect() ask the native module to start a fresh
    // Tor daemon while the previous attempt's startTor() might still be mid-flight.
    const backend = new ScriptedTorBackend([]); // never resolves on its own; we emit manually below
    const stopSpy = jest.spyOn(backend, 'stop');
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 5000});

    const first = manager.connect();
    expect(manager.getState()).toBe('starting-tor');
    expect(stopSpy).not.toHaveBeenCalled();

    // A second connect() while the first is still in flight supersedes it.
    const second = manager.connect({transport: 'obfs4'});
    expect(await first).toBe('disconnected');
    expect(stopSpy).toHaveBeenCalledTimes(1);

    backend.emit({kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
    expect(await second).toBe('connected');
  });

  it('does NOT call backend.stop for a plain connect() with no in-flight attempt', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const stopSpy = jest.spyOn(backend, 'stop');
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

    await manager.connect();
    expect(stopSpy).not.toHaveBeenCalled();

    await manager.disconnect();
    expect(stopSpy).toHaveBeenCalledTimes(1); // from disconnect() itself, not from a supersede

    stopSpy.mockClear();
    await manager.connect();
    // No in-flight attempt existed (the previous one already settled via disconnect()), so this
    // fresh connect() must not pay an extra native stop().
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('does not re-stop a backend the bootstrap timeout already stopped', async () => {
    // Regression (observed on-device, originally against the since-deleted C-tor backend, as
    // stopTor() x3 back-to-back before the obfs4 start): the connect cascade in App.tsx stops the
    // backend three times to escalate one rung. connect()'s own timeout handler stops it;
    // connectBest() then calls disconnect() right after; then coldConnect() walks to a tier with no
    // bridges to dial and disconnect()s again without ever starting anything. Each stop serializes
    // on the native lifecycle executor; under C-tor that could block ~10s per call, so the two
    // redundant ones delayed the next transport by up to 20s for no reason. Arti's stop is now
    // near-instant, but avoiding three round-trips (two of them against an already-stopped daemon)
    // to escalate ONE rung is still wasted work worth collapsing regardless of how cheap each one is.
    jest.useFakeTimers();
    try {
      const backend = new ScriptedTorBackend([
        {kind: 'starting'},
        {kind: 'bootstrapping', percent: 10},
      ]);
      const stopSpy = jest.spyOn(backend, 'stop');
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 5000});

      const pending = manager.connect({transport: 'direct'});
      jest.advanceTimersByTime(5000 + FIRST_PROGRESS_GRACE_MS);
      expect(await pending).toBe('offline');
      expect(stopSpy).toHaveBeenCalledTimes(1); // the timeout's own stop

      // What the cascade does next: disconnect(), then a no-bridge tier disconnect()s again.
      await manager.disconnect();
      await manager.disconnect();
      expect(stopSpy).toHaveBeenCalledTimes(1); // still 1 — nothing was running to stop
      expect(manager.getState()).toBe('disconnected');

      // A real start re-arms the teardown: the next disconnect MUST reach the backend again.
      backend.emit({kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
      const second = manager.connect({transport: 'obfs4'});
      backend.emit({kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
      expect(await second).toBe('connected');
      await manager.disconnect();
      expect(stopSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('always stops on the FIRST disconnect, since a daemon may outlive the process that started it', async () => {
    // A dormant daemon from a previous process (or one orphaned by a crash) is alive but was never
    // started by THIS manager, so "we have not started anything" must not be read as "nothing is
    // running". The very first stop is the safety hammer and always reaches the backend.
    const backend = new ScriptedTorBackend([]);
    const stopSpy = jest.spyOn(backend, 'stop');
    const manager = new TorManager(backend);

    await manager.disconnect();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a bootstrapped Tor daemon from one configured for the requested onion auth', async () => {
    const auth = {
      onionHost: 'a'.repeat(56),
      privKeyBase32: 'A'.repeat(52),
    };
    const otherAuth = {
      onionHost: 'b'.repeat(56),
      privKeyBase32: 'B'.repeat(52),
    };
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    let resolvedAuth: typeof auth | null = null;
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveOnionAuth: () => resolvedAuth,
    });

    await manager.connect();

    expect(manager.isOnionAuthActive(null)).toBe(true);
    expect(manager.isOnionAuthActive(auth)).toBe(false);

    await manager.disconnect();
    resolvedAuth = auth;
    await manager.connect();

    expect(manager.isOnionAuthActive(auth)).toBe(true);
    expect(manager.isOnionAuthActive(otherAuth)).toBe(false);
    expect(manager.isOnionAuthActive(null)).toBe(false);

    await manager.disconnect();
    expect(manager.isOnionAuthActive(auth)).toBe(false);
  });

  describe('isLive()', () => {
    it('is true only while actually connected', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

      expect(manager.isLive()).toBe(false);
      await manager.connect();
      expect(manager.isLive()).toBe(true);
    });

    it('goes false the instant disconnect() clears the socket — even though backend.stop() ' +
      'can now block for seconds and getState() lags behind until it resolves', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
      await manager.connect();
      expect(manager.isLive()).toBe(true);

      // Stand in for a native stopTor() that has not resolved yet. Under the since-deleted C-tor
      // backend this could genuinely take up to ~10s (a bounded native poll); Arti's stop is
      // near-instant, but disconnect()'s state machine must stay correct regardless of how long
      // backend.stop() takes, so this test still exercises an artificially slow one.
      let releaseStop: (() => void) | undefined;
      const slowStop = new Promise<void>(resolve => {
        releaseStop = resolve;
      });
      jest.spyOn(backend, 'stop').mockReturnValue(slowStop);

      const disconnecting = manager.disconnect();

      // disconnect() has nulled `socks` synchronously already, so isLive() is false right away —
      // this is the whole point of the method. getState() meanwhile is STILL 'connected' because
      // disconnect() only flips state after the (still-pending) backend.stop() resolves; a caller
      // gating a reconnect decision on getState() would be fooled here, isLive() is not.
      expect(manager.getState()).toBe('connected');
      expect(manager.isLive()).toBe(false);

      releaseStop!();
      await disconnecting;

      expect(manager.getState()).toBe('disconnected');
      expect(manager.isLive()).toBe(false);
    });
  });

  describe('first-progress grace on the bootstrap timeout', () => {
    it('survives a no-progress stall past the raw timeout, thanks to the grace, and only goes ' +
      'offline once the grace itself elapses', async () => {
      jest.useFakeTimers();
      try {
        const backend = new ScriptedTorBackend([]); // never emits — simulates a stuck teardown
        const manager = new TorManager(backend, {bootstrapTimeoutMs: 2000});

        const pending = manager.connect();
        backend.emit({kind: 'starting'});

        // Past the raw bootstrapTimeoutMs but still inside the +FIRST_PROGRESS_GRACE_MS window:
        // must NOT have timed out yet (this is what the native teardown barrier eats into).
        jest.advanceTimersByTime(2000);
        expect(manager.getState()).not.toBe('offline');

        // Now cross the grace window too — only then does the no-progress deadline fire.
        jest.advanceTimersByTime(FIRST_PROGRESS_GRACE_MS);
        expect(await pending).toBe('offline');
        expect(manager.getSocksProxy()).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('drops the grace once real bootstrap progress lands, so a later stall times out at the ' +
      'plain bootstrapTimeoutMs', async () => {
      jest.useFakeTimers();
      try {
        const backend = new ScriptedTorBackend([]);
        const manager = new TorManager(backend, {bootstrapTimeoutMs: 2000});

        const pending = manager.connect();
        backend.emit({kind: 'starting'});
        backend.emit({kind: 'bootstrapping', percent: 15}); // forward progress — re-arms plainly

        // A stall of exactly bootstrapTimeoutMs now times out — no grace left to absorb it.
        jest.advanceTimersByTime(2000);
        expect(await pending).toBe('offline');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // The warn-only >=0.4.8 PoW-readiness guard (torVersion.ts) was removed along with C-tor:
  // StiqArtiModule never populates `torVersion` on its 'connected' event, so the check was
  // permanently dead under Arti. getTorVersion() itself stays — purely informational plumbing —
  // in case a future backend ever reports a version.
  describe('getTorVersion()', () => {
    it('captures the version from a connected event carrying torVersion', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}, torVersion: '0.4.8.22'},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

      expect(await manager.connect()).toBe('connected');
      expect(manager.getTorVersion()).toBe('0.4.8.22');
    });

    it('yields null when the connected event omits torVersion (the Arti case, always)', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

      expect(await manager.connect()).toBe('connected');
      expect(manager.getTorVersion()).toBeNull();
    });

    it('clears the captured version on disconnect so it cannot linger across reconnects', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}, torVersion: '0.4.8.22'},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

      await manager.connect();
      expect(manager.getTorVersion()).toBe('0.4.8.22');

      await manager.disconnect();
      expect(manager.getTorVersion()).toBeNull();
    });
  });

  it('matches a secondary mirror credential present only in the onionAuthExtra set (P2 §1.7)', async () => {
    const primaryAuth = {onionHost: 'a'.repeat(56), privKeyBase32: 'A'.repeat(52)};
    const secondaryAuth = {onionHost: 'b'.repeat(56), privKeyBase32: 'B'.repeat(52)};
    const untouchedAuth = {onionHost: 'c'.repeat(56), privKeyBase32: 'C'.repeat(52)};
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveOnionAuth: () => primaryAuth,
      resolveOnionAuthExtra: () => [secondaryAuth],
    });

    await manager.connect();

    // Primary and secondary both read as "active" — a caller can't tell which slot served it.
    expect(manager.isOnionAuthActive(primaryAuth)).toBe(true);
    expect(manager.isOnionAuthActive(secondaryAuth)).toBe(true);
    // A credential absent from both slots is not active.
    expect(manager.isOnionAuthActive(untouchedAuth)).toBe(false);
    // null (public onion) still reads against the PRIMARY slot only, unaffected by extras.
    expect(manager.isOnionAuthActive(null)).toBe(false);
    // buildStartConfig actually received the extra set (threaded to the native start config).
    expect(backend.lastConfig?.onionAuth).toEqual(primaryAuth);
    expect(backend.lastConfig?.onionAuthExtra).toEqual([secondaryAuth]);
  });

  it('leaves single-mirror onion-auth behaviour unchanged when no resolveOnionAuthExtra is supplied', async () => {
    const auth = {onionHost: 'a'.repeat(56), privKeyBase32: 'A'.repeat(52)};
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveOnionAuth: () => auth,
    });

    await manager.connect();

    expect(manager.isOnionAuthActive(auth)).toBe(true);
    expect(manager.isOnionAuthActive(null)).toBe(false);
    expect(backend.lastConfig?.onionAuthExtra).toBeUndefined();
  });

  // T14-S1: regression net proving a Snowflake / WebTunnel start config flows through the manager
  // to the backend unchanged (transport + bridge lines), so the ladder wiring can't silently drop
  // or rewrite a transport on its way to the native daemon.
  describe('transport passthrough (Snowflake + WebTunnel)', () => {
    it('passes a snowflake start config through to the backend', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'starting'},
        {kind: 'bootstrapping', percent: 50},
        {kind: 'connected', socks: {host: '127.0.0.1', port: 1}},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
      const snowflakeLines = defaultBridgeLines('snowflake');

      const final = await manager.connect({
        transport: 'snowflake',
        bridgeLines: snowflakeLines,
      });

      expect(final).toBe('connected');
      expect(backend.lastConfig?.transport).toBe('snowflake');
      expect(backend.lastConfig?.bridgeLines).toEqual(snowflakeLines);
    });

    it('passes a webtunnel start config with pasted bridge lines through to the backend', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'starting'},
        {kind: 'bootstrapping', percent: 50},
        {kind: 'connected', socks: {host: '127.0.0.1', port: 1}},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
      // DEFAULT_WEBTUNNEL_BRIDGES is empty (fetched/seeded at runtime), so supply a pasted line.
      const webtunnelLines = [
        'webtunnel 192.0.2.5:443 0000000000000000000000000000000000000000 url=https://example.com/wt ver=0.0.2',
      ];

      const final = await manager.connect({
        transport: 'webtunnel',
        bridgeLines: webtunnelLines,
      });

      expect(final).toBe('connected');
      expect(backend.lastConfig?.transport).toBe('webtunnel');
      expect(backend.lastConfig?.bridgeLines).toEqual(webtunnelLines);
    });
  });
});

describe('TorManager connect-clock instrumentation', () => {
  /**
   * Deterministic clock: hands back the scripted timestamps in call order, then holds the last.
   *
   * ScriptedTorBackend.start() emits its whole script SYNCHRONOUSLY, so connect() reads the clock
   * in a fixed order:
   *   1. timeline start
   *   2. the `native-start` mark
   *   3. one read per `bootstrapping` event
   *   4. one read at settle (finish)
   * (`native-ready` reads once more on the microtask after start() resolves, but that lands after
   * finish() so it changes nothing.) Adding a clock read in connect() will shift these scripts —
   * that is intentional, so a timing change cannot pass unnoticed.
   */
  const scriptedClock = (times: number[]) => {
    let i = 0;
    return (): number => times[Math.min(i++, times.length - 1)] ?? 0;
  };

  it('attributes a slow connect to the phase that actually cost the time', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 5}, // reached a directory
      {kind: 'bootstrapping', percent: 15}, // began fetching the consensus
      {kind: 'bootstrapping', percent: 45}, // consensus done, on to descriptors
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 60_000,
      //          start  native-start  5%     15%     45%      finish
      now: scriptedClock([0, 100, 1_000, 2_000, 32_000, 33_000]),
    });

    expect(await manager.connect()).toBe('connected');

    const timing = manager.getLastTiming();
    expect(timing).not.toBeNull();
    expect(timing?.totalMs()).toBe(33_000);
    // The 30s gap between the 15% and 45% lines is consensus-fetch time, and must be charged
    // there — NOT to `descriptors`, the phase the 45% line announces it has just reached.
    expect(timing?.slowest()?.id).toBe('consensus');
    expect(timing?.slowest()?.ms).toBe(30_000);
    expect(timing?.format()).toContain('consensus 30.0s ←');
    // The launch instants are recorded so a slow launch is separable from a slow tor.
    expect(timing?.marks()).toEqual(
      expect.arrayContaining([
        {name: 'native-start', atMs: 100},
        {name: 'first-progress', atMs: 1_000},
      ]),
    );
  });

  it('records a breakdown for a FAILED attempt too, so timeouts are diagnosable', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 16},
      {kind: 'error', message: 'bridge unreachable'},
    ]);
    const manager = new TorManager(backend, {
      //          start  native-start  16%     finish
      now: scriptedClock([0, 100, 4_000, 9_000]),
    });

    expect(await manager.connect()).toBe('offline');

    const timing = manager.getLastTiming();
    // Stalled at 16% (consensus) — the connect cost is what we spent before the first percent.
    expect(timing?.slowest()?.id).toBe('consensus');
    expect(timing?.totalMs()).toBe(9_000);
  });

  it('reports the outcome to the onTiming observer', async () => {
    const seen: Array<[string, string]> = [];
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'bootstrapping', percent: 50},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      //          start  native-start  50%     finish
      now: scriptedClock([0, 100, 3_000, 4_000]),
      onTiming: (timeline, outcome) => {
        seen.push([outcome, timeline.slowest()?.id ?? 'none']);
      },
    });

    await manager.connect();

    expect(seen).toEqual([['connected', 'connect']]);
  });

  it('never lets a throwing onTiming observer break the connect', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'starting'},
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      onTiming: () => {
        throw new Error('diagnostics blew up');
      },
    });

    expect(await manager.connect()).toBe('connected');
    expect(manager.getSocksProxy()).toEqual({host: '127.0.0.1', port: 9050});
  });

  it('has no timing before the first attempt finishes', () => {
    const manager = new TorManager(new ScriptedTorBackend([]));
    expect(manager.getLastTiming()).toBeNull();
  });
});

/**
 * relayOnion resolution — the target the native post-bootstrap reachability probe dials before the
 * daemon is allowed to report `connected` (arti-ffi/src/lib.rs `probe_reachability`).
 *
 * THE BUG THESE PIN: the probe only fired for members-only communities, because the only host in
 * the start config came from `onionAuth`. `onionAuth == null` means "a PUBLIC relay onion", not
 * "no relay" — so a public community's user still got "connected" off a cached consensus with zero
 * working channels, and the connect ladder parked on a dead rung. Public coverage is therefore the
 * case that matters most here.
 */
describe('TorManager relayOnion (reachability-probe target)', () => {
  const HOST = 'a'.repeat(56);
  const HOST2 = 'b'.repeat(56);
  const AUTH_HOST = 'c'.repeat(56);

  const connectedBackend = () =>
    new ScriptedTorBackend([{kind: 'connected', socks: {host: '127.0.0.1', port: 9050}}]);

  afterEach(() => setActiveRelayOnion(null));

  it('sends relayOnion for a PUBLIC community — no onionAuth at all', async () => {
    const backend = connectedBackend();
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveRelayOnion: () => `ws://${HOST}.onion`,
    });

    expect(await manager.connect()).toBe('connected');
    // The probe has a host to dial even though this community carries no reach credential.
    expect(backend.lastConfig?.relayOnion).toBe(HOST);
    expect(backend.lastConfig?.onionAuth).toBeUndefined();
  });

  it('re-reads the resolver on EVERY connect, so a community switch moves the probe target', async () => {
    let active = `ws://${HOST}.onion`;
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveRelayOnion: () => active,
    });

    await manager.connect();
    expect(backend.lastConfig?.relayOnion).toBe(HOST);

    await manager.disconnect();
    active = `ws://${HOST2}.onion`;
    await manager.connect();
    expect(backend.lastConfig?.relayOnion).toBe(HOST2);
  });

  it('falls back to the module-level active relay onion when no resolver is wired', async () => {
    setActiveRelayOnion(`ws://${HOST}.onion/`);
    const backend = connectedBackend();
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

    await manager.connect();

    expect(backend.lastConfig?.relayOnion).toBe(HOST);
  });

  it("falls back to the onion-auth credential's own host when nothing else names a relay", async () => {
    const auth = {onionHost: AUTH_HOST, privKeyBase32: 'A'.repeat(52)};
    const backend = connectedBackend();
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveOnionAuth: () => auth,
    });

    await manager.connect();

    // Same host the native side would have fallen back to on its own — this can never NARROW the
    // probe coverage a members-only community already had.
    expect(backend.lastConfig?.relayOnion).toBe(AUTH_HOST);
  });

  it('prefers the resolver over the static option, the module value, and the auth host', async () => {
    setActiveRelayOnion(`ws://${HOST2}.onion`);
    const backend = connectedBackend();
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      relayOnion: `ws://${HOST2}.onion`,
      resolveRelayOnion: () => HOST,
      resolveOnionAuth: () => ({onionHost: AUTH_HOST, privKeyBase32: 'A'.repeat(52)}),
    });

    await manager.connect();

    expect(backend.lastConfig?.relayOnion).toBe(HOST);
  });

  it('omits relayOnion entirely when no source names a v3 onion (pre-field byte-parity)', async () => {
    const backend = connectedBackend();
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      // A clearnet relay URL is not a probe target; it must not be sent as one.
      resolveRelayOnion: () => 'wss://relay.example.com',
    });

    await manager.connect();

    expect(backend.lastConfig && 'relayOnion' in backend.lastConfig).toBe(false);
  });
});

/**
 * Deferred reachability verdicts (types.ts 'verified' / 'transport-dead') — the native background
 * probe that now runs AFTER 'connected' instead of blocking it. Exactly one of these arrives per
 * daemon lifecycle; see eventToState() and the backend.subscribe() handler in TorManager.connect().
 */
describe('TorManager onReach (deferred reachability verdicts)', () => {
  it("'verified' after connected notifies onReach(ok=true, transport) and leaves state 'connected'", async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000, transport: 'direct'});
    const seen: Array<[boolean, string | null, string | undefined]> = [];
    manager.onReach((ok, transport, message) => seen.push([ok, transport, message]));

    expect(await manager.connect()).toBe('connected');

    backend.emit({kind: 'verified'});

    expect(seen).toEqual([[true, 'direct', undefined]]);
    expect(manager.getState()).toBe('connected');
  });

  it("'transport-dead' after connected notifies onReach(ok=false, message), stops the backend, clears " +
    "SOCKS, and goes offline", async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const stopSpy = jest.spyOn(backend, 'stop');
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000, transport: 'obfs4'});
    const seen: Array<[boolean, string | null, string | undefined]> = [];
    manager.onReach((ok, transport, message) => seen.push([ok, transport, message]));

    expect(await manager.connect()).toBe('connected');
    expect(manager.getSocksProxy()).not.toBeNull();

    backend.emit({kind: 'transport-dead', message: 'no usable guards'});
    // stopBackendIfRunning() is fire-and-forget from the event handler; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([[false, 'obfs4', 'no usable guards']]);
    expect(manager.getState()).toBe('offline');
    expect(manager.getSocksProxy()).toBeNull();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('onReach unsubscribe stops further delivery to that listener', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    const seen: boolean[] = [];
    const unsub = manager.onReach(ok => seen.push(ok));

    await manager.connect();
    unsub();
    backend.emit({kind: 'verified'});

    expect(seen).toHaveLength(0);
  });

  it('a throwing onReach listener does not stop other listeners from being notified', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    const seen: boolean[] = [];
    manager.onReach(() => {
      throw new Error('listener blew up');
    });
    manager.onReach(ok => seen.push(ok));

    await manager.connect();

    expect(() => backend.emit({kind: 'verified'})).not.toThrow();
    expect(seen).toEqual([true]);
  });
});

/**
 * installReach() — the second half of an EARLY start (see its doc comment in TorManager.ts): install
 * the current reach credentials into a LIVE daemon without a restart.
 */
describe('TorManager installReach()', () => {
  it('returns false when not connected', async () => {
    const manager = new TorManager(new ScriptedTorBackend([]));
    expect(await manager.installReach()).toBe(false);
  });

  it('returns false when the connected backend has no installReach (e.g. plain ScriptedTorBackend)', async () => {
    const backend = new ScriptedTorBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    await manager.connect();

    expect(await manager.installReach()).toBe(false);
  });

  it('calls backend.installReach with the resolved credentials and returns true when connected', async () => {
    const backend = new ReachCapableBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    const auth = {onionHost: 'a'.repeat(56), privKeyBase32: 'A'.repeat(52)};
    const manager = new TorManager(backend, {
      bootstrapTimeoutMs: 1000,
      resolveOnionAuth: () => auth,
    });
    await manager.connect();

    expect(await manager.installReach()).toBe(true);
    expect(backend.installReachFn).toHaveBeenCalledTimes(1);
    expect(backend.installReachFn).toHaveBeenCalledWith({
      onionAuth: auth,
      onionAuthExtra: undefined,
      relayOnion: auth.onionHost,
    });
    // A live install activates the credential just like a fresh connect() would.
    expect(manager.isOnionAuthActive(auth)).toBe(true);
  });

  it('returns false (no throw) when backend.installReach rejects', async () => {
    const backend = new ReachCapableBackend([
      {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
    ]);
    backend.installReachFn.mockRejectedValueOnce(new Error('native install failed'));
    const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});
    await manager.connect();

    await expect(manager.installReach()).resolves.toBe(false);
  });
});
