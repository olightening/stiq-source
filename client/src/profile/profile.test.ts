import {getPublicKey, generateSecretKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {buildProfile} from './profile';
import {InMemoryEventStore} from '../nostr/store';
import {createChannel} from '../channels/channels';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';

function ev(kind: number, pubkey: string, content: string, id: string): Event {
  return {id, pubkey, created_at: 1, kind, tags: [], content, sig: 's'};
}

describe('buildProfile', () => {
  it('aggregates metadata and owned channels', async () => {
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);
    const keyStore = new KeyStore(new InMemorySecureStorage());
    await keyStore.enroll(sk);

    const store = new InMemoryEventStore();
    store.save(ev(0, owner, JSON.stringify({name: 'Ada', about: 'hi'}), 'meta1'));

    // Use the real NIP-53 (kind 30311) channel builder so parseChannel recognises the events.
    store.save(await createChannel(keyStore, {name: 'Ada News'}));
    store.save(await createChannel(keyStore, {name: 'Ada Notes'}));
    // Someone else's channel must not appear on Ada's profile.
    const otherSk = generateSecretKey();
    const otherStore = new KeyStore(new InMemorySecureStorage());
    await otherStore.enroll(otherSk);
    store.save(await createChannel(otherStore, {name: 'Other'}));

    const profile = buildProfile(store, owner);
    expect(profile.npub).toBe(nip19.npubEncode(owner));
    expect(profile.name).toBe('Ada');
    expect(profile.channels.map(c => c.name).sort()).toEqual(['Ada News', 'Ada Notes']);
  });

  it('handles a profile with no metadata or channels', () => {
    const owner = getPublicKey(generateSecretKey());
    const profile = buildProfile(new InMemoryEventStore(), owner);
    expect(profile.name).toBeUndefined();
    expect(profile.channels).toEqual([]);
  });

  // #8: posts/ideaCount are NOT built here anymore — a raw {authors: [pubkey]} query can never match
  // a blind post (throwaway-signed). AppRuntime.getProfile overlays both from the resolved feed
  // instead (see AppRuntime.test.ts's "getProfile — resolved-feed posts + ideaCount" suite for the
  // blind-attribution-aware behaviour this replaced).
  it('never builds posts/ideaCount from the raw store — even a plain (non-blind) matching post is left to the caller', () => {
    const owner = getPublicKey(generateSecretKey());
    const store = new InMemoryEventStore();
    store.save(ev(1, owner, 'a real note', 'note1'));
    store.save(ev(1111, owner, 'a real comment', 'comment1'));

    const profile = buildProfile(store, owner);
    expect(profile.posts).toEqual([]);
    expect(profile.ideaCount).toBe(0);
  });
});
