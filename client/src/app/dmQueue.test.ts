/**
 * DM send resilience: a direct message routes its gift wrap through the SAME outbox as an
 * optimistic post, so a DM composed before the relay is up stays QUEUED (·, 'sending') and
 * auto-resends on reconnect — instead of the old fire-once publish that flashed 'failed' (✕)
 * the instant Tor wasn't ready (a DM the user could never retry — the thread has no Retry button).
 */
// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {Kind} from '../nostr/events';
import {PUBLISH_TIMEOUT_MESSAGE} from '../nostr/RelayClient';
import {BlindTokensExhausted} from '../blind/blindSigner';
import type {AppRuntimeDeps} from './AppRuntime';
import type {Session} from '../onboarding/enrollment';
import type {SecureStorage} from '../keys/keystore';
import type {EventStore} from '../nostr/store';
import type {DirectMessage} from '../dm/dm';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) {
    throw new Error('enrollment failed in setup');
  }
  return result.session;
}

/**
 * Replace the real (NIP-13 difficulty-20, ~1M-hash) DM mine with a fast, well-formed gift wrap.
 * The fix under test is the outbox routing in sendDM/deliver, not the PoW itself, so a finalized
 * kind-1059 event with a unique id is all the outbox + store + publish path need.
 */
function stubSeal(runtime: AppRuntime): void {
  const rt = runtime as unknown as {
    identity: {sealDM: (pk: string, text: string, replyTo?: string) => Promise<{wrap: Event; rumorId: string}>};
  };
  rt.identity.sealDM = async (peerPk: string, text: string) => ({
    wrap: finalizeEvent(
      {kind: Kind.GiftWrap, created_at: Math.floor(Date.now() / 1000), tags: [['p', peerPk]], content: text},
      generateSecretKey(),
    ),
    rumorId: 'r'.repeat(64),
  });
}

/** The delivery status of our own sent DM with the given text, as the UI would read it. */
function sentStatus(runtime: AppRuntime, text: string): string | undefined {
  for (const c of runtime.getSnapshot().inbox) {
    const m = c.messages.find(msg => msg.text === text);
    if (m) return m.status;
  }
  return undefined;
}

/** The whole sent-DM echo with the given text (for its id / failureReason), as the UI would read it. */
function sentMsg(runtime: AppRuntime, text: string): DirectMessage | undefined {
  for (const c of runtime.getSnapshot().inbox) {
    const m = c.messages.find(msg => msg.text === text);
    if (m) return m;
  }
  return undefined;
}

/** Count our own echoes with the given text — asserts a retry didn't leave a duplicate behind. */
function sentCount(runtime: AppRuntime, text: string): number {
  return runtime.getSnapshot().inbox.flatMap(c => c.messages).filter(m => m.text === text).length;
}

function makeRuntime(
  secure: SecureStorage,
  store: EventStore,
  publish: AppRuntimeDeps['publish'],
): AppRuntime {
  return new AppRuntime({secureStorage: secure, store, hash: identityHash, autoLockMs: 60_000, publish});
}

describe('DM send path (offline queue + retry)', () => {
  it('keeps a DM composed while the relay is offline QUEUED (·), then delivers (✓) on reconnect', async () => {
    let online = false;
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () =>
      online
        ? {accepted: true, message: 'ok'}
        : {accepted: false, message: 'relay not connected', offline: true},
    );
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    const peerPk = getPublicKey(generateSecretKey());

    // Relay still offline: the DM must NOT flash 'failed' — it's queued, not rejected.
    await runtime.sendDM(peerPk, 'hi while connecting');
    await flush();
    expect(sentStatus(runtime, 'hi while connecting')).toBe('sending');

    // Relay comes up → onRelayConnected re-delivers the queued wrap → 'sent'.
    online = true;
    await runtime.onRelayConnected();
    await flush();
    expect(sentStatus(runtime, 'hi while connecting')).toBe('sent');
    runtime.dispose();
  });

  it('marks a DM the relay genuinely rejects as failed (✕)', async () => {
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () => ({
      accepted: false,
      message: 'blocked: rejected',
    }));
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    const peerPk = getPublicKey(generateSecretKey());

    await runtime.sendDM(peerPk, 'rejected dm');
    await flush();
    expect(sentStatus(runtime, 'rejected dm')).toBe('failed');
    runtime.dispose();
  });

  it('a DM queued offline survives a restart still QUEUED (not downgraded to failed) and delivers on reconnect', async () => {
    const secure = new InMemorySecureStorage();
    const peerPk = getPublicKey(generateSecretKey());

    // Session 1: enroll, then send a DM while the relay is offline (queued in the outbox).
    const rt1 = makeRuntime(secure, new InMemoryEventStore(), async () => ({
      accepted: false,
      message: 'relay not connected',
      offline: true,
    }));
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    await rt1.submitPin('1234');
    stubSeal(rt1);
    await rt1.sendDM(peerPk, 'queued across restart');
    await flush();
    expect(sentStatus(rt1, 'queued across restart')).toBe('sending');
    rt1.dispose();

    // Session 2: a fresh runtime over the SAME secure storage (reloads the outbox + sent echoes).
    // The persisted 'sending' echo must stay 'sending' — its wrap is still queued — NOT 'failed'.
    let online = false;
    const rt2 = makeRuntime(secure, new InMemoryEventStore(), async () =>
      online
        ? {accepted: true, message: 'ok'}
        : {accepted: false, message: 'relay not connected', offline: true},
    );
    await rt2.init();
    await rt2.submitPin('1234');
    expect(sentStatus(rt2, 'queued across restart')).toBe('sending');

    // And it auto-delivers once the relay is reachable.
    online = true;
    await rt2.onRelayConnected();
    await flush();
    expect(sentStatus(rt2, 'queued across restart')).toBe('sent');
    rt2.dispose();
  });

  it('records a human-facing failureReason on a relay rejection (so the ✕ can explain itself)', async () => {
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () => ({
      accepted: false,
      message: 'blocked: this community requires a space token for this content',
    }));
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    const peerPk = getPublicKey(generateSecretKey());

    await runtime.sendDM(peerPk, 'why did it fail');
    await flush();
    const msg = sentMsg(runtime, 'why did it fail');
    expect(msg?.status).toBe('failed');
    // The RAW relay message is stored on the echo; the bubble maps it to calm copy at render.
    expect(msg?.failureReason).toBe('blocked: this community requires a space token for this content');
    runtime.dispose();
  });

  it('retryDm re-delivers a relay-rejected DM via the outbox (wrap exists) → sent', async () => {
    let reject = true;
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () =>
      reject ? {accepted: false, message: 'blocked: rejected'} : {accepted: true, message: 'ok'},
    );
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    const peerPk = getPublicKey(generateSecretKey());

    await runtime.sendDM(peerPk, 'retry me');
    await flush();
    const failed = sentMsg(runtime, 'retry me');
    expect(failed?.status).toBe('failed');

    // The relay recovers; a Retry tap re-delivers the SAME queued wrap (id === the outbox key).
    reject = false;
    await runtime.retryDm(peerPk, failed!.id);
    await flush();
    expect(sentStatus(runtime, 'retry me')).toBe('sent');
    expect(sentMsg(runtime, 'retry me')?.failureReason).toBeUndefined(); // cleared on success
    expect(sentCount(runtime, 'retry me')).toBe(1);
    runtime.dispose();
  });

  it('retryDm re-sends a DM whose seal failed BEFORE the relay (nothing queued) → sent, no duplicate', async () => {
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () => ({
      accepted: true,
      message: 'ok',
    }));
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    const peerPk = getPublicKey(generateSecretKey());

    // First seal throws (space-token exhaustion — T0.1: BlindTokensExhausted, calm message, not a raw
    // "out of tokens" Error) → failed ✕ with a reason, nothing queued.
    let sealCalls = 0;
    const rt = runtime as unknown as {
      identity: {sealDM: (pk: string, text: string) => Promise<{wrap: Event; rumorId: string}>};
    };
    rt.identity.sealDM = async (peerPk2: string, text: string) => {
      sealCalls++;
      if (sealCalls === 1) {
        throw new BlindTokensExhausted('space-write');
      }
      return {
        wrap: finalizeEvent(
          {kind: Kind.GiftWrap, created_at: Math.floor(Date.now() / 1000), tags: [['p', peerPk2]], content: text},
          generateSecretKey(),
        ),
        rumorId: 'r'.repeat(64),
      };
    };

    await runtime.sendDM(peerPk, 'seal failed once');
    await flush();
    const failed = sentMsg(runtime, 'seal failed once');
    expect(failed?.status).toBe('failed');
    // T0.1/B6: the DM's failureReason is BlindTokensExhausted's message verbatim (sendDM's catch-all
    // pipes err.message straight through) — must be the calm copy, never raw token/draw/allowance jargon.
    expect(failed?.failureReason).toBe(new BlindTokensExhausted().message);
    expect(failed?.failureReason?.toLowerCase()).not.toMatch(/token|allowance|draw/);

    // Retry re-runs the full seal+send; the stale echo is replaced by a fresh sent one (no duplicate).
    await runtime.retryDm(peerPk, failed!.id);
    await flush();
    expect(sentStatus(runtime, 'seal failed once')).toBe('sent');
    expect(sentCount(runtime, 'seal failed once')).toBe(1);
    runtime.dispose();
  });
});

/**
 * finding #dms: a DM gift wrap's publish() call takes the SHARED socket's single 60s wait-for-OK
 * (no `stiq_token` under default config). An ambiguous timeout (no OK, no rejection — publishShared's
 * `{accepted:false, message:'timeout'}`) used to go straight to 'failed' (✕) with only a genuine relay
 * reconnect able to auto-resend it — an UNBOUNDED wait, since nothing forces a merely
 * congested-but-alive socket closed on its own. It now self-drives the SAME bounded local backoff
 * ladder (RESEND_BACKOFF_MS) every other ambiguous/offline write already gets, keeping the thread
 * honest with the quiet '·' (sending) affordance instead of a hard '✕' while attempts remain.
 */
describe('DM send path (ambiguous publish timeout — bounded local auto-resend)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps a DM auto-retrying (·, not ✕) through an ambiguous timeout, then delivers once a later attempt lands', async () => {
    let gate = false;
    let callCount = 0;
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () => {
      if (!gate) return {accepted: true, message: 'ok'}; // enrollment's own binding-event publish
      callCount++;
      // 1st attempt: ambiguous timeout (no OK, no rejection). 2nd (the local ~4s backoff resend): lands.
      return callCount === 1
        ? {accepted: false, message: PUBLISH_TIMEOUT_MESSAGE}
        : {accepted: true, message: 'ok'};
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    gate = true;
    const peerPk = getPublicKey(generateSecretKey());

    await runtime.sendDM(peerPk, 'stalled circuit');
    // The FIRST ambiguous timeout must not flash the hard '✕' — it self-schedules a local resend and
    // keeps showing the quiet queued affordance while retries remain.
    expect(sentStatus(runtime, 'stalled circuit')).toBe('sending');
    expect(callCount).toBe(1);

    // The local ~4s backoff resend fires on its own — no reconnect, no manual Retry tap.
    await jest.advanceTimersByTimeAsync(4_000);
    expect(callCount).toBe(2);
    expect(sentStatus(runtime, 'stalled circuit')).toBe('sent');
    expect(sentCount(runtime, 'stalled circuit')).toBe(1); // no duplicate echo left behind
    runtime.dispose();
  });

  it('settles a DM to failed only once the local resend ladder is exhausted on repeated ambiguous timeouts, and a reconnect still resends it', async () => {
    let gate = false;
    let callCount = 0;
    let accept = false;
    const runtime = makeRuntime(new InMemorySecureStorage(), new InMemoryEventStore(), async () => {
      if (!gate) return {accepted: true, message: 'ok'}; // enrollment's own binding-event publish
      callCount++;
      return accept
        ? {accepted: true, message: 'ok'}
        : {accepted: false, message: PUBLISH_TIMEOUT_MESSAGE};
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    stubSeal(runtime);
    gate = true;
    const peerPk = getPublicKey(generateSecretKey());

    await runtime.sendDM(peerPk, 'never lands locally');
    expect(sentStatus(runtime, 'never lands locally')).toBe('sending');
    expect(callCount).toBe(1);

    // Walk the whole local backoff ladder (4/8/16/32s) — every attempt is still ambiguous.
    await jest.advanceTimersByTimeAsync(4_000);
    await jest.advanceTimersByTimeAsync(8_000);
    await jest.advanceTimersByTimeAsync(16_000);
    await jest.advanceTimersByTimeAsync(32_000);
    expect(callCount).toBe(5); // original send + 4 local resends
    // Ladder exhausted — settles to 'failed' (✕ + Retry), still auto-resent on a genuine reconnect.
    expect(sentStatus(runtime, 'never lands locally')).toBe('failed');

    accept = true;
    await runtime.onRelayConnected();
    await jest.advanceTimersByTimeAsync(0);
    expect(sentStatus(runtime, 'never lands locally')).toBe('sent');
    expect(sentCount(runtime, 'never lands locally')).toBe(1);
    runtime.dispose();
  });
});
