import {
  buildSubscriptionList,
  parseSubscriptions,
  subscribedChannelIds,
  channelSyncIds,
} from './subscriptions';
import type {Channel} from './channels';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import type {Event} from '../nostr/events';

function ev(partial: Partial<Event> & {kind: number; tags: string[][]; pubkey: string; created_at: number}): Event {
  return {id: Math.random().toString(36).slice(2), content: '', sig: '', ...partial} as Event;
}

describe('channel subscriptions (NIP-51)', () => {
  it('builds a kind-10009 list with deduped a tags', () => {
    const unsigned = buildSubscriptionList(['c1', 'c2', 'c1']);
    expect(unsigned.kind).toBe(Kind.ChannelSubscriptions);
    expect(unsigned.tags).toEqual([['a', 'c1'], ['a', 'c2']]);
  });

  it('round-trips through parseSubscriptions', () => {
    const unsigned = buildSubscriptionList(['a', 'b']);
    const event = ev({...unsigned, pubkey: 'u1', created_at: 1});
    expect(parseSubscriptions(event)).toEqual(['a', 'b']);
  });

  it('latest list wins in the store', () => {
    const store = new InMemoryEventStore();
    store.save(ev({...buildSubscriptionList(['a']), pubkey: 'u1', created_at: 100}));
    store.save(ev({...buildSubscriptionList(['a', 'b']), pubkey: 'u1', created_at: 200}));
    // A different user's list must not bleed in.
    store.save(ev({...buildSubscriptionList(['z']), pubkey: 'u2', created_at: 300}));
    expect(subscribedChannelIds(store, 'u1').sort()).toEqual(['a', 'b']);
  });

  it('returns empty when the user has no list', () => {
    const store = new InMemoryEventStore();
    expect(subscribedChannelIds(store, 'nobody')).toEqual([]);
    expect(subscribedChannelIds(store, undefined)).toEqual([]);
  });
});

/**
 * channelSyncIds — "the channels I am a part of", the REAL values the scoped `channels` subscription
 * hides inside its decoy cover set (bug 8). Getting this set wrong is a silent failure in both
 * directions: too small and a member stops receiving a channel they are in; too large and we waste
 * cover slots on channels they never read.
 */
function ch(id: string, owner: string, admins?: string[]): Channel {
  return {id, owner, name: id, admins};
}

describe('channelSyncIds (wire scoping — bug 8)', () => {
  const ME = 'me';

  it('includes channels I FOLLOW (the kind-10009 list)', () => {
    const store = new InMemoryEventStore();
    store.save(ev({...buildSubscriptionList(['c1', 'c2']), pubkey: ME, created_at: 1}));
    expect(channelSyncIds(store, ME, []).sort()).toEqual(['c1', 'c2']);
  });

  it('includes channels I OWN even when I never followed them', () => {
    const store = new InMemoryEventStore();
    expect(channelSyncIds(store, ME, [ch('mine', ME)])).toEqual(['mine']);
  });

  it('includes channels I ADMINISTER but do not follow — an unfollowed admin must still moderate', () => {
    // The concrete failure this prevents: AppRuntime.administeredSpaceAutoContexts feeds the
    // moderation log from channelMessages() for every channel the viewer owns OR administers. With
    // 1311 off the firehose and this channel missing from the cover set, an admin who never pressed
    // Follow would see an EMPTY message list for their own channel — no error, just a mod log
    // quietly missing that channel's auto-hides.
    const store = new InMemoryEventStore();
    expect(channelSyncIds(store, ME, [ch('c1', 'someone-else', [ME])])).toEqual(['c1']);
  });

  it('excludes channels that are merely known — being able to SEE a channel is not being in it', () => {
    const store = new InMemoryEventStore();
    const channels = [ch('other', 'someone-else'), ch('other2', 'someone-else', ['not-me'])];
    expect(channelSyncIds(store, ME, channels)).toEqual([]);
  });

  it('unions the three sources without duplicating a followed channel I also own', () => {
    // A duplicate would be handed straight to the cover set, where a repeated entry marks a
    // coordinate as real to anyone reading the REQ.
    const store = new InMemoryEventStore();
    store.save(ev({...buildSubscriptionList(['c1', 'c2']), pubkey: ME, created_at: 1}));
    const ids = channelSyncIds(store, ME, [ch('c1', ME), ch('c3', 'x', [ME])]);
    expect(ids.sort()).toEqual(['c1', 'c2', 'c3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is empty with no identity (nothing to scope to, and nothing to leak)', () => {
    const store = new InMemoryEventStore();
    expect(channelSyncIds(store, undefined, [ch('c1', ME)])).toEqual([]);
  });
});
