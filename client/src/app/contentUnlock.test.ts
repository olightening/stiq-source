/**
 * C7 content-encryption READ METER — the population loop wired into AppRuntime (SHIPS DARK).
 *
 * Proves:
 *  • DORMANT (fallback caps, flag OFF): unlockContentEpoch is a no-op — no read draw, no organizer
 *    round-trip, no content key set, _writeEpoch never advances; and posts publish PLAINTEXT.
 *  • ACTIVE (relay advertises enforced.content_encryption): unlockContentEpoch spends/draws a read
 *    token, runs runReadUnlock, sets + PERSISTS the epoch key (loadContentKeys round-trips), emits.
 *
 * Uses the same in-memory enrollment harness as capabilityConsumers.test.ts, and mocks the Tor
 * round-trips (runReadUnlock / runTokenDraw) exactly as the existing blind tests do.
 */
// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import * as readUnlockMod from '../blind/readUnlock';
import * as drawMod from '../blind/drawExchange';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {makePoolWallet} from '../blind/tokenPool';
import {Purpose} from '../contracts';
import {isSealedContent} from '../blind/blindPost';
import {
  mintContentKey,
  hasContentEpochKey,
  getContentEpochKey,
  getWriteContentKey,
  clearActiveContentKeys,
  loadContentKeys,
  setContentKeyStorage,
} from '../blind/contentKey';
import {setBytesPerToken} from '../blind/tokenCost';
import {isEpochUnlockUnavailable, clearEpochUnlockDisplay} from '../blind/unlockState';
import type {Community} from '../onboarding/community';
import {getPublicKey, type Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ORG_SK = new Uint8Array(32).fill(11);
const ORG_PUB = getPublicKey(ORG_SK);
const ISSUER = 'aXNz';
const ISSUER_FP = walletKeyFingerprint(ISSUER);

const v3 = (): Community => ({relayUrl: RELAY, issuerPublicKey: ISSUER, organizerPubkey: ORG_PUB, communityKey: CK});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(relayInfo: () => unknown, extraDeps: Record<string, unknown> = {}) {
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
    ...extraDeps,
  });
  return {runtime, secure, published};
}

async function slotIdFor(secure: InMemorySecureStorage): Promise<string> {
  const ring = new KeyRing(secure);
  return (await ring.getActiveSlotId()) ?? communityId(RELAY);
}

/** Seed the active community's POSTING wallet so a real post can spend a token. */
async function seedPostWallet(secure: InMemorySecureStorage, n = 5): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure), ISSUER_FP);
  // Real holder-bound keypairs (P3): posting spends token 0, signing the event with its secret.
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

/** Seed the active account's READ wallet (unbound, matching the runtime's rk-less read wallet). */
async function seedReadWallet(secure: InMemorySecureStorage, n = 3): Promise<void> {
  const wallet = makePoolWallet(Purpose.Read, secure, await slotIdFor(secure));
  // Read tokens are opaque bearer proofs (never sign anything), so the secret is a filler of matching
  // width. Each token's bytes MUST be unique: add() dedupes by token value, so n identical fillers
  // would collapse to a single held token and any test spending more than once would silently draw.
  await wallet.add(
    0,
    Array.from({length: n}, (_, i) => ({
      token: new Uint8Array(8).fill(i + 1),
      sig: new Uint8Array(4),
      secret: new Uint8Array(8),
    })),
  );
}

async function enrolled(relayInfo: () => unknown, extraDeps: Record<string, unknown> = {}) {
  const h = newRuntime(relayInfo, extraDeps);
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  return h;
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const ON = capsDoc({enforced: {content_encryption: true}});
const noConnect = () => ({}) as never; // runReadUnlock/runTokenDraw are mocked → connect unused

afterEach(() => {
  jest.restoreAllMocks();
  setBytesPerToken(0);
  clearActiveContentKeys();
  setContentKeyStorage(null);
});

describe('unlockContentEpoch — DORMANT at fallback caps (flag OFF, ships dark)', () => {
  it('is a no-op: no read draw, no unlock round-trip, no content key, _writeEpoch untouched', async () => {
    const {runtime} = await enrolled(() => ({})); // relay advertises nothing → contentEncryption false
    await runtime.onRelayConnected();
    const unlockSpy = jest.spyOn(readUnlockMod, 'runReadUnlock');
    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw');

    const res = await runtime.unlockContentEpoch(noConnect, 5);

    expect(res).toEqual({ok: false, error: 'content encryption not enabled'});
    expect(unlockSpy).not.toHaveBeenCalled();
    expect(drawSpy).not.toHaveBeenCalled();
    expect(hasContentEpochKey(5)).toBe(false);
    expect(getWriteContentKey()).toBeNull(); // write side never activated → posts stay plaintext
    runtime.dispose();
  });

  it('posts publish PLAINTEXT while the flag is off (byte-identical dark behaviour)', async () => {
    const {runtime, secure, published} = await enrolled(() => ({}));
    await runtime.onRelayConnected();
    await seedPostWallet(secure);
    published.length = 0;

    await expect(runtime.post('hello world')).resolves.toBeUndefined();
    const note = published.find(e => e.kind === 1)!;
    expect(note).toBeDefined();
    // Blind (throwaway-signed, carries a token) but the BODY is plaintext — not sealed under a
    // content epoch key. No ['encrypted','nip44'] / ['ke'] tags.
    expect(note.tags.some(t => t[0] === 'stiq_token')).toBe(true);
    expect(isSealedContent(note)).toBe(false);
    expect(note.tags.some(t => t[0] === 'ke')).toBe(false);
    expect(note.content).toContain('hello world');
    runtime.dispose();
  });
});

describe('unlockContentEpoch — ACTIVE when the relay advertises content encryption (flag ON)', () => {
  it('spends a seeded read token, runs runReadUnlock, sets + persists the epoch key, and emits', async () => {
    const {runtime, secure} = await enrolled(() => ON);
    await runtime.onRelayConnected(); // negotiate caps → contentEncryption true
    await seedReadWallet(secure); // wallet has read tokens → spend path (no draw)

    const key = mintContentKey();
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: true, epoch: 9, key});
    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw');

    // Observe the emit: subscribe fires once immediately, then again on the unlock's emit().
    let emits = 0;
    const unsub = runtime.subscribe(() => {
      emits++;
    });
    emits = 0;

    const res = await runtime.unlockContentEpoch(noConnect, 9);

    expect(res).toEqual({ok: true});
    expect(drawSpy).not.toHaveBeenCalled(); // seeded wallet → no draw needed
    expect(unlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({organizerPubkey: ORG_PUB, epoch: 9}),
    );
    // The unlocked key is cached in-memory for the synchronous feed decrypt path.
    expect(hasContentEpochKey(9)).toBe(true);
    expect(getContentEpochKey(9)).toEqual(key);
    expect(emits).toBeGreaterThanOrEqual(1); // feed re-render fired

    // PERSISTED (content-key storage was wired at init): a fresh hydrate round-trips the key.
    clearActiveContentKeys();
    expect(hasContentEpochKey(9)).toBe(false);
    await loadContentKeys(await slotIdFor(secure));
    expect(getContentEpochKey(9)).toEqual(key);

    unsub();
    runtime.dispose();
  });

  it('draws a read batch over Tor when the wallet is empty, then unlocks', async () => {
    const {runtime} = await enrolled(() => ON);
    await runtime.onRelayConnected();
    // Read wallet empty → unlockContentEpoch must draw a purpose:'read' batch first.
    const drawSpy = jest
      .spyOn(drawMod, 'runTokenDraw')
      .mockResolvedValue({ok: true, tokens: [{token: new Uint8Array(8), sig: new Uint8Array(4), secret: new Uint8Array(8)}]});
    const key = mintContentKey();
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: true, epoch: 3, key});

    const res = await runtime.unlockContentEpoch(noConnect, 3);

    expect(res).toEqual({ok: true});
    expect(drawSpy).toHaveBeenCalledWith(expect.objectContaining({purpose: 'read'}));
    expect(unlockSpy).toHaveBeenCalledTimes(1);
    expect(getContentEpochKey(3)).toEqual(key);
    runtime.dispose();
  });

  it('surfaces the unlock error and stores nothing when runReadUnlock fails', async () => {
    const {runtime, secure} = await enrolled(() => ON);
    await runtime.onRelayConnected();
    await seedReadWallet(secure);
    jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: false, error: 'the organizer did not respond in time', timedOut: true});

    const res = await runtime.unlockContentEpoch(noConnect, 2);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/organizer/);
    expect(hasContentEpochKey(2)).toBe(false);
    runtime.dispose();
  });

  it('is idempotent: a re-unlock of an already-open epoch spends no token', async () => {
    const {runtime, secure} = await enrolled(() => ON);
    await runtime.onRelayConnected();
    await seedReadWallet(secure);
    const key = mintContentKey();
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: true, epoch: 6, key});

    expect((await runtime.unlockContentEpoch(noConnect, 6)).ok).toBe(true);
    // Second call short-circuits on hasContentEpochKey — no second round-trip.
    expect((await runtime.unlockContentEpoch(noConnect, 6)).ok).toBe(true);
    expect(unlockSpy).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});

// The invisible-unlock redesign (2026-07-21 incident): sealed items auto-unlock in the background
// with no tap and no flag dependency, and only an organizer REFUSAL ever becomes user-visible.
describe('invisible auto-unlock (noteLockedEpochs / sealedItem gate)', () => {
  const waitFor = async (cond: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise<void>(r => setTimeout(r, 10));
    }
  };

  afterEach(() => {
    clearEpochUnlockDisplay();
  });

  it('a sealed item unlocks even with the relay flag OFF — content sealed before a flag flip-off must not strand', async () => {
    const {runtime, secure} = await enrolled(() => ({})); // relay advertises nothing → flag off
    await runtime.onRelayConnected();
    await seedReadWallet(secure);
    const key = mintContentKey();
    jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({ok: true, epoch: 4, key});

    const res = await runtime.unlockContentEpoch(noConnect, 4, {sealedItem: true});

    expect(res).toEqual({ok: true});
    expect(getContentEpochKey(4)).toEqual(key);
    runtime.dispose();
  });

  it('noteLockedEpochs background-unlocks a sealed epoch exactly once (deduped)', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never; // mocked round-trips → the socket is never used
    await runtime.onRelayConnected();
    await seedReadWallet(secure);
    const key = mintContentKey();
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: true, epoch: 8, key});

    runtime.noteLockedEpochs([8, 8]);
    runtime.noteLockedEpochs([8]); // second sweep while in flight — must not double-spend
    await waitFor(() => hasContentEpochKey(8));

    expect(unlockSpy).toHaveBeenCalledTimes(1);
    expect(getContentEpochKey(8)).toEqual(key);
    runtime.dispose();
  });

  it('an organizer REFUSAL flips the epoch to unavailable (the one user-visible state); a transient failure stays pending', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 5);
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockImplementation(async opts =>
        opts.epoch === 9
          ? {ok: false, error: 'read access revoked for this member'} // organizer-signed refusal → fatal
          : {ok: false, error: 'the organizer did not respond in time', timedOut: true},
      );

    runtime.noteLockedEpochs([9, 10]);
    await waitFor(() => unlockSpy.mock.calls.length >= 2);
    await waitFor(() => runtime.epochAccessState(9) === 'unavailable');

    expect(isEpochUnlockUnavailable(9)).toBe(true); // render layer shows the quiet members-only card
    expect(runtime.epochAccessState(10)).toBe('pending'); // Tor flake → invisible retry, no card
    expect(isEpochUnlockUnavailable(10)).toBe(false);
    runtime.dispose();
  });
});

// 2026-07-22 termination + revival fix (prod: 11 sealed posts, 4 organizer answers ever — permanent
// gray bars). Pending must TERMINATE on its own (no organizer refusal required), a tap must retry,
// and a reconnect/foreground must revive a stuck epoch WITHOUT any further caller ever noticing.
describe('unlock termination + revival (pending -> unlockUnavailable, tap-to-retry, reconnect/foreground revival)', () => {
  const waitFor = async (cond: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise<void>(r => setTimeout(r, 10));
    }
  };

  type EpochUnlockState = {inFlight: boolean; attempts: number; nextAt: number; lastFatal: boolean};
  const epochMap = (runtime: AppRuntime) =>
    (runtime as unknown as {_epochUnlock: Map<number, EpochUnlockState>})._epochUnlock;

  afterEach(() => {
    clearEpochUnlockDisplay();
  });

  it('a purely transient epoch (never refused, never answered) terminates after N attempts — pending -> unavailable', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);
    jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({
      ok: false,
      error: 'the organizer did not respond in time',
      timedOut: true,
    });

    const epoch = 21;
    // Drive the ladder manually (bypass real backoff sleeps — attempt COUNT is what's under test):
    // each iteration kicks one attempt, waits for it to settle, then clears nextAt so the next
    // noteLockedEpochs call isn't gated by the (multi-second) real backoff.
    for (let i = 1; i <= 4; i++) {
      runtime.noteLockedEpochs([epoch]);
      await waitFor(() => epochMap(runtime).get(epoch)?.inFlight === false && epochMap(runtime).get(epoch)?.attempts === i);
      epochMap(runtime).get(epoch)!.nextAt = 0;
    }

    expect(runtime.epochAccessState(epoch)).toBe('unavailable'); // terminated WITHOUT any organizer refusal
    expect(isEpochUnlockUnavailable(epoch)).toBe(true);
    runtime.dispose();
  });

  it('tap-to-retry (retryEpochUnlock) resets a terminal epoch\'s attempts and unlocks once the organizer answers', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: false, error: 'read access revoked for this member'});

    const epoch = 22;
    runtime.noteLockedEpochs([epoch]);
    await waitFor(() => runtime.epochAccessState(epoch) === 'unavailable'); // organizer refusal → terminal
    expect(isEpochUnlockUnavailable(epoch)).toBe(true);

    const key = mintContentKey();
    unlockSpy.mockResolvedValue({ok: true, epoch, key}); // the organizer would now answer (lifted revocation)

    runtime.retryEpochUnlock(epoch);
    expect(epochMap(runtime).get(epoch)?.attempts).toBe(0); // reset immediately, synchronously
    await waitFor(() => hasContentEpochKey(epoch));

    expect(isEpochUnlockUnavailable(epoch)).toBe(false);
    expect(getContentEpochKey(epoch)).toEqual(key);
    runtime.dispose();
  });

  it('onRelayConnected (reconnect) revives a backed-off epoch with NO further caller — the prod gap', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);
    const unlockSpy = jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({
      ok: false,
      error: 'the organizer did not respond in time',
      timedOut: true,
    });

    const epoch = 23;
    runtime.noteLockedEpochs([epoch]);
    await waitFor(() => epochMap(runtime).get(epoch)?.inFlight === false);
    // Backed off well into the future — in production, with a quiet feed, NOTHING would call
    // noteLockedEpochs again and this epoch would sit pending forever (the prod bug under review).
    expect(epochMap(runtime).get(epoch)!.nextAt).toBeGreaterThan(Date.now());
    expect(runtime.epochAccessState(epoch)).toBe('pending');

    const key = mintContentKey();
    unlockSpy.mockResolvedValue({ok: true, epoch, key}); // the next attempt would now succeed

    await runtime.onRelayConnected(); // the ONLY trigger from here — no manual noteLockedEpochs call
    await waitFor(() => hasContentEpochKey(epoch));

    expect(getContentEpochKey(epoch)).toEqual(key);
    runtime.dispose();
  });

  it('setAppBackgrounded(false) (app foreground) revives a TERMINAL epoch with no tap and no reconnect', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);
    const unlockSpy = jest
      .spyOn(readUnlockMod, 'runReadUnlock')
      .mockResolvedValue({ok: false, error: 'read access revoked for this member'});

    const epoch = 24;
    runtime.noteLockedEpochs([epoch]);
    await waitFor(() => runtime.epochAccessState(epoch) === 'unavailable');

    const key = mintContentKey();
    unlockSpy.mockResolvedValue({ok: true, epoch, key});

    runtime.setAppBackgrounded(true);
    runtime.setAppBackgrounded(false); // foreground — the ONLY trigger from here
    await waitFor(() => hasContentEpochKey(epoch));

    expect(isEpochUnlockUnavailable(epoch)).toBe(false);
    expect(getContentEpochKey(epoch)).toEqual(key);
    runtime.dispose();
  });

  it('a successful token draw revives a backed-off epoch — the pipe just proved itself (2026-07-23 M31 field gap)', async () => {
    const {runtime, secure} = await enrolled(() => ({}));
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
      ({}) as never;
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);
    const unlockSpy = jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({
      ok: false,
      error: 'the organizer did not respond in time',
      timedOut: true,
    });

    const epoch = 26;
    runtime.noteLockedEpochs([epoch]);
    await waitFor(() => epochMap(runtime).get(epoch)?.inFlight === false);
    // Parked well into the future — on a quiet always-foregrounded session nothing would retry it.
    expect(epochMap(runtime).get(epoch)!.nextAt).toBeGreaterThan(Date.now());

    const key = mintContentKey();
    unlockSpy.mockResolvedValue({ok: true, epoch, key});
    jest.spyOn(drawMod, 'runTokenDraw').mockResolvedValue({
      ok: true,
      tokens: [{token: new Uint8Array(8), sig: new Uint8Array(4), secret: new Uint8Array(8)}],
    });

    // A posting draw completes (the wallets stocking once the Tor pipe finally woke up) — the ONLY
    // trigger from here: no reconnect, no foreground, no tap, no feed rebuild.
    await expect(runtime.drawTokens(noConnect)).resolves.toMatchObject({ok: true});
    await waitFor(() => hasContentEpochKey(epoch));

    expect(getContentEpochKey(epoch)).toEqual(key);
    runtime.dispose();
  });

  it('a scheduled backoff retry fires by ITSELF once nextAt passes — no external trigger of any kind', async () => {
    // Shrink the ladder so the timer's real-time wait stays ~1s (the arm clamp's minimum); the
    // static array is shared, so restore it even if the test throws.
    const ladder = (AppRuntime as unknown as {UNLOCK_RETRY_BACKOFF_MS: number[]}).UNLOCK_RETRY_BACKOFF_MS;
    const original = [...ladder];
    ladder.splice(0, ladder.length, 1_100, 1_100, 1_100);
    try {
      const {runtime, secure} = await enrolled(() => ({}));
      (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () =>
        ({}) as never;
      await runtime.onRelayConnected();
      await seedReadWallet(secure, 10);
      const unlockSpy = jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({
        ok: false,
        error: 'the organizer did not respond in time',
        timedOut: true,
      });

      const epoch = 27;
      runtime.noteLockedEpochs([epoch]);
      await waitFor(() => epochMap(runtime).get(epoch)?.inFlight === false);
      expect(epochMap(runtime).get(epoch)!.nextAt).toBeGreaterThan(Date.now()); // scheduled, not due

      const key = mintContentKey();
      unlockSpy.mockResolvedValue({ok: true, epoch, key});

      // NOTHING from here — no noteLockedEpochs, no reconnect, no foreground, no tap, no draw. The
      // armed timer alone must honor the ladder's own schedule.
      await waitFor(() => hasContentEpochKey(epoch), 6_000);

      expect(getContentEpochKey(epoch)).toEqual(key);
      runtime.dispose();
    } finally {
      ladder.splice(0, ladder.length, ...original);
    }
  }, 15_000);

  it('a request that cannot reach the wire while offline is retried (queued), never dropped: attempts still accumulate', async () => {
    // connectForDraw itself throws synchronously, exactly like App.tsx's late-bound wrapper before
    // startRelay assigns it (relay socket not live yet) — runReadUnlock is the REAL implementation
    // here (not mocked, unlike every other test in this file), proving the whole stack (not just a
    // mock) treats this as transient. runReadUnlock's OWN default ladder (4 sub-attempts, 3s apart)
    // runs to exhaustion before this outer call settles, hence the generous timeout.
    const {runtime, secure} = await enrolled(() => ({}));
    let connectCalls = 0;
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () => {
      connectCalls++;
      throw new Error('draw socket unavailable (relay not connected)');
    };
    await runtime.onRelayConnected();
    await seedReadWallet(secure, 10);

    const epoch = 25;
    runtime.noteLockedEpochs([epoch]);
    await waitFor(() => epochMap(runtime).get(epoch)?.inFlight === false, 15_000);

    expect(connectCalls).toBeGreaterThan(0); // the request DID try to reach the wire, not skipped
    expect(epochMap(runtime).get(epoch)?.attempts).toBe(1); // counted — not silently discarded
    expect(runtime.epochAccessState(epoch)).toBe('pending'); // one failure alone isn't terminal yet
    runtime.dispose();
  }, 20_000);
});
