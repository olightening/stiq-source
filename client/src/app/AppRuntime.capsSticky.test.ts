// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so the
// runtime logic can be exercised in the test environment (same preamble as reconnectCapsFlush).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import type {Community} from '../onboarding/community';

/**
 * Sticky per-community enforcement (the 2026-07-28 caps-fallback split-brain fix, OPEN_ITEMS
 * §2.1c). The hazard: `defaultRelayCapabilities()` says `spaceTokensRequired: false`, and the
 * runtime falls back to it on a cold start, a community switch, and any window where the NIP-11
 * fetch fails while the relay socket itself is healthy — so a token-ENFORCING community received
 * token-less space writes BY DESIGN and rejected them all as "out of tokens".
 *
 * The contract these tests pin:
 *   • only an EXPLICIT advertisement changes what the client believes is enforced — in EITHER
 *     direction (the T-G3b flip-pickup contract is preserved, not weakened);
 *   • a doc that omits the block/field, or a fetch that fails outright, NEVER downgrades;
 *   • the record survives a restart (persisted per community), so the pre-first-fetch window of
 *     the next cold start already attaches tokens.
 */
const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const community = (): Community => ({relayUrl: RELAY, issuerPublicKey: 'aXNz'});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community(), new MockBlindRsa(), 'STIQ-TEST-STICKY');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function makeRuntime(fetchRelayInfo: () => unknown): AppRuntime {
  return new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store: new SwappableEventStore(new InMemoryEventStore()),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
    fetchRelayInfo: async () => fetchRelayInfo(),
  });
}

const spaceTokens = (runtime: AppRuntime): boolean =>
  runtime.relayCapabilities().enforcedFlags.spaceTokensRequired;

const contentEnc = (runtime: AppRuntime): boolean =>
  runtime.relayCapabilities().enforcedFlags.contentEncryption;

describe('sticky enforcement flags (caps-fallback split-brain fix)', () => {
  beforeEach(async () => {
    // The sticky record deliberately persists across runtimes INSIDE a test (that's the restart
    // test) — but between tests it must start clean, or one test's advertisement leaks into the
    // next test's "never advertised" world.
    await AsyncStorage.clear();
  });

  it('an absent stiq block no longer downgrades a known-enforcing community; an explicit false still does', async () => {
    let doc: unknown = {'stiq-capabilities': {enforced: {space_tokens_required: true}}};
    const runtime = makeRuntime(() => doc);
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    // An older/degraded doc with NO stiq block at all: pre-fix this parsed to the constant
    // fallback (false) and the very next channel message went out token-less. Now: absence is
    // not a downgrade — the sticky record stands.
    doc = {};
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    // A block that's present but silent on this FIELD is absence too.
    doc = {'stiq-capabilities': {enforced: {blind_required: false}}};
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    // The T-G3b contract is intact: an EXPLICIT false is a real operator downgrade and lands.
    doc = {'stiq-capabilities': {enforced: {space_tokens_required: false}}};
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(false);

    // And an explicit re-enable lands too — stickiness never wedges a flag in either direction.
    doc = {'stiq-capabilities': {enforced: {space_tokens_required: true}}};
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    runtime.dispose();
  });

  it('a failed NIP-11 fetch keeps the enforcing view (the outage window that minted "out of tokens")', async () => {
    let fail = false;
    const runtime = makeRuntime(() => {
      if (fail) throw new Error('nip-11 circuit dead');
      return {'stiq-capabilities': {enforced: {space_tokens_required: true}}};
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    // The outage's exact split-brain: relay WS reconnects fine, the NIP-11 fetch (its own Tor
    // circuit) dies. The enforcing view must survive the reconnect.
    fail = true;
    await runtime.onRelayConnected();
    expect(spaceTokens(runtime)).toBe(true);

    runtime.dispose();
  });

  it('content_encryption sticks across dead/degraded NIP-11 fetches — a downed or withholding primary can never silently turn sealing off (mirror-federation invariant)', async () => {
    // Capability authority is the community PRIMARY (communityStore.relayUrl) — mirrors are never
    // NIP-11-fetched, and MirrorSet's withholding-promotion does not re-point the fetch. So the only
    // relay that can change this flag is the primary itself; while it is down (the exact window
    // where secondaries carry the community) the sticky record must keep sealing ON, or every post
    // written during the outage would leak plaintext to EVERY mirror.
    let doc: unknown = {'stiq-capabilities': {enforced: {content_encryption: true}}};
    let fail = false;
    const runtime = makeRuntime(() => {
      if (fail) throw new Error('primary onion unreachable');
      return doc;
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    await runtime.onRelayConnected();
    expect(contentEnc(runtime)).toBe(true);

    // Primary down; reads/writes ride the mirrors. Fetch fails outright — sealing view survives.
    fail = true;
    await runtime.onRelayConnected();
    expect(contentEnc(runtime)).toBe(true);

    // Primary back but serving a degraded/older doc with no stiq block — absence is not a downgrade.
    fail = false;
    doc = {};
    await runtime.onRelayConnected();
    expect(contentEnc(runtime)).toBe(true);

    // Only the primary's EXPLICIT false — the deliberate organizer rollback — lands.
    doc = {'stiq-capabilities': {enforced: {content_encryption: false}}};
    await runtime.onRelayConnected();
    expect(contentEnc(runtime)).toBe(false);

    runtime.dispose();
  });

  it('the record survives a RESTART: a fresh runtime enforces before its relay ever advertises again', async () => {
    // Session 1: the relay explicitly advertises enforcement; dispose (app killed).
    const first = makeRuntime(() => ({
      'stiq-capabilities': {enforced: {space_tokens_required: true, bytes_per_token: 256}},
    }));
    await first.init();
    await first.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await first.submitPin('1234')).toBe('unlocked');
    await first.onRelayConnected();
    expect(spaceTokens(first)).toBe(true);
    first.dispose();

    // Session 2 (same device — the AsyncStorage module mock persists): every NIP-11 fetch of this
    // run returns a block-less doc, the exact shape of a cold start whose capability circuit is
    // struggling. Pre-fix this session would post token-less until one fetch succeeded; now the
    // persisted record already enforces.
    const second = makeRuntime(() => ({}));
    await second.init();
    await second.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await second.submitPin('1234')).toBe('unlocked');
    await second.onRelayConnected();
    expect(spaceTokens(second)).toBe(true);
    expect(second.relayCapabilities().enforcedFlags.bytesPerToken).toBe(256);
    second.dispose();
  });
});
