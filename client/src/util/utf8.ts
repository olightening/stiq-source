/* eslint-disable no-bitwise -- UTF-8 decoding is inherently bit manipulation */
/**
 * Minimal UTF-8 decoder for bytes fetched over Tor (reader-mode HTML, JSON responses).
 * Hermes does not ship a reliable global TextDecoder, so we decode by hand. Malformed
 * sequences are replaced with U+FFFD rather than throwing.
 */
// fromCharCode.apply chokes on very large argument arrays under Hermes; stringify in bounded chunks.
const CHUNK = 8192;
const REPLACEMENT = 0xfffd; // U+FFFD REPLACEMENT CHARACTER (was the literal '�')

export function utf8Decode(bytes: Uint8Array): string {
  const n = bytes.length;
  // Collect UTF-16 code units into a densely-appended array, then stringify in bounded chunks.
  // This replaces the old per-char `out += String.fromCharCode(...)` which reallocated the growing
  // output on every append — O(n) copies that froze the JS thread on ~5MB reader-mode pages.
  const units: number[] = [];
  let i = 0;
  while (i < n) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      units.push(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0 && i < n) {
      const b1 = bytes[i++]!;
      units.push(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < n) {
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      units.push(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if (b0 >= 0xf0 && i + 2 < n) {
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      const b3 = bytes[i++]!;
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      units.push(REPLACEMENT);
    }
  }
  // fromCharCode.apply chokes on very large argument arrays under Hermes; emit in bounded chunks.
  // A surrogate pair is pushed as two adjacent units, so a chunk split between them still produces
  // the correct concatenated string (fromCharCode never re-combines pairs).
  if (units.length <= CHUNK) {
    return String.fromCharCode.apply(null, units);
  }
  let out = '';
  for (let p = 0; p < units.length; p += CHUNK) {
    out += String.fromCharCode.apply(null, units.slice(p, p + CHUNK));
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(++i);
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}
