/* eslint-disable no-bitwise -- index packing is inherently bit manipulation */
/**
 * Stiq Pictures — the inline picture token, adapted for STIQ's Tor-only / relay-only, load-on-tap
 * design. A picture never leaves the device as a photo; instead the composer attaches a tiny,
 * deterministic pixel-art version INLINE inside the message body (base64), exactly the way inline
 * voice rides inside a body (feed/voice.ts). Every surface (feed, comments, DM, channel) renders it
 * as a quiet chip that only decodes/paints when the viewer taps it.
 *
 * Wire form of one picture: a compact binary
 *   header(7) + palette(colours·3) + packed indices(ceil(res²·bpi/8))
 * base64-encoded — the exact byte layout `pixelEngine.weight()` assumes, so the organizer allowance
 * (measured in token bytes) and the actual token size never disagree. The binary is carried in a
 * self-delimited `[[pic:res;colours;l=label;base64]]` token; `[[ ]]` never occurs in base64 or
 * markdown, so it is collision-free.
 *
 * ## Two token forms, one reference type
 *
 * Those bytes may ride in the token (`;<base64>`) or in a separate blob event (`;w=<n>;STIQBLOB<id>`
 * — see feed/mediaBlob.ts). Both parse to the SAME {@link InlinePicture}, differing only in its
 * {@link InlinePicture.source}; the renderer resolves that source and cannot tell which form the body
 * used. Inline is the LEGACY form and is not going away: every post already in the wild and every
 * row in every user's local cache carries it, so it stays first-class forever.
 *
 * ## Relay-blindness: what the blob split costs (accepted, deliberate)
 *
 * This module used to guarantee: "a picture is NOT its own event kind and carries NO distinguishing
 * tag … the blind relay sees only opaque bytes; it never learns an event contains a picture." For a
 * blob-backed picture that is NO LONGER TRUE, and pretending otherwise would be worse than the leak:
 * the relay sees a post reference a blob, and sees the tap that fetches it. The trade was made
 * knowingly — inline bytes meant every picture in the community was pushed to every phone over Tor
 * whether or not anyone looked, which is what made the app unusable to browse. What is preserved:
 * the blob kind is GENERIC (media, not "picture" — the relay never learns the modality), the blob
 * carries no tag pointing back at its post, and the fetch takes an id ARRAY so decoy cover can be
 * layered on. An inline picture retains the original property in full.
 */
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {parseMediaSource, payloadWeightBytes, type MediaSource} from './mediaBlob';
import {bitsPerIndex, DITHERS, type Dither, type PixelResult} from './pixelEngine';

/** 7-byte header magic (version 1). */
const MAGIC = 0x50; // 'P'

/**
 * Hard per-token ceiling on the decoded binary (bytes). A picture at the largest allowed size
 * (256²·6bpi + 64·3 palette) is ~48.5 KB decoded; this cap (64 KB) leaves headroom while bounding a
 * malformed/hostile token. The organizer's per-period allowance is a separate, softer budget.
 */
export const MAX_PICTURE_BYTES = 64 * 1024;

/**
 * A lightweight reference to a picture in a body, as pulled out during render. It carries only the
 * chip metadata (res/colours/label) + a {@link MediaSource} saying where the bytes are — never the
 * decoded image. Everything expensive (fetch, base64→unpack→paint) is deferred to the tap.
 *
 * This is why a feed render is cheap: a picture is a quiet chip until you choose to load it, whether
 * its bytes are already inline or still sitting on the relay.
 */
export interface InlinePicture {
  res: number;
  colours: number;
  /** Optional short caption shown on the chip before it loads. */
  label?: string;
  /**
   * Where the bytes live: inline in the token (legacy) or in a blob event to fetch on tap. Resolve
   * it with `loadMediaSource` (media/mediaBlobService.ts), then {@link decodePicturePayload}.
   */
  source: MediaSource;
  /**
   * Length of the base64 payload (≈ wire bytes) — what the organizer's allowance is measured
   * against. Read from the token's `w=` field for a blob-backed picture, or the payload's own length
   * for an inline one, so the figure means the same thing in both forms (see `payloadWeightBytes`).
   */
  weightBytes: number;
}

/** A fully decoded picture, ready to paint (palette + per-pixel indices). */
export interface DecodedPicture {
  res: number;
  colours: number;
  dither: Dither;
  palette: number[][];
  indices: Uint8Array;
}

const DITHER_CODE: Record<Dither, number> = {ordered: 0, diffusion: 1, atkinson: 2, halftone: 3, none: 4};

// ── binary pack / unpack ──────────────────────────────────────────────────────────────────────────
function packIndices(indices: Uint8Array, bpi: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((indices.length * bpi) / 8));
  let bit = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    for (let b = bpi - 1; b >= 0; b--) {
      if ((idx >> b) & 1) out[bit >> 3]! |= 0x80 >> (bit & 7);
      bit++;
    }
  }
  return out;
}

function unpackIndices(bytes: Uint8Array, count: number, bpi: number): Uint8Array {
  const out = new Uint8Array(count);
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let b = 0; b < bpi; b++) {
      v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
      bit++;
    }
    out[i] = v;
  }
  return out;
}

/** Pack a quantised picture result + dither mode into the compact wire binary. */
export function packPicture(result: PixelResult, dither: Dither): Uint8Array {
  const {res, colours, palette, indices} = result;
  const bpi = bitsPerIndex(colours);
  const packed = packIndices(indices, bpi);
  const raw = new Uint8Array(7 + colours * 3 + packed.length);
  raw[0] = MAGIC;
  raw[1] = (res >> 8) & 0xff;
  raw[2] = res & 0xff;
  raw[3] = colours & 0xff;
  raw[4] = DITHER_CODE[dither] ?? 0;
  raw[5] = bpi & 0xff;
  raw[6] = 0; // reserved
  for (let i = 0; i < colours; i++) {
    const c = palette[i] ?? [0, 0, 0];
    raw[7 + i * 3] = c[0]! & 0xff;
    raw[7 + i * 3 + 1] = c[1]! & 0xff;
    raw[7 + i * 3 + 2] = c[2]! & 0xff;
  }
  raw.set(packed, 7 + colours * 3);
  return raw;
}

/** Decode the wire binary back into palette + indices, or null if malformed. */
export function unpackPicture(raw: Uint8Array): {res: number; colours: number; dither: Dither; palette: number[][]; indices: Uint8Array} | null {
  if (raw.length < 7 || raw[0] !== MAGIC) return null;
  const res = (raw[1]! << 8) | raw[2]!;
  const colours = raw[3]!;
  const dither = DITHERS[raw[4]!] ?? 'ordered';
  const bpi = raw[5]!;
  if (res < 1 || res > 512 || colours < 2 || colours > 256 || bpi < 1 || bpi > 8) return null;
  const palEnd = 7 + colours * 3;
  const idxBytes = Math.ceil((res * res * bpi) / 8);
  if (raw.length < palEnd + idxBytes) return null;
  const palette: number[][] = [];
  for (let i = 0; i < colours; i++) {
    palette.push([raw[7 + i * 3]!, raw[7 + i * 3 + 1]!, raw[7 + i * 3 + 2]!]);
  }
  const indices = unpackIndices(raw.subarray(palEnd, palEnd + idxBytes), res * res, bpi);
  return {res, colours, dither, palette, indices};
}

// ── inline body token ───────────────────────────────────────────────────────────────────────────
// `[[pic:<res>;<colours>;l=<url-encoded label>;[w=<bytes>;]<tail>]]`. res/colours ride in the text
// prefix so a renderer can label the chip without decoding; the label is URL-encoded so it can never
// contain the `;` / `]` delimiters (or a `://` / `nostr:` sequence that other body tokenizers would
// mangle).
//
// `<tail>` is EITHER the base64 payload (legacy, inline) or a `STIQBLOB<id>` reference to a blob
// event (feed/mediaBlob.ts) — one alphabet, so this single regex matches both and old bodies parse
// byte-identically. `w=` is the payload's real size, written only on a blob reference so the
// allowance keeps metering the bytes rather than the 72-char pointer; both groups are optional, so a
// legacy token still matches exactly as it did before blobs existed.
const INLINE_PIC_RE = /\[\[pic:(\d+);(\d+)(?:;l=([^;\]]*))?(?:;w=(\d+))?;([A-Za-z0-9+/=]+)\]\]/g;

/** Approximate decoded byte length of a base64 string (without allocating it). */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/** Build the inline body token for a freshly framed picture. */
export function encodeInlinePicture(result: PixelResult, dither: Dither, label?: string): string {
  const b64 = bytesToBase64(packPicture(result, dither));
  const l = label && label.trim() ? `;l=${encodeURIComponent(label.trim())}` : '';
  return `[[pic:${result.res};${result.colours}${l};${b64}]]`;
}

/**
 * Extract every picture reference from a body, in document order. Cheap: only the regex + a size-cap
 * check run here (no base64 decode, no fetch) — oversized/garbage tokens are skipped. The chip
 * resolves the source and calls `decodePicturePayload` on tap to actually paint it.
 */
export function extractInlinePictures(body: string): InlinePicture[] {
  const out: InlinePicture[] = [];
  for (const m of body.matchAll(INLINE_PIC_RE)) {
    const tail = m[5]!;
    if (!tail) continue;
    const source = parseMediaSource(tail);
    // The size cap bounds a hostile INLINE token (a blob reference is 72 chars by construction, and
    // its payload is bounded by the relay's own per-event cap when it is fetched).
    if (source.kind === 'inline' && base64ByteLength(source.payloadBase64) > MAX_PICTURE_BYTES) continue;
    const res = parseInt(m[1]!, 10);
    const colours = parseInt(m[2]!, 10);
    if (!(res > 0) || !(colours > 0)) continue;
    let label: string | undefined;
    if (m[3]) {
      try {
        label = decodeURIComponent(m[3]);
      } catch {
        label = m[3];
      }
    }
    out.push({res, colours, ...(label ? {label} : {}), source, weightBytes: payloadWeightBytes(m[4], tail)});
  }
  return out;
}

/** Decode a picture's base64 payload into palette + indices. Null if malformed. Run on tap. */
export function decodePicturePayload(payloadBase64: string): DecodedPicture | null {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(payloadBase64);
  } catch {
    return null;
  }
  return unpackPicture(raw);
}

/**
 * Decode a picture whose bytes are already in hand (an inline token). Returns null for a blob-backed
 * picture — those must be resolved through `loadMediaSource` first, then handed to
 * {@link decodePicturePayload}. Kept for the inline path and its existing callers/tests.
 */
export function decodePicture(pic: InlinePicture): DecodedPicture | null {
  return pic.source.kind === 'inline' ? decodePicturePayload(pic.source.payloadBase64) : null;
}

/** Remove inline picture tokens from a body (so the raw token never renders as text). */
export function stripInlinePictures(body: string): string {
  return body.replace(INLINE_PIC_RE, '');
}

/**
 * Count inline picture tokens in a body. Counts raw token occurrences (the same tokens
 * {@link stripInlinePictures} removes), NOT validated pictures — so it matches the relay's per-post
 * media cap exactly and is unaffected by base64 byte-size validation.
 */
export function countInlinePictures(body: string): number {
  return (body.match(INLINE_PIC_RE) || []).length;
}

/** Cheap fast-path: does the body contain at least one inline picture? */
export function hasInlinePicture(body: string): boolean {
  return body.includes('[[pic:');
}

/**
 * Collapse a body into a one-line preview, replacing any inline picture with a short label instead
 * of leaking its multi-KB base64 token. Returns '' for a genuinely empty body. Use everywhere a
 * message is shown as a single line: inbox previews, reply quotes, pinned bars.
 */
export function inlinePictureSummary(text: string): string {
  const stripped = stripInlinePictures(text).replace(/\s+/g, ' ').trim();
  if (stripped) return stripped;
  return hasInlinePicture(text) ? '🖼️ Picture' : '';
}
