/**
 * Outbound image upload (Tier 3) — Blossom over Tor.
 *
 * The relay never stores media. A posted image is sanitized + re-encoded on-device (native
 * StiqImage strips EXIF/GPS and normalizes the format), hashed, given a BlurHash, then PUT to
 * a Blossom server (BUD-01/02) THROUGH Tor — ideally an `.onion` host so the upload never
 * touches an exit node. The returned URL + sha256 + BlurHash become a NIP-94 `imeta` tag on
 * the post, so every reader gets a leak-free preview and a hash to verify the download.
 */
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {bytesToBase64} from '../util/base64';
import {utf8Decode, utf8Encode} from '../util/utf8';
import {MEDIA_MAX_BYTES} from '../config';
import type {TorManager} from '../tor';
import type {ImageMeta} from '../nostr/imeta';
import {torFetch, type StiqHttpNative} from './torHttp';

/** Kind 24242 Blossom authorization event (BUD-01). */
export function buildBlossomAuth(sha256: string, action: 'upload' = 'upload'): UnsignedEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    created_at: now,
    content: `Upload ${sha256}`,
    tags: [
      ['t', action],
      ['x', sha256.toLowerCase()],
      ['expiration', String(now + 600)], // 10-minute validity
    ],
  };
}

export interface ProcessedImage {
  /** Sanitized, re-encoded bytes (EXIF/GPS stripped by StiqImage). */
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  blurhash?: string;
}

export type AuthSigner = (unsigned: UnsignedEvent) => Promise<Event>;

interface BlobDescriptor {
  url?: string;
  sha256?: string;
  size?: number;
  type?: string;
}

/**
 * Upload a processed image to a Blossom server over Tor and return the NIP-94 `imeta` to embed.
 * Throws when no host is configured, on a non-2xx response, or on a sha256 mismatch.
 */
export async function uploadToBlossom(
  manager: TorManager,
  endpoint: string,
  img: ProcessedImage,
  signAuth: AuthSigner,
  native?: StiqHttpNative,
): Promise<ImageMeta> {
  if (!endpoint) {
    throw new Error('no media host configured (set MEDIA_BLOSSOM_ENDPOINT)');
  }
  const auth = await signAuth(buildBlossomAuth(img.sha256));
  const authHeader = `Nostr ${bytesToBase64(utf8Encode(JSON.stringify(auth)))}`;

  const res = await torFetch(
    manager,
    {
      url: `${endpoint.replace(/\/+$/, '')}/upload`,
      method: 'PUT',
      headers: {Authorization: authHeader, 'Content-Type': img.mime},
      bodyBase64: bytesToBase64(img.bytes),
      maxBytes: MEDIA_MAX_BYTES,
      maxRedirects: 0,
    },
    native,
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`upload failed (HTTP ${res.status})`);
  }
  let descriptor: BlobDescriptor;
  try {
    descriptor = JSON.parse(utf8Decode(res.bytes)) as BlobDescriptor;
  } catch {
    throw new Error('upload response was not valid JSON');
  }
  if (!descriptor.url) {
    throw new Error('upload response missing url');
  }
  // Content-addressed integrity: the host must have stored exactly our bytes.
  if (descriptor.sha256 && descriptor.sha256.toLowerCase() !== img.sha256.toLowerCase()) {
    throw new Error('server reported a different sha256');
  }

  return {
    url: descriptor.url,
    mime: img.mime,
    dim: {width: img.width, height: img.height},
    blurhash: img.blurhash,
    sha256: img.sha256,
    size: img.bytes.length,
  };
}
