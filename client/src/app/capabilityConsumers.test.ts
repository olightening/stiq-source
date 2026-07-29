/**
 * Relay-capability CONSUMER wiring (C4 PoW, C5 domain-separation verification, weight-pricing).
 *
 * Proves the four consumers of the negotiated {@link RelayCapabilities} source their values from the
 * live caps and, crucially, are SHIP-AHEAD SAFE: at caps fallback (relay hasn't advertised the block)
 * behaviour is byte-identical to the build constants. Uses the same in-memory enrollment harness as
 * blindSilo.regression.test.ts so a v3 community's blind signer + wallet are live.
 */
// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppRuntime} from './AppRuntime';
import * as drawExchange from '../blind/drawExchange';
import {Identity} from '../keys/identity';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {getBytesPerToken, setBytesPerToken} from '../blind/tokenCost';
import {CAPS_SCHEMA_PURPOSE_FINGERPRINTS} from '../nostr/capabilities';
import {clearRecentLogs, getRecentLogs, log} from '../util/log';
import {DM_POW_DIFFICULTY, ENROLL_POW_DIFFICULTY} from '../config';
import type {Community} from '../onboarding/community';
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ORG_SK = new Uint8Array(32).fill(11);
const ORG_PUB = getPublicKey(ORG_SK);
const ISSUER = 'aXNz'; // the posting/enroll issuer key of the test community
const ISSUER_FP = walletKeyFingerprint(ISSUER);
// T1.4/F6: a rotated posting key + a dedicated space-write key, used by the rotation-safe /
// re-sync / space-write drift tests below.
const NEW_POST_KEY = Buffer.from('rotated-post-key').toString('base64');
const NEW_POST_FP = walletKeyFingerprint(NEW_POST_KEY);
const SPACE_KEY = Buffer.from('space-write-key').toString('base64');
const SPACE_KEY_FP = walletKeyFingerprint(SPACE_KEY);

const v3 = (): Community => ({relayUrl: RELAY, issuerPublicKey: ISSUER, organizerPubkey: ORG_PUB, communityKey: CK});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** Build an enrolled+unlocked runtime whose NIP-11 fetch returns `relayInfo()` (mutable per test). */
function newRuntime(relayInfo: () => unknown) {
  const secure = new InMemorySecureStorage();
  const stores = new Map<string, EventStore>();
  const makeStore = async (cid: string | null): Promise<EventStore> => {
    const key = cid ?? '__none__';
    let store = stores.get(key);
    if (!store) {
      store = new InMemoryEventStore();
      stores.set(key, store);
    }
    return store;
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
    fetchRelayInfo: async () => relayInfo(),
  });
  return {runtime, secure, published};
}

async function slotIdFor(secure: InMemorySecureStorage): Promise<string> {
  const ring = new KeyRing(secure);
  return (await ring.getActiveSlotId()) ?? communityId(RELAY);
}

/** Seed the active community's blind-posting wallet, stamped under a SPECIFIC issuer-key fingerprint
 *  — lets a test seed tokens AFTER a key rotation/re-sync, once the runtime wallet has rebound to a
 *  NEW fingerprint (the default `seedWallet` below always stamps the fixture's original ISSUER_FP). */
async function seedWalletFp(secure: InMemorySecureStorage, fp: string, n = 5): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure), fp);
  // Real holder-bound keypairs (P3): these tokens are spent + posted blind by the runtime.
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

/** Seed the active community's blind-posting wallet so a real post can spend a token. */
async function seedWallet(secure: InMemorySecureStorage, n = 5): Promise<void> {
  return seedWalletFp(secure, ISSUER_FP, n);
}

/** Drain the fire-and-forget promise chain handleIncomingEvent kicks off (mirrors
 *  AppRuntime.mirrors.test.ts's helper of the same name). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A kind-30078 `d=stiq:token-keys` doc signed by the active organizer (ORG_SK) — the live re-sync
 *  path a client adopts new/rotated purpose keys from (T1.4/F6). `fields` uses the short wire keys
 *  (`pk`, `swk`, …) exactly like the join code / organizer's publishTokenKeys. */
function tokenKeysDoc(fields: Record<string, string>, createdAt = 1000): Event {
  return finalizeEvent(
    {kind: 30078, created_at: createdAt, tags: [['d', 'stiq:token-keys']], content: JSON.stringify(fields)},
    ORG_SK,
  );
}

/** A fully-enrolled, unlocked runtime on the v3 community. */
async function enrolled(relayInfo: () => unknown) {
  const h = newRuntime(relayInfo);
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  return h;
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const isBlind = (e: Event): boolean => e.tags.some(t => t[0] === 'stiq_token' && !!t[1]);

afterEach(() => {
  jest.restoreAllMocks();
  setBytesPerToken(0); // reset the tokenCost module global between tests
});

describe('C4 — capability-driven PoW', () => {
  it('enroll draw mines to caps.enrollPow when the relay advertises it (raised without a new client)', async () => {
    const {runtime} = await enrolled(() => capsDoc({enroll_pow: 17}));
    await runtime.onRelayConnected(); // negotiate caps → enrollPow = 17
    const spy = jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({ok: true, tokens: []});
    await runtime.drawTokens(() => ({}) as never);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({powDifficulty: 17}));
    runtime.dispose();
  });

  it('enroll draw falls back to ENROLL_POW_DIFFICULTY at caps fallback (relay silent)', async () => {
    const {runtime} = await enrolled(() => ({})); // no stiq-capabilities block
    await runtime.onRelayConnected();
    const spy = jest.spyOn(drawExchange, 'runTokenDraw').mockResolvedValue({ok: true, tokens: []});
    await runtime.drawTokens(() => ({}) as never);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({powDifficulty: ENROLL_POW_DIFFICULTY}));
    runtime.dispose();
  });

  it('DM seal mines to caps.dmPow when advertised, and to DM_POW_DIFFICULTY at fallback', async () => {
    const peer = getPublicKey(generateSecretKey());
    const fakeWrap = finalizeEvent(
      {kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', peer]], content: 'x'},
      generateSecretKey(),
    );
    const sealSpy = jest
      .spyOn(Identity.prototype, 'sealDM')
      .mockResolvedValue({wrap: fakeWrap, rumorId: 'r'});

    // Fallback: caps never negotiated → dmPow = DM_POW_DIFFICULTY.
    const {runtime} = await enrolled(() => capsDoc({dm_pow: 9}));
    await runtime.sendDM(peer, 'before caps');
    expect(sealSpy).toHaveBeenLastCalledWith(peer, expect.any(String), undefined, DM_POW_DIFFICULTY, expect.any(Function));

    // Advertised: after negotiation dmPow = 9.
    await runtime.onRelayConnected();
    await runtime.sendDM(peer, 'after caps');
    expect(sealSpy).toHaveBeenLastCalledWith(peer, expect.any(String), undefined, 9, expect.any(Function));
    runtime.dispose();
  });
});

describe('C5 — domain-separation verification', () => {
  // The schema at/above which a fingerprint mismatch HARD-blocks; below it, advisory only. Kept in
  // step with CAPS_SCHEMA_PURPOSE_FINGERPRINTS in ../nostr/capabilities.
  const AT = CAPS_SCHEMA_PURPOSE_FINGERPRINTS;
  const BELOW = CAPS_SCHEMA_PURPOSE_FINGERPRINTS - 1;

  it('MISMATCH at/above schema threshold: posting fingerprint the community key does not match → post fails loudly', async () => {
    const wrongFp = walletKeyFingerprint('SOME-OTHER-KEY');
    const {runtime} = await enrolled(() =>
      capsDoc({schema_version: AT, purpose_key_fingerprints: {posting: wrongFp}}),
    );
    await runtime.onRelayConnected(); // negotiate caps → mismatch flagged (schema guarantees format)
    await expect(runtime.post('should be blocked')).rejects.toThrow('community mis-provisioned — update your invite');
    runtime.dispose();
  });

  it('MISMATCH below schema threshold: ADVISORY only — no block, posting still works (format not yet pinned)', async () => {
    const wrongFp = walletKeyFingerprint('SOME-OTHER-KEY');
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({schema_version: BELOW, purpose_key_fingerprints: {posting: wrongFp}}),
    );
    clearRecentLogs();
    await runtime.onRelayConnected(); // caps say schema < threshold → do NOT enforce
    await seedWallet(secure);
    published.length = 0;
    // Posting is NOT blocked — a mismatch below the pinned-format schema can't brick the community.
    await expect(runtime.post('still posts')).resolves.toBeUndefined();
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    // But it IS surfaced as an advisory warning (not silently swallowed).
    expect(
      getRecentLogs().some(l => l.level === 'warn' && /C5 provisioning advisory/.test(l.msg)),
    ).toBe(true);
    runtime.dispose();
  });

  it('READ-HALF (Trap 2) at/above threshold: relay advertises read metering but invite has no rk → blocks', async () => {
    // v3 community carries NO readIssuerPublicKey (no `rk`), so activeReadKeyFp is undefined.
    const {runtime} = await enrolled(() =>
      capsDoc({schema_version: AT, purpose_key_fingerprints: {read: walletKeyFingerprint('READ-KEY')}}),
    );
    await runtime.onRelayConnected();
    await expect(runtime.post('needs updated invite')).rejects.toThrow(
      'community mis-provisioned — update your invite',
    );
    runtime.dispose();
  });

  it('READ-HALF below threshold: rk-less invite + read metering advertised → advisory only, posting works', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({schema_version: BELOW, purpose_key_fingerprints: {read: walletKeyFingerprint('READ-KEY')}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);
    published.length = 0;
    await expect(runtime.post('still posts')).resolves.toBeUndefined();
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    runtime.dispose();
  });

  it('MATCH at/above threshold: relay advertises the community’s own posting fingerprint → posting proceeds (blind)', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({schema_version: AT, purpose_key_fingerprints: {posting: ISSUER_FP}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);
    published.length = 0;
    await expect(runtime.post('should post')).resolves.toBeUndefined();
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    runtime.dispose();
  });

  it('REAL relay wire format (issuer_key_fingerprints array + sha256: prefix, full hash) MATCHES via prefix compare', async () => {
    // The production relay advertises the posting key as a full-length sha256 hex inside a
    // `["sha256:<hex>"]` array; the client fingerprint (ISSUER_FP) is its 16-hex prefix.
    // verifyCommunityProvisioning must unwrap the array, strip `sha256:`, and prefix-match — NOT block.
    const relayFull = `sha256:${ISSUER_FP}${'0'.repeat(48)}`;
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [relayFull], enroll: [relayFull]}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);
    published.length = 0;
    await expect(runtime.post('should post')).resolves.toBeUndefined();
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    runtime.dispose();
  });

  it('REAL relay wire format MISMATCH at/above threshold → post blocked loudly', async () => {
    const wrongFull = `sha256:${walletKeyFingerprint('SOME-OTHER-KEY')}${'0'.repeat(48)}`;
    const {runtime} = await enrolled(() =>
      capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [wrongFull]}}),
    );
    await runtime.onRelayConnected();
    await expect(runtime.post('should be blocked')).rejects.toThrow(
      'community mis-provisioned — update your invite',
    );
    runtime.dispose();
  });

  it('NO fingerprints (caps fallback): no check, posting behaves exactly as today', async () => {
    const {runtime, secure, published} = await enrolled(() => ({})); // relay advertises nothing
    await runtime.onRelayConnected();
    await seedWallet(secure);
    published.length = 0;
    await expect(runtime.post('unchanged')).resolves.toBeUndefined();
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    runtime.dispose();
  });

  // T1.4/F6 — rotation-safe SET compare: the relay advertises each domain as an ARRAY of currently
  // valid fingerprints (a rotation runs the OLD and NEW key in parallel), and a wallet key is stale
  // iff it matches NONE of them — never "differs from entry[0]".
  describe('T1.4/F6 — rotation-safe fingerprint SET compare + space-write coverage', () => {
    it('(a) ROTATION OVERLAP: a wallet key matching a NON-FIRST array entry is NOT flagged stale', async () => {
      const {runtime, secure, published} = await enrolled(() =>
        capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [NEW_POST_FP, ISSUER_FP]}}),
      );
      await runtime.onRelayConnected(); // ISSUER_FP is the SECOND entry — must still match
      await seedWallet(secure);
      published.length = 0;
      await expect(runtime.post('mid-rotation overlap still posts')).resolves.toBeUndefined();
      expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
      runtime.dispose();
    });

    it('(b) STALE: a wallet key matching NO entry in the array IS flagged and blocks mis-blinding', async () => {
      const wrongA = walletKeyFingerprint('SOME-OTHER-KEY-A');
      const wrongB = walletKeyFingerprint('SOME-OTHER-KEY-B');
      const {runtime} = await enrolled(() =>
        capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [wrongA, wrongB]}}),
      );
      await runtime.onRelayConnected(); // ISSUER_FP matches NEITHER entry → genuinely stale
      await expect(runtime.post('should be blocked')).rejects.toThrow(
        'community mis-provisioned — update your invite',
      );
      runtime.dispose();
    });

    it('(c) RE-SYNC: a posting-key mismatch clears once a live stiq:token-keys doc adopts the matching key (not a permanent brick)', async () => {
      const {runtime, secure, published} = await enrolled(() =>
        capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [NEW_POST_FP]}}),
      );
      await runtime.onRelayConnected(); // today's key (ISSUER_FP) matches nothing yet → blocked
      await expect(runtime.post('blocked before resync')).rejects.toThrow(
        'community mis-provisioned — update your invite',
      );

      // The organizer republishes stiq:token-keys with the rotated posting key (`pk`) — the live
      // re-sync path (T1.4/F6): this must land WITHOUT a restart or re-enrollment.
      runtime.handleIncomingEvent(tokenKeysDoc({pk: NEW_POST_KEY}));
      await flushMicrotasks();

      // The runtime wallet is now bound to NEW_POST_FP — seed tokens under THAT fingerprint.
      await seedWalletFp(secure, NEW_POST_FP);
      published.length = 0;
      await expect(runtime.post('should post now')).resolves.toBeUndefined();
      expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
      runtime.dispose();
    });

    it('(d) F6 CLOSED: a stale SPACE-WRITE key is now caught (previously had no fingerprint field at all)', async () => {
      // The community carries no dedicated spaceWriteIssuerPublicKey, so it falls back to the
      // enrollment key (ISSUER_FP) — but the relay advertises a DIFFERENT space-write set. Before
      // T1.4 this sailed straight through (no spaceWrite field existed to compare against).
      const {runtime} = await enrolled(() =>
        capsDoc({schema_version: AT, issuer_key_fingerprints: {space_write: [SPACE_KEY_FP]}}),
      );
      await runtime.onRelayConnected();
      await expect(runtime.post('space-write key mismatch blocks posting too')).rejects.toThrow(
        'community mis-provisioned — update your invite',
      );
      runtime.dispose();
    });

    it('(d) MATCH: the relay advertising the community’s own (fallback-to-enroll) space-write fingerprint does NOT block', async () => {
      const {runtime, secure, published} = await enrolled(() =>
        capsDoc({schema_version: AT, issuer_key_fingerprints: {space_write: [ISSUER_FP]}}),
      );
      await runtime.onRelayConnected();
      await seedWallet(secure);
      published.length = 0;
      await expect(runtime.post('space-write key matches, posts fine')).resolves.toBeUndefined();
      expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
      runtime.dispose();
    });
  });
});

describe('weight-pricing — driven by caps.enforcedFlags.bytesPerToken', () => {
  beforeEach(async () => {
    // Sticky enforcement (2026-07-28) persists explicitly-advertised flags per community in
    // AsyncStorage — a file-scoped singleton under the global jest mock. Earlier describes in this
    // file advertise bytes_per_token for the SAME test cid, which leaked into the caps-fallback
    // case below and broke its stays-off-at-0 expectation (identically on master). Same hygiene as
    // AppRuntime.capsSticky.test.ts / spaceReactions.test.ts.
    await AsyncStorage.clear();
  });
  it('activates pricing at the advertised rate (bytes_per_token > 0)', async () => {
    const {runtime} = await enrolled(() => capsDoc({enforced: {bytes_per_token: 256}}));
    expect(getBytesPerToken()).toBe(0); // off until caps are negotiated
    await runtime.onRelayConnected();
    expect(getBytesPerToken()).toBe(256);
    runtime.dispose();
  });

  it('stays off (0) at caps fallback → every post costs exactly one token, unchanged', async () => {
    const {runtime} = await enrolled(() => ({})); // no bytes_per_token advertised
    await runtime.onRelayConnected();
    expect(getBytesPerToken()).toBe(0);
    runtime.dispose();
  });
});

describe('T5.1/F18 — AppSnapshot.tokenStatus (wallet counts + C5 drift wiring)', () => {
  const AT = CAPS_SCHEMA_PURPOSE_FINGERPRINTS;

  beforeEach(() => clearRecentLogs());

  it('wallet counts start at zero and populate after refreshTokenWalletCounts()', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    expect(runtime.getSnapshot().tokenStatus.wallets).toEqual({
      post: 0,
      read: 0,
      pictureWrite: 0,
      pictureRead: 0,
      audioWrite: 0,
      audioRead: 0,
      spaceWrite: 0,
    });

    await seedWallet(secure, 7);
    const counts = await runtime.refreshTokenWalletCounts();
    expect(counts.post).toBe(7);
    expect(runtime.getSnapshot().tokenStatus.wallets.post).toBe(7);
    // The six pooled auxiliary purposes were never seeded — stay zero, not undefined/NaN.
    expect(runtime.getSnapshot().tokenStatus.wallets.spaceWrite).toBe(0);
    expect(runtime.getSnapshot().tokenStatus.wallets.read).toBe(0);
    runtime.dispose();
  });

  it('wallet row view pairs each count with whether its relay gate is on (post always active)', async () => {
    const {runtime, secure} = await enrolled(() =>
      capsDoc({enforced: {space_tokens_required: true}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure, 3);
    await runtime.refreshTokenWalletCounts();
    const rows = runtime.getSnapshot().tokenStatus.walletRows;
    expect(rows.find(r => r.purpose === 'post')).toMatchObject({count: 3, active: true});
    expect(rows.find(r => r.purpose === 'spaceWrite')).toMatchObject({count: 0, active: true});
    expect(rows.find(r => r.purpose === 'audioRead')).toMatchObject({active: false}); // no consumer (F12)
    runtime.dispose();
  });

  it('domain table MATCHES via the real relay wire format (array + sha256: prefix) → ok, no communityKeyError', async () => {
    const relayFull = `sha256:${ISSUER_FP}${'0'.repeat(48)}`;
    const {runtime} = await enrolled(() =>
      capsDoc({schema_version: AT, issuer_key_fingerprints: {posting: [relayFull]}}),
    );
    await runtime.onRelayConnected();
    const snap = runtime.getSnapshot();
    const posting = snap.tokenStatus.domains.find(d => d.domain === 'posting');
    expect(posting).toMatchObject({
      advertised: true,
      relayKeyCount: 1,
      walletFingerprint: ISSUER_FP,
      verdict: 'ok',
    });
    expect(snap.tokenStatus.communityKeyError).toBeUndefined();
    runtime.dispose();
  });

  it('domain table flags STALE on a genuine mismatch, mirroring the same reason as communityKeyError', async () => {
    const wrongFp = walletKeyFingerprint('SOME-OTHER-KEY');
    const {runtime} = await enrolled(() =>
      capsDoc({schema_version: AT, purpose_key_fingerprints: {posting: wrongFp}}),
    );
    await runtime.onRelayConnected();
    const snap = runtime.getSnapshot();
    const posting = snap.tokenStatus.domains.find(d => d.domain === 'posting');
    expect(posting).toMatchObject({verdict: 'stale', walletFingerprint: ISSUER_FP});
    expect(snap.tokenStatus.communityKeyError).toBe('community mis-provisioned — update your invite');
    runtime.dispose();
  });

  it('domain table reads UNKNOWN (not stale) when the relay is silent on a domain — caps fallback', async () => {
    const {runtime} = await enrolled(() => ({})); // no stiq-capabilities block at all
    await runtime.onRelayConnected();
    const domains = runtime.getSnapshot().tokenStatus.domains;
    expect(domains.every(d => d.verdict === 'unknown')).toBe(true);
    expect(domains.find(d => d.domain === 'posting')).toMatchObject({advertised: false, relayKeyCount: 0});
    runtime.dispose();
  });

  it('recentFailures mirrors the diagnostic log ring buffer, newest-first, non-token scopes excluded', async () => {
    const {runtime} = await enrolled(() => ({}));
    log.warn('wallet', 'space-write write exhausted its space-write tokens — queued for retry');
    log.info('relay', 'NOTICE: unrelated — must not appear (wrong scope)');
    const failures = runtime.getSnapshot().tokenStatus.recentFailures;
    expect(failures[0]).toMatchObject({scope: 'wallet', message: expect.stringContaining('exhausted')});
    expect(failures.some(f => f.scope === 'relay')).toBe(false);
    runtime.dispose();
  });
});
