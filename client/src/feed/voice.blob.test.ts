/**
 * Voice on the SHARED lazy-blob transport (the mechanism pictures ride — feed/mediaBlob.ts).
 *
 * Two things are pinned here, and the first matters more than the second:
 *
 *   1. BACKWARD COMPATIBILITY, in BOTH legacy forms. Every voice clip already published carries its
 *      base64 INLINE — either inside a `[[voice:…]]` body token or as a standalone kind-1222 event
 *      whose whole content is a `data:` URI. Every user's local SQLite cache is full of both. They
 *      must keep parsing and playing forever, with no fetch and no migration. This is not a
 *      transitional concern, and it did not stop being one when LAZY_MEDIA_BLOBS flipped ON
 *      (2026-07-15). It got MORE permanent, for three reasons that have no end date: every clip
 *      composed by every build shipped before the flip is inline and immutable on the relay; a
 *      member on an older APK keeps composing inline into the same community feed; and the OFF
 *      rollback (still supported, still tested) composes inline again. A blob-only reader would go
 *      deaf on all three.
 *   2. The new blob-reference form parses through the same path to the same shape, so the player
 *      cannot tell the two apart.
 */
import {
  countInlineVoices,
  decodeVoicePayload,
  voiceDecoderFor,
  encodeInlineVoice,
  extractInlineVoices,
  hasInlineVoice,
  inlineVoiceSummary,
  parseVoiceMessage,
  stripInlineVoices,
  KIND_VOICE_MESSAGE,
  MAX_VOICE_BYTES,
  type VoiceMessage,
} from './voice';
import {segmentInlineMedia, bodyForMeasure, countInlineMedia, labelInlineMedia} from './inlineMedia';
import {encodeBlobTail, splitMediaBlobs, type UnsignedMediaBlob} from './mediaBlob';
import type {Event} from 'nostr-tools/pure';

const BLOB_ID = 'd'.repeat(64);
const AUDIO = 'QUJDREVGRw=='; // 12 base64 chars → 8 decoded bytes

/** The LEGACY on-the-wire form: audio inline in the body. Exactly what is already published. */
function legacyToken(audio = AUDIO): string {
  return encodeInlineVoice({
    source: {kind: 'inline', payloadBase64: audio},
    mimeType: 'audio/mp4',
    durationSec: 12,
    waveform: [0.1, 0.8, 0.4],
    weightBytes: audio.length,
  });
}

/** The NEW form: player metadata + real byte weight + a reference to the blob holding the audio. */
function blobToken(weight = 4096): string {
  return `[[voice:audio/mp4;12;wf=0.10,0.80,0.40;w=${weight};${encodeBlobTail(BLOB_ID)}]]`;
}

/** A standalone voice event (kind 1222) — the other legacy form, whose content IS a data: URI. */
function standaloneEvent(audio = AUDIO): Event {
  return {
    kind: KIND_VOICE_MESSAGE,
    created_at: 100,
    tags: [['duration', '12'], ['waveform', '0.10', '0.80', '0.40']],
    content: `data:audio/mp4;base64,${audio}`,
    id: 'id',
    pubkey: 'p'.repeat(64),
    sig: 's',
  } as Event;
}

describe('backward compatibility — legacy inline voice in a body token', () => {
  it('still extracts, with its audio in hand and no fetch implied', () => {
    const [v] = extractInlineVoices(`listen ${legacyToken()} thoughts?`);
    expect(v!.mimeType).toBe('audio/mp4');
    expect(v!.durationSec).toBe(12);
    expect(v!.waveform).toEqual([0.1, 0.8, 0.4]);
    expect(v!.source).toEqual({kind: 'inline', payloadBase64: AUDIO});
  });

  it('still meters its weight as the base64 payload length', () => {
    const [v] = extractInlineVoices(legacyToken());
    expect(v!.weightBytes).toBe(AUDIO.length);
  });

  it('still strips, counts, summarises and labels', () => {
    const body = `a ${legacyToken()} b`;
    expect(stripInlineVoices(body)).toBe('a  b');
    expect(countInlineVoices(body)).toBe(1);
    expect(hasInlineVoice(body)).toBe(true);
    expect(inlineVoiceSummary(legacyToken())).toBe('🎙️ Voice message');
    expect(labelInlineMedia(legacyToken())).toBe('🎙 voice');
  });

  it('still segments in place, so the player renders where it sits in the text', () => {
    const segments = segmentInlineMedia(`before ${legacyToken()} after`);
    expect(segments.map(s => s.type)).toEqual(['text', 'voice', 'text']);
  });

  it('still refuses an oversized inline token (the hostile-payload cap is unchanged)', () => {
    expect(extractInlineVoices(legacyToken('A'.repeat(MAX_VOICE_BYTES * 2)))).toHaveLength(0);
  });

  it('a token written by the OLD encoder (no w= field) parses byte-identically', () => {
    // The literal pre-blob grammar, hard-coded rather than generated — so this keeps testing the old
    // wire form even if the encoder changes again.
    const [v] = extractInlineVoices(`[[voice:audio/mp4;12;wf=0.10,0.80,0.40;${AUDIO}]]`);
    expect(v!.source).toEqual({kind: 'inline', payloadBase64: AUDIO});
    expect(v!.weightBytes).toBe(AUDIO.length);
    expect(v!.durationSec).toBe(12);
  });
});

describe('backward compatibility — legacy standalone voice post (kind 1222 data: URI)', () => {
  it('parses to an inline source, so it plays with no fetch', () => {
    const v = parseVoiceMessage(standaloneEvent());
    expect(v!.source).toEqual({kind: 'inline', payloadBase64: AUDIO});
    expect(v!.durationSec).toBe(12);
    expect(v!.waveform).toEqual([0.1, 0.8, 0.4]);
  });

  it('its payload validates, so PostCard can play it straight through the shared machine', () => {
    const v = parseVoiceMessage(standaloneEvent());
    expect(decodeVoicePayload((v!.source as {payloadBase64: string}).payloadBase64)).toBe(AUDIO);
  });

  it('is NOT size-capped — an oversized clip that already arrived stays playable', () => {
    // Deliberate asymmetry with the body token, and unchanged from before this round: the bytes are
    // already on the device, so refusing to play them would cost the user a download they already
    // paid for over Tor and save nothing. Pinned end-to-end (parse AND decode), because capping only
    // the decoder would silently stop these posts playing while parse still looked fine.
    const big = 'A'.repeat(MAX_VOICE_BYTES * 2);
    const v = parseVoiceMessage(standaloneEvent(big));
    expect(v).not.toBeNull();
    expect(voiceDecoderFor(v!.source)(big)).toBe(big);
  });
});

describe('voiceDecoderFor — the cap applies to what we FETCH, not to what already arrived', () => {
  it('caps a blob-backed clip: a legitimate blob is always under the cap, so an oversized one is hostile', () => {
    const big = 'A'.repeat(MAX_VOICE_BYTES * 2);
    expect(voiceDecoderFor({kind: 'blob', blobId: BLOB_ID})(big)).toBeNull();
    expect(decodeVoicePayload(big)).toBeNull();
  });

  it('does NOT cap an inline clip — the bytes rode in with the event', () => {
    const big = 'A'.repeat(MAX_VOICE_BYTES * 2);
    expect(voiceDecoderFor({kind: 'inline', payloadBase64: big})(big)).toBe(big);
  });

  it('rejects non-base64 in both forms — nothing unreadable reaches the native player', () => {
    expect(voiceDecoderFor({kind: 'blob', blobId: BLOB_ID})('<html>nope</html>')).toBeNull();
    expect(voiceDecoderFor({kind: 'inline', payloadBase64: 'x'})('<html>nope</html>')).toBeNull();
  });
});

describe('the new blob-reference form', () => {
  it('parses to a blob source carrying no audio', () => {
    const [v] = extractInlineVoices(blobToken());
    expect(v!.source).toEqual({kind: 'blob', blobId: BLOB_ID});
  });

  it('keeps the player metadata, so an idle bar renders with zero network', () => {
    // This is what makes a lazy clip look like a real one: duration + waveform ride in the token.
    const [v] = extractInlineVoices(blobToken());
    expect(v!.mimeType).toBe('audio/mp4');
    expect(v!.durationSec).toBe(12);
    expect(v!.waveform).toEqual([0.1, 0.8, 0.4]);
  });

  it('reports the REAL payload weight from w=, not the length of the reference', () => {
    // The fail-open trap: a blob tail is 72 chars, so anything metering the tail would meter ~0.
    const [v] = extractInlineVoices(blobToken(199_000));
    expect(v!.weightBytes).toBe(199_000);
    expect(v!.weightBytes).not.toBe(encodeBlobTail(BLOB_ID).length);
  });

  it('is indistinguishable from an inline clip to every body-level helper', () => {
    // The whole point of reusing the token grammar: nothing downstream had to learn a new shape —
    // including the RELAY, which counts a post's media by this same grammar.
    const body = `a ${blobToken()} b`;
    expect(stripInlineVoices(body)).toBe('a  b');
    expect(countInlineVoices(body)).toBe(1);
    expect(countInlineMedia(body)).toBe(1);
    expect(hasInlineVoice(body)).toBe(true);
    expect(bodyForMeasure(body)).toBe('a  b');
    expect(inlineVoiceSummary(blobToken())).toBe('🎙️ Voice message');
    expect(labelInlineMedia(blobToken())).toBe('🎙 voice');
    expect(segmentInlineMedia(body).map(s => s.type)).toEqual(['text', 'voice', 'text']);
  });

  it('round-trips through the encoder without losing its weight', () => {
    const [v] = extractInlineVoices(blobToken(4096));
    expect(encodeInlineVoice(v!)).toBe(blobToken(4096));
  });
});

describe('splitMediaBlobs moves a composed clip onto the blob transport', () => {
  /** Stand-in for the throwaway-key signer AppRuntime injects; ids need only be distinct 64-hex. */
  function signer(): (b: UnsignedMediaBlob) => Event {
    let n = 0;
    return b => ({...b, id: String(++n).padStart(64, 'a'), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128)} as Event);
  }

  it('lifts the audio out of the body and leaves a reference the extractor still understands', () => {
    // THE END-TO-END CLAIM: compose inline → split at publish → parse back to a lazy clip. If the
    // voice regex ever stops accepting `w=`, this token stops matching and the raw base64 renders as
    // TEXT in the feed — which is why the grammar and the splitter are pinned together here.
    const {blobs, body} = splitMediaBlobs(`hi ${legacyToken()}`, signer());
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.content).toBe(AUDIO);
    expect(body).not.toContain(AUDIO);

    const [v] = extractInlineVoices(body);
    expect(v!.source).toEqual({kind: 'blob', blobId: blobs[0]!.id});
    expect(v!.weightBytes).toBe(AUDIO.length); // metering the audio, not the pointer
    expect(v!.durationSec).toBe(12);
    expect(v!.waveform).toEqual([0.1, 0.8, 0.4]);
  });

  it('leaves a body that is already blob-backed alone (idempotent)', () => {
    const {blobs, body} = splitMediaBlobs(`hi ${blobToken()}`, signer());
    expect(blobs).toHaveLength(0);
    expect(body).toContain(encodeBlobTail(BLOB_ID));
  });

  it('splits a mixed picture+voice body with one transport and no per-modality branch', () => {
    const {blobs} = splitMediaBlobs(`${legacyToken()} and [[pic:2;2;l=cat;UAAA]]`, signer());
    expect(blobs).toHaveLength(2);
    // ONE generic blob kind for both, so the relay learns "media" and never WHICH media.
    expect(new Set(blobs.map(b => b.kind)).size).toBe(1);
  });
});

describe('decodeVoicePayload — the only place fetched audio is bounded', () => {
  it('accepts a well-formed payload and hands back exactly the bytes native plays', () => {
    expect(decodeVoicePayload(AUDIO)).toBe(AUDIO);
  });

  it('rejects empty and non-base64 payloads', () => {
    expect(decodeVoicePayload('')).toBeNull();
    expect(decodeVoicePayload('not base64!!')).toBeNull();
    expect(decodeVoicePayload('<html>nope</html>')).toBeNull();
  });

  it('rejects an oversized payload — a blob-backed clip is capped HERE, not at parse', () => {
    // A blob's bytes arrive after the token was parsed, and `w=` is author-supplied, so this is the
    // only point at which a hostile clip can be stopped before it reaches the native player.
    expect(decodeVoicePayload('A'.repeat(MAX_VOICE_BYTES * 2))).toBeNull();
  });
});

describe('mixed bodies', () => {
  it('renders a legacy clip and a blob-backed clip side by side, in order', () => {
    const voices: VoiceMessage[] = extractInlineVoices(`${legacyToken()} then ${blobToken()}`);
    expect(voices.map(v => v.source.kind)).toEqual(['inline', 'blob']);
  });

  it('a body holding both eras still counts as exactly two media against the per-post cap', () => {
    expect(countInlineMedia(`${legacyToken()} ${blobToken()}`)).toBe(2);
  });
});
