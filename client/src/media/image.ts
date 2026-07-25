/**
 * Inbound image policy + fetch (Tiers 1 & 2).
 *
 * Pure helpers (magic-byte sniffing, animation detection, hash-pin verification) are testable
 * in isolation; `fetchImage` ties them to the Tor transport so a remote image is pulled over
 * Tor, capped, sniffed, hash-verified against its NIP-94 `imeta`, and handed to the renderer
 * as an in-memory `data:` URI — never an `<Image>`-over-the-OS-network-stack fetch.
 */
import {bytesToBase64} from '../util/base64';
import {sha256Hex} from '../util/hash';
import {MEDIA_ALLOWED_MIME, MEDIA_MAX_BYTES} from '../config';
import type {ImageMeta} from '../nostr/imeta';
import type {TorManager} from '../tor';
import {torFetch, type StiqHttpNative} from './torHttp';

export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** Identify an image by its leading magic bytes — never trust a server's Content-Type. */
export function detectImageType(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'; // GIF8
  }
  return null;
}

/**
 * Detect multi-frame / animated images. We reject these on the inbound path: animated GIF,
 * animated WebP (an ANIM chunk), and APNG (an acTL chunk before IDAT) are a larger decoder
 * attack surface and a common way to smuggle surprising content past a static preview.
 */
export function isAnimatedImage(bytes: Uint8Array): boolean {
  const type = detectImageType(bytes);
  if (type === 'image/gif') {
    return true; // treat all GIFs as animatable
  }
  const ascii = (start: number, str: string): boolean => {
    for (let i = 0; i < str.length; i++) {
      if (bytes[start + i] !== str.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  };
  if (type === 'image/webp') {
    for (let i = 12; i + 4 < Math.min(bytes.length, 4096); i++) {
      if (ascii(i, 'ANIM') || ascii(i, 'ANMF')) {
        return true;
      }
    }
  }
  if (type === 'image/png') {
    for (let i = 8; i + 4 < Math.min(bytes.length, 4096); i++) {
      if (ascii(i, 'acTL')) {
        return true; // APNG animation control chunk
      }
      if (ascii(i, 'IDAT')) {
        break; // image data started; no acTL before it → static PNG
      }
    }
  }
  return false;
}

/** Whether a bare URL's extension looks like an image (used to route raw links to image cards). */
export function looksLikeImageUrl(url: string): boolean {
  return /\.(?:jpe?g|png|gif|webp)(?:[?#]\S*)?$/i.test(url);
}

/** Verify fetched bytes match the sha256 pinned in the imeta `x` tag (Tier 2 hash-pin). */
export function verifySha256(bytes: Uint8Array, expectedHex?: string): boolean {
  if (!expectedHex) {
    return true; // nothing to verify against
  }
  return sha256Hex(bytes) === expectedHex.toLowerCase();
}

export interface FetchedImage {
  mime: SniffedMime;
  bytes: Uint8Array;
  /** In-memory data URI for leak-free rendering via <Image source={{uri}}>. */
  dataUri: string;
}

export interface FetchImageOptions {
  allowed?: readonly string[];
  maxBytes?: number;
  /** Share a circuit with related fetches; omit for per-image isolation. */
  circuitTag?: string;
}

/**
 * Fetch a referenced image over Tor and return renderable bytes, or throw with a reason.
 * Order matters: cap → sniff (allow-list) → reject animated → hash-pin verify, all BEFORE the
 * bytes are exposed for rendering.
 */
export async function fetchImage(
  manager: TorManager,
  meta: ImageMeta,
  opts: FetchImageOptions = {},
  native?: StiqHttpNative,
): Promise<FetchedImage> {
  const allowed = opts.allowed ?? MEDIA_ALLOWED_MIME;
  const maxBytes = opts.maxBytes ?? MEDIA_MAX_BYTES;
  if (meta.size && meta.size > maxBytes) {
    throw new Error(`image declares ${meta.size} bytes, over the ${maxBytes} cap`);
  }
  const res = await torFetch(
    manager,
    {url: meta.url, maxBytes, circuitTag: opts.circuitTag},
    native,
  );
  const bytes = res.bytes;
  const sniffed = detectImageType(bytes);
  if (!sniffed || !allowed.includes(sniffed)) {
    throw new Error(`unsupported or non-image content (${sniffed ?? 'unknown'})`);
  }
  if (isAnimatedImage(bytes)) {
    throw new Error('animated images are not displayed');
  }
  if (!verifySha256(bytes, meta.sha256)) {
    throw new Error('sha256 mismatch — refusing tampered media');
  }
  return {mime: sniffed, bytes, dataUri: `data:${sniffed};base64,${bytesToBase64(bytes)}`};
}
