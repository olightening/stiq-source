/**
 * THE load-bearing invariant of the lazy-media work: a media blob must NEVER ride the firehose.
 *
 * The entire bug being fixed is that picture/voice bytes arrived with the feed REQ whether or not
 * anyone tapped. If a blob kind ever leaks into FEED_KINDS / SUBSCRIBED_KINDS, that bug returns in a
 * worse form — silently, and with an extra event per picture. These tests are the tripwire.
 */
import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {
  FEED_KINDS,
  FEED_STORE_READ_KINDS,
  FETCH_ONLY_KINDS,
  GROUP_KINDS,
  KIND_MEDIA_BLOB,
  SUBSCRIBED_KINDS,
  isSubscribedKind,
} from './index';
import {RelayClient} from '../nostr/RelayClient';
import {InMemoryEventStore} from '../nostr/store';
import {FakeRelaySocket} from '../nostr/socket.fake';
import {buildMediaBlobEvent} from '../feed/mediaBlob';

function makeBlob(payload = 'UABCD'): Event {
  const b = buildMediaBlobEvent(payload);
  return finalizeEvent({kind: b.kind, created_at: b.created_at, tags: b.tags, content: b.content}, generateSecretKey());
}

describe('media blob kinds stay off the firehose', () => {
  it('is declared in FETCH_ONLY_KINDS', () => {
    expect(FETCH_ONLY_KINDS).toContain(KIND_MEDIA_BLOB);
  });

  it('is absent from every list that drives a subscription or a store scan', () => {
    expect(FEED_KINDS).not.toContain(KIND_MEDIA_BLOB);
    expect(SUBSCRIBED_KINDS).not.toContain(KIND_MEDIA_BLOB);
    expect(FEED_STORE_READ_KINDS).not.toContain(KIND_MEDIA_BLOB);
    expect(isSubscribedKind(KIND_MEDIA_BLOB)).toBe(false);
  });

  it('keeps the three off-firehose/ingest lists disjoint from the firehose set', () => {
    for (const k of FETCH_ONLY_KINDS) {
      expect(SUBSCRIBED_KINDS).not.toContain(k);
      expect(FEED_KINDS).not.toContain(k);
    }
    // FETCH_ONLY_KINDS and GROUP_KINDS are separate allow-lists for separate reasons; a kind in both
    // would mean two different fetch disciplines claim it.
    for (const k of FETCH_ONLY_KINDS) {
      expect(GROUP_KINDS).not.toContain(k);
    }
  });

  // The deprecated `KIND_PICTURE` alias of 30351 is GONE (bug 8 retired it — subscriptionPlan, its
  // last importer, now uses KIND_MEDIA_BLOB). Its test went with it: it existed to pin that the alias
  // stayed an alias and never drifted into a second kind, and an export that no longer exists cannot
  // drift. `tsc` is the tripwire now — a re-import of the old name fails the build outright, which is
  // strictly stronger than the runtime equality this asserted.
});

describe('RelayClient — blobs ingest on demand but are never requested in bulk', () => {
  function connect(): {client: RelayClient; socket: FakeRelaySocket; store: InMemoryEventStore} {
    const store = new InMemoryEventStore();
    const socket = new FakeRelaySocket();
    // Default kinds (SUBSCRIBED_KINDS) on purpose: this asserts what the REAL production kind set
    // asks for, not a hand-picked one that could pass while the real list regressed.
    const client = new RelayClient(socket, store, {verify: () => true});
    socket.simulateOpen();
    return {client, socket, store};
  }

  it('never names a blob kind in any subscription it opens', () => {
    const {socket} = connect();
    const reqs = socket.sent.filter(m => m.startsWith('["REQ"'));
    expect(reqs.length).toBeGreaterThan(0);
    for (const raw of reqs) {
      const [, , ...filters] = JSON.parse(raw) as [string, string, ...{kinds?: number[]}[]];
      for (const f of filters) {
        expect(f.kinds ?? []).not.toContain(KIND_MEDIA_BLOB);
      }
    }
  });

  it('ACCEPTS a blob that arrives on an id-scoped fetch (the tap path)', () => {
    // The mirror image of the above: off the firehose, but ingestible — otherwise a tapped picture
    // could be fetched and then thrown away at the gate.
    const {client, store} = connect();
    const blob = makeBlob();
    expect(client.ingest(blob)).toBe(true);
    expect(store.has(blob.id)).toBe(true);
  });

  it('fetchById issues exactly one id-scoped REQ naming the blob and no kinds', () => {
    const {client, socket} = connect();
    const blob = makeBlob();
    const before = socket.sent.length;
    client.fetchById([blob.id]);

    const reqs = socket.sent.slice(before).filter(m => m.startsWith('["REQ"'));
    expect(reqs).toHaveLength(1);
    const [, , filter] = JSON.parse(reqs[0]!) as [string, string, {ids?: string[]; kinds?: number[]}];
    expect(filter.ids).toEqual([blob.id]);
    // Scoped by id ALONE — a kinds filter would tell the relay it is serving media.
    expect(filter.kinds).toBeUndefined();
  });

  it('fetches MULTIPLE ids in one REQ — the seam a decoy cover set plugs into unchanged', () => {
    const {client, socket} = connect();
    const ids = [makeBlob('UAAA').id, makeBlob('UBBB').id, makeBlob('UCCC').id];
    const before = socket.sent.length;
    client.fetchById(ids);

    const reqs = socket.sent.slice(before).filter(m => m.startsWith('["REQ"'));
    expect(reqs).toHaveLength(1);
    const [, , filter] = JSON.parse(reqs[0]!) as [string, string, {ids: string[]}];
    expect(filter.ids).toEqual(ids);
  });

  it('rejects a kind that is on no list at all (the gate still bites)', () => {
    const {client} = connect();
    const junk = finalizeEvent({kind: 31337, created_at: 1, tags: [], content: 'x'}, generateSecretKey());
    expect(client.ingest(junk)).toBe(false);
  });
});
