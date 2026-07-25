/* eslint-disable no-bitwise -- PNG/DEFLATE/CRC are inherently bit manipulation */
/**
 * Minimal, dependency-free PNG encoder (Hermes-safe).
 *
 * The Stiq Pictures pipeline decodes an inline token into an indexed pixel-art image; to render it
 * we need a real image the RN `<Image>` can display. There is no HTML canvas on Hermes and no
 * pako/zlib in the bundle, so we emit a PNG whose zlib stream uses **stored (uncompressed) DEFLATE
 * blocks** — standards-valid and trivial to produce without a compressor. The PNG is only ever an
 * in-memory render target (a `data:` URI, exactly like media/image.ts): it is NEVER transmitted, so
 * its lack of compression costs nothing on the wire — the compact packed token is the wire form.
 *
 * `encodeIndexedPng` expands an indexed image (palette + indices) to RGB with an integer
 * nearest-neighbour upscale, so the big pixels stay crisp (RN `<Image>` has no `image-rendering:
 * pixelated` equivalent — we bake the upscale into the bitmap instead).
 */
import {bytesToBase64} from '../util/base64';

// ── CRC32 (PNG chunk checksum) ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Adler-32 (zlib stream checksum) ────────────────────────────────────────────
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  // Process in chunks so the running sums never overflow a 32-bit int before the modulo.
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Wrap a chunk (type + data) with its 4-byte length prefix and trailing CRC. */
function chunk(type: string, data: Uint8Array): number[] {
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

/** Wrap raw bytes in a zlib stream that uses only stored (uncompressed) DEFLATE blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01]; // zlib header: CM=8/CINFO=7, FLEVEL=0, FCHECK
  let i = 0;
  do {
    const len = Math.min(0xffff, raw.length - i);
    const last = i + len >= raw.length ? 1 : 0;
    out.push(last); // BFINAL in bit0, BTYPE=00 (stored) — byte-aligned
    out.push(len & 0xff, (len >>> 8) & 0xff); // LEN (little-endian)
    out.push(~len & 0xff, (~len >>> 8) & 0xff); // NLEN = ~LEN
    for (let j = 0; j < len; j++) out.push(raw[i + j]!);
    i += len;
  } while (i < raw.length);
  out.push(...u32be(adler32(raw)));
  return Uint8Array.from(out);
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Encode an RGB bitmap (3 bytes/pixel, row-major) as a PNG byte array. Colour type 2 (truecolour,
 * no alpha) — Stiq pictures are always opaque, so we skip the alpha channel to keep the buffer
 * smaller. Each scanline is prefixed with filter byte 0 (None).
 */
export function encodeRgbPng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = Uint8Array.from([
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    2, // colour type: truecolour (RGB)
    0, // compression: deflate
    0, // filter: adaptive (only filter 0 used)
    0, // interlace: none
  ]);
  // Raw scanlines: each row is [filter=0, r,g,b, r,g,b, …].
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: None
    raw.set(rgb.subarray(y * stride, y * stride + stride), dst + 1);
  }
  const idat = zlibStored(raw);
  const bytes = [...PNG_SIG, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))];
  return Uint8Array.from(bytes);
}

/**
 * Expand an indexed pixel-art image (palette + per-pixel indices at `res`×`res`) into an RGB PNG,
 * integer-upscaled by `scale` (nearest-neighbour) so the pixels render crisp. Returns PNG bytes.
 */
export function encodeIndexedPng(
  indices: Uint8Array,
  palette: readonly (readonly number[])[],
  res: number,
  scale = 1,
): Uint8Array {
  const s = Math.max(1, Math.floor(scale));
  const w = res * s;
  const stride = w * 3;
  const rgb = new Uint8Array(w * res * s * 3);
  for (let y = 0; y < res; y++) {
    // Build one source row of RGB, then copy it `s` times (vertical upscale).
    const rowStart = (y * s) * stride;
    for (let x = 0; x < res; x++) {
      const c = palette[indices[y * res + x]!] ?? BLACK;
      const r = c[0]! & 0xff;
      const g = c[1]! & 0xff;
      const b = c[2]! & 0xff;
      const base = rowStart + x * s * 3;
      for (let dx = 0; dx < s; dx++) {
        const o = base + dx * 3;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = b;
      }
    }
    for (let dy = 1; dy < s; dy++) {
      rgb.copyWithin(rowStart + dy * stride, rowStart, rowStart + stride);
    }
  }
  return encodeRgbPng(rgb, w, res * s);
}

const BLACK: readonly number[] = [0, 0, 0];

/** Convenience: an indexed image → a `data:image/png;base64,…` URI ready for `<Image source>`. */
export function indexedPngDataUri(
  indices: Uint8Array,
  palette: readonly (readonly number[])[],
  res: number,
  scale = 1,
): string {
  return `data:image/png;base64,${bytesToBase64(encodeIndexedPng(indices, palette, res, scale))}`;
}
