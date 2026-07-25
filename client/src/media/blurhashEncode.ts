/* eslint-disable no-bitwise -- BlurHash encoding is inherently bit manipulation */
/**
 * Pure-JS BlurHash encoder — used on the OUTBOUND path (Tier 3) so a poster's image carries a
 * compact, leak-free preview (NIP-94 `imeta` `blurhash`) that every reader decodes locally.
 *
 * Input is an RGBA pixel buffer of a small thumbnail (the native StiqImage sanitizer returns
 * one). Inverse of decodeBlurhash in ./blurhash. Algorithm per the BlurHash reference.
 */

const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / Math.pow(83, length - i)) % 83;
    out += DIGITS[digit];
  }
  return out;
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

function encodeDC(r: number, g: number, b: number): number {
  return (linearTosRGB(r) << 16) + (linearTosRGB(g) << 8) + linearTosRGB(b);
}

function encodeAC(r: number, g: number, b: number, maximumValue: number): number {
  const quant = (v: number): number =>
    Math.max(0, Math.min(18, Math.floor(signPow(v / maximumValue, 0.5) * 9 + 9.5)));
  return quant(r) * 19 * 19 + quant(g) * 19 + quant(b);
}

/**
 * Encode an RGBA buffer to a BlurHash. `componentX`/`componentY` (1-9) control detail.
 * Throws on bad component counts or a buffer that doesn't match width*height*4.
 */
export function encodeBlurhash(
  rgba: Uint8Array | number[],
  width: number,
  height: number,
  componentX = 4,
  componentY = 3,
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new Error('blurhash components must be 1..9');
  }
  if (rgba.length !== width * height * 4) {
    throw new Error('rgba length does not match width*height*4');
  }

  const factors: Array<[number, number, number]> = [];
  for (let y = 0; y < componentY; y++) {
    for (let x = 0; x < componentX; x++) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++) {
          const basis =
            normalisation *
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const idx = 4 * (i + j * width);
          r += basis * sRGBToLinear(rgba[idx] ?? 0);
          g += basis * sRGBToLinear(rgba[idx + 1] ?? 0);
          b += basis * sRGBToLinear(rgba[idx + 2] ?? 0);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc: [number, number, number] = factors[0] ?? [0, 0, 0];
  const ac = factors.slice(1);

  let hash = '';
  const sizeFlag = componentX - 1 + (componentY - 1) * 9;
  hash += encode83(sizeFlag, 1);

  let maximumValue: number;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.map(f => Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]))));
    const quantisedMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
    maximumValue = (quantisedMax + 1) / 166;
    hash += encode83(quantisedMax, 1);
  } else {
    maximumValue = 1;
    hash += encode83(0, 1);
  }

  hash += encode83(encodeDC(dc[0], dc[1], dc[2]), 4);
  for (const f of ac) {
    hash += encode83(encodeAC(f[0], f[1], f[2], maximumValue), 2);
  }
  return hash;
}
