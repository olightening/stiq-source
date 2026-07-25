/**
 * Voice loads on tap now, through the SAME machine pictures use. These tests pin the halves that
 * matter:
 *   • rendering a clip costs NOTHING — no payload parsed, no REQ issued — until play is pressed;
 *   • a blob-backed clip genuinely waits on a relay REQ, then plays the bytes that arrive;
 *   • BOTH legacy forms (inline body token, standalone kind-1222 data: URI) still play, with no
 *     network at all;
 *   • a dropped Tor circuit is reported honestly and can be retried.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {VoicePlayer} from './VoicePlayer';
import {
  encodeInlineVoice,
  extractInlineVoices,
  parseVoiceMessage,
  KIND_VOICE_MESSAGE,
  MAX_VOICE_BYTES,
  type VoiceMessage,
} from '../voice';
import {buildMediaBlobEvent, encodeBlobTail} from '../mediaBlob';
import {createMediaBlobService, setMediaBlobService, type MediaBlobDeps} from '../../media/mediaBlobService';
import {FETCH_TIMEOUT_MS} from '../../nostr/RelayClient';
import {playVoice, stopPlayback} from '../../media/voiceRecorder';

// The native audio module has no backing under Jest, so playback is faked at the JS bridge — which
// is also the seam that lets us assert WHICH bytes reached the player.
jest.mock('../../media/voiceRecorder', () => ({
  playVoice: jest.fn(() => Promise.resolve()),
  stopPlayback: jest.fn(() => Promise.resolve()),
}));

const mockPlayVoice = playVoice as jest.MockedFunction<typeof playVoice>;
const mockStopPlayback = stopPlayback as jest.MockedFunction<typeof stopPlayback>;

const AUDIO = 'QUJDREVGRw=='; // valid base64, 8 decoded bytes

/** A legacy inline clip — bytes riding in the body, exactly as every published post carries them. */
function inlineVoice(): VoiceMessage {
  return extractInlineVoices(
    encodeInlineVoice({
      source: {kind: 'inline', payloadBase64: AUDIO},
      mimeType: 'audio/mp4',
      durationSec: 12,
      waveform: [0.1, 0.8, 0.4],
      weightBytes: AUDIO.length,
    }),
  )[0]!;
}

/** The blob event holding the audio, plus the token that references it. */
function blobBacked(): {blob: Event; voice: VoiceMessage} {
  const b = buildMediaBlobEvent(AUDIO);
  const blob = finalizeEvent({kind: b.kind, created_at: b.created_at, tags: b.tags, content: b.content}, generateSecretKey());
  const [voice] = extractInlineVoices(`[[voice:audio/mp4;12;wf=0.10,0.80,0.40;w=${AUDIO.length};${encodeBlobTail(blob.id)}]]`);
  return {blob, voice: voice!};
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

function mount(voice: VoiceMessage): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<VoicePlayer voice={voice} />);
  });
  return tree!;
}

function playButton(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  return tree.root.findByProps({accessibilityLabel: 'voice-play'});
}

function press(tree: renderer.ReactTestRenderer): void {
  act(() => {
    playButton(tree).props.onPress();
  });
}

/** The visible text of the bar, joined — what the viewer actually reads. */
function textOf(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as never)
    .flatMap(n => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter(c => typeof c === 'string')
    .join(' ');
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPlayVoice.mockClear();
  mockStopPlayback.mockClear();
  mockPlayVoice.mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  jest.useRealTimers();
  setMediaBlobService(null);
});

describe('rendering a voice clip costs nothing until play is pressed', () => {
  it('issues no request and plays nothing on mount — the whole point of the change', () => {
    // THE USER'S BUG, at the leaf: a feed full of voice notes used to parse ~267KB of base64 EACH
    // and stage a full player, tapped or not.
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {voice} = blobBacked();

    mount(voice);

    expect(relay.requested).toEqual([]);
    expect(mockPlayVoice).not.toHaveBeenCalled();
  });

  it('still draws the duration and waveform at rest, straight from the token metadata', () => {
    // A lazy clip must not look like a stub: everything on the bar at rest rides in the token, so it
    // costs nothing and needs no audio.
    const {voice} = blobBacked();
    const tree = mount(voice);

    expect(textOf(tree)).toContain('0:12');
    // 28 waveform bars, drawn with no payload in hand.
    expect(tree.root.findAllByProps({accessibilityLabel: 'voice-play'}).length).toBeGreaterThan(0);
    expect(voice.source).toEqual({kind: 'blob', blobId: (voice.source as {blobId: string}).blobId});
  });
});

describe('a blob-backed clip really fetches, then plays', () => {
  it('asks the relay for exactly its blob id when play is pressed — and not before', () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    const tree = mount(voice);
    expect(relay.requested).toEqual([]);

    press(tree);
    expect(relay.requested).toEqual([[blob.id]]);
  });

  it('says it is fetching over Tor while it genuinely is', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {});

    // Unlike the old picture chip's hardcoded delay, this caption is up because a REQ is genuinely
    // outstanding — nothing here advances a timer to make it appear.
    expect(textOf(tree)).toContain('Fetching over Tor');
    expect(mockPlayVoice).not.toHaveBeenCalled();
  });

  it('plays automatically once the bytes land — one press means play, not "fetch, then press again"', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {
      relay.deliver(blob);
    });

    expect(mockPlayVoice).toHaveBeenCalledTimes(1);
    expect(mockPlayVoice).toHaveBeenCalledWith(AUDIO); // the bytes that came off the relay
    expect(textOf(tree)).not.toContain('Fetching over Tor');
  });

  it('does not re-fetch on a replay — the audio is already in hand', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {
      relay.deliver(blob);
    });
    // Let the clip finish so the button is back to ▶ rather than ■.
    await act(async () => {
      jest.advanceTimersByTime(13_000);
    });

    press(tree);
    await act(async () => {});

    expect(mockPlayVoice).toHaveBeenCalledTimes(2);
    expect(relay.requested).toHaveLength(1); // one REQ, two plays
  });

  it('stops the old audio when its row is recycled onto a different clip mid-playback', async () => {
    // FlatList reuses a row's component instance with new props. Without a reset, the previous
    // clip's audio would keep playing under a bar that now shows a DIFFERENT clip sitting at ▶.
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<VoicePlayer voice={voice} />);
    });
    act(() => {
      tree.root.findByProps({accessibilityLabel: 'voice-play'}).props.onPress();
    });
    await act(async () => {
      relay.deliver(blob);
    });
    expect(mockPlayVoice).toHaveBeenCalledTimes(1);

    // Same component instance, different clip — the row scrolled and got reused.
    await act(async () => {
      tree.update(<VoicePlayer voice={inlineVoice()} />);
    });

    expect(mockStopPlayback).toHaveBeenCalledTimes(1);
    expect(mockPlayVoice).toHaveBeenCalledTimes(1); // and the new clip did NOT auto-play
  });

  it('stops playback when pressed mid-clip instead of starting a second one', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {
      relay.deliver(blob);
    });
    expect(mockPlayVoice).toHaveBeenCalledTimes(1);

    press(tree); // now playing → this press means stop
    expect(mockStopPlayback).toHaveBeenCalledTimes(1);
    expect(mockPlayVoice).toHaveBeenCalledTimes(1);
  });
});

describe('backward compatibility — legacy clips still play, with no network', () => {
  it('an inline body-token clip plays without any service bound and without advancing a timer', async () => {
    // THE REGRESSION TEST. A legacy clip's bytes rode with the post; it must never need a fetch, a
    // service, or a delay. Nothing here binds a blob service or advances the clock.
    setMediaBlobService(null);
    const tree = mount(inlineVoice());

    press(tree);
    await act(async () => {});

    expect(mockPlayVoice).toHaveBeenCalledWith(AUDIO);
    expect(textOf(tree)).not.toContain("Couldn't");
  });

  it('a standalone kind-1222 data: URI post plays — the PostCard path', async () => {
    // PostCard mounts VoicePlayer directly from `item.voice` (feed.ts → parseVoiceMessage), bypassing
    // RichText entirely. That path must survive the change untouched.
    setMediaBlobService(null);
    const event = {
      kind: KIND_VOICE_MESSAGE,
      created_at: 100,
      tags: [['duration', '12']],
      content: `data:audio/mp4;base64,${AUDIO}`,
      id: 'id',
      pubkey: 'p'.repeat(64),
      sig: 's',
    } as Event;
    const voice = parseVoiceMessage(event)!;
    expect(voice.source).toEqual({kind: 'inline', payloadBase64: AUDIO});

    const tree = mount(voice);
    press(tree);
    await act(async () => {});

    expect(mockPlayVoice).toHaveBeenCalledWith(AUDIO);
  });

  it('an OVERSIZED standalone post still plays — the cap bounds what we fetch, not what arrived', async () => {
    // Regression guard for a trap in this change: routing every clip through the size-capped decoder
    // would have silently stopped legacy standalone posts over MAX_VOICE_BYTES from playing at all,
    // even though they play today and their bytes are already on the device.
    setMediaBlobService(null);
    const big = 'A'.repeat(MAX_VOICE_BYTES * 2);
    const event = {
      kind: KIND_VOICE_MESSAGE,
      created_at: 100,
      tags: [['duration', '90']],
      content: `data:audio/mp4;base64,${big}`,
      id: 'id',
      pubkey: 'p'.repeat(64),
      sig: 's',
    } as Event;

    const tree = mount(parseVoiceMessage(event)!);
    press(tree);
    await act(async () => {});

    expect(mockPlayVoice).toHaveBeenCalledWith(big);
    expect(textOf(tree)).not.toContain("Couldn't");
  });
});

describe('failure over Tor is routine, and honest', () => {
  it('reports a retryable failure when the fetch times out', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });

    expect(textOf(tree)).toContain("Couldn't fetch voice");
    expect(textOf(tree)).toContain('tap to retry');
    expect(playButton(tree).props.disabled).toBe(false);
    expect(mockPlayVoice).not.toHaveBeenCalled(); // never pretends to play what never arrived
  });

  it('a retry after a timeout issues a genuinely new request, and recovers', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {blob, voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {
      jest.advanceTimersByTime(FETCH_TIMEOUT_MS + 1);
    });
    expect(relay.requested).toHaveLength(1);

    press(tree);
    expect(relay.requested).toHaveLength(2);

    await act(async () => {
      relay.deliver(blob);
    });
    expect(mockPlayVoice).toHaveBeenCalledWith(AUDIO); // the retry played it
  });

  it('says "Not connected" — and does not pretend to fetch — while Tor is down', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService({...relay.deps, isConnected: () => false}));
    const {voice} = blobBacked();

    const tree = mount(voice);
    press(tree);
    await act(async () => {});

    expect(textOf(tree)).toContain('Not connected');
    expect(relay.requested).toEqual([]);
    expect(playButton(tree).props.disabled).toBe(false); // worth retrying once Tor is back
  });

  it('stops inviting a retry when the audio is corrupt (retrying can never help)', async () => {
    const relay = fakeRelay();
    setMediaBlobService(createMediaBlobService(relay.deps));
    const {voice} = blobBacked();
    // A blob that fetches fine but whose payload is not audio this build can accept — it is over the
    // size cap, so decodeVoicePayload rejects it. No amount of retrying changes that.
    const corrupt = finalizeEvent(
      {kind: 30351, created_at: 1, tags: [], content: 'A'.repeat(400 * 1024)},
      generateSecretKey(),
    );
    const withCorruptId: VoiceMessage = {...voice, source: {kind: 'blob', blobId: corrupt.id}};

    const tree = mount(withCorruptId);
    press(tree);
    await act(async () => {
      relay.deliver(corrupt);
    });

    expect(textOf(tree)).toContain("Couldn't load voice");
    expect(textOf(tree)).not.toContain('tap to retry');
    expect(playButton(tree).props.disabled).toBe(true);
    expect(mockPlayVoice).not.toHaveBeenCalled();
  });

  it('surfaces a native playback failure instead of silently doing nothing', async () => {
    // The bytes are fine; the device just wouldn't play them. This used to be swallowed whole — the
    // button flipped back to ▶ and the viewer was told nothing.
    setMediaBlobService(null);
    mockPlayVoice.mockImplementation(() => Promise.reject(new Error('no audio module')));

    const tree = mount(inlineVoice());
    press(tree);
    await act(async () => {});

    expect(textOf(tree)).toContain("Couldn't play voice");
  });
});
