import {encodeRgbPng, encodeIndexedPng, indexedPngDataUri} from './png';

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function readChunks(bytes: Uint8Array): {type: string; length: number}[] {
  const out: {type: string; length: number}[] = [];
  let i = 8;
  while (i < bytes.length) {
    const len = (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!;
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    out.push({type, length: len >>> 0});
    i += 12 + (len >>> 0);
  }
  return out;
}

describe('pure-JS PNG encoder', () => {
  it('emits a valid PNG structure (sig + IHDR + IDAT + IEND)', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2×2
    const png = encodeRgbPng(rgb, 2, 2);
    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIG);
    const chunks = readChunks(png);
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[0]!.length).toBe(13); // IHDR is always 13 bytes
  });

  it('encodes an IHDR carrying the right dimensions + colour type 2 (RGB)', () => {
    const png = encodeRgbPng(new Uint8Array(3 * 3 * 3), 3, 3);
    // IHDR data starts at offset 8 (sig) + 4 (len) + 4 (type) = 16.
    const w = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
    const h = (png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!;
    expect(w).toBe(3);
    expect(h).toBe(3);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // colour type: truecolour
  });

  it('integer-upscales an indexed image (crisp big pixels)', () => {
    const palette = [
      [10, 20, 30],
      [200, 100, 50],
    ];
    const indices = new Uint8Array([0, 1, 1, 0]); // 2×2
    const png = encodeIndexedPng(indices, palette, 2, 4); // ×4 → 8×8
    const w = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
    expect(w).toBe(8);
  });

  it('produces a data URI ready for <Image source>', () => {
    const uri = indexedPngDataUri(new Uint8Array([0]), [[0, 0, 0]], 1, 1);
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('handles a stored-DEFLATE block boundary (>65535 raw bytes)', () => {
    // A 160×160 image: raw scanlines = 160*(160*3+1) = 77,120 bytes > one 0xFFFF stored block.
    const png = encodeRgbPng(new Uint8Array(160 * 160 * 3), 160, 160);
    const chunks = readChunks(png);
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    // A well-formed multi-block stream still terminates in a valid IEND.
    expect(chunks[chunks.length - 1]!.type).toBe('IEND');
  });
});
