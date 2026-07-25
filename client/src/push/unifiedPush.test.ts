/**
 * T1 UnifiedPush TS wrapper + registration substrate. Pure functions + an injected fake torHttp /
 * fake native module — no real Tor, no real native connector. Asserts the privacy invariants: a
 * host-mismatched endpoint never registers, the body carries only coarse p:/h:/e: keys, and the whole
 * wrapper is absent-safe when the native module isn't compiled in.
 */
import {NativeModules} from 'react-native';
import {PUSH_UNIFIEDPUSH} from '../config';
import type {TorManager} from '../tor';
import type {StiqHttpNative} from '../media/torHttp';
import {defaultRelayCapabilities, type RelayCapabilities} from '../nostr/capabilities';
import {
  buildRegistration,
  extractNtfyTopic,
  getDistributor,
  getEndpoint,
  hasUnifiedPushModule,
  pushEnabled,
  registerApp,
  registerWithWatcher,
} from './unifiedPush';

const HOST = 'ntfyabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion';

describe('extractNtfyTopic', () => {
  it('returns the last path segment when the host matches', () => {
    expect(extractNtfyTopic(`http://${HOST}:2586/up-Ab12_cd`, HOST)).toBe('up-Ab12_cd');
  });

  it('matches host-only allowed against an endpoint carrying a port', () => {
    expect(extractNtfyTopic(`https://${HOST}:2586/topic1`, `${HOST}:2586`)).toBe('topic1');
  });

  it('returns null on a host mismatch (never leak the endpoint to a foreign ntfy)', () => {
    expect(extractNtfyTopic(`http://evil.onion/topic1`, HOST)).toBeNull();
  });

  it('returns null for a malformed endpoint or a missing topic segment', () => {
    expect(extractNtfyTopic(`http://${HOST}/`, HOST)).toBeNull();
    expect(extractNtfyTopic('', HOST)).toBeNull();
    expect(extractNtfyTopic(`http://${HOST}/bad topic!`, HOST)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractNtfyTopic(undefined as any, HOST)).toBeNull();
  });
});

describe('buildRegistration', () => {
  const base = {
    myPubkey: 'AB'.repeat(32), // mixed case → must be lowercased
    groupIds: ['group1', 'group2'],
    allowedNtfyHost: HOST,
    ttlSeconds: 7 * 86400,
  };

  it('builds a v1 registration with coarse p:/h:/e: keys and a future exp', () => {
    const before = Math.floor(Date.now() / 1000);
    const reg = buildRegistration(`http://${HOST}:2586/cap-topic`, {
      ...base,
      rootIds: ['CD'.repeat(32)],
    });
    expect(reg).not.toBeNull();
    expect(reg!.v).toBe(1);
    expect(reg!.topic).toBe('cap-topic');
    expect(reg!.keys).toEqual([
      `p:${'ab'.repeat(32)}`,
      'h:group1',
      'h:group2',
      `e:${'cd'.repeat(32)}`,
    ]);
    expect(reg!.exp).toBeGreaterThanOrEqual(before + 7 * 86400);
  });

  it('omits e: keys when no rootIds are supplied', () => {
    const reg = buildRegistration(`http://${HOST}/t`, base);
    expect(reg!.keys).toEqual([`p:${'ab'.repeat(32)}`, 'h:group1', 'h:group2']);
  });

  it('returns null when the endpoint host is not the advertised ntfy host', () => {
    expect(buildRegistration('http://someoneelse.onion/t', base)).toBeNull();
  });

  it('returns null when the member has no pubkey', () => {
    expect(buildRegistration(`http://${HOST}/t`, {...base, myPubkey: ''})).toBeNull();
  });
});

describe('pushEnabled (flag × caps matrix)', () => {
  const withWatcher: RelayCapabilities = {
    ...defaultRelayCapabilities(),
    push: {watcher: 'w.onion:8787', ntfy: 'n.onion'},
  };
  const noWatcher: RelayCapabilities = {...defaultRelayCapabilities(), push: {ntfy: 'n.onion'}};

  it('requires BOTH the flag and an advertised watcher (AND semantics)', () => {
    // Tracks the real flag: enabled iff PUSH_UNIFIEDPUSH is on AND caps.push.watcher exists.
    expect(pushEnabled(withWatcher)).toBe(PUSH_UNIFIEDPUSH);
  });

  it('is false whenever the relay advertises no watcher, regardless of the flag', () => {
    expect(pushEnabled(noWatcher)).toBe(false);
    expect(pushEnabled(defaultRelayCapabilities())).toBe(false);
  });
});

describe('registerWithWatcher (over an injected fake torHttp)', () => {
  const manager = {getSocksProxy: () => ({host: '127.0.0.1', port: 9050})} as unknown as TorManager;
  const reg = {v: 1 as const, topic: 't', keys: ['p:' + 'ab'.repeat(32)], exp: 9999999999};

  it('returns true and POSTs JSON to <watcher>/push/register on a 204', async () => {
    const request = jest.fn(
      async (_opts: {url: string; method: string; headers: Record<string, string>; bodyBase64: string}) => ({
        status: 204,
        headers: {},
        bodyBase64: '',
      }),
    );
    const native: StiqHttpNative = {request};
    await expect(registerWithWatcher('abc.onion:8787', reg, manager, native)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    const opts = request.mock.calls[0]![0];
    expect(opts.url).toBe('http://abc.onion:8787/push/register');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.bodyBase64.length).toBeGreaterThan(0);
  });

  it('returns false on any non-204 status', async () => {
    const native: StiqHttpNative = {request: jest.fn(async () => ({status: 500, headers: {}, bodyBase64: ''}))};
    await expect(registerWithWatcher('abc.onion:8787', reg, manager, native)).resolves.toBe(false);
  });

  it('returns false (never throws) when Tor is offline', async () => {
    const offline = {getSocksProxy: () => null} as unknown as TorManager;
    const native: StiqHttpNative = {request: jest.fn()};
    await expect(registerWithWatcher('abc.onion:8787', reg, offline, native)).resolves.toBe(false);
  });
});

describe('native module wrapper (absent-safe)', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (NativeModules as any).StiqUnifiedPush;
  });

  it('degrades to no-ops when the native module is absent', async () => {
    expect(hasUnifiedPushModule()).toBe(false);
    await expect(registerApp()).resolves.toBe('no_module');
    await expect(getEndpoint()).resolves.toBeNull();
    await expect(getDistributor()).resolves.toBeNull();
  });

  it('delegates to the native module when present, and swallows a native throw', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqUnifiedPush = {
      registerApp: jest.fn(async () => 'registered'),
      getEndpoint: jest.fn(async () => 'http://x.onion/topic'),
      getDistributor: jest.fn(async () => 'org.ntfy'),
    };
    expect(hasUnifiedPushModule()).toBe(true);
    await expect(registerApp()).resolves.toBe('registered');
    await expect(getEndpoint()).resolves.toBe('http://x.onion/topic');
    await expect(getDistributor()).resolves.toBe('org.ntfy');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqUnifiedPush = {
      registerApp: jest.fn(async () => {
        throw new Error('native boom');
      }),
    };
    await expect(registerApp()).resolves.toBe('error');
  });
});
