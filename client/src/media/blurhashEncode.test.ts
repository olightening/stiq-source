import {decodeBlurhash, isValidBlurhash, averageColor} from './blurhash';
import {encodeBlurhash} from './blurhashEncode';

/** Build a width*height RGBA buffer of one solid color. */
function solid(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe('encodeBlurhash', () => {
  it('produces a structurally valid hash', () => {
    const hash = encodeBlurhash(solid(8, 8, 120, 60, 200), 8, 8, 4, 3);
    expect(isValidBlurhash(hash)).toBe(true);
  });

  it('round-trips a solid color to a near-identical average', () => {
    const hash = encodeBlurhash(solid(8, 8, 200, 100, 50), 8, 8, 3, 3);
    const avg = averageColor(hash);
    expect(avg).not.toBeNull();
    // Parse the average hex and check each channel is within tolerance of the input.
    const m = /^#(..)(..)(..)$/.exec(avg!)!;
    const [r, g, b] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
    expect(Math.abs(r - 200)).toBeLessThan(12);
    expect(Math.abs(g - 100)).toBeLessThan(12);
    expect(Math.abs(b - 50)).toBeLessThan(12);
  });

  it('decodes back to a usable grid', () => {
    const hash = encodeBlurhash(solid(6, 6, 30, 180, 90), 6, 6, 4, 3);
    const grid = decodeBlurhash(hash, 4, 4);
    expect(grid?.colors).toHaveLength(16);
  });

  it('rejects bad component counts and mismatched buffers', () => {
    expect(() => encodeBlurhash(solid(2, 2, 0, 0, 0), 2, 2, 0, 3)).toThrow();
    expect(() => encodeBlurhash(new Uint8Array(3), 2, 2)).toThrow();
  });
});
