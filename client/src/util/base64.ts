/* eslint-disable no-bitwise -- base64 is inherently bit manipulation */
/** Standard base64 (RFC 4648, padded) — matches Go's base64.StdEncoding. Self-contained. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Precomputed 256-entry reverse lookup: byte code -> 6-bit value, or -1 if not an alphabet char.
// Replaces the O(64) ALPHABET.indexOf() scan that ran once per input character.
const REVERSE = ((): Int8Array => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

// fromCharCode.apply chokes on very large argument arrays under Hermes; emit in bounded chunks.
const CHUNK = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  // Each 3-byte group yields 4 chars (padded), so output length is a multiple of 4.
  const chars = new Array<number>(Math.ceil(n / 3) * 4);
  let ci = 0;
  const EQ = 61; // '='.charCodeAt(0)
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    chars[ci++] = ALPHABET.charCodeAt((triplet >> 18) & 63);
    chars[ci++] = ALPHABET.charCodeAt((triplet >> 12) & 63);
    chars[ci++] = b1 === undefined ? EQ : ALPHABET.charCodeAt((triplet >> 6) & 63);
    chars[ci++] = b2 === undefined ? EQ : ALPHABET.charCodeAt(triplet & 63);
  }
  // Build the string in chunks instead of per-char concatenation.
  let out = '';
  for (let i = 0; i < chars.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, chars.slice(i, i + CHUNK));
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const cn = clean.length;
  const out = new Uint8Array(Math.floor((cn * 3) / 4));
  let acc = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < cn; i++) {
    const code = clean.charCodeAt(i);
    const idx = code < 256 ? REVERSE[code]! : -1;
    if (idx === -1) {
      throw new Error('invalid base64');
    }
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
