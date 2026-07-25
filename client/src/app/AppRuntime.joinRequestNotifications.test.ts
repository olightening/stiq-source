/**
 * Join-request visibility in the notification center (deriveNotifications' join-request source) +
 * the subscription-lifecycle fix in closeGroup.
 *
 * An admin of a CLOSED group must see pending join requests without opening that group's Manage page:
 *   (A) closeGroup keeps the scoped sub alive for a closed group I administer (so the pending/state
 *       stream stays current), and drops it otherwise.
 *   (B) deriveNotifications emits a 'requested to join' row per pending 9021 (routing to Manage),
 *       excludes invited accepts, honors the per-group notification-prefs mute, and — the ver-key
 *       regression — re-derives when a fresh 39004 lands.
 *
 * Harness idioms mirror AppRuntime.membership.test.ts / AppRuntime.rosterOverlay.test.ts.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';
import {DEFAULT_PREFS, savePrefs} from '../notifications/prefs';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

interface Harness {
  runtime: AppRuntime;
  store: InMemoryEventStore;
  unsubscribeGroup: jest.Mock;
}

async function enrolledRuntime(): Promise<Harness> {
  const store = new InMemoryEventStore();
  const unsubscribeGroup = jest.fn();
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      void e;
      return {accepted: true, message: 'ok'};
    },
    subscribeGroup: () => {},
    unsubscribeGroup,
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, unsubscribeGroup};
}

let seq = 0;
/** A relay-signed replaceable state event; monotonic created_at so a later one supersedes. */
function relayState(kind: number, tags: string[][]): Event {
  seq += 1;
  return {
    id: (seq.toString(36) + 'e'.repeat(64)).slice(0, 64),
    pubkey: 'f'.repeat(64),
    created_at: 1000 + seq,
    kind,
    tags,
    content: '',
    sig: 's',
  } as Event;
}

/** A raw kind-9021 join request from `requester` (its id is the reqId the notification keys on). */
function joinRequest(requester: string, invited = false): Event {
  seq += 1;
  const tags: string[][] = [['h', GID]];
  if (invited) tags.push(['invite']);
  return {
    id: ('r' + seq.toString(36) + 'a'.repeat(64)).slice(0, 64),
    pubkey: requester,
    created_at: 2000 + seq,
    kind: GroupKind.JoinRequest,
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

const GID = 'g1';
const REQUESTER = 'b'.repeat(64);
const REQUESTER2 = 'c'.repeat(64);
const OTHER_ADMIN = 'd'.repeat(64);

/** Seed a CLOSED (non-broadcast) group's relay state with the given admins/members. */
function seedClosedGroup(h: Harness, admins: string[], members: string[]): void {
  h.store.save(relayState(GroupKind.Metadata, [['d', GID], ['name', 'Whisper network'], ['closed']]));
  h.store.save(relayState(GroupKind.Admins, [['d', GID], ...admins.map(a => ['p', a])]));
  h.store.save(relayState(GroupKind.Members, [['d', GID], ...members.map(m => ['p', m])]));
}

/** Force the group into the viewer's joined set (deriveNotifications iterates joinedGroups). */
function joinLocally(h: Harness): void {
  (h.runtime as unknown as {joinedGroups: Set<string>}).joinedGroups.add(GID);
}

// The notification-prefs module is a file-level singleton shared across every runtime built here —
// so a per-channel mute set in one test would otherwise leak into the next. Reset it to defaults
// before each test.
beforeEach(async () => {
  await savePrefs(DEFAULT_PREFS);
});

describe('join-request notifications — deriveNotifications source', () => {
  it('yields a "requested to join" row for a pending 9021 + 39004 on a closed group I admin', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [me], [me]);
    joinLocally(h);
    const req = joinRequest(REQUESTER);
    h.store.save(req);
    h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER]]));

    const row = h.runtime.deriveNotifications().find(i => i.action === 'requested to join');
    expect(row).toBeDefined();
    expect(row!.id).toBe(req.id); // keyed on the raw 9021 id (read-state needs a stable id)
    expect(row!.kind).toBe('channel');
    expect(row!.target).toEqual({kind: 'group_requests', groupId: GID});
    expect(row!.actor).toBe('Someone'); // no display name resolvable → the design fallback
    expect(row!.targetText).toBe('Whisper network');
    expect(row!.avatar.shape).toBe('hexagon'); // non-broadcast group
    expect(row!.ts).toBe(req.created_at);
  });

  it('excludes an invited accept (auto-approving) from the requests source', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [me], [me]);
    joinLocally(h);
    h.store.save(joinRequest(REQUESTER, /* invited */ true));
    h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER]]));

    expect(h.runtime.deriveNotifications().some(i => i.action === 'requested to join')).toBe(false);
  });

  it('is not emitted for a group I do NOT administer', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [OTHER_ADMIN], [OTHER_ADMIN, me]); // me is a plain member, not an admin
    joinLocally(h);
    h.store.save(joinRequest(REQUESTER));
    h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER]]));

    expect(h.runtime.deriveNotifications().some(i => i.action === 'requested to join')).toBe(false);
  });

  it('muting the group via notification prefs suppresses the request row', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [me], [me]);
    joinLocally(h);
    h.store.save(joinRequest(REQUESTER));
    h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER]]));
    expect(h.runtime.deriveNotifications().some(i => i.action === 'requested to join')).toBe(true);

    const prefs = h.runtime.getNotificationPrefs();
    await h.runtime.setNotificationPrefs({
      ...prefs,
      channels: {...prefs.channels, perChannel: {...prefs.channels.perChannel, [GID]: false}},
    });

    expect(h.runtime.deriveNotifications().some(i => i.action === 'requested to join')).toBe(false);
  });

  it('re-derives when a fresh 39004 arrives (ver-key regression for the cache-invalidation fix)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [me], [me]);
    joinLocally(h);
    h.store.save(joinRequest(REQUESTER));
    h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER]]));

    // First derive caches a single-request list.
    expect(h.runtime.deriveNotifications().filter(i => i.action === 'requested to join')).toHaveLength(1);

    // A second requester lands: raw 9021 + a NEW 39004 pending set. Ingesting the 39004 bumps the
    // store version for GroupKind.Pending — which is now folded into the notif cache key.
    h.store.save(joinRequest(REQUESTER2));
    ingest(h, relayState(GroupKind.Pending, [['d', GID], ['p', REQUESTER], ['p', REQUESTER2]]));

    // Without GroupKind.Pending in the ver-key, this second call would return the stale 1-item cache.
    expect(h.runtime.deriveNotifications().filter(i => i.action === 'requested to join')).toHaveLength(2);
  });
});

describe('closeGroup — subscription lifecycle for closed groups I administer', () => {
  it('does NOT unsubscribe a closed group I administer (keeps pending/state live)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [me], [me]);

    h.runtime.closeGroup(GID);
    expect(h.unsubscribeGroup).not.toHaveBeenCalled();
  });

  it('DOES unsubscribe a closed group I do NOT administer', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(h, [OTHER_ADMIN], [OTHER_ADMIN, me]); // member, not admin

    h.runtime.closeGroup(GID);
    expect(h.unsubscribeGroup).toHaveBeenCalledWith(GID);
  });
});
