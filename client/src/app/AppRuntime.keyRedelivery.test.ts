// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment (same preamble as groups.test).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';
import {Kind} from '../nostr/events';
import {spaceKeyRequestDTag} from '../channels/membership';

/**
 * The space-key redelivery loop (OPEN_ITEMS §3.1 — "private space looks empty forever"). The
 * stranded state has no other exit: the member's 30079 never arrived, but the admin's persisted
 * `_deliveredKeyTo` watermark says "already keyed", so maybeDeliverKeyToNewMembers will never send
 * again — the space renders a legitimate-looking "No messages yet." for good. These tests pin both
 * halves: the REQUESTER publishes exactly one addressable ask when (and only when) the evidence
 * says it is behind, and the RESPONDER re-delivers the CURRENT epoch to CURRENT members only —
 * deliberately bypassing the watermark, never bypassing the roster.
 */
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-REKEY');
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

let relayStateSeq = 0;
/** A relay-signed replaceable state event (no `opt` tag → supersedes the optimistic seed). */
function relayState(kind: number, tags: string[][]): Event {
  relayStateSeq += 1;
  return {
    id: (relayStateSeq.toString(36) + 'e'.repeat(64)).slice(0, 64),
    pubkey: 'f'.repeat(64),
    created_at: 1000 + relayStateSeq,
    kind,
    tags,
    content: '',
    sig: 's',
  } as Event;
}

let requestSeq = 0;
/** A signed-looking redelivery request as it would arrive off the group's scoped sub. */
function keyRequest(spaceId: string, requester: string, at: number): Event {
  requestSeq += 1;
  return {
    id: (requestSeq.toString(36) + 'a'.repeat(64)).slice(0, 64),
    pubkey: requester,
    created_at: at,
    kind: Kind.AppData,
    tags: [
      ['d', spaceKeyRequestDTag(spaceId)],
      ['h', spaceId],
    ],
    content: '',
    sig: 's',
  } as Event;
}

/** Drain the fire-and-forget async chains (hydrate → sign → publishOptimistic → deliver). */
async function flush(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

const requestDocs = (published: Event[], spaceId: string): Event[] =>
  published.filter(
    e => e.kind === Kind.AppData && e.tags.some(t => t[0] === 'd' && t[1] === spaceKeyRequestDTag(spaceId)),
  );

const deliveries = (published: Event[]): Event[] =>
  published.filter(e => e.kind === Kind.SpaceKeyDelivery);

describe('responder: maybeRedeliverSpaceKey', () => {
  it('a keyed admin re-delivers to a roster member — BYPASSING the already-delivered watermark', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const gid = (await runtime.createGroup({name: 'Vault', private: true}))!;
    const requester = getPublicKey(generateSecretKey());
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', me], ['p', requester]]));

    // THE stranded state: this device's watermark claims the requester was already keyed at the
    // current epoch, so the 39002-driven backfill will never send again. The request must win.
    (runtime as unknown as {_deliveredKeyTo: Map<string, number>})._deliveredKeyTo.set(
      `${gid}:${requester}`,
      0,
    );

    published.length = 0;
    runtime.handleIncomingEvent(keyRequest(gid, requester, 5000));
    await flush();

    const sent = deliveries(published);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tags).toContainEqual(['p', requester]);
    expect(sent[0]!.tags).toContainEqual(['h', gid]);
    expect(sent[0]!.tags).toContainEqual(['ke', '0']); // CURRENT epoch — never the history
    runtime.dispose();
  });

  it("an OUTSIDER's request never leaks a key (roster is the gate, exactly like every delivery path)", async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const gid = (await runtime.createGroup({name: 'Vault', private: true}))!;
    const outsider = getPublicKey(generateSecretKey());
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', me]])); // outsider NOT listed

    published.length = 0;
    runtime.handleIncomingEvent(keyRequest(gid, outsider, 5000));
    await flush();
    expect(deliveries(published)).toHaveLength(0);
    runtime.dispose();
  });

  it('the same request is answered ONCE; a genuinely newer request is answered again', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const gid = (await runtime.createGroup({name: 'Vault', private: true}))!;
    const requester = getPublicKey(generateSecretKey());
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', me], ['p', requester]]));

    published.length = 0;
    const req = keyRequest(gid, requester, 5000);
    runtime.handleIncomingEvent(req);
    await flush();
    runtime.handleIncomingEvent(req); // a reconnect replaying the same addressable doc
    await flush();
    expect(deliveries(published)).toHaveLength(1);

    runtime.handleIncomingEvent(keyRequest(gid, requester, 5001)); // the member's NEXT session
    await flush();
    expect(deliveries(published)).toHaveLength(2);
    runtime.dispose();
  });

  it('a keyless non-admin member ignores requests entirely', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const owner = getPublicKey(generateSecretKey());
    const requester = getPublicKey(generateSecretKey());
    const gid = 'notmine1';
    store.save(relayState(GroupKind.Metadata, [['d', gid], ['name', 'X'], ['owner', owner], ['private']]));
    store.save(relayState(GroupKind.Admins, [['d', gid], ['p', owner]]));
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', owner], ['p', me], ['p', requester]]));

    published.length = 0;
    runtime.handleIncomingEvent(keyRequest(gid, requester, 5000));
    await flush();
    expect(deliveries(published)).toHaveLength(0);
    runtime.dispose();
  });
});

describe('requester: maybeRequestSpaceKeyRedelivery (fires from opening the space)', () => {
  it('a keyless member opening a private space publishes ONE request doc — and only one per session', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const owner = getPublicKey(generateSecretKey());
    const gid = 'darkspace';
    store.save(relayState(GroupKind.Metadata, [['d', gid], ['name', 'Dark'], ['owner', owner], ['private']]));
    store.save(relayState(GroupKind.Admins, [['d', gid], ['p', owner]]));
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', owner], ['p', me]]));

    published.length = 0;
    runtime.openGroup(gid);
    await flush();
    const docs = requestDocs(published, gid);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.tags).toContainEqual(['h', gid]); // rides the group's scoped sub to the admins
    expect(docs[0]!.content).toBe('');

    runtime.openGroup(gid); // re-opening the view must not spam the relay
    await flush();
    expect(requestDocs(published, gid)).toHaveLength(1);
    runtime.dispose();
  });

  it('a member who HOLDS the current key never asks', async () => {
    const {runtime, published} = await enrolledRuntime();
    const gid = (await runtime.createGroup({name: 'Mine', private: true}))!; // creator minted epoch 0

    published.length = 0;
    runtime.openGroup(gid);
    await flush();
    expect(requestDocs(published, gid)).toHaveLength(0);
    runtime.dispose();
  });

  it('holding an OLD epoch while messages prove a newer one (a rotation we missed) triggers the ask', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const gid = (await runtime.createGroup({name: 'Rotated', private: true}))!; // we hold epoch 0
    // A cached message sealed under epoch 1 — evidence of a rotation whose 30079 never reached us.
    store.save({
      id: 'c'.repeat(64),
      pubkey: 'd'.repeat(64),
      created_at: 2000,
      kind: GroupKind.Chat,
      tags: [['h', gid], ['encrypted', 'nip44'], ['ke', '1']],
      content: 'ciphertext',
      sig: 's',
    } as Event);

    published.length = 0;
    runtime.openGroup(gid);
    await flush();
    expect(requestDocs(published, gid)).toHaveLength(1);
    runtime.dispose();
  });

  it('a NON-member does not ask (the responder would refuse anyway; don\'t even publish)', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const owner = getPublicKey(generateSecretKey());
    const gid = 'exclusive';
    store.save(relayState(GroupKind.Metadata, [['d', gid], ['name', 'X'], ['owner', owner], ['private']]));
    store.save(relayState(GroupKind.Members, [['d', gid], ['p', owner]])); // me NOT listed

    published.length = 0;
    runtime.openGroup(gid);
    await flush();
    expect(requestDocs(published, gid)).toHaveLength(0);
    runtime.dispose();
  });
});
