/**
 * The chip's load is REAL now. These tests pin the two halves of that:
 *   • the fake `780 + random*480` ms delay is gone — an inline picture no longer pretends to fetch;
 *   • a blob-backed picture genuinely waits on a relay REQ, and genuinely fails when it never lands.
 *
 * The CONTINUITY of the tap→preview transition is pinned separately, in
 * `PictureChip.transition.test.tsx`.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {PictureChip} from './PictureChip';
import {encodeInlinePicture, extractInlinePictures} from '../picture';
import {buildMediaBlobEvent, encodeBlobTail} from '../mediaBlob';
import {createMediaBlobService, setMediaBlobService, type MediaBlobDeps} from '../../media/mediaBlobService';
import {clearRenderedMedia} from '../../media/renderedMediaCache';
import {FETCH_TIMEOUT_MS} from '../../nostr/RelayClient';
import type {InlinePicture} from '../picture';

const PIXELS = {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])};

/** The blob event holding a real picture payload, plus the token that references it. */
function blobBacked(): {blob: Event; picture: InlinePicture} {
  const inline = encodeInlinePicture(PIXELS, 'none', 'cat');
  const payload = (extractInlinePictures(inline)[0]!.source as {payloadBase64: string}).payloadBase64;
  const b = buildMediaBlobEvent(payload);
  const blob = finalizeEvent({kind: b.kind, created_at: b.created_at, tags: b.tags, content: b.content}, generateSecretKey());
  const [picture] = extractInlinePictures(`[[pic:2;2;l=cat;w=${payload.length};${encodeBlobTail(blob.id)}]]`);
  return {blob, picture: picture!};
}

function inlinePicture(): InlinePicture {
  return extractInlinePictures(encodeInlinePicture(PIXELS, 'none', 'cat'))[0]!;
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

/** Mount a chip and give it a width (onLayout never fires under react-test-renderer). */
function mount(picture: InlinePicture): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<PictureChip picture={picture} />);
  });
  act(() => {
    tree!.root.findByProps({accessibilityLabel: 'picture-chip'}).props.onLayout({nativeEvent: {layout: {width: 300, height: 40, x: 0, y: 0}}});
  });
  return tree!;
}

function tap(tree: renderer.ReactTestRenderer): void {
  act(() => {
    tree.root.findByProps({accessibilityLabel: 'picture-chip'}).props.onPress();
  });
}

/** The visible text of the whole card, joined — what the viewer actually reads. */
function textOf(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as never)
    .flatMap(n => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter(c => typeof c === 'string')
    .join(' ');
}

function isLoading(tree: renderer.ReactTestRenderer): boolean {
  return textOf(tree).includes('Fetching over Tor');
}

/**
 * The chip's pressable bar. `findAllByProps` matches the composite AND its host nodes, so one chip
 * yields several entries — [0] is the composite, whose props are the ones passed in.
 *
 * NOTE: the bar is now mounted in EVERY state (see PictureChip's header — one frame, never swapped),
 * so its presence says nothing about the load. `showsChipBar` asks the real question.
 */
function chipBar(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAllByProps({accessibilityLabel: 'picture-chip'});
}

/** True while the frame is resting as a chip (idle or a settled error) rather than as the stage. */
function showsChipBar(tree: renderer.ReactTestRenderer): boolean {
  return tree.root.findAllByProps({accessibilityLabel: 'picture-stage'}).length === 0;
}

/** True once the decoded pixel-art is genuinely painted into the stage. */
function isPainted(tree: renderer.ReactTestRenderer): boolean {
  return tree.root.findAllByProps({accessibilityLabel: 'picture-image'}).length > 0;
}

/** Let the expand/collapse tween — and its completion callback — run out. */
function settleAnim(): void {
  act(() => {
    jest.advanceTimersByTime(800);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  setMediaBlobService(null);
});

describe('the fake "Fetching over Tor…" delay is gone', () => {
  it('an inline picture loads on its own, without any timer being advanced', async () => {
    // THE REGRESSION TEST. The old code held "Fetching over Tor…" up for a hardcoded 780-1260ms
    // while the bytes sat in memory. If that timer ever comes back, this fails: nothing here
    // advances the clock, yet the picture must be fully PAINTED — the assertion is on the pixels
    // being on screen, not merely on the absence of a caption, so it still bites even though an
    // inline load no longer shows the caption at all.
    setMediaBlobService(null); // deliberately unbound — an inline picture needs no service at all
    const tree = mount(inlinePicture());
    tap(tree);
    await act(async () => {});

    expect(isPainted(tree)).toBe(true);
    expect(isLoading(tree)).toBe(false);
    expect(showsChipBar(tree)).toBe(false); // expanded to the stage, i.e. loaded
  });

  it('never claims to fetch a picture whose bytes are already on the device', async () => {
    // The caption states a fact. An inline picture crosses no network, so it must not say it did —
    // that is the original lie, shrunk to a single frame. Asserted while the load is IN FLIGHT (the
    // hook's `loading` state is entered synchronously on tap), which is the only window it could
    // appear in.
    setMediaBlobService(null);
    const tree = mount(inlinePicture());
    tap(tree);
    expect(isLoading(tree)).toBe(false); // mid-load, and still not pretending
    await act(async () => {});
    expect(isPainted(tree)).toBe(true);
  });

  it('re-decodes a blob already in the store without a REQ, and without claiming Tor', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, picture} = blobBacked();
    relay.deliver(blob); // already in the store, exactly as it would be after a first load

    const tree = mount(picture);
    tap(tree);
    expect(isLoading(tree)).toBe(false); // no ring, no caption — nothing is being fetched
    await act(async () => {});

    expect(isPainted(tree)).toBe(true);
    expect(relay.requested).toEqual([]);
  });

  it('re-tapping after Settings clears the rendered media re-decodes locally — it does not re-fetch', async () => {
    // The whole round trip, because this is the contract the blob split rests on: the rendered-media
    // cache holds the DECODED artifact, the durable event store holds the blob. Clearing the former
    // must revert the card to tap-to-load without throwing away the bytes — otherwise every clear
    // would silently cost the viewer another trip over Tor for pictures they already have.
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {
      relay.deliver(blob);
    });
    expect(isPainted(tree)).toBe(true);
    expect(relay.requested).toHaveLength(1); // one real fetch, as it should be

    act(() => {
      clearRenderedMedia();
    });
    settleAnim();
    expect(showsChipBar(tree)).toBe(true); // back to a quiet tap-to-load chip
    expect(isPainted(tree)).toBe(false);

    tap(tree);
    expect(isLoading(tree)).toBe(false); // and it does not pretend to fetch what it still has
    await act(async () => {});
    expect(isPainted(tree)).toBe(true);
    expect(relay.requested).toHaveLength(1); // STILL one — the re-tap never left the device
  });
});

describe('a blob-backed picture really fetches', () => {
  it('asks the relay for exactly its blob id, once tapped — and not before', () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, picture} = blobBacked();

    const tree = mount(picture);
    // Rendering a feed full of pictures must cost NOTHING on the network. This is the user's bug.
    expect(relay.requested).toEqual([]);

    tap(tree);
    expect(relay.requested).toEqual([[blob.id]]);
  });

  it('stays in the loading state until the bytes actually arrive, then paints', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {});
    expect(isLoading(tree)).toBe(true); // genuinely waiting on Tor — not on a timer

    await act(async () => {
      relay.deliver(blob);
    });
    expect(isLoading(tree)).toBe(false);
    expect(showsChipBar(tree)).toBe(false);
  });

  it('shows an honest, retryable failure when the fetch times out', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });

    // Collapsed back to a chip that says what happened and invites another go — rather than a
    // spinner that spins forever over a circuit that already gave up.
    expect(isLoading(tree)).toBe(false);
    expect(textOf(tree)).toContain("Couldn't fetch picture");
    expect(textOf(tree)).toContain('tap to retry');
    expect(textOf(tree)).toContain('↻'); // ↻ — VoicePlayer's glyph for "another go could work"
    expect(chipBar(tree)[0]!.props.disabled).toBe(false);
    settleAnim(); // the retreat is animated too — let it land back on the chip
    expect(showsChipBar(tree)).toBe(true);
  });

  it('a retry after a timeout issues a genuinely new request', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });
    expect(relay.requested).toHaveLength(1);
    settleAnim();

    tap(tree);
    expect(relay.requested).toHaveLength(2);

    await act(async () => {
      relay.deliver(blob);
    });
    expect(isLoading(tree)).toBe(false);
    expect(isPainted(tree)).toBe(true); // recovered
    expect(showsChipBar(tree)).toBe(false);
  });

  it('hands the chip back for a retry the moment it fails — not once the retreat has finished', async () => {
    // The failure and its ↻ are readable immediately; a tap on them must work immediately. If the
    // chip stayed inert for the length of the collapse tween, the viewer's first, natural retry —
    // the one they make while reading "tap to retry" — would be silently swallowed.
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });

    // Mid-retreat, before any timer for the collapse has been advanced.
    const layer = tree.root.findAllByProps({accessibilityLabel: 'picture-chip'})[0]!.parent!;
    expect(layer.props.pointerEvents).toBe('auto');
    expect(chipBar(tree)[0]!.props.disabled).toBe(false);
  });

  it('says "Not connected" — and does not pretend to fetch — while Tor is down', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService({...relay.deps, isConnected: () => false}));
    const {picture} = blobBacked();

    const tree = mount(picture);
    tap(tree);
    await act(async () => {});

    expect(textOf(tree)).toContain('Not connected');
    expect(relay.requested).toEqual([]);
    expect(chipBar(tree)[0]!.props.disabled).toBe(false); // worth retrying once Tor is back
  });

  it('stops inviting a retry when the bytes are corrupt (retrying can never help)', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {picture} = blobBacked();
    // A blob whose payload is well-formed base64 but not a valid picture binary: it fetches fine,
    // then fails to decode.
    const corrupt = finalizeEvent(
      {kind: 30351, created_at: 1, tags: [], content: 'QUJDREVG'},
      generateSecretKey(),
    );
    const withCorruptId = {...picture, source: {kind: 'blob' as const, blobId: corrupt.id}};

    const tree = mount(withCorruptId);
    tap(tree);
    await act(async () => {
      relay.deliver(corrupt);
    });

    // Word-for-word, glyph-for-glyph what VoicePlayer does with unplayable audio: ⚠ instead of ↻,
    // no retry invitation, and the press target disabled. One mechanism, one vocabulary.
    expect(textOf(tree)).toContain("Couldn't load picture");
    expect(textOf(tree)).not.toContain('tap to retry');
    expect(textOf(tree)).toContain('⚠'); // ⚠
    expect(textOf(tree)).not.toContain('↻'); // never ↻ — it would invite a tap that cannot work
    expect(chipBar(tree)[0]!.props.disabled).toBe(true);
  });
});
