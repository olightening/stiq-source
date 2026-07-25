/**
 * Live organizer mirror-list adoption (P2 MirrorSet, synthesis §1.7/§1.9) + the org-config watermark.
 *
 * Covers the review-pass fixes wired through handleIncomingEvent / applyOrgConfig:
 *  - Fix 6: the per-`d` anti-rollback watermark advances ONLY after applyOrgConfig returns a real
 *    patch, so a MALFORMED doc carrying a high created_at can't advance it and permanently block a
 *    later legitimate doc.
 *  - Fix 3: a durable stiq:mirrors apply pushes the fresh secondary set to the LIVE transport
 *    (onMirrorsChanged) without waiting for a reconnect.
 *  - Fix 7: an adopted AUTH-GATED mirror grows the required onion-auth set and asks the host to
 *    reconnect (Tor writes ClientOnionAuthDir only at startup); a public mirror does not.
 */
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {setActiveOnionAuthExtra, getActiveOnionAuthExtra} from '../tor/onionAuth';
import type {MirrorSpec} from '../nostr/MirrorSet';
import type {Community} from '../onboarding/community';
import {finalizeEvent, getPublicKey, type Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const MIRROR = `ws://${'b'.repeat(56)}.onion`;
const MIRROR_HOST = 'b'.repeat(56);
const AUTH_KEY = 'B'.repeat(52); // valid uppercase-base32 x25519 client-auth key

const ORG_SK = new Uint8Array(32).fill(11);
const ORG_PUB = getPublicKey(ORG_SK);

const community = (): Community => ({relayUrl: RELAY, issuerPublicKey: 'aXNz', organizerPubkey: ORG_PUB});

async function makeSession(c: Community): Promise<Session> {
  const {enrollment} = await Enrollment.begin(c, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** kind-30078 `d=stiq:mirrors` doc signed by the active organizer. `content` overrides the JSON body
 *  (used to inject a MALFORMED doc). */
function mirrorsDoc(mirrors: unknown[], createdAt: number, content?: string): Event {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      tags: [['d', 'stiq:mirrors']],
      content: content ?? JSON.stringify(mirrors),
    },
    ORG_SK,
  );
}

function newRuntime() {
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
  const mirrorCalls: MirrorSpec[][] = [];
  let reconnectCalls = 0;
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: makeStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
    onMirrorsChanged: specs => mirrorCalls.push(specs),
    requestRelayReconnect: () => {
      reconnectCalls++;
    },
  });
  return {runtime, mirrorCalls, reconnectCalls: () => reconnectCalls};
}

/** Drain the fire-and-forget promise chain handleIncomingEvent kicks off. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('live stiq:mirrors adoption + org-config watermark', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    setActiveOnionAuthExtra([]); // module singleton — don't leak between tests
  });

  it('adopts a public mirror live (onMirrorsChanged) WITHOUT requesting a reconnect (fix 3)', async () => {
    const {runtime, mirrorCalls, reconnectCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();

    // The live MirrorSet was handed the fresh secondary set (primary excluded).
    expect(mirrorCalls).toEqual([[{url: MIRROR, onionAuthKey: null}]]);
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    // A public onion carries no auth — the daemon's auth set is unchanged, so NO restart is asked for.
    expect(reconnectCalls()).toBe(0);
    expect(getActiveOnionAuthExtra()).toEqual([]);
    runtime.dispose();
  });

  it('adopts an AUTH-GATED mirror: grows the onion-auth set and requests a reconnect (fix 7)', async () => {
    const {runtime, mirrorCalls, reconnectCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');
    expect(getActiveOnionAuthExtra()).toEqual([]); // no auth-gated secondaries at enroll

    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR, onionAuthKey: AUTH_KEY}], 1000));
    await flushMicrotasks();

    expect(mirrorCalls).toEqual([[{url: MIRROR, onionAuthKey: AUTH_KEY}]]);
    // The new mirror's <host>.auth_private must be written by a daemon restart before it's reachable.
    expect(getActiveOnionAuthExtra()).toEqual([{onionHost: MIRROR_HOST, privKeyBase32: AUTH_KEY}]);
    expect(reconnectCalls()).toBe(1);
    runtime.dispose();
  });

  it('a MALFORMED high-created_at doc does NOT block a later legitimate doc (fix 6)', async () => {
    const {runtime, mirrorCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    // A malformed doc (not a JSON array → applyOrgConfig returns null) carrying a HIGH created_at.
    runtime.handleIncomingEvent(mirrorsDoc([], 2000, 'this is not a json array'));
    await flushMicrotasks();
    expect(mirrorCalls).toEqual([]); // nothing applied
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([]); // and no mirror adopted

    // A later LEGITIMATE doc with a lower created_at must still apply — the malformed one must not
    // have advanced the per-d watermark (the bug: it did, permanently blocking this).
    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();
    expect(mirrorCalls).toEqual([[{url: MIRROR, onionAuthKey: null}]]);
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    runtime.dispose();
  });

  it('a genuinely OLDER stiq:mirrors doc is still rejected (anti-rollback preserved)', async () => {
    const {runtime, mirrorCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    // Apply a valid doc at t=1000.
    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();
    expect(mirrorCalls.length).toBe(1);

    // A strictly-older valid doc (t=500) from a stale/withholding mirror must NOT roll it back.
    const otherMirror = `ws://${'c'.repeat(56)}.onion`;
    runtime.handleIncomingEvent(mirrorsDoc([{url: otherMirror}], 500));
    await flushMicrotasks();
    expect(mirrorCalls.length).toBe(1); // unchanged — the rollback guard held
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    runtime.dispose();
  });

  // ── MF-1: recordKnownGoodMirror is the missing PRODUCER for the un-evictable mirror tier. A mirror
  //    the transport has SEEN serve honest content is captured into mirrorsKnownGood, which
  //    effectiveMirrors unions and no org `stiq:mirrors` de-list can retract. ────────────────────────
  it('a known-good mirror survives an org de-list (mirrorsKnownGood is un-evictable)', async () => {
    const {runtime, mirrorCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    // Org publishes a mirror; the device adopts it into mirrorsOrg.
    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);

    // The MirrorSet observes it serving honest content (promotion / confirmed withholding-delta) and
    // captures it as known-good — the un-evictable tier.
    runtime.recordKnownGoodMirror({url: MIRROR, onionAuthKey: null});
    await flushMicrotasks();
    // Re-capturing the same host is a no-op (deduped by onion host).
    runtime.recordKnownGoodMirror({url: `${MIRROR}/`, onionAuthKey: null});
    await flushMicrotasks();

    // Org now publishes a NEWER, EMPTY stiq:mirrors — a de-list attempt. mirrorsOrg is cleared...
    runtime.handleIncomingEvent(mirrorsDoc([], 2000));
    await flushMicrotasks();

    // ...but the mirror the device trusts stays: the org cannot retract a known-good mirror.
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    // The live transport was re-pushed the surviving set on the de-list (not an empty one).
    expect(mirrorCalls.at(-1)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    runtime.dispose();
  });

  // ── User-controlled relay management (the Relays screen producers). addUserMirror is the PRODUCER
  //    the mirrorsUser tier was missing; mute/unmute drive the mirrorsBlocked tier. ─────────────────
  const PRIMARY_HOST = 'a'.repeat(56);

  it('addUserMirror adopts a member mirror live (onMirrorsChanged) and shows it in the snapshot', async () => {
    const {runtime, mirrorCalls, reconnectCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    await runtime.addUserMirror({url: MIRROR, onionAuthKey: null});

    expect(mirrorCalls.at(-1)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    expect(reconnectCalls()).toBe(0); // public onion → no restart
    expect(runtime.relaySnapshot()?.active.map(r => [r.host, r.source])).toEqual([
      [PRIMARY_HOST, 'primary'],
      [MIRROR_HOST, 'user'],
    ]);
    runtime.dispose();
  });

  it('addUserMirror of an auth-gated relay grows the onion-auth set and requests a reconnect', async () => {
    const {runtime, reconnectCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    await runtime.addUserMirror({url: MIRROR, onionAuthKey: AUTH_KEY});

    expect(getActiveOnionAuthExtra()).toEqual([{onionHost: MIRROR_HOST, privKeyBase32: AUTH_KEY}]);
    expect(reconnectCalls()).toBe(1);
    runtime.dispose();
  });

  it('muteMirror closes an organizer mirror: drops it from the live set and lists it muted', async () => {
    const {runtime, mirrorCalls} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);

    await runtime.muteMirror({url: MIRROR, onionAuthKey: null});

    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([]); // subtracted from the effective set
    expect(mirrorCalls.at(-1)).toEqual([]); // live transport told to drop it
    const snap = runtime.relaySnapshot();
    expect(snap?.active.map(r => r.host)).toEqual([PRIMARY_HOST]); // only the primary remains
    expect(snap?.muted.map(r => [r.host, r.source])).toEqual([[MIRROR_HOST, 'organizer']]);
    runtime.dispose();
  });

  it('muteMirror refuses to mute the PRIMARY relay (the app must keep ≥1 relay)', async () => {
    const {runtime} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    await runtime.muteMirror({url: RELAY, onionAuthKey: null});

    const snap = runtime.relaySnapshot();
    expect(snap?.active.map(r => r.host)).toEqual([PRIMARY_HOST]);
    expect(snap?.muted).toEqual([]);
    runtime.dispose();
  });

  it('a mute wins over a later organizer re-publish; unmute restores the relay', async () => {
    const {runtime} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 1000));
    await flushMicrotasks();
    await runtime.muteMirror({url: MIRROR, onionAuthKey: null});
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([]);

    // Org re-publishes the SAME mirror with a newer doc — the member's mute must still win.
    runtime.handleIncomingEvent(mirrorsDoc([{url: MIRROR}], 2000));
    await flushMicrotasks();
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([]);

    await runtime.unmuteMirror(MIRROR_HOST);
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);
    runtime.dispose();
  });

  it('removeUserMirror drops a member-added mirror from the live set', async () => {
    const {runtime} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(community()), '1234', '9999');

    await runtime.addUserMirror({url: MIRROR, onionAuthKey: null});
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([{url: MIRROR, onionAuthKey: null}]);

    await runtime.removeUserMirror(MIRROR_HOST);
    expect(runtime.activeSecondaryMirrors(RELAY)).toEqual([]);
    expect(runtime.relaySnapshot()?.active.map(r => r.host)).toEqual([PRIMARY_HOST]);
    runtime.dispose();
  });
});
