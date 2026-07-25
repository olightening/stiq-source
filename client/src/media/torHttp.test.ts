import {bytesToBase64} from '../util/base64';
import type {TorManager} from '../tor';
import {
  resolveFinalUrl,
  torFetch,
  torFetchText,
  type StiqHttpNative,
  type StiqHttpNativeRequest,
  type StiqHttpNativeResponse,
} from './torHttp';

const ONION = 'http://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion';
const onlineManager = {getSocksProxy: () => ({host: '127.0.0.1', port: 9050})} as unknown as TorManager;
const offlineManager = {getSocksProxy: () => null} as unknown as TorManager;

type Handler = (opts: StiqHttpNativeRequest) => StiqHttpNativeResponse | Promise<StiqHttpNativeResponse>;

function fakeNative(handler: Handler): StiqHttpNative & {calls: StiqHttpNativeRequest[]} {
  const calls: StiqHttpNativeRequest[] = [];
  return {
    calls,
    async request(opts) {
      calls.push(opts);
      return handler(opts);
    },
  };
}

function ok(bytes: Uint8Array, contentType = 'application/octet-stream'): StiqHttpNativeResponse {
  return {status: 200, headers: {'Content-Type': contentType}, bodyBase64: bytesToBase64(bytes)};
}

describe('torFetch', () => {
  it('returns decoded bytes and a normalized content-type', async () => {
    const native = fakeNative(() => ok(new Uint8Array([1, 2, 3]), 'image/png; charset=binary'));
    const res = await torFetch(onlineManager, {url: `${ONION}/x.png`}, native);
    expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
    expect(res.contentType).toBe('image/png');
    expect(res.status).toBe(200);
  });

  it('routes through the SOCKS proxy with a stream-isolation tag and a pinned UA', async () => {
    const native = fakeNative(() => ok(new Uint8Array([0])));
    await torFetch(onlineManager, {url: `${ONION}/a`}, native);
    const call = native.calls[0]!;
    expect(call.socksHost).toBe('127.0.0.1');
    expect(call.socksPort).toBe(9050);
    expect(call.socksUser).toBeTruthy();
    expect(call.socksUser).toBe(call.socksPass); // same tag → same circuit
    expect(call.headers['User-Agent']).toMatch(/Firefox/);
    expect(call.headers).not.toHaveProperty('Referer');
    expect(call.headers).not.toHaveProperty('Cookie');
  });

  it('reuses a provided circuitTag', async () => {
    const native = fakeNative(() => ok(new Uint8Array([0])));
    await torFetch(onlineManager, {url: `${ONION}/a`, circuitTag: 'shared'}, native);
    expect(native.calls[0]!.socksUser).toBe('shared');
  });

  it('follows a redirect and reports the final url', async () => {
    const native = fakeNative(opts => {
      if (opts.url.endsWith('/start')) {
        return {status: 302, headers: {Location: '/final'}, bodyBase64: ''};
      }
      return ok(new Uint8Array([9]));
    });
    const res = await torFetch(onlineManager, {url: `${ONION}/start`}, native);
    expect(native.calls).toHaveLength(2);
    expect(res.url).toBe(`${ONION}/final`);
    expect(Array.from(res.bytes)).toEqual([9]);
  });

  it('stops following after maxRedirects and returns the redirect response', async () => {
    const native = fakeNative(() => ({status: 302, headers: {Location: '/loop'}, bodyBase64: ''}));
    const res = await torFetch(onlineManager, {url: `${ONION}/loop`, maxRedirects: 1}, native);
    expect(res.status).toBe(302);
    expect(native.calls).toHaveLength(2); // hop 0 + hop 1, then give up
  });

  it('throws when Tor is offline (no clearnet fallback)', async () => {
    const native = fakeNative(() => ok(new Uint8Array([0])));
    await expect(torFetch(offlineManager, {url: `${ONION}/a`}, native)).rejects.toThrow(/offline/i);
  });

  it('throws when the native module is missing rather than using the OS stack', async () => {
    await expect(torFetch(onlineManager, {url: `${ONION}/a`}, undefined)).rejects.toThrow(/not linked/i);
  });

  it('refuses a non-http(s) URL', async () => {
    const native = fakeNative(() => ok(new Uint8Array([0])));
    await expect(torFetch(onlineManager, {url: 'javascript:alert(1)'}, native)).rejects.toThrow(/non-http/i);
  });

  it('refuses a redirect that points at a non-http(s) scheme', async () => {
    const native = fakeNative(() => ({
      status: 302,
      headers: {Location: 'javascript:alert(1)'},
      bodyBase64: '',
    }));
    await expect(torFetch(onlineManager, {url: `${ONION}/x`}, native)).rejects.toThrow(/non-http/i);
  });

  it('enforces the byte cap', async () => {
    const native = fakeNative(() => ok(new Uint8Array(10)));
    await expect(torFetch(onlineManager, {url: `${ONION}/big`, maxBytes: 5}, native)).rejects.toThrow(/exceeds/);
  });
});

describe('torFetchText / resolveFinalUrl', () => {
  it('decodes UTF-8 text', async () => {
    const native = fakeNative(() => ({
      status: 200,
      headers: {'Content-Type': 'text/html; charset=utf-8'},
      bodyBase64: bytesToBase64(new Uint8Array([0x68, 0x69])), // "hi"
    }));
    const {text} = await torFetchText(onlineManager, {url: `${ONION}/p`}, native);
    expect(text).toBe('hi');
  });

  it('resolveFinalUrl follows redirects via HEAD', async () => {
    const native = fakeNative((opts): StiqHttpNativeResponse => {
      if (opts.url.endsWith('/a')) {
        return {status: 301, headers: {Location: `${ONION}/b`}, bodyBase64: ''};
      }
      return {status: 200, headers: {}, bodyBase64: ''};
    });
    const {finalUrl, status} = await resolveFinalUrl(onlineManager, `${ONION}/a`, native);
    expect(finalUrl).toBe(`${ONION}/b`);
    expect(status).toBe(200);
    expect(native.calls[0]!.method).toBe('HEAD');
  });
});
