import {generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {createPostPublisher} from './publisher';
import {postTags} from './tags';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';

describe('createPostPublisher', () => {
  it('signs then publishes, returning the relay result', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    const sk = generateSecretKey();
    await store.enroll(sk);

    const published: Event[] = [];
    const relay = {
      publish: async (event: Event) => {
        published.push(event);
        return {accepted: true, message: 'stored'};
      },
    };

    const publish = createPostPublisher(store, relay);
    const result = await publish('gm world', ['news']);

    expect(result.accepted).toBe(true);
    expect(verifyEvent(result.event)).toBe(true);
    expect(result.event.pubkey).toBe(getPublicKey(sk));
    expect(postTags(result.event)).toEqual(['news']);
    expect(published).toHaveLength(1);
  });

  it('surfaces a relay rejection', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    await store.enroll(generateSecretKey());
    const relay = {publish: async () => ({accepted: false, message: 'blocked'})};

    const result = await createPostPublisher(store, relay)('hi');
    expect(result.accepted).toBe(false);
    expect(result.message).toBe('blocked');
  });
});
