import {bytesToBase64} from '../util/base64';
import {sha256Hex} from '../util/hash';
import type {TorManager} from '../tor';
import type {StiqHttpNative, StiqHttpNativeResponse} from './torHttp';
import {
  detectImageType,
  fetchImage,
  isAnimatedImage,
  looksLikeImageUrl,
  verifySha256,
} from './image';

const onlineManager = {getSocksProxy: () => ({host: '127.0.0.1', port: 9050})} as unknown as TorManager;
const ONION = 'http://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const HTML = new Uint8Array([0x3c, 0x21, 0x64, 0x6f, 0x63]); // "<!doc"
// RIFF........WEBPANIM... — an allowed type (webp) that is animated.
const ANIM_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x41, 0x4e, 0x49, 0x4d, 0, 0,
]);

function nativeReturning(bytes: Uint8Array, contentType = 'image/jpeg'): StiqHttpNative {
  return {
    async request(): Promise<StiqHttpNativeResponse> {
      return {status: 200, headers: {'Content-Type': contentType}, bodyBase64: bytesToBase64(bytes)};
    },
  };
}

describe('detectImageType', () => {
  it('recognizes jpeg/png/gif by magic bytes', () => {
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(GIF)).toBe('image/gif');
  });
  it('returns null for non-image bytes', () => {
    expect(detectImageType(HTML)).toBeNull();
  });
});

describe('isAnimatedImage', () => {
  it('treats GIF as animated', () => {
    expect(isAnimatedImage(GIF)).toBe(true);
  });
  it('treats a plain jpeg as static', () => {
    expect(isAnimatedImage(JPEG)).toBe(false);
  });
  it('detects an animated WebP via its ANIM chunk', () => {
    expect(isAnimatedImage(ANIM_WEBP)).toBe(true);
  });
});

describe('looksLikeImageUrl', () => {
  it('matches image extensions, including with query', () => {
    expect(looksLikeImageUrl('https://h/a.jpg')).toBe(true);
    expect(looksLikeImageUrl('https://h/a.png?x=1')).toBe(true);
    expect(looksLikeImageUrl('https://h/page')).toBe(false);
  });
});

describe('verifySha256', () => {
  it('passes when no hash is pinned', () => {
    expect(verifySha256(JPEG)).toBe(true);
  });
  it('matches a correct hash and rejects a wrong one', () => {
    expect(verifySha256(JPEG, sha256Hex(JPEG))).toBe(true);
    expect(verifySha256(JPEG, 'f'.repeat(64))).toBe(false);
  });
});

describe('fetchImage', () => {
  it('fetches, sniffs, and returns a data URI', async () => {
    const img = await fetchImage(
      onlineManager,
      {url: `${ONION}/a.jpg`},
      {},
      nativeReturning(JPEG),
    );
    expect(img.mime).toBe('image/jpeg');
    expect(img.dataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('rejects content that is not an allowed image type', async () => {
    await expect(
      fetchImage(onlineManager, {url: `${ONION}/x`}, {}, nativeReturning(HTML, 'text/html')),
    ).rejects.toThrow(/non-image|unsupported/i);
  });

  it('rejects animated images (allowed type but multi-frame)', async () => {
    await expect(
      fetchImage(onlineManager, {url: `${ONION}/a.webp`}, {}, nativeReturning(ANIM_WEBP, 'image/webp')),
    ).rejects.toThrow(/animated/i);
  });

  it('rejects a sha256 mismatch', async () => {
    await expect(
      fetchImage(
        onlineManager,
        {url: `${ONION}/a.jpg`, sha256: 'a'.repeat(64)},
        {},
        nativeReturning(JPEG),
      ),
    ).rejects.toThrow(/sha256/i);
  });

  it('passes when the pinned sha256 matches', async () => {
    const img = await fetchImage(
      onlineManager,
      {url: `${ONION}/a.jpg`, sha256: sha256Hex(JPEG)},
      {},
      nativeReturning(JPEG),
    );
    expect(img.mime).toBe('image/jpeg');
  });
});
