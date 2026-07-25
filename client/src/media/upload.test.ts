import type {Event} from 'nostr-tools/pure';
import {bytesToBase64} from '../util/base64';
import {utf8Decode, utf8Encode} from '../util/utf8';
import {sha256Hex} from '../util/hash';
import type {TorManager} from '../tor';
import type {StiqHttpNative, StiqHttpNativeRequest, StiqHttpNativeResponse} from './torHttp';
import {buildBlossomAuth, uploadToBlossom, type ProcessedImage} from './upload';

const onlineManager = {getSocksProxy: () => ({host: '127.0.0.1', port: 9050})} as unknown as TorManager;
const ONION = 'http://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion';

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const img: ProcessedImage = {
  bytes,
  mime: 'image/jpeg',
  width: 800,
  height: 600,
  sha256: sha256Hex(bytes),
  blurhash: 'L6Pj0^jE',
};

// A stand-in signer that returns the unsigned event as if signed.
const signAuth = async (u: {kind: number; tags: string[][]; content: string; created_at: number}): Promise<Event> =>
  ({...u, id: 'id', pubkey: 'pk', sig: 'sig'} as Event);

function fakeNative(
  handler: (opts: StiqHttpNativeRequest) => StiqHttpNativeResponse,
): StiqHttpNative & {calls: StiqHttpNativeRequest[]} {
  const calls: StiqHttpNativeRequest[] = [];
  return {
    calls,
    async request(opts) {
      calls.push(opts);
      return handler(opts);
    },
  };
}

function jsonResponse(status: number, body: unknown): StiqHttpNativeResponse {
  return {
    status,
    headers: {'Content-Type': 'application/json'},
    bodyBase64: bytesToBase64(utf8Encode(JSON.stringify(body))),
  };
}

describe('buildBlossomAuth', () => {
  it('builds a kind-24242 event pinning the sha256', () => {
    const ev = buildBlossomAuth('ABCD');
    expect(ev.kind).toBe(24242);
    expect(ev.tags).toContainEqual(['t', 'upload']);
    expect(ev.tags).toContainEqual(['x', 'abcd']);
    expect(ev.tags.find(t => t[0] === 'expiration')).toBeDefined();
  });
});

describe('uploadToBlossom', () => {
  it('PUTs over Tor with a Nostr auth header and returns imeta', async () => {
    const native = fakeNative(() => jsonResponse(200, {url: `${ONION}/x.jpg`, sha256: img.sha256, size: bytes.length}));
    const meta = await uploadToBlossom(onlineManager, ONION, img, signAuth, native);

    expect(meta.url).toBe(`${ONION}/x.jpg`);
    expect(meta.sha256).toBe(img.sha256);
    expect(meta.blurhash).toBe('L6Pj0^jE');
    expect(meta.dim).toEqual({width: 800, height: 600});

    const call = native.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${ONION}/upload`);
    expect(call.headers.Authorization?.startsWith('Nostr ')).toBe(true);
    // The auth header carries the signed kind-24242 event.
    const authJson = utf8Decode(
      Uint8Array.from(atobToBytes(call.headers.Authorization!.slice('Nostr '.length))),
    );
    expect(JSON.parse(authJson).kind).toBe(24242);
  });

  it('throws without a configured endpoint', async () => {
    await expect(uploadToBlossom(onlineManager, '', img, signAuth)).rejects.toThrow(/no media host/i);
  });

  it('throws on a non-2xx response', async () => {
    const native = fakeNative(() => jsonResponse(413, {message: 'too big'}));
    await expect(uploadToBlossom(onlineManager, ONION, img, signAuth, native)).rejects.toThrow(/HTTP 413/);
  });

  it('rejects a server sha256 mismatch', async () => {
    const native = fakeNative(() => jsonResponse(200, {url: `${ONION}/x.jpg`, sha256: 'f'.repeat(64)}));
    await expect(uploadToBlossom(onlineManager, ONION, img, signAuth, native)).rejects.toThrow(/sha256/i);
  });
});

// Minimal base64→bytes for the test (mirrors util/base64 decoding) to read the auth header back.
function atobToBytes(b64: string): number[] {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | ALPHA.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}
