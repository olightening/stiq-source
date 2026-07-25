// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
//
// PIN_LOCK_UI (bugs 5+6) ships default-OFF: the PIN UI is dark, so `loadPinEnabled()` reports the
// effective preference `false` and resolveScreen never names 'lock' — which would make this file's
// lock/duress/pre-warm scenarios unreachable rather than broken. Force it ON so they keep exercising
// the PIN machinery end-to-end, exactly as they did before the flag existed. That every one of them
// passes UNCHANGED under this single override IS the ship-dark contract's proof: nothing about the
// lock feature was deleted or rewritten, only gated. (The dark side is pinned separately, by
// pinLockDark.test.ts / route.test.ts / AppShell.test.tsx and the Settings + onboarding mirrors.)
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
  PIN_LOCK_UI: true,
}));

import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {v2 as nip44} from 'nostr-tools/nip44';
import {AppRuntime, type AppSnapshot} from './AppRuntime';
import {FETCH_TIMEOUT_MS} from '../nostr/RelayClient';
import {InMemorySecureStorage, namespacedSkItem} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {communityId} from '../communities/communityStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LEGACY_SK_ITEM,
  credTokenKey,
  credSigKey,
  identityRelayKey,
  identityAtKey,
  displayNameSelfKey,
  gradientSelfKey,
  draftsKey,
  dmSentKey,
  dmReactionsKey,
  dmFailedWrapsKey,
  dmBlocklistKey,
  sqliteDbKeyItem,
  eventsCacheKey,
  outboxKey,
  displayNameBookKey,
  gradientBookKey,
  groupsJoinedKey,
  spacesEncryptedKey,
  pictureSpendKey,
  mutedAuthorsKey,
} from './workspaceKeys';
import {walletStorageKeys} from '../blind/wallet';
import {buildComment, refOf} from '../feed/comments';

/**
 * InMemorySecureStorage that also records every key ever written, so the M3 wipe-completeness test
 * can assert that NO namespaced (`stiq.*.<slot>` / `stiq.*.<cid>`) key the app itself wrote survives
 * a wipe — a future-proof check beyond the explicit per-key assertions.
 */
class TrackingSecureStorage extends InMemorySecureStorage {
  readonly written = new Set<string>();
  override async setItem(key: string, value: string): Promise<void> {
    this.written.add(key);
    await super.setItem(key, value);
  }
}
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {SqliteEventStore, WARM_CHUNK_ROWS, type SqliteDb} from '../nostr/sqliteStore';
import {
  putRenderedMedia,
  renderedMediaSize,
  clearRenderedMedia,
} from '../media/renderedMediaCache';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {sealDM} from '../dm/dm';
import {resolveScreen} from './route';
import type {Session} from '../onboarding/enrollment';
import {Kind} from '../nostr/events';
import {GroupKind} from '../channels/groups';
import {ITEM_WARM_CHUNK_ROWS} from '../feed/feed';
import {DEFAULT_PICTURE_RULES} from '../feed/pictureRules';
import {DEFAULT_AUDIO_RULES} from '../feed/audioRules';
import {
  ORGANIZER_D_COMMUNITY,
  ORGANIZER_D_LOG_PAGE,
  ORGANIZER_D_GOV,
  ORGANIZER_D_MOD_LIMITS,
  type ModActionLimits,
} from '../moderation/organizerConfig';
import {decodeGradient, encodeGradient, gradientFromSeed} from '../media/gradient';
import {encodeIdentityHeader, decodeGradientHeader} from '../profile/displayName';
import {buildIdentityBeacon, encodeProfilePayload, D_IDENTITY_BEACON, D_IDENTITY_PROFILE} from '../profile/identityDoc';
import {toBlindEvent, assembleBlindEvent} from '../blind/blindPost';
import {decodeCommunityKey, setActiveCommunityKey} from '../blind/communityKey';
import {clearAuthorCache} from '../blind/identity';
import {newTokenKeypair} from '../blind/holderProof';
import {EpochWallet, walletKeyFingerprint, type Token} from '../blind/wallet';
import * as drawExchange from '../blind/drawExchange';
import {BlindTokensExhausted} from '../blind/blindSigner';
import {encryptForSpace} from '../channels/groupCrypto';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../blind/contentKey';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../blind/protocol';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

/** A fresh holder-bound token fixture: a real BIP-340 keypair (Q = the wire token, q = the secret)
 *  — P3 requires `token` to be the actual schnorr pubkey of `secret` (see holderProof.ts), or the
 *  holder-binding check rejects the attribution and author resolution falls back to the signer. */
function makeToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: new Uint8Array(32), secret: q};
}

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) {
    throw new Error('enrollment failed in setup');
  }
  return result.session;
}

function newRuntime(secure = new InMemorySecureStorage()) {
  return new AppRuntime({
    secureStorage: secure,
    store: new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
}

describe('AppRuntime lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drives onboarding → fresh enrollment lands UNLOCKED in the feed (bug #4) → locks → unlocked via PIN → duress → onboarding', async () => {
    const runtime = newRuntime();
    await runtime.init();
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');

    // Finish onboarding: stores key + credential and enrolls in one step. A FRESH enrollment lands
    // UNLOCKED — the member just set AND confirmed this exact PIN twice during onboarding, which IS
    // this session's authentication; bouncing straight to a lock-screen re-prompt would be redundant
    // (bug #4).
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(runtime.getSnapshot().enrolled).toBe(true);
    expect(resolveScreen(runtime.getSnapshot())).toBe('feed');

    // A composed post appears in the feed (signed on-device, published, cached).
    await runtime.post('hello world', ['news']);
    const snap = runtime.getSnapshot();
    expect(snap.feed.items.map(i => i.content)).toContain('hello world');
    expect(snap.feed.items[0]!.tags).toEqual(['news']);

    // A LATER lock (inactivity timeout, backgrounding, or a genuine cold start of an already-
    // enrolled app) still gates the app behind the PIN screen — only the transition immediately
    // following enrollment itself skips the prompt.
    runtime.lock();
    expect(resolveScreen(runtime.getSnapshot())).toBe('lock');

    // Standard PIN opens the feed.
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    expect(resolveScreen(runtime.getSnapshot())).toBe('feed');

    // Duress PIN wipes and returns to onboarding (key gone).
    expect(await runtime.submitPin('9999')).toBe('wiped');
    expect(runtime.getSnapshot().enrolled).toBe(false);
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');
    runtime.dispose();
  });

  // ── A1: LOCK GATING — a locked snapshot builds nothing and never touches the store ──────────────
  it('a locked (PIN-screen) snapshot returns empty heavy fields and issues ZERO store.query', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    // A fresh enrollment lands unlocked (bug #4) — lock explicitly to reach the scenario this
    // gating test is actually about: a genuinely locked PIN screen (timeout/backgrounding/restart).
    runtime.lock();
    // A cached post exists but the user is on the lock screen (locked, PIN never re-entered).
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'withheld-while-locked'}, generateSecretKey()));
    // Let the deferred-heavy macrotask fire so ONLY the lock gate remains in effect.
    await jest.runOnlyPendingTimersAsync();
    expect(resolveScreen(runtime.getSnapshot())).toBe('lock');

    const spy = jest.spyOn(store, 'query');
    const snap = runtime.getSnapshot();
    expect(spy).not.toHaveBeenCalled(); // locked → no bucket warmed, no SqliteEventStore.warmKind
    expect(snap.feed.items).toEqual([]); // heavy fields empty behind the lock
    expect(snap.channels).toEqual([]);
    expect(snap.bookmarkedPostIds).toEqual([]);
    spy.mockRestore();
    runtime.dispose();
  });

  // ── M7: legible background sync — snapshot.syncing mirrors the live relay-sync flag, forced false
  //    on the cheap idle/locked path (nothing sync-related renders behind the lock gate) ────────────
  it('exposes a live syncing flag on the snapshot, forced false while locked/idle', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    // Real (unlocked) build: reflects the live relaySyncing() flag one-to-one.
    expect(runtime.getSnapshot().syncing).toBe(false); // no relay sync in progress yet
    runtime.setRelaySyncing(true);
    expect(runtime.getSnapshot().syncing).toBe(true);

    // Locking routes getSnapshot through the cheap idle path (buildIdleSnapshot, A1) — syncing must
    // read false there even though the underlying flag is still set, since no sync UI is on screen.
    runtime.lock();
    await jest.runOnlyPendingTimersAsync();
    expect(resolveScreen(runtime.getSnapshot())).toBe('lock');
    expect(runtime.getSnapshot().syncing).toBe(false);

    // Unlocking returns to the real build, which picks the live flag straight back up.
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    expect(runtime.getSnapshot().syncing).toBe(true);

    runtime.setRelaySyncing(false);
    expect(runtime.getSnapshot().syncing).toBe(false);
    runtime.dispose();
  });

  it('unlocking lifts the gate and the very next emit builds the full (cached) feed', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    // A fresh enrollment lands unlocked (bug #4) — lock explicitly to reach the scenario this test
    // is actually about: unlocking FROM a genuinely locked state.
    runtime.lock();
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'cached-while-locked'}, generateSecretKey()));
    await jest.runOnlyPendingTimersAsync();
    expect(runtime.getSnapshot().feed.items).toEqual([]); // locked → withheld

    let emitted: AppSnapshot | undefined;
    const unsub = runtime.subscribe(s => { emitted = s; });
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    // The unlock emit built the real feed (structural pass is synchronous; scores follow later).
    expect(emitted!.feed.items.some(i => i.content === 'cached-while-locked')).toBe(true);
    expect(runtime.getSnapshot().feed.items.some(i => i.content === 'cached-while-locked')).toBe(true);
    unsub();
    runtime.dispose();
  });

  // ── A2: SPLASH HANDOFF — init's first emit is cheap; the real build lands on the next macrotask ──
  it('defers the heavy feed build off init and lands it on the next macrotask (splash handoff)', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore(); // shared across "relaunch" to stand in for the persisted cache
    const mk = () =>
      new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish: async () => ({accepted: true, message: 'ok'})});

    // Session 1: enroll, unlock, disable the PIN screen so a relaunch routes straight to the feed.
    const rt1 = mk();
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    await rt1.submitPin('1234');
    await rt1.setPinEnabled(false);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'off-critical-path'}, generateSecretKey()));
    rt1.dispose();

    // Session 2 (relaunch): init must NOT build the heavy feed synchronously behind the splash.
    const rt2 = mk();
    await rt2.init();
    expect(rt2.getSnapshot().pinEnabled).toBe(false); // routes straight to the feed (no lock gate)
    expect(rt2.getSnapshot().feed.items).toEqual([]); // heavy build still deferred right after init
    // The deferred macrotask lands the real build.
    await jest.runOnlyPendingTimersAsync();
    expect(rt2.getSnapshot().feed.items.some(i => i.content === 'off-critical-path')).toBe(true);
    rt2.dispose();
  });

  // ── Post-PIN latency: pre-warm structural buckets while LOCKED, one kind per macrotask ──────────
  it('pre-warms the structural feed buckets one kind per macrotask while locked (not one big blocking query)', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore(); // shared across "relaunch" — stands in for the persisted cache
    const mk = () =>
      new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish: async () => ({accepted: true, message: 'ok'})});

    // Session 1: enroll and keep the PIN screen ON, so the relaunch lands genuinely locked. Persist
    // pinEnabled=true EXPLICITLY — a prior test in this file disables it and the AsyncStorage mock
    // persists across tests, so the default would otherwise leak through as 'false'.
    const rt1 = mk();
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    await rt1.setPinEnabled(true);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'cached'}, generateSecretKey()));
    rt1.dispose();

    // Session 2 (relaunch): enrolled + PIN on → lands LOCKED → schedulePrewarmWhileLocked fires.
    const rt2 = mk();
    await rt2.init();
    expect(rt2.getSnapshot().lock).toBe('locked'); // precondition: the pre-warm only runs while locked
    expect(rt2.getSnapshot().feed.items).toEqual([]); // locked → nothing built yet
    const querySpy = jest.spyOn(store, 'query');

    // Drain the deferred timers: the pre-warm queries ONE structural kind per macrotask.
    await jest.runAllTimersAsync();

    const singleKindWarms = querySpy.mock.calls
      .map(c => c[0]?.kinds)
      .filter((k): k is number[] => Array.isArray(k) && k.length === 1)
      .map(k => k[0]!);
    // Every structural feed kind (FEED_STORE_READ_KINDS minus kind-7) was warmed individually…
    expect(singleKindWarms).toEqual(expect.arrayContaining([1, 30023, 1068, 1222, 1111, 1018, 1984, 10000]));
    // …kind-7 (the largest bucket) is intentionally excluded from the pre-warm…
    expect(singleKindWarms).not.toContain(7);
    // …and the pre-warm never batches every kind into one blocking query while locked.
    expect(querySpy.mock.calls.every(c => (c[0]?.kinds?.length ?? 1) === 1)).toBe(true);
    // Still locked → the feed is still withheld (pre-warm only warms buckets, builds nothing).
    expect(rt2.getSnapshot().feed.items).toEqual([]);

    querySpy.mockRestore();
    rt2.dispose();
    // This file has NO per-test AsyncStorage reset, so the persisted pinEnabled flag leaks between
    // tests; the rest of the file implicitly relies on it being 'off' (autolock disabled, so their
    // runOnlyPendingTimers() drains don't lock the app). Restore that shared 'off' state after this
    // test — which deliberately turned it on — so we don't destabilise later tests.
    await AsyncStorage.setItem('stiq.lock.pinEnabled', 'false');
  });

  it('wipeAllData clears the community key, every key-ring slot, and legacy pre-silo secrets (findings #8/#10/#18)', async () => {
    const secure = new InMemorySecureStorage();
    const runtime = newRuntime(secure);
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    // Seed the classes of secret material the emergency kill switch must destroy.
    await secure.setItem('stiq.community.key', 'ab'.repeat(32)); // active community key (the WHO secret)
    await secure.setItem(LEGACY_SK_ITEM, 'cd'.repeat(32)); // a pre-silo raw private key left by migration
    expect((await new KeyRing(secure).listSlots()).length).toBeGreaterThan(0);

    await runtime.wipeAllData();

    // Fresh-install state: community key gone, all key-ring slots + legacy key gone.
    expect(await secure.getItem('stiq.community.key')).toBeNull();
    expect(await secure.getItem(LEGACY_SK_ITEM)).toBeNull();
    expect(await new KeyRing(secure).listSlots()).toEqual([]);
    expect(runtime.getSnapshot().enrolled).toBe(false);
    runtime.dispose();
  });

  it('wipeAllData removes EVERY per-slot / per-community namespaced item — no deanonymising residue (finding M3)', async () => {
    const secure = new TrackingSecureStorage();
    const runtime = newRuntime(secure);
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    // The active identity slot + community id the wipe must enumerate (id === communityId(relayUrl)).
    const slotId = (await new KeyRing(secure).listSlots())[0]!.id;
    const cid = communityId(community.relayUrl);

    // Seed the LIVE per-account (slot) / per-community namespaced state the enrolled app uses — the
    // keys the pre-M3 wipe loop skipped (only sk+cred+relay were removed per slot). SecureStorage-backed.
    // The wallet/outbox/picture-spend are now per-ACCOUNT (slot), joined only by the per-community
    // PUBLIC layer (event cache DB + name/gradient phonebooks) that stays per-CID by design.
    const wallet = walletStorageKeys(slotId);
    const secureNamespaced = [
      namespacedSkItem(slotId),
      credTokenKey(slotId),
      credSigKey(slotId),
      identityRelayKey(slotId),
      identityAtKey(slotId),
      displayNameSelfKey(slotId),
      gradientSelfKey(slotId),
      draftsKey(slotId), // plaintext unsent posts
      dmSentKey(slotId),
      dmReactionsKey(slotId),
      dmFailedWrapsKey(slotId),
      wallet.tokens, // blind-token wallet (bearer secrets) — per account
      wallet.epoch,
      wallet.keyfp,
      outboxKey(slotId), // pending optimistic sends — per account
      pictureSpendKey(slotId), // picture-allowance spend — per account
      sqliteDbKeyItem(cid), // per-community PUBLIC layer (kept per-CID)
      eventsCacheKey(cid),
      displayNameBookKey(cid),
      gradientBookKey(cid),
    ];
    for (const k of secureNamespaced) await secure.setItem(k, 'sentinel');
    // AsyncStorage-backed — SecureStorage.removeItem on these would be a SILENT NO-OP (finding M3):
    const asyncNamespaced = [dmBlocklistKey(slotId), groupsJoinedKey(slotId), spacesEncryptedKey(slotId)];
    for (const k of asyncNamespaced) await AsyncStorage.setItem(k, 'sentinel');

    await runtime.wipeAllData();

    // Every seeded namespaced item is gone — true fresh-install state, via the correct backend.
    for (const k of secureNamespaced) {
      expect(await secure.getItem(k)).toBeNull();
    }
    for (const k of asyncNamespaced) {
      expect(await AsyncStorage.getItem(k)).toBeNull();
    }

    // Future-proof: NO SecureStorage key the app itself wrote that carries the slot id or community
    // id may survive (catches any namespaced helper a later change forgets to wipe).
    for (const k of secure.written) {
      if (k.includes(slotId) || k.includes(cid)) {
        expect(await secure.getItem(k)).toBeNull();
      }
    }
    runtime.dispose();
  });

  it('feedItemFor resolves a post from the store, for logged/auto-hidden posts + saved embeds', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    await runtime.post('logged post body', ['news']);
    const id = runtime.getSnapshot().feed.items.find(i => i.content === 'logged post body')!.id;

    // feedItemFor reads straight from the store (getById), independent of feed visibility — so an
    // auto-hidden post (dropped from the feed) still resolves for the mod-log view + embed picker.
    const item = runtime.feedItemFor(id);
    expect(item?.id).toBe(id);
    expect(item?.content).toBe('logged post body');
    // An id that isn't cached resolves to null (nothing to show / save).
    expect(runtime.feedItemFor('0'.repeat(64))).toBeNull();
    runtime.dispose();
  });

  it('changing my own gradient rebuilds the feed so my posts re-render with it', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    await runtime.post('my idea', []);
    const before = runtime.getSnapshot();
    const mineBefore = before.feed.items.find(i => i.content === 'my idea');
    expect(mineBefore).toBeDefined();
    // Enrollment without a chosen gradient auto-claims a random one (#9), so this is already defined —
    // just not yet the gradient we're about to switch to.
    const autoClaimed = mineBefore!.authorGradient;
    expect(autoClaimed).toBeDefined();

    // Changing the gradient writes NO Nostr event, so the feed-cache's version key doesn't move.
    // The identity-version counter is what forces buildFeed to re-run.
    const grad = {type: 'linear' as const, angle: 90, stops: ['#ff0000', '#00ff00']};
    await runtime.setMyGradient(grad);

    const after = runtime.getSnapshot();
    expect(after.feed).not.toBe(before.feed); // cache invalidated → fresh feed reference
    const mineAfter = after.feed.items.find(i => i.content === 'my idea');
    expect(mineAfter!.authorGradient).toEqual(grad);
    expect(mineAfter!.authorGradient).not.toEqual(autoClaimed);
    runtime.dispose();
  });

  // ── #9: gradient auto-claim — a user who skips choosing one at enrollment still gets a real,
  //    claimed gradient (not the unclaimed seed fallback), so every member converges on the same one.
  it('enrollment WITHOUT a chosen gradient auto-claims a random one, visible via gradientFor/getProfile', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999'); // no gradient arg
    await runtime.submitPin('1234');

    const me = runtime.getSnapshot().currentUserPubkey!;
    const claimed = runtime.gradientFor(me);
    expect(claimed).toBeDefined();
    expect(runtime.getMyGradient()).toEqual(claimed);
    expect(runtime.getProfile(me).gradient).toEqual(claimed);
    runtime.dispose();
  });

  it('enrollment WITH a chosen gradient still uses exactly that one (no auto-claim override)', async () => {
    const runtime = newRuntime();
    await runtime.init();
    const grad = {type: 'radial' as const, angle: 180, stops: ['#111111', '#eeeeee']};
    await runtime.completeEnrollment(await makeSession(), '1234', '9999', grad);
    await runtime.submitPin('1234');

    const me = runtime.getSnapshot().currentUserPubkey!;
    expect(runtime.gradientFor(me)).toEqual(grad);
    runtime.dispose();
  });

  it('announces identity via a relay-blind beacon + encrypted profile when the gradient changes', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const grad = {type: 'linear' as const, angle: 90, stops: ['#ff0000', '#00ff00']};
    await runtime.setMyGradient(grad);

    const appData = store.query({kinds: [Kind.AppData]});
    const beacon = appData.find(e => e.tags.some(t => t[0] === 'd' && t[1] === D_IDENTITY_BEACON));
    const profile = appData.find(e => e.tags.some(t => t[0] === 'd' && t[1] === D_IDENTITY_PROFILE));

    // Beacon: relay-blind SOH header carrying the gradient (the relay never interprets it).
    expect(beacon).toBeDefined();
    expect(decodeGradientHeader(beacon!.content)).toBe(encodeGradient(grad));
    // Encrypted profile: NIP-44 ciphertext — the plaintext gradient is NOT visible to the relay.
    expect(profile).toBeDefined();
    expect(profile!.content).not.toContain('ff0000');
    expect(profile!.content).not.toBe(encodeProfilePayload('', encodeGradient(grad)));
    runtime.dispose();
  });

  it('learns a peer’s name + gradient from their identity beacon (no post required)', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const peerSK = generateSecretKey();
    const peerPub = getPublicKey(peerSK);
    const peerGrad = {type: 'linear' as const, angle: 210, stops: ['#123456', '#abcdef']};
    const beacon = finalizeEvent(buildIdentityBeacon('Peer', encodeGradient(peerGrad), 3000)!, peerSK);
    store.save(beacon);
    runtime.handleIncomingEvent(beacon);

    const prof = runtime.getProfile(peerPub);
    expect(prof.name).toBe('Peer');
    // Compare via the wire form — that's exactly what propagates and is rendered.
    expect(encodeGradient(prof.gradient!)).toBe(encodeGradient(peerGrad));
    runtime.dispose();
  });

  it('adopts our own newer encrypted profile from another device, ignoring a stale one', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    expect(runtime.getMyDisplayName()).toBe('');
    // Enrollment without a chosen gradient auto-claims a random one (#9) rather than leaving this
    // null; the cross-device adoption below must still win over it (adopt always overwrites when a
    // valid gradient is present in the payload, regardless of what's already locally claimed).
    expect(runtime.getMyGradient()).not.toBeNull();

    // "Device B" (same key) publishes a newer encrypted profile; we adopt it across devices.
    const identity = (runtime as unknown as {identity: {buildEncryptedProfile: (p: string, at: number) => Promise<import('nostr-tools/pure').Event>}}).identity;
    const adopt = (e: import('nostr-tools/pure').Event): Promise<void> =>
      (runtime as unknown as {adoptEncryptedProfile: (ev: import('nostr-tools/pure').Event) => Promise<void>}).adoptEncryptedProfile(e);

    const grad = {type: 'linear' as const, angle: 45, stops: ['#010203', '#040506']};
    const newer = await identity.buildEncryptedProfile(encodeProfilePayload('Roamer', encodeGradient(grad)), 5000);
    await adopt(newer);
    expect(runtime.getMyDisplayName()).toBe('Roamer');
    expect(runtime.getMyGradient()).toEqual(grad);

    // A stale copy (older created_at) must NOT clobber the fresher adopted identity.
    const stale = await identity.buildEncryptedProfile(encodeProfilePayload('Old', ''), 1);
    await adopt(stale);
    expect(runtime.getMyDisplayName()).toBe('Roamer');
    runtime.dispose();
  });

  it('routes an INGESTED newer self identity-enc event to adoptEncryptedProfile and converges (multi-device wiring)', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    expect(runtime.getMyDisplayName()).toBe('');

    // "Device B" (same key) publishes a newer encrypted profile; it arrives via the self-profile
    // subscription and is ingested through the SAME handleIncomingEvent path a relay EVENT drives.
    const identity = (runtime as unknown as {
      identity: {buildEncryptedProfile: (p: string, at: number) => Promise<import('nostr-tools/pure').Event>};
    }).identity;
    const grad = {type: 'linear' as const, angle: 45, stops: ['#010203', '#040506']};
    const evt = await identity.buildEncryptedProfile(encodeProfilePayload('Roamer', encodeGradient(grad)), 5000);
    // The carrier is our OWN pubkey + the identity-enc d-tag — exactly the guard the ingest handler
    // keys the adopt on (event.pubkey === myPubkey && d === D_IDENTITY_PROFILE).
    expect(evt.pubkey).toBe(runtime.getPubkey());
    expect(evt.tags).toContainEqual(['d', D_IDENTITY_PROFILE]);

    const adoptSpy = jest.spyOn(
      runtime as unknown as {adoptEncryptedProfile: (e: import('nostr-tools/pure').Event) => Promise<void>},
      'adoptEncryptedProfile',
    );
    store.save(evt);
    runtime.handleIncomingEvent(evt); // routes synchronously to adoptEncryptedProfile (fire-and-forget)
    expect(adoptSpy).toHaveBeenCalledWith(evt);
    await adoptSpy.mock.results[0]!.value; // let the adoption promise settle → convergence completes

    expect(runtime.getMyDisplayName()).toBe('Roamer');
    expect(runtime.getMyGradient()).toEqual(grad);
    runtime.dispose();
  });

  it('resolves to onboarding when no secure storage is available', async () => {
    const runtime = new AppRuntime({secureStorage: null, store: new InMemoryEventStore()});
    await runtime.init();
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');
    expect(await runtime.submitPin('1234')).toBe('rejected');
    runtime.dispose();
  });

  it('decrypts a received DM into the inbox and the duress wipe clears it', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    const session = await makeSession();
    await runtime.completeEnrollment(session, '1234', '9999');
    await runtime.submitPin('1234');

    // Someone seals a DM to our pubkey; it lands in our cache.
    const senderSK = generateSecretKey();
    store.save(sealDM(senderSK, session.pubkey, 'hello there'));
    await runtime.refreshInbox();

    const inbox = runtime.getSnapshot().inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.messages[0]!.text).toBe('hello there');
    expect(inbox[0]!.peer).toBe(getPublicKey(senderSK));

    // Duress wipes the gift wraps with the cache.
    await runtime.submitPin('9999');
    expect(runtime.getSnapshot().inbox).toEqual([]);
    expect(store.size()).toBe(0);
    runtime.dispose();
  });

  it('notifies subscribers with snapshots', async () => {
    const runtime = newRuntime();
    const seen: boolean[] = [];
    runtime.subscribe(s => seen.push(s.enrolled));
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(seen).toContain(true);
    runtime.dispose();
  });

  // ── A8: loadPubkey fast path — decode the persisted npub instead of reading the secret key ──────
  it('loadPubkey resolves the hex pubkey from the persisted npub, without a second secret-key read', async () => {
    const secure = new InMemorySecureStorage();
    const runtime = newRuntime(secure);
    await runtime.init();
    const session = await makeSession();
    await runtime.completeEnrollment(session, '1234', '9999');
    await runtime.submitPin('1234');
    expect(runtime.getSnapshot().currentUserPubkey).toBe(session.pubkey);
    const {slots} = await runtime.listKeySlots();
    expect(slots).toHaveLength(1);
    const skItem = namespacedSkItem(slots[0]!.id);
    runtime.dispose();

    // "Relaunch" against the same storage and count reads of the raw secret-key entry during init().
    const getItemSpy = jest.spyOn(secure, 'getItem');
    const runtime2 = newRuntime(secure);
    await runtime2.init();

    // The pubkey resolves correctly — byte-identical to the original enrollment...
    expect(runtime2.getSnapshot().currentUserPubkey).toBe(session.pubkey);
    // ...and the secret key is read exactly ONCE during boot, by KeyStore.isEnrolled()'s presence
    // check. The OLD loadPubkey (identity.info() → store.publicKey()) read it a SECOND time — plus ran
    // secp256k1 getPublicKey() — purely to learn the pubkey; the new npub-decode fast path never does.
    const skReads = getItemSpy.mock.calls.filter(call => call[0] === skItem).length;
    expect(skReads).toBe(1);

    getItemSpy.mockRestore();
    runtime2.dispose();
  });
});

describe('AppRuntime.getAuthorEventIds (log-batch source for the moderator console)', () => {
  const kindPost = 1;
  const kindArticle = 30023;

  it("returns only the target author's feed-post ids across post kinds", () => {
    const store = new InMemoryEventStore();
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const pkA = getPublicKey(skA);

    const p1 = finalizeEvent({kind: kindPost, created_at: 10, tags: [], content: 'a-post-1'}, skA);
    const p2 = finalizeEvent({kind: kindPost, created_at: 20, tags: [], content: 'a-post-2'}, skA);
    const art = finalizeEvent(
      {kind: kindArticle, created_at: 30, tags: [['d', 'x']], content: 'a-article'},
      skA,
    );
    const other = finalizeEvent({kind: kindPost, created_at: 40, tags: [], content: 'b-post'}, skB);
    [p1, p2, art, other].forEach(e => store.save(e));

    const runtime = new AppRuntime({secureStorage: new InMemorySecureStorage(), store});
    const ids = runtime.getAuthorEventIds(pkA);

    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
    expect(ids).toContain(art.id);
    expect(ids).not.toContain(other.id);
    runtime.dispose();
  });
});

// ── Version-keyed derived-value caches in getSnapshot (findings #10/#11/#12/#13) ──────────────────
describe('AppRuntime getSnapshot() version-keyed derived caches', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // An organizer whose signed 30078/1984 events are honoured (the organizer is always a moderator).
  const orgSK = generateSecretKey();
  const orgHex = getPublicKey(orgSK);
  const orgNpub = nip19.npubEncode(orgHex);

  async function enrolledRuntime(store: InMemoryEventStore, autoLockMs = 60_000) {
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs,
      organizerNpub: orgNpub,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    return runtime;
  }

  /** Organizer-signed kind-1984 stiq-action on an event id (lock/pin/hide/…). */
  const modAction = (targetId: string, action: string, at: number) =>
    finalizeEvent({kind: Kind.Report, created_at: at, tags: [['e', targetId], ['stiq-action', action]], content: ''}, orgSK);
  /** Organizer-signed kind-1984 ban on an author pubkey. */
  const banAction = (authorHex: string, at: number) =>
    finalizeEvent({kind: Kind.Report, created_at: at, tags: [['p', authorHex], ['stiq-action', 'ban']], content: 'banned'}, orgSK);
  /** Organizer-signed kind-30078 limits doc. */
  const limitsDoc = (allowVoice: boolean, at: number) =>
    finalizeEvent({kind: Kind.AppData, created_at: at, tags: [['d', 'stiq:limits']], content: JSON.stringify({allow_voice: allowVoice})}, orgSK);
  /** Organizer-signed kind-30078 picture-limits doc (compact wire shape). */
  const pictureRulesDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent({kind: Kind.AppData, created_at: at, tags: [['d', 'stiq:picture-limits']], content: JSON.stringify(wire)}, orgSK);
  /** Organizer-signed kind-30078 audio-limits doc (compact wire shape). */
  const audioRulesDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent({kind: Kind.AppData, created_at: at, tags: [['d', 'stiq:audio-limits']], content: JSON.stringify(wire)}, orgSK);

  it('a cache-hit snapshot (no intervening save) issues ZERO store.query calls', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    runtime.getSnapshot(); // warm every version-keyed cache (roster, overlay, banned, limits, perms,
    // bookmarks, subscriptions, feed, channels, groups)
    const spy = jest.spyOn(store, 'query');
    runtime.getSnapshot();
    expect(spy).not.toHaveBeenCalled(); // all derived values served from cache — no bucket scans
    spy.mockRestore();
    runtime.dispose();
  });

  it('a new kind-1984 lock report invalidates the moderation overlay on the next snapshot', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const before = runtime.getSnapshot();
    expect(before.lockedPostIds).not.toContain('post-1');

    store.save(modAction('post-1', 'lock', 1000)); // organizer locks a post
    const after = runtime.getSnapshot();
    expect(after.lockedPostIds).toContain('post-1'); // overlay recomputed → lock visible
    expect(after.lockedPostIds).not.toBe(before.lockedPostIds); // fresh array identity on real change
    runtime.dispose();
  });

  it('a new kind-1984 ban invalidates the banned-author set (feed rebuilds)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const bannedSK = generateSecretKey();
    const bannedHex = getPublicKey(bannedSK);
    // A visible post by the soon-to-be-banned author.
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'from-banned'}, bannedSK));
    const before = runtime.getSnapshot();
    expect(before.feed.items.some(i => i.content === 'from-banned')).toBe(true);

    store.save(banAction(bannedHex, 1000)); // organizer bans the author
    const after = runtime.getSnapshot();
    expect(after.feed.items.some(i => i.content === 'from-banned')).toBe(false); // banned → dropped
    runtime.dispose();
  });

  it('a new kind-30078 limits doc invalidates the cached limits (allowVoice flips)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    expect(runtime.getSnapshot().allowVoice).toBe(false); // no limits doc yet

    store.save(limitsDoc(true, 1000)); // organizer enables voice
    expect(runtime.getSnapshot().allowVoice).toBe(true); // cache invalidated by the 30078 version bump
    runtime.dispose();
  });

  it('a live stiq:picture-limits event syncs the snapshot pictureRules', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    // Default before any organizer doc arrives.
    expect(runtime.getSnapshot().pictureRules.maxRes).toBe(DEFAULT_PICTURE_RULES.maxRes);
    // Simulate the organizer's kind-30078 doc arriving live over the relay (App.tsx wires
    // relay.onEvent → handleIncomingEvent → applyOrgConfig).
    runtime.handleIncomingEvent(pictureRulesDoc({al: true, ab: 999, ph: 12, mbp: 4096, mr: 128, mc: 32}, 1000));
    const r = runtime.getSnapshot().pictureRules;
    expect(r.maxRes).toBe(128);
    expect(r.maxColours).toBe(32);
    expect(r.allowanceBytes).toBe(999);
    runtime.dispose();
  });

  it('a live stiq:audio-limits event syncs the snapshot audioRules (recorder knobs + caps)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    expect(runtime.getSnapshot().audioRules.bitrateKbps).toBe(DEFAULT_AUDIO_RULES.bitrateKbps);
    runtime.handleIncomingEvent(audioRulesDoc({al: true, ab: 500_000, ph: 24, mbc: 100_000, md: 45, br: 16, sr: 16_000}, 1000));
    const r = runtime.getSnapshot().audioRules;
    expect(r.bitrateKbps).toBe(16); // the recorder will encode at this bitrate
    expect(r.maxDurationSec).toBe(45);
    expect(r.maxBytesPerClip).toBe(100_000);
    expect(r.allowanceBytes).toBe(500_000);
    runtime.dispose();
  });

  it('moderatorHides is version-cached: a repeated getThread does NOT re-scan reports/mutes, a new report does', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const authorSK = generateSecretKey();
    const post = finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'root'}, authorSK);
    store.save(post);
    runtime.getThread(post.id); // warm the version-keyed moderatorHides cache

    // Count only the report(1984)/mute-list(10000) scans moderatorHides performs — buildThread's own
    // comment(1111)/post(1) queries are intentionally uncached and run every call.
    const modScans = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([q]) =>
        (q as {kinds?: number[]})?.kinds?.some(k => k === Kind.Report || k === Kind.MuteList),
      ).length;

    const spy = jest.spyOn(store, 'query');
    runtime.getThread(post.id); // same report/mute version → served from cache
    expect(modScans(spy)).toBe(0);
    spy.mockRestore();

    // A new moderator report bumps versionOf([Report]) → the cache must invalidate and re-scan.
    store.save(modAction(post.id, 'hide', 1000));
    const spy2 = jest.spyOn(store, 'query');
    runtime.getThread(post.id);
    expect(modScans(spy2)).toBeGreaterThan(0);
    spy2.mockRestore();
    runtime.dispose();
  });

  it('a new kind-30078 roster invalidates the moderator roster (isModerator reflects it)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getSnapshot().currentUserPubkey!;
    expect(runtime.getSnapshot().isModerator).toBe(false); // not on any roster yet

    // Organizer publishes a roster that names me as a moderator.
    store.save(
      finalizeEvent(
        {kind: Kind.AppData, created_at: 1000, tags: [['d', 'stiq:moderators'], ['p', me]], content: ''},
        orgSK,
      ),
    );
    expect(runtime.getSnapshot().isModerator).toBe(true); // roster cache invalidated
    runtime.dispose();
  });

  it('bookmarkedPostIds / lockedPostIds keep a STABLE array identity when nothing relevant changes', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const a = runtime.getSnapshot();
    const b = runtime.getSnapshot();
    expect(b.bookmarkedPostIds).toBe(a.bookmarkedPostIds); // same reference — memo deps stop churning
    expect(b.lockedPostIds).toBe(a.lockedPostIds);
    expect(b.pinnedPostIds).toBe(a.pinnedPostIds);
    expect(b.subscribedChannelIds).toBe(a.subscribedChannelIds);
    runtime.dispose();
  });

  it('bookmarkedPostIds array identity CHANGES when a bookmark lands', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'savable'}, generateSecretKey()));
    const before = runtime.getSnapshot();
    const postId = before.feed.items.find(i => i.content === 'savable')!.id;

    await runtime.toggleBookmark(postId);
    const after = runtime.getSnapshot();
    expect(after.bookmarkedPostIds).not.toBe(before.bookmarkedPostIds); // fresh identity on real change
    expect(after.bookmarkedPostIds).toContain(postId);
    runtime.dispose();
  });

  it('getEventScore serves from a version-cached reaction tally and invalidates on a new reaction', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const voterSK = generateSecretKey();
    const upvote = (at: number) =>
      finalizeEvent({kind: Kind.Reaction, created_at: at, tags: [['e', 'target-x']], content: '+'}, voterSK);

    store.save(upvote(1000));
    runtime.getEventScore('target-x'); // warm the tally
    const spy = jest.spyOn(store, 'query');
    // Two more score reads without a new reaction: served from the cached map, no re-scan.
    expect(runtime.getEventScore('target-x').score).toBe(1);
    expect(runtime.getEventScore('target-x').score).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // A second reaction (different signer) bumps the kind-7 version → tally rebuilds.
    store.save(finalizeEvent({kind: Kind.Reaction, created_at: 1001, tags: [['e', 'target-x']], content: '+'}, generateSecretKey()));
    expect(runtime.getEventScore('target-x').score).toBe(2);
    runtime.dispose();
  });

  // ── A2: POSTS-FIRST SCORING — the structural feed lands first (score 0), a follow-up pass fills in
  //    the kind-7 reaction scores and re-emits. ────────────────────────────────────────────────────
  it('shows the posts-first feed with score 0, then fills reaction scores in on a follow-up pass', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const post = finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'scored-post'}, generateSecretKey());
    store.save(post);
    store.save(finalizeEvent({kind: Kind.Reaction, created_at: 1000, tags: [['e', post.id]], content: '+'}, generateSecretKey()));

    // Posts-first: the post is present (structural pass), but its score is still 0 (kind-7 not bucketed).
    const before = runtime.getSnapshot().feed.items.find(i => i.id === post.id)!;
    expect(before).toBeDefined();
    expect(before.score).toBe(0);

    // The scored follow-up pass runs on the next macrotask and re-emits WITH the real reaction score.
    await jest.runOnlyPendingTimersAsync();
    const after = runtime.getSnapshot().feed.items.find(i => i.id === post.id)!;
    expect(after.score).toBe(1);
    runtime.dispose();
  });

  // ── B3/P1-4: the scored follow-up pass chunk-warms every visible item's cache entry across
  //    multiple macrotasks (instead of rebuilding the whole feed in one synchronous shot) ─────────
  it('chunks the scored item-cache warm across macrotasks and lands an identical, fully-scored feed', async () => {
    const store = new InMemoryEventStore();
    // Idle-lock OFF for this test: the pending-timer waves below fire EVERY pending timer, and the
    // fixture's 60s autolock is pending from enrollment — firing it locks the app and blanks the
    // snapshot mid-assert (the failure mode the runAllTimersAsync note below describes). This test
    // is about chunk-warm equivalence, not lock gating, so it must not arm an idle timer at all.
    const runtime = await enrolledRuntime(store, Infinity);

    // More than one item-warm chunk of posts, each with a single upvote, so the scored pass must
    // span ≥2 chunks and yield a real setTimeout(0) macrotask between them.
    const authorSK = generateSecretKey();
    const postCount = ITEM_WARM_CHUNK_ROWS * 2 + 10;
    const posts = Array.from({length: postCount}, (_, i) =>
      finalizeEvent({kind: Kind.Post, created_at: 900 + i, tags: [], content: `chunked-post-${i}`}, authorSK),
    );
    posts.forEach(p => store.save(p));
    posts.forEach(p =>
      store.save(finalizeEvent({kind: Kind.Reaction, created_at: 2000, tags: [['e', p.id]], content: '+'}, generateSecretKey())),
    );

    // Posts-first: the structural feed lands with every post present but still unscored.
    const before = runtime.getSnapshot();
    const beforeIds = before.feed.items.map(i => i.id).sort();
    expect(beforeIds.length).toBe(postCount);
    expect(before.feed.items.every(i => i.score === 0)).toBe(true);

    // The scored pass must yield MORE than once (the initial scheduleScorePass timer PLUS at least
    // one item-warm chunk boundary) to finish a feed this size — proving the item-cache warm is
    // itself spread across macrotasks, not done in one synchronous shot. Drain in bounded waves of
    // `runOnlyPendingTimersAsync` (NOT `runAllTimersAsync`, which would also advance the fake clock
    // far enough to fire the 60s autolock timer and blank the snapshot) — each wave fires only the
    // macrotasks already due, so a multi-chunk warm needs several waves, one per chunk boundary.
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    for (let wave = 0; wave < 10; wave++) {
      await jest.runOnlyPendingTimersAsync();
    }
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(1);
    setTimeoutSpy.mockRestore();

    // The final feed is byte-identical to what an unchunked build would have produced: same posts,
    // every one fully scored — the chunking only spread the SAME work across more macrotasks.
    const after = runtime.getSnapshot();
    expect(after.feed.items.map(i => i.id).sort()).toEqual(beforeIds);
    expect(after.feed.items.every(i => i.score === 1)).toBe(true);
    runtime.dispose();
  });

  // ── #6: scoped invalidation signals — snapshot.storeVersions ─────────────────────────────────────
  // MainScreen's channel/group memos can't key on `feed` (the feed's own version deliberately
  // EXCLUDES LiveChat/LiveActivity/GroupChat — see FEED_STORE_READ_KINDS' doc comment), so these
  // dedicated counters are what let a later wave detect a channel/group-only write.

  it('storeVersions.channels bumps on a channel-relevant kind, leaving feed + storeVersions.groups untouched', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const before = runtime.getSnapshot();

    // A channel broadcast (kind 1311) is NOT a feed-kind event, so `feed` must keep its reference.
    store.save(
      finalizeEvent({kind: Kind.LiveChat, created_at: 900, tags: [['a', `30311:${'0'.repeat(64)}:c1`]], content: 'hi channel'}, generateSecretKey()),
    );
    const after = runtime.getSnapshot();
    expect(after.feed).toBe(before.feed); // unaffected — the pre-existing gap #6 addresses
    expect(after.storeVersions.channels).not.toBe(before.storeVersions.channels);
    expect(after.storeVersions.groups).toBe(before.storeVersions.groups); // unrelated signal untouched
    runtime.dispose();
  });

  it('storeVersions.groups bumps on a group-relevant kind (chat/thread/reply/reaction), leaving feed + storeVersions.channels untouched', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const before = runtime.getSnapshot();

    // A group chat message (kind 9) is NOT a feed-kind event either.
    store.save(finalizeEvent({kind: GroupKind.Chat, created_at: 900, tags: [['h', 'g1']], content: 'hi group'}, generateSecretKey()));
    const after = runtime.getSnapshot();
    expect(after.feed).toBe(before.feed);
    expect(after.storeVersions.groups).not.toBe(before.storeVersions.groups);
    expect(after.storeVersions.channels).toBe(before.storeVersions.channels);
    runtime.dispose();
  });

  it('storeVersions.identity bumps when a peer\'s name/gradient is learned from a non-feed-kind event, but not on a repeat sighting of the SAME identity', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const peerSK = generateSecretKey();
    const peerPub = getPublicKey(peerSK);

    const before = runtime.getSnapshot();
    // Group chat (kind 9) is not a feed-kind event, so only the identity counter (not feedVer) can
    // signal that this peer's name is now known — see learnNameFromContent's doc comment.
    const withHeader = encodeIdentityHeader('hi group', 'Peer', '');
    const chat = finalizeEvent({kind: GroupKind.Chat, created_at: 900, tags: [['h', 'g1']], content: withHeader}, peerSK);
    store.save(chat);
    runtime.handleIncomingEvent(chat);
    const after = runtime.getSnapshot();
    expect(after.storeVersions.identity).not.toBe(before.storeVersions.identity);
    expect(runtime.getProfile(peerPub).name).toBe('Peer');

    // A repeat sighting of the IDENTICAL name must not bump the counter again (no needless rebuild).
    const chat2 = finalizeEvent({kind: GroupKind.Chat, created_at: 950, tags: [['h', 'g1']], content: withHeader}, peerSK);
    store.save(chat2);
    runtime.handleIncomingEvent(chat2);
    const after2 = runtime.getSnapshot();
    expect(after2.storeVersions.identity).toBe(after.storeVersions.identity);
    runtime.dispose();
  });

  it('storeVersions.thread bumps on a new comment (open thread refreshes) but NOT on an unrelated reaction', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const before = runtime.getSnapshot();

    // A background like (kind-7) is exactly the churn A2 wants an open thread to ignore — the thread
    // signal MUST stay steady so MainScreen's threadNodes memo does not rebuild on every emit.
    store.save(finalizeEvent({kind: Kind.Reaction, created_at: 900, tags: [['e', 'x']], content: '+'}, generateSecretKey()));
    const afterLike = runtime.getSnapshot();
    expect(afterLike.storeVersions.thread).toBe(before.storeVersions.thread);

    // A new kind-1111 comment IS thread content — the signal must bump so a genuinely new comment on
    // the open thread still refreshes it.
    store.save(finalizeEvent({kind: Kind.Comment, created_at: 950, tags: [['E', 'root']], content: 'reply'}, generateSecretKey()));
    const afterComment = runtime.getSnapshot();
    expect(afterComment.storeVersions.thread).not.toBe(afterLike.storeVersions.thread);
    runtime.dispose();
  });

  // ── heaviness-audit #6: organizer-config readers extended with the SAME versionOf([AppData])-keyed
  //    cache pattern as cachedLimits/cachedPermissions above (getCommunityConfig, getLogPage,
  //    getGovernance, checkModLimit, checkLimit) — behavior-identical, just cached. ──────────────────
  const communityConfigDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent(
      {kind: Kind.AppData, created_at: at, tags: [['d', ORGANIZER_D_COMMUNITY]], content: JSON.stringify(wire)},
      orgSK,
    );
  const logPageWireDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent(
      {kind: Kind.AppData, created_at: at, tags: [['d', ORGANIZER_D_LOG_PAGE]], content: JSON.stringify(wire)},
      orgSK,
    );
  const governanceDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent(
      {kind: Kind.AppData, created_at: at, tags: [['d', ORGANIZER_D_GOV]], content: JSON.stringify(wire)},
      orgSK,
    );
  const modLimitsWireDoc = (wire: Record<string, unknown>, at: number) =>
    finalizeEvent(
      {kind: Kind.AppData, created_at: at, tags: [['d', ORGANIZER_D_MOD_LIMITS]], content: JSON.stringify(wire)},
      orgSK,
    );

  /** Count only kind-30078 (AppData) store.query scans — the config-doc reads these caches collapse
   *  to a hit; unrelated scans (e.g. checkModLimit's own per-user Report tally, or getLogPage's
   *  live channel/identity resolution) are excluded, mirroring the moderatorHides test's modScans. */
  const appDataScans = (spy: jest.SpyInstance) =>
    spy.mock.calls.filter(([q]) => (q as {kinds?: number[]})?.kinds?.includes(Kind.AppData)).length;

  it('getCommunityConfig() is version-cached: a repeat call issues zero AppData scans, a new stiq:community doc invalidates it', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    expect(runtime.getCommunityConfig()?.name).toBeUndefined(); // no doc yet — warms the cache (miss)

    const spy = jest.spyOn(store, 'query');
    expect(runtime.getCommunityConfig()?.name).toBeUndefined(); // same AppData version → cache hit
    expect(appDataScans(spy)).toBe(0);
    spy.mockRestore();

    store.save(communityConfigDoc({nm: 'New Name'}, 1000)); // bumps versionOf([AppData])
    expect(runtime.getCommunityConfig()?.name).toBe('New Name'); // cache invalidated → recomputed
    runtime.dispose();
  });

  it('getGovernance() is version-cached: a repeat call issues zero AppData scans, a new stiq:gov doc invalidates it', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    expect(runtime.getGovernance()).toBeUndefined(); // no doc yet — warms the cache (miss)

    const spy = jest.spyOn(store, 'query');
    expect(runtime.getGovernance()).toBeUndefined(); // cache hit
    expect(appDataScans(spy)).toBe(0);
    spy.mockRestore();

    store.save(governanceDoc({cc: 'mods'}, 1000));
    expect(runtime.getGovernance()?.channelCreate).toBe('mods'); // cache invalidated → recomputed
    runtime.dispose();
  });

  it("getLogPage()'s underlying config doc is version-cached: a repeat call issues zero AppData scans, a new stiq:log-page doc invalidates it", async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    expect(runtime.getLogPage()?.note).toBeUndefined(); // no doc yet — warms the cache (miss)

    const spy = jest.spyOn(store, 'query');
    runtime.getLogPage();
    // currentLogPage/currentGuide/currentFeaturedSpaces all served from the cache — zero AppData
    // scans. getLogPage() still re-resolves live channels/groups/identities every call (unrelated
    // kinds), which is why this filters to AppData specifically rather than asserting zero calls.
    expect(appDataScans(spy)).toBe(0);
    spy.mockRestore();

    store.save(logPageWireDoc({note: {ver: 'v1', b: 'Hello from the organizer'}, picks: [], people: []}, 1000));
    expect(runtime.getLogPage()?.note?.body).toBe('Hello from the organizer'); // cache invalidated
    runtime.dispose();
  });

  it("checkModLimit()'s config lookup (currentModLimits) is version-cached, keyed on versionOf([AppData]) + organizer", async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    // Exercise the private cache accessor directly (mirrors the internals() idiom in
    // AppRuntime.rosterOverlay.test.ts / AppRuntime.decryptCache.test.ts): checkModLimit()'s
    // OBSERVABLE return additionally depends on the caller's own report tally, which would need
    // unrelated setup to move — the cache invalidation itself is precisely what changed here.
    const internals = runtime as unknown as {cachedModLimits: () => ModActionLimits | undefined};
    expect(internals.cachedModLimits()).toBeUndefined(); // no doc yet — warms the cache (miss)

    const spy = jest.spyOn(store, 'query');
    expect(internals.cachedModLimits()).toBeUndefined(); // cache hit
    expect(appDataScans(spy)).toBe(0);
    spy.mockRestore();

    store.save(modLimitsWireDoc({ban: {d: 3, w: 10}}, 1000));
    expect(internals.cachedModLimits()?.ban).toEqual({daily: 3, weekly: 10}); // cache invalidated
    runtime.dispose();
  });

  it('checkLimit() now reuses the SAME version-cached limits as getSnapshot().allowVoice — a call right after getSnapshot() issues zero AppData scans', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    runtime.getSnapshot(); // warms cachedLimits() via the allowVoice field

    const spy = jest.spyOn(store, 'query');
    // Before this fix, checkLimit() called currentLimits() directly, bypassing the cache
    // getSnapshot() just warmed, and re-scanning the AppData bucket on every call.
    expect(runtime.checkLimit('posts')).toBeNull(); // no stiq:limits doc published
    expect(appDataScans(spy)).toBe(0);
    spy.mockRestore();
    runtime.dispose();
  });
});

// ── DM decrypt efficiency: chunk-yield, per-peer key cache, negative-cache persistence, pruning,
//    and debounced sent-DM persistence (findings #1–#5) ─────────────────────────────────────────
describe('AppRuntime DM decrypt efficiency', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const enroll = async (secure: InMemorySecureStorage, store: InMemoryEventStore) => {
    const runtime = new AppRuntime({
      secureStorage: secure,
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    return runtime;
  };

  /** A syntactically-valid but permanently-undecryptable-for-us kind-1059 wrap with a chosen age. */
  const alienWrap = (createdAt: number): Event =>
    finalizeEvent(
      {kind: Kind.GiftWrap, created_at: createdAt, tags: [['p', getPublicKey(generateSecretKey())]], content: 'not-nip44'},
      generateSecretKey(),
    );

  it('chunks the historical decrypt and yields the JS thread between chunks (finding #1)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enroll(new InMemorySecureStorage(), store);
    // More than one DECRYPT_CHUNK (32) of undecryptable wraps → the decrypt must span ≥2 chunks and
    // yield a macrotask in between.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 80; i++) store.save(alienWrap(now));

    let done = false;
    const p = runtime.refreshInbox().then(() => {
      done = true;
    });
    // The loop yielded via setTimeout(0) after the first chunk — without advancing timers it cannot
    // have finished all 80 wraps.
    await Promise.resolve();
    expect(done).toBe(false);

    await jest.runAllTimersAsync();
    await p;
    expect(done).toBe(true);
    runtime.dispose();
  });

  it('persists the negative decrypt cache and honours it on relaunch (finding #4)', async () => {
    const secure = new InMemorySecureStorage();
    const decoy = alienWrap(Math.floor(Date.now() / 1000));

    // Session 1: an undecryptable decoy wrap is attempted once, fails, and is remembered.
    const store1 = new InMemoryEventStore();
    const rt1 = await enroll(secure, store1);
    store1.save(decoy);
    await rt1.refreshInbox();
    await jest.runOnlyPendingTimersAsync(); // let the debounced negative-cache write flush
    // The decoy id is now in the persisted negative cache (some stiq.dm.failedWraps.* key).
    const persisted = [...(secure as unknown as {map: Map<string, string>}).map.entries()]
      .find(([k]) => k.startsWith('stiq.dm.failedWraps'));
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted![1]) as string[]).toContain(decoy.id);
    rt1.dispose();

    // Session 2: a fresh runtime over the SAME storage + a fresh store that still holds the decoy.
    const store2 = new InMemoryEventStore();
    store2.save(decoy);
    const rt2 = new AppRuntime({
      secureStorage: secure,
      store: store2,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await rt2.init();
    await rt2.submitPin('1234');
    // The seeded negative cache means refreshInbox must NOT re-derive any conversation key for the
    // known-alien decoy.
    const spy = jest.spyOn(nip44.utils, 'getConversationKey');
    await rt2.whenInboxReady();
    await rt2.refreshInbox();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    rt2.dispose();
  });

  it('prunes undecryptable wraps only once they age past the backdating window (finding #3)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enroll(new InMemorySecureStorage(), store);
    const now = Math.floor(Date.now() / 1000);
    const oldWrap = alienWrap(now - 4 * 24 * 60 * 60); // 4 days old — safely past the 3-day window
    const recentWrap = alienWrap(now - 60 * 60); // 1 hour old — still inside the window
    store.save(oldWrap);
    store.save(recentWrap);

    await runtime.refreshInbox();
    await jest.runOnlyPendingTimersAsync();

    // The aged alien wrap is deleted from the store; the recent one is retained (could still be a
    // legitimately back-dated genuine wrap).
    expect(store.has(oldWrap.id)).toBe(false);
    expect(store.has(recentWrap.id)).toBe(true);
    runtime.dispose();
  });

  it('coalesces the three sent-DM persists of one send burst into a single keystore write (finding #5)', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore();
    const runtime = await enroll(secure, store);
    // Replace the slow PoW mine with a fast well-formed wrap (mirrors dmQueue.test.ts).
    (runtime as unknown as {identity: {sealDM: (pk: string, text: string) => Promise<{wrap: Event; rumorId: string}>}}).identity.sealDM =
      async (pk: string, text: string) => ({
        wrap: finalizeEvent({kind: Kind.GiftWrap, created_at: Math.floor(Date.now() / 1000), tags: [['p', pk]], content: text}, generateSecretKey()),
        rumorId: 'r'.repeat(64),
      });

    const setItem = jest.spyOn(secure, 'setItem');
    const sentWrites = () => setItem.mock.calls.filter(([k]) => k.startsWith('stiq.dm.sent')).length;

    await runtime.sendDM(getPublicKey(generateSecretKey()), 'one burst');
    await jest.runOnlyPendingTimersAsync(); // fire the debounced write + any deliver() follow-ups
    // sendDM writes the sent echo three times logically (optimistic, wrap-id adoption, status flip),
    // but the debounce collapses the burst to ONE keystore write.
    expect(sentWrites()).toBe(1);
    setItem.mockRestore();
    runtime.dispose();
  });
});

// ── Fix 1: LOCAL feed author mute — device-only; filters feed + comments; PUBLISHES NOTHING ────────
// The feed "Mute this author" must never publish (no kind-10000 mute list, no event) so it leaks
// nothing to the relay and can't be correlated — distinct from the moderator's PUBLISHED mute list.
describe('AppRuntime local author mute (device-only)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Enrolled runtime with a SPY on the relay publish fn, so a test can prove muting publishes nothing. */
  async function mutedRuntime() {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore();
    const publish = jest.fn(async () => ({accepted: true, message: 'ok'}));
    const runtime = new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish});
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    return {runtime, store, secure, publish};
  }

  it('filters a muted author out of the feed and restores them on unmute — WITHOUT publishing anything', async () => {
    const {runtime, store, publish} = await mutedRuntime();
    const spamSK = generateSecretKey();
    const spamPub = getPublicKey(spamSK);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'noisy-post'}, spamSK));
    store.save(finalizeEvent({kind: Kind.Post, created_at: 901, tags: [], content: 'kept-post'}, generateSecretKey()));
    expect(runtime.getSnapshot().feed.items.some(i => i.content === 'noisy-post')).toBe(true);

    const publishesBefore = publish.mock.calls.length;
    const sizeBefore = store.size();
    await runtime.muteAuthor(spamPub);

    // The muted author's post is gone; everyone else stays.
    const muted = runtime.getSnapshot();
    expect(muted.feed.items.some(i => i.content === 'noisy-post')).toBe(false);
    expect(muted.feed.items.some(i => i.content === 'kept-post')).toBe(true);
    expect(runtime.isAuthorMuted(spamPub)).toBe(true);
    expect(muted.mutedAuthorPubkeys).toContain(spamPub);

    // CRITICAL (anonymity): muting is purely local — no relay publish, no new event of any kind.
    expect(publish.mock.calls.length).toBe(publishesBefore);
    expect(store.size()).toBe(sizeBefore);

    // Unmute brings the author back — again with no publish.
    await runtime.unmuteAuthor(spamPub);
    expect(runtime.getSnapshot().feed.items.some(i => i.content === 'noisy-post')).toBe(true);
    expect(publish.mock.calls.length).toBe(publishesBefore);
    runtime.dispose();
  });

  it('prunes a muted author from comment threads too (device-only)', async () => {
    const {runtime, store} = await mutedRuntime();
    const post = finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'root-post'}, generateSecretKey());
    store.save(post);
    const spamSK = generateSecretKey();
    const spamPub = getPublicKey(spamSK);
    const goodComment = finalizeEvent(buildComment('nice one', refOf(post), refOf(post)), generateSecretKey());
    const spamComment = finalizeEvent(buildComment('buy my coin', refOf(post), refOf(post)), spamSK);
    store.save(goodComment);
    store.save(spamComment);

    const before = runtime.getThread(post.id).map(n => n.event.id);
    expect(before).toEqual(expect.arrayContaining([goodComment.id, spamComment.id]));

    await runtime.muteAuthor(spamPub);
    const after = runtime.getThread(post.id).map(n => n.event.id);
    expect(after).toContain(goodComment.id);
    expect(after).not.toContain(spamComment.id);
    runtime.dispose();
  });

  it('persists the mute per identity slot and re-applies it on relaunch (local storage only)', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore();
    const publish = jest.fn(async () => ({accepted: true, message: 'ok'}));
    const rt1 = new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish});
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    await rt1.submitPin('1234');
    const slotId = (await rt1.listKeySlots()).slots[0]!.id;

    const spamSK = generateSecretKey();
    const spamPub = getPublicKey(spamSK);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'from-spammer'}, spamSK));
    const publishesBefore = publish.mock.calls.length; // enrollment already published a binding event
    await rt1.muteAuthor(spamPub);

    // Persisted under the per-slot AsyncStorage key — and the mute itself published NOTHING to the relay.
    const raw = await AsyncStorage.getItem(mutedAuthorsKey(slotId));
    expect(JSON.parse(raw!) as string[]).toContain(spamPub);
    expect(publish.mock.calls.length).toBe(publishesBefore);
    rt1.dispose();

    // Relaunch over the SAME storage + store: the mute hydrates during init and still filters.
    const rt2 = new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish});
    await rt2.init();
    await rt2.submitPin('1234');
    await jest.runOnlyPendingTimersAsync(); // land the deferred heavy build
    expect(rt2.isAuthorMuted(spamPub)).toBe(true);
    expect(rt2.getSnapshot().feed.items.some(i => i.content === 'from-spammer')).toBe(false);
    rt2.dispose();
  });
});

// Fine-grained cache deletion (Settings → Storage). The runtime methods are thin, safe pass-throughs:
// events go through the store's exempt-aware deleteCachedEvents; rendered media is the RAM cache.
describe('AppRuntime cache deletion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearRenderedMedia(); // the media cache is a process-global — reset between cases
  });
  afterEach(() => jest.useRealTimers());

  /** An initialised (un-enrolled) runtime over an explicit store we can seed + inspect. */
  async function runtimeOver(store: InMemoryEventStore): Promise<AppRuntime> {
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await jest.runOnlyPendingTimersAsync(); // drain the deferred-heavy macrotask
    return runtime;
  }

  // Hand-built events with a chosen id (so store.has(id) is assertable). The store/feed never verify
  // signatures — that happens at relay ingest — so a placeholder sig is fine here.
  const mk = (id: string, kind: number, at: number): Event => ({
    id,
    pubkey: 'pk',
    created_at: at,
    kind,
    tags: [],
    content: id,
    sig: 'sig',
  });
  const post = (id: string, at: number): Event => mk(id, Kind.Post, at);
  const dm = (id: string, at: number): Event => mk(id, Kind.GiftWrap, at);

  it('cachedEventCount reports how many non-exempt events match, excluding DMs', async () => {
    const store = new InMemoryEventStore();
    const runtime = await runtimeOver(store);
    store.save(post('old', 100));
    store.save(post('new', 1000));
    store.save(dm('dm', 1)); // ancient DM — never counted, never deletable
    expect(runtime.cachedEventCount({olderThanSeconds: 500})).toBe(1); // only 'old'
    expect(runtime.cachedEventCount()).toBe(2); // both posts; the DM is exempt
    runtime.dispose();
  });

  it('clearCachedEvents deletes matching feed events (never DMs), returns the count, and re-emits', async () => {
    const store = new InMemoryEventStore();
    const runtime = await runtimeOver(store);
    store.save(post('old', 100));
    store.save(post('new', 1000));
    store.save(dm('dm', 1));
    const listener = jest.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    const removed = runtime.clearCachedEvents({olderThanSeconds: 500});
    expect(removed).toBe(1);
    expect(store.has('old')).toBe(false);
    expect(store.has('new')).toBe(true);
    expect(store.has('dm')).toBe(true); // the DM survives — exempt
    expect(listener).toHaveBeenCalled(); // the deletion re-emitted so the feed re-renders
    runtime.dispose();
  });

  it('clearRenderedMedia empties the media cache and returns the count, leaving events untouched', async () => {
    const store = new InMemoryEventStore();
    const runtime = await runtimeOver(store);
    store.save(post('keep', 100));
    putRenderedMedia('url:a', 'data:image/png;base64,AAA');
    putRenderedMedia('sha:b', 'data:image/png;base64,BBB');

    expect(runtime.clearRenderedMedia()).toBe(2);
    expect(renderedMediaSize()).toBe(0);
    expect(store.has('keep')).toBe(true); // clearing rendered media never deletes source events
    runtime.dispose();
  });
});

// ── init() reentrancy guard ─────────────────────────────────────────────────────────────────────
// App.tsx's attemptInit() can call runtime.init() again (a Retry) while an earlier call is still
// in flight, or after it already settled. These pin down AppRuntime's side of the contract: an
// in-flight call is deduped onto the SAME run, a completed success is a cheap no-op, and a
// completed FAILURE does not permanently wedge the runtime — a fresh init() actually re-runs.
describe('AppRuntime.init() reentrancy guard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('concurrent init() calls dedupe onto one real run and both callers resolve', async () => {
    const runtime = newRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = jest.spyOn(runtime as any, '_doInit');

    const p1 = runtime.init();
    const p2 = runtime.init();
    // Both calls land on the exact same in-flight promise — no second run was even started.
    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding'); // the one real run actually completed
    spy.mockRestore();
    runtime.dispose();
  });

  it('a repeat init() call after success is a cheap no-op (does not re-run the body)', async () => {
    const runtime = newRuntime();
    await runtime.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = jest.spyOn(runtime as any, '_doInit');
    await runtime.init();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    runtime.dispose();
  });

  it('after a rejected init(), a fresh init() call actually re-runs the body (not permanently blocked)', async () => {
    const runtime = newRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = jest.spyOn(runtime as any, '_doInit');
    spy.mockRejectedValueOnce(new Error('boom'));

    await expect(runtime.init()).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(1);

    // The rejected attempt must not wedge the guard: a fresh call re-runs the real body and succeeds.
    await runtime.init();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');

    spy.mockRestore();
    runtime.dispose();
  });
});

// ── Audit finding #2 (phase-split init): on a genuinely FRESH install, init() should paint the
//    onboarding/lock UI off just the cheap enrolled/pinEnabled reads, running store-open + workspace
//    hydration as a fire-and-forget phase 2 — and skip the SQLCipher open entirely, since there is
//    nothing to cache pre-account. The ENROLLED path is untouched (covered by every other describe
//    block in this file, which all keep passing unchanged). ──────────────────────────────────────
describe('AppRuntime phase-split init — un-enrolled fast path (finding #2)', () => {
  it('a fresh un-enrolled init() never opens/creates the per-account event store (SQLCipher skip)', async () => {
    const secure = new InMemorySecureStorage();
    let createStoreCalls = 0;
    const makeStore = async (): Promise<EventStore> => {
      createStoreCalls++;
      return new InMemoryEventStore();
    };
    const store = new SwappableEventStore(new InMemoryEventStore());
    const runtime = new AppRuntime({
      secureStorage: secure,
      store,
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });

    await runtime.init();
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');
    expect(createStoreCalls).toBe(0); // nothing to cache pre-account — SQLCipher open skipped entirely

    // Phase 2 (device-wide settings + loadWorkspaceState) settles too, still without ever opening
    // a store — the skip is total, not just deferred past init()'s own promise.
    await runtime.whenInitPhase2Ready();
    expect(createStoreCalls).toBe(0);

    runtime.dispose();
  });

  it('emits the phase-1 (early) snapshot before phase-2 (settings load + loadWorkspaceState) settles', async () => {
    const secure = new InMemorySecureStorage();
    const runtime = new AppRuntime({
      secureStorage: secure,
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });

    // Gate phase 2's loadWorkspaceState open until explicitly released, so we can prove init()
    // already resolved (and already emitted) long before phase 2 gets anywhere near done.
    let releaseWorkspaceLoad: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseWorkspaceLoad = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (runtime as any).loadWorkspaceState.bind(runtime);
    const spy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(runtime as any, 'loadWorkspaceState')
      .mockImplementation(async (...args: unknown[]) => {
        await gate;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return original(...args);
      });

    let emitCount = 0;
    const unsubscribe = runtime.subscribe(() => {
      emitCount++;
    });

    await runtime.init(); // must resolve WITHOUT waiting for the still-gated loadWorkspaceState
    expect(emitCount).toBeGreaterThanOrEqual(1); // phase-1's emit() already fired
    expect(resolveScreen(runtime.getSnapshot())).toBe('onboarding');
    expect(spy).toHaveBeenCalledTimes(1); // phase 2 kicked off...

    // ...but is still gated — whenInitPhase2Ready() must not have settled yet.
    let phase2Done = false;
    void runtime.whenInitPhase2Ready().then(() => {
      phase2Done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(phase2Done).toBe(false);

    releaseWorkspaceLoad();
    await runtime.whenInitPhase2Ready();
    expect(phase2Done).toBe(true);

    spy.mockRestore();
    unsubscribe();
    runtime.dispose();
  });
});

// ── #8: getProfile resolves posts/ideaCount through the RESOLVED feed (blind-attribution-aware),
//    not a raw {authors:[pubkey]} store query — buildProfile alone can never match a blind post,
//    since it's signed by a per-post THROWAWAY key, not the real author's pubkey. ─────────────────
describe('AppRuntime.getProfile — resolved-feed posts + ideaCount (#8)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    clearAuthorCache();
    setActiveCommunityKey(null);
  });

  const CK = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
  const RELAY = `ws://${'c'.repeat(56)}.onion`;

  /** A v3 enrollment session: the community carries a shared community key (blind posting). */
  async function makeV3Session(): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {relayUrl: RELAY, issuerPublicKey: 'aXNz', organizerPubkey: 'a'.repeat(64), communityKey: CK},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) {
      throw new Error('enrollment failed in setup');
    }
    return result.session;
  }

  it('a blind-posted note (throwaway-signed + stiq_attr) shows up on the resolved author\'s profile with correct ideaCount', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    // Enrolling as a v3 (blind-posting-provisioned) community activates the shared community key —
    // completeEnrollment's loadActiveCommunityPolicy() calls setActiveCommunityKey internally.
    await runtime.completeEnrollment(await makeV3Session(), '1234', '9999');
    await runtime.submitPin('1234');

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ck = decodeCommunityKey(CK)!;
    const token: Token = makeToken();

    // Throwaway-signed: event.pubkey is NEITHER authorPk nor anything derivable from it. Only the
    // encrypted stiq_attr attribution (decrypted via resolveAuthorPubkey) recovers the real author.
    const blindNote = toBlindEvent(
      {kind: Kind.Post, created_at: 900, tags: [], content: 'blind idea'},
      [token],
      authorSk,
      ck,
    );
    expect(blindNote.pubkey).not.toBe(authorPk);
    store.save(blindNote);

    // One resolved NIP-22 comment by the same (real) author, also blind-signed.
    const blindComment = toBlindEvent(
      {kind: Kind.Comment, created_at: 950, tags: [], content: 'blind reply'},
      [token],
      authorSk,
      ck,
    );
    store.save(blindComment);

    const profile = runtime.getProfile(authorPk);
    expect(profile.posts.map(p => p.content)).toContain('blind idea');
    expect(profile.ideaCount).toBe(1);
    runtime.dispose();
  });

  it('a moderator-hidden post stays hidden on the profile too (single-visibility model, no author exception)', async () => {
    const store = new InMemoryEventStore();
    const orgSK = generateSecretKey();
    const orgNpub = nip19.npubEncode(getPublicKey(orgSK));
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      organizerNpub: orgNpub,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const post = finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'to be hidden'}, authorSk);
    store.save(post);
    expect(runtime.getProfile(authorPk).posts.map(p => p.id)).toContain(post.id);

    // Organizer hides it (kind-1984) — visibleFeed drops it, so it must also drop off the profile.
    store.save(finalizeEvent({kind: Kind.Report, created_at: 1000, tags: [['e', post.id]], content: ''}, orgSK));
    expect(runtime.getProfile(authorPk).posts.map(p => p.id)).not.toContain(post.id);
    runtime.dispose();
  });
});

// ── getProfile render-hot-path memoization (adversarial-review fix): getProfile is invoked from
//    render hot paths (DM/comment/channel-list rows) once per row per render — unmemoized, each call
//    re-scanned the WHOLE visible feed AND the whole raw comment+post store (ideaCountFor) even when
//    nothing changed. Memoized per pubkey on the same composite _cachedBuildFeed keys on, plus
//    _mutedVersion + PROFILE_KINDS (adds Metadata/LiveActivity). ─────────────────────────────────────
describe('AppRuntime.getProfile — memoized per pubkey (render-hot-path cost)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('repeated getProfile calls for the same pubkey issue ZERO store.query calls once warmed', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'once'}, authorSk));
    store.save(finalizeEvent({kind: Kind.Comment, created_at: 950, tags: [], content: 'idea'}, authorSk));

    runtime.getProfile(authorPk); // warm the memo (posts + ideaCount + roster + overlay + banned set)

    const spy = jest.spyOn(store, 'query');
    const p1 = runtime.getProfile(authorPk);
    const p2 = runtime.getProfile(authorPk);
    expect(spy).not.toHaveBeenCalled(); // fully served from the per-pubkey memo — no re-scan
    expect(p1).toBe(p2); // same cached Profile object identity
    expect(p1.posts).toHaveLength(1);
    expect(p1.ideaCount).toBe(1);
    spy.mockRestore();
    runtime.dispose();
  });

  it('a new post by the profile\'s author invalidates the memo on the next call', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const before = runtime.getProfile(authorPk);
    expect(before.posts).toHaveLength(0);

    store.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'fresh'}, authorSk));
    const after = runtime.getProfile(authorPk);
    expect(after).not.toBe(before); // real change → fresh memo entry, not the stale cached one
    expect(after.posts.map(p => p.content)).toContain('fresh');
    runtime.dispose();
  });

  it('a new comment by the profile\'s author bumps ideaCount on the next call (memo invalidates)', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    expect(runtime.getProfile(authorPk).ideaCount).toBe(0);

    store.save(finalizeEvent({kind: Kind.Comment, created_at: 950, tags: [], content: 'idea'}, authorSk));
    expect(runtime.getProfile(authorPk).ideaCount).toBe(1);
    runtime.dispose();
  });

  it('the viewer\'s own display-name/gradient change (identity bump, no store event) invalidates their memoized profile', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    const me = runtime.getSnapshot().currentUserPubkey!;

    expect(runtime.getProfile(me).name).toBeUndefined();
    await runtime.setMyDisplayName('Test User'); // no feed-kind store event — only _identityVersion bumps
    expect(runtime.getProfile(me).name).toBe('Test User'); // memo invalidated by the identityVersion bump
    runtime.dispose();
  });

  it('switching communities clears the per-pubkey profile memo (no stale cross-community posts)', async () => {
    const secure = new InMemorySecureStorage();
    const stores = new Map<string, EventStore>();
    const makeStore = async (cid: string | null): Promise<EventStore> => {
      const key = cid ?? '__none__';
      let s = stores.get(key);
      if (!s) {
        s = new InMemoryEventStore();
        stores.set(key, s);
      }
      return s;
    };
    const store = new SwappableEventStore(new InMemoryEventStore());
    const runtime = new AppRuntime({
      secureStorage: secure,
      store,
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();

    const RELAY_A = `ws://${'d'.repeat(56)}.onion`;
    const RELAY_B = `ws://${'e'.repeat(56)}.onion`;
    const sessionFor = async (relayUrl: string): Promise<Session> => {
      const {enrollment} = await Enrollment.begin({relayUrl, issuerPublicKey: 'aXNz'}, new MockBlindRsa(), 'STIQ-TEST-0001');
      const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
      if (!result.ok) throw new Error('enrollment failed in setup');
      return result.session;
    };

    await runtime.completeEnrollment(await sessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const storeA = stores.get(communityId(RELAY_A))!;
    storeA.save(finalizeEvent({kind: Kind.Post, created_at: 900, tags: [], content: 'in-A'}, authorSk));
    // Warm the memo for authorPk while community A is active.
    expect(runtime.getProfile(authorPk).posts.map(p => p.content)).toContain('in-A');

    // Join community B (additive — a new identity slot + its own store). This switches to B.
    await runtime.completeEnrollment(await sessionFor(RELAY_B), '1234', '');
    await runtime.submitPin('1234');
    // SAME pubkey key, different community: the memo must NOT leak A's cached posts forward.
    expect(runtime.getProfile(authorPk).posts).toEqual([]);

    // Switch back to A: its posts are freshly (and correctly) recomputed.
    await runtime.switchCommunity(communityId(RELAY_A));
    expect(runtime.getProfile(authorPk).posts.map(p => p.content)).toContain('in-A');
    runtime.dispose();
  });
});

// ── P1-3/A3: community-switch structural warm (activateWorkspace → warmSwitchKindsChunked) ────────
// A3 found that switching community/account cold-warmed Post/Comment/Report/MuteList via the
// UN-chunked warmKind() — one synchronous SELECT + JSON.parse of up to TIMELINE_RETENTION rows PER
// KIND, landing inside the switch's own emit(). warmSwitchKindsChunked spreads that same work across
// the SqliteEventStore.warmKindChunked's existing yielding chunks (no new yield idiom), and
// activateWorkspace now awaits it BEFORE emitting. These two tests cover: (1) a large bucket really
// does span multiple macrotasks and still lands a correct feed, and (2) a superseding dispose()
// (mirroring a removeCommunity/removeIdentity teardown) stops the pass BETWEEN kinds instead of
// warming/emitting against a workspace the runtime no longer owns.
describe('AppRuntime P1-3/A3 — community-switch structural warm (warmSwitchKindsChunked)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /**
   * Minimal SqliteDb fake covering exactly the SQL surface a cold community-switch warm exercises:
   * INSERT (seeding), the chunked-warm SELECT (paginated by rowid — same idiom as
   * sqliteStore.warmChunked.test.ts's ChunkFakeDb), the sync warmKind SELECT, a cold getById
   * id-lookup, has()'s existence check, and the bootstrap COUNT(*). Everything else (retention-prune
   * scans, DELETE) falls through to an empty result — this test's fake clock never advances the
   * retention prune's PRUNE_DELAY_MS=5000, so those statements are never actually hit.
   */
  class PrewarmFakeDb implements SqliteDb {
    private rows = new Map<string, {rowid: number; event: Event}>();
    private nextRowid = 1;
    /** One entry (the kind) per chunked-warm SELECT that ran — the chunk-boundary signal below. */
    chunkSelects: number[] = [];

    execute(sql: string, params: unknown[] = []): {rows: {_array: unknown[]}; rowsAffected: number} {
      const none = {rows: {_array: [] as unknown[]}, rowsAffected: 0};
      if (sql.includes('INSERT OR IGNORE')) {
        const id = params[0] as string;
        if (!this.rows.has(id)) {
          this.rows.set(id, {rowid: this.nextRowid++, event: JSON.parse(params[7] as string) as Event});
        }
        return {rows: {_array: []}, rowsAffected: 1};
      }
      if (sql.includes('SELECT rowid AS r, raw FROM events')) {
        const [kind, after, limit] = params as [number, number, number];
        this.chunkSelects.push(kind);
        const matches = [...this.rows.values()]
          .filter(r => r.event.kind === kind && r.rowid > after)
          .sort((a, b) => a.rowid - b.rowid)
          .slice(0, limit)
          .map(r => ({r: r.rowid, raw: JSON.stringify(r.event)}));
        return {rows: {_array: matches}, rowsAffected: 0};
      }
      if (sql.includes('SELECT raw FROM events WHERE kind')) {
        const kind = params[0] as number;
        const matches = [...this.rows.values()]
          .filter(r => r.event.kind === kind)
          .map(r => ({raw: JSON.stringify(r.event)}));
        return {rows: {_array: matches}, rowsAffected: 0};
      }
      if (sql.includes('SELECT raw FROM events WHERE id')) {
        const row = this.rows.get(params[0] as string);
        return {rows: {_array: row ? [{raw: JSON.stringify(row.event)}] : []}, rowsAffected: 0};
      }
      if (sql.includes('COUNT(*)')) {
        return {rows: {_array: [{n: this.rows.size}]}, rowsAffected: 0};
      }
      if (sql.includes('SELECT 1 FROM events WHERE id')) {
        return {rows: {_array: this.rows.has(params[0] as string) ? [{}] : []}, rowsAffected: 0};
      }
      if (sql.includes('SELECT kind FROM events WHERE id')) {
        const row = this.rows.get(params[0] as string);
        return {rows: {_array: row ? [{kind: row.event.kind}] : []}, rowsAffected: 0};
      }
      if (sql.startsWith('DELETE FROM events WHERE id')) {
        const removed = this.rows.delete(params[0] as string);
        return {rows: {_array: []}, rowsAffected: removed ? 1 : 0};
      }
      if (sql.startsWith('DELETE FROM events')) {
        this.rows.clear();
        return none;
      }
      if (sql.includes('DISTINCT kind')) {
        const kinds = [...new Set([...this.rows.values()].map(r => r.event.kind))];
        return {rows: {_array: kinds.map(kind => ({kind}))}, rowsAffected: 0};
      }
      return none; // CREATE TABLE/INDEX, retention-prune scans, MAX(created_at), etc.
    }
  }

  /** A real enrollment Session bound to `relayUrl` (→ a distinct community id), mirroring the
   *  multicommunity.test.ts / getProfile-memo helper above. */
  async function sessionFor(relayUrl: string): Promise<Session> {
    const {enrollment} = await Enrollment.begin({relayUrl, issuerPublicKey: 'aXNz'}, new MockBlindRsa(), 'STIQ-TEST-0001');
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  it('spans real macrotasks warming a large Post bucket on a switch, and still lands a correct feed', async () => {
    const secure = new InMemorySecureStorage();
    const dbs = new Map<string, PrewarmFakeDb>();
    const dbFor = (cid: string | null): PrewarmFakeDb => {
      const key = cid ?? '__none__';
      let db = dbs.get(key);
      if (!db) {
        db = new PrewarmFakeDb();
        dbs.set(key, db);
      }
      return db;
    };
    // Every switch opens a FRESH SqliteEventStore over the persisted db (a cold in-RAM mirror, same
    // as reopening op-sqlite) — never the SAME store instance reused, so switching back to B for real
    // exercises the cold warm against whatever was seeded into its db in the meantime.
    const makeStore = async (cid: string | null): Promise<EventStore> => new SqliteEventStore(dbFor(cid));
    const store = new SwappableEventStore(new SqliteEventStore(dbFor(null)));
    const runtime = new AppRuntime({
      secureStorage: secure,
      store,
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();

    const RELAY_A = `ws://${'f'.repeat(56)}.onion`;
    const RELAY_B = `ws://${'9'.repeat(56)}.onion`;
    await runtime.completeEnrollment(await sessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    await runtime.completeEnrollment(await sessionFor(RELAY_B), '1234', ''); // joins B (additive)
    await runtime.submitPin('1234');

    // Seed B's durable db with a Post bucket spanning multiple WARM_CHUNK_ROWS chunks — the switch's
    // cold warm must span the SAME chunk boundaries sqliteStore.warmKindChunked itself yields on.
    const cidB = communityId(RELAY_B);
    const dbB = dbFor(cidB);
    const seedStore = new SqliteEventStore(dbB);
    const postCount = WARM_CHUNK_ROWS * 2 + 5;
    // Cheap fake posts (no real schnorr signing): the local store write + chunked warm + feed build
    // exercised here never verify signatures, so signing WARM_CHUNK_ROWS*2+5 events with
    // finalizeEvent would only add ~seconds of pointless crypto to a work-spreading test. A unique id
    // and a placeholder sig are all the warm/feed path reads.
    const authorPk = 'a'.repeat(64);
    for (let i = 0; i < postCount; i++) {
      seedStore.save({
        id: `post-b-${i.toString().padStart(5, '0')}`,
        pubkey: authorPk,
        created_at: 900 + i,
        kind: Kind.Post,
        tags: [],
        content: `chunked-b-${i}`,
        sig: '0'.repeat(128),
      } as Event);
    }

    await runtime.switchCommunity(communityId(RELAY_A)); // away from B first

    let settled = false;
    const switchPromise = runtime.switchCommunity(cidB).finally(() => {
      settled = true;
    });
    // Drain in bounded waves of a precise 1ms advance (NOT `runOnlyPendingTimersAsync`, which
    // exhausts the ENTIRE currently-pending timer queue regardless of a timer's delay — it would
    // also fire the far-future 60s autolock timer armed by unlock() and blank the snapshot; a plain
    // `advanceTimersByTimeAsync(0)` doesn't reliably re-arm for a chain that reschedules its OWN next
    // 0ms timer from inside the callback it just ran). A small, bounded, non-zero advance per wave
    // drains exactly the switch's own chunk-boundary `setTimeout(0)`s one at a time, and 30 waves of
    // 1ms each stays microseconds away from the 60_000ms autolock timer.
    for (let wave = 0; wave < 30 && !settled; wave++) {
      await jest.advanceTimersByTimeAsync(1);
    }
    await switchPromise;

    // The seeded Post bucket needed MORE than one chunked-warm SELECT — proving the switch's
    // structural warm actually spanned multiple yielding macrotasks, not one synchronous shot.
    const postChunkSelects = dbB.chunkSelects.filter(k => k === Kind.Post);
    expect(postChunkSelects.length).toBeGreaterThan(1);

    // The switch still lands a correct, fully-populated feed once the chunked warm completes — this
    // is work-spreading, not a logic change.
    const after = runtime.getSnapshot();
    expect(after.feed.items.some(i => i.content === `chunked-b-${postCount - 1}`)).toBe(true);
    runtime.dispose();
    // Heavier integration test (two real enrollments + a multi-chunk warm drain) — give it headroom
    // over jest's 5s default so full-suite CPU contention can't flake it.
  }, 20000);

  it('a superseding dispose() cancels an in-flight structural warm before it reaches a later kind', async () => {
    const secure = new InMemorySecureStorage();
    const dbs = new Map<string, EventStore>();
    const warmCalls: number[] = [];
    const gates = new Map<number, () => void>();
    /** Wrap `inner` so warmKindChunked never auto-resolves — it records the kind it was asked to
     *  warm and parks a resolver the test controls, so a switch can be frozen mid-loop to prove the
     *  generation guard stops it before it reaches a LATER PREWARM_KINDS entry. */
    const pausable = (inner: EventStore): EventStore => {
      const target = inner as unknown as Record<string, unknown>;
      return new Proxy(target, {
        get(obj, prop, receiver) {
          if (prop === 'warmKindChunked') {
            return (kind: number) =>
              new Promise<void>(resolve => {
                warmCalls.push(kind);
                gates.set(kind, resolve);
              });
          }
          const v = Reflect.get(obj, prop, receiver);
          return typeof v === 'function' ? v.bind(obj) : v;
        },
      }) as unknown as EventStore;
    };

    const RELAY_A = `ws://${'1'.repeat(56)}.onion`;
    const RELAY_B = `ws://${'2'.repeat(56)}.onion`;
    const cidB = communityId(RELAY_B);
    // Only B's store is pausable — A's stays plain (immediate no-op warm), so the SETUP switches
    // (enroll A, join B, switch back to A) complete normally and only the switch INTO B under test
    // gets stuck.
    const makeStore = async (cid: string | null): Promise<EventStore> => {
      const key = cid ?? '__none__';
      let s = dbs.get(key);
      if (!s) {
        s = key === cidB ? pausable(new InMemoryEventStore()) : new InMemoryEventStore();
        dbs.set(key, s);
      }
      return s;
    };
    const store = new SwappableEventStore(new InMemoryEventStore());
    const runtime = new AppRuntime({
      secureStorage: secure,
      store,
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await sessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    await runtime.completeEnrollment(await sessionFor(RELAY_B), '1234', '');
    await runtime.submitPin('1234');
    await runtime.switchCommunity(communityId(RELAY_A));
    warmCalls.length = 0; // ignore anything warmed by the setup switches above

    const switchPromise = runtime.switchCommunity(cidB);
    // Let the switch progress up to its first warmKindChunked call — a plain microtask chain (no
    // timer is scheduled until warmKindChunked itself would yield one, which this fake never does).
    for (let i = 0; i < 500 && warmCalls.length === 0; i++) await Promise.resolve();
    expect(warmCalls.length).toBe(1); // exactly the FIRST PREWARM_KINDS entry — stuck there, unresolved

    // Supersede mid-warm: dispose() bumps `_switchWarmGen`, exactly like a
    // removeCommunity/removeIdentity teardown's direct clearSwitchCaches()+emit branch would.
    runtime.dispose();
    // Let the "in-flight SQL call" resolve AFTER the supersede (mirrors a real query already
    // dispatched to op-sqlite completing after the JS-side generation has already moved on).
    gates.get(warmCalls[0]!)?.();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    await switchPromise.catch(() => {});

    // The loop must have stopped BETWEEN kinds: it never asked to warm a second PREWARM_KINDS entry.
    expect(warmCalls.length).toBe(1);
  });
});

// ── getIdentity: the thin name+gradient+npub lookup introduced alongside getProfile's memo — never
//    computes posts/ideaCount, and is keyed only on _identityVersion (no feed/moderation dependency).
describe('AppRuntime.getIdentity — thin name/gradient lookup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('mirrors getProfile\'s name + gradient without posts/ideaCount, and updates on an identity bump', async () => {
    const runtime = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    const me = runtime.getSnapshot().currentUserPubkey!;

    // No name yet (enrollment auto-claims a gradient but never a name) — matches getProfile.
    const before = runtime.getIdentity(me);
    expect(before.pubkey).toBe(me);
    expect(before.npub).toBe(nip19.npubEncode(me));
    expect(before.name).toBeUndefined();
    expect(before).toEqual({pubkey: me, npub: nip19.npubEncode(me), gradient: runtime.getProfile(me).gradient});

    await runtime.setMyDisplayName('Test User'); // identity bump, no store event
    const identity = runtime.getIdentity(me);
    expect(identity.name).toBe('Test User'); // memo invalidated by the identityVersion bump
    expect(runtime.getProfile(me).name).toBe(identity.name); // same source of truth as getProfile
    runtime.dispose();
  });
});

/**
 * Publish-durability FIX A — a still-'sending' outbox event (deliver() got an `offline` result) is no
 * longer left to rot until the NEXT relay reconnect: deliver() now self-schedules a bounded, escalating
 * local backoff resend (4s/8s/16s/32s) so a single flaky Tor circuit recovers on its own even while the
 * relay connection itself stays healthy. An in-flight guard keeps that local timer from racing a
 * concurrent onRelayConnected()/retry() resend of the SAME event into a double publish() call.
 */
describe('AppRuntime publish durability — local backoff resend for a still-"sending" write (FIX A)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('an offline deliver result schedules a local resend; the ~4s backoff fires on its own and a later accepted attempt confirms + removes the entry, with no further resends', async () => {
    let gate = false;
    let callCount = 0;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => {
        if (!gate) return {accepted: true, message: 'ok'}; // enrollment's own binding-event publish
        callCount++;
        // 1st call (from post()): this post's dedicated Tor circuit isn't up yet, though the relay
        // connection itself is healthy — no reconnect ever happens in this test.
        // 2nd call (the local ~4s backoff resend): it lands.
        return callCount === 1
          ? {accepted: false, message: 'relay not connected', offline: true}
          : {accepted: true, message: 'ok'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    gate = true;

    await runtime.post('flaky circuit', []);
    let snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'flaky circuit');
    expect(item).toBeDefined();
    expect(snap.sendStatus.get(item!.id)).toBe('sending'); // queued, not 'failed'
    expect(callCount).toBe(1); // no reconnect and no manual retry involved

    // Advance past the first backoff step (4s) — the LOCAL resend timer fires on its own.
    await jest.advanceTimersByTimeAsync(4_000);
    expect(callCount).toBe(2);
    snap = runtime.getSnapshot();
    expect(snap.sendStatus.get(item!.id)).toBe('confirmed');

    // Advance through every remaining backoff step (8s/16s/32s, plus slack) — no further resend
    // fires: the fire-time status check in scheduleResend stops the chain once the event left
    // 'sending'.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(callCount).toBe(2);

    // ...and shortly after, the confirmed entry lingers then is removed (ring fills and disappears).
    expect(runtime.getSnapshot().sendStatus.has(item!.id)).toBe(false);

    runtime.dispose();
  });

  it('caps local backoff at 4 scheduled resends (4/8/16/32s) then relies on the next reconnect, unchanged', async () => {
    let gate = false;
    let callCount = 0;
    let acceptNow = false;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => {
        if (!gate) return {accepted: true, message: 'ok'};
        callCount++;
        return acceptNow
          ? {accepted: true, message: 'ok'}
          : {accepted: false, message: 'relay not connected', offline: true};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    gate = true;

    await runtime.post('stubborn circuit', []);
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'stubborn circuit')!;
    expect(callCount).toBe(1); // original send

    // Walk every scheduled backoff step — still offline each time.
    await jest.advanceTimersByTimeAsync(4_000);
    expect(callCount).toBe(2);
    await jest.advanceTimersByTimeAsync(8_000);
    expect(callCount).toBe(3);
    await jest.advanceTimersByTimeAsync(16_000);
    expect(callCount).toBe(4);
    await jest.advanceTimersByTimeAsync(32_000);
    expect(callCount).toBe(5);

    // The local backoff table (bounded, ~4-5 attempts total) is now exhausted — waiting even a long
    // time issues no further resend on its own.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(callCount).toBe(5);
    expect(runtime.getSnapshot().sendStatus.get(item.id)).toBe('sending'); // still queued, not lost
    // M7: the render-only offline hint stays set while every attempt keeps coming back offline — the
    // feed should read this as "Queued — connecting…", not "Sending…".
    expect(runtime.getSnapshot().sendQueuedOffline.has(item.id)).toBe(true);

    // A genuine relay reconnect still delivers it — the pre-existing retry path is unchanged.
    acceptNow = true;
    await runtime.onRelayConnected();
    await jest.advanceTimersByTimeAsync(0);
    expect(runtime.getSnapshot().sendStatus.get(item.id)).toBe('confirmed');
    // Once delivered, the id is no longer "queued offline" (it isn't 'sending' at all anymore).
    expect(runtime.getSnapshot().sendQueuedOffline.has(item.id)).toBe(false);

    runtime.dispose();
  });

  it('the in-flight guard prevents a concurrent double-send for the same event id', async () => {
    const gatedAcks: Array<(v: {accepted: boolean; message: string}) => void> = [];
    let gate = false;
    let callCount = 0;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: () => {
        if (!gate) return Promise.resolve({accepted: true, message: 'ok'});
        callCount++;
        return new Promise(res => gatedAcks.push(res));
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    gate = true;

    // post() -> publishOptimistic() fires deliver() in the background; by the time post() resolves,
    // deliver() has already run synchronously up to its (still-pending) publish() call, so the
    // in-flight guard already holds this event's id.
    await runtime.post('racey send', []);
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'racey send')!;
    expect(callCount).toBe(1);

    // A concurrent retry — e.g. onRelayConnected's reconnect flush firing at the same moment as the
    // local backoff timer — must NOT issue a second publish() while the first is still in flight.
    await runtime.retry(item.id);
    expect(callCount).toBe(1); // short-circuited by the guard before calling publish again

    // Resolve the ORIGINAL in-flight publish now — it lands normally, exactly once.
    gatedAcks.forEach(ack => ack({accepted: true, message: 'ok'}));
    await jest.advanceTimersByTimeAsync(0);
    expect(runtime.getSnapshot().sendStatus.get(item.id)).toBe('confirmed');
    expect(callCount).toBe(1);

    runtime.dispose();
  });
});

/**
 * Publish-durability FIX B — a post that fails to SIGN at compose time because the blind wallet is
 * exhausted (even after feedSigner's own internal draw-and-retry) must not be lost. post() still
 * re-throws on a BlindTokensExhausted (the composer's existing one-shot Alert, and the
 * blindSilo.regression.test.ts "propagates the exhaustion" contract, both depend on that) — but it
 * now also records the raw compose params, and drainPendingPosts() (wired from onRelayConnected and
 * from a successful drawTokens()) re-signs + republishes it automatically once tokens/relay are
 * available, with no user action.
 */
describe('AppRuntime publish durability — token-exhaustion compose recovery (FIX B)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
  const ORG_PUB = 'b'.repeat(64);

  /** A v3 (blind-posting) session: same test community as makeSession(), plus a communityKey (so
   *  BlindSigner.sign() actually engages — see blind/blindSigner.ts, it no-ops without one) and an
   *  organizerPubkey (drawTokens() requires one — "this community has no organizer mailbox"
   *  otherwise). */
  async function blindSession(): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {...community, communityKey: CK, organizerPubkey: ORG_PUB},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  afterEach(() => jest.restoreAllMocks());

  it('queues a post whose sign throws BlindTokensExhausted (even after the internal draw retry) instead of losing it, then auto-publishes it once drawTokens() + onRelayConnected succeed', async () => {
    const published: Event[] = [];
    let drawNowCalls = 0;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      // feedSigner's on-demand draw-and-retry also fails (offline / organizer cap genuinely hit) —
      // matches blindSilo.regression.test.ts's own "propagates the exhaustion" scenario.
      drawTokensNow: async () => {
        drawNowCalls++;
        return false;
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    expect(await runtime.walletBalance()).toBe(0); // nothing drawn yet
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    // Wallet empty + draw-and-retry fails ⇒ post() rejects (unchanged contract). FIX B (#3/#5): the
    // post is now RENDERED optimistically the instant it's composed — even while the draw fails — as a
    // durable 'failed' placeholder (with Retry), NOT invisible-and-lost as it was before. It is NOT
    // published (no valid signature) and its raw body is queued for auto-recovery.
    await expect(runtime.post('queued while broke')).rejects.toThrow(BlindTokensExhausted);
    expect(drawNowCalls).toBe(1);
    expect(published.length).toBe(0);
    const failedSnap = runtime.getSnapshot();
    const placeholder = failedSnap.feed.items.find(i => i.content === 'queued while broke');
    expect(placeholder).toBeDefined(); // rendered durably (was: undefined → invisible + lost)
    expect(failedSnap.sendStatus.get(placeholder!.id)).toBe('failed'); // shows a failed/Retry indicator

    // A later PROACTIVE draw (drawTokens(), independent of drawTokensNow) succeeds and seeds the
    // wallet — this is the moment a real host would call it on reconnect/foreground.
    jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({
      ok: true,
      tokens: [makeToken()],
    });
    const draw = await runtime.drawTokens(() => ({}) as never);
    expect(draw.ok).toBe(true);
    expect(draw.drawn).toBe(1);
    await jest.advanceTimersByTimeAsync(0); // let drawTokens()'s fire-and-forget drainPendingPosts() run

    // The queued post is signed + published automatically — no user action, no re-typing — which
    // spends the freshly-drawn token (back to 0: it wasn't just left in the wallet unused).
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'queued while broke');
    expect(item).toBeDefined();
    expect(published.some(e => e.id === item!.id)).toBe(true);
    expect(await runtime.walletBalance()).toBe(0);

    runtime.dispose();
  });

  // T-G2 — no-foreground-wait invariant: extends the FIX B suite above with the one assertion it
  // didn't make explicit — that the durable placeholder renders BEFORE the on-demand draw safety net
  // (feedSigner's drawNow()) ever settles, so a dry wallet can never make post()'s CALLER wait on a
  // multi-second Tor round-trip. The composer itself never awaits post() (App.tsx's onSubmit calls it
  // fire-and-forget) — this pins the underlying guarantee that makes that safe: by the time `post()`
  // has been called, the write is already visible and durable, with zero microtasks elapsed.
  it('renders the durable placeholder BEFORE the on-demand draw settles — a dry wallet never makes the caller wait on the draw', async () => {
    const published: Event[] = [];
    let releaseDraw!: (drew: boolean) => void;
    const drawGate = new Promise<boolean>(resolve => {
      releaseDraw = resolve;
    });
    let drawNowCalls = 0;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      // The on-demand draw hangs until the test explicitly releases it — proving whatever happens
      // BEFORE that release is happening entirely without having waited on the draw.
      drawTokensNow: async () => {
        drawNowCalls++;
        return drawGate;
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    // Call post() and do NOT await it — the on-demand draw is (deliberately) still hanging. If the
    // write's visibility depended on the draw resolving, NONE of the assertions below could pass yet.
    const p = runtime.post('instant placeholder, slow draw');

    // Zero microtasks have elapsed here — this is the literal synchronous continuation of the post()
    // call. The placeholder is ALREADY rendered: renderPlaceholder runs synchronously inside
    // queuePendingWrite, before the first await in the chain, exactly so a caller never has anything
    // to wait for.
    const midFlightSnap = runtime.getSnapshot();
    const placeholder = midFlightSnap.feed.items.find(i => i.content === 'instant placeholder, slow draw');
    expect(placeholder).toBeDefined();
    expect(midFlightSnap.sendStatus.get(placeholder!.id)).toBe('sending');
    // Zero microtasks elapsed, so feedSigner cannot possibly have reached its drawNow() call yet
    // either (that's several awaits deeper — mintMediaBlobs, the silo guard, signPendingEvent) — the
    // placeholder above is rendered strictly BEFORE any draw is even attempted, not merely before it
    // resolves.
    expect(drawNowCalls).toBe(0);

    releaseDraw(false); // let the draw fail (offline/organizer cap) — post() keeps its existing contract
    await expect(p).rejects.toThrow(BlindTokensExhausted);
    expect(drawNowCalls).toBe(1); // exactly one on-demand draw for this one write, never re-entrant

    // Still durably queued (T0.1's contract), not lost — the invariant under test doesn't relax that.
    const failedSnap = runtime.getSnapshot();
    expect(failedSnap.sendStatus.get(placeholder!.id)).toBe('failed');

    runtime.dispose();
  });

  it('a single Retry after a token-exhausted compose publishes the post ONCE — the on-demand draw must not re-entrantly double-sign it (hardening: retry double-post/double-spend)', async () => {
    const published: Event[] = [];
    let runtime!: AppRuntime;
    let drawShouldSucceed = false;
    runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => { published.push(e); return {accepted: true, message: 'ok'}; },
      // Mirror the REAL wiring (App.tsx): feedSigner's on-demand top-up runs the PROACTIVE draw, which
      // fires `void drainPendingPosts()` BEFORE returning. That re-entrancy used to double-sign an
      // intent that retry() left sitting in pendingPosts across its own draw.
      drawTokensNow: async () => {
        if (!drawShouldSucceed) return false;
        const r = await runtime.drawTokens(() => ({}) as never);
        return (r.drawn ?? 0) > 0;
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    published.length = 0;

    // 1) Compose while broke (draw fails) ⇒ a durable 'failed' placeholder + one queued intent.
    await expect(runtime.post('one retry, one post')).rejects.toThrow(BlindTokensExhausted);
    const placeholder = runtime.getSnapshot().feed.items.find(i => i.content === 'one retry, one post');
    expect(placeholder).toBeDefined();
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(1);

    // 2) Draws now succeed. ONE Retry: signPostPlaceholder → BlindTokensExhausted → drawNow() →
    //    drawTokens() fires drainPendingPosts() re-entrantly. With the fix retry removed the intent
    //    from the queue FIRST, so the nested drain finds nothing and the post is signed exactly ONCE.
    jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({ok: true, tokens: [makeToken()]});
    drawShouldSucceed = true;
    await runtime.retry(placeholder!.id);
    await jest.advanceTimersByTimeAsync(0); // flush the fire-and-forget drainPendingPosts()

    const copies = published.filter(e => e.content.includes('one retry, one post'));
    expect(copies.length).toBe(1); // was 2 (double publish + double token-spend) before the fix
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(0);

    runtime.dispose();
  });

  it('also drains via onRelayConnected (not just drawTokens()) once the wallet has been topped up some other way', async () => {
    const secure = new InMemorySecureStorage();
    const published: Event[] = [];
    const runtime = new AppRuntime({
      secureStorage: secure,
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      // No drawTokensNow wired at all — this proves the recovery path works via onRelayConnected's
      // own drain, independent of feedSigner's on-demand draw-and-retry (which just rethrows here).
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    await expect(runtime.post('queued for reconnect')).rejects.toThrow(BlindTokensExhausted);
    expect(published.length).toBe(0);

    // Tokens become available some other way (e.g. a background top-up this test isn't otherwise
    // exercising) — seed the wallet directly through a SEPARATE EpochWallet instance bound to the
    // same storage/slot/issuer-key, exactly like a real draw would (see wallet.ts's own
    // read-through-on-miss doc). Nothing drains yet — no connect has happened.
    const sid = (await new KeyRing(secure).getActiveSlotId()) ?? communityId(community.relayUrl);
    await new EpochWallet(secure, sid, walletKeyFingerprint(community.issuerPublicKey)).add(0, [
      makeToken(),
    ]);
    expect(published.some(e => e.content?.includes('queued for reconnect'))).toBe(false);

    // The relay (re)connects: onRelayConnected() drains the queue on its own.
    await runtime.onRelayConnected();
    await jest.advanceTimersByTimeAsync(0);

    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'queued for reconnect');
    expect(item).toBeDefined();
    expect(published.some(e => e.id === item!.id)).toBe(true);

    runtime.dispose();
  });

  it('queues a COMMENT whose sign throws BlindTokensExhausted instead of discarding the typed content — renders it durably in the thread, persists it per-account (survives restart), and auto-publishes it once a draw succeeds', async () => {
    const secure = new InMemorySecureStorage();
    const published: Event[] = [];
    let drawNowCalls = 0;
    const runtime = new AppRuntime({
      secureStorage: secure,
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => { published.push(e); return {accepted: true, message: 'ok'}; },
      // feedSigner's on-demand draw-and-retry also fails — the comment genuinely can't sign right now.
      drawTokensNow: async () => { drawNowCalls++; return false; },
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    published.length = 0; // drop the enrollment binding-event publish

    // A reply on some feed post, composed while the wallet is empty + the draw-and-retry fails. Before
    // this fix, comment() went through signOptimisticWrite, which DISCARDED the placeholder on failure —
    // the typed content was lost. It now takes the same durable path as post().
    const root = {id: 'a'.repeat(64), pubkey: 'c'.repeat(64), kind: Kind.Post};
    await expect(runtime.comment('durable reply', root, root)).rejects.toThrow(BlindTokensExhausted);
    expect(drawNowCalls).toBe(1);
    expect(published.length).toBe(0);

    // NOT lost: rendered durably in the thread as a 'failed' placeholder (with Retry) + queued.
    const placeholder = runtime.getThread(root.id).find(n => n.event.content.includes('durable reply'));
    expect(placeholder).toBeDefined();
    expect(runtime.getSnapshot().sendStatus.get(placeholder!.event.id)).toBe('failed');
    const queued = (runtime as unknown as {pendingPosts: Array<{type?: string}>}).pendingPosts;
    expect(queued.length).toBe(1);
    expect(queued[0]!.type).toBe('comment'); // typed intent, not coerced to a post

    // Persistence contract (survives an app restart): the intent is written to the per-account recovery
    // blob carrying its type + root/parent refs, so loadPendingCompose can rebuild the EXACT comment.
    const persisted = [...(secure as unknown as {map: Map<string, string>}).map.entries()]
      .find(([k]) => k.includes('pending.compose'));
    expect(persisted).toBeDefined();
    const parsed = JSON.parse(persisted![1]) as Array<{type?: string; content: string; root?: {id: string}; parent?: {id: string}}>;
    expect(parsed.some(p => p.type === 'comment' && p.content.includes('durable reply') && p.root?.id === root.id && p.parent?.id === root.id)).toBe(true);

    // A later successful draw drains the queue and auto-publishes the comment — no user action, no
    // re-typing — and it lands as a real reply on the SAME root, spending the freshly-drawn token.
    jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({ok: true, tokens: [makeToken()]});
    const draw = await runtime.drawTokens(() => ({}) as never);
    expect(draw.ok).toBe(true);
    await jest.advanceTimersByTimeAsync(0); // flush the fire-and-forget drainPendingPosts()

    const delivered = published.find(e => e.content.includes('durable reply'));
    expect(delivered).toBeDefined();
    expect(runtime.getThread(root.id).some(n => n.event.id === delivered!.id)).toBe(true);
    expect(await runtime.walletBalance()).toBe(0);

    runtime.dispose();
  });
});

/**
 * Publish-durability FIX B — SILO SAFETY (security). A token-exhausted compose intent is queued with
 * the ACTIVE community+account captured at enqueue time. It must NEVER be re-signed with a DIFFERENT
 * community/account's feedSigner and published into that silo (wrong attribution + a cross-silo
 * identity link). Two independent guards enforce this: clearSwitchCaches() empties the queue on a
 * workspace switch (primary), and drainPendingPosts() only re-publishes intents whose captured
 * (cid, slotId) still equals the active pair, dropping the rest (defense-in-depth, for a drain racing
 * a switch). These tests exercise BOTH.
 */
describe('AppRuntime publish durability — a queued post never crosses communities/accounts (FIX B security)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const RELAY_A = community.relayUrl; // ws://aaaa…onion (the default test community)
  const RELAY_B = `ws://${'d'.repeat(56)}.onion`;
  const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
  const CK_B = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
  const ORG_A = 'a'.repeat(64);
  const ORG_B = 'b'.repeat(64);
  const ISSUER_FP = walletKeyFingerprint(community.issuerPublicKey);

  /** A v3 blind-posting session for `relayUrl` (communityKey engages the blind signer; organizerPubkey
   *  lets a later drawTokens() run). */
  async function sessionFor(relayUrl: string, ck: string, org: string): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {relayUrl, issuerPublicKey: community.issuerPublicKey, communityKey: ck, organizerPubkey: org},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  /** A multi-community runtime (per-cid stores) with NO drawTokensNow, so an empty wallet forces
   *  post() to queue + reject rather than transparently topping up. */
  function multiCommunityRuntime() {
    const secure = new InMemorySecureStorage();
    const stores = new Map<string, EventStore>();
    const makeStore = async (cid: string | null): Promise<EventStore> => {
      const key = cid ?? '__none__';
      let s = stores.get(key);
      if (!s) {
        s = new InMemoryEventStore();
        stores.set(key, s);
      }
      return s;
    };
    const published: Event[] = [];
    const runtime = new AppRuntime({
      secureStorage: secure,
      store: new SwappableEventStore(new InMemoryEventStore()),
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
    });
    return {runtime, secure, published};
  }

  /** Seed the ACTIVE account's blind-posting wallet directly (mirrors a real Tor top-up). */
  async function seedActiveWallet(secure: InMemorySecureStorage, fallbackRelay: string, n = 3): Promise<void> {
    const sid = (await new KeyRing(secure).getActiveSlotId()) ?? communityId(fallbackRelay);
    await new EpochWallet(secure, sid, ISSUER_FP).add(
      0,
      Array.from({length: n}, () => makeToken()),
    );
  }

  it('PRIMARY: a post queued in community A is dropped (never published into B) after switchCommunity(B) clears the queue', async () => {
    const {runtime, secure, published} = multiCommunityRuntime();
    await runtime.init();
    // Join both communities (A first → active; B in add mode → active), then return to A.
    await runtime.completeEnrollment(await sessionFor(RELAY_A, CK_A, ORG_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await runtime.completeEnrollment(await sessionFor(RELAY_B, CK_B, ORG_B), '1234', '');
    await runtime.switchCommunity(communityId(RELAY_A));

    // In A with an empty wallet + no drawTokensNow ⇒ post() queues the intent (cid=A) and rejects.
    await expect(runtime.post('secret-from-A')).rejects.toThrow(BlindTokensExhausted);
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(1);
    published.length = 0;

    // The user switches to B, whose wallet HAS tokens (so an unguarded drain COULD publish A's post
    // into B). switchCommunity → activateWorkspace → clearSwitchCaches empties the queue.
    await runtime.switchCommunity(communityId(RELAY_B));
    await seedActiveWallet(secure, RELAY_B, 3);
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(0); // cleared by the switch

    // A drain in B's context now finds nothing — A's content never reaches B's relay.
    await runtime.onRelayConnected();
    await jest.advanceTimersByTimeAsync(0);
    expect(published.some(e => e.content?.includes('secret-from-A'))).toBe(false);
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(0);

    runtime.dispose();
  });

  it('DEFENSE-IN-DEPTH: a stale A-scoped intent that somehow outlives the context flip is DROPPED by the (cid,slot) guard on drain, never published into B', async () => {
    const {runtime, secure, published} = multiCommunityRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await sessionFor(RELAY_A, CK_A, ORG_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    const slotA = (await runtime.listKeySlots()).activeId!;
    const cidA = communityId(RELAY_A);

    // Queue a post in A (empty wallet, no drawTokensNow), then join community B in ADD mode. FIX B:
    // completeEnrollment now clears the OUTGOING account's in-memory optimistic state (like a switch),
    // so the queue is emptied by the flip — the PRIMARY guard.
    await expect(runtime.post('secret-from-A-again')).rejects.toThrow(BlindTokensExhausted);
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(1);
    await runtime.completeEnrollment(await sessionFor(RELAY_B, CK_B, ORG_B), '1234', '');
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(0); // cleared by the flip
    await seedActiveWallet(secure, RELAY_B, 3); // B could sign+publish if the guard were absent
    published.length = 0;

    // Now DEFENSE-IN-DEPTH: simulate a stale A-scoped intent that somehow outlived the flip (e.g. a
    // drain racing the swap). Inject it directly, then drain in B's context — the per-intent (cid,
    // slotId) guard in drainPendingPosts must DROP it (intent.cid=A !== activeCid=B), never sign it
    // with B's feedSigner nor publish it into B's relay.
    (runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.push({
      id: 'local-stale-A',
      content: 'secret-from-A-again',
      tags: [],
      cid: cidA,
      slotId: slotA,
    });
    await runtime.onRelayConnected();
    await jest.advanceTimersByTimeAsync(0);
    expect(published.some(e => e.content?.includes('secret-from-A-again'))).toBe(false);
    expect((runtime as unknown as {pendingPosts: unknown[]}).pendingPosts.length).toBe(0);

    runtime.dispose();
  });
});

/**
 * M1 — the last two "sign-before-render" gaps (setPinnedComment, promoteChannelPost) now route
 * through signOptimisticWrite exactly like vote()/comment(): the placeholder renders INSTANTLY, and
 * the (potentially seconds-long, Tor-bound) blind draw+sign happens AFTER, in the background — an
 * empty wallet's on-demand draw-and-retry must never block the UI. These tests gate drawTokensNow on
 * an externally-resolved promise to freeze the draw exactly where a real Tor round-trip would stall,
 * then assert the placeholder is already visible (and nothing published yet) before releasing it.
 */
describe('AppRuntime M1 — setPinnedComment/promoteChannelPost render before the blind sign', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const CK = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
  const ORG_PUB = 'e'.repeat(64);

  /** A v3 (blind-posting) session — same recipe as the FIX B describe's blindSession() above. */
  async function blindSession(): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {...community, communityKey: CK, organizerPubkey: ORG_PUB},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  /** drawTokensNow gated on an externally-resolved promise — simulates the seconds-long Tor draw
   *  feedSigner awaits when the wallet is empty, so the test can inspect the render before it settles. */
  function gatedDraw() {
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(res => {
      release = res;
    });
    return {drawTokensNow: () => gate, release: (ok: boolean) => release(ok)};
  }

  it('setPinnedComment renders the placeholder BEFORE the gated blind sign resolves', async () => {
    const store = new InMemoryEventStore();
    const published: Event[] = [];
    const {drawTokensNow, release} = gatedDraw();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      drawTokensNow,
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    expect(await runtime.walletBalance()).toBe(0); // empty ⇒ sign() must hit the gated draw-and-retry
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    const done = runtime.setPinnedComment('p'.repeat(64), 'f'.repeat(64), Kind.Post, 'pinned note');
    await jest.advanceTimersByTimeAsync(0); // let the render + sign-until-gated run; the draw stays pending

    const placeholder = store.query({kinds: [Kind.Comment]}).find(e => e.content === 'pinned note');
    expect(placeholder).toBeDefined(); // rendered BEFORE the sign resolved — the M1 fix
    expect(runtime.getSnapshot().sendStatus.get(placeholder!.id)).toBe('sending');
    expect(published.length).toBe(0); // sign() is still gated — nothing published yet

    release(false); // draw ultimately fails (offline / cap hit) — matches feedSigner's existing contract
    await expect(done).rejects.toThrow(BlindTokensExhausted);
    runtime.dispose();
  });

  it('promoteChannelPost renders the feed placeholder BEFORE the gated blind sign resolves', async () => {
    const store = new InMemoryEventStore();
    const published: Event[] = [];
    const {drawTokensNow, release} = gatedDraw();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      drawTokensNow,
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    expect(await runtime.walletBalance()).toBe(0);
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    // A LiveChat (channel broadcast) source message — bypasses the private-space refusal check
    // entirely (that only applies to GroupKind.Chat), so promoteChannelPost proceeds straight into
    // the feed-post build+render.
    const source: Event = {
      id: 's'.repeat(64),
      pubkey: 'x'.repeat(64),
      created_at: 1000,
      kind: Kind.LiveChat,
      tags: [['a', `30311:${'x'.repeat(64)}:chan`, '', 'root']],
      content: 'original message',
      sig: '',
    };
    const done = runtime.promoteChannelPost(source, 'promoted content');
    await jest.advanceTimersByTimeAsync(0);

    // feed.items' content is header-stripped for display (withMyName may have prefixed an auto-
    // claimed gradient header onto the raw stored event) — match on the rendered item, like the
    // FIX B / optimistic tests do, not the raw store event.
    const placeholder = runtime.getSnapshot().feed.items.find(i => i.content === 'promoted content');
    expect(placeholder).toBeDefined(); // rendered BEFORE the sign resolved
    expect(runtime.getSnapshot().sendStatus.get(placeholder!.id)).toBe('sending');
    expect(published.length).toBe(0); // still gated — the source edit hasn't even been reached yet

    release(false);
    await expect(done).rejects.toThrow(BlindTokensExhausted);
    runtime.dispose();
  });

  // "Publish tap hangs for seconds" fix (defect 1b, 2026-07-15): App.tsx's onSubmit now calls
  // runtime.post() fire-and-forget — it does NOT await this promise before letting the composer
  // close, only attaching a `.catch` for the one-shot Alert (see App.tsx). That rewiring is only
  // correct because post() is GUARANTEED to render its durable placeholder before the (seconds-long)
  // blind draw+sign even starts, exactly like setPinnedComment/promoteChannelPost above. This test
  // pins that invariant directly against `post()` — if a future change moved renderPlaceholder to
  // after an await, App.tsx's fire-and-forget wiring would silently start racing an empty feed.
  it('post renders the placeholder BEFORE the gated blind sign resolves — safe for a caller to stop awaiting it once called', async () => {
    const store = new InMemoryEventStore();
    const published: Event[] = [];
    const {drawTokensNow, release} = gatedDraw();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        published.push(e);
        return {accepted: true, message: 'ok'};
      },
      drawTokensNow,
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');
    expect(await runtime.walletBalance()).toBe(0); // empty ⇒ sign() must hit the gated draw-and-retry
    published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself

    const done = runtime.post('should render before the draw settles');
    await jest.advanceTimersByTimeAsync(0); // let the render + sign-until-gated run; the draw stays pending

    // feed.items' content is header-stripped for display (withMyName may have prefixed an auto-
    // claimed gradient header onto the raw stored event) — match on the rendered item, like the
    // setPinnedComment/promoteChannelPost tests above.
    const placeholder = runtime.getSnapshot().feed.items.find(i => i.content === 'should render before the draw settles');
    expect(placeholder).toBeDefined(); // rendered BEFORE the sign resolved
    expect(runtime.getSnapshot().sendStatus.get(placeholder!.id)).toBe('sending');
    expect(published.length).toBe(0); // sign() is still gated — nothing published yet

    release(false); // draw ultimately fails (offline / cap hit)
    // post()'s OWN returned promise still carries the rejection unchanged — App.tsx just no longer
    // `await`s it from the composer; it routes this via a `.catch` (postFailureAlert) instead.
    await expect(done).rejects.toThrow(BlindTokensExhausted);
    runtime.dispose();
  });
});

/**
 * M2 — a low-water threshold refill fired after every successful blind spend (see feedSigner /
 * maybeRefillWallet), so the on-demand draw-and-retry safety net becomes practically unreachable in
 * normal use. Guarded by a single in-flight boolean so a burst of spends never stacks concurrent draws.
 */
describe('AppRuntime M2 — low-water background refill after a blind spend', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const CK = Buffer.from(new Uint8Array(32).fill(8)).toString('base64');
  const ORG_PUB = 'f'.repeat(64);

  async function blindSession(): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {...community, communityKey: CK, organizerPubkey: ORG_PUB},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  it('a spend that drops the wallet below 15 fires exactly one background refill, even racing a second spend', async () => {
    let drawNowCalls = 0;
    let releaseRefill!: (ok: boolean) => void;
    const refillGate = (): Promise<boolean> =>
      new Promise(res => {
        releaseRefill = res;
      });
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
      drawTokensNow: () => {
        drawNowCalls++;
        return refillGate();
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');

    // Seed exactly 15 tokens via the real proactive draw path (bound to the runtime's own wallet +
    // key fingerprint) — mirrors the FIX B describe's seeding pattern above.
    jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({
      ok: true,
      tokens: Array.from({length: 15}, () => makeToken()),
    });
    const draw = await runtime.drawTokens(() => ({}) as never);
    expect(draw.drawn).toBe(15);
    expect(await runtime.walletBalance()).toBe(15);

    // First spend: 15 → 14, below LOW_WATER_REFILL_THRESHOLD (15) ⇒ fires the ONE background refill.
    // drawTokensNow is gated, so the refill stays "in flight" through the second spend below.
    await runtime.vote('1'.repeat(64), 'a'.repeat(64), 'up');
    await jest.advanceTimersByTimeAsync(0); // let the fire-and-forget refill reach drawTokensNow()
    expect(await runtime.walletBalance()).toBe(14);
    expect(drawNowCalls).toBe(1);

    // Second spend while the first refill is still in flight: 14 → 13, still below threshold — the
    // in-flight guard must suppress a second, concurrent draw.
    await runtime.vote('2'.repeat(64), 'a'.repeat(64), 'up');
    await jest.advanceTimersByTimeAsync(0);
    expect(await runtime.walletBalance()).toBe(13);
    expect(drawNowCalls).toBe(1); // NOT stacked

    // Once the in-flight refill settles, the guard clears — a LATER spend can trigger another one.
    releaseRefill(true);
    await jest.advanceTimersByTimeAsync(0);
    await runtime.vote('3'.repeat(64), 'a'.repeat(64), 'up');
    await jest.advanceTimersByTimeAsync(0);
    expect(drawNowCalls).toBe(2);

    runtime.dispose();
  });
});

// 2026-07-21 members-only invisible-unlock incident: every AppRuntime surface that reads a
// possibly-sealed event's content must resolve it first (blind/blindPost.ts's resolveContent) so a
// still-locked body never reaches an embed card, a moderation snapshot, or an author-name learn.
describe('getEvent — sealed quoted/referenced post embed (members-only invisible unlock)', () => {
  afterEach(() => clearActiveContentKeys());

  it('resolves a locked sealed post to empty content, and the plaintext once its epoch unlocks', () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    const key = mintContentKey();
    const ct = encryptForSpace('members only body', key);
    const ev = assembleBlindEvent(
      {kind: 1, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '5']], content: ct},
      [makeToken()],
      'attr',
    );
    store.save(ev);

    // Locked: never the ciphertext, never a throw — a neutral empty summary.
    const locked = runtime.getEvent(ev.id);
    expect(locked).not.toBeNull();
    expect(locked!.content).toBe('');
    expect(locked!.content).not.toBe(ev.content);

    // Once this device holds epoch 5's key, the SAME lookup resolves the plaintext.
    setContentEpochKey(5, key);
    const unlocked = runtime.getEvent(ev.id);
    expect(unlocked!.content).toBe('members only body');
  });
});

describe('fetchNaddr — un-blacklist on failure (channel-open hang root cause)', () => {
  // requestedNaddrs used to be a permanent, session-long blacklist: fetchNaddr added a coordinate
  // to it before the underlying fetchByFilter dep was known to have succeeded, and nothing ever
  // removed it on failure — one attempt that raced a not-yet-open socket, or simply timed out over
  // Tor, meant that coordinate (a tapped channel embed's own 30311 metadata, e.g.) could never be
  // re-fetched for the rest of the session. Mirrors RelayClient.fetchByFilter's own un-blacklist.

  it('re-issues fetchByFilter for a naddr that never resolved, once the fetch window elapses', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      const fetchByFilter = jest.fn();
      const runtime = new AppRuntime({secureStorage: null, store, fetchByFilter});

      const owner = getPublicKey(generateSecretKey());
      const naddr = nip19.naddrEncode({kind: 30311, pubkey: owner, identifier: 'chan-1'});

      expect(runtime.getEvent(naddr)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      // Re-rendering the same unresolved embed while the first attempt is still "in flight" must
      // stay a no-op (the existing de-dupe behavior this fix must not regress).
      expect(runtime.getEvent(naddr)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      // Nothing ever lands in the store — simulate the underlying fetch never landing an event by
      // letting fetchNaddr's own un-blacklist window elapse with the coordinate still uncached.
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS);

      // A later render (or an explicit retry) now re-issues the fetch instead of staying silently
      // stuck for the rest of the session.
      expect(runtime.getEvent(naddr)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never re-issues once the coordinate genuinely resolves before the window elapses', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      const fetchByFilter = jest.fn();
      const runtime = new AppRuntime({secureStorage: null, store, fetchByFilter});

      const sk = generateSecretKey();
      const owner = getPublicKey(sk);
      const naddr = nip19.naddrEncode({kind: 30311, pubkey: owner, identifier: 'chan-2'});

      expect(runtime.getEvent(naddr)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      const channelDef = finalizeEvent(
        {kind: 30311, created_at: 1000, tags: [['d', 'chan-2'], ['title', 'General']], content: ''},
        sk,
      );
      store.save(channelDef);

      jest.advanceTimersByTime(FETCH_TIMEOUT_MS);

      expect(runtime.getEvent(naddr)).not.toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1); // never re-issued — it genuinely resolved
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("moderatorHide / reportPost — never publish a sealed target's ciphertext as a report snapshot", () => {
  afterEach(() => clearActiveContentKeys());

  it('omits the content-snapshot tag while the target is locked; embeds the plaintext once unlocked', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');

    const key = mintContentKey();
    const ct = encryptForSpace('a members-only post someone reported', key);
    const target = assembleBlindEvent(
      {kind: 1, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '3']], content: ct},
      [makeToken()],
      'attr',
    );
    store.save(target);

    await runtime.moderatorHide(target.id, target.pubkey, 'other');
    const reportsLocked = store.query({kinds: [Kind.Report]});
    const report1 = reportsLocked.find(r => r.tags.some(t => t[0] === 'e' && t[1] === target.id));
    expect(report1).toBeDefined();
    // Never the tag at all while locked — an omitted snapshot, not an empty/ciphertext one.
    expect(report1!.tags.some(t => t[0] === 'content-snapshot')).toBe(false);

    setContentEpochKey(3, key);
    await runtime.moderatorHide(target.id, target.pubkey, 'other');
    const reportsUnlocked = store.query({kinds: [Kind.Report]});
    const report2 = reportsUnlocked.find(
      r => r.id !== report1!.id && r.tags.some(t => t[0] === 'e' && t[1] === target.id),
    );
    expect(report2).toBeDefined();
    expect(report2!.tags.find(t => t[0] === 'content-snapshot')?.[1]).toBe(
      'a members-only post someone reported',
    );

    runtime.dispose();
  });
});

// Beyond-the-audit finding: handleIncomingEvent → learnNameFrom ran decodeNameHeader over a
// post/article/comment's RAW content, unconditionally — a still-sealed body's ciphertext could
// poison the display-name phonebook exactly like FIX 4 already guards against for private-group
// nip44 messages (a different mechanism, same risk).
describe("learnNameFrom — a sealed post's identity header is never parsed from ciphertext", () => {
  afterEach(() => clearActiveContentKeys());

  it('learns nothing while locked; learns the real name once the epoch unlocks', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');

    const key = mintContentKey();
    const withHeader = encodeIdentityHeader('hi everyone', 'Peer', '');
    const ct = encryptForSpace(withHeader, key);
    const sealedPost = assembleBlindEvent(
      {kind: 1, created_at: 900, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '13']], content: ct},
      [makeToken()],
      'attr',
    );
    store.save(sealedPost);
    runtime.handleIncomingEvent(sealedPost);
    // Locked: no plaintext header to learn from — never a name parsed out of ciphertext.
    expect(runtime.getProfile(sealedPost.pubkey).name).toBeUndefined();

    setContentEpochKey(13, key);
    runtime.handleIncomingEvent(sealedPost); // re-sighted now that this device holds the key
    expect(runtime.getProfile(sealedPost.pubkey).name).toBe('Peer');

    runtime.dispose();
  });

  // Beyond-the-audit finding (item 4): the original guard only fired for GroupKind.Chat — any OTHER
  // kind forging the same ['encrypted','nip44'] marker (without a real content-epoch seal, i.e. not
  // a blind/token post) slipped straight past it into resolveContent, which treats a non-blind event
  // as already-plaintext (isSealedContent gates on isBlindPost) — poisoning displayNames.
  it("generalizes the ciphertext guard beyond GroupKind.Chat: a non-blind event forging ['encrypted','nip44'] is never learned from", async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');

    const forgerSk = generateSecretKey();
    const forgerPk = getPublicKey(forgerSk);
    // NOT a blind post (no stiq_token tag) — isSealedContent is therefore false — yet it carries the
    // same ['encrypted','nip44'] marker a real seal (or a private-group message) would, with a
    // plaintext-shaped identity header sitting right behind it (not actually encrypted).
    const forged = finalizeEvent(
      {kind: 1, created_at: 900, tags: [[TAG_ENC, ENC_NIP44]], content: encodeIdentityHeader('hi', 'Forged', '')},
      forgerSk,
    );
    store.save(forged);
    runtime.handleIncomingEvent(forged);
    expect(runtime.getProfile(forgerPk).name).toBeUndefined();

    runtime.dispose();
  });
});

// F-attribution fix: a member's post used to render bare-npub ("anonymous") while their comment on
// the SAME screen — resolved via a different chain (resolveAuthor directly) — showed their display
// name. The shared resolver (profile/resolveDisplayIdentity.ts) is now the ONE path every
// attribution surface reads through, so the two can never diverge again.
describe('AppRuntime — shared attribution resolver (F-attribution)', () => {
  const CK = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
  const ORG_PUB = 'd'.repeat(64);

  /** A v3 (blind-posting) session, mirroring the FIX B suite's blindSession() helper. */
  async function blindSession(): Promise<Session> {
    const {enrollment} = await Enrollment.begin(
      {...community, communityKey: CK, organizerPubkey: ORG_PUB},
      new MockBlindRsa(),
      'STIQ-TEST-0001',
    );
    const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
    if (!result.ok) throw new Error('enrollment failed in setup');
    return result.session;
  }

  afterEach(() => {
    clearAuthorCache();
    clearActiveContentKeys();
  });

  it('feedItemFor AND resolveIdentityById agree on a blind post never touched by any prior buildFeed pass — neither renders anonymous', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const communityKeyBytes = decodeCommunityKey(runtime.getActiveCommunityKey()!)!;
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(
      {kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'hello community'},
      [makeToken()],
      authorSk,
      communityKeyBytes,
      {name: 'Bo'},
    );
    store.save(ev);
    // Deliberately skip handleIncomingEvent/buildFeed — this event has NEVER been through any
    // attestation-teaching pass. That gap (a phonebook-only lookup with no attestation fallback) is
    // exactly what let the post-detail header render "anonymous" for a first-ever-seen member.

    const viaFeedItemFor = runtime.feedItemFor(ev.id);
    const viaDetailResolver = runtime.resolveIdentityById(ev.id);
    expect(viaFeedItemFor?.authorPubkey).toBe(authorPk);
    expect(viaFeedItemFor?.authorName).toBe('Bo');
    expect(viaDetailResolver?.pubkey).toBe(authorPk);
    expect(viaDetailResolver?.name).toBe('Bo');
    // The two surfaces must agree — this is what used to diverge (post "anonymous", comment named).
    expect(viaDetailResolver?.name).toBe(viaFeedItemFor?.authorName);

    runtime.dispose();
  });

  it('getEvent (embed cards) attributes a blind COMMENT to its real author — name + claimed gradient, never the throwaway signer', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const communityKeyBytes = decodeCommunityKey(runtime.getActiveCommunityKey()!)!;
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const claimed = 'L135:ff0000,0000ff';
    const comment = toBlindEvent(
      {kind: Kind.Comment, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'good point'},
      [makeToken()],
      authorSk,
      communityKeyBytes,
      {name: 'Bo', gradient: claimed},
    );
    store.save(comment);
    expect(comment.pubkey).not.toBe(authorPk); // signed by a per-post throwaway key

    const summary = runtime.getEvent(comment.id);
    expect(summary).not.toBeNull();
    // The embed card renders WHOEVER this says — so it must be the member, not the throwaway.
    expect(summary!.pubkey).toBe(authorPk);
    expect(summary!.pubkey).not.toBe(comment.pubkey);
    expect(summary!.name).toBe('Bo');
    // ...and their gradient, not one seeded from a key nobody owns.
    expect(summary!.gradient).toEqual(decodeGradient(claimed));
    expect(summary!.gradient).not.toEqual(gradientFromSeed(nip19.npubEncode(comment.pubkey)));

    runtime.dispose();
  });

  it('resolveIdentityById is null for an id the store has never seen (never crashes, never fabricates an identity)', async () => {
    const runtime = newRuntime();
    await runtime.init();
    expect(runtime.resolveIdentityById('0'.repeat(64))).toBeNull();
    runtime.dispose();
  });

  it('learnFromUnlockedEpoch (item 3b): the moment a sealed epoch unlocks, an already-synced blind post sealed under it teaches the phonebook — keyed on the REAL author, never the throwaway signer', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await blindSession(), '1234', '9999');
    await runtime.submitPin('1234');

    const communityKeyBytes = decodeCommunityKey(runtime.getActiveCommunityKey()!)!;
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);

    const key = mintContentKey();
    const withHeader = encodeIdentityHeader('sealed body', 'SealedName', '');
    const ct = encryptForSpace(withHeader, key);
    const sealedBlindPost = toBlindEvent(
      {kind: 1, created_at: 900, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '77']], content: ct},
      [makeToken()],
      authorSk,
      communityKeyBytes,
      {},
    );
    store.save(sealedBlindPost);
    runtime.handleIncomingEvent(sealedBlindPost); // arrives while locked — the guard skips it
    expect(runtime.getProfile(authorPk).name).toBeUndefined();
    expect(runtime.getProfile(sealedBlindPost.pubkey).name).toBeUndefined(); // never the throwaway either

    setContentEpochKey(77, key);
    // The automatic sweep (called from unlockContentEpoch in production) — invoked directly here to
    // isolate it from the Tor-backed draw/unlock round-trip.
    (runtime as unknown as {learnFromUnlockedEpoch(epoch: number): void}).learnFromUnlockedEpoch(77);
    expect(runtime.getProfile(authorPk).name).toBe('SealedName');

    runtime.dispose();
  });
});
