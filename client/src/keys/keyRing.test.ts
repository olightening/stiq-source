import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {KeyStore, InMemorySecureStorage, namespacedSkItem} from './keystore';
import {KeyRing, newSlotId, type KeySlot} from './keyRing';
import {credTokenKey, credSigKey, identityRelayKey} from '../app/workspaceKeys';

function makeSlot(over: Partial<KeySlot> = {}): KeySlot {
  const pubkey = getPublicKey(generateSecretKey());
  return {
    id: newSlotId(),
    communityName: 'Test Community',
    relayUrl: 'wss://relay.example.onion',
    enrolledAt: 1_700_000_000,
    npub: nip19.npubEncode(pubkey),
    ...over,
  };
}

describe('KeySlot.npub', () => {
  it('bech32-decodes back to the exact same hex pubkey getPublicKey(sk) derives (A8 fast-path invariant)', () => {
    // AppRuntime.loadPubkey's fast path decodes the persisted npub instead of reading the secret key
    // and running secp256k1 getPublicKey() on every launch. This proves the invariant it relies on:
    // nip19.decode(slot.npub).data is byte-identical to getPublicKey(sk) for the key that produced it.
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const slot = makeSlot({npub: nip19.npubEncode(pubkey)});
    const decoded = nip19.decode(slot.npub);
    expect(decoded.type).toBe('npub');
    expect(decoded.data).toBe(pubkey);
  });
});

describe('newSlotId', () => {
  it('produces RFC-4122 v4 UUIDs that are unique', () => {
    const a = newSlotId();
    const b = newSlotId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('namespaced KeyStore', () => {
  it('isolates keys per namespace and leaves the legacy key untouched', async () => {
    const storage = new InMemorySecureStorage();
    const sk = generateSecretKey();

    // Legacy single-identity store (no namespace).
    const legacy = new KeyStore(storage);
    await legacy.enroll(generateSecretKey());

    // Namespaced store writes under stiq_privkey_<ns> — a different key entirely.
    const ns = newSlotId();
    const scoped = new KeyStore(storage, ns);
    await scoped.enroll(sk);

    expect(await storage.getItem(namespacedSkItem(ns))).not.toBeNull();
    expect(await scoped.publicKey()).toBe(getPublicKey(sk));
    // Legacy identity still enrolled and independent.
    expect(await legacy.isEnrolled()).toBe(true);

    // Resetting the namespaced store does not touch the legacy key.
    await scoped.reset();
    expect(await scoped.isEnrolled()).toBe(false);
    expect(await legacy.isEnrolled()).toBe(true);
  });
});

describe('KeyRing', () => {
  it('adds slots, makes the newest active, and persists across instances', async () => {
    const storage = new InMemorySecureStorage();
    const ring = new KeyRing(storage);

    const a = makeSlot();
    const b = makeSlot();
    await ring.addSlot(a);
    await ring.addSlot(b);

    // Newest add is active.
    expect(await ring.getActiveSlotId()).toBe(b.id);

    // Survives a "restart" (fresh instance over the same storage).
    const reopened = new KeyRing(storage);
    const slots = await reopened.listSlots();
    expect(slots.map(s => s.id)).toEqual([a.id, b.id]);
    expect(await reopened.setActiveSlot(a.id));
    expect(await reopened.getActiveSlotId()).toBe(a.id);
  });

  it('updates an existing slot rather than duplicating it', async () => {
    const storage = new InMemorySecureStorage();
    const ring = new KeyRing(storage);
    const slot = makeSlot({communityName: 'Old'});
    await ring.addSlot(slot);
    await ring.addSlot({...slot, communityName: 'New'});

    const slots = await ring.listSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0]?.communityName).toBe('New');
  });

  it('removeSlot wipes the slot key and re-points the active slot', async () => {
    const storage = new InMemorySecureStorage();
    const ring = new KeyRing(storage);

    const a = makeSlot();
    const b = makeSlot();
    await ring.addSlot(a);
    await ring.addSlot(b);
    // Write a private key under b's namespace, as enrollment would.
    await new KeyStore(storage, b.id).enroll(generateSecretKey());
    expect(await storage.getItem(namespacedSkItem(b.id))).not.toBeNull();

    // b is active; removing it wipes its key and falls back to a.
    await ring.removeSlot(b.id);
    expect(await storage.getItem(namespacedSkItem(b.id))).toBeNull();
    expect((await ring.listSlots()).map(s => s.id)).toEqual([a.id]);
    expect(await ring.getActiveSlotId()).toBe(a.id);

    // Removing the last slot clears the active pointer.
    await ring.removeSlot(a.id);
    expect(await ring.listSlots()).toEqual([]);
    expect(await ring.getActiveSlotId()).toBeNull();
  });

  it('clear() wipes the whole ring', async () => {
    const storage = new InMemorySecureStorage();
    const ring = new KeyRing(storage);
    await ring.addSlot(makeSlot());
    await ring.clear();
    expect(await ring.listSlots()).toEqual([]);
    expect(await ring.getActiveSlotId()).toBeNull();
  });

  it('removeSlot wipes the slot secret key AND its credential + relay', async () => {
    const storage = new InMemorySecureStorage();
    const ring = new KeyRing(storage);
    const slot = makeSlot();
    // Seed the slot's namespaced secrets, as enrollment would.
    await new KeyStore(storage, slot.id).enroll(generateSecretKey());
    await storage.setItem(credTokenKey(slot.id), 'dG9rZW4=');
    await storage.setItem(credSigKey(slot.id), 'c2ln');
    await storage.setItem(identityRelayKey(slot.id), 'wss://relay.example.onion');
    await ring.addSlot(slot);

    await ring.removeSlot(slot.id);

    expect(await storage.getItem(namespacedSkItem(slot.id))).toBeNull();
    expect(await storage.getItem(credTokenKey(slot.id))).toBeNull();
    expect(await storage.getItem(credSigKey(slot.id))).toBeNull();
    expect(await storage.getItem(identityRelayKey(slot.id))).toBeNull();
  });
});
