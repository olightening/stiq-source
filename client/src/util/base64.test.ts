import {bytesToBase64, base64ToBytes} from './base64';

describe('base64', () => {
  it('matches known vectors (StdEncoding)', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([102]))).toBe('Zg==');
    expect(bytesToBase64(new Uint8Array([102, 111]))).toBe('Zm8=');
    expect(bytesToBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    // 'foobar' — exercises multiple groups + trailing remainder
    expect(bytesToBase64(new Uint8Array([102, 111, 111, 98, 97, 114]))).toBe('Zm9vYmFy');
  });

  it('decodes known vectors back to bytes', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array([]));
    expect(base64ToBytes('Zg==')).toEqual(new Uint8Array([102]));
    expect(base64ToBytes('Zm8=')).toEqual(new Uint8Array([102, 111]));
    expect(base64ToBytes('Zm9v')).toEqual(new Uint8Array([102, 111, 111]));
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips every 1/2/3-byte remainder length', () => {
    for (let len = 0; len <= 9; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = (i * 37 + 11) & 0xff;
      }
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('covers all 64 alphabet symbols (incl + and /)', () => {
    // 0xFB,0xF0 -> "+/..." territory; sweep all byte values through a round-trip
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }
    const encoded = bytesToBase64(bytes);
    expect(base64ToBytes(encoded)).toEqual(bytes);
    // sanity: encoding of 0xFB,0xFF,0xBF hits '+' and '/'
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('+/+/');
  });

  it('round-trips a large input (chunk-boundary smoke test)', () => {
    const bytes = new Uint8Array(50000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (i * 131 + 7) & 0xff;
    }
    const encoded = bytesToBase64(bytes);
    expect(encoded.length % 4).toBe(0);
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  it('throws on invalid input', () => {
    expect(() => base64ToBytes('not*base64')).toThrow('invalid base64');
  });

  it('throws on whitespace and newlines (not silently skipped)', () => {
    expect(() => base64ToBytes('Zm 9v')).toThrow('invalid base64');
    expect(() => base64ToBytes('Zm9v\n')).toThrow('invalid base64');
  });

  it('throws on non-ASCII / astral chars (>255 code units)', () => {
    expect(() => base64ToBytes('Zm9𝕒')).toThrow('invalid base64');
    expect(() => base64ToBytes('Zm9é')).toThrow('invalid base64');
  });

  it('strips only trailing padding, rejects embedded padding', () => {
    expect(base64ToBytes('Zg==')).toEqual(new Uint8Array([102]));
    // '=' in the middle is not stripped by /=+$/ and is not an alphabet char -> throw
    expect(() => base64ToBytes('Z=g=')).toThrow('invalid base64');
  });
});
