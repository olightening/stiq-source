import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {Identity} from './identity';
import {InMemorySecureStorage} from './keystore';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const unsigned = {kind: 1, created_at: 1, tags: [] as string[][], content: 'x'};

describe('Identity', () => {
  const credential = {
    token: new Uint8Array([1, 2, 3]),
    signature: new Uint8Array([4, 5, 6]),
  };

  it('enrolls key + relay + credential, persists across restart, signs, and resets', async () => {
    const storage = new InMemorySecureStorage();
    const sk = generateSecretKey();

    const info = await new Identity(storage).enroll(sk, ONION, credential);
    expect(info.npub).toBe(nip19.npubEncode(getPublicKey(sk)));
    expect(info.relayUrl).toBe(ONION);

    // Restart: a fresh Identity over the same secure storage.
    const reopened = new Identity(storage);
    expect(await reopened.isEnrolled()).toBe(true);
    expect((await reopened.info()).relayUrl).toBe(ONION);
    expect(await reopened.credential()).toEqual(credential);

    const event = await reopened.sign(unsigned);
    expect(event.pubkey).toBe(getPublicKey(sk));

    await reopened.reset();
    expect(await reopened.isEnrolled()).toBe(false);
    expect(await reopened.credential()).toBeNull();
    await expect(reopened.sign(unsigned)).rejects.toThrow(/no key enrolled/);
  });

  it('silos two slots: distinct keys, credentials, and relays; reset of one leaves the other', async () => {
    const storage = new InMemorySecureStorage();
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const credA = {token: new Uint8Array([10]), signature: new Uint8Array([11])};
    const credB = {token: new Uint8Array([20]), signature: new Uint8Array([21])};
    const relayA = `ws://${'a'.repeat(56)}.onion`;
    const relayB = `ws://${'b'.repeat(56)}.onion`;

    await new Identity(storage, 'slotA').enroll(skA, relayA, credA);
    await new Identity(storage, 'slotB').enroll(skB, relayB, credB);

    // Each slot signs with its OWN key and reads its OWN credential + relay.
    const a = new Identity(storage, 'slotA');
    const b = new Identity(storage, 'slotB');
    expect((await a.info()).pubkey).toBe(getPublicKey(skA));
    expect((await b.info()).pubkey).toBe(getPublicKey(skB));
    expect((await a.info()).pubkey).not.toBe((await b.info()).pubkey);
    expect((await a.info()).relayUrl).toBe(relayA);
    expect((await b.info()).relayUrl).toBe(relayB);
    expect(await a.credential()).toEqual(credA);
    expect(await b.credential()).toEqual(credB);
    expect((await a.sign(unsigned)).pubkey).toBe(getPublicKey(skA));

    // The legacy (un-namespaced) identity sees NEITHER slot.
    expect(await new Identity(storage).isEnrolled()).toBe(false);

    // Resetting slotA does not touch slotB.
    await a.reset();
    expect(await a.isEnrolled()).toBe(false);
    expect(await a.credential()).toBeNull();
    expect(await b.isEnrolled()).toBe(true);
    expect(await b.credential()).toEqual(credB);
  });
});
