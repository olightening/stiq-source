import {FIRST_PROGRESS_GRACE_MS, TorManager, requireTorTransport} from './TorManager';
import {ScriptedTorBackend, UnavailableTorBackend} from './backend.fake';
import {defaultBridgeLines} from './bridges';

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
    // Regression (observed on-device as stopTor() x3 back-to-back before the obfs4 start): the
    // connect cascade in App.tsx stops the backend three times to escalate one rung. connect()'s
    // own timeout handler stops it; connectBest() then calls disconnect() right after; then
    // coldConnect() walks to a tier with no bridges to dial and disconnect()s again without ever
    // starting anything. Each stop serializes on the native lifecycle executor and can block ~10s,
    // so the two redundant ones delayed the next transport by up to 20s for no reason.
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

      // Stand in for the native stopTor(), which can now block for up to ~10s before resolving.
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

  describe('getTorVersion() (warn-only PoW-readiness guard)', () => {
    it('captures the version from a connected event carrying torVersion', async () => {
      const backend = new ScriptedTorBackend([
        {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}, torVersion: '0.4.8.22'},
      ]);
      const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

      expect(await manager.connect()).toBe('connected');
      expect(manager.getTorVersion()).toBe('0.4.8.22');
    });

    it('yields null and no warning when the connected event omits torVersion', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const backend = new ScriptedTorBackend([
          {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}},
        ]);
        const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

        expect(await manager.connect()).toBe('connected');
        expect(manager.getTorVersion()).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('warns exactly once for a sub-0.4.8 daemon WITHOUT changing the resolved state', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const backend = new ScriptedTorBackend([
          {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}, torVersion: '0.4.6.10'},
        ]);
        const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

        // The guard is warn-only: connect still resolves 'connected'.
        expect(await manager.connect()).toBe('connected');
        expect(manager.getState()).toBe('connected');
        expect(manager.getTorVersion()).toBe('0.4.6.10');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('0.4.6.10');
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT warn for the shipped 0.4.8.22 daemon', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const backend = new ScriptedTorBackend([
          {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}, torVersion: '0.4.8.22'},
        ]);
        const manager = new TorManager(backend, {bootstrapTimeoutMs: 1000});

        await manager.connect();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
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
