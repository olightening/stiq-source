import {prefixesOf, evaluateMatches, relayHttpBase} from './check';
import {fullHashes} from './url';

describe('safe browsing — check helpers', () => {
  it('derives unique 4-byte (8-hex) prefixes', () => {
    const full = ['aabbccdd1111', 'aabbccdd2222', '00112233ffff'];
    expect(prefixesOf(full)).toEqual(['aabbccdd', '00112233']);
  });

  it('flags only when a returned hash is actually a hash of this URL', () => {
    const full = fullHashes('http://malware.test/bad');
    // relay returns one matching hash and one unrelated hash
    const verdict = evaluateMatches(full, [
      {hash: full[0]!.toUpperCase(), threatType: 'MALWARE'},
      {hash: 'deadbeef'.repeat(8), threatType: 'SOCIAL_ENGINEERING'},
    ]);
    expect(verdict).toEqual({checked: true, flagged: true, threatTypes: ['MALWARE']});
  });

  it('does not flag when no returned hash matches', () => {
    const full = fullHashes('http://good.test/ok');
    const verdict = evaluateMatches(full, [{hash: 'a'.repeat(64), threatType: 'MALWARE'}]);
    expect(verdict).toEqual({checked: true, flagged: false, threatTypes: []});
  });

  it('derives the relay http base from a ws onion url', () => {
    expect(relayHttpBase('ws://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/')).toBe(
      'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion',
    );
    expect(relayHttpBase('wss://relay.onion:443/path')).toBe('http://relay.onion:443');
    expect(relayHttpBase('not a url')).toBeNull();
  });
});
