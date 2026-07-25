/**
 * Member-arrival space-key backfill (the "joined but can't read/post" fix).
 *
 * The relay's grant-admit path (inviteGrantAdmits) makes an invitee a MEMBER with no admin action
 * at all — so nobody ever ran deliverCurrentSpaceKeyTo for them, and they landed in a private space
 * that rendered empty and where their own sends were silently blocked. The fix: every admin/owner
 * device holding the key, on every 39002 arrival, delivers the current-epoch key to every member it
 * hasn't already keyed at that epoch (persisted per-(space,member,epoch) dedupe).
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {getPublicKey} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const KIND_KEY_DELIVERY = 30079;

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(): Promise<{
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
}> {
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
/** A relay-signed replaceable state event (the fake relay key never matters client-side). */
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

/** A VALID secp256k1 pubkey fixture — the NIP-44 key wrap derives a shared secret against it. */
const pkOf = (n: number): string => getPublicKey(new Uint8Array(32).fill(n));

/** Drain the fire-and-forget delivery chains. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const deliveriesTo = (published: Event[], member: string): Event[] =>
  published.filter(
    e => e.kind === KIND_KEY_DELIVERY && e.tags.some(t => t[0] === 'p' && t[1] === member),
  );

describe('member-arrival space-key backfill', () => {
  it('an admin seeing a 39002 with an unkeyed member (a grant-admit) delivers the key — once', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    // I create the private space, so I hold the epoch-0 key.
    const gid = (await runtime.createGroup({name: 'Sec', private: true, broadcast: true, closed: true}))!;
    const joiner = pkOf(7);

    // The relay grant-admitted `joiner` with NO admin action: the 39002 just arrives listing them.
    const members = relayState(GroupKind.Members, [['d', gid], ['p', me], ['p', joiner]]);
    store.save(members);
    runtime.handleIncomingEvent(members);
    await flush();

    expect(deliveriesTo(published, joiner)).toHaveLength(1);

    // The same 39002 (or any later one with an unchanged list) must not re-deliver: the
    // per-(space, member, epoch) dedupe bounds the cost to one delivery ever.
    const again = relayState(GroupKind.Members, [['d', gid], ['p', me], ['p', joiner]]);
    store.save(again);
    runtime.handleIncomingEvent(again);
    await flush();
    expect(deliveriesTo(published, joiner)).toHaveLength(1);
  });

  it('delivers nothing when this device holds no key for the space', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const gid = 'not-my-keyed-space';
    const joiner = pkOf(8);
    // I'm listed as an ADMIN of a private space I never created — I hold no key, so I can't
    // (and must not attempt to) key anyone.
    store.save(relayState(GroupKind.Metadata, [['d', gid], ['name', 'X'], ['owner', me], ['private'], ['closed']]));
    store.save(relayState(GroupKind.Admins, [['d', gid], ['p', me]]));
    const members = relayState(GroupKind.Members, [['d', gid], ['p', me], ['p', joiner]]);
    store.save(members);
    runtime.handleIncomingEvent(members);
    await flush();
    expect(deliveriesTo(published, joiner)).toHaveLength(0);
  });

  it('a non-admin member device never backfills', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const owner = pkOf(1);
    const gid = 'someone-elses-space';
    store.save(relayState(GroupKind.Metadata, [['d', gid], ['name', 'X'], ['owner', owner], ['private'], ['closed']]));
    store.save(relayState(GroupKind.Admins, [['d', gid], ['p', owner]]));
    const members = relayState(GroupKind.Members, [['d', gid], ['p', owner], ['p', me], ['p', pkOf(9)]]);
    store.save(members);
    runtime.handleIncomingEvent(members);
    await flush();
    expect(published.filter(e => e.kind === KIND_KEY_DELIVERY)).toHaveLength(0);
  });
});
