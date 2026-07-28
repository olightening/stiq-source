/**
 * CTorBackend (ctorBackend.ts) — the ctor flavor's TorBackend adapter over the StiqTor native
 * module. The load-bearing contracts:
 *   - start() forwards TorStartConfig VERBATIM (transport strings are a native contract pinned
 *     by transportContract.test.ts; extra fields like relayOnion ride along harmlessly).
 *   - subscribe() relays 'StiqTorStatus' device events untouched and unsubscribes cleanly.
 *   - NO installReach — its absence is what routes TorManager.installReach() to the
 *     restart path C-tor requires (ClientOnionAuthDir is read at Tor start only).
 */
type Listener = (event: unknown) => void;
const mockListeners: {current: Map<string, Listener[]>} = {current: new Map()};

jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: class {
    constructor(_m: unknown) {}
    addListener(name: string, fn: Listener) {
      const arr = mockListeners.current.get(name) ?? [];
      arr.push(fn);
      mockListeners.current.set(name, arr);
      return {
        remove: () => {
          const a = mockListeners.current.get(name) ?? [];
          const i = a.indexOf(fn);
          if (i >= 0) a.splice(i, 1);
        },
      };
    }
    removeAllListeners() {}
  },
}));

import {CTorBackend, getCtorTorModule} from './ctorBackend';
import type {TorBackend} from './backend';
import {NativeModules} from 'react-native';

const nm = NativeModules as {StiqTor?: unknown};

beforeEach(() => {
  mockListeners.current = new Map();
});

afterEach(() => {
  delete nm.StiqTor;
});

const emit = (name: string, event: unknown) => {
  for (const fn of mockListeners.current.get(name) ?? []) fn(event);
};

describe('getCtorTorModule', () => {
  it('returns the StiqTor module when linked, undefined otherwise', () => {
    expect(getCtorTorModule()).toBeUndefined();
    const mod = {startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()};
    nm.StiqTor = mod;
    expect(getCtorTorModule()).toBe(mod);
  });
});

describe('CTorBackend', () => {
  const native = () => {
    const calls: {start: unknown[]; stop: number} = {start: [], stop: 0};
    return {
      calls,
      startTor: (config: unknown) => {
        calls.start.push(config);
        return Promise.resolve();
      },
      stopTor: () => {
        calls.stop += 1;
        return Promise.resolve();
      },
    };
  };

  it('start() forwards the config verbatim — no remapping, unknown fields included', async () => {
    const mod = native();
    const backend = new CTorBackend(mod);
    const config = {
      transport: 'obfs4' as const,
      bridgeLines: ['obfs4 1.2.3.4:443 FINGERPRINT cert=abc iat-mode=0'],
      socksPort: 9050,
      relayOnion: 'a'.repeat(56),
    };
    await backend.start(config);
    expect(mod.calls.start).toHaveLength(1);
    expect(mod.calls.start[0]).toBe(config);
  });

  it('stop() calls stopTor()', async () => {
    const mod = native();
    const backend = new CTorBackend(mod);
    await backend.stop();
    expect(mod.calls.stop).toBe(1);
  });

  it("subscribe() relays 'StiqTorStatus' events untouched and the returned fn unsubscribes", () => {
    const backend = new CTorBackend(native());
    const seen: unknown[] = [];
    const unsub = backend.subscribe(e => seen.push(e));
    const event = {kind: 'bootstrapping', percent: 45, summary: 'Loading relay descriptors'};
    emit('StiqTorStatus', event);
    expect(seen).toEqual([event]);
    unsub();
    emit('StiqTorStatus', {kind: 'connected', socks: {host: '127.0.0.1', port: 9050}});
    expect(seen).toHaveLength(1);
  });

  it('has NO installReach — TorManager.installReach() must return false for this backend', () => {
    const backend: TorBackend = new CTorBackend(native());
    expect(backend.installReach).toBeUndefined();
  });
});
