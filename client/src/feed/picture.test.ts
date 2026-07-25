import {
  packPicture,
  unpackPicture,
  encodeInlinePicture,
  extractInlinePictures,
  decodePicture,
  stripInlinePictures,
  hasInlinePicture,
  inlinePictureSummary,
  base64ByteLength,
  MAX_PICTURE_BYTES,
} from './picture';
import {pixelate, pixelateWithPalette, quantise, quantiseWithPalette, medianCut, transformDownsample, weight, type PixelResult} from './pixelEngine';

/** A tiny synthetic source square (a 4×4 red/blue checker) for deterministic tests. */
function checkerSource(size: number): Uint8Array {
  const src = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const red = (x + y) % 2 === 0;
      src[o] = red ? 220 : 20;
      src[o + 1] = 20;
      src[o + 2] = red ? 20 : 220;
      src[o + 3] = 255;
    }
  }
  return src;
}

function sampleResult(res = 16, colours = 16): PixelResult {
  return pixelate(checkerSource(32), 32, 32, {zoom: 1, panX: 0, panY: 0, rot: 0}, res, colours, 'none');
}

describe('picture token codec', () => {
  it('round-trips a picture through pack/unpack', () => {
    const result = sampleResult(16, 16);
    const raw = packPicture(result, 'ordered');
    const decoded = unpackPicture(raw);
    expect(decoded).not.toBeNull();
    expect(decoded!.res).toBe(16);
    expect(decoded!.colours).toBe(16);
    expect(decoded!.dither).toBe('ordered');
    expect(Array.from(decoded!.indices)).toEqual(Array.from(result.indices));
    expect(decoded!.palette).toEqual(result.palette);
  });

  it('round-trips through the inline body token, preserving the label', () => {
    const result = sampleResult(16, 32);
    const token = encodeInlinePicture(result, 'atkinson', 'Dusk · from the roof');
    const body = `look at this\n\n${token}\n\nnice right?`;
    expect(hasInlinePicture(body)).toBe(true);
    const pics = extractInlinePictures(body);
    expect(pics).toHaveLength(1);
    expect(pics[0]!.label).toBe('Dusk · from the roof');
    expect(pics[0]!.res).toBe(16);
    expect(pics[0]!.colours).toBe(32);
    // Decoding is deferred to tap.
    const decoded = decodePicture(pics[0]!);
    expect(decoded).not.toBeNull();
    expect(decoded!.dither).toBe('atkinson');
    expect(Array.from(decoded!.indices)).toEqual(Array.from(result.indices));
  });

  it('strips tokens from a body and summarises a picture-only body', () => {
    const token = encodeInlinePicture(sampleResult(), 'none', 'roof');
    expect(stripInlinePictures(`hi ${token} bye`).trim()).toBe('hi  bye'.trim());
    expect(inlinePictureSummary(token)).toBe('🖼️ Picture');
    expect(inlinePictureSummary(`caption ${token}`)).toBe('caption');
    expect(inlinePictureSummary('no picture here')).toBe('no picture here');
    // A picture-only body never leaks its base64 into a one-line preview.
    expect(inlinePictureSummary(token).includes('[[pic:')).toBe(false);
  });

  it('extracts multiple pictures in document order', () => {
    const a = encodeInlinePicture(sampleResult(16, 16), 'ordered', 'one');
    const b = encodeInlinePicture(sampleResult(16, 16), 'ordered', 'two');
    const pics = extractInlinePictures(`${a} middle ${b}`);
    expect(pics.map(p => p.label)).toEqual(['one', 'two']);
  });

  it('skips a malformed or oversized token instead of rendering it', () => {
    expect(extractInlinePictures('[[pic:16;16;;????]]')).toHaveLength(0); // not base64
    const huge = 'A'.repeat(MAX_PICTURE_BYTES * 2);
    expect(extractInlinePictures(`[[pic:256;64;;${huge}]]`)).toHaveLength(0);
    expect(unpackPicture(new Uint8Array([1, 2, 3]))).toBeNull(); // bad magic/short
  });

  it('token size tracks weight() closely (allowance gate parity)', () => {
    for (const [res, colours] of [[48, 16], [64, 32], [128, 32], [256, 64]] as const) {
      const token = encodeInlinePicture(sampleResult(res, colours), 'ordered');
      const m = /;([A-Za-z0-9+/=]+)\]\]$/.exec(token)!;
      const b64len = m[1]!.length;
      // weight() predicts the base64 length within base64's 4-char padding granularity.
      expect(Math.abs(b64len - weight(res, colours))).toBeLessThanOrEqual(4);
    }
  });

  it('base64ByteLength matches the decoded length', () => {
    const raw = packPicture(sampleResult(16, 16), 'none');
    const b64 = encodeInlinePicture(sampleResult(16, 16), 'none').match(/;([A-Za-z0-9+/=]+)\]\]$/)![1]!;
    expect(base64ByteLength(b64)).toBe(raw.length);
  });

  it('quantise produces indices within palette bounds', () => {
    const src = checkerSource(32);
    const data = new Uint8ClampedArray(src);
    const r = quantise(data, 32, 16, 'ordered');
    expect(r.palette.length).toBeLessThanOrEqual(16);
    for (const idx of r.indices) expect(idx).toBeLessThan(r.palette.length);
  });

  it('quantiseWithPalette (drag fast path) matches quantise given the same palette', () => {
    // The composer reuses a cached palette during a drag to skip median-cut; that path must produce
    // the SAME indices as the full quantise would for the same palette + data.
    const data = new Uint8ClampedArray(checkerSource(24));
    const pal = medianCut(data, 16);
    const full = quantiseWithPalette(data, 24, pal, 'ordered');
    const viaQuantise = quantise(data, 24, 16, 'ordered'); // its own median-cut = same deterministic pal
    expect(viaQuantise.palette).toEqual(pal);
    expect(Array.from(full.indices)).toEqual(Array.from(viaQuantise.indices));
  });

  it('pans a non-square photo at base zoom (cover-with-pan cropper)', () => {
    // A 2:1 photo, left half red / right half blue. At zoom 1 the square viewport shows a centred
    // square; panning left vs right must reveal DIFFERENT halves → different average colour.
    const w = 64;
    const h = 32;
    const src = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const left = x < w / 2;
        src[o] = left ? 255 : 0;
        src[o + 1] = 0;
        src[o + 2] = left ? 0 : 255;
        src[o + 3] = 255;
      }
    }
    const avg = (t: {zoom: number; panX: number; panY: number; rot: number}): [number, number] => {
      const d = transformDownsample(src, w, h, t, 16, 1);
      let r = 0;
      let b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!;
        b += d[i + 2]!;
      }
      return [r, b];
    };
    const [lr, lb] = avg({zoom: 1, panX: -0.3, panY: 0, rot: 0}); // reveal the (red) left
    const [rr, rb] = avg({zoom: 1, panX: 0.3, panY: 0, rot: 0}); // reveal the (blue) right
    expect(lr).toBeGreaterThan(rr); // more red when panned toward the left half
    expect(rb).toBeGreaterThan(lb); // more blue when panned toward the right half
  });

  it('rotates the framed image (180° flips top↔bottom)', () => {
    // Square photo: top half red, bottom half blue.
    const n = 32;
    const src = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        const top = y < n / 2;
        src[o] = top ? 255 : 0;
        src[o + 2] = top ? 0 : 255;
        src[o + 3] = 255;
      }
    }
    const topRow = (rot: number): number => {
      const d = transformDownsample(src, n, n, {zoom: 1, panX: 0, panY: 0, rot}, 16, 1);
      // average red of the top output row
      let r = 0;
      for (let x = 0; x < 16; x++) r += d[x * 4]!;
      return r;
    };
    expect(topRow(0)).toBeGreaterThan(topRow(2)); // rot 0 → top is red; rot 2 (180°) → top is blue
  });

  it('clamps pan to nothing for a square photo at zoom 1', () => {
    const src = checkerSource(32);
    const a = transformDownsample(src, 32, 32, {zoom: 1, panX: 0, panY: 0, rot: 0}, 16, 1);
    const b = transformDownsample(src, 32, 32, {zoom: 1, panX: 0.4, panY: 0.4, rot: 0}, 16, 1);
    expect(Array.from(b)).toEqual(Array.from(a)); // no overflow → pan clamped to identical crop
  });

  it('pixelateWithPalette produces in-bounds indices', () => {
    const src = checkerSource(48);
    const pal = medianCut(new Uint8ClampedArray(src), 32);
    const r = pixelateWithPalette(src, 48, 48, {zoom: 1, panX: 0, panY: 0, rot: 0}, 32, pal, 'ordered', 1);
    for (const idx of r.indices) expect(idx).toBeLessThan(pal.length);
  });
});
