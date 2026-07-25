import {generateSecretKey, getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {KeyStore, InMemorySecureStorage} from './keystore';

const unsigned = {kind: 1, created_at: 1000, tags: [] as string[][], content: 'hi'};

describe('KeyStore', () => {
  it('signs a valid event without exposing the private key', async () => {
    const storage = new InMemorySecureStorage();
    const store = new KeyStore(storage);
    const sk = generateSecretKey();

    await store.enroll(sk);
    expect(await store.isEnrolled()).toBe(true);
    expect(await store.publicKey()).toBe(getPublicKey(sk));

    const event = await store.sign(unsigned);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(getPublicKey(sk));

    // The store deliberately offers no way to read the raw key back.
    expect((store as unknown as Record<string, unknown>).exportKey).toBeUndefined();
    expect((store as unknown as Record<string, unknown>).secretKey).toBeUndefined();
  });

  it('survives a restart (new instance over the same secure storage)', async () => {
    const storage = new InMemorySecureStorage();
    const sk = generateSecretKey();
    await new KeyStore(storage).enroll(sk);

    // Simulate app relaunch: a fresh KeyStore over the persisted storage.
    const reopened = new KeyStore(storage);
    expect(await reopened.isEnrolled()).toBe(true);
    const event = await reopened.sign(unsigned);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(getPublicKey(sk));
  });

  it('reset removes the key', async () => {
    const storage = new InMemorySecureStorage();
    const store = new KeyStore(storage);
    await store.enroll(generateSecretKey());

    await store.reset();

    expect(await store.isEnrolled()).toBe(false);
    await expect(store.sign(unsigned)).rejects.toThrow(/no key enrolled/);
  });

  it('refuses to sign before enrollment', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    await expect(store.publicKey()).rejects.toThrow(/no key enrolled/);
    await expect(store.sign(unsigned)).rejects.toThrow(/no key enrolled/);
  });
});
