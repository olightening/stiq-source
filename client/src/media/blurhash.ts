/* eslint-disable no-bitwise -- BlurHash decoding is inherently bit manipulation */
/**
 * Pure-JS BlurHash decoder (Tier 0 — visual, zero network, zero IP leak).
 *
 * A BlurHash is ~20-30 chars of text the *poster* computes and embeds in the signed event
 * (NIP-94 `imeta` `blurhash`). Every reader decodes it locally into a soft, colorful preview
 * WITHOUT fetching a single byte — so a malicious post can never turn "show me a preview"
 * into a network request that reveals the reader's IP.
 *
 * We decode to a coarse grid of average colors (default 8x8) and render it as plain RN Views
 * (see BlurhashView), which keeps the whole path dependency-free and fully testable — no
 * native canvas, no pixel buffers, no `<Image>` (which would hit the OS network stack).
 *
 * Algorithm per the BlurHash reference (https://github.com/woltapp/blurhash).
 */

const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str: string): number {
  let value = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = DIGITS.indexOf(str.charAt(i));
    if (idx === -1) {
      return NaN;
    }
    value = value * 83 + idx;
  }
  return value;
}

function sRGBToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearTosRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255 + 0.5)
    : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(val: number, exp: number): number {
  return (val < 0 ? -1 : 1) * Math.pow(Math.abs(val), exp);
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Structural validity check (length matches the declared component count). */
export function isValidBlurhash(hash: string): boolean {
  if (typeof hash !== 'string' || hash.length < 6) {
    return false;
  }
  const sizeFlag = decode83(hash.charAt(0));
  if (!Number.isFinite(sizeFlag)) {
    return false;
  }
  const numX = (sizeFlag % 9) + 1;
  const numY = Math.floor(sizeFlag / 9) + 1;
  return hash.length === 4 + 2 * numX * numY;
}

export interface DecodedBlurhash {
  cols: number;
  rows: number;
  /** Row-major hex colors, length cols*rows. */
  colors: string[];
}

/**
 * Decode a BlurHash to a `cols`x`rows` grid of hex colors by evaluating the cosine basis at
 * each cell center. Returns null for an invalid hash (caller falls back to a neutral tile).
 */
export function decodeBlurhash(hash: string, cols = 8, rows = 8): DecodedBlurhash | null {
  if (!isValidBlurhash(hash)) {
    return null;
  }
  const sizeFlag = decode83(hash.charAt(0));
  const numX = (sizeFlag % 9) + 1;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const quantisedMax = decode83(hash.charAt(1));
  const maxValue = (quantisedMax + 1) / 166;

  const numColors = numX * numY;
  const components: Array<[number, number, number]> = new Array(numColors);
  for (let i = 0; i < numColors; i++) {
    if (i === 0) {
      const value = decode83(hash.substring(2, 6));
      components[i] = [
        sRGBToLinear(value >> 16),
        sRGBToLinear((value >> 8) & 255),
        sRGBToLinear(value & 255),
      ];
    } else {
      const value = decode83(hash.substring(4 + i * 2, 6 + i * 2));
      const quantR = Math.floor(value / (19 * 19));
      const quantG = Math.floor(value / 19) % 19;
      const quantB = value % 19;
      components[i] = [
        signPow((quantR - 9) / 9, 2) * maxValue,
        signPow((quantG - 9) / 9, 2) * maxValue,
        signPow((quantB - 9) / 9, 2) * maxValue,
      ];
    }
  }

  const colors: string[] = new Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    const posY = (cy + 0.5) / rows;
    for (let cx = 0; cx < cols; cx++) {
      const posX = (cx + 0.5) / cols;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos(Math.PI * posX * i) * Math.cos(Math.PI * posY * j);
          const c = components[i + j * numX]!;
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      colors[cy * cols + cx] = toHex(linearTosRGB(r), linearTosRGB(g), linearTosRGB(b));
    }
  }
  return {cols, rows, colors};
}

/** The single average color (the DC term) — a cheap solid fallback. */
export function averageColor(hash: string): string | null {
  if (!isValidBlurhash(hash)) {
    return null;
  }
  const value = decode83(hash.substring(2, 6));
  return toHex(value >> 16, (value >> 8) & 255, value & 255);
}
