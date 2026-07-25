import {bytesToHex, hexToBytes} from './hex';

describe('hex', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255, 128]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    expect(bytesToHex(new Uint8Array([0, 255]))).toBe('00ff');
  });

  it('throws on malformed hex', () => {
    expect(() => hexToBytes('abc')).toThrow(); // odd length
    expect(() => hexToBytes('zz')).toThrow(); // non-hex
  });
});
