/* eslint-disable no-bitwise -- palette packing / dither thresholds are bit & index math */
/**
 * Stiq Pictures pixel engine — a pure-JS (Hermes-safe) port of the design's PixelEngine.
 *
 * The reference (design_handoff_pictures/stiq-pixel-engine.js) is HTML-canvas based, but only two
 * steps actually need a canvas: getting RGBA pixels IN and painting them OUT. Everything between —
 * median-cut palette reduction, the four dither modes, and `weight()` — is pure integer/float math
 * and is ported here verbatim so a picture pixelates identically on device.
 *
 *   RGBA source square (from the native decoder) → transform (zoom/pan/rotate) + downsample to
 *   res×res → median-cut to N colours → dither → { palette, indices }.
 *
 * The RGBA-in step is replaced by `transformDownsample` (samples a cached source buffer instead of
 * a canvas); the paint-out step lives in media/png.ts. `weight(res,colours)` reproduces the frozen
 * spec's token-size table byte-for-byte, so the composer's allowance gate and the actual encoded
 * token can never disagree.
 */

export const RES = [48, 64, 96, 128, 256] as const;
export const COLOURS = [16, 32, 64] as const;

export type Dither = 'ordered' | 'diffusion' | 'atkinson' | 'halftone' | 'none';
export const DITHERS: Dither[] = ['ordered', 'diffusion', 'atkinson', 'halftone', 'none'];
/** Friendly readout name for each dither mode (matches the design's segmented control). */
export const DITHER_NAME: Record<Dither, string> = {
  ordered: 'Bayer 8×8',
  diffusion: 'Floyd–Steinberg',
  atkinson: 'Atkinson',
  halftone: 'Clustered dot',
  none: 'None',
};

/** Crop/frame transform. `rot` is in 90° steps (0..3); pan is a fraction of the viewport. */
export interface Transform {
  zoom: number;
  panX: number;
  panY: number;
  rot: number;
}

export const IDENTITY_TRANSFORM: Transform = {zoom: 1, panX: 0, panY: 0, rot: 0};

export interface PixelResult {
  res: number;
  colours: number;
  /** N palette entries, each an [r,g,b] triple (0..255). */
  palette: number[][];
  /** res*res palette indices, row-major. */
  indices: Uint8Array;
}

// ── weight (token byte count) — reproduces the frozen spec's §7 worst-case table ──────────────────
/** Bits needed to index a palette of `colours` entries (16→4, 32→5, 64→6). */
export function bitsPerIndex(colours: number): number {
  return Math.max(1, Math.ceil(Math.log2(colours)));
}

/**
 * Byte size of the transmitted base64 token for a res×colours picture. Header(7) + palette(colours*3)
 * + packed indices(ceil(res²·bpi/8)), then ×4/3 for base64 expansion. Depends ONLY on res+colours —
 * dither never changes the byte size.
 */
export function weight(res: number, colours: number): number {
  const bpi = bitsPerIndex(colours);
  const raw = 7 + colours * 3 + Math.ceil((res * res * bpi) / 8);
  return Math.round((raw * 4) / 3);
}

/** Human size string, e.g. "13.5 KB". */
export function fmtKB(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// ── transform + downsample: sample a cached RGBA source square into a res×res RGBA buffer ─────────
//
// Replaces the design's drawSquare→getImageData. `src` is the FULL photo as a srcW×srcH RGBA buffer
// (the native decoder scales the whole photo down, no crop — the framing happens here). It's a real
// cover-with-pan cropper: at zoom 1 the square viewport shows a centred square that COVERS (the
// photo's shorter side fills), and pan (`panX`/`panY`, a fraction of the photo) slides that square
// along the overflowing longer axis; zoom tightens the viewport further. `supersample` averages an
// N×N footprint for a cheap area-downsample (N=1 is the fast path used during live dragging).
export function transformDownsample(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  t: Transform,
  res: number,
  supersample = 2,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(res * res * 4);
  const zoom = t.zoom > 0 ? t.zoom : 1;
  const theta = ((((t.rot % 4) + 4) % 4) * Math.PI) / 2;
  const cos = Math.round(Math.cos(theta));
  const sin = Math.round(Math.sin(theta));
  // Visible source square side (source px): shorter side at zoom 1, tighter as you zoom in.
  const visSide = Math.min(srcW, srcH) / zoom;
  const halfV = visSide / 2;
  // Viewport centre in source px, driven by pan (a fraction of the photo), clamped so the square
  // stays inside the photo — this is what lets you slide along the overflowing axis at zoom 1.
  const cx = Math.max(halfV, Math.min(srcW - halfV, srcW / 2 + t.panX * srcW));
  const cy = Math.max(halfV, Math.min(srcH - halfV, srcH / 2 + t.panY * srcH));
  // Supersample count: `supersample <= 0` means AUTO — pick ~one sample per source pixel the output
  // pixel covers (visSide/res), capped, so a large downsample is properly area-averaged instead of
  // point-sampled (which aliases into a noisy/degraded pixel-art). Callers pass 1 for the fast drag
  // path and 0 (auto) for the settled/final render.
  const n =
    supersample <= 0
      ? Math.max(1, Math.min(4, Math.round(visSide / res)))
      : Math.max(1, Math.floor(supersample));
  const step = 1 / n;
  for (let oy = 0; oy < res; oy++) {
    for (let ox = 0; ox < res; ox++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let hit = 0;
      for (let syi = 0; syi < n; syi++) {
        for (let sxi = 0; sxi < n; sxi++) {
          // Normalised offset within the viewport square: -0.5 … +0.5.
          const nu = (ox + (sxi + 0.5) * step) / res - 0.5;
          const nv = (oy + (syi + 0.5) * step) / res - 0.5;
          // Rotate the sample offset (90° steps), then map into source px.
          const ru = cos * nu - sin * nv;
          const rv = sin * nu + cos * nv;
          const sxp = cx + ru * visSide;
          const syp = cy + rv * visSide;
          if (sxp < 0 || sxp >= srcW || syp < 0 || syp >= srcH) continue; // outside → black
          const so = ((syp | 0) * srcW + (sxp | 0)) * 4;
          ar += src[so]!;
          ag += src[so + 1]!;
          ab += src[so + 2]!;
          hit++;
        }
      }
      const o = (oy * res + ox) * 4;
      if (hit > 0) {
        out[o] = ar / hit;
        out[o + 1] = ag / hit;
        out[o + 2] = ab / hit;
      }
      out[o + 3] = 255; // pictures are opaque
    }
  }
  return out;
}

// ── median-cut palette (ported verbatim) ──────────────────────────────────────────────────────────
function chanRange(box: number[][]): {range: number; ch: number} {
  const mn = [255, 255, 255];
  const mx = [0, 0, 0];
  for (let j = 0; j < box.length; j++) {
    for (let c = 0; c < 3; c++) {
      const v = box[j]![c]!;
      if (v < mn[c]!) mn[c] = v;
      if (v > mx[c]!) mx[c] = v;
    }
  }
  const dr = mx[0]! - mn[0]!;
  const dg = mx[1]! - mn[1]!;
  const db = mx[2]! - mn[2]!;
  const m = Math.max(dr, dg, db);
  return {range: m, ch: m === dr ? 0 : m === dg ? 1 : 2};
}

export function medianCut(data: Uint8ClampedArray | Uint8Array, want: number): number[][] {
  const px: number[][] = [];
  for (let i = 0; i < data.length; i += 4) px.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  if (px.length === 0) return [[0, 0, 0]];
  let boxes: number[][][] = [px];
  while (boxes.length < want) {
    let bi = 0;
    let brange = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.length < 2) continue;
      const r = chanRange(boxes[i]!);
      if (r.range > brange) {
        brange = r.range;
        bi = i;
      }
    }
    if (brange < 0) break;
    const box = boxes[bi]!;
    const ch = chanRange(box).ch;
    box.sort((a, b) => a[ch]! - b[ch]!);
    const mid = box.length >> 1;
    boxes = [...boxes.slice(0, bi), box.slice(0, mid), box.slice(mid), ...boxes.slice(bi + 1)];
  }
  return boxes.map(b => {
    let r = 0;
    let g = 0;
    let bl = 0;
    const nn = b.length;
    for (let j = 0; j < nn; j++) {
      r += b[j]![0]!;
      g += b[j]![1]!;
      bl += b[j]![2]!;
    }
    return [Math.round(r / nn), Math.round(g / nn), Math.round(bl / nn)];
  });
}

// ── dither matrices + nearest-colour ──────────────────────────────────────────────────────────────
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
const CLUSTER4 = [
  [12, 5, 6, 13],
  [4, 0, 1, 7],
  [11, 3, 2, 8],
  [15, 10, 9, 14],
];

function nearest(pal: number[][], r: number, g: number, b: number): number {
  let bi = 0;
  let bd = 1e12;
  for (let i = 0; i < pal.length; i++) {
    const dr = pal[i]![0]! - r;
    const dg = pal[i]![1]! - g;
    const db = pal[i]![2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}

function diffuse(buf: Float32Array, res: number, x: number, y: number, er: number, eg: number, eb: number, f: number): void {
  if (x < 0 || x >= res || y < 0 || y >= res) return;
  const k = (y * res + x) * 3;
  buf[k]! += er * f;
  buf[k + 1]! += eg * f;
  buf[k + 2]! += eb * f;
}

/**
 * Reduce a res×res RGBA buffer to `colours` via median-cut, then dither. Ported verbatim from the
 * reference `pixelate()` minus the canvas draw/read. Returns the palette + per-pixel indices.
 */
export function quantise(data: Uint8ClampedArray | Uint8Array, res: number, colours: number, mode: Dither): PixelResult {
  return quantiseWithPalette(data, res, medianCut(data, colours), mode);
}

/**
 * Dither a res×res RGBA buffer against a PROVIDED palette (skips median-cut). Used on the composer's
 * interactive path: during a pan/zoom gesture we reuse the palette from the last settled render, so
 * every drag frame avoids the costly median-cut and only re-maps pixels. The palette is refreshed
 * when the gesture settles or a control changes.
 */
export function quantiseWithPalette(data: Uint8ClampedArray | Uint8Array, res: number, pal: number[][], mode: Dither): PixelResult {
  const colours = pal.length;
  const idx = new Uint8Array(res * res);
  let x: number;
  let y: number;
  if (mode === 'diffusion' || mode === 'atkinson') {
    const atk = mode === 'atkinson';
    const buf = new Float32Array(res * res * 3);
    for (let i = 0, k = 0; i < data.length; i += 4, k += 3) {
      buf[k] = data[i]!;
      buf[k + 1] = data[i + 1]!;
      buf[k + 2] = data[i + 2]!;
    }
    for (y = 0; y < res; y++) {
      for (x = 0; x < res; x++) {
        const p = (y * res + x) * 3;
        const r = buf[p]!;
        const g = buf[p + 1]!;
        const b = buf[p + 2]!;
        const bi = nearest(pal, r, g, b);
        idx[y * res + x] = bi;
        const er = r - pal[bi]![0]!;
        const eg = g - pal[bi]![1]!;
        const eb = b - pal[bi]![2]!;
        if (atk) {
          const qf = 1 / 8;
          diffuse(buf, res, x + 1, y, er, eg, eb, qf);
          diffuse(buf, res, x + 2, y, er, eg, eb, qf);
          diffuse(buf, res, x - 1, y + 1, er, eg, eb, qf);
          diffuse(buf, res, x, y + 1, er, eg, eb, qf);
          diffuse(buf, res, x + 1, y + 1, er, eg, eb, qf);
          diffuse(buf, res, x, y + 2, er, eg, eb, qf);
        } else {
          diffuse(buf, res, x + 1, y, er, eg, eb, 7 / 16);
          diffuse(buf, res, x - 1, y + 1, er, eg, eb, 3 / 16);
          diffuse(buf, res, x, y + 1, er, eg, eb, 5 / 16);
          diffuse(buf, res, x + 1, y + 1, er, eg, eb, 1 / 16);
        }
      }
    }
  } else if (mode === 'ordered') {
    const spread = 150 / Math.cbrt(colours);
    for (y = 0; y < res; y++) {
      for (x = 0; x < res; x++) {
        const oo = (y * res + x) * 4;
        const thr = (BAYER8[y & 7]![x & 7]! / 64 - 0.5) * spread;
        idx[y * res + x] = nearest(pal, data[oo]! + thr, data[oo + 1]! + thr, data[oo + 2]! + thr);
      }
    }
  } else if (mode === 'halftone') {
    const hspread = 150 / Math.cbrt(colours);
    for (y = 0; y < res; y++) {
      for (x = 0; x < res; x++) {
        const oh = (y * res + x) * 4;
        const th = (CLUSTER4[y & 3]![x & 3]! / 16 - 0.5) * hspread;
        idx[y * res + x] = nearest(pal, data[oh]! + th, data[oh + 1]! + th, data[oh + 2]! + th);
      }
    }
  } else {
    for (y = 0; y < res; y++) {
      for (x = 0; x < res; x++) {
        const on = (y * res + x) * 4;
        idx[y * res + x] = nearest(pal, data[on]!, data[on + 1]!, data[on + 2]!);
      }
    }
  }
  return {res, colours, palette: pal, indices: idx};
}

/** Full pipeline: full photo RGBA → framed, downsampled, quantised, dithered indexed image. */
export function pixelate(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  t: Transform,
  res: number,
  colours: number,
  mode: Dither,
  supersample = 2,
): PixelResult {
  const data = transformDownsample(src, srcW, srcH, t, res, supersample);
  return quantise(data, res, colours, mode);
}

/** Like `pixelate` but against a fixed palette (skips median-cut) — the interactive drag fast path. */
export function pixelateWithPalette(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  t: Transform,
  res: number,
  pal: number[][],
  mode: Dither,
  supersample = 1,
): PixelResult {
  const data = transformDownsample(src, srcW, srcH, t, res, supersample);
  return quantiseWithPalette(data, res, pal, mode);
}
