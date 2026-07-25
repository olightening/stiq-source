import {TOR_MIN_SUPPORTED_VERSION, parseTorVersion, torVersionAtLeast} from './torVersion';

describe('parseTorVersion', () => {
  it('parses a 4-segment tor version into numeric components', () => {
    expect(parseTorVersion('0.4.8.22')).toEqual([0, 4, 8, 22]);
  });

  it('parses a 3-segment version', () => {
    expect(parseTorVersion('0.4.8')).toEqual([0, 4, 8]);
  });

  it('returns null for fewer than 3 segments', () => {
    expect(parseTorVersion('0.4')).toBeNull();
    expect(parseTorVersion('1')).toBeNull();
  });

  it('returns null when any segment is non-numeric', () => {
    expect(parseTorVersion('garbage')).toBeNull();
    expect(parseTorVersion('0.4.x')).toBeNull();
    expect(parseTorVersion('0.4.8-rc')).toBeNull();
    expect(parseTorVersion('')).toBeNull();
  });
});

describe('torVersionAtLeast', () => {
  it('accepts the shipped 0.4.8.22 daemon against the 0.4.8 minimum', () => {
    expect(torVersionAtLeast('0.4.8.22', TOR_MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it('rejects the EOL 0.4.6.10 daemon', () => {
    expect(torVersionAtLeast('0.4.6.10', '0.4.8')).toBe(false);
  });

  it('treats an exact match as satisfying the minimum', () => {
    expect(torVersionAtLeast('0.4.8', '0.4.8')).toBe(true);
  });

  it('accepts a higher major/minor', () => {
    expect(torVersionAtLeast('0.5.0', '0.4.8')).toBe(true);
    expect(torVersionAtLeast('0.4.9.11', '0.4.8')).toBe(true);
  });

  it('compares component-wise with missing trailing components treated as 0', () => {
    // 0.4.8 == 0.4.8.0, so it is NOT below 0.4.8.0
    expect(torVersionAtLeast('0.4.8', '0.4.8.0')).toBe(true);
    // 0.4.8 (i.e. 0.4.8.0) IS below 0.4.8.1
    expect(torVersionAtLeast('0.4.8', '0.4.8.1')).toBe(false);
  });

  it('fails open when the actual version is unparseable (no warn-spam on odd strings)', () => {
    expect(torVersionAtLeast('garbage', '0.4.8')).toBe(true);
    expect(torVersionAtLeast('', '0.4.8')).toBe(true);
  });

  it('fails open when the minimum is unparseable', () => {
    expect(torVersionAtLeast('0.4.8.22', 'nonsense')).toBe(true);
  });
});
