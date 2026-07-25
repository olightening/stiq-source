import {buildMuteList, blockedPubkeys} from './ownerComments';
import {InMemoryEventStore} from '../nostr/store';
import type {Event} from '../nostr/events';

function ev(p: Partial<Event> & {kind: number; pubkey: string; tags: string[][]; created_at: number}): Event {
  return {id: Math.random().toString(36).slice(2), content: '', sig: '', ...p} as Event;
}

describe('mute list helpers', () => {
  it('builds + parses a mute list (latest wins)', () => {
    const store = new InMemoryEventStore();
    store.save(ev({...buildMuteList(['a']), pubkey: 'owner', created_at: 100}));
    store.save(ev({...buildMuteList(['a', 'b']), pubkey: 'owner', created_at: 200}));
    store.save(ev({...buildMuteList(['z']), pubkey: 'other', created_at: 300}));
    expect([...blockedPubkeys(store, 'owner')].sort()).toEqual(['a', 'b']);
  });

  it('deduplicates pubkeys when building', () => {
    expect(buildMuteList(['a', 'a', 'b']).tags).toEqual([['p', 'a'], ['p', 'b']]);
  });

  it('no list → empty set', () => {
    const store = new InMemoryEventStore();
    expect(blockedPubkeys(store, 'owner').size).toBe(0);
  });
});
