import {nip19} from 'nostr-tools';
import {safeNpubEncode, shortenNpub} from './npub';

describe('safeNpubEncode', () => {
  it('encodes a valid 32-byte hex pubkey to npub', () => {
    const hex = '0'.repeat(64);
    expect(safeNpubEncode(hex)).toBe(nip19.npubEncode(hex));
    expect(safeNpubEncode(hex).startsWith('npub1')).toBe(true);
  });
  it('falls back to the raw input on malformed hex', () => {
    expect(safeNpubEncode('not-hex')).toBe('not-hex');
    expect(safeNpubEncode('xyz')).toBe('xyz');
  });
});

describe('shortenNpub', () => {
  const N = 'npub1abcdefghijklmnopqrstuvwxyz0123456789';

  it('defaults to lead 8 / tail 3 (channel author chips)', () => {
    expect(shortenNpub(N)).toBe(`${N.slice(0, 8)}…${N.slice(-3)}`);
  });

  it('honours each per-surface lead/tail exactly', () => {
    expect(shortenNpub(N, {lead: 8, tail: 4})).toBe(`${N.slice(0, 8)}…${N.slice(-4)}`);
    expect(shortenNpub(N, {lead: 10, tail: 4})).toBe(`${N.slice(0, 10)}…${N.slice(-4)}`);
    expect(shortenNpub(N, {lead: 10, tail: 8})).toBe(`${N.slice(0, 10)}…${N.slice(-8)}`);
    expect(shortenNpub(N, {lead: 11, tail: 3})).toBe(`${N.slice(0, 11)}…${N.slice(-3)}`);
    expect(shortenNpub(N, {lead: 12, tail: 4})).toBe(`${N.slice(0, 12)}…${N.slice(-4)}`);
  });

  it("tail 0 yields a 'lead…' form with no trailing slice (Settings/RefEmbed)", () => {
    expect(shortenNpub(N, {lead: 20, tail: 0})).toBe(`${N.slice(0, 20)}…`);
    expect(shortenNpub(N, {lead: 10, tail: 0})).toBe(`${N.slice(0, 10)}…`);
  });

  it('minLen returns short strings unshortened (list-row guards)', () => {
    expect(shortenNpub('short', {lead: 12, tail: 4, minLen: 16})).toBe('short');
    expect(shortenNpub('short', {lead: 10, tail: 8, minLen: 24})).toBe('short');
    // exactly minLen is still returned unchanged
    expect(shortenNpub('x'.repeat(16), {lead: 12, tail: 4, minLen: 16})).toBe('x'.repeat(16));
    // one over minLen is shortened
    expect(shortenNpub('x'.repeat(17), {lead: 12, tail: 4, minLen: 16})).toBe(
      `${'x'.repeat(12)}…${'x'.repeat(4)}`,
    );
  });
});
