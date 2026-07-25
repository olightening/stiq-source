import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {PROMOTED_TAG, promotedFeedId, isPromoted, withPromotedTag, promotedTagFrom} from './promote';
import {buildChannelMessageEdit, broadcastToChannel, channelMessages} from './channels';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import type {Event} from 'nostr-tools/pure';

async function ownerStore() {
  const store = new KeyStore(new InMemorySecureStorage());
  const sk = generateSecretKey();
  await store.enroll(sk);
  return {store, pubkey: getPublicKey(sk)};
}

describe('promote helpers (No.5)', () => {
  it('withPromotedTag appends the marker; promotedFeedId / isPromoted read it', () => {
    const base = {kind: 1311, created_at: 1, tags: [['a', 'coord', '', 'root']], content: 'x'};
    const tagged = withPromotedTag(base, 'feed123');
    expect(tagged.tags).toContainEqual([PROMOTED_TAG, 'feed123']);
    expect(promotedFeedId(tagged as unknown as Event)).toBe('feed123');
    expect(isPromoted(tagged as unknown as Event)).toBe(true);
  });

  it('treats an unpromoted event as not promoted', () => {
    const ev = {kind: 1311, tags: [['a', 'coord']], content: 'x'} as unknown as Event;
    expect(promotedFeedId(ev)).toBeUndefined();
    expect(isPromoted(ev)).toBe(false);
    expect(promotedTagFrom(ev)).toEqual([]);
  });
});

describe('promotion survives the channel edit fold (No.5)', () => {
  it('carries the promoted marker onto the folded message and replaces its text', async () => {
    const {store} = await ownerStore();
    const cache = new InMemoryEventStore();
    const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:c1`;

    const m1 = await broadcastToChannel(store, COORD, 'original channel post');
    cache.save({...m1, created_at: 1});

    // Promote: a position-preserving edit carrying the final text + the promoted marker.
    const promote = await store.sign(
      withPromotedTag(buildChannelMessageEdit(COORD, m1.id, 'final edited text now on the feed'), 'feedEvent99'),
    );
    cache.save({...promote, created_at: 2});

    const [msg] = channelMessages(cache, COORD);
    expect(msg!.id).toBe(m1.id); // position preserved
    expect(msg!.content).toBe('final edited text now on the feed'); // text replaced in channel
    expect(promotedFeedId(msg!)).toBe('feedEvent99'); // promoted marker survived the fold
    expect(isPromoted(msg!)).toBe(true);
  });
});
