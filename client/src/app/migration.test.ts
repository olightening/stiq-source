import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {bytesToHex} from '../util/hex';
import {InMemorySecureStorage} from '../keys/keystore';
import {namespacedSkItem} from '../keys/keystore';
import {Identity} from '../keys/identity';
import {KeyRing, newSlotId} from '../keys/keyRing';
import {CommunityStore, communityId} from '../communities/communityStore';
import {walletStorageKeys, EpochWallet} from '../blind/wallet';
import {migrateToSlots, migrateCidToSlot} from './migration';
import {
  LEGACY_SK_ITEM,
  LEGACY_RELAY_ITEM,
  LEGACY_CRED_TOKEN_ITEM,
  LEGACY_CRED_SIG_ITEM,
  LEGACY_DISPLAYNAME_SELF,
  LEGACY_GRADIENT_SELF,
  LEGACY_PICTURE_SPEND,
  PREV_OUTBOX_CID,
  PREV_GROUPS_JOINED_CID,
  PREV_SPACES_ENCRYPTED_CID,
  credTokenKey,
  credSigKey,
  displayNameSelfKey,
  gradientSelfKey,
  outboxKey,
  groupsJoinedKey,
  spacesEncryptedKey,
  pictureSpendKey,
} from './workspaceKeys';
import AsyncStorage from '@react-native-async-storage/async-storage';

const RELAY = `ws://${'a'.repeat(56)}.onion`;

/** Seed a pre-silo single-community install: legacy global keys + a community in the list. */
async function seedLegacyInstall(storage: InMemorySecureStorage): Promise<{sk: Uint8Array; pubkey: string}> {
  const sk = generateSecretKey();
  await storage.setItem(LEGACY_SK_ITEM, bytesToHex(sk));
  await storage.setItem(LEGACY_RELAY_ITEM, RELAY);
  await storage.setItem(LEGACY_CRED_TOKEN_ITEM, 'dG9rZW4=');
  await storage.setItem(LEGACY_CRED_SIG_ITEM, 'c2ln');
  await storage.setItem(LEGACY_DISPLAYNAME_SELF, 'Quiet River');
  await storage.setItem(LEGACY_GRADIENT_SELF, JSON.stringify({type: 'linear', angle: 120, stops: ['#7cb2ff', '#b89aff']}));
  // The enrolled user already has the community recorded (enrollment upserts it).
  const communities = new CommunityStore(storage);
  await communities.upsert({id: communityId(RELAY), relayUrl: RELAY, issuerPublicKey: 'aXNz', name: 'Test Community'});
  return {sk, pubkey: getPublicKey(sk)};
}

describe('migrateToSlots (pre-silo → slot model)', () => {
  it('creates slot 0 that signs identically to the legacy key, backfills namespaced data, keeps legacy keys', async () => {
    const storage = new InMemorySecureStorage();
    const {pubkey} = await seedLegacyInstall(storage);
    const keyRing = new KeyRing(storage);
    const communities = new CommunityStore(storage);

    await migrateToSlots(storage, keyRing, communities);

    // A slot was created and made active.
    const slots = await keyRing.listSlots();
    expect(slots).toHaveLength(1);
    const slotId = slots[0]!.id;
    expect(await keyRing.getActiveSlotId()).toBe(slotId);
    expect(slots[0]!.npub).toBe(nip19.npubEncode(pubkey));

    // The slot's Identity signs with the SAME key as the legacy install.
    const info = await new Identity(storage, slotId).info();
    expect(info.pubkey).toBe(pubkey);

    // Secrets + identity values were copied into the slot's namespace.
    expect(await storage.getItem(namespacedSkItem(slotId))).toBe(await storage.getItem(LEGACY_SK_ITEM));
    expect(await storage.getItem(credTokenKey(slotId))).toBe('dG9rZW4=');
    expect(await storage.getItem(credSigKey(slotId))).toBe('c2ln');
    expect(await storage.getItem(displayNameSelfKey(slotId))).toBe('Quiet River');
    expect(await storage.getItem(gradientSelfKey(slotId))).toBeTruthy();

    // COPY-not-move: the legacy keys are still present (safety net).
    expect(await storage.getItem(LEGACY_SK_ITEM)).toBeTruthy();
    expect(await storage.getItem(LEGACY_CRED_TOKEN_ITEM)).toBe('dG9rZW4=');
  });

  it('is idempotent — a second run creates no new slot and clobbers nothing', async () => {
    const storage = new InMemorySecureStorage();
    await seedLegacyInstall(storage);
    const keyRing = new KeyRing(storage);
    const communities = new CommunityStore(storage);

    await migrateToSlots(storage, keyRing, communities);
    const slotId = (await keyRing.listSlots())[0]!.id;
    const credAfterFirst = await storage.getItem(credTokenKey(slotId));

    await migrateToSlots(storage, keyRing, communities);
    expect(await keyRing.listSlots()).toHaveLength(1);
    expect(await storage.getItem(credTokenKey(slotId))).toBe(credAfterFirst);
  });

  it('no-ops on a fresh install (no legacy key)', async () => {
    const storage = new InMemorySecureStorage();
    const keyRing = new KeyRing(storage);
    const communities = new CommunityStore(storage);

    await migrateToSlots(storage, keyRing, communities);
    expect(await keyRing.listSlots()).toHaveLength(0);
  });
});

describe('migrateCidToSlot (per-cid/global identity-bound state → per-account slot)', () => {
  it('(d) maps legacy per-cid + global items into the (active) slot, idempotently', async () => {
    const storage = new InMemorySecureStorage();
    const keyRing = new KeyRing(storage);
    const cid = communityId(RELAY);
    const slotId = newSlotId();
    await keyRing.addSlot({id: slotId, communityName: 'A', relayUrl: RELAY, enrolledAt: 1, npub: 'npub1x'});

    // A v1-silo install: wallet + outbox + groups + spaces keyed per-CID, picture-spend + space keys global.
    const wCid = walletStorageKeys(cid);
    await storage.setItem(wCid.tokens, 'TOK');
    await storage.setItem(wCid.epoch, '0');
    await storage.setItem(wCid.keyfp, 'FP');
    await storage.setItem(PREV_OUTBOX_CID(cid), 'OUTBOX');
    await AsyncStorage.setItem(PREV_GROUPS_JOINED_CID(cid), JSON.stringify(['g1']));
    await AsyncStorage.setItem(PREV_SPACES_ENCRYPTED_CID(cid), JSON.stringify(['g1']));
    await storage.setItem(LEGACY_PICTURE_SPEND, JSON.stringify({windowStart: 1, spentBytes: 99}));
    await storage.setItem('spacekey:g1:0', 'ab'.repeat(32)); // global (un-namespaced) space key + marker
    await storage.setItem('spacekey:g1:epoch', '0');

    await migrateCidToSlot(storage, keyRing);

    // Wallet, outbox, groups, spaces, picture-spend copied into the slot's namespace.
    const wSlot = walletStorageKeys(slotId);
    expect(await storage.getItem(wSlot.tokens)).toBe('TOK');
    expect(await storage.getItem(wSlot.epoch)).toBe('0');
    expect(await storage.getItem(wSlot.keyfp)).toBe('FP');
    expect(await storage.getItem(outboxKey(slotId))).toBe('OUTBOX');
    expect(await AsyncStorage.getItem(groupsJoinedKey(slotId))).toContain('g1');
    expect(await AsyncStorage.getItem(spacesEncryptedKey(slotId))).toContain('g1');
    expect(await storage.getItem(pictureSpendKey(slotId))).toContain('99');
    // The private-space E2E key moved from the global namespace into the slot's.
    expect(await storage.getItem(`spacekey:${slotId}:g1:0`)).toBe('ab'.repeat(32));

    // Idempotent: a second run neither re-copies nor clobbers newer per-slot state.
    await storage.setItem(wSlot.tokens, 'TOK2');
    await migrateCidToSlot(storage, keyRing);
    expect(await storage.getItem(wSlot.tokens)).toBe('TOK2');
  });

  it('leaves the migrated wallet spendable by an EpochWallet bound to the slot', async () => {
    const storage = new InMemorySecureStorage();
    const keyRing = new KeyRing(storage);
    const cid = communityId(RELAY);
    const slotId = newSlotId();
    await keyRing.addSlot({id: slotId, communityName: 'A', relayUrl: RELAY, enrolledAt: 1, npub: 'npub1x'});

    // Seed a real token batch in the per-cid wallet (as a v1-silo draw would have). The token is only
    // migrated + counted here (never posted), so the secret is an opaque filler of matching width.
    await new EpochWallet(storage, cid).add(0, [{token: new Uint8Array(32), sig: new Uint8Array(32), secret: new Uint8Array(32)}]);
    await migrateCidToSlot(storage, keyRing);

    // The slot's wallet now holds the migrated token.
    expect(await new EpochWallet(storage, slotId).count()).toBe(1);
  });
});
