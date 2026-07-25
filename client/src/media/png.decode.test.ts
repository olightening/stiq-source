import zlib from 'zlib';
import {encodeIndexedPng} from './png';

/** Concatenate the IDAT payload of a PNG. */
function idat(png: Uint8Array): Buffer {
  let i = 8;
  const parts: Buffer[] = [];
  while (i < png.length) {
    const len = ((png[i]! << 24) | (png[i + 1]! << 16) | (png[i + 2]! << 8) | png[i + 3]!) >>> 0;
    const type = String.fromCharCode(png[i + 4]!, png[i + 5]!, png[i + 6]!, png[i + 7]!);
    if (type === 'IDAT') parts.push(Buffer.from(png.subarray(i + 8, i + 8 + len)));
    i += 12 + len;
  }
  return Buffer.concat(parts);
}

describe('PNG is decodable by a real zlib/PNG decoder', () => {
  it('inflates the stored-DEFLATE IDAT to correct upscaled scanlines', () => {
    const palette = [
      [10, 20, 30],
      [200, 100, 50],
      [0, 0, 0],
      [5, 5, 5],
    ];
    const indices = new Uint8Array([0, 1, 2, 3]); // 2×2 (res=2)
    const scale = 3;
    const png = encodeIndexedPng(indices, palette, 2, scale); // → 6×6 RGB
    const raw = zlib.inflateSync(idat(png)); // MUST not throw: valid zlib header + Adler-32
    const W = 2 * scale; // 6
    const H = 2 * scale; // 6
    const stride = W * 3;
    expect(raw.length).toBe(H * (stride + 1));
    // Row 0, col 0 = palette[0]; a filter byte precedes each scanline.
    expect(raw[0]).toBe(0);
    expect([raw[1], raw[2], raw[3]]).toEqual([10, 20, 30]);
    // Row 0, col `scale` = start of source col 1 = palette[1].
    const c1 = 1 + scale * 3;
    expect([raw[c1], raw[c1 + 1], raw[c1 + 2]]).toEqual([200, 100, 50]);
    // Row `scale` (start of source row 1), col 0 = palette[2].
    const r1 = scale * (stride + 1) + 1;
    expect([raw[r1], raw[r1 + 1], raw[r1 + 2]]).toEqual([0, 0, 0]);
  });
});
