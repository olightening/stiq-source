import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {
  createMediaBlobService,
  getMediaBlobService,
  loadMediaSource,
  MediaBlobFetchError,
  setMediaBlobService,
  type MediaBlobDeps,
} from './mediaBlobService';
import {buildMediaBlobEvent, encodeBlobTail, parseMediaSource} from '../feed/mediaBlob';
import {FETCH_TIMEOUT_MS} from '../nostr/RelayClient';

function makeBlob(payload: string): Event {
  const b = buildMediaBlobEvent(payload);
  return finalizeEvent({kind: b.kind, created_at: b.created_at, tags: b.tags, content: b.content}, generateSecretKey());
}

/**
 * A relay+store fake. `fetchById` records the ids asked for and delivers nothing until the test says
 * so — which is the point: it lets us assert the honest timeout instead of assuming success.
 */
function fakeDeps(opts: {connected?: boolean} = {}) {
  const store = new Map<string, Event>();
  const listeners = new Set<(e: Event) => void>();
  const requested: string[][] = [];
  const deps: MediaBlobDeps = {
    getById: id => store.get(id),
    fetchById: ids => {
      requested.push([...ids]);
    },
    onEvent: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isConnected: () => opts.connected ?? true,
  };
  return {
    deps,
    requested,
    /** Pre-seed the store, as if the blob were already fetched or locally published. */
    put: (e: Event) => store.set(e.id, e),
    /** Simulate the relay delivering an event on the open fetch REQ (ingest → store + notify). */
    deliver: (e: Event) => {
      store.set(e.id, e);
      for (const cb of [...listeners]) cb(e);
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  setMediaBlobService(null);
  jest.useRealTimers();
});

describe('fetch by IDS', () => {
  it('asks the relay for exactly the ids it does not already hold', async () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const blob = makeBlob('UAAA');

    const p = svc.fetchBlobs([blob.id]);
    expect(f.requested).toEqual([[blob.id]]);

    f.deliver(blob);
    await expect(p).resolves.toEqual(new Map([[blob.id, 'UAAA']]));
  });

  it('fetches an ARRAY — several ids in one request (the decoy-cover seam)', async () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const a = makeBlob('UAAA');
    const b = makeBlob('UBBB');
    const c = makeBlob('UCCC');

    const p = svc.fetchBlobs([a.id, b.id, c.id]);
    expect(f.requested).toEqual([[a.id, b.id, c.id]]);

    f.deliver(a);
    f.deliver(b);
    f.deliver(c);
    const got = await p;
    expect(got.get(a.id)).toBe('UAAA');
    expect(got.get(c.id)).toBe('UCCC');
  });

  it('resolves the ids that arrived even when others never do', async () => {
    // A partial result is still useful: the caller only needs the one id it actually wanted, and
    // decoys are expected to be discarded.
    jest.useFakeTimers();
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const a = makeBlob('UAAA');
    const missing = makeBlob('UZZZ');

    const p = svc.fetchBlobs([a.id, missing.id]);
    f.deliver(a);
    jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);

    const got = await p;
    expect(got.get(a.id)).toBe('UAAA');
    expect(got.has(missing.id)).toBe(false);
  });

  it('never re-requests a blob it already holds — the event store IS the cache', async () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const blob = makeBlob('UAAA');
    f.put(blob);

    await expect(svc.fetchBlobs([blob.id])).resolves.toEqual(new Map([[blob.id, 'UAAA']]));
    // The whole point: a scroll past an already-fetched picture must not touch Tor again.
    expect(f.requested).toEqual([]);
  });

  it('collapses a double-tap into ONE request', async () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const blob = makeBlob('UAAA');

    const p1 = svc.fetchBlobs([blob.id]);
    const p2 = svc.fetchBlobs([blob.id]);
    expect(f.requested).toHaveLength(1);

    f.deliver(blob);
    await Promise.all([p1, p2]);
  });

  it('unsubscribes its arrival listener once settled (no listener leak on the ingest hot path)', async () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const blob = makeBlob('UAAA');

    const p = svc.fetchBlobs([blob.id]);
    expect(f.listenerCount()).toBe(1);
    f.deliver(blob);
    await p;
    expect(f.listenerCount()).toBe(0);
  });

  it('peek reads the store synchronously and never fetches', () => {
    const f = fakeDeps();
    const svc = createMediaBlobService(f.deps);
    const blob = makeBlob('UAAA');
    expect(svc.peek(blob.id)).toBeNull();
    f.put(blob);
    expect(svc.peek(blob.id)).toBe('UAAA');
    expect(f.requested).toEqual([]);
  });
});

describe('loadMediaSource', () => {
  it('resolves an inline source immediately, with no service and no network', async () => {
    // Legacy bodies must render even before Tor is up — their bytes are already in hand.
    setMediaBlobService(null);
    await expect(loadMediaSource({kind: 'inline', payloadBase64: 'UAAA'})).resolves.toBe('UAAA');
  });

  it('resolves a blob source through a real fetch', async () => {
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const blob = makeBlob('UAAA');

    const p = loadMediaSource({kind: 'blob', blobId: blob.id});
    f.deliver(blob);
    await expect(p).resolves.toBe('UAAA');
  });

  it('passes cover ids alongside the wanted blob, and returns only the wanted one', async () => {
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const want = makeBlob('UWANT');
    const decoy = makeBlob('UDECOY');

    const p = loadMediaSource({kind: 'blob', blobId: want.id}, {cover: [decoy.id]});
    expect(f.requested[0]).toEqual([want.id, decoy.id]);

    f.deliver(want);
    f.deliver(decoy);
    await expect(p).resolves.toBe('UWANT');
  });

  it('fails "offline" when no service is bound (tests / pre-Tor) rather than hanging', async () => {
    setMediaBlobService(null);
    await expect(loadMediaSource({kind: 'blob', blobId: 'a'.repeat(64)})).rejects.toBeInstanceOf(MediaBlobFetchError);
    await expect(loadMediaSource({kind: 'blob', blobId: 'a'.repeat(64)})).rejects.toMatchObject({reason: 'offline'});
  });

  it('fails "offline" FAST when the relay is down — without burning the full deadline', async () => {
    const f = fakeDeps({connected: false});
    setMediaBlobService(createMediaBlobService(f.deps));
    await expect(loadMediaSource({kind: 'blob', blobId: 'a'.repeat(64)})).rejects.toMatchObject({reason: 'offline'});
    expect(f.requested).toEqual([]); // never even attempted
  });

  it('fails "timeout" when the blob never arrives — the real, routine Tor failure', async () => {
    jest.useFakeTimers();
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));

    const p = loadMediaSource({kind: 'blob', blobId: 'a'.repeat(64)});
    const assertion = expect(p).rejects.toMatchObject({reason: 'timeout'});
    jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does not give up before the REQ itself does', async () => {
    jest.useFakeTimers();
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const blob = makeBlob('USLOW');

    const p = loadMediaSource({kind: 'blob', blobId: blob.id});
    // Just shy of the deadline the fetch must still be open — reporting failure while the bytes are
    // in flight over a slow circuit would be its own kind of lie.
    jest.advanceTimersByTime(FETCH_TIMEOUT_MS - 1);
    f.deliver(blob);
    await expect(p).resolves.toBe('USLOW');
  });

  it('fails "malformed" (not "timeout") when the blob arrives corrupt', async () => {
    // The distinction is real: a timeout is worth retrying, corrupt bytes never are.
    jest.useFakeTimers();
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const bad = finalizeEvent({kind: 30351, created_at: 1, tags: [], content: 'not base64!!'}, generateSecretKey());

    const p = loadMediaSource({kind: 'blob', blobId: bad.id});
    const assertion = expect(p).rejects.toMatchObject({reason: 'malformed'});
    f.deliver(bad);
    jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    await assertion;
  });

  it('resolves from the store without a fetch once a blob has been pulled once', async () => {
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const blob = makeBlob('UAAA');

    const first = loadMediaSource({kind: 'blob', blobId: blob.id});
    f.deliver(blob);
    await first;

    await expect(loadMediaSource({kind: 'blob', blobId: blob.id})).resolves.toBe('UAAA');
    expect(f.requested).toHaveLength(1); // still just the one, original REQ
  });
});

describe('service binding', () => {
  it('is null until bound and null again after teardown', () => {
    expect(getMediaBlobService()).toBeNull();
    const svc = createMediaBlobService(fakeDeps().deps);
    setMediaBlobService(svc);
    expect(getMediaBlobService()).toBe(svc);
    setMediaBlobService(null);
    expect(getMediaBlobService()).toBeNull();
  });
});

describe('end-to-end: a body token → fetched bytes', () => {
  it('takes a blob-referencing token all the way to its payload', async () => {
    const f = fakeDeps();
    setMediaBlobService(createMediaBlobService(f.deps));
    const blob = makeBlob('UPAYLOAD');

    // Exactly what extractInlinePictures hands a chip on tap.
    const source = parseMediaSource(encodeBlobTail(blob.id));
    const p = loadMediaSource(source);
    f.deliver(blob);
    await expect(p).resolves.toBe('UPAYLOAD');
  });
});
