/**
 * F-D regression: drawTokens() and unlockContentEpoch() must deposit a completed batch into the
 * ACCOUNT THAT STARTED the draw, never whichever account happens to be active when the (multi-
 * minute, Tor-routed) organizer round-trip finally resolves.
 *
 * Both methods used to re-read a MUTABLE field — `this.wallet` (drawTokens) / `this.tokenPool`
 * (unlockContentEpoch) — for their deposit AFTER `await runTokenDraw(...)`, rather than a value
 * captured before the await. `rebuildIdentity()` reassigns BOTH fields to a brand-new
 * EpochWallet/TokenPool on every identity/community switch (switchIdentity / switchCommunity), so a
 * switch landing in that window used to file tokens minted under account A's issuer key into
 * whichever account was active when the organizer's response arrived — a genuine cross-silo leak.
 * `drawForWallet` already got this right (a stable local `wallet` parameter, never `this.wallet`);
 * `unlockContentEpoch` already captured `slot` up front for its epoch-KEY persist two lines below
 * the very deposit line this file pins — just not for the deposit itself.
 *
 * Each test starts a draw while account A is active, lets it hang mid-flight (a manually-released
 * gate standing in for the Tor round-trip), switches to a SIBLING account B, THEN releases the
 * batch — and asserts it landed in A's wallet, never B's.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import * as drawMod from '../blind/drawExchange';
import * as readUnlockMod from '../blind/readUnlock';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet} from '../blind/wallet';
import {makePoolWallet} from '../blind/tokenPool';
import {Purpose} from '../contracts';
import {mintContentKey, clearActiveContentKeys, setContentKeyStorage} from '../blind/contentKey';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const CK_B = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
const ISSUER = 'aXNz';
const ORG_A = 'a'.repeat(64);
const ORG_B = 'b'.repeat(64);

const v3 = (relayUrl: string, ck: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: ISSUER,
  organizerPubkey: org,
  communityKey: ck,
});

async function sessionFor(relayUrl: string, ck: string, org: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(relayUrl, ck, org), new MockBlindRsa(), 'STIQ-TEST-FD');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const CONTENT_ENCRYPTION_ON = (): unknown => capsDoc({enforced: {content_encryption: true}});

function newRuntime(relayInfo: () => unknown = () => ({})) {
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
    fetchRelayInfo: async () => relayInfo(),
  });
  return {runtime, secure, published};
}

async function activeSlotId(secure: InMemorySecureStorage): Promise<string> {
  return (await new KeyRing(secure).getActiveSlotId())!;
}

/** A promise this test controls the resolution of — stands in for the seconds-to-minutes-long Tor
 *  organizer round-trip runTokenDraw performs, so the test can park a draw mid-flight, switch the
 *  active account, and only THEN let it resolve. */
function gate<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>(res => {
    release = res;
  });
  return {promise, release};
}

const noConnect = () => ({}) as never; // runTokenDraw/runReadUnlock are module-mocked → connect unused

/** `n` distinct fake tokens (unique `token` bytes per index) — EpochWallet.add() is idempotent BY
 *  TOKEN VALUE (F10: a recovery replay must not double-credit), so giving every fake token the
 *  same bytes (e.g. a bare `new Uint8Array(8)`, all zeros) would silently collapse an n-token batch
 *  down to 1 in the wallet — a self-inflicted false pass/fail unrelated to the fix under test. */
function fakeTokens(n: number, tag: number) {
  return Array.from({length: n}, (_, i) => ({
    token: Uint8Array.of(tag, i),
    sig: Uint8Array.of(tag, i, 1),
    secret: Uint8Array.of(tag, i, 2),
  }));
}

/** Drain the fire-and-forget promise chains the draw path fans out into, up to (but never past) a
 *  still-pending gate — matches the `flush` helper other blind-draw suites in this directory use. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

afterEach(() => {
  jest.restoreAllMocks();
  clearActiveContentKeys();
  setContentKeyStorage(null);
});

describe('F-D: a mid-draw account switch never diverts the batch into the sibling account', () => {
  it('drawTokens(): the posting-token batch lands in the account that STARTED the draw (A), not the one active when it resolves (B)', async () => {
    const {runtime, secure} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await sessionFor(RELAY_A, CK_A, ORG_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    const slotA = await activeSlotId(secure);

    // Join a SIBLING community/account B (add mode activates it), then switch back to A — the draw
    // under test starts here, with B sitting one switch away.
    await runtime.completeEnrollment(await sessionFor(RELAY_B, CK_B, ORG_B), '1234', '');
    const slotB = await activeSlotId(secure);
    expect(slotB).not.toBe(slotA);
    await runtime.switchCommunity(communityId(RELAY_A));
    expect(await activeSlotId(secure)).toBe(slotA);

    const {promise, release} = gate<{ok: true; tokens: {token: Uint8Array; sig: Uint8Array; secret: Uint8Array}[]}>();
    jest.spyOn(drawMod, 'runTokenDraw').mockReturnValue(promise as never);

    const draw = runtime.drawTokens(noConnect, 3); // starts while A is active
    await flush(); // let it reach + start awaiting the gated runTokenDraw

    // The switch happens WHILE the organizer round-trip is still in flight.
    await runtime.switchCommunity(communityId(RELAY_B));
    expect(await activeSlotId(secure)).toBe(slotB);
    expect(await runtime.walletBalance()).toBe(0); // B's own (fresh) wallet — nothing yet

    release({ok: true, tokens: fakeTokens(3, 1)});
    const res = await draw;
    expect(res).toEqual({ok: true, drawn: 3});

    // The batch must land in A's wallet — the account that actually started/paid for the draw —
    // never in B's, even though B was active the instant the organizer's response arrived.
    expect(await new EpochWallet(secure, slotA).count()).toBe(3);
    expect(await runtime.walletBalance()).toBe(0); // B (still active) got nothing extra

    runtime.dispose();
  });

  it('unlockContentEpoch(): a drawn read-token batch lands in the account that started the unlock (A), not the one active when it resolves (B)', async () => {
    const {runtime, secure} = newRuntime(CONTENT_ENCRYPTION_ON);
    await runtime.init();
    await runtime.completeEnrollment(await sessionFor(RELAY_A, CK_A, ORG_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await runtime.onRelayConnected(); // negotiate caps → contentEncryption true, while A is active
    const slotA = await activeSlotId(secure);

    await runtime.completeEnrollment(await sessionFor(RELAY_B, CK_B, ORG_B), '1234', '');
    const slotB = await activeSlotId(secure);
    expect(slotB).not.toBe(slotA);
    await runtime.switchCommunity(communityId(RELAY_A));
    // A community switch resets _relayCaps to the fallback (a stale advertisement must not leak
    // into the incoming community) — re-negotiate while A is active, right before the unlock starts.
    await runtime.onRelayConnected();
    expect(await activeSlotId(secure)).toBe(slotA);

    const key = mintContentKey();
    jest.spyOn(readUnlockMod, 'runReadUnlock').mockResolvedValue({ok: true, epoch: 5, key});
    const {promise, release} = gate<{ok: true; tokens: {token: Uint8Array; sig: Uint8Array; secret: Uint8Array}[]}>();
    jest.spyOn(drawMod, 'runTokenDraw').mockReturnValue(promise as never);

    const unlock = runtime.unlockContentEpoch(noConnect, 5); // A's read wallet is empty → must draw
    await flush(); // let it reach + start awaiting the gated runTokenDraw

    await runtime.switchCommunity(communityId(RELAY_B));
    expect(await activeSlotId(secure)).toBe(slotB);

    release({ok: true, tokens: fakeTokens(5, 2)});
    const res = await unlock;
    expect(res).toEqual({ok: true});

    // 5 drawn, 1 immediately spent on the unlock itself → A's read wallet holds 4. B's read wallet
    // (a completely separate TokenPool instance, rebuilt fresh on the switch) must hold none of it.
    expect(await makePoolWallet(Purpose.Read, secure, slotA).count()).toBe(4);
    expect(await makePoolWallet(Purpose.Read, secure, slotB).count()).toBe(0);

    runtime.dispose();
  });
});
