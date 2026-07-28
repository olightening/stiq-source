/**
 * Pure mapper validity matrix for the Arti restricted-discovery client-auth (T17-S4).
 * Mirrors the onionAuth.test.ts style and reuses the SAME fixtures, proving the Arti mapper
 * accepts/rejects exactly what the C-tor validators do — just in Arti's KeyMgr shape.
 */
import {artiClientAuthEntry} from './onionAuthArti';

const HOST = 'a'.repeat(56); // stand-in v3 onion host (56 base32 chars)
const KEY = 'A'.repeat(52); // stand-in x25519 key (52 base32 chars)

describe('artiClientAuthEntry', () => {
  it('maps a valid bare host + key to the Arti KeyMgr entry shape', () => {
    expect(artiClientAuthEntry(HOST, KEY)).toEqual({
      onionHost: HOST,
      privKeyBase32: KEY,
    });
  });

  it('accepts a full relay URL for the host and normalizes it via onionHostOf', () => {
    expect(artiClientAuthEntry(`ws://${HOST}.onion/`, KEY)).toEqual({
      onionHost: HOST,
      privKeyBase32: KEY,
    });
    expect(artiClientAuthEntry(`ws://${HOST}.onion:80/path`, KEY)).toEqual({
      onionHost: HOST,
      privKeyBase32: KEY,
    });
  });

  it('returns null for a malformed key (reusing isValidAuthKeyBase32)', () => {
    expect(artiClientAuthEntry(HOST, 'bad')).toBeNull();
    expect(artiClientAuthEntry(HOST, 'A'.repeat(51))).toBeNull(); // too short
    expect(artiClientAuthEntry(HOST, 'a'.repeat(52))).toBeNull(); // lowercase not allowed
    expect(artiClientAuthEntry(HOST, 'A'.repeat(50) + '01')).toBeNull(); // 0/1 not base32
  });

  it('returns null for a non-v3-onion / malformed host (reusing onionHostOf)', () => {
    expect(artiClientAuthEntry('ws://example.com', KEY)).toBeNull();
    expect(artiClientAuthEntry('a'.repeat(40), KEY)).toBeNull(); // wrong length bare host
    expect(artiClientAuthEntry('', KEY)).toBeNull();
  });
});
