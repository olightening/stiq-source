/**
 * F10 durable draw staging — AppRuntime wiring (TOKEN_FIXING_PLAN.md T3.1).
 *
 * A freshly-organizer-signed token batch otherwise lives ONLY in the JS heap between runTokenDraw()
 * resolving and wallet.add() persisting it — a process kill in that window loses the whole paid batch
 * with no recovery (the throwaway reply key lived only in a closure). This suite proves the fix at the
 * AppRuntime integration level: a marker is durably staged (in the SAME per-account SecureStorage the
 * wallet uses) before the mailbox round-trip, survives past the owning AppRuntime instance being
 * discarded (modeling the process dying), and is recovered by a FRESH AppRuntime instance sharing only
 * that storage on its very next draw call — without re-charging the organizer's epoch quota.
 *
 * runTokenDraw/resumeTokenDraw are mocked at the module boundary (same convention as
 * contentUnlock.test.ts/spaceWrites.durable.test.ts) so this suite exercises the REAL AppRuntime
 * orchestration (marker persistence keyed by the real active slot, wallet.add integration, marker
 * clearing) without re-deriving the network/crypto plumbing — drawExchange.test.ts's
 * "resumeTokenDraw — real blind-RSA round trip" test separately proves that plumbing end to end with
 * real RSA-PSS keys, so the marker's contents are known to be sufficient to actually finalize a batch.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import * as drawMod from '../blind/drawExchange';
import type {DrawMarker} from '../blind/drawExchange';
import {loadDrawMarker} from '../blind/drawStaging';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet} from '../blind/wallet';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ISSUER = 'aXNz';
const ORG = 'a'.repeat(64); // opaque organizer pubkey — mocked draws never touch real crypto with it
const identityHash = async (d: Uint8Array) => d;

const v3 = (): Community => ({relayUrl: RELAY, issuerPublicKey: ISSUER, organizerPubkey: ORG, communityKey: CK});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-F10-DRAW');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(secure: InMemorySecureStorage) {
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new SwappableEventStore(new InMemoryEventStore()),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    fetchRelayInfo: async () => ({}),
  });
  return {runtime, published};
}

async function slotIdFor(secure: InMemorySecureStorage): Promise<string> {
  const ring = new KeyRing(secure);
  return (await ring.getActiveSlotId()) ?? communityId(RELAY);
}

const noConnect = () => ({}) as never; // runTokenDraw/resumeTokenDraw are module-mocked → connect unused

function fakeMarker(credId: string): DrawMarker {
  return {
    schemaV: 1,
    credId,
    epoch: 1,
    purpose: 'post',
    reqHash: 'hash-x',
    issuerPublicKey: ISSUER,
    organizerPubkey: ORG,
    requestEvent: {
      id: 'req-x',
      pubkey: 'p'.repeat(64),
      created_at: 0,
      kind: 9024,
      tags: [],
      content: 'cipher',
      sig: 's'.repeat(128),
    },
    replyPubkey: 'r'.repeat(64),
    respConvKey: 'Y29udmtleQ==',
    items: [],
    savedAt: Date.now(),
  };
}

function fakeTokens(n: number, tag: number) {
  return Array.from({length: n}, (_, i) => ({
    token: Uint8Array.of(tag, i),
    sig: Uint8Array.of(tag, i, 1),
    secret: Uint8Array.of(tag, i, 2),
  }));
}

/** Drain the fire-and-forget promise chains the draw path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('F10: a draw-in-flight marker survives a killed process and is recovered on the next call', () => {
  it('stages a marker before the round-trip; a fresh AppRuntime over the same storage recovers the batch via resumeStagedDraw, without re-drawing the recovered tokens', async () => {
    const secure = new InMemorySecureStorage();

    // --- Before the "kill": the first runtime starts a draw whose organizer round-trip never
    // completes from the caller's point of view (models a process kill any time after staging). ---
    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw');
    drawSpy.mockImplementationOnce(async opts => {
      // Real drawExchange behavior: onMarker fires BEFORE the mailbox round-trip. Capture that this
      // wiring actually ran, then hang forever — nothing after this point ever executes, exactly like
      // a killed process never reaching wallet.add().
      await opts.onMarker?.(fakeMarker('cred-x'));
      return new Promise(() => {});
    });

    const {runtime: rt1} = newRuntime(secure);
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await rt1.submitPin('1234')).toBe('unlocked');

    void rt1.drawTokens(noConnect); // fire-and-forget — this call's promise never settles (mocked hang)
    await flush();

    // The marker must be readable independently of rt1's live object — through the SAME namespaced
    // storage key a completely separate process/instance would use. This is the crux of F10: the
    // batch's recovery data outlives the in-memory session that would otherwise be the only copy.
    const namespace = await slotIdFor(secure);
    const onDisk = await loadDrawMarker(secure, namespace, 'post');
    expect(onDisk).not.toBeNull();
    expect(onDisk?.credId).toBe('cred-x');
    rt1.dispose();

    // --- "Cold start": a SECOND AppRuntime sharing only the SecureStorage unlocks the same account.
    // Its next draw call must resume the staged batch before attempting anything new. ---
    const resumeSpy = jest.spyOn(drawMod, 'resumeTokenDraw').mockImplementation(async marker => {
      expect(marker.credId).toBe('cred-x'); // resumed with the EXACT marker that was persisted to disk
      return {ok: true, tokens: fakeTokens(3, 77)};
    });
    // The fresh call's OWN (separate) draw attempt fails deterministically, so the only tokens that can
    // land in the wallet are the RECOVERED ones — isolating what this test is actually proving.
    drawSpy.mockImplementationOnce(async () => ({ok: false, drawn: 0, error: 'no more tokens this epoch'} as never));

    const {runtime: rt2} = newRuntime(secure);
    await rt2.init();
    expect(await rt2.submitPin('1234')).toBe('unlocked');

    const res = await rt2.drawTokens(noConnect);

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ok: false, drawn: 0, error: 'no more tokens this epoch'}); // the fresh draw's own unrelated outcome

    // The RECOVERED batch reached the wallet — the paid-for tokens were not lost.
    const wallet = new EpochWallet(secure, namespace);
    expect(await wallet.count()).toBe(3);

    // Reconciled — the marker is gone, so a third launch does not try to resume it again.
    expect(await loadDrawMarker(secure, namespace, 'post')).toBeNull();

    rt2.dispose();
  });

  it('a terminal (non-timedOut) resume failure clears the marker instead of retrying forever', async () => {
    const secure = new InMemorySecureStorage();
    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw');
    drawSpy.mockImplementationOnce(async opts => {
      await opts.onMarker?.(fakeMarker('cred-y'));
      return new Promise(() => {});
    });

    const {runtime: rt1} = newRuntime(secure);
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await rt1.submitPin('1234')).toBe('unlocked');
    void rt1.drawTokens(noConnect);
    await flush();

    const namespace = await slotIdFor(secure);
    expect(await loadDrawMarker(secure, namespace, 'post')).not.toBeNull();
    rt1.dispose();

    // The organizer definitively rejects the resumed batch (e.g. the credential was since revoked) —
    // a TERMINAL outcome (timedOut is NOT set), unlike a mere timeout that should keep the marker.
    jest.spyOn(drawMod, 'resumeTokenDraw').mockResolvedValue({ok: false, error: 'invalid membership credential'});
    drawSpy.mockImplementationOnce(async () => ({ok: false, drawn: 0, error: 'no more tokens this epoch'} as never));

    const {runtime: rt2} = newRuntime(secure);
    await rt2.init();
    expect(await rt2.submitPin('1234')).toBe('unlocked');
    await rt2.drawTokens(noConnect);

    // Nothing to recover — the marker must be gone, not left to be retried forever against a batch
    // that can never resolve.
    expect(await loadDrawMarker(secure, namespace, 'post')).toBeNull();
    const wallet = new EpochWallet(secure, namespace);
    expect(await wallet.count()).toBe(0);

    rt2.dispose();
  });
});
