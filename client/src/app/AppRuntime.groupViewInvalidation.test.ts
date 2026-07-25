/**
 * Group-view invalidation (snapshot storeVersions.groups): MainScreen's roster/messages memos key on
 * this single counter, so it MUST move for every input the group view renders — found frozen
 * on-device 2026-07-19: an admin's open Manage page never saw an incoming approve echo (39002), its
 * OWN optimistic approve (9000 insert), or a space key arriving after a sealed space rendered
 * ("No messages yet." until an unrelated write). GROUP_VIEW_KINDS now carries the membership kinds
 * and _spaceKeysVersion folds key arrivals into the same counter; these tests pin all three signals.
 *
 * Harness idioms mirror AppRuntime.rosterOverlay.test.ts (enrolledRuntime, relayState, ingest).
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
// TIMING_JITTER ships default-ON but delays only the wire send; these assertions await a 0ms flush(),
// so disable the jitter (as the sibling optimistic/groups tests do) to observe the publish outcome.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

interface Harness {
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
}

async function enrolledRuntime(): Promise<Harness> {
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

let stateSeq = 0;
/** A relay-signed replaceable state event; monotonic created_at so a later one supersedes. */
function relayState(kind: number, tags: string[][]): Event {
  stateSeq += 1;
  return {
    id: (stateSeq.toString(36) + 'e'.repeat(64)).slice(0, 64),
    pubkey: 'f'.repeat(64),
    created_at: 1000 + stateSeq,
    kind,
    tags,
    content: '',
    sig: 's',
  } as Event;
}

/** Save an event to the store AND feed it through handleIncomingEvent, as relay ingestion does. */
function ingest(h: Harness, ev: Event): void {
  h.store.save(ev);
  h.runtime.handleIncomingEvent(ev);
}

/** Typed accessor for the private key-cache funnel (mirrors rosterOverlay's internals() idiom). */
function internals(runtime: AppRuntime): {
  cacheSpaceKeyInMemory(spaceId: string, epoch: number, key: Uint8Array): void;
} {
  return runtime as unknown as {
    cacheSpaceKeyInMemory(spaceId: string, epoch: number, key: Uint8Array): void;
  };
}

const GID = 'g1';
const BOB = 'b'.repeat(64);

function groupsVersion(h: Harness): number {
  return h.runtime.getSnapshot().storeVersions.groups;
}

describe('snapshot storeVersions.groups moves for every group-view input', () => {
  it('bumps on an incoming members echo (39002) — the frozen-Manage-page approve echo', async () => {
    const h = await enrolledRuntime();
    const v0 = groupsVersion(h);
    ingest(h, relayState(GroupKind.Members, [['d', GID], ['p', BOB]]));
    expect(groupsVersion(h)).toBeGreaterThan(v0);
  });

  it('bumps on incoming pending state (39004) and a raw join request (9021)', async () => {
    const h = await enrolledRuntime();
    const v0 = groupsVersion(h);
    ingest(h, relayState(GroupKind.Pending, [['d', GID], ['p', BOB]]));
    const v1 = groupsVersion(h);
    expect(v1).toBeGreaterThan(v0);
    ingest(h, relayState(GroupKind.JoinRequest, [['h', GID]]));
    expect(groupsVersion(h)).toBeGreaterThan(v1);
  });

  it('bumps on the local optimistic approve (9000 insert) so the roster overlay renders instantly', async () => {
    const h = await enrolledRuntime();
    // Seed a closed group the runtime administers so approveJoin publishes.
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    ingest(h, relayState(GroupKind.Metadata, [['d', GID], ['name', 'G'], ['owner', me], ['closed']]));
    ingest(h, relayState(GroupKind.Admins, [['d', GID], ['p', me, 'admin']]));
    ingest(h, relayState(GroupKind.Members, [['d', GID], ['p', me]]));
    ingest(h, relayState(GroupKind.Pending, [['d', GID], ['p', BOB]]));
    const v0 = groupsVersion(h);
    await h.runtime.approveJoin(GID, BOB);
    await flush();
    expect(h.published.some(e => e.kind === GroupKind.AddUser)).toBe(true);
    expect(groupsVersion(h)).toBeGreaterThan(v0);
  });

  it('bumps when a space key lands (and not again for the same key) — sealed history appears on unlock', async () => {
    const h = await enrolledRuntime();
    const v0 = groupsVersion(h);
    internals(h.runtime).cacheSpaceKeyInMemory('gX', 0, new Uint8Array(32));
    const v1 = groupsVersion(h);
    expect(v1).toBeGreaterThan(v0);
    // Idempotent: re-caching the SAME (space, epoch) must not spin the counter.
    internals(h.runtime).cacheSpaceKeyInMemory('gX', 0, new Uint8Array(32));
    expect(groupsVersion(h)).toBe(v1);
    // A different epoch is a new unlock.
    internals(h.runtime).cacheSpaceKeyInMemory('gX', 1, new Uint8Array(32));
    expect(groupsVersion(h)).toBeGreaterThan(v1);
  });
});
