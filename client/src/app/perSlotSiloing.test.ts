/**
 * Per-account (identity-slot) siloing suite.
 *
 * The multi-community silo already swaps the community-PUBLIC layer (feed/phonebooks) on a switch;
 * this suite covers the IDENTITY-BOUND state that was re-keyed from per-community/global to per-ACCOUNT
 * (slot): wallet, outbox, joined groups, encrypted-spaces set, picture-allowance spend, and the
 * organizer-config carry-over. It proves:
 *   (a) two accounts in the SAME community keep those isolated;
 *   (b) switching community is a COMPLETE swap — no outgoing account's identity-bound state stays visible;
 *   (c) organizer config never carries a previous community's value into one that omits it;
 *   (e) leaving a community with multiple accounts removes ALL of them (no orphaned sibling slot).
 */
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {CommunityStore, communityId, type EnrolledCommunity} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {outboxKey, groupsJoinedKey, spacesEncryptedKey, pictureSpendKey} from './workspaceKeys';
import {DEFAULT_TAG_POLICY, type TagPolicy} from '../feed/tagPolicy';
import {DEFAULT_LABELS} from '../feed/labels';
import {DEFAULT_POST_RULES, type PostRules} from '../feed/postRules';
import {DEFAULT_REASONS, type ReasonsConfig} from '../moderation/reasons';
import {DEFAULT_RANKING, type RankingConfig} from '../feed/sort';
import AsyncStorage from '@react-native-async-storage/async-storage';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const CID_A = communityId(RELAY_A);
const CID_B = communityId(RELAY_B);
const ISSUER_FP = walletKeyFingerprint('aXNz'); // every test community shares issuer 'aXNz'

async function makeSessionFor(relayUrl: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl, issuerPublicKey: 'aXNz'},
    new MockBlindRsa(),
    'STIQ-TEST-0001',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** Test-double store key — per-(cid, slot) now (finding #4: the cache is per-ACCOUNT, not per-cid). */
const storeKey = (cid: string | null, slotId: string | null): string =>
  `${cid ?? '__none__'}::${slotId ?? '__noslot__'}`;

function newSiloRuntime() {
  const secure = new InMemorySecureStorage();
  const stores = new Map<string, EventStore>();
  // Key by BOTH cid AND slot: two accounts in the SAME community must get DIFFERENT stores, so
  // account B's downloaded feed + kind-1059 DM gift-wraps never land in account A's cache (finding #4).
  const makeStore = async (cid: string | null, slotId: string | null): Promise<EventStore> => {
    const key = storeKey(cid, slotId);
    let store = stores.get(key);
    if (!store) {
      store = new InMemoryEventStore();
      stores.set(key, store);
    }
    return store;
  };
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new SwappableEventStore(new InMemoryEventStore()),
    createStore: makeStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  return {runtime, secure, stores};
}

/** Deposit `n` posting tokens into a slot's wallet, stamped under the shared issuer fingerprint. */
async function seedWallet(secure: InMemorySecureStorage, slotId: string, n: number): Promise<void> {
  const wallet = new EpochWallet(secure, slotId, ISSUER_FP);
  // Real holder-bound keypairs (P3): these tokens are spent + posted blind by the runtime.
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

/** Read the runtime's private CommunityStore (to seed a community's organizer config directly). */
function communitiesOf(runtime: AppRuntime): CommunityStore {
  return (runtime as unknown as {communities: CommunityStore}).communities;
}

const activeSlot = async (r: AppRuntime): Promise<string> => (await r.listKeySlots()).activeId!;

describe('per-account (slot) siloing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('(a) two accounts in the SAME community keep isolated wallet/outbox/groups/spaces/picture-spend + feed/gift-wraps', async () => {
    const {runtime, secure, stores} = newSiloRuntime();
    await runtime.init();

    // Account 1 in community A, given real per-account state.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const slot1 = await activeSlot(runtime);
    await seedWallet(secure, slot1, 4);
    await runtime.post('acct1 pending'); // outbox (community A carries no ck → non-blind, no token spent)
    const gid = await runtime.createGroup({private: true}); // joined group + encrypted space + space key
    await secure.setItem(pictureSpendKey(slot1), JSON.stringify({windowStart: Date.now(), spentBytes: 4096}));

    // Account 1 sees its own state.
    expect(await runtime.walletBalance()).toBe(4);
    expect(await secure.getItem(outboxKey(slot1))).not.toBeNull();
    expect(await AsyncStorage.getItem(groupsJoinedKey(slot1))).toContain(gid);
    expect(await AsyncStorage.getItem(spacesEncryptedKey(slot1))).toContain(gid);

    // Finding #4 — the EVENT STORE is now per-account: account 1's downloaded feed post AND its
    // kind-1059 DM gift-wrap live in slot1's OWN store, a DIFFERENT instance from slot2's.
    const store1 = stores.get(storeKey(CID_A, slot1))!;
    expect(store1).toBeDefined();
    const PK = 'a'.repeat(64); // a valid 32-byte hex pubkey (so the feed can render the kind-1 post)
    store1.save({id: 'feedpost-1', pubkey: PK, created_at: 1, kind: 1, tags: [], content: 'acct1 only', sig: 's'});
    store1.save({id: 'giftwrap-1', pubkey: PK, created_at: 1, kind: 1059, tags: [], content: 'wrap', sig: 's'});

    // Account 2 in the SAME community → a NEW slot with EMPTY identity-bound state (nothing bleeds over).
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '');
    const slot2 = await activeSlot(runtime);
    expect(slot2).not.toBe(slot1);
    expect(communityId((await runtime.listKeySlots()).slots.find(s => s.id === slot2)!.relayUrl)).toBe(CID_A);
    expect(await runtime.walletBalance()).toBe(0);
    expect(runtime.getSnapshot().picturesSpentBytes).toBe(0);
    expect(await secure.getItem(outboxKey(slot2))).toBeNull();
    expect(await AsyncStorage.getItem(groupsJoinedKey(slot2))).toBeNull();
    expect(await AsyncStorage.getItem(spacesEncryptedKey(slot2))).toBeNull();

    // slot2's store is a SEPARATE instance: it holds NEITHER account 1's feed post NOR its DM gift-wrap.
    const store2 = stores.get(storeKey(CID_A, slot2))!;
    expect(store2).toBeDefined();
    expect(store2).not.toBe(store1);
    expect(store2.has('feedpost-1')).toBe(false); // account 1's feed content never renders on account 2
    expect(store2.has('giftwrap-1')).toBe(false); // account 1's DM gift-wraps never sit in account 2's cache
    // …while account 1's own store still holds both.
    expect(store1.has('feedpost-1')).toBe(true);
    expect(store1.has('giftwrap-1')).toBe(true);

    // Account 1's state survives untouched and is restored on switch back.
    await runtime.switchIdentity(slot1);
    expect(await runtime.walletBalance()).toBe(4);
    expect(runtime.getSnapshot().picturesSpentBytes).toBe(4096);
    runtime.dispose();
  });

  it('(b) switching community is a COMPLETE swap — no outgoing account state stays visible', async () => {
    const {runtime, secure} = newSiloRuntime();
    await runtime.init();

    // Community A: post, wallet, picture-spend.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const slotA = await activeSlot(runtime);
    await seedWallet(secure, slotA, 3);
    await runtime.post('from-A');
    await secure.setItem(pictureSpendKey(slotA), JSON.stringify({windowStart: Date.now(), spentBytes: 2048}));
    expect(runtime.getSnapshot().feed.items.map(i => i.content)).toContain('from-A');

    // Join community B and switch to it — NONE of A's identity-bound state may show through.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    await runtime.switchCommunity(CID_B);
    let snap = runtime.getSnapshot();
    expect(snap.feed.items.map(i => i.content)).not.toContain('from-A');
    expect(await runtime.walletBalance()).toBe(0); // B's own (empty) wallet, not A's 3
    expect(snap.sendStatus.size).toBe(0); // B's own (empty) outbox, not A's pending send
    expect(snap.picturesSpentBytes).toBe(0); // B's own spend, not A's 2048

    // Switch back to A — its full state returns.
    await runtime.switchCommunity(CID_A);
    snap = runtime.getSnapshot();
    expect(snap.feed.items.map(i => i.content)).toContain('from-A');
    expect(await runtime.walletBalance()).toBe(3);
    expect(snap.sendStatus.size).toBe(1);
    expect(snap.picturesSpentBytes).toBe(2048);
    runtime.dispose();
  });

  it('(c) organizer config never carries a previous community\'s value into one that omits it', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();

    // Enroll A, then give A a FULL non-default organizer config directly on its record.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const communities = communitiesOf(runtime);
    const recA = (await communities.list()).find(c => c.id === CID_A)!;
    const customTagPolicy = {
      communityTags: ['news'],
      pinCommunityTags: true,
      allowMemberTags: true,
      maxTags: 42,
      tagScopes: {},
    } as unknown as TagPolicy;
    const customPostRules: PostRules = {
      note: {min: 0, max: 999, mediaMax: 0, labelRequired: false},
      article: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
      authorNoteMax: 280,
    };
    const customReasons: ReasonsConfig = {buckets: DEFAULT_REASONS.buckets, reportThreshold: 7};
    const customRanking: RankingConfig = {...DEFAULT_RANKING, halfLifeHours: 7.5, scoreWeight: 0.5};
    const withConfig: EnrolledCommunity = {
      ...recA,
      tagPolicy: customTagPolicy,
      postRules: customPostRules,
      postRulesAt: 123,
      reasons: customReasons,
      ranking: customRanking,
    };
    await communities.upsert(withConfig);

    // Enroll B (no organizer config) — it becomes active; its config is the defaults.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');

    // Switch to A: its custom config loads.
    await runtime.switchCommunity(CID_A);
    let snap = runtime.getSnapshot();
    expect((snap.tagPolicy as unknown as {maxTags: number}).maxTags).toBe(42);
    expect(snap.postRules).toEqual(customPostRules);
    expect(snap.reasons).toEqual(customReasons);
    expect(snap.ranking).toEqual(customRanking);

    // Switch to B (which sets NONE of these): every field RESETS to its default — A's values do not
    // carry over (the bug this fix closes was a missing field leaving the previous community's value).
    await runtime.switchCommunity(CID_B);
    snap = runtime.getSnapshot();
    expect(snap.tagPolicy).toEqual(DEFAULT_TAG_POLICY);
    expect(snap.labels).toEqual(DEFAULT_LABELS);
    expect(snap.postRules).toEqual(DEFAULT_POST_RULES);
    expect(snap.reasons).toEqual(DEFAULT_REASONS);
    expect(snap.ranking).toEqual(DEFAULT_RANKING);
    runtime.dispose();
  });

  it('(e) leaving a community with multiple accounts removes ALL of them (no orphaned sibling slot)', async () => {
    const {runtime, secure} = newSiloRuntime();
    await runtime.init();

    // Two accounts in community A + one in B (B is where we land after leaving A).
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const slotA1 = await activeSlot(runtime);
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '');
    const slotA2 = await activeSlot(runtime);
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    expect(slotA1).not.toBe(slotA2);
    expect((await runtime.listKeySlots()).slots).toHaveLength(3);

    // Give each A account a per-account secret so we can prove it was wiped, not orphaned.
    await seedWallet(secure, slotA1, 2);
    await seedWallet(secure, slotA2, 2);

    // Leave community A (currently NOT active — B is). BOTH A accounts + their state must go; B stays.
    await runtime.removeCommunity(CID_A);

    const {slots} = await runtime.listKeySlots();
    expect(slots).toHaveLength(1); // only B's slot — neither A account is orphaned
    expect(slots.every(s => communityId(s.relayUrl) === CID_B)).toBe(true);
    expect((await runtime.getCommunities()).list.map(c => c.id)).toEqual([CID_B]);
    // Both A accounts' wallets (and outboxes) were wiped, not left behind.
    expect(await new EpochWallet(secure, slotA1).count()).toBe(0);
    expect(await new EpochWallet(secure, slotA2).count()).toBe(0);
    runtime.dispose();
  });
});
