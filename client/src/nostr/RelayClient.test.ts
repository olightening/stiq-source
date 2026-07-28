import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {
  RelayClient,
  warnKindDrift,
  classifyRejection,
  type NegentropySyncOptions,
  type ReconcileStats,
} from './RelayClient';
import {InMemoryEventStore} from './store';
import {FakeRelaySocket} from './socket.fake';
import {sharedInboundBudget} from './inboundBudget';
import {Negentropy, NegentropyStorage} from './negentropy';
import {defaultRelayCapabilities} from './capabilities';
import {SUBSCRIBED_KINDS, Kind} from '../contracts';
import {clearRecentLogs, getRecentLogs} from '../util/log';

function makePost(content: string, createdAt: number): Event {
  const sk = generateSecretKey();
  getPublicKey(sk);
  return finalizeEvent(
    {kind: 1, created_at: createdAt, tags: [['t', 'general']], content},
    sk,
  );
}

/** A blind post: throwaway-signed and carrying the anti-spam `stiq_token`/`stiq_sig`/`stiq_attr` tags. */
function makeBlindPost(content: string, createdAt: number): Event {
  const sk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1,
      created_at: createdAt,
      tags: [
        ['stiq_token', 'dG9rZW4='],
        ['stiq_sig', 'c2ln'],
        ['stiq_attr', 'YXR0cg=='],
      ],
      content,
    },
    sk,
  );
}

/** A DM gift wrap: kind 1059, no `stiq_token` tag (a normal DM under default config never carries one). */
function makeDmWrap(content: string, createdAt: number): Event {
  const sk = generateSecretKey();
  return finalizeEvent({kind: Kind.GiftWrap, created_at: createdAt, tags: [], content}, sk);
}

/** A transport that exposes torSocket's `openPublishCircuit`, spawning a fresh tracked sibling socket. */
class IsolatingFakeSocket extends FakeRelaySocket {
  readonly siblings: FakeRelaySocket[] = [];
  openPublishCircuit(): FakeRelaySocket {
    const s = new FakeRelaySocket();
    this.siblings.push(s);
    return s;
  }
}

/** Circuit isolation is wired but no dedicated circuit can be built right now (Tor momentarily offline). */
class NullCircuitFakeSocket extends FakeRelaySocket {
  calls = 0;
  openPublishCircuit(): null {
    this.calls++;
    return null;
  }
}

/**
 * A transport whose openPublishCircuit() is scripted call-by-call — each entry is either 'null' (no
 * dedicated circuit could be built this attempt) or 'sibling' (hand back a fresh tracked sibling for
 * the test to drive manually). Exercises RelayClient's bounded fresh-circuit retry loop: each retry
 * MUST call this again for a brand-new sibling, never reusing a prior (failed) one.
 */
class ScriptedPublishCircuitSocket extends FakeRelaySocket {
  readonly siblings: FakeRelaySocket[] = [];
  calls = 0;
  constructor(private readonly script: ReadonlyArray<'null' | 'sibling'>) {
    super();
  }
  openPublishCircuit(): FakeRelaySocket | null {
    const step = this.script[this.calls] ?? 'sibling';
    this.calls++;
    if (step === 'null') return null;
    const sib = new FakeRelaySocket();
    this.siblings.push(sib);
    return sib;
  }
}

/**
 * A socket whose `send()` throws on demand (call `failNextSend()` before the send you want to
 * fail) — simulates the "socket not open yet" moment a send can race, e.g. right after a channel
 * view mounts while Tor is still settling. Every other send behaves exactly like FakeRelaySocket.
 */
class ThrowOnceSocket extends FakeRelaySocket {
  private failNext = false;
  failNextSend(): void {
    this.failNext = true;
  }
  override send(data: string): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('socket not open');
    }
    super.send(data);
  }
}

describe('RelayClient', () => {
  it('subscribes to the configured kinds when the socket opens', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1, 7, 1059]});
    expect(client.isSynced()).toBe(false);
    socket.simulateOpen();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual(['REQ', 'feed', {kinds: [1, 7, 1059]}]);
  });

  it('omits since on a cold cache but applies the configured limit', () => {
    const socket = new FakeRelaySocket();
    new RelayClient(socket, new InMemoryEventStore(), {kinds: [1], limit: 500});
    socket.simulateOpen();
    expect(JSON.parse(socket.sent[0]!)).toEqual(['REQ', 'feed', {kinds: [1], limit: 500}]);
  });

  it('requests only events since the cache high-water mark (minus overlap)', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    store.save(makePost('old', 9_000));
    store.save(makePost('newest', 10_000));
    new RelayClient(socket, store, {kinds: [1], overlapSeconds: 300});
    socket.simulateOpen();
    // since = newest created_at (10_000) - overlap (300) = 9_700
    expect(JSON.parse(socket.sent[0]!)).toEqual(['REQ', 'feed', {kinds: [1], since: 9_700}]);
  });

  it('opens every subscription from a custom plan and syncs once all EOSE', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [
        {subId: 'feed', filter: {kinds: [1, 7]}},
        {subId: 'dm', filter: {kinds: [1059], '#p': ['abc']}},
      ],
    });
    let synced = false;
    client.onSynced(() => (synced = true));
    socket.simulateOpen();
    expect(socket.sent.map(s => JSON.parse(s))).toEqual([
      ['REQ', 'feed', {kinds: [1, 7]}],
      ['REQ', 'dm', {kinds: [1059], '#p': ['abc']}],
    ]);
    socket.emitEose('feed');
    expect(synced).toBe(false); // dm still pending
    socket.emitEose('dm');
    expect(synced).toBe(true);
  });

  it('surfaces a SCOPED sub’s EOSE via onScopedEose without touching plan-sync state (Phase 5)', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [{subId: 'feed', filter: {kinds: [1]}}],
    });
    const scopedEoses: string[] = [];
    let synced = false;
    client.onScopedEose(subId => scopedEoses.push(subId));
    client.onSynced(() => (synced = true));
    socket.simulateOpen();

    client.subscribeScoped('channel:ch1', [{kinds: [1311], '#a': ['ch1']}]);

    // The scoped sub's stored-history replay finishes: the scoped listener fires with the sub id…
    socket.emitEose('channel:ch1');
    expect(scopedEoses).toEqual(['channel:ch1']);
    // …and it must NOT count toward the plan's own synced state (feed hasn't EOSE'd yet).
    expect(synced).toBe(false);

    // The plan's own EOSE is consumed by the sync machinery, never surfaced as a scoped one.
    socket.emitEose('feed');
    expect(synced).toBe(true);
    expect(scopedEoses).toEqual(['channel:ch1']);

    // An unknown/closed sub id never fires the scoped listener.
    socket.emitEose('never-opened');
    expect(scopedEoses).toEqual(['channel:ch1']);
  });

  it('validates, dedupes, caches, and notifies on real signed events', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store);
    const received: string[] = [];
    client.onEvent(e => received.push(e.id));

    socket.simulateOpen();
    const post = makePost('hello over tor', 1000);
    socket.emitEvent('feed', post);
    socket.emitEvent('feed', post); // duplicate

    expect(store.size()).toBe(1);
    expect(received).toEqual([post.id]);
  });

  it('fires onSeen for every received event including duplicate echoes', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store);
    const seen: string[] = [];
    const stored: string[] = [];
    client.onSeen(e => seen.push(e.id));
    client.onEvent(e => stored.push(e.id));

    socket.simulateOpen();
    const post = makePost('echo of our own write', 1000);
    socket.emitEvent('feed', post);
    socket.emitEvent('feed', post); // duplicate — e.g. relay echoing our optimistic write back

    // onEvent dedupes (store changed once); onSeen fires for BOTH so echo-confirmation works
    // even though the event is already in the store.
    expect(stored).toEqual([post.id]);
    expect(seen).toEqual([post.id, post.id]);
  });

  it('drops events with a forged signature', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store);
    socket.simulateOpen();

    const valid = makePost('hello', 1000);
    // Build a fresh object (no spread) so nostr-tools' cached "verified" flag is not
    // carried over, then give it an invalid signature.
    const forged: Event = {
      id: valid.id,
      pubkey: valid.pubkey,
      created_at: valid.created_at,
      kind: valid.kind,
      tags: valid.tags,
      content: valid.content,
      sig: '00'.repeat(64),
    };
    client.ingest(forged);

    expect(store.size()).toBe(0);
  });

  it('dedupes a known id BEFORE verifying, but still fires onSeen (echo-confirmation)', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const post = makePost('optimistic write echoed by relay', 1000);
    store.save(post); // e.g. saved optimistically on publish, before the relay echoes it back

    let verifyCalls = 0;
    const client = new RelayClient(socket, store, {
      verify: () => {
        verifyCalls++;
        return true;
      },
    });
    const seen: string[] = [];
    const stored: string[] = [];
    client.onSeen(e => seen.push(e.id));
    client.onEvent(e => stored.push(e.id));

    socket.simulateOpen();
    socket.emitEvent('feed', post); // relay echo of an event already in the store

    // Signature verification is SKIPPED for the known id (its stored copy was verified on first
    // sight) — the whole point of dedupe-before-verify.
    expect(verifyCalls).toBe(0);
    // But onSeen still fires so optimistic-write echo-confirmation / liveness keep working, while
    // onEvent (store-changing) does not, matching the prior store.save()-dedupe behaviour.
    expect(seen).toEqual([post.id]);
    expect(stored).toEqual([]);
    expect(store.size()).toBe(1);
  });

  it('verifies exactly once for a genuinely new id, then skips re-verify on the echo', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    let verifyCalls = 0;
    // eslint-disable-next-line no-new -- constructor wires socket.onMessage; driven via the socket
    new RelayClient(socket, store, {
      verify: () => {
        verifyCalls++;
        return true;
      },
    });
    socket.simulateOpen();

    const post = makePost('new then echoed', 1000);
    socket.emitEvent('feed', post); // first sight — must verify
    socket.emitEvent('feed', post); // duplicate — must NOT re-verify (now in store)
    socket.emitEvent('feed', post); // and again

    expect(verifyCalls).toBe(1);
    expect(store.size()).toBe(1);
  });

  it('never stores an unverified event even when its id is unknown', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    // Fails verification: the security invariant is that an unknown id must be verified before store.
    const client = new RelayClient(socket, store, {verify: () => false});
    const stored: string[] = [];
    const seen: string[] = [];
    client.onEvent(e => stored.push(e.id));
    client.onSeen(e => seen.push(e.id));
    socket.simulateOpen();

    socket.emitEvent('feed', makePost('forged', 1000));

    expect(store.size()).toBe(0);
    expect(stored).toEqual([]);
    expect(seen).toEqual([]); // an unverified unknown id fires NOTHING
  });

  it('marks synced on EOSE', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    let synced = false;
    client.onSynced(() => (synced = true));
    socket.simulateOpen();
    expect(client.isSynced()).toBe(false);
    socket.emitEose('feed');
    expect(synced).toBe(true);
    expect(client.isSynced()).toBe(true);
  });

  it('serves the feed from cache after going offline', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store);
    socket.simulateOpen();
    socket.emitEvent('feed', makePost('older', 1000));
    socket.emitEvent('feed', makePost('newer', 2000));

    // Connection drops.
    client.close();
    expect(socket.closed).toBe(true);

    // Feed still readable from cache, newest first.
    const cached = client.cachedPosts();
    expect(cached.map(e => e.content)).toEqual(['newer', 'older']);
  });

  it('publishes an event and resolves with the OK frame, caching on accept', async () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makePost('publish me', 5000);
    const pending = client.publish(event);
    socket.emit(JSON.stringify(['OK', event.id, true, 'stored']));

    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(store.has(event.id)).toBe(true); // optimistic local cache
    // The EVENT frame was actually sent.
    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);
  });

  it('reports a rejected publish and does not cache it', async () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makePost('blocked', 5000);
    const pending = client.publish(event);
    socket.emit(JSON.stringify(['OK', event.id, false, 'blocked: not a member']));

    const result = await pending;
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/not a member/);
    expect(store.has(event.id)).toBe(false);
  });

  // ── Anonymity finding #1: a blind post's EVENT must ride its own Tor circuit, never the socket
  //    that carries identity-scoped REQs (DM #p:[myNpub], self-lists, group subs). ──
  it('routes a blind publish over a dedicated sibling circuit, not the shared feed socket', async () => {
    const socket = new IsolatingFakeSocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen(); // the feed subscription (identity-scoped REQs) opens on the shared socket
    const feedSends = socket.sent.length;

    const event = makeBlindPost('anon note', 5000);
    const pending = client.publish(event);

    // The EVENT frame must NOT touch the shared (identity) socket.
    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(false);
    expect(socket.sent.length).toBe(feedSends);
    expect(socket.siblings).toHaveLength(1);

    const sib = socket.siblings[0]!;
    sib.simulateOpen(); // the dedicated circuit connects → the queued EVENT is sent HERE
    expect(sib.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);

    sib.emit(JSON.stringify(['OK', event.id, true, 'stored']));
    const result = await pending;

    expect(result.accepted).toBe(true);
    expect(store.has(event.id)).toBe(true); // cached optimistically on accept, like the shared path
    expect(sib.closed).toBe(true); // dedicated circuit torn down after the publish
  });

  it('publishes a blind post on the shared socket when the transport lacks circuit isolation', async () => {
    const socket = new FakeRelaySocket(); // plain fake: no openPublishCircuit
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makeBlindPost('anon note', 5000);
    const pending = client.publish(event);
    // Falls back to the shared socket (behaviour unchanged when isolation is unavailable).
    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);
    socket.emit(JSON.stringify(['OK', event.id, true, 'stored']));

    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(store.has(event.id)).toBe(true);
  });

  it('keeps a normal (non-blind) publish on the shared socket even when isolation is available', async () => {
    const socket = new IsolatingFakeSocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makePost('hello', 5000); // no stiq_token tag → not a blind post
    const pending = client.publish(event);
    expect(socket.siblings).toHaveLength(0); // no dedicated circuit spun up
    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);
    socket.emit(JSON.stringify(['OK', event.id, true, 'stored']));

    const result = await pending;
    expect(result.accepted).toBe(true);
  });

  // ── finding #dms: a DM gift wrap (kind 1059, no `stiq_token` under default config) gets the SAME
  //    isolated-circuit treatment as a blind post — off the identity-scoped shared socket, and onto
  //    the fast bounded fresh-circuit retry ladder, instead of one 60s shared-socket wait. ──
  it('routes a DM gift wrap over a dedicated sibling circuit, not the shared feed socket', async () => {
    const socket = new IsolatingFakeSocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen(); // the DM REQ (identity-scoped, '#p:[myNpub]') opens on the shared socket
    const feedSends = socket.sent.length;

    const event = makeDmWrap('sealed rumor', 5000);
    const pending = client.publish(event);

    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(false);
    expect(socket.sent.length).toBe(feedSends);
    expect(socket.siblings).toHaveLength(1);

    const sib = socket.siblings[0]!;
    sib.simulateOpen();
    expect(sib.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);

    sib.emit(JSON.stringify(['OK', event.id, true, 'stored']));
    const result = await pending;

    expect(result.accepted).toBe(true);
    expect(store.has(event.id)).toBe(true);
    expect(sib.closed).toBe(true); // dedicated circuit torn down after the publish
  });

  it('publishes a DM gift wrap on the shared socket when the transport lacks circuit isolation', async () => {
    const socket = new FakeRelaySocket(); // plain fake: no openPublishCircuit — behavior unchanged
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makeDmWrap('sealed rumor', 5000);
    const pending = client.publish(event);
    expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(true);
    socket.emit(JSON.stringify(['OK', event.id, true, 'stored']));

    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(store.has(event.id)).toBe(true);
  });

  it('reports a blind publish as offline (queued, never leaked) after exhausting every circuit retry', async () => {
    jest.useFakeTimers();
    try {
      const socket = new NullCircuitFakeSocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
      socket.simulateOpen();

      const event = makeBlindPost('anon note', 5000);
      const pending = client.publish(event);

      await jest.advanceTimersByTimeAsync(0); // attempt 1: no circuit right now (immediate)
      await jest.advanceTimersByTimeAsync(800); // attempt 2, after the first backoff
      await jest.advanceTimersByTimeAsync(1_500); // attempt 3, after the second backoff

      const result = await pending;

      expect(result.accepted).toBe(false);
      expect(result.offline).toBe(true); // caller keeps it queued + retries; does not mark it failed
      // All 3 attempts were spent (never gives up after one miss, never hangs past the cap).
      expect(socket.calls).toBe(3);
      // Crucially, it was never sent on the shared identity socket, and not cached (not accepted).
      expect(socket.sent.some(s => s.startsWith('["EVENT"'))).toBe(false);
      expect(store.has(event.id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces a relay rejection on the dedicated circuit as a genuine failure, not a retry', async () => {
    const socket = new IsolatingFakeSocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
    socket.simulateOpen();

    const event = makeBlindPost('blocked', 5000);
    const pending = client.publish(event);
    const sib = socket.siblings[0]!;
    sib.simulateOpen();
    sib.emit(JSON.stringify(['OK', event.id, false, 'blocked: spent token']));

    const result = await pending;
    expect(result.accepted).toBe(false);
    expect(result.offline).toBeFalsy(); // a policy rejection is permanent — not an offline retry
    expect(store.has(event.id)).toBe(false);
    expect(sib.closed).toBe(true);
    expect(socket.siblings).toHaveLength(1); // a terminal rejection is NEVER retried
  });

  // ── Bounded fresh-circuit retry (fixes "posts not posting anywhere" under a flaky Tor network):
  //    a TRANSIENT miss (no circuit / timeout / closed-before-OK) retries on a BRAND NEW isolated
  //    circuit up to MAX_PUBLISH_CIRCUIT_ATTEMPTS times; a genuine relay REJECTION never retries. ──
  describe('publishIsolated bounded fresh-circuit retry', () => {
    it('succeeds on the very first attempt without retrying', async () => {
      const socket = new ScriptedPublishCircuitSocket(['sibling']);
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
      socket.simulateOpen();

      const event = makeBlindPost('anon note', 5000);
      const pending = client.publish(event);
      const sib = socket.siblings[0]!;
      sib.simulateOpen();
      sib.emit(JSON.stringify(['OK', event.id, true, 'stored']));

      const result = await pending;
      expect(result.accepted).toBe(true);
      expect(socket.calls).toBe(1);
    });

    it('retries on a brand-new circuit after transient misses, succeeding on the 3rd attempt', async () => {
      jest.useFakeTimers();
      try {
        // Attempt 1: no circuit available at all. Attempt 2: a circuit that dies before the OK.
        // Attempt 3: a circuit that opens and OKs.
        const socket = new ScriptedPublishCircuitSocket(['null', 'sibling', 'sibling']);
        const store = new InMemoryEventStore();
        const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
        socket.simulateOpen();

        const event = makeBlindPost('anon note', 5000);
        const pending = client.publish(event);

        await jest.advanceTimersByTimeAsync(0); // attempt 1 settles immediately (offline)
        expect(socket.calls).toBe(1);

        await jest.advanceTimersByTimeAsync(800); // fires attempt 2 after the first backoff
        expect(socket.calls).toBe(2);
        const sib2 = socket.siblings[0]!;
        sib2.close(); // dies before ever opening — transient, not a rejection

        await jest.advanceTimersByTimeAsync(1_500); // fires attempt 3 after the second backoff
        expect(socket.calls).toBe(3);
        const sib3 = socket.siblings[1]!;
        sib3.simulateOpen();
        sib3.emit(JSON.stringify(['OK', event.id, true, 'stored']));

        const result = await pending;
        expect(result.accepted).toBe(true);
        expect(socket.calls).toBe(3); // exactly 3 dedicated circuits opened — never more, never fewer
        expect(store.has(event.id)).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not retry a genuine relay rejection even mid-way through the attempt budget', async () => {
      // Only one entry: if the retry loop wrongly treated a rejection as transient, the second
      // openPublishCircuit() call would fall through to the 'sibling' default and this test would
      // still (wrongly) pass — so the assertion on `calls` below is what actually pins "not retried".
      const socket = new ScriptedPublishCircuitSocket(['sibling']);
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
      socket.simulateOpen();

      const event = makeBlindPost('blocked', 5000);
      const pending = client.publish(event);
      const sib = socket.siblings[0]!;
      sib.simulateOpen();
      sib.emit(JSON.stringify(['OK', event.id, false, 'blocked: spent token']));

      const result = await pending;
      expect(result.accepted).toBe(false);
      expect(result.offline).toBeFalsy(); // terminal rejection, not a queued retry
      expect(socket.calls).toBe(1);
    });
  });

  // ── finding #dms: nothing else in the app notices a shared socket that stays open but stops
  //    answering publishes — publishShared()'s own timeout never touches the transport, the app's
  //    connection watchdog is one-shot, and the native layer keeps auto-answering server pings
  //    regardless. Bounded stall detection closes forces the issue after TWO consecutive misses with
  //    nothing landing in between, handing recovery to the existing reconnect + outbox walk. ──
  describe('bounded shared-socket stall detection', () => {
    it('does not close the socket after a single publish timeout', async () => {
      jest.useFakeTimers();
      try {
        const socket = new FakeRelaySocket();
        const client = new RelayClient(socket, new InMemoryEventStore(), {publishTimeoutMs: 1000});
        socket.simulateOpen();

        const event = makePost('one stall', 5000);
        const pending = client.publish(event);
        await jest.advanceTimersByTimeAsync(1000);
        const result = await pending;

        expect(result.accepted).toBe(false);
        expect(socket.closed).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('force-closes the shared socket after two consecutive publish timeouts with no OK in between', async () => {
      jest.useFakeTimers();
      try {
        const socket = new FakeRelaySocket();
        const client = new RelayClient(socket, new InMemoryEventStore(), {publishTimeoutMs: 1000});
        socket.simulateOpen();

        const first = client.publish(makePost('first stall', 5000));
        await jest.advanceTimersByTimeAsync(1000);
        await first;
        expect(socket.closed).toBe(false); // one miss alone is never enough

        const second = client.publish(makePost('second stall', 5001));
        await jest.advanceTimersByTimeAsync(1000);
        await second;
        expect(socket.closed).toBe(true); // two in a row, nothing in between → treated as suspect
      } finally {
        jest.useRealTimers();
      }
    });

    it('resets the stall streak when an OK lands between two timeouts, so the socket stays open', async () => {
      jest.useFakeTimers();
      try {
        const socket = new FakeRelaySocket();
        const client = new RelayClient(socket, new InMemoryEventStore(), {publishTimeoutMs: 1000});
        socket.simulateOpen();

        const first = client.publish(makePost('stall one', 5000));
        await jest.advanceTimersByTimeAsync(1000);
        await first;
        expect(socket.closed).toBe(false);

        // A second publish lands successfully in between — proves the socket is still answering and
        // resets the streak.
        const okEvent = makePost('lands fine', 5001);
        const landed = client.publish(okEvent);
        socket.emit(JSON.stringify(['OK', okEvent.id, true, 'stored']));
        await landed;

        const third = client.publish(makePost('stall two', 5002));
        await jest.advanceTimersByTimeAsync(1000);
        await third;
        expect(socket.closed).toBe(false); // streak was reset — this is only the FIRST timeout again
      } finally {
        jest.useRealTimers();
      }
    });

    it('resets the stall streak on any EVENT frame between two timeouts, so the socket stays open', async () => {
      jest.useFakeTimers();
      try {
        const socket = new FakeRelaySocket();
        const store = new InMemoryEventStore();
        const client = new RelayClient(socket, store, {publishTimeoutMs: 1000});
        socket.simulateOpen();

        const first = client.publish(makePost('stall one', 5000));
        await jest.advanceTimersByTimeAsync(1000);
        await first;
        expect(socket.closed).toBe(false);

        // Ordinary feed traffic arrives on the standing REQ — the socket is clearly still alive.
        socket.emitEvent('feed', makePost('unrelated live post', 5002));

        const second = client.publish(makePost('stall two', 5001));
        await jest.advanceTimersByTimeAsync(1000);
        await second;
        expect(socket.closed).toBe(false); // streak was reset by the EVENT frame — not suspect (yet)
      } finally {
        jest.useRealTimers();
      }
    });

    it('never closes a healthy socket that has no publishes in flight at all', () => {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      new RelayClient(socket, store, {kinds: [1]});
      socket.simulateOpen();
      for (let i = 0; i < 10; i++) socket.emitEvent('feed', makePost(`live-${i}`, 5000 + i));
      expect(socket.closed).toBe(false);
    });

    it('a successfully-accepted publish never counts toward the stall streak', async () => {
      jest.useFakeTimers();
      try {
        const socket = new FakeRelaySocket();
        const client = new RelayClient(socket, new InMemoryEventStore(), {publishTimeoutMs: 1000});
        socket.simulateOpen();

        // Two publishes in a row, both accepted immediately (no timeout ever fires) — never suspect.
        for (let i = 0; i < 2; i++) {
          const event = makePost(`ok-${i}`, 5000 + i);
          const pending = client.publish(event);
          socket.emit(JSON.stringify(['OK', event.id, true, 'stored']));
          await pending;
        }
        expect(socket.closed).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('cooperatively drains inbound frames in bounded JS-thread batches', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      new RelayClient(socket, store, {
        inboundBatchSize: 2,
        inboundTimeSliceMs: 1_000,
      });
      socket.simulateOpen();
      const posts = Array.from({length: 5}, (_, i) => makePost(`queued-${i}`, i + 1));
      posts.forEach(post => socket.emitEvent('feed', post));

      expect(store.size()).toBe(0); // native callbacks only enqueue
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(2);
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(4);
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still drains one event per tick when the shared inbound budget is already exhausted (I3 no-starvation)', () => {
    jest.useFakeTimers();
    try {
      // `sharedInboundBudget` is a MODULE-LEVEL singleton, so it can carry a window opened by an
      // earlier test in this file. Jump the fake clock comfortably ahead of "real now" (rather
      // than pin it to some small fixed constant) so this always lands in a BRAND NEW window no
      // matter what an earlier test left behind — real wall-clock time only moves forward across
      // sequential test execution, so this is always further ahead than any prior window's start.
      const now = Date.now() + 60_000;
      jest.setSystemTime(now);
      // Simulate the shared cross-client pool already spent this window — e.g. by another live
      // mirror secondary's own drain tick moments earlier (I3).
      sharedInboundBudget.remaining(now); // opens/rolls the window at `now`
      sharedInboundBudget.charge(1_000); // far more than one window ever allows

      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      new RelayClient(socket, store, {inboundBatchSize: 5});
      socket.simulateOpen();
      const posts = Array.from({length: 3}, (_, i) => makePost(`starve-${i}`, i + 1));
      posts.forEach(post => socket.emitEvent('feed', post));

      expect(store.size()).toBe(0);
      // Forward-progress guarantee: even with the shared pool fully spent, EVERY tick still
      // processes exactly one event rather than wedging this client's queue.
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(1);
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(2);
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends a drain tick early once cumulative frame bytes cross the byte cap (I6)', () => {
    jest.useFakeTimers();
    try {
      // Jump the fake clock well past "real now" — and past the no-starvation test's own window
      // above — so the shared budget rolls over to a fresh, fully-refilled window here; this
      // test's result then depends ONLY on the byte cap, never on shared-budget window overlap.
      jest.setSystemTime(Date.now() + 120_000);

      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      // Generous batch size so the byte cap — not the event-count cap — is what ends the tick.
      new RelayClient(socket, store, {inboundBatchSize: 10});
      socket.simulateOpen();

      // Each frame's raw JSON is ~150KB (content dominates frame length): two of them already
      // cross the 256KB per-tick cap, so the 3rd/4th must roll to a later tick even though
      // inboundBatchSize (10) has plenty of headroom left.
      const big = 'x'.repeat(150 * 1_024);
      const posts = Array.from({length: 4}, (_, i) => makePost(big, i + 1));
      posts.forEach(post => socket.emitEvent('feed', post));

      expect(store.size()).toBe(0);
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(2); // byte cap crossed after the 2nd frame
      jest.runOnlyPendingTimers();
      expect(store.size()).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('self-terminates a tick mid-batch once per-event charging exhausts the shared budget (P2-1)', () => {
    jest.useFakeTimers();
    let dateNowSpy: jest.SpyInstance<number, []> | undefined;
    let base: number | undefined;
    try {
      // Baseline reads the fake clock's current "now" BEFORE Date.now is scripted below, then jumps
      // well past every other test's window (same pattern as the byte-cap test above) so this test's
      // result depends ONLY on budget accounting, never on shared-budget window overlap.
      base = Date.now() + 240_000;
      sharedInboundBudget.remaining(base); // opens/rolls a fresh, fully-refilled window at `base`

      // Script Date.now() so each processed event "costs" 6ms of simulated JS time: event 1 always
      // runs (forward-progress bypass) and is charged 6ms (pool: 4ms left of the 10ms budget);
      // event 2's pre-charge `remaining()` check still sees 4ms > 0 so it also runs, and is itself
      // charged another 6ms (pool: spent 12ms, over budget) — event 3's `remaining()` check must
      // then see the pool exhausted and stop the loop, all inside this FIRST tick. Every call past
      // the scripted ones clamps to the last (base + 12) so the following tick's own bookkeeping
      // stays inert. This is only possible because charging now happens per-event, inside the loop,
      // instead of once at tick end (B4) — under tick-end-only charging every event here would still
      // run in the same tick.
      const schedule = [base, base + 6, base + 6, base + 12, base + 12, base + 12];
      let call = 0;
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        const value = schedule[Math.min(call, schedule.length - 1)]!;
        call++;
        return value;
      });

      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      // Generous batch size so it's the shared budget — not inboundBatchSize — that ends the tick.
      new RelayClient(socket, store, {inboundBatchSize: 5});
      socket.simulateOpen();
      const posts = Array.from({length: 3}, (_, i) => makePost(`budget-${i}`, i + 1));
      posts.forEach(post => socket.emitEvent('feed', post));

      expect(store.size()).toBe(0);
      jest.runOnlyPendingTimers();
      // Mid-batch self-termination: only 2 of the 3 queued events land in this tick even though
      // inboundBatchSize (5) has plenty of headroom — the shared budget, charged per-event as it's
      // spent, stopped the loop before the 3rd.
      expect(store.size()).toBe(2);
      jest.runOnlyPendingTimers();
      // Forward-progress guarantee still holds: the deferred 3rd event lands on the very next tick
      // regardless of the (still-exhausted) pool.
      expect(store.size()).toBe(3);
    } finally {
      dateNowSpy?.mockRestore();
      // `sharedInboundBudget` is a MODULE-LEVEL singleton (see the no-starvation test above) — leaving
      // it deliberately exhausted at `base` would otherwise wedge every later test in this file that
      // doesn't itself roll the window (their un-mocked Date.now() never reaches `base` again within
      // a real-time test run), so roll it forward past `base` to a fresh, fully-refilled window here.
      if (base !== undefined) sharedInboundBudget.remaining(base + 32);
      jest.useRealTimers();
    }
  });

  it('fires onIngestEvent once per event that passes ingest, from within the SAME paced drain', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const warmed: string[] = [];
      new RelayClient(socket, store, {
        inboundBatchSize: 2,
        inboundTimeSliceMs: 1_000,
        onIngestEvent: e => warmed.push(e.id),
      });
      socket.simulateOpen();
      const posts = Array.from({length: 5}, (_, i) => makePost(`queued-${i}`, i + 1));
      posts.forEach(post => socket.emitEvent('feed', post));

      // The hook must fire IN STEP with the paced drain — not all at once, not from a separate
      // scheduler — so it lands 2-per-tick exactly like the store writes above.
      expect(warmed).toEqual([]);
      jest.runOnlyPendingTimers();
      expect(warmed).toEqual(posts.slice(0, 2).map(p => p.id));
      jest.runOnlyPendingTimers();
      expect(warmed).toEqual(posts.slice(0, 4).map(p => p.id));
      jest.runOnlyPendingTimers();
      expect(warmed).toEqual(posts.map(p => p.id));
    } finally {
      jest.useRealTimers();
    }
  });

  it('never fires onIngestEvent for an event rejected by the kind gate or a forged signature', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const warmed: string[] = [];
    const client = new RelayClient(socket, store, {kinds: [1], onIngestEvent: e => warmed.push(e.id)});
    socket.simulateOpen();

    // Wrong kind (0 = Metadata; not in `kinds: [1]` and not a NIP-29 GROUP_KINDS exception either).
    const wrongKind = finalizeEvent({kind: 0, created_at: 1000, tags: [], content: '{}'}, generateSecretKey());
    client.ingest(wrongKind);
    expect(warmed).toEqual([]);

    // Forged signature — rejected before the hook could ever fire. Built fresh (no spread) so
    // nostr-tools' cached "verified" flag from `valid` isn't carried over (mirrors the test above).
    const valid = makePost('hello', 1000);
    const forged: Event = {
      id: valid.id,
      pubkey: valid.pubkey,
      created_at: valid.created_at,
      kind: valid.kind,
      tags: valid.tags,
      content: valid.content,
      sig: '00'.repeat(64),
    };
    client.ingest(forged);
    expect(warmed).toEqual([]);
  });

  it('fires onIngestEvent for an already-known duplicate too (it passed ingest on first sight)', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const post = makePost('already stored', 1000);
    store.save(post); // e.g. persisted from a prior session, or saved optimistically on publish
    const warmed: string[] = [];
    const client = new RelayClient(socket, store, {onIngestEvent: e => warmed.push(e.id)});
    client.ingest(post);
    expect(warmed).toEqual([post.id]);
  });

  it('paginates stored history without replacing the root live subscription', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {
        plan: () => [{
          subId: 'history',
          filter: {kinds: [1]},
          pagination: {pageSize: 2, delayMs: 10},
        }],
      });
      let synced = false;
      client.onSynced(() => (synced = true));
      socket.simulateOpen();
      expect(JSON.parse(socket.sent[0]!)).toEqual(['REQ', 'history', {kinds: [1], limit: 2}]);

      socket.emitEvent('history', makePost('newest', 500));
      socket.emitEvent('history', makePost('next', 400));
      socket.emitEose('history');
      expect(synced).toBe(false);

      jest.advanceTimersByTime(10);
      let pageReqs = socket.sent
        .map(s => JSON.parse(s))
        .filter(f => f[0] === 'REQ' && String(f[1]).startsWith('page:history:'));
      expect(pageReqs[0]).toEqual([
        'REQ',
        'page:history:1',
        {kinds: [1], limit: 2, until: 400},
      ]);

      socket.emitEvent('page:history:1', makePost('older', 300));
      socket.emitEvent('page:history:1', makePost('older still', 200));
      socket.emitEose('page:history:1');
      jest.advanceTimersByTime(10);
      pageReqs = socket.sent
        .map(s => JSON.parse(s))
        .filter(f => f[0] === 'REQ' && String(f[1]).startsWith('page:history:'));
      expect(pageReqs[1]).toEqual([
        'REQ',
        'page:history:2',
        {kinds: [1], limit: 2, until: 200},
      ]);

      socket.emitEvent('page:history:2', makePost('oldest', 100));
      socket.emitEose('page:history:2'); // short final page: pagination is complete
      expect(synced).toBe(true);
      expect(store.size()).toBe(5);
      expect(socket.sent.map(s => JSON.parse(s))).not.toContainEqual(['CLOSE', 'history']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('widens a saturated timestamp boundary instead of skipping same-second events', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      new RelayClient(socket, new InMemoryEventStore(), {
        plan: () => [{
          subId: 'history',
          filter: {kinds: [1]},
          pagination: {pageSize: 2, delayMs: 1},
        }],
      });
      const a = makePost('same-second-a', 500);
      const b = makePost('same-second-b', 500);
      socket.simulateOpen();
      socket.emitEvent('history', a);
      socket.emitEvent('history', b);
      socket.emitEose('history');
      jest.advanceTimersByTime(1);

      // The inclusive boundary deliberately repeats these two events on the first older page.
      socket.emitEvent('page:history:1', a);
      socket.emitEvent('page:history:1', b);
      socket.emitEose('page:history:1');
      jest.advanceTimersByTime(1);

      const requests = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(requests).toContainEqual([
        'REQ',
        'page:history:2',
        {kinds: [1], limit: 4, until: 500},
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RelayClient CLOSED/NOTICE frames', () => {
  it('a CLOSED sub is removed from pending tracking and drives markSynced when it was the last one', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    let synced = false;
    client.onSynced(() => (synced = true));
    socket.simulateOpen();
    expect(client.isSynced()).toBe(false);

    // The relay refuses the sub (e.g. NIP-42 auth-required) instead of ever sending an EOSE. Without
    // CLOSED handling this sub stays in pendingSubs forever and onSynced never fires (the hang this
    // fix closes).
    socket.emit(JSON.stringify(['CLOSED', 'feed', 'auth-required: please authenticate']));

    expect(synced).toBe(true);
    expect(client.isSynced()).toBe(true);
  });

  it('a CLOSED sub only drives markSynced once every other pending sub has also settled', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [
        {subId: 'feed', filter: {kinds: [1]}},
        {subId: 'dm', filter: {kinds: [1059]}},
      ],
    });
    let synced = false;
    client.onSynced(() => (synced = true));
    socket.simulateOpen();

    socket.emit(JSON.stringify(['CLOSED', 'dm', 'restricted: not a member']));
    expect(synced).toBe(false); // feed is still pending

    socket.emitEose('feed');
    expect(synced).toBe(true);
  });

  it('a subsequent EVENT for a CLOSED sub id is ignored (the sub was dropped from knownSubIds)', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {kinds: [1]});
    const received: string[] = [];
    client.onEvent(e => received.push(e.id));
    socket.simulateOpen();

    socket.emit(JSON.stringify(['CLOSED', 'feed', 'auth-required: please authenticate']));
    const post = makePost('after close', 1000);
    socket.emitEvent('feed', post);

    expect(received).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('emits a structured sub-error to onSubError listeners for a CLOSED frame', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    const errors: {subId: string; message: string}[] = [];
    client.onSubError(err => errors.push(err));
    socket.simulateOpen();

    socket.emit(JSON.stringify(['CLOSED', 'feed', 'auth-required: please authenticate']));

    expect(errors).toEqual([{subId: 'feed', message: 'auth-required: please authenticate'}]);
  });

  it('onSubError unsubscribe stops further delivery', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [
        {subId: 'feed', filter: {kinds: [1]}},
        {subId: 'dm', filter: {kinds: [1059]}},
      ],
    });
    const errors: {subId: string; message: string}[] = [];
    const unsub = client.onSubError(err => errors.push(err));
    socket.simulateOpen();
    socket.emit(JSON.stringify(['CLOSED', 'feed', 'first']));
    unsub();
    socket.emit(JSON.stringify(['CLOSED', 'dm', 'second']));

    expect(errors).toEqual([{subId: 'feed', message: 'first'}]);
  });

  it('a NOTICE frame is delivered to onNotice listeners instead of being silently dropped', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    const notices: string[] = [];
    client.onNotice(n => notices.push(n));
    socket.simulateOpen();

    socket.emit(JSON.stringify(['NOTICE', 'rate-limited: slow down']));

    expect(notices).toEqual(['rate-limited: slow down']);
  });

  it('a NOTICE frame does not disturb sub tracking or throw', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    let synced = false;
    client.onSynced(() => (synced = true));
    socket.simulateOpen();

    expect(() => socket.emit(JSON.stringify(['NOTICE', 'just fyi']))).not.toThrow();
    expect(synced).toBe(false); // feed sub still pending — untouched by the NOTICE

    socket.emitEose('feed');
    expect(synced).toBe(true);
  });
});

describe('classifyRejection — relay OK-frame reason → {code, retryable} (C3)', () => {
  it('maps every known PERMANENT prefix to non-retryable', () => {
    // These will never succeed on a re-send of the SAME signed event, so they must stay terminal.
    expect(classifyRejection('blocked: banned author')).toEqual({code: 'blocked', retryable: false});
    expect(classifyRejection('invalid: bad signature')).toEqual({code: 'invalid', retryable: false});
    expect(classifyRejection('auth-required: please authenticate')).toEqual({
      code: 'auth-required',
      retryable: false,
    });
    expect(classifyRejection('restricted: not a member')).toEqual({code: 'restricted', retryable: false});
    // Same event carries the same insufficient PoW — re-sending just re-rejects.
    expect(classifyRejection('pow: 24 bits needed')).toEqual({code: 'pow', retryable: false});
  });

  it('maps every known TRANSIENT class to retryable', () => {
    expect(classifyRejection('rate-limited: slow down').retryable).toBe(true);
    expect(classifyRejection('error: too many events').retryable).toBe(true);
    expect(classifyRejection('please slow down').retryable).toBe(true);
    expect(classifyRejection('try again later').retryable).toBe(true);
    expect(classifyRejection('temporarily unavailable').retryable).toBe(true);
    // The relay already holds this event — a retry harmlessly de-dupes rather than fails terminally.
    expect(classifyRejection('duplicate: have this event').retryable).toBe(true);
  });

  it('defaults an UNKNOWN / unclassified reason to non-retryable (preserves B1 terminal-rejected)', () => {
    expect(classifyRejection('some brand new relay message')).toEqual({code: 'unknown', retryable: false});
    expect(classifyRejection('')).toEqual({code: 'unknown', retryable: false});
    expect(classifyRejection('mystery: not a known code')).toEqual({code: 'mystery', retryable: false});
  });

  it('lets a PERMANENT prefix win even when its human text contains a transient phrase', () => {
    // 'blocked:' is a policy block; the trailing "too many tags" must NOT flip it to retryable.
    expect(classifyRejection('blocked: too many tags')).toEqual({code: 'blocked', retryable: false});
  });

  // ── The relay's ACTUAL wire format is "[code] human text", not a bare "code:" prefix — the bare
  //    regex alone never matched it, so every real rejection fell through to the non-retryable
  //    default. These pin the bracket-aware parse against the relay's real prose. ──
  describe('bracketed "[code] message" format (the relay\'s actual OK-frame reason shape)', () => {
    it('extracts the bracketed code and still honors the permanent prefix in the trailing text', () => {
      expect(
        classifyRejection('[token_required] blocked: this community requires a posting token'),
      ).toEqual({code: 'token_required', retryable: false});
    });

    it('treats a transient relay-side storage failure recording the blind token as retryable', () => {
      expect(classifyRejection('[record_token_error] error: could not record token').retryable).toBe(
        true,
      );
    });

    it('treats a transient relay-side storage failure recording membership as retryable', () => {
      expect(
        classifyRejection('[record_membership_error] error: could not record membership').retryable,
      ).toBe(true);
    });

    it('parses the [too_many_tags] bracket code and stays non-retryable (no transient-substring flip)', () => {
      // The "too many tags" prose contains the transient substring "too many"; the bracket code is now
      // returned, and the permanent "blocked:" prefix keeps it terminal for the SAME signed event.
      expect(classifyRejection('[too_many_tags] blocked: too many tags (3, max 2)')).toEqual({
        code: 'too_many_tags',
        retryable: false,
      });
    });

    // Regression: none of the existing bare-prefix / no-prefix shapes may change behaviour.
    it('regression: bare-prefix and plain-prose reasons classify exactly as before', () => {
      expect(classifyRejection('rate-limited: slow down').retryable).toBe(true);
      expect(classifyRejection('blocked: banned').retryable).toBe(false);
      expect(classifyRejection('invalid: bad sig').retryable).toBe(false);
      expect(classifyRejection('nope').retryable).toBe(false);
    });
  });
});

describe('RelayClient resyncFeed — legacy path (no negentropy configured for this connection)', () => {
  // A cold-cache connect now omits `negentropy` entirely (see App.tsx), which makes this path
  // reachable in production. It must reuse the INJECTED plan's own 'feed' filter — never
  // RelayClient's generic defaultPlan()/`kinds` fallback, which the app's custom plan
  // (createFeedAndDmPlan) never configures via the `kinds`/`limit` constructor options and would
  // otherwise resync with an unbounded, unscoped firehose REQ.
  it("reuses the injected plan's 'feed' filter, not RelayClient's generic kinds/limit default", async () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {
      // No `kinds`/`limit` set (matches App.tsx) — only a custom plan, as createFeedAndDmPlan is.
      plan: () => [{subId: 'feed', filter: {kinds: [1, 1311], since: 12_345}}],
    });
    socket.simulateOpen();
    socket.emitEose('feed');
    socket.sent.length = 0;

    const pending = client.resyncFeed(1_000);
    const frames = socket.sent.map(s => JSON.parse(s));
    const req = frames.find(f => f[0] === 'REQ')!;
    // The plan's own bounded/incremental filter — NOT SUBSCRIBED_KINDS/no-limit.
    expect(req[2]).toEqual({kinds: [1, 1311], since: 12_345});

    socket.emitEose(req[1]);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('RelayClient NIP-77 reconciliation', () => {
  const FEED_KINDS = [1, 7, 1111, 1984];

  /** Build the negentropy option wiring the client's feed reconciliation to the test store. */
  function negOptions(store: InMemoryEventStore, fallback: () => {kinds: number[]; since?: number}): NegentropySyncOptions {
    return {
      subId: 'feed',
      filter: {kinds: FEED_KINDS},
      getItems: () => store.query({kinds: [1]}).map(e => ({id: e.id, timestamp: e.created_at})),
      fallbackFilter: fallback,
    };
  }

  /**
   * Act as the relay: answer every NEG-OPEN/NEG-MSG using the server-role engine until close.
   * Replies on the SAME subId the client opened with (frame[1]) rather than a hardcoded literal,
   * so this works whether the client used the legacy default ('feed') or the current default
   * ('feed-neg') — or any caller-chosen subId.
   */
  function driveRelay(socket: FakeRelaySocket, server: Negentropy): void {
    let idx = 0;
    for (let guard = 0; guard < 100; guard++) {
      if (idx >= socket.sent.length) break;
      const frame = JSON.parse(socket.sent[idx++]!);
      if (frame[0] === 'NEG-OPEN') {
        socket.emit(JSON.stringify(['NEG-MSG', frame[1], server.reconcile(frame[3]).output]));
      } else if (frame[0] === 'NEG-MSG') {
        socket.emit(JSON.stringify(['NEG-MSG', frame[1], server.reconcile(frame[2]).output]));
      } else if (frame[0] === 'NEG-CLOSE') {
        return;
      }
    }
  }

  it('defaults the reconciliation subId to "feed-neg" — distinct from the live feed REQ\'s "feed"', () => {
    const socket = new FakeRelaySocket();
    new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [],
      negentropy: {
        filter: {kinds: FEED_KINDS},
        getItems: () => [],
        fallbackFilter: () => ({kinds: FEED_KINDS}),
      },
    });
    socket.simulateOpen();
    const [, subId] = JSON.parse(socket.sent[0]!);
    expect(subId).toBe('feed-neg');
  });

  it('runs the live standing feed REQ and the warm-cache reconciliation CONCURRENTLY on distinct subIds without collision (bugs #3+#4)', () => {
    const store = new InMemoryEventStore();
    const local = makePost('already cached', 9_700);
    store.save(local);
    const server = new Negentropy(
      NegentropyStorage.fromItems([{id: local.id, timestamp: local.created_at}]),
    );

    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      // Mirrors subscriptionPlan.ts: the live feed sub is ALWAYS present alongside negentropy.
      plan: () => [{subId: 'feed', filter: {kinds: FEED_KINDS, since: 9_700}}],
      negentropy: {
        subId: 'feed-neg',
        filter: {kinds: FEED_KINDS, since: 9_700},
        getItems: () => [{id: local.id, timestamp: local.created_at}],
        fallbackFilter: () => ({kinds: FEED_KINDS, since: 9_700}),
      },
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    const frames = socket.sent.map(s => JSON.parse(s));
    // The live REQ opened on 'feed' — untouched by the reconciliation session on 'feed-neg'.
    expect(frames).toContainEqual(['REQ', 'feed', {kinds: FEED_KINDS, since: 9_700}]);
    expect(frames.some(f => f[0] === 'NEG-OPEN' && f[1] === 'feed-neg')).toBe(true);

    // A brand-new event delivered on the LIVE 'feed' sub ingests normally — the live REQ is the
    // real-time delivery path and must keep working while reconciliation is still in flight.
    const fresh = makePost('arrives live while reconciling', 20_000);
    socket.emitEvent('feed', fresh);
    expect(store.has(fresh.id)).toBe(true);

    // 'feed' EOSEs on its own — reconciliation ('feed-neg') hasn't finished yet, so still unsynced.
    socket.emitEose('feed');
    expect(synced).toBe(false);

    // Reconciliation completes independently and finds nothing missing.
    driveRelay(socket, server);
    expect(synced).toBe(true);
  });

  it('reconciles the feed and fetches only the missing-id delta', () => {
    const store = new InMemoryEventStore();
    const local = [makePost('a', 1000), makePost('b', 1001), makePost('c', 1002)];
    for (const e of local) store.save(e);
    // The relay holds everything local plus three events we don't have.
    const extras = [makePost('x', 1003), makePost('y', 1004), makePost('z', 1005)];
    const server = new Negentropy(
      NegentropyStorage.fromItems(
        [...local, ...extras].map(e => ({id: e.id, timestamp: e.created_at})),
      ),
    );

    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [], // feed is owned by negentropy; no DM in this test
      negentropy: negOptions(store, () => ({kinds: FEED_KINDS, since: 900})),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    // Opens with NEG-OPEN, not a feed REQ.
    expect(JSON.parse(socket.sent[0]!)[0]).toBe('NEG-OPEN');

    driveRelay(socket, server);

    const frames = socket.sent.map(s => JSON.parse(s));
    // Exactly one id-scoped fetch REQ, carrying precisely the three missing ids.
    const idReq = frames.find(f => f[0] === 'REQ' && f[2] && Array.isArray(f[2].ids));
    expect(idReq).toBeDefined();
    expect(new Set(idReq[2].ids)).toEqual(new Set(extras.map(e => e.id)));
    // No legacy since-based feed REQ was opened (the fallback did not fire).
    expect(frames.some(f => f[0] === 'REQ' && f[2] && 'since' in f[2])).toBe(false);
    // Reconciliation itself is done, but "synced" waits for the missing-id chunk to drain so
    // background work (token draws, queued publishes) does not pile onto the initial ingest burst.
    expect(synced).toBe(false);
    socket.emitEose(idReq[1]);
    expect(synced).toBe(true);
  });

  it('finds nothing to fetch when already in sync', () => {
    const store = new InMemoryEventStore();
    const local = [makePost('a', 1000), makePost('b', 1001)];
    for (const e of local) store.save(e);
    const server = new Negentropy(
      NegentropyStorage.fromItems(local.map(e => ({id: e.id, timestamp: e.created_at}))),
    );

    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, () => ({kinds: FEED_KINDS, since: 900})),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    driveRelay(socket, server);

    const frames = socket.sent.map(s => JSON.parse(s));
    expect(frames.some(f => f[0] === 'REQ' && f[2] && Array.isArray(f[2].ids))).toBe(false);
    expect(synced).toBe(true);
  });

  it('resolves the reconciliation filter per round and snapshots the same bounded window', () => {
    const store = new InMemoryEventStore();
    const local = makePost('local', 10_000);
    store.save(local);
    const filter = {kinds: FEED_KINDS, since: 9_700, limit: 500};
    const filterFactory = jest.fn(() => filter);
    const getItems = jest.fn(() => [{id: local.id, timestamp: local.created_at}]);
    const socket = new FakeRelaySocket();
    new RelayClient(socket, store, {
      plan: () => [],
      negentropy: {
        subId: 'feed',
        filter: filterFactory,
        getItems,
        fallbackFilter: () => filter,
      },
    });

    socket.simulateOpen();

    expect(filterFactory).toHaveBeenCalledTimes(1);
    expect(getItems).toHaveBeenCalledWith(filter);
    expect(JSON.parse(socket.sent[0]!)[2]).toEqual(filter);
  });

  it('falls back cleanly when preparing the reconciliation window throws', () => {
    const socket = new FakeRelaySocket();
    const fallback = {kinds: FEED_KINDS, limit: 500};
    new RelayClient(socket, new InMemoryEventStore(), {
      plan: () => [],
      negentropy: {
        subId: 'feed',
        filter: () => {
          throw new Error('store unavailable');
        },
        getItems: () => [],
        fallbackFilter: () => fallback,
      },
    });

    socket.simulateOpen();

    expect(socket.sent.map(s => JSON.parse(s))).toContainEqual(['REQ', 'feed', fallback]);
  });

  it('falls back to the legacy feed REQ when the relay returns NEG-ERROR', () => {
    const store = new InMemoryEventStore();
    store.save(makePost('a', 5000));

    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, () => ({kinds: FEED_KINDS, since: 4700})),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    expect(JSON.parse(socket.sent[0]!)[0]).toBe('NEG-OPEN');

    // Relay rejects the reconciliation session.
    socket.emit(JSON.stringify(['NEG-ERROR', 'feed', 'blocked']));

    const frames = socket.sent.map(s => JSON.parse(s));
    // The legacy incremental feed REQ is opened as a firewall.
    expect(frames).toContainEqual(['REQ', 'feed', {kinds: FEED_KINDS, since: 4700}]);
    expect(synced).toBe(false); // waits for the fallback sub's EOSE

    socket.emitEose('feed');
    expect(synced).toBe(true);
  });

  it('falls back immediately (not just eventually via timeout) on a malformed/hostile NEG-MSG payload', () => {
    // A hostile or buggy relay could send garbage instead of a valid negentropy hex frame. This
    // must recover the SAME tick — via handleNegMsg's own try/catch around Negentropy.reconcile —
    // not merely survive by falling through to the timeout watchdog. Proof: no fake timers are
    // advanced here at all, yet the fallback REQ is already on the wire immediately after emit().
    // If handleNegMsg's try/catch were ever removed, handleMessage's outer per-frame catch would
    // still stop a crash, but negFallback() would then only fire negTimeoutMs later — this test
    // would fail because the fallback REQ would not exist yet at the assertion point.
    const store = new InMemoryEventStore();
    store.save(makePost('a', 5000));

    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, () => ({kinds: FEED_KINDS, since: 4700})),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    expect(JSON.parse(socket.sent[0]!)[0]).toBe('NEG-OPEN');

    // Non-hex garbage: the engine's HexReader throws decoding the very first byte. (After this,
    // negActive flips false, so a SECOND hostile frame on this subId would be silently ignored by
    // the dispatch guard rather than re-entering handleNegMsg — one hostile frame is what a real
    // relay bug or attacker gets exactly one free shot at, so that is what this test drives.)
    expect(() => socket.emit(JSON.stringify(['NEG-MSG', 'feed', 'not-valid-hex-!!']))).not.toThrow();

    const frames = socket.sent.map(s => JSON.parse(s));
    expect(frames).toContainEqual(['REQ', 'feed', {kinds: FEED_KINDS, since: 4700}]);
    expect(synced).toBe(false); // waits for the fallback sub's EOSE, same contract as NEG-ERROR

    socket.emitEose('feed');
    expect(synced).toBe(true);
  });

  it('settles a manual resync when its negentropy fallback reaches EOSE', async () => {
    const store = new InMemoryEventStore();
    const local = makePost('already cached', 5_000);
    store.save(local);
    const server = new Negentropy(
      NegentropyStorage.fromItems([{id: local.id, timestamp: local.created_at}]),
    );
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, () => ({kinds: FEED_KINDS, since: 4_700})),
    });
    socket.simulateOpen();
    driveRelay(socket, server);
    expect(client.isSynced()).toBe(true);

    const pending = client.resyncFeed(1_000);
    socket.emit(JSON.stringify(['NEG-ERROR', 'feed', 'retry with REQ']));
    expect(socket.sent.map(s => JSON.parse(s))).toContainEqual([
      'REQ',
      'feed',
      {kinds: FEED_KINDS, since: 4_700},
    ]);
    socket.emitEose('feed');

    await expect(pending).resolves.toBeUndefined();
  });

  it('falls back when reconciliation does not finish before the timeout', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      store.save(makePost('a', 5000));
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, store, {
        plan: () => [],
        negentropy: {...negOptions(store, () => ({kinds: FEED_KINDS, since: 4700})), timeoutMs: 10_000},
      });
      let synced = false;
      client.onSynced(() => (synced = true));

      socket.simulateOpen();
      // Relay never answers the NEG-OPEN.
      jest.advanceTimersByTime(10_001);

      const frames = socket.sent.map(s => JSON.parse(s));
      expect(frames).toContainEqual(['REQ', 'feed', {kinds: FEED_KINDS, since: 4700}]);
      socket.emitEose('feed');
      expect(synced).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RelayClient fetchById (chunking + un-blacklist on cleanup)', () => {
  const idsOf = (frame: unknown): string[] => {
    // ['REQ', subId, {ids: [...]}]
    const f = frame as [string, string, {ids?: string[]}];
    return f[0] === 'REQ' && f[2]?.ids ? f[2].ids : [];
  };

  it('drains a large need-list as sequential bounded chunks with a yield between them', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, new InMemoryEventStore());
      socket.simulateOpen();
      socket.sent.length = 0; // drop the initial subscribe frame

      const ids = Array.from({length: 60}, (_, i) => `id${i}`.padStart(8, '0'));
      client.fetchById(ids);

      let reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs.map(idsOf).map(a => a.length)).toEqual([25]);

      socket.emitEose(reqs[0]![1]);
      jest.advanceTimersByTime(25);
      reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs.map(idsOf).map(a => a.length)).toEqual([25, 25]);

      socket.emitEose(reqs[1]![1]);
      jest.advanceTimersByTime(25);
      reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs.map(idsOf).map(a => a.length)).toEqual([25, 25, 10]);
      expect(reqs.flatMap(idsOf).sort()).toEqual([...ids].sort());
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-requests ids that never arrived after the fetch cleanup fires (no permanent blacklist)', () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryEventStore();
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, store);
      socket.simulateOpen();
      socket.sent.length = 0;

      const arrived = makePost('this one shows up', 1000);
      client.fetchById([arrived.id, 'missing-id-that-never-arrives']);
      // The requested-but-uncached id must not be re-requested while the fetch is still in flight.
      socket.sent.length = 0;
      client.fetchById(['missing-id-that-never-arrives']);
      expect(socket.sent).toHaveLength(0);

      // One of the two ids ingests; the other never does.
      socket.emitEvent('fetch:0', arrived);

      // Cleanup fires (12s). The arrived id stays blacklisted (it's in the store); the missing id is
      // dropped from the blacklist so a later reconnect/resync can re-request it.
      jest.advanceTimersByTime(12_001);
      socket.sent.length = 0;

      client.fetchById([arrived.id, 'missing-id-that-never-arrives']);
      const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs.flatMap(idsOf)).toEqual(['missing-id-that-never-arrives']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RelayClient fetchByFilter (order-insensitive dedupe + un-blacklist on cleanup)', () => {
  it('re-requests a filter that never matched an event after the fetch cleanup fires (no permanent blacklist)', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, new InMemoryEventStore());
      socket.simulateOpen();
      socket.sent.length = 0;

      const filter = [{kinds: [30023], authors: ['author-a'], '#d': ['article-1']}];
      client.fetchByFilter(filter);
      expect(socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ')).toHaveLength(1);

      // Re-requesting while the fetch is still in flight is a no-op.
      socket.sent.length = 0;
      client.fetchByFilter(filter);
      expect(socket.sent).toHaveLength(0);

      // Nothing ever arrives — let the 12s cleanup fire with zero matching events ingested.
      jest.advanceTimersByTime(12_001);

      // A later call must go out as a fresh REQ instead of being silently swallowed forever.
      socket.sent.length = 0;
      client.fetchByFilter(filter);
      const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays deduped once a matching event actually lands before cleanup (no wasted re-request)', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store);
      socket.simulateOpen();
      socket.sent.length = 0;

      const filter = [{kinds: [30023], authors: ['author-a'], '#d': ['article-1']}];
      client.fetchByFilter(filter);
      const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      const subId = reqs[0]![1];

      const article = finalizeEvent(
        {kind: 30023, created_at: 1000, tags: [['d', 'article-1']], content: 'the article'},
        generateSecretKey(),
      );
      socket.emitEvent(subId, article);
      expect(store.has(article.id)).toBe(true);

      jest.advanceTimersByTime(12_001);

      socket.sent.length = 0;
      client.fetchByFilter(filter);
      expect(socket.sent).toHaveLength(0); // still deduped — the coordinate genuinely resolved
    } finally {
      jest.useRealTimers();
    }
  });

  it('a synchronous send throw rolls back the dedupe key immediately (not just at the 12s cleanup)', () => {
    const socket = new ThrowOnceSocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    const filter = [{kinds: [30023], authors: ['author-a'], '#d': ['article-1']}];
    socket.failNextSend();
    client.fetchByFilter(filter); // send throws — must not permanently blacklist the filter
    // cleanup() harmlessly attempts a CLOSE for the never-opened subId (same as fetchById's), but
    // no REQ ever went out.
    expect(socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ')).toHaveLength(0);

    socket.sent.length = 0;
    client.fetchByFilter(filter); // this time the send succeeds
    const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
    expect(reqs).toHaveLength(1);
  });

  it('dedupes filters that differ only in object key order (order-insensitive dedupe key)', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.fetchByFilter([{kinds: [30023], authors: ['author-a'], '#d': ['article-1']}]);
    expect(socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ')).toHaveLength(1);

    socket.sent.length = 0;
    // Same filter, keys written in a different order (as two independent call sites building the
    // "same" filter object plausibly would) — must still dedupe as the identical request.
    client.fetchByFilter([{authors: ['author-a'], '#d': ['article-1'], kinds: [30023]}]);
    expect(socket.sent).toHaveLength(0);
  });

  it('dedupes a filter carrying an explicit `undefined` field the same as one that omits it', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.fetchByFilter([{kinds: [30023], authors: ['author-a'], '#d': ['article-1']}]);
    expect(socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ')).toHaveLength(1);

    socket.sent.length = 0;
    client.fetchByFilter([
      {kinds: [30023], authors: ['author-a'], '#d': ['article-1'], since: undefined},
    ]);
    expect(socket.sent).toHaveLength(0);
  });
});

describe('RelayClient requestOlder (shared scroll-back pagination primitive, bug #3)', () => {
  it('opens a one-shot older-page REQ with until/limit applied on top of the caller filter', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'feed', filter: {kinds: [1, 7]}, until: 1_000, limit: 50});

    const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]![2]).toEqual({kinds: [1, 7], until: 1_000, limit: 50});
  });

  it('ingests events on the older-page sub and self-closes on EOSE', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store);
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'feed', filter: {kinds: [1]}, until: 10_000});
    const subId = (JSON.parse(socket.sent[0]!) as [string, string])[1];

    const older = makePost('an older cached-backfill post', 500);
    socket.emitEvent(subId, older);
    expect(store.has(older.id)).toBe(true);

    socket.sent.length = 0;
    socket.emitEose(subId);
    expect(socket.sent.map(s => JSON.parse(s))).toContainEqual(['CLOSE', subId]);
  });

  it('a second call for the SAME subKey while one is in flight is a no-op (no duplicate REQ)', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'group:abc', filter: {kinds: [9, 11, 12], '#h': ['abc']}, until: 5_000});
    expect(socket.sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);

    // Same surface, still pending — no second REQ opened.
    client.requestOlder({subKey: 'group:abc', filter: {kinds: [9, 11, 12], '#h': ['abc']}, until: 4_000});
    expect(socket.sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);
  });

  it('allows a fresh older-page request for the same subKey once the prior one closes', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'channel:30311:owner:d', filter: {kinds: [1311], '#a': ['30311:owner:d']}, until: 9_000});
    const firstSubId = (JSON.parse(socket.sent[0]!) as [string, string])[1];
    socket.emitEose(firstSubId);

    socket.sent.length = 0;
    client.requestOlder({subKey: 'channel:30311:owner:d', filter: {kinds: [1311], '#a': ['30311:owner:d']}, until: 8_000});
    expect(socket.sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);
  });

  it('different subKeys page independently and concurrently', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'feed', filter: {kinds: [1]}, until: 1_000});
    client.requestOlder({subKey: 'group:xyz', filter: {kinds: [9], '#h': ['xyz']}, until: 2_000});
    expect(socket.sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(2);
  });

  it('defaults the page size to OLDER_PAGE_LIMIT (50) when the caller omits `limit`', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore());
    socket.simulateOpen();
    socket.sent.length = 0;

    client.requestOlder({subKey: 'feed', filter: {kinds: [1]}, until: 1_000});
    const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
    expect(reqs[0]![2].limit).toBe(50);
  });

  it('self-closes and releases the subKey guard after a bounded timeout when the relay never EOSEs', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, new InMemoryEventStore());
      socket.simulateOpen();
      socket.sent.length = 0;

      client.requestOlder({subKey: 'feed', filter: {kinds: [1]}, until: 1_000});
      jest.advanceTimersByTime(12_001);
      expect(socket.sent.some(s => JSON.parse(s)[0] === 'CLOSE')).toBe(true);

      // The guard released — a fresh request for the same subKey opens a new REQ.
      socket.sent.length = 0;
      client.requestOlder({subKey: 'feed', filter: {kinds: [1]}, until: 900});
      expect(socket.sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * An EventStore whose save() throws for one specific event id — simulates a store-layer failure
 * (e.g. a mid-batch SQL error surfaced by saveNewBatch, or its per-event fallback) so a test can
 * exercise a throwing STORE step, distinct from a throwing verify().
 */
class ThrowingOnIdEventStore extends InMemoryEventStore {
  constructor(private readonly throwingId: string) {
    super();
  }
  override save(event: Event): boolean {
    if (event.id === this.throwingId) {
      throw new Error('store write exploded');
    }
    return super.save(event);
  }
}

describe('RelayClient ingest trust boundary (malformed/throwing frames never kill the session)', () => {
  it('drops a raw frame with tags-not-an-array without throwing, and still ingests later valid frames', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    new RelayClient(socket, store); // constructed for its socket->store wiring side-effect
    socket.simulateOpen();

    const malformed = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      sig: 'c'.repeat(128),
      kind: 1,
      created_at: 1000,
      content: 'hi',
      tags: 'not-an-array',
    };
    expect(() => socket.emit(JSON.stringify(['EVENT', 'feed', malformed]))).not.toThrow();
    expect(store.size()).toBe(0);

    const good = makePost('still ingests after malformed frame', 2000);
    socket.emitEvent('feed', good);
    expect(store.has(good.id)).toBe(true);
  });

  it('drops a raw frame with numeric content without throwing, and still ingests later valid frames', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    new RelayClient(socket, store); // constructed for its socket->store wiring side-effect
    socket.simulateOpen();

    const malformed = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      sig: 'c'.repeat(128),
      kind: 1,
      created_at: 1000,
      content: 12345,
      tags: [],
    };
    expect(() => socket.emit(JSON.stringify(['EVENT', 'feed', malformed]))).not.toThrow();
    expect(store.size()).toBe(0);

    const good = makePost('still ingests after malformed frame', 2000);
    socket.emitEvent('feed', good);
    expect(store.has(good.id)).toBe(true);
  });

  it('drops a truncated event (missing fields) without throwing, and still ingests later valid frames', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    new RelayClient(socket, store); // constructed for its socket->store wiring side-effect
    socket.simulateOpen();

    const truncated = {id: 'a'.repeat(64), kind: 1, created_at: 1000, content: '', tags: []};
    expect(() => socket.emit(JSON.stringify(['EVENT', 'feed', truncated]))).not.toThrow();
    expect(store.size()).toBe(0);

    const good = makePost('still ingests after truncated frame', 2000);
    socket.emitEvent('feed', good);
    expect(store.has(good.id)).toBe(true);
  });

  it('drops a frame that throws mid-processing (private counter), never killing the drain loop', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {
      verify: event => {
        if (event.content === 'boom') {
          throw new Error('verify exploded');
        }
        return true;
      },
    });
    socket.simulateOpen();

    const bad = makePost('boom', 1000);
    const good = makePost('fine', 2000);

    expect(client.droppedFrameCount()).toBe(0);
    expect(() => socket.emitEvent('feed', bad)).not.toThrow();
    expect(client.droppedFrameCount()).toBe(1);
    expect(store.has(bad.id)).toBe(false);

    // The socket/session is unaffected — a subsequent valid frame still ingests normally.
    socket.emitEvent('feed', good);
    expect(store.has(good.id)).toBe(true);
    expect(client.droppedFrameCount()).toBe(1);
  });

  it('keeps draining the batched inbound queue past a throwing frame in the middle', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {
        inboundBatchSize: 10,
        inboundTimeSliceMs: 1_000,
        verify: event => {
          if (event.content === 'boom') {
            throw new Error('verify exploded');
          }
          return true;
        },
      });
      socket.simulateOpen();

      const before = makePost('before', 1);
      const boom = makePost('boom', 2);
      const after = makePost('after', 3);
      socket.emitEvent('feed', before);
      socket.emitEvent('feed', boom);
      socket.emitEvent('feed', after);

      expect(store.size()).toBe(0); // batched — only enqueued so far
      jest.runOnlyPendingTimers();

      expect(store.has(before.id)).toBe(true);
      expect(store.has(boom.id)).toBe(false);
      expect(store.has(after.id)).toBe(true); // drain continued past the throwing frame
      expect(client.droppedFrameCount()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps draining the batched inbound queue past a throwing STORE write in the middle, and stays re-armed', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const before = makePost('before', 1);
      const boom = makePost('boom', 2);
      const after = makePost('after', 3);
      // The throw comes from the STORE step this time (flushPendingIngest's saveNewBatch/save
      // path), not from verify() — exercising Bug 1 (a throwing store write must not stall the
      // drain loop or drop the rest of the tick).
      const store = new ThrowingOnIdEventStore(boom.id);
      const client = new RelayClient(socket, store, {
        inboundBatchSize: 10,
        inboundTimeSliceMs: 1_000,
      });
      socket.simulateOpen();

      const notified: string[] = [];
      client.onEvent(event => notified.push(event.content));

      socket.emitEvent('feed', before);
      socket.emitEvent('feed', boom);
      socket.emitEvent('feed', after);

      expect(store.size()).toBe(0); // batched — only enqueued so far
      jest.runOnlyPendingTimers();

      // The throwing store write is dropped and counted, but the OTHER events in the same tick
      // are still stored and still notify listeners — one bad event doesn't drop the whole tick.
      expect(store.has(before.id)).toBe(true);
      expect(store.has(boom.id)).toBe(false);
      expect(store.has(after.id)).toBe(true);
      expect(notified).toEqual(['before', 'after']);
      expect(client.droppedFrameCount()).toBe(1);

      // The drain loop is NOT stalled: scheduleInboundDrain's re-arm still ran, so a later
      // message drains normally instead of sitting stuck in the queue forever.
      const later = makePost('later', 4);
      socket.emitEvent('feed', later);
      jest.runOnlyPendingTimers();
      expect(store.has(later.id)).toBe(true);
      expect(notified).toEqual(['before', 'after', 'later']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RelayClient dedupe Set eviction (fetchedIds/fetchedFilters bounded growth)', () => {
  it('evicts the oldest fetchedFilters entries once the dedupe cap is exceeded', () => {
    // fetchByFilter opens a real 12s cleanup timer per call; use fake timers so driving it 4000+
    // times in this test doesn't leave a pile of live real-clock timers behind.
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const client = new RelayClient(socket, new InMemoryEventStore());
      socket.simulateOpen();
      socket.sent.length = 0;

      const firstFilter = [{kinds: [30023], authors: ['author-first'], '#d': ['first']}];
      client.fetchByFilter(firstFilter);
      expect(socket.sent).toHaveLength(1);

      // Re-requesting the SAME filter immediately is deduped (no new REQ).
      socket.sent.length = 0;
      client.fetchByFilter(firstFilter);
      expect(socket.sent).toHaveLength(0);

      // Push the dedupe set past its ~4096 cap with distinct filters so the oldest entries
      // (including `firstFilter`, inserted before all of these) get evicted.
      for (let i = 0; i < 4096; i++) {
        client.fetchByFilter([{kinds: [30023], authors: [`author-${i}`], '#d': [`d${i}`]}]);
      }

      // firstFilter was among the oldest and should have been evicted — re-requesting it now
      // sends a fresh REQ instead of being silently deduped forever.
      socket.sent.length = 0;
      client.fetchByFilter(firstFilter);
      expect(socket.sent).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the oldest fetchedIds entries once the dedupe cap is exceeded, even for an id already in the store', () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRelaySocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store);
      socket.simulateOpen();
      socket.sent.length = 0;

      // `first` arrives and is stored — normally this permanently dedupes it in fetchedIds (the
      // "un-blacklist on cleanup" path only removes ids that never made it to the store).
      const first = makePost('first fetched by id', 1_000);
      client.fetchById([first.id]);
      let reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs).toHaveLength(1);
      const firstSubId = reqs[0]![1];
      socket.emitEvent(firstSubId, first);
      socket.emitEose(firstSubId);
      expect(store.has(first.id)).toBe(true);

      // Push the dedupe set past its cap with 4096 distinct filler ids (all added to fetchedIds
      // synchronously by this single fetchById call, regardless of chunk draining).
      const filler = Array.from({length: 4096}, (_, i) => `filler${i}`.padStart(64, '0'));
      client.fetchById(filler);

      // Drain every filler id-fetch chunk (none of them arrive, so their un-blacklist cleanup
      // removes them from fetchedIds anyway — irrelevant to this test, which is about `first`).
      const drained = new Set<string>();
      for (let guard = 0; guard < 400; guard++) {
        const frames = socket.sent.map(s => JSON.parse(s));
        const next = frames.find(
          f => f[0] === 'REQ' && Array.isArray(f[2]?.ids) && !drained.has(f[1]),
        );
        if (!next) break;
        drained.add(next[1]);
        socket.emitEose(next[1]);
        jest.advanceTimersByTime(25);
      }

      // `first.id` is still in the store, so if fetchedIds were unbounded it would stay deduped
      // forever. Once the cap evicted it (it was the oldest entry), re-requesting it by id must
      // send a fresh REQ rather than silently no-op.
      socket.sent.length = 0;
      client.fetchById([first.id]);
      const refetchReqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(refetchReqs.some(f => (f[2]?.ids ?? []).includes(first.id))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RelayClient — allowed-kinds lockstep (C6)', () => {
  beforeEach(() => clearRecentLogs());
  const capsWarns = () => getRecentLogs().filter(e => e.level === 'warn' && e.scope === 'caps');

  it('WARNS but still STORES an accepted event whose kind is missing from the relay allow-list', () => {
    const store = new InMemoryEventStore();
    // Relay advertises only kind 7, but the client accepts kind 1 (getAllowedKinds omits it).
    const client = new RelayClient(new FakeRelaySocket(), store, {kinds: [1, 7], getAllowedKinds: () => [7]});
    const post = makePost('drifted kind', 1000);
    expect(client.ingest(post)).toBe(true); // NOT rejected — accept/reject is unchanged
    expect(store.has(post.id)).toBe(true);
    const w = capsWarns();
    expect(w).toHaveLength(1);
    expect(w[0]!.msg).toContain('ingest');
    expect(w[0]!.msg).toContain('1');
  });

  it('warns each drifted kind at most once across repeated ingests', () => {
    const store = new InMemoryEventStore();
    const client = new RelayClient(new FakeRelaySocket(), store, {kinds: [1, 7], getAllowedKinds: () => [7]});
    client.ingest(makePost('a', 1000));
    client.ingest(makePost('b', 1001));
    expect(capsWarns()).toHaveLength(1); // kind 1 warned once, not twice
  });

  it('stays silent when the relay allow-list carries the accepted kind (no drift / fallback)', () => {
    const store = new InMemoryEventStore();
    const client = new RelayClient(new FakeRelaySocket(), store, {kinds: [1, 7], getAllowedKinds: () => [1, 7]});
    expect(client.ingest(makePost('allowed', 1000))).toBe(true);
    expect(capsWarns()).toHaveLength(0);
  });

  it('does nothing when getAllowedKinds is not wired (default) — byte-identical to before', () => {
    const store = new InMemoryEventStore();
    const client = new RelayClient(new FakeRelaySocket(), store, {kinds: [1, 7]});
    expect(client.ingest(makePost('no getter', 1000))).toBe(true);
    expect(capsWarns()).toHaveLength(0);
  });
});

describe('warnKindDrift (shared C6 helper)', () => {
  beforeEach(() => clearRecentLogs());
  const warns = () => getRecentLogs().filter(e => e.level === 'warn' && e.scope === 'caps');

  it('WARNS (never throws) when a subscribed kind is absent from the relay allow-list', () => {
    expect(() => warnKindDrift([1, 7, 9999], [1, 7], 'ingest')).not.toThrow();
    const w = warns();
    expect(w).toHaveLength(1);
    expect(w[0]!.msg).toContain('9999');
    expect(w[0]!.msg).toContain('ingest');
  });

  it('stays silent when every subscribed kind is allowed (no drift)', () => {
    warnKindDrift([1, 7], [1, 7, 30023], 'feed-plan');
    expect(warns()).toHaveLength(0);
  });

  it('is a no-op when the relay advertised no allow-list (empty) — ship-ahead fallback', () => {
    warnKindDrift([1, 7, 9999], [], 'feed-plan');
    expect(warns()).toHaveLength(0);
  });

  it('at caps fallback (allowedKinds ⊇ SUBSCRIBED_KINDS) the firehose set never warns', () => {
    warnKindDrift(SUBSCRIBED_KINDS, defaultRelayCapabilities().allowedKinds, 'feed-plan');
    expect(warns()).toHaveLength(0);
  });

  it('de-dupes with the alreadyWarned set: each drifted kind warns at most once', () => {
    const seen = new Set<number>();
    warnKindDrift([9999], [1], 'ingest', seen);
    warnKindDrift([9999], [1], 'ingest', seen); // same kind again → suppressed
    expect(warns()).toHaveLength(1);
    expect(seen.has(9999)).toBe(true);
  });
});

describe('RelayClient NIP-77 instrumentation (T10-S3 onReconciled + buckets)', () => {
  const FEED_KINDS = [1, 7, 1111, 1984];

  /** negentropy options wired to a test store, with per-test overrides (onReconciled/buckets/etc). */
  function negOptions(
    store: InMemoryEventStore,
    extra: Partial<NegentropySyncOptions> = {},
  ): NegentropySyncOptions {
    return {
      subId: 'feed',
      filter: {kinds: FEED_KINDS},
      getItems: () => store.query({kinds: [1]}).map(e => ({id: e.id, timestamp: e.created_at})),
      fallbackFilter: () => ({kinds: FEED_KINDS, since: 900}),
      ...extra,
    };
  }

  /** Act as the relay: answer NEG-OPEN/NEG-MSG with the server-role engine until NEG-CLOSE. */
  function driveRelay(socket: FakeRelaySocket, server: Negentropy): void {
    let idx = 0;
    for (let guard = 0; guard < 100; guard++) {
      if (idx >= socket.sent.length) break;
      const frame = JSON.parse(socket.sent[idx++]!);
      if (frame[0] === 'NEG-OPEN') {
        socket.emit(JSON.stringify(['NEG-MSG', frame[1], server.reconcile(frame[3]).output]));
      } else if (frame[0] === 'NEG-MSG') {
        socket.emit(JSON.stringify(['NEG-MSG', frame[1], server.reconcile(frame[2]).output]));
      } else if (frame[0] === 'NEG-CLOSE') {
        return;
      }
    }
  }

  it('fires onReconciled once with fellBack=false and correct rounds/need/have on a completed reconcile', () => {
    const store = new InMemoryEventStore();
    const local = [makePost('a', 1000), makePost('b', 1001), makePost('c', 1002)];
    for (const e of local) store.save(e);
    // The relay holds everything local plus three events we don't have.
    const extras = [makePost('x', 1003), makePost('y', 1004), makePost('z', 1005)];
    const server = new Negentropy(
      NegentropyStorage.fromItems([...local, ...extras].map(e => ({id: e.id, timestamp: e.created_at}))),
    );

    const socket = new FakeRelaySocket();
    const stats: ReconcileStats[] = [];
    new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, {onReconciled: s => stats.push(s)}),
    });

    socket.simulateOpen();
    driveRelay(socket, server);

    expect(stats).toHaveLength(1);
    const s = stats[0]!;
    expect(s.subId).toBe('feed');
    expect(s.fellBack).toBe(false);
    expect(s.rounds).toBeGreaterThanOrEqual(1);
    expect(s.wallMs).toBeGreaterThanOrEqual(0);
    expect(s.need).toBe(3); // the three missing extras
    expect(s.have).toBe(0); // the relay is a superset — nothing we hold that it lacks
    expect(s.frameBytesOut).toBeGreaterThan(0);
    expect(typeof s.at).toBe('number');
  });

  it('fires onReconciled once with fellBack=true on a NEG-ERROR and does NOT double-fire on the fallback EOSE', () => {
    const store = new InMemoryEventStore();
    store.save(makePost('a', 5000));
    const socket = new FakeRelaySocket();
    const stats: ReconcileStats[] = [];
    new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, {
        fallbackFilter: () => ({kinds: FEED_KINDS, since: 4700}),
        onReconciled: s => stats.push(s),
      }),
    });

    socket.simulateOpen();
    expect(JSON.parse(socket.sent[0]!)[0]).toBe('NEG-OPEN');

    // The relay rejects the reconciliation session → one fell-back stat.
    socket.emit(JSON.stringify(['NEG-ERROR', 'feed', 'blocked']));
    expect(stats).toHaveLength(1);
    expect(stats[0]!.fellBack).toBe(true);

    // The legacy fallback REQ opened; its EOSE must NOT emit a SECOND stat.
    expect(socket.sent.map(x => JSON.parse(x))).toContainEqual([
      'REQ',
      'feed',
      {kinds: FEED_KINDS, since: 4700},
    ]);
    socket.emitEose('feed');
    expect(stats).toHaveLength(1);
  });

  it('swallows a throwing onReconciled consumer — the round still completes and the feed marks synced', () => {
    const store = new InMemoryEventStore();
    const local = [makePost('a', 1000), makePost('b', 1001)];
    for (const e of local) store.save(e);
    const server = new Negentropy(
      NegentropyStorage.fromItems(local.map(e => ({id: e.id, timestamp: e.created_at}))),
    );
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, {
        onReconciled: () => {
          throw new Error('diagnostics consumer blew up');
        },
      }),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    expect(() => driveRelay(socket, server)).not.toThrow();
    expect(synced).toBe(true); // markSynced still fired despite the throwing consumer
  });

  it('forwards opts.buckets to the engine — an out-of-range value makes construction throw → fallback', () => {
    const store = new InMemoryEventStore();
    store.save(makePost('a', 5000));
    const socket = new FakeRelaySocket();
    const stats: ReconcileStats[] = [];
    new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, {
        buckets: 1, // invalid ([2,256]); the DEFAULT (16) would NOT throw — so a fallback proves forwarding
        fallbackFilter: () => ({kinds: FEED_KINDS, since: 4700}),
        onReconciled: s => stats.push(s),
      }),
    });

    socket.simulateOpen();
    const frames = socket.sent.map(x => JSON.parse(x));
    // Construction threw before initiate(), so no NEG-OPEN went out; the legacy REQ fired instead.
    expect(frames.some(f => f[0] === 'NEG-OPEN')).toBe(false);
    expect(frames).toContainEqual(['REQ', 'feed', {kinds: FEED_KINDS, since: 4700}]);
    // The fell-back round emitted exactly one stat with rounds=0 (nothing was ever driven).
    expect(stats).toHaveLength(1);
    expect(stats[0]!.fellBack).toBe(true);
    expect(stats[0]!.rounds).toBe(0);
  });

  it('reconciles the same delta with a forwarded non-default buckets (32) — branching stays wire-safe', () => {
    const store = new InMemoryEventStore();
    const local = [makePost('a', 1000), makePost('b', 1001), makePost('c', 1002)];
    for (const e of local) store.save(e);
    const extras = [makePost('x', 1003), makePost('y', 1004), makePost('z', 1005)];
    const server = new Negentropy(
      NegentropyStorage.fromItems([...local, ...extras].map(e => ({id: e.id, timestamp: e.created_at}))),
    );
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, store, {
      plan: () => [],
      negentropy: negOptions(store, {buckets: 32}),
    });
    let synced = false;
    client.onSynced(() => (synced = true));

    socket.simulateOpen();
    driveRelay(socket, server);

    const frames = socket.sent.map(x => JSON.parse(x));
    const idReq = frames.find(f => f[0] === 'REQ' && f[2] && Array.isArray(f[2].ids));
    expect(idReq).toBeDefined();
    expect(new Set(idReq[2].ids)).toEqual(new Set(extras.map(e => e.id)));
    socket.emitEose(idReq[1]);
    expect(synced).toBe(true);
  });
});

describe('RelayClient scoped subs across (re)connect (onSubscribed)', () => {
  // The accepted-join-request bug: resubscribeGroups() used to run from onRelayConnected — called at
  // relay CONSTRUCTION, before the Tor socket opened — so sendSubscribe()'s knownSubIds reset wiped
  // every scoped group sub the moment the socket did open, and the requester's fresh 39002 had no
  // surviving subscription to arrive on. These pin both halves: the wipe, and the onSubscribed cure.

  it('a scoped sub opened BEFORE the socket opens is wiped by the plan send (the disease)', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {kinds: [1]});
    client.subscribeScoped('group:g1', [{kinds: [39002], '#d': ['g1']}]);

    socket.simulateOpen(); // sendSubscribe resets the sub registry to the plan's subs
    const post = makePost('member list', 1000);
    socket.emitEvent('group:g1', post);

    expect(store.size()).toBe(0); // EVENT for the wiped subId is discarded
  });

  it('onSubscribed fires on every plan send, and a scoped sub opened from it sticks', () => {
    const socket = new FakeRelaySocket();
    const store = new InMemoryEventStore();
    const client = new RelayClient(socket, store, {kinds: [1]});
    let fired = 0;
    client.onSubscribed(() => {
      fired++;
      client.subscribeScoped('group:g1', [{kinds: [39002], '#d': ['g1']}]);
    });

    socket.simulateOpen();
    expect(fired).toBe(1);
    // The scoped REQ went out AFTER the plan's, on the open socket.
    const reqs = socket.sent.map(x => JSON.parse(x)).filter(f => f[0] === 'REQ');
    expect(reqs.map(f => f[1])).toEqual(['feed', 'group:g1']);

    const post = makePost('member list', 1000);
    socket.emitEvent('group:g1', post);
    expect(store.size()).toBe(1); // the sub survived — its events ingest

    // Reconnect: the plan send wipes scoped subs again, and onSubscribed re-opens them again.
    socket.simulateOpen();
    expect(fired).toBe(2);
    const post2 = makePost('fresher member list', 2000);
    socket.emitEvent('group:g1', post2);
    expect(store.size()).toBe(2);
  });

  it('a throwing onSubscribed listener does not stop the others', () => {
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    let reached = false;
    client.onSubscribed(() => {
      throw new Error('boom');
    });
    client.onSubscribed(() => (reached = true));

    socket.simulateOpen();

    expect(reached).toBe(true);
    expect(client.isSynced()).toBe(false); // connection unharmed, still awaiting EOSE
  });
});

describe('RelayClient subscribeScoped — retry on a failed send', () => {
  // The empty-channel-that-does-open bug: a scoped-sub send that races the socket not being open
  // yet (a channel view mounts while Tor is still settling) used to just roll back knownSubIds and
  // give up — nothing re-issued the REQ until the NEXT genuine reconnect fired resubscribeChannels,
  // which may never happen while the socket stays "nominally up" for the rest of that session.

  it('retries a failed send under the SAME subId on a short backoff, and it survives', () => {
    jest.useFakeTimers();
    try {
      const socket = new ThrowOnceSocket();
      const store = new InMemoryEventStore();
      const client = new RelayClient(socket, store, {kinds: [1]});
      socket.simulateOpen();
      socket.sent.length = 0;

      socket.failNextSend();
      client.subscribeScoped('channel:c1', [{kinds: [1311], '#a': ['30311:owner:c1']}]);
      expect(socket.sent).toHaveLength(0); // the send threw — nothing went out yet

      jest.advanceTimersByTime(250); // first retry backoff
      const reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs).toHaveLength(1);
      expect(reqs[0]![1]).toBe('channel:c1'); // re-issued under the identical subId

      // The sub is genuinely live now — an EVENT for it ingests.
      const msg = makePost('hello channel', 1000);
      socket.emitEvent('channel:c1', msg);
      expect(store.has(msg.id)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after the bounded retries are exhausted, without throwing or looping forever', () => {
    jest.useFakeTimers();
    try {
      const socket = new ThrowOnceSocket();
      const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
      socket.simulateOpen();
      socket.sent.length = 0;

      // Fail every attempt (initial send + every retry).
      socket.failNextSend();
      client.subscribeScoped('channel:c1', [{kinds: [1311], '#a': ['30311:owner:c1']}]);
      socket.failNextSend();
      jest.advanceTimersByTime(250); // retry 1 — also fails
      socket.failNextSend();
      jest.advanceTimersByTime(1_000); // retry 2 — also fails, and the backoff budget is spent

      // No further timer is pending — advancing well past any further backoff sends nothing.
      jest.advanceTimersByTime(60_000);
      expect(socket.sent).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closeSub cancels a pending retry — a channel closed mid-backoff never resurrects its sub', () => {
    jest.useFakeTimers();
    try {
      const socket = new ThrowOnceSocket();
      const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
      socket.simulateOpen();
      socket.sent.length = 0;

      socket.failNextSend();
      client.subscribeScoped('channel:c1', [{kinds: [1311], '#a': ['30311:owner:c1']}]);
      client.closeSub('channel:c1'); // user navigated away before the retry ever fired

      jest.advanceTimersByTime(60_000);
      // No REQ (the cancelled retry never fired) — the CLOSE attempted by closeSub is swallowed
      // (knownSubIds never held this subId, since the original send failed), so nothing is sent.
      expect(socket.sent).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a fresh subscribeScoped call for the same subId supersedes a stale pending retry (no duplicate REQ)', () => {
    jest.useFakeTimers();
    try {
      const socket = new ThrowOnceSocket();
      const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
      socket.simulateOpen();
      socket.sent.length = 0;

      socket.failNextSend();
      client.subscribeScoped('channel:c1', [{kinds: [1311], '#a': ['30311:owner:c1']}]);
      // A genuine reconnect (or any fresh caller) re-issues immediately, before the 250ms retry —
      // this must cancel the stale retry rather than leaving both eventually firing.
      client.subscribeScoped('channel:c1', [{kinds: [1311], '#a': ['30311:owner:c1']}]);
      let reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs).toHaveLength(1);

      jest.advanceTimersByTime(60_000); // the cancelled retry must never also fire
      reqs = socket.sent.map(s => JSON.parse(s)).filter(f => f[0] === 'REQ');
      expect(reqs).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
