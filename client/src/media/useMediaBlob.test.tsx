/**
 * The shared load-on-tap state machine, tested MODALITY-FREE — no picture, no voice, just the
 * lifecycle both consume. This is the contract Slot F (picture card) and Slot I (voice) build on, so
 * it is pinned here rather than only through one modality's component.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {useMediaBlob, type MediaLoad} from './useMediaBlob';
import {createMediaBlobService, setMediaBlobService, type MediaBlobDeps} from './mediaBlobService';
import {buildMediaBlobEvent} from '../feed/mediaBlob';
import {clearRenderedMedia} from './renderedMediaCache';
import {FETCH_TIMEOUT_MS} from '../nostr/RelayClient';
import type {MediaSource} from '../feed/mediaBlob';

function makeBlob(payload: string): Event {
  const b = buildMediaBlobEvent(payload);
  return finalizeEvent({kind: b.kind, created_at: b.created_at, tags: b.tags, content: b.content}, generateSecretKey());
}

function fakeRelay() {
  const store = new Map<string, Event>();
  const listeners = new Set<(e: Event) => void>();
  const requested: string[][] = [];
  const deps: MediaBlobDeps = {
    getById: id => store.get(id),
    fetchById: ids => void requested.push([...ids]),
    onEvent: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isConnected: () => true,
  };
  return {
    deps,
    requested,
    deliver: (e: Event) => {
      store.set(e.id, e);
      for (const cb of [...listeners]) cb(e);
    },
  };
}

/** Decode stand-in: uppercase the payload, or reject anything starting with 'BAD'. */
const decode = (p: string): string | null => (p.startsWith('BAD') ? null : p.toUpperCase());

/** Mount the hook and expose its latest value to the test. */
function harness(source: MediaSource, dec: (p: string) => string | null = decode) {
  const seen: {current: MediaLoad<string> | null} = {current: null};
  function Probe(): React.JSX.Element {
    seen.current = useMediaBlob(source, dec);
    return <Text>{seen.current.state}</Text>;
  }
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Probe />);
  });
  return {seen, tree: tree!};
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  setMediaBlobService(null);
});

describe('lifecycle', () => {
  it('starts idle, with nothing loaded and no error', () => {
    const {seen} = harness({kind: 'inline', payloadBase64: 'abc'});
    expect(seen.current!.state).toBe('idle');
    expect(seen.current!.value).toBeNull();
    expect(seen.current!.error).toBeNull();
  });

  it('idle → loading → loaded, handing back the DECODED artifact', async () => {
    const {seen} = harness({kind: 'inline', payloadBase64: 'abc'});
    act(() => seen.current!.load());
    expect(seen.current!.state).toBe('loading');

    await act(async () => {});
    expect(seen.current!.state).toBe('loaded');
    expect(seen.current!.value).toBe('ABC');
  });

  it('decodes exactly ONCE per load (a 48KB unpack must not run on every render)', async () => {
    const dec = jest.fn(decode);
    const {seen, tree} = harness({kind: 'inline', payloadBase64: 'abc'}, dec);
    act(() => seen.current!.load());
    await act(async () => {});

    // Force extra renders; the artifact is cached in state, not recomputed.
    act(() => {
      tree.update(<Text>x</Text>);
    });
    expect(dec).toHaveBeenCalledTimes(1);
  });

  it('idle → loading → error on a failed fetch', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {seen} = harness({kind: 'blob', blobId: 'a'.repeat(64)});

    act(() => seen.current!.load());
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });
    expect(seen.current!.state).toBe('error');
    expect(seen.current!.error).toBe('timeout');
    expect(seen.current!.value).toBeNull();
  });

  it('lands in error:"decode" when the bytes arrive but cannot be read', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const bad = makeBlob('BADDATA');
    const {seen} = harness({kind: 'blob', blobId: bad.id});

    act(() => seen.current!.load());
    await act(async () => {
      relay.deliver(bad);
    });
    expect(seen.current!.state).toBe('error');
    expect(seen.current!.error).toBe('decode');
  });
});

describe('retry policy', () => {
  it('a transport failure is retryable, and load() genuinely retries', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const blob = makeBlob('later');
    const {seen} = harness({kind: 'blob', blobId: blob.id});

    act(() => seen.current!.load());
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });
    expect(seen.current!.retryable).toBe(true);

    act(() => seen.current!.load());
    await act(async () => {
      relay.deliver(blob);
    });
    expect(seen.current!.state).toBe('loaded');
    expect(seen.current!.value).toBe('LATER');
    expect(relay.requested).toHaveLength(2);
  });

  it('an undecodable payload is NOT retryable, and load() refuses — re-fetching cannot help', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const bad = makeBlob('BADDATA');
    const {seen} = harness({kind: 'blob', blobId: bad.id});

    act(() => seen.current!.load());
    await act(async () => {
      relay.deliver(bad);
    });
    expect(seen.current!.retryable).toBe(false);

    const before = relay.requested.length;
    act(() => seen.current!.load());
    expect(relay.requested).toHaveLength(before); // refused, per the documented contract
    expect(seen.current!.state).toBe('error');
  });

  it('a double-tap in one frame starts only ONE load', () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {seen} = harness({kind: 'blob', blobId: 'a'.repeat(64)});

    act(() => {
      seen.current!.load();
      seen.current!.load();
      seen.current!.load();
    });
    expect(relay.requested).toHaveLength(1);
  });
});

describe('reset', () => {
  it('returns a loaded chip to idle', async () => {
    const {seen} = harness({kind: 'inline', payloadBase64: 'abc'});
    act(() => seen.current!.load());
    await act(async () => {});
    expect(seen.current!.state).toBe('loaded');

    act(() => seen.current!.reset());
    expect(seen.current!.state).toBe('idle');
    expect(seen.current!.value).toBeNull();
  });

  it('clearing the rendered-media cache reverts a loaded chip to tap-to-load', async () => {
    const {seen} = harness({kind: 'inline', payloadBase64: 'abc'});
    act(() => seen.current!.load());
    await act(async () => {});

    act(() => {
      clearRenderedMedia();
    });
    expect(seen.current!.state).toBe('idle');
    expect(seen.current!.value).toBeNull();
  });

  it('clears a permanent failure, so a reset un-sticks a chip that had refused to retry', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const bad = makeBlob('BADDATA');
    const {seen} = harness({kind: 'blob', blobId: bad.id});

    act(() => seen.current!.load());
    await act(async () => {
      relay.deliver(bad);
    });
    // Stuck: load() is refused outright while the failure is known-permanent.
    act(() => seen.current!.load());
    expect(seen.current!.state).toBe('error');

    act(() => seen.current!.reset());
    act(() => seen.current!.load());
    // Un-stuck — the load runs again. It resolves straight from the store (the corrupt blob is
    // cached, so no second REQ is issued: re-pulling bytes we already hold would be pointless) and
    // lands back in `error: decode`, which is the honest outcome for a genuinely corrupt picture.
    expect(seen.current!.state).toBe('loading');
    await act(async () => {});
    expect(seen.current!.state).toBe('error');
    expect(seen.current!.error).toBe('decode');
    expect(relay.requested).toHaveLength(1);
  });
});
