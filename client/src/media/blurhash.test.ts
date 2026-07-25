import {averageColor, decodeBlurhash, isValidBlurhash} from './blurhash';

// Reference vector from the BlurHash project (4x3 components → length 28).
const VALID = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
const HEX = /^#[0-9a-f]{6}$/;

describe('isValidBlurhash', () => {
  it('accepts a well-formed hash', () => {
    expect(isValidBlurhash(VALID)).toBe(true);
  });
  it('rejects too-short or malformed input', () => {
    expect(isValidBlurhash('abc')).toBe(false);
    expect(isValidBlurhash('')).toBe(false);
    expect(isValidBlurhash(VALID.slice(0, -1))).toBe(false); // length mismatch
  });
});

describe('decodeBlurhash', () => {
  it('produces a cols*rows grid of valid hex colors', () => {
    const grid = decodeBlurhash(VALID, 8, 8);
    expect(grid).not.toBeNull();
    expect(grid?.colors).toHaveLength(64);
    for (const c of grid!.colors) {
      expect(c).toMatch(HEX);
    }
  });

  it('honors a custom grid size', () => {
    const grid = decodeBlurhash(VALID, 4, 4);
    expect(grid?.cols).toBe(4);
    expect(grid?.colors).toHaveLength(16);
  });

  it('returns null for an invalid hash', () => {
    expect(decodeBlurhash('nope')).toBeNull();
  });

  it('is deterministic', () => {
    expect(decodeBlurhash(VALID, 4, 4)).toEqual(decodeBlurhash(VALID, 4, 4));
  });
});

describe('averageColor', () => {
  it('returns a valid hex for the DC term', () => {
    expect(averageColor(VALID)).toMatch(HEX);
  });
  it('returns null for invalid input', () => {
    expect(averageColor('nope')).toBeNull();
  });
});
