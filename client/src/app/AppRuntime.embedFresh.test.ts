// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
// SCOPED_CHANNEL_SYNC pinned ON: the deriveNotifications tests below exercise the scoped channel
// rows, which only exist in the ON state (see AppRuntime.channelSync.test.ts for the rationale).
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
  SCOPED_CHANNEL_SYNC: true,
}));

/**
 * Embed/notification FRESHNESS: a quoted event must render what its source surface renders NOW,
 * loading it from the relay if needed — not whatever raw bytes happened to be cached first.
 *
 *  - getEvent folds channel/group edits exactly like the open surface (channelMessages /
 *    groupChatMessages) so an embed card and the destination it opens can never disagree.
 *  - getEvent NEVER passes space-sealed NIP-44 ciphertext through as preview text.
 *  - A comment embed fetches its missing thread ROOT (the tap navigates to the root — a cached
 *    comment with an unfetched root was a permanently dead tap).
 *  - Raw `kind:pubkey:d` coordinates resolve and fetch (NostrLinkPreview hands the tap path a
 *    DECODED naddr in exactly that shape).
 *  - fetchEventDoc un-blacklists on failure (the fetchNaddr idiom's second half — one Tor timeout
 *    must not strand an event card on "Fetching event…" for the whole session).
 *  - deriveNotifications: an EDIT is not new activity — it neither re-notifies nor outranks a
 *    genuinely newer broadcast, but the surviving row's preview shows the edited text.
 */
import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {Kind} from '../nostr/events';
import {GroupKind} from '../channels/groups';
import {FETCH_TIMEOUT_MS} from '../nostr/RelayClient';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-FRESH');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(): Promise<{runtime: AppRuntime; store: InMemoryEventStore}> {
  const store = new InMemoryEventStore();
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store};
}

const hex = (seed: string): string => seed.padEnd(64, '0');
const AUTHOR = hex('aa');
const STRANGER = hex('bb');

function chanMsg(id: string, coord: string, author: string, content: string, at: number): Event {
  return {
    id: hex(id),
    pubkey: author,
    created_at: at,
    kind: Kind.LiveChat,
    tags: [['a', coord, '', 'root']],
    content,
    sig: 's',
  } as Event;
}

function chanEdit(id: string, coord: string, author: string, target: string, content: string, at: number): Event {
  return {
    id: hex(id),
    pubkey: author,
    created_at: at,
    kind: Kind.LiveChat,
    tags: [['a', coord, '', 'root'], ['e', target, '', 'edit']],
    content,
    sig: 's',
  } as Event;
}

function grpMsg(id: string, gid: string, author: string, content: string, at: number, extraTags: string[][] = []): Event {
  return {
    id: hex(id),
    pubkey: author,
    created_at: at,
    kind: GroupKind.Chat,
    tags: [['h', gid], ...extraTags],
    content,
    sig: 's',
  } as Event;
}

function grpEdit(id: string, gid: string, author: string, target: string, content: string, at: number): Event {
  return {
    id: hex(id),
    pubkey: author,
    created_at: at,
    kind: GroupKind.Chat,
    tags: [['h', gid], ['e', target, '', 'edit']],
    content,
    sig: 's',
  } as Event;
}

describe('getEvent — edit fold parity with the open surface', () => {
  it("channel: the embed preview shows the author's LATEST edit, not the original bytes", () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    const coord = `30311:${STRANGER}:general`;
    const original = chanMsg('01', coord, AUTHOR, 'first draft', 100);
    store.save(original);
    store.save(chanEdit('02', coord, AUTHOR, original.id, 'second thoughts', 200));
    store.save(chanEdit('03', coord, AUTHOR, original.id, 'final wording', 300));

    expect(runtime.getEvent(original.id)?.content).toBe('final wording');
  });

  it('channel: a FOREIGN "edit" never rewrites the preview (author-scoped, like the open channel)', () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    const coord = `30311:${STRANGER}:general`;
    const original = chanMsg('01', coord, AUTHOR, 'my words', 100);
    store.save(original);
    store.save(chanEdit('02', coord, STRANGER, original.id, 'hijacked words', 200));

    expect(runtime.getEvent(original.id)?.content).toBe('my words');
  });

  it("group: the embed preview shows the author's latest edit", () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    const original = grpMsg('01', 'grp1', AUTHOR, 'before', 100);
    store.save(original);
    store.save(grpEdit('02', 'grp1', AUTHOR, original.id, 'after', 200));

    expect(runtime.getEvent(original.id)?.content).toBe('after');
  });
});

describe('getEvent — space-sealed content never renders as plaintext', () => {
  it('a sealed group message without the key resolves to an EMPTY body, not ciphertext', () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    // The group's relay state says PRIVATE — the same signal the open surface keys "hide, never
    // render ciphertext" on (AppRuntime.decryptSpaceMessages).
    store.save({
      id: hex('meta'),
      pubkey: hex('ff'),
      created_at: 10,
      kind: GroupKind.Metadata,
      tags: [['d', 'vault'], ['name', 'Vault'], ['owner', STRANGER], ['private']],
      content: '',
      sig: 's',
    } as Event);
    const sealed = grpMsg('01', 'vault', AUTHOR, 'AqB64CipherTextBlob==', 100, [
      ['encrypted', 'nip44'],
      ['ke', '0'],
    ]);
    store.save(sealed);

    const summary = runtime.getEvent(sealed.id);
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe(''); // attributed card, hidden body
    expect(summary!.content).not.toContain('CipherText');
  });
});

describe('getEvent — comment embeds fetch their missing thread ROOT', () => {
  it('kicks an id-scoped fetch for the root so the tap can eventually land', () => {
    const store = new InMemoryEventStore();
    const fetchEvents = jest.fn();
    const runtime = new AppRuntime({secureStorage: null, store, fetchEvents});
    const rootId = hex('r00t');
    const comment = {
      id: hex('c0'),
      pubkey: AUTHOR,
      created_at: 100,
      kind: Kind.Comment,
      tags: [['E', rootId]],
      content: 'nice post',
      sig: 's',
    } as Event;
    store.save(comment);

    const summary = runtime.getEvent(comment.id);
    expect(summary?.rootId).toBe(rootId);
    expect(fetchEvents).toHaveBeenCalledWith([rootId]); // root absent → fetched like the comment was
  });

  it('does not fetch a root that is already cached', () => {
    const store = new InMemoryEventStore();
    const fetchEvents = jest.fn();
    const runtime = new AppRuntime({secureStorage: null, store, fetchEvents});
    const root = {
      id: hex('r00t'),
      pubkey: STRANGER,
      created_at: 50,
      kind: Kind.Post,
      tags: [],
      content: 'the post',
      sig: 's',
    } as Event;
    const comment = {
      id: hex('c0'),
      pubkey: AUTHOR,
      created_at: 100,
      kind: Kind.Comment,
      tags: [['E', root.id]],
      content: 'nice post',
      sig: 's',
    } as Event;
    store.save(root);
    store.save(comment);

    expect(runtime.getEvent(comment.id)?.rootTitle).toBeTruthy();
    expect(fetchEvents).not.toHaveBeenCalled();
  });
});

describe('getEvent — raw `kind:pubkey:d` coordinates (the decoded-naddr tap shape)', () => {
  it('resolves a cached addressable by coordinate', () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({secureStorage: null, store});
    store.save({
      id: hex('a1'),
      pubkey: AUTHOR,
      created_at: 100,
      kind: 30023,
      tags: [['d', 'my-article'], ['title', 'On Freshness']],
      content: 'Article body',
      sig: 's',
    } as Event);

    const summary = runtime.getEvent(`30023:${AUTHOR}:my-article`);
    expect(summary?.title).toBe('On Freshness');
    expect(summary?.content).toBe('Article body');
  });

  it('filter-fetches an uncached coordinate instead of silently dead-ending', () => {
    const store = new InMemoryEventStore();
    const fetchByFilter = jest.fn();
    const runtime = new AppRuntime({secureStorage: null, store, fetchByFilter});

    expect(runtime.getEvent(`30023:${AUTHOR}:missing`)).toBeNull();
    expect(fetchByFilter).toHaveBeenCalledWith([
      {kinds: [30023], authors: [AUTHOR], '#d': ['missing']},
    ]);
  });
});

describe('fetchEventDoc — un-blacklist on failure (the fetchNaddr idiom, BOTH halves)', () => {
  // requestedEventCoords was add-only: one fetchByFilter attempt that timed out over Tor deduped
  // that event coordinate FOREVER, stranding EventDetailHost on "Fetching event…" all session.
  it('re-issues the fetch for a coordinate that never resolved, once the window elapses', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      const fetchByFilter = jest.fn();
      const runtime = new AppRuntime({secureStorage: null, store, fetchByFilter});
      const coord = `31923:${AUTHOR}:launch-party`;

      expect(runtime.eventLive(coord)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      // In-flight de-dupe must not regress: a re-render is still a no-op inside the window.
      expect(runtime.eventLive(coord)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(FETCH_TIMEOUT_MS);

      expect(runtime.eventLive(coord)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(2); // released — a later render retries
    } finally {
      jest.useRealTimers();
    }
  });

  it('never re-issues once the doc genuinely lands before the window elapses', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      const fetchByFilter = jest.fn();
      const runtime = new AppRuntime({secureStorage: null, store, fetchByFilter});
      const coord = `31923:${AUTHOR}:launch-party`;

      expect(runtime.eventLive(coord)).toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);

      store.save({
        id: hex('d0c'),
        pubkey: AUTHOR,
        created_at: 100,
        kind: 31923,
        tags: [['d', 'launch-party']],
        content: JSON.stringify({v: 1, t: 'Launch'}), // parseEventDoc's versioned wire shape
        sig: 's',
      } as Event);
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS);

      expect(runtime.eventLive(coord)).not.toBeNull();
      expect(fetchByFilter).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('deriveNotifications — a channel EDIT is not new activity', () => {
  function saveChannel(store: InMemoryEventStore, d: string): string {
    store.save({
      id: hex(`def${d}`),
      pubkey: STRANGER,
      created_at: 10,
      kind: Kind.LiveActivity,
      tags: [['d', d], ['title', `#${d}`]],
      content: '',
      sig: 's',
    } as Event);
    return `30311:${STRANGER}:${d}`;
  }

  it("keeps the ORIGINAL's id/ts (no re-notify of a read message) while the preview shows the edited text", async () => {
    const {runtime, store} = await enrolledRuntime();
    const coord = saveChannel(store, 'mine');
    const original = chanMsg('m1', coord, STRANGER, 'first wording', 100);
    store.save(original);
    store.save(chanEdit('m2', coord, STRANGER, original.id, 'fixed wording', 200));
    await runtime.subscribeChannel(coord);

    const row = runtime.deriveNotifications().find(n => n.kind === 'channel');
    expect(row).toBeDefined();
    expect(row!.id).toBe(original.id); // the edit's own id must NOT mint a fresh (unread) row
    expect(row!.ts).toBe(100);
    expect(row!.preview).toContain('fixed wording'); // …but the text shown is the current one
    runtime.dispose();
  });

  it('an edited OLD message never outranks a genuinely newer broadcast', async () => {
    const {runtime, store} = await enrolledRuntime();
    const coord = saveChannel(store, 'mine');
    const older = chanMsg('m1', coord, STRANGER, 'yesterday', 100);
    const newer = chanMsg('m3', coord, STRANGER, 'today', 150);
    store.save(older);
    store.save(newer);
    store.save(chanEdit('m2', coord, STRANGER, older.id, 'yesterday (edited)', 200));
    await runtime.subscribeChannel(coord);

    const row = runtime.deriveNotifications().find(n => n.kind === 'channel');
    expect(row!.id).toBe(newer.id); // created_at 200 on the edit must not beat the real latest
    expect(row!.preview).toContain('today');
    runtime.dispose();
  });
});
