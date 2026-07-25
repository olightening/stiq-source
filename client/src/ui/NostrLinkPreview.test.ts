import * as nip19 from 'nostr-tools/nip19';
import {decodeNostrUri} from './NostrLinkPreview';

const HEX = 'a'.repeat(64);
const PUBKEY = 'b'.repeat(64);

describe('decodeNostrUri', () => {
  it('decodes a nevent URI to its hex event id', () => {
    const uri = `nostr:${nip19.neventEncode({id: HEX, author: PUBKEY, kind: 1})}`;
    expect(decodeNostrUri(uri)).toBe(HEX);
  });

  it('decodes a bare note (no nostr: prefix) to its hex event id', () => {
    const uri = nip19.noteEncode(HEX);
    expect(decodeNostrUri(uri)).toBe(HEX);
  });

  it('decodes a naddr (addressable event) to its {kind,pubkey,identifier} coordinate', () => {
    const uri = `nostr:${nip19.naddrEncode({identifier: 'my-slug', pubkey: PUBKEY, kind: 30023})}`;
    expect(decodeNostrUri(uri)).toBe(`30023:${PUBKEY}:my-slug`);
  });

  it('decodes a naddr with an empty d-tag identifier', () => {
    const uri = `nostr:${nip19.naddrEncode({identifier: '', pubkey: PUBKEY, kind: 34550})}`;
    expect(decodeNostrUri(uri)).toBe(`34550:${PUBKEY}:`);
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(decodeNostrUri('nostr:not-a-real-ref')).toBeNull();
    expect(decodeNostrUri('')).toBeNull();
  });

  it('returns null for an npub (not an event/addressable ref)', () => {
    const uri = nip19.npubEncode(PUBKEY);
    expect(decodeNostrUri(uri)).toBeNull();
  });
});
