/**
 * AppRuntime log offer — the owner-consent gate for listing a PRIVATE NIP-29 group in the organizer
 * dashboard's community log picker (channels/logOffer.ts wraps the wire contract; issuer/log-offer.mjs
 * is the server-side authority). Harness mirrors AppRuntime.groups.test.ts / AppRuntime.rosterOverlay.
 * test.ts (enrolledRuntime) — groups here are the creator's OWN, so their optimistic 39000 already
 * carries owner = the runtime's own pubkey, letting getLogOffer/setLogOffer/revokeLogOffer be
 * exercised without hand-building relay state.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
// TIMING_JITTER ships default-ON but delays only the wire send; disable it (as the sibling
// optimistic/groups tests do) so publishes are observable after a synchronous await.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {Kind} from '../nostr/events';
import {logOfferDTag, parseLogOfferContent} from '../channels/logOffer';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(): Promise<{runtime: AppRuntime; store: InMemoryEventStore; published: Event[]}> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    subscribeGroup: () => {},
    unsubscribeGroup: () => {},
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published};
}

function lastOfKind(published: Event[], kind: number): Event | undefined {
  return [...published].reverse().find(e => e.kind === kind);
}

describe('AppRuntime log offer', () => {
  it('setLogOffer publishes a kind-30078 live offer built from the group\'s CURRENT name/gradient/flags', async () => {
    const {runtime, published} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Secret Garden', private: true, closed: true, broadcast: false}))!;
    expect(groupId).toBeTruthy();

    await runtime.setLogOffer(groupId);

    const offerEvent = lastOfKind(published, Kind.AppData);
    expect(offerEvent).toBeDefined();
    expect(offerEvent!.tags).toContainEqual(['d', logOfferDTag(groupId)]);
    // Pin: never stiq:-prefixed — the relay reserves that prefix for the organizer's own config.
    expect(offerEvent!.tags.find(t => t[0] === 'd')?.[1]?.startsWith('stiq:')).toBe(false);

    const parsed = parseLogOfferContent(offerEvent!.content);
    expect(parsed).not.toBeNull();
    expect(parsed?.gid).toBe(groupId);
    expect(parsed?.n).toBe('Secret Garden');
    expect(parsed?.pr).toBe(true);
    expect(parsed?.cl).toBe(true);
    expect(parsed?.bc).toBe(false);
  });

  it('getLogOffer is null until setLogOffer publishes, then reflects the live offer (owner-keyed)', async () => {
    const {runtime} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Secret Garden', private: true}))!;
    expect(runtime.getLogOffer(groupId)).toBeNull();

    await runtime.setLogOffer(groupId);
    const offer = runtime.getLogOffer(groupId);
    expect(offer?.gid).toBe(groupId);
    expect(offer?.n).toBe('Secret Garden');
  });

  it('revokeLogOffer republishes the SAME d as an rv:true tombstone, delisting the offer', async () => {
    const {runtime, published} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Secret Garden', private: true}))!;
    await runtime.setLogOffer(groupId);
    expect(runtime.getLogOffer(groupId)).not.toBeNull();

    // buildLogOffer/buildLogOfferRevoke stamp `at`/created_at from Date.now() — two calls back-to-back
    // in a fast test can land in the SAME unix second, tying created_at. currentLogOffer (mirroring
    // spaceRules' getSpaceSettings) breaks ties by store order, not wall-clock intent, so advance the
    // clock a full second between publishes to pin "the later one wins" unambiguously (same idiom as
    // AppRuntime.dmBlock.test.ts's Date.now spy).
    const future = Date.now() + 2000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(future);
    try {
      await runtime.revokeLogOffer(groupId);
    } finally {
      nowSpy.mockRestore();
    }

    const revokeEvent = lastOfKind(published, Kind.AppData);
    expect(revokeEvent!.tags).toContainEqual(['d', logOfferDTag(groupId)]);
    const raw = JSON.parse(revokeEvent!.content) as {rv?: boolean};
    expect(raw.rv).toBe(true);
    expect(runtime.getLogOffer(groupId)).toBeNull();
  });
});
