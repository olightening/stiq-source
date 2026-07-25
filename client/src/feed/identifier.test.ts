import {nip19} from 'nostr-tools';
import {postIdentifier} from './identifier';
import {Kind} from '../nostr/events';
import type {Event} from 'nostr-tools/pure';

const HEX = 'a'.repeat(64);

function evt(over: Partial<Event>): Event {
  return {id: HEX, pubkey: HEX, created_at: 1, kind: 1, tags: [], content: '', sig: 's', ...over} as Event;
}

describe('postIdentifier', () => {
  it('encodes a kind-1 note as nevent', () => {
    const id = postIdentifier(evt({kind: Kind.Post}));
    expect(id.startsWith('nevent1')).toBe(true);
    const decoded = nip19.decode(id);
    expect(decoded.type).toBe('nevent');
  });

  it('encodes a kind-30023 article as naddr using its d tag', () => {
    const id = postIdentifier(evt({kind: Kind.Article, tags: [['d', 'my-slug']]}));
    expect(id.startsWith('naddr1')).toBe(true);
    const decoded = nip19.decode(id);
    expect(decoded.type).toBe('naddr');
    expect((decoded.data as {identifier: string}).identifier).toBe('my-slug');
  });

  it('falls back to the raw id on a malformed event (never throws)', () => {
    expect(postIdentifier(evt({id: 'not-hex', pubkey: 'p'}))).toBe('not-hex');
  });
});
