import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {MirrorSet, fullHorizonNegentropy, type MirrorSpec} from './MirrorSet';
import {InMemoryEventStore, type EventStore} from './store';
import {FakeRelaySocket} from './socket.fake';
import type {RelaySocket} from './socket';
import type {NegentropySyncOptions} from './RelayClient';
import type {ReqFilter} from './protocol';
import {FEED_KINDS} from '../contracts';

/** A primary-shaped negentropy option: incremental `since` window, getItems reads FEED_KINDS from the
 *  shared store — the exact shape App.tsx builds. Used to prove secondaries widen it to full horizon. */
function primaryNegentropy(store: EventStore, filter: () => ReqFilter): NegentropySyncOptions {
  return {
    subId: 'feed',
    filter,
    getItems: f => {
      let evs = store.query({kinds: FEED_KINDS});
      if (f.since !== undefined) evs = evs.filter(e => e.created_at >= f.since!);
      if (f.limit !== undefined) evs = evs.slice(0, f.limit);
      return evs.map(e => ({id: e.id, timestamp: e.created_at}));
    },
    fallbackFilter: filter,
  };
}

function makePost(content: string, createdAt: number): Event {
  const sk = generateSecretKey();
  return finalizeEvent({kind: 1, created_at: createdAt, tags: [], content}, sk);
}

/** Tracks every socket the MirrorSet asks for by url, keyed so tests can drive a specific mirror. */
function trackedCreateSocket(): {
  createSocket: (url: string) => RelaySocket;
  socketsFor: (url: string) => FakeRelaySocket[];
  callCount: (url: string) => number;
} {
  const byUrl = new Map<string, FakeRelaySocket[]>();
  return {
    createSocket: (url: string) => {
      const socket = new FakeRelaySocket();
      const list = byUrl.get(url) ?? [];
      list.push(socket);
      byUrl.set(url, list);
      return socket;
    },
    socketsFor: (url: string) => byUrl.get(url) ?? [],
    callCount: (url: string) => (byUrl.get(url) ?? []).length,
  };
}

describe('MirrorSet', () => {
  it('is byte-identical to a bare RelayClient with zero secondary mirrors', async () => {
    const primarySocket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const {createSocket, callCount} = trackedCreateSocket();
    const mirrors = new MirrorSet(primarySocket, store, {
      primaryOptions: {kinds: [1]},
      createSocket,
      secondaryMirrors: [],
    });

    let synced = false;
    const received: string[] = [];
    mirrors.onSynced(() => (synced = true));
    mirrors.onEvent(e => received.push(e.id));

    primarySocket.simulateOpen();
    expect(JSON.parse(primarySocket.sent[0]!)).toEqual(['REQ', 'feed', {kinds: [1]}]);
    expect(mirrors.isSynced()).toBe(false);

    const post = makePost('hello', 1000);
    primarySocket.emitEvent('feed', post);
    primarySocket.emitEose('feed');

    expect(synced).toBe(true);
    expect(mirrors.isSynced()).toBe(true);
    expect(received).toEqual([post.id]);
    expect(mirrors.cachedPosts()).toEqual([post]);
    // No secondary was ever attempted — zero-mirror config never touches createSocket.
    expect(callCount('wss://mirror.onion')).toBe(0);

    const pending = mirrors.publish(makePost('published', 2000));
    const okId = JSON.parse(primarySocket.sent[1]!)[1].id as string;
    primarySocket.emit(JSON.stringify(['OK', okId, true, '']));
    await expect(pending).resolves.toEqual({accepted: true, message: ''});

    mirrors.close();
    expect(primarySocket.closed).toBe(true);
  });

  it('fires onEvent exactly once when both primary and a secondary ingest the same event', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const received: string[] = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryPlan: () => [{subId: 'recon', filter: {kinds: [1]}}],
        secondaryConnectDelayMs: 10,
      });
      mirrors.onEvent(e => received.push(e.id));

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary syncs -> schedules the staggered secondary connect

      jest.advanceTimersByTime(10);
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen();
      expect(JSON.parse(secondarySocket.sent[0]!)).toEqual(['REQ', 'recon', {kinds: [1]}]);
      secondarySocket.emitEose('recon'); // reconcile-only secondary syncs

      // A single real event delivered on the primary's live sub FIRST...
      const post = makePost('shared', 1000);
      primarySocket.emitEvent('feed', post);
      // ...then re-delivered on the secondary's own subscription (as a real mirror would, since the
      // event lives in both relays' histories). Store-level dedup means the secondary's ingest sees
      // it as already-known and never fires its own onEvent.
      secondarySocket.emitEvent('recon', post);

      expect(received).toEqual([post.id]);
      expect(store.size()).toBe(1);
      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('promotes a withholding-flagged secondary to the full live plan (unpinned primary)', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const withheldEvents: Array<{withholdingUrl: string; promotedUrl: string | null}> = [];
      const received: string[] = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        primaryUrl: 'wss://primary.onion',
        secondaryConnectDelayMs: 10,
        onWithholding: info => withheldEvents.push(info),
      });
      mirrors.onEvent(e => received.push(e.id));

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary synced -> connected+synced for the withholding gate

      jest.advanceTimersByTime(10);
      const firstSecondarySocket = socketsFor(secondarySpec.url)[0]!;
      firstSecondarySocket.simulateOpen(); // default secondaryPlan (undefined) -> [] -> syncs immediately
      // handleChildSynced auto-fires resyncFeed() (legacy path, no negentropy) under a fresh sub id.
      const resyncFrame = JSON.parse(firstSecondarySocket.sent[0]!) as [string, string, unknown];
      expect(resyncFrame[0]).toBe('REQ');
      const resyncSubId = resyncFrame[1];

      // The relay this secondary IS honestly reconciling against yields a post the primary never sent.
      // (Ingesting it synchronously cascades straight through to promotion below — no EOSE needed.)
      const withheld = makePost('withheld by primary', 900);
      firstSecondarySocket.emitEvent(resyncSubId, withheld);

      // Delivered once to the app...
      expect(received).toEqual([withheld.id]);
      // ...and attributed as withholding: the secondary is torn down and rebuilt with the FULL plan.
      expect(callCount(secondarySpec.url)).toBe(2);
      expect(withheldEvents).toEqual([
        {withholdingUrl: 'wss://primary.onion', promotedUrl: secondarySpec.url},
      ]);

      const promotedSocket = socketsFor(secondarySpec.url)[1]!;
      promotedSocket.simulateOpen();
      const promotedFrame = JSON.parse(promotedSocket.sent[0]!) as [string, string, {kinds: number[]}];
      // Full live plan now (subId 'feed', not the reconcile-only 'recon'/empty plan) — resumed from
      // the shared store's high-water mark rather than a cold-cache REQ.
      expect(promotedFrame[0]).toBe('REQ');
      expect(promotedFrame[1]).toBe('feed');
      expect(promotedFrame[2].kinds).toEqual([1]);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('routes scoped (re)subscriptions to the PROMOTED secondary, not the withholding primary', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        primaryUrl: 'wss://primary.onion',
        secondaryConnectDelayMs: 10,
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary synced -> eligible for the withholding gate

      // Baseline: before any promotion a scoped group sub goes to the primary.
      mirrors.subscribeScoped('grp:before', [{kinds: [39000]}]);
      const beforeFrame = primarySocket.sent.map(s => JSON.parse(s)).find(f => f[1] === 'grp:before');
      expect(beforeFrame?.[0]).toBe('REQ');

      // Drive the same withholding -> promotion path as the test above.
      jest.advanceTimersByTime(10);
      const firstSecondarySocket = socketsFor(secondarySpec.url)[0]!;
      firstSecondarySocket.simulateOpen();
      const resyncSubId = (JSON.parse(firstSecondarySocket.sent[0]!) as [string, string])[1];
      firstSecondarySocket.emitEvent(resyncSubId, makePost('withheld by primary', 900));

      const promotedSocket = socketsFor(secondarySpec.url)[1]!;
      promotedSocket.simulateOpen();
      const primarySentBefore = primarySocket.sent.length;

      // A scoped (re)subscription now MUST land on the promoted mirror — the withholding primary is
      // exactly the socket AppRuntime.onRelaySubscribed must stop re-opening scoped group subs on.
      mirrors.subscribeScoped('grp:after', [{kinds: [39002]}]);
      const onPromoted = promotedSocket.sent.map(s => JSON.parse(s)).find(f => f[1] === 'grp:after');
      expect(onPromoted?.[0]).toBe('REQ');
      // ...and NOT on the withholding primary.
      expect(primarySocket.sent.length).toBe(primarySentBefore);

      // closeSub likewise targets the promoted mirror.
      mirrors.closeSub('grp:after');
      const closed = promotedSocket.sent.map(s => JSON.parse(s)).find(f => f[0] === 'CLOSE' && f[1] === 'grp:after');
      expect(closed).toBeTruthy();

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never demotes a pinned primary even when a secondary reports a withheld feed event', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const withheldEvents: unknown[] = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        primaryUrl: 'wss://primary.onion',
        pinnedPrimaryUrl: 'wss://primary.onion', // user pinned the primary as preferred
        secondaryConnectDelayMs: 10,
        onWithholding: info => withheldEvents.push(info),
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed');

      jest.advanceTimersByTime(10);
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen();
      const resyncFrame = JSON.parse(secondarySocket.sent[0]!) as [string, string, unknown];
      const resyncSubId = resyncFrame[1];

      const withheld = makePost('withheld but primary is pinned', 900);
      secondarySocket.emitEvent(resyncSubId, withheld);

      // No promotion: the pinned primary is never auto-demoted.
      expect(callCount(secondarySpec.url)).toBe(1);
      expect(withheldEvents).toEqual([]);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publish resolves on the first accepted OK across connected children', async () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryConnectDelayMs: 10,
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed');
      jest.advanceTimersByTime(10);
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen(); // reconcile-only (default empty plan) syncs immediately and connects

      const post = makePost('fan out', 3000);
      const pending = mirrors.publish(post);
      // The secondary answers first with an accept; publish must resolve on it, not wait on the primary.
      const secondaryEventId = JSON.parse(secondarySocket.sent.at(-1)!)[1].id as string;
      secondarySocket.emit(JSON.stringify(['OK', secondaryEventId, true, '']));

      await expect(pending).resolves.toEqual({accepted: true, message: ''});
      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publish returns offline when no child is connected', async () => {
    const primarySocket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const {createSocket} = trackedCreateSocket();
    const mirrors = new MirrorSet(primarySocket, store, {
      primaryOptions: {kinds: [1], publishTimeoutMs: 5},
      createSocket,
      secondaryMirrors: [],
    });
    // Primary socket never opens — its publish call will time out (fast, via a short publishTimeoutMs)
    // and MirrorSet's single-target fast path passes that offline-shaped result straight through.
    jest.useFakeTimers();
    try {
      const pending = mirrors.publish(makePost('nobody home', 4000));
      jest.advanceTimersByTime(5);
      const result = await pending;
      expect(result.accepted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fires onSynced on the first child to sync, before any secondary connects', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket} = trackedCreateSocket();
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [{url: 'wss://mirror1.onion'}],
        secondaryConnectDelayMs: 10_000,
      });
      let synced = false;
      mirrors.onSynced(() => (synced = true));

      primarySocket.simulateOpen();
      expect(synced).toBe(false);
      primarySocket.emitEose('feed');
      expect(synced).toBe(true); // fired on the primary alone; the secondary hasn't even connected yet

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Fix 2: a connected-but-WITHHOLDING primary (opens, never syncs) must not disable cross-mirror
  //    reconciliation — a bounded wall-clock deadline starts the secondaries anyway. ────────────────
  it('starts secondaries on a wall-clock deadline when the primary connects but never syncs', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryConnectDelayMs: 5,
        secondaryStartDeadlineMs: 100,
      });

      primarySocket.simulateOpen(); // connected...
      // ...but the primary NEVER emits EOSE — onSynced never fires (the withholding case).
      jest.advanceTimersByTime(99);
      expect(callCount(secondarySpec.url)).toBe(0); // deadline hasn't elapsed yet

      jest.advanceTimersByTime(2); // deadline fires -> startSecondaries -> staggered connect (index 0)
      expect(callCount(secondarySpec.url)).toBe(1); // secondary attempted despite no primary sync

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a primary that DOES sync before the deadline cancels it and does not double-start secondaries', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryConnectDelayMs: 5,
        secondaryStartDeadlineMs: 100,
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary syncs -> startSecondaries + clears the deadline
      jest.advanceTimersByTime(5);
      expect(callCount(secondarySpec.url)).toBe(1);

      // Advancing past the (now-cancelled) deadline must NOT schedule a second connect attempt.
      jest.advanceTimersByTime(200);
      expect(callCount(secondarySpec.url)).toBe(1);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── A Tor-offline createSocket() throw during a secondary connect attempt must retry, not crash. ──
  //    createSocket dials Tor exactly like the primary's own connect path (App.tsx's startRelay) and
  //    throws SYNCHRONOUSLY when Tor is momentarily offline (torSocket.ts's requireTorTransport).
  //    startRelay wraps that call in a try/catch for exactly this reason; connectSecondary used not
  //    to — so a staggered start (or this same test's real target, its OWN onClose-driven auto-retry)
  //    firing while Tor was still mid-reconnect threw UNCAUGHT out of a bare setTimeout callback, with
  //    no caller in a position to catch it.
  it('retries on a backoff instead of throwing when createSocket fails (Tor momentarily offline)', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      let calls = 0;
      let failNext = false;
      const sockets: FakeRelaySocket[] = [];
      const createSocket = (): RelaySocket => {
        calls++;
        if (failNext) {
          failNext = false;
          throw new Error('offline: no Tor circuit; refusing any non-Tor connection');
        }
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      };
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryConnectDelayMs: 5,
        // A real (non-empty) plan so the recovered secondary actually opens a sub to ingest through —
        // the default `() => []` would leave knownSubIds empty and silently drop the proof-of-life
        // event below regardless of whether the reconnect itself worked.
        secondaryPlan: () => [{subId: 'recon', filter: {kinds: [1]}}],
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary syncs -> startSecondaries schedules the staggered connect
      failNext = true; // the staggered first attempt finds Tor offline
      // Advancing past the staggered delay must not throw out of this call — that IS the bug.
      expect(() => jest.advanceTimersByTime(5)).not.toThrow();
      expect(calls).toBe(1);
      expect(sockets).toHaveLength(0); // the throwing attempt never produced a socket

      // The retry is scheduled on the SAME relayBackoffMs(1) schedule a post-connect failure gets
      // (streak 1 -> 4000-6000ms with jitter); advancing past its ceiling must fire exactly one retry.
      expect(() => jest.advanceTimersByTime(6_000)).not.toThrow();
      expect(calls).toBe(2);
      expect(sockets).toHaveLength(1); // this attempt succeeded

      // The recovered secondary is a genuinely live child — it ingests like any other.
      sockets[0]!.simulateOpen();
      sockets[0]!.emitEvent('recon', makePost('recovered mirror', 1000));
      expect(store.size()).toBe(1);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Fix 3: a durably-adopted mirror is used WITHOUT a reconnect — newcomers connect, existing
  //    children are left running, dropped children are torn down. ────────────────────────────────
  it('updateSecondaryMirrors connects a newcomer, leaves an existing child untouched, and drops a removed one', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const first: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [first],
        secondaryConnectDelayMs: 10,
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary syncs -> startSecondaries
      jest.advanceTimersByTime(10);
      socketsFor(first.url)[0]!.simulateOpen();
      expect(callCount(first.url)).toBe(1);

      // Organizer publishes a fresh stiq:mirrors adding a second (public) mirror; adopt it live.
      const second: MirrorSpec = {url: 'wss://mirror2.onion'};
      mirrors.updateSecondaryMirrors([first, second]);
      jest.advanceTimersByTime(10);
      expect(callCount(second.url)).toBe(1); // newcomer attempted without a reconnect
      expect(callCount(first.url)).toBe(1); // the already-connected mirror was NOT rebuilt

      // Removing the first from the set tears its child down (deliberate — no auto-reconnect).
      mirrors.updateSecondaryMirrors([second]);
      expect(socketsFor(first.url)[0]!.closed).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(callCount(first.url)).toBe(1); // torn-down child never auto-reconnects

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Fix 4: a pre-connect retry (createSocket() threw before any ChildEntry existed) must not
  //    resurrect a mirror the organizer has since REMOVED via updateSecondaryMirrors. There is no
  //    ChildEntry for updateSecondaryMirrors's de-list loop to walk and tear down in this case — the
  //    armed retry closure is only visible to connectSecondary itself. ──────────────────────────────
  it('abandons a pending pre-connect retry once its mirror is removed from the set', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      let calls = 0;
      const createSocket = (): RelaySocket => {
        calls++;
        throw new Error('offline: no Tor circuit; refusing any non-Tor connection');
      };
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryConnectDelayMs: 5,
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary syncs -> startSecondaries schedules the staggered connect
      // The staggered first attempt finds Tor offline; connectSecondary arms a pre-connect retry keyed
      // on the URL alone (preConnectFailureStreak) since no ChildEntry was ever created.
      jest.advanceTimersByTime(5);
      expect(calls).toBe(1);

      // Organizer removes this mirror from stiq:mirrors BEFORE the retry fires. Without the fix, this
      // pending retry is invisible to updateSecondaryMirrors's de-list loop (it only walks ChildEntrys)
      // and keeps going regardless.
      mirrors.updateSecondaryMirrors([]);

      // Advance past the retry's backoff (relayBackoffMs(1): 4000-6000ms with jitter, same schedule the
      // sibling "retries on a backoff" test above pins).
      jest.advanceTimersByTime(6_000);
      // The retry must have abandoned itself instead of dialing a mirror that's no longer wanted.
      expect(calls).toBe(1);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Fix 1: a secondary reconciles the FULL display horizon, not the primary's incremental `since`
  //    window — otherwise a primary that withheld OLDER posts is never caught. ─────────────────────
  it('gives secondaries a full-horizon negentropy filter (no incremental `since`)', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {
          plan: () => [], // feed owned by negentropy
          negentropy: primaryNegentropy(store, () => ({kinds: FEED_KINDS, since: 999_999})),
        },
        createSocket,
        secondaryMirrors: [secondarySpec],
        secondaryPlan: () => [],
        secondaryConnectDelayMs: 5,
        secondaryStartDeadlineMs: 20,
        secondaryReconcileLimit: 500,
      });

      primarySocket.simulateOpen();
      // The PRIMARY opens with its incremental since-window NEG-OPEN.
      const primaryNeg = primarySocket.sent.map(s => JSON.parse(s)).find(f => f[0] === 'NEG-OPEN');
      expect(primaryNeg[2]).toEqual({kinds: FEED_KINDS, since: 999_999});

      // Primary never syncs; the deadline starts the (withholding-resistant) secondary.
      jest.advanceTimersByTime(20);
      jest.advanceTimersByTime(5);
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen();

      const secondaryNeg = secondarySocket.sent.map(s => JSON.parse(s)).find(f => f[0] === 'NEG-OPEN');
      expect(secondaryNeg).toBeDefined();
      // Full display horizon: the primary's `since` is gone, bounded by the reconcile limit instead.
      expect(secondaryNeg[2]).toEqual({kinds: FEED_KINDS, limit: 500});
      expect('since' in secondaryNeg[2]).toBe(false);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── MF-4: a connected-but-never-syncing (stall-withhold) primary can never satisfy isSynced(), so
  //    promotion must still fire on the first RECENT secondary delta once the startup deadline elapses.
  it('promotes on a recent secondary delta even though the primary never syncs (never-synced path)', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const withheldEvents: Array<{withholdingUrl: string; promotedUrl: string | null}> = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]}, // no negentropy → no window boundary → every delta is a candidate
        createSocket,
        secondaryMirrors: [secondarySpec],
        primaryUrl: 'wss://primary.onion',
        secondaryConnectDelayMs: 5,
        secondaryStartDeadlineMs: 20,
        onWithholding: info => withheldEvents.push(info),
      });

      primarySocket.simulateOpen(); // connected...
      // ...but the primary NEVER emits EOSE — isSynced() stays false forever (the stall-withhold case).
      // Advance past the 20ms deadline so the nested index-0 connect (delay 0, scheduled AT t=20) also
      // fires within the same run's remaining budget.
      jest.advanceTimersByTime(25); // deadline fires → primaryNeverSynced + staggered connect (index 0)
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen(); // empty plan → syncs → resyncFeed() under a fresh sub
      const resyncSubId = (JSON.parse(secondarySocket.sent[0]!) as [string, string, unknown])[1];

      const withheld = makePost('recent, withheld by a never-syncing primary', 1500);
      secondarySocket.emitEvent(resyncSubId, withheld);

      // Promotion happened WITHOUT primary.isSynced() — the whole point of the never-synced path.
      expect(mirrors.isSynced()).toBe(false); // still not synced on the primary side
      expect(callCount(secondarySpec.url)).toBe(2);
      expect(withheldEvents).toEqual([
        {withholdingUrl: 'wss://primary.onion', promotedUrl: secondarySpec.url},
      ]);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── MF-5a: a full-horizon secondary legitimately BACK-FILLS older history below the primary's live
  //    window; that older delta is union-ingested but must NOT be misread as withholding. Only a delta
  //    at/after the window promotes (and marks the mirror known-good, MF-1). ─────────────────────────
  it('does not promote (or capture) on OLDER-history back-fill, but does on a recent delta', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const secondarySpec: MirrorSpec = {url: 'wss://mirror1.onion'};
      const withheldEvents: unknown[] = [];
      const observedGood: MirrorSpec[] = [];
      const received: string[] = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {
          plan: () => [],
          // The primary's live/high-water window starts at 1000 — anything older is back-fill.
          negentropy: primaryNegentropy(store, () => ({kinds: FEED_KINDS, since: 1000})),
        },
        createSocket,
        // A live sub so the secondary can deliver events directly (its own negentropy stays half-open).
        secondaryPlan: () => [{subId: 'recon', filter: {kinds: [1]}}],
        secondaryMirrors: [secondarySpec],
        primaryUrl: 'wss://primary.onion',
        secondaryConnectDelayMs: 5,
        secondaryStartDeadlineMs: 20,
        onWithholding: info => withheldEvents.push(info),
        onMirrorObservedGood: spec => observedGood.push(spec),
      });
      mirrors.onEvent(e => received.push(e.id));

      // Primary never connects → never syncs → deadline starts the secondary (promotion is maximally
      // enabled via the never-synced path, so a non-promotion here is purely the recency gate). Advance
      // past the 20ms deadline so the nested index-0 connect (delay 0) fires in the same run.
      jest.advanceTimersByTime(25);
      const secondarySocket = socketsFor(secondarySpec.url)[0]!;
      secondarySocket.simulateOpen();

      // OLDER than the window (created_at 900 < since 1000): union-ingested, but NOT a withholding signal.
      const backfill = makePost('older back-fill', 900);
      secondarySocket.emitEvent('recon', backfill);
      expect(received).toContain(backfill.id); // union-of-reads still delivered it
      expect(callCount(secondarySpec.url)).toBe(1); // no promotion
      expect(withheldEvents).toEqual([]);
      expect(observedGood).toEqual([]); // and NOT captured as known-good

      // AT/after the window (created_at 1500 >= since 1000): a real recent delta → capture + promote.
      const recent = makePost('recent, withheld', 1500);
      secondarySocket.emitEvent('recon', recent);
      expect(observedGood).toEqual([secondarySpec]); // MF-1 capture fires for the honest mirror
      expect(callCount(secondarySpec.url)).toBe(2); // promoted
      expect(withheldEvents).toEqual([
        {withholdingUrl: 'wss://primary.onion', promotedUrl: secondarySpec.url},
      ]);

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── MF-5b: during the connect window after a promotion (the promoted socket hasn't opened, so
  //    promotedEntry.connected is still false), a second secondary also holding a delta must NOT fire
  //    its own promotion — the synchronous promotionPending flag guards it. ──────────────────────────
  it('does not double-promote during the connect window when a second secondary also has a delta', () => {
    jest.useFakeTimers();
    try {
      const primarySocket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const {createSocket, socketsFor, callCount} = trackedCreateSocket();
      const specA: MirrorSpec = {url: 'wss://mirrorA.onion'};
      const specB: MirrorSpec = {url: 'wss://mirrorB.onion'};
      const withheldEvents: Array<{withholdingUrl: string; promotedUrl: string | null}> = [];
      const mirrors = new MirrorSet(primarySocket, store, {
        primaryOptions: {kinds: [1]},
        createSocket,
        secondaryMirrors: [specA, specB],
        primaryUrl: 'wss://primary.onion',
        secondaryConnectDelayMs: 5,
        onWithholding: info => withheldEvents.push(info),
      });

      primarySocket.simulateOpen();
      primarySocket.emitEose('feed'); // primary synced
      jest.advanceTimersByTime(5); // connect A (delay 0) and B (delay 5)
      const socketA = socketsFor(specA.url)[0]!;
      const socketB = socketsFor(specB.url)[0]!;
      socketA.simulateOpen();
      socketB.simulateOpen();
      const subA = (JSON.parse(socketA.sent[0]!) as [string, string, unknown])[1];
      const subB = (JSON.parse(socketB.sent[0]!) as [string, string, unknown])[1];

      // A delivers first → A is promoted; its promoted socket has NOT opened yet (promotionPending set).
      socketA.emitEvent(subA, makePost('withheld via A', 900));
      expect(callCount(specA.url)).toBe(2); // A: initial + promoted rebuild

      // B delivers DURING that connect window → must be blocked; only ONE promotion total.
      socketB.emitEvent(subB, makePost('withheld via B', 901));
      expect(callCount(specB.url)).toBe(1); // B never promoted
      expect(withheldEvents).toEqual([
        {withholdingUrl: 'wss://primary.onion', promotedUrl: specA.url},
      ]);

      // Once A's promoted socket opens, promotionPending clears; the steady-state guard then keeps the
      // now-connected promoted mirror as the single live role.
      socketsFor(specA.url)[1]!.simulateOpen();
      socketB.emitEvent(subB, makePost('another via B', 902));
      expect(callCount(specB.url)).toBe(1); // still not promoted (promotedEntry connected)

      mirrors.close();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fullHorizonNegentropy', () => {
  it('strips the primary incremental `since` and bounds by the display-horizon limit', () => {
    const base: NegentropySyncOptions = {
      subId: 'feed',
      filter: () => ({kinds: [1, 30023], since: 12_345}),
      getItems: () => [],
      fallbackFilter: () => ({kinds: [1, 30023], since: 12_345}),
    };
    const derived = fullHorizonNegentropy(base, [1, 30023], 500);
    const f = typeof derived.filter === 'function' ? derived.filter() : derived.filter;
    expect(f).toEqual({kinds: [1, 30023], limit: 500}); // no `since`
    expect('since' in f).toBe(false);
    expect(derived.fallbackFilter()).toEqual({kinds: [1, 30023], limit: 500});
    expect(derived.getItems).toBe(base.getItems); // reused verbatim (reads the shared store)
    expect(derived.subId).toBe('feed');
  });

  it('preserves an existing cold-cache `limit` (there is no `since` to strip)', () => {
    const base: NegentropySyncOptions = {
      subId: 'feed',
      filter: () => ({kinds: [1], limit: 200}),
      getItems: () => [],
      fallbackFilter: () => ({kinds: [1], limit: 200}),
    };
    const derived = fullHorizonNegentropy(base, [1], 500);
    const f = typeof derived.filter === 'function' ? derived.filter() : derived.filter;
    expect(f).toEqual({kinds: [1], limit: 200}); // the primary's own limit stands, still no `since`
  });

  it('falls back to the provided feedKinds when the base filter carries none', () => {
    const base: NegentropySyncOptions = {
      subId: 'feed',
      filter: () => ({since: 5}) as ReqFilter,
      getItems: () => [],
      fallbackFilter: () => ({since: 5}) as ReqFilter,
    };
    const derived = fullHorizonNegentropy(base, [1, 7, 1111], 300);
    const f = typeof derived.filter === 'function' ? derived.filter() : derived.filter;
    expect(f).toEqual({kinds: [1, 7, 1111], limit: 300});
  });
});
