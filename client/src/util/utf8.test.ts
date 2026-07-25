import {utf8Decode, utf8Encode} from './utf8';

const enc = (s: string) => Array.from(utf8Encode(s));

describe('utf8Encode', () => {
  it('encodes ASCII, 2-byte, 3-byte, and 4-byte code points', () => {
    expect(enc('A')).toEqual([0x41]);
    expect(enc('é')).toEqual([0xc3, 0xa9]); // U+00E9
    expect(enc('€')).toEqual([0xe2, 0x82, 0xac]); // U+20AC
    expect(enc('😀')).toEqual([0xf0, 0x9f, 0x98, 0x80]); // U+1F600 (surrogate pair in)
  });

  it('encodes empty string', () => {
    expect(enc('')).toEqual([]);
  });
});

describe('utf8Decode', () => {
  it('decodes empty input', () => {
    expect(utf8Decode(new Uint8Array([]))).toBe('');
  });

  it('decodes ASCII', () => {
    expect(utf8Decode(new Uint8Array([72, 105]))).toBe('Hi');
  });

  it('decodes 2/3/4-byte sequences (incl surrogate-pair output)', () => {
    expect(utf8Decode(new Uint8Array([0xc3, 0xa9]))).toBe('é');
    expect(utf8Decode(new Uint8Array([0xe2, 0x82, 0xac]))).toBe('€');
    expect(utf8Decode(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]))).toBe('😀');
  });

  it('round-trips a mixed multilingual string', () => {
    const s = 'Hello, мир! 世界 😀 café — ναι';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });

  it('round-trips every encode output', () => {
    const samples = ['', 'a', 'ab', 'abc', 'abcd', 'é', 'aé', '€x', '😀😀', '🇬🇧flag'];
    for (const s of samples) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });

  // --- Malformed-input characterization (behavior must be preserved exactly) ---

  it('emits U+FFFD for a lone continuation byte and advances one byte', () => {
    // 0x80 is not a valid lead -> else branch -> replacement; trailing 'A' still decodes
    expect(utf8Decode(new Uint8Array([0x80, 0x41]))).toBe('�A');
  });

  it('emits U+FFFD for a truncated 2-byte sequence at end of input', () => {
    // lead 0xC3 with no following byte (i === n) -> else -> replacement
    expect(utf8Decode(new Uint8Array([0xc3]))).toBe('�');
  });

  it('emits U+FFFD for a truncated 3-byte sequence at end of input', () => {
    // lead 0xE2 needs i+1<n; only one byte follows -> else -> replacement, then 0x82 also stray
    expect(utf8Decode(new Uint8Array([0xe2, 0x82]))).toBe('��');
  });

  it('emits U+FFFD for a truncated 4-byte sequence at end of input', () => {
    // lead 0xF0 needs i+2<n; two bytes follow -> else -> replacement, then two strays
    expect(utf8Decode(new Uint8Array([0xf0, 0x9f, 0x98]))).toBe('���');
  });

  it('does not validate continuation bytes (masks whatever follows, as before)', () => {
    // 0xC3 followed by ASCII 0x41: original masks it as a continuation -> ((0x03<<6)|(0x41&0x3f))
    const cp = ((0xc3 & 0x1f) << 6) | (0x41 & 0x3f);
    expect(utf8Decode(new Uint8Array([0xc3, 0x41]))).toBe(String.fromCharCode(cp));
  });

  it('smoke: large input decodes without O(n^2) freeze and stays correct', () => {
    const unit = utf8Encode('héllo😀 ');
    const parts: number[] = [];
    for (let i = 0; i < 20000; i++) {
      parts.push(...unit);
    }
    const bytes = new Uint8Array(parts);
    const decoded = utf8Decode(bytes);
    expect(decoded).toBe('héllo😀 '.repeat(20000));
  });

  it('chunk boundary does not split a surrogate pair or drop units', () => {
    // Fill just past the 8192 code-unit chunk boundary with emoji (2 units each) so a pair
    // straddles the flush point.
    const s = '😀'.repeat(9000);
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});
