/**
 * First-run community prefetch (prefetchCommunity.ts) — the connecting ladder's third rung.
 *
 * The contract these lock down is "warm the RIGHT database with the RIGHT subscriptions, and never
 * be able to trap the member":
 *   - the plan it runs is the production one, reduced to `feed` + `org-config` because there is no
 *     enrolled npub yet — and, critically, carrying NO npub-scoped filter of any kind;
 *   - events land in the store the HOST's factory returned under the PRE-MINTED slot, which is the
 *     only reason enrollment can adopt them;
 *   - every failure mode (cap, dead socket, a store that won't open) resolves `false` rather than
 *     hanging, because the caller awaits this before the member can proceed.
 */
import {FakeRelaySocket} from '../nostr/socket.fake';
import {InMemoryEventStore} from '../nostr/store';
import type {EventStore} from '../nostr/store';
import {Kind} from '../contracts';
import {channelCoord} from '../channels/channels';
import type {Event} from 'nostr-tools/pure';
import type {Session} from './enrollment';
import {startCommunityPrefetch} from './prefetchCommunity';

const RELAY = `ws://${'a'.repeat(56)}.onion`;
const ORGANIZER = 'o'.repeat(64);
const OWNER = 'b'.repeat(64);

/** Only `relayUrl` and `community.organizerPubkey` are read here — the rest of Session is inert. */
function session(relayUrl = RELAY): Session {
  return {
    relayUrl,
    community: {relayUrl, issuerPublicKey: 'ISSUER', organizerPubkey: ORGANIZER},
  } as unknown as Session;
}

/**
 * A distinct 64-char LOWERCASE hex id. Not decoration: protocol.ts's `isValidEventShape` is the
 * trust boundary between the relay and everything downstream, and it drops any EVENT frame whose id
 * isn't hex — so a "readable" fixture id would be silently discarded before ingest ever ran, and the
 * test would fail for a reason that has nothing to do with this module.
 */
let idSeq = 0;
function hexId(): string {
  idSeq += 1;
  return idSeq.toString(16).padStart(64, 'a');
}

function channelDef(d: string, createdAt: number): Event {
  return {
    id: hexId(),
    pubkey: OWNER,
    created_at: createdAt,
    kind: Kind.LiveActivity,
    tags: [['d', d], ['title', d], ['status', 'live']],
    content: '',
    sig: 'x'.repeat(128),
  };
}

/** REQ filters this socket has been sent, keyed by sub id. */
function reqsBySubId(socket: FakeRelaySocket): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const raw of socket.sent) {
    const frame = JSON.parse(raw) as unknown[];
    if (frame[0] !== 'REQ') continue;
    out.set(frame[1] as string, frame[2] as Record<string, unknown>);
  }
  return out;
}

/** Let RelayClient's paced inbound drain (setTimeout(0) per tick) run to completion. */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

interface Harness {
  socket: FakeRelaySocket;
  store: InMemoryEventStore & {close?: () => void};
  closed: {store: number};
  createStore: jest.Mock<Promise<EventStore>, [string, string]>;
}

function harness(): Harness {
  const socket = new FakeRelaySocket();
  const closed = {store: 0};
  const store = Object.assign(new InMemoryEventStore(), {
    close: () => {
      closed.store++;
    },
  });
  const createStore = jest.fn(async (_cid: string, _slotId: string) => store as EventStore);
  return {socket, store, closed, createStore};
}

describe('startCommunityPrefetch', () => {
  it('runs the production plan reduced to feed + org-config, with no npub-scoped subscription', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(session(), {
      connect: () => h.socket,
      createStore: h.createStore,
      verify: () => true,
    });

    await drain();
    h.socket.simulateOpen();

    // The store was opened under the PRE-MINTED slot the handle hands to enrollment — same cid, same
    // slot id, so `swapActiveStore()` later reopens this exact file.
    expect(h.createStore).toHaveBeenCalledWith(prefetch.cid, prefetch.slotId);

    const reqs = reqsBySubId(h.socket);
    expect([...reqs.keys()].sort()).toEqual(['feed', 'org-config']);
    expect(reqs.get('org-config')).toMatchObject({authors: [ORGANIZER]});
    // The identity-scoped subs (dm / self-lists / space-keys / draft-deliveries / self-profile) are
    // absent because there is no enrolled npub — and nothing here may invent one. A `#p` or `authors`
    // naming this device on this connection is exactly the leak the plan's decoy machinery exists to
    // prevent, so assert it structurally rather than trusting the reduction.
    expect(reqs.has('dm')).toBe(false);
    expect(reqs.has('self-profile')).toBe(false);
    for (const filter of reqs.values()) {
      expect(filter['#p']).toBeUndefined();
    }

    await prefetch.finish();
  });

  it('resolves true once every subscription has EOSE\'d, with the events in the host store', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(session(), {
      connect: () => h.socket,
      createStore: h.createStore,
      verify: () => true,
    });
    await drain();
    h.socket.simulateOpen();

    let settled: boolean | undefined;
    void prefetch.waitForEssentials().then(ok => {
      settled = ok;
    });

    h.socket.emitEvent('feed', channelDef('lounge', 100));
    h.socket.emitEose('feed');
    await drain();
    expect(settled).toBeUndefined(); // org-config still pending — not synced yet

    h.socket.emitEose('org-config');
    await drain();

    expect(settled).toBe(true);
    expect(h.store.query({kinds: [Kind.LiveActivity]})).toHaveLength(1);

    await prefetch.finish();
  });

  it('gives up at the cap rather than holding onboarding on a relay that never EOSEs', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(
      session(),
      {connect: () => h.socket, createStore: h.createStore, verify: () => true},
      {essentialsCapMs: 1_000},
    );
    await drain();
    h.socket.simulateOpen();

    // Asserted as "holds, then gives up" rather than by measuring elapsed wall-clock against the
    // cap: a lower bound on Date.now() is a flaky instrument (Windows clock granularity had a 1000ms
    // cap read back as 884ms), and it isn't what the rung promises anyway. What matters is that the
    // ladder is genuinely held while the store could still fill, and that it then advances on its
    // own — nothing else here can settle it, since no EOSE arrives and the socket stays open.
    let settled: boolean | undefined;
    const wait = prefetch.waitForEssentials().then(ok => (settled = ok));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(settled).toBeUndefined();

    await expect(wait).resolves.toBe(false);

    await prefetch.finish();
  });

  it('resolves false immediately when the socket dies before EOSE', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(
      session(),
      {connect: () => h.socket, createStore: h.createStore, verify: () => true},
      // A cap far beyond the test's patience: passing this only via a dead socket proves the close
      // path resolves on its own rather than being rescued by the timer.
      {essentialsCapMs: 600_000},
    );
    await drain();
    h.socket.simulateOpen();
    h.socket.close();

    await expect(prefetch.waitForEssentials()).resolves.toBe(false);
    await prefetch.finish();
  });

  it('still yields a usable slot id when the store cannot be opened', async () => {
    const socket = new FakeRelaySocket();
    const prefetch = startCommunityPrefetch(session(), {
      connect: () => socket,
      createStore: () => Promise.reject(new Error('no secure storage')),
      verify: () => true,
    });

    await expect(prefetch.waitForEssentials()).resolves.toBe(false);
    // Enrollment is still handed this slot: it then names an empty namespace, which is precisely
    // what minting one inside completeEnrollment would have produced. No special-casing needed.
    expect(prefetch.slotId).toBeTruthy();
    expect(prefetch.cid).toBeTruthy();
    await expect(prefetch.finish()).resolves.toBeUndefined();
  });

  it('bulk wave pulls recent messages for the newest channel definitions it downloaded', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(
      session(),
      {connect: () => h.socket, createStore: h.createStore, verify: () => true},
      {spaceCount: 2, spaceMessageLimit: 40},
    );
    await drain();
    h.socket.simulateOpen();

    h.socket.emitEvent('feed', channelDef('old', 100));
    h.socket.emitEvent('feed', channelDef('newer', 200));
    h.socket.emitEvent('feed', channelDef('newest', 300));
    h.socket.emitEose('feed');
    h.socket.emitEose('org-config');
    await drain();

    prefetch.startBulk();
    await drain();

    const chatReq = [...reqsBySubId(h.socket).values()].find(
      f => Array.isArray(f.kinds) && (f.kinds as number[]).includes(Kind.LiveChat),
    );
    expect(chatReq).toBeDefined();
    expect(chatReq).toMatchObject({limit: 40});
    // Newest-definition-first, capped at spaceCount — the oldest channel is left to stream in
    // normally after enrollment rather than widening the join's download.
    expect(chatReq!['#a']).toEqual([
      channelCoord(OWNER, 'newest'),
      channelCoord(OWNER, 'newer'),
    ]);

    await prefetch.finish();
  });

  it('finish() closes the socket and releases the store handle, and is idempotent', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(session(), {
      connect: () => h.socket,
      createStore: h.createStore,
      verify: () => true,
    });
    await drain();
    h.socket.simulateOpen();

    await prefetch.finish();
    // Both matter before enrollment reopens the same per-(cid, slot) SQLCipher file.
    expect(h.socket.closed).toBe(true);
    expect(h.closed.store).toBe(1);

    await prefetch.finish();
    expect(h.closed.store).toBe(1);
  });

  it('startBulk() after finish() issues nothing', async () => {
    const h = harness();
    const prefetch = startCommunityPrefetch(session(), {
      connect: () => h.socket,
      createStore: h.createStore,
      verify: () => true,
    });
    await drain();
    h.socket.simulateOpen();
    h.socket.emitEose('feed');
    h.socket.emitEose('org-config');
    await drain();

    await prefetch.finish();
    const before = h.socket.sent.length;
    prefetch.startBulk();
    await drain();
    expect(h.socket.sent.length).toBe(before);
  });
});
