/**
 * T-G3b — churn cap verification: onRelayConnected must re-negotiate the relay's advertised
 * capabilities (NIP-11 + stiq-capabilities) and flush the outbox on EVERY (re)connect, not just the
 * first. A stale `contentEncryption`/`spaceTokensRequired` flag surviving past a genuine reconnect is
 * dangerous (the 2026-07-21 incident's root shape: a client that never learns an operator flipped a
 * flag). This suite pins both halves of that contract directly against AppRuntime.onRelayConnected —
 * no App.tsx wiring involved, so it holds regardless of which host code path calls it.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const ISSUER = 'aXNz';

// No `communityKey` — a plain (non-blind) community, so post() signs directly via identity and needs
// no token wallet at all. This suite is about the reconnect/caps/flush plumbing, not token spending.
const community = (): Community => ({relayUrl: RELAY, issuerPublicKey: ISSUER});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community(), new MockBlindRsa(), 'STIQ-TEST-RECONNECT');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});

/** Drain the fire-and-forget promise chains the publish/deliver path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('T-G3b: onRelayConnected re-negotiates caps + flushes the outbox on EVERY reconnect', () => {
  it('a SECOND reconnect re-fetches caps (a flag flip is picked up, not stuck on the first-connect value)', async () => {
    let contentEncryptionOn = false;
    let fetchCount = 0;
    const relayInfo = (): unknown => {
      fetchCount++;
      return capsDoc({enforced: {content_encryption: contentEncryptionOn}});
    };
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new SwappableEventStore(new InMemoryEventStore()),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: true, message: 'ok'}),
      fetchRelayInfo: async () => relayInfo(),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    // First connect (enrollment's own onRelayConnected, via completeEnrollment/init, already ran at
    // least once) — read the count fresh from here rather than assume how many times it already fired.
    const afterFirst = fetchCount;
    expect(runtime.relayCapabilities().enforcedFlags.contentEncryption).toBe(false);

    // Operator flips the flag server-side; a fresh reconnect must pick it up — not stay stale.
    contentEncryptionOn = true;
    await runtime.onRelayConnected();
    expect(fetchCount).toBeGreaterThan(afterFirst); // genuinely re-fetched, not skipped as "already done"
    expect(runtime.relayCapabilities().enforcedFlags.contentEncryption).toBe(true);

    // And a THIRD reconnect flips it back — proving this isn't a one-time "catch up once" correction.
    const afterSecond = fetchCount;
    contentEncryptionOn = false;
    await runtime.onRelayConnected();
    expect(fetchCount).toBeGreaterThan(afterSecond);
    expect(runtime.relayCapabilities().enforcedFlags.contentEncryption).toBe(false);

    runtime.dispose();
  });

  it('onRelayConnected immediately re-delivers everything still unsent — no waiting for a timer', async () => {
    // Starts true so the enrollment's own pending-bind publish lands and clears during setup — it must
    // not still be sitting in loadPendingBind() when we later measure the WRITE-under-test's own
    // reconnect flush, or its own retry would inflate the count this assertion cares about.
    let online = true;
    const deliveryAttempts: string[] = [];
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new SwappableEventStore(new InMemoryEventStore()),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        deliveryAttempts.push(e.id);
        return online ? {accepted: true, message: 'ok'} : {accepted: false, message: 'offline', offline: true};
      },
      fetchRelayInfo: async () => capsDoc({}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await flush();
    deliveryAttempts.length = 0; // drop the (now-cleared) enrollment binding event's delivery attempt(s)

    // Compose while offline: queued ('sending'), one delivery attempt made and rejected as offline.
    online = false;
    void runtime.post('queued while offline');
    await flush();
    expect(deliveryAttempts.length).toBe(1);
    expect(runtime.getSnapshot().sendStatus.get(deliveryAttempts[0]!)).toBe('sending');

    // Relay reconnects — onRelayConnected must flush the outbox RIGHT NOW (no local backoff wait).
    online = true;
    await runtime.onRelayConnected();
    await flush();

    expect(deliveryAttempts.length).toBe(2); // re-delivered immediately on THIS call, not later
    // The relay's OK is delivery — deliver() confirms immediately (see AppRuntime.deliver's doc), so
    // the ring lands on 'confirmed', not a lingering 'accepted'.
    expect(runtime.getSnapshot().sendStatus.get(deliveryAttempts[0]!)).toBe('confirmed');

    runtime.dispose();
  });
});
