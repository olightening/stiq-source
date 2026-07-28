/**
 * Coverage for the T17 Arti spike's TS seam (ArtiTorBackend). These are the PURE, host-testable
 * parts — the device-only paths (the arti-ffi cdylib, StiqArtiModule.kt) stay jest-absent, exactly
 * like the C-tor native path (nativeBackend.test.ts only covers getNetworkClass).
 *
 * We prove three things the spike promises:
 *   1. getArtiTorModule() reads NativeModules.StiqArti and is undefined when absent (safe-degrade).
 *   2. ArtiTorBackend.start/stop delegate verbatim to the native module (config forwarded, no remap).
 *   3. ArtiTorBackend.subscribe wires the SAME 'StiqTorStatus' NativeEventEmitter, and a scripted
 *      'connected' event drives a real TorManager to ConnectionState 'connected' via the shared
 *      eventToState mapping — i.e. Arti presents the identical TorBackendEvent contract, so nothing
 *      above the seam changes. (This is the spike's central "no wire change" claim.)
 *
 * react-native is mocked minimally: a functional NativeEventEmitter that records listeners on a
 * static array so the test can emit 'StiqTorStatus' events, plus a mutable NativeModules the tests
 * drive directly (the RN preset's own NativeModules is a static no-op).
 */
jest.mock('react-native', () => {
  const listeners: Array<{name: string; cb: (e: unknown) => void}> = [];
  class NativeEventEmitter {
    static listeners = listeners;
    constructor(_module: unknown) {}
    addListener(name: string, cb: (e: unknown) => void) {
      const entry = {name, cb};
      listeners.push(entry);
      return {
        remove: () => {
          const i = listeners.indexOf(entry);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    }
    removeAllListeners() {
      listeners.length = 0;
    }
  }
  return {NativeModules: {}, NativeEventEmitter};
});

import {NativeEventEmitter, NativeModules} from 'react-native';
import {ArtiTorBackend, getArtiTorModule} from './artiBackend';
import {TorManager} from './TorManager';
import type {TorBackendEvent, TorReachConfig, TorStartConfig} from './types';

const nm = NativeModules as {StiqArti?: unknown};
const emitterListeners = (NativeEventEmitter as unknown as {
  listeners: Array<{name: string; cb: (e: TorBackendEvent) => void}>;
}).listeners;

/** A no-op native module whose start/stop/installReach record their calls, mirroring the StiqArti
 *  surface (StiqArtiNativeModule now REQUIRES installReach — see TorManager.installReach()). */
function makeFakeNative() {
  const calls: {startConfig?: TorStartConfig; stopped: number; installReachConfig?: TorReachConfig} =
    {stopped: 0};
  return {
    calls,
    startTor(config: TorStartConfig): Promise<void> {
      calls.startConfig = config;
      return Promise.resolve();
    },
    stopTor(): Promise<void> {
      calls.stopped += 1;
      return Promise.resolve();
    },
    installReach: jest.fn((config: TorReachConfig): Promise<void> => {
      calls.installReachConfig = config;
      return Promise.resolve();
    }),
  };
}

/** Emit a 'StiqTorStatus' event to every registered listener, as the native emitter would. */
function emitStatus(event: TorBackendEvent) {
  for (const l of emitterListeners.slice()) {
    if (l.name === 'StiqTorStatus') l.cb(event);
  }
}

afterEach(() => {
  delete nm.StiqArti;
  emitterListeners.length = 0;
});

describe('getArtiTorModule', () => {
  it('is undefined when NativeModules.StiqArti is absent (jest/host, or unbuilt Arti .so)', () => {
    delete nm.StiqArti;
    expect(getArtiTorModule()).toBeUndefined();
  });

  it('returns the module when StiqArti is present', () => {
    const mod = makeFakeNative();
    nm.StiqArti = mod;
    expect(getArtiTorModule()).toBe(mod);
  });
});

describe('ArtiTorBackend', () => {
  it('delegates start() to native.startTor with the config forwarded verbatim (no remap)', async () => {
    const native = makeFakeNative();
    const backend = new ArtiTorBackend(native);
    const config: TorStartConfig = {
      transport: 'direct',
      bridgeLines: [],
      socksPort: 0,
      dataDir: '/data/arti',
    };
    await backend.start(config);
    expect(native.calls.startConfig).toBe(config);
  });

  it('delegates stop() to native.stopTor', async () => {
    const native = makeFakeNative();
    const backend = new ArtiTorBackend(native);
    await backend.stop();
    expect(native.calls.stopped).toBe(1);
  });

  it('installReach forwards the config verbatim to native.installReach and returns its promise', async () => {
    const native = makeFakeNative();
    const backend = new ArtiTorBackend(native);
    const config: TorReachConfig = {
      onionAuth: {onionHost: 'a'.repeat(56), privKeyBase32: 'A'.repeat(52)},
      relayOnion: 'b'.repeat(56),
    };

    const result = backend.installReach(config);

    expect(native.installReach).toHaveBeenCalledTimes(1);
    expect(native.calls.installReachConfig).toBe(config); // forwarded verbatim, no remap
    // ArtiTorBackend.installReach returns the native call's OWN promise, not a wrapper around it.
    expect(result).toBe(native.installReach.mock.results[0]!.value);
    await expect(result).resolves.toBeUndefined();
  });

  it('subscribe() wires the StiqTorStatus emitter, forwards events, and unsubscribe removes it', () => {
    const backend = new ArtiTorBackend(makeFakeNative());
    const seen: TorBackendEvent[] = [];
    const unsub = backend.subscribe(e => seen.push(e));

    expect(emitterListeners).toHaveLength(1);
    expect(emitterListeners[0]!.name).toBe('StiqTorStatus');

    emitStatus({kind: 'bootstrapping', percent: 42});
    expect(seen).toEqual([{kind: 'bootstrapping', percent: 42}]);

    unsub();
    expect(emitterListeners).toHaveLength(0);
    emitStatus({kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
    expect(seen).toHaveLength(1); // no more deliveries after unsubscribe
  });

  it('drives a real TorManager to connected — identical TorBackendEvent contract, zero wire change', async () => {
    const native = makeFakeNative();
    const manager = new TorManager(new ArtiTorBackend(native), {bootstrapTimeoutMs: 1000});

    const pending = manager.connect();
    // TorManager subscribed synchronously inside connect(); now feed the scripted sequence exactly
    // as StiqArtiModule would over 'StiqTorStatus'.
    emitStatus({kind: 'starting'});
    emitStatus({kind: 'bootstrapping', percent: 50, summary: 'Building circuits'});
    emitStatus({kind: 'connected', socks: {host: '127.0.0.1', port: 9150}});

    expect(await pending).toBe('connected');
    expect(manager.getState()).toBe('connected');
    expect(manager.getSocksProxy()).toEqual({host: '127.0.0.1', port: 9150});
    // The Arti backend received the start config — its transport defaulted to obfs4 via buildStartConfig.
    expect(native.calls.startConfig?.transport).toBe('obfs4');
  });

  it('maps an Arti error event to offline with NO clearnet fallback', async () => {
    const manager = new TorManager(new ArtiTorBackend(makeFakeNative()));
    const pending = manager.connect();
    emitStatus({kind: 'starting'});
    emitStatus({kind: 'error', message: 'pt-unsupported-in-spike'});
    expect(await pending).toBe('offline');
    expect(manager.getSocksProxy()).toBeNull();
  });
});
