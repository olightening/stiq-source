import {
  parseVoiceMessage,
  isVoiceEvent,
  base64ByteLength,
  encodeInlineVoice,
  extractInlineVoices,
  stripInlineVoices,
  hasInlineVoice,
  inlineVoiceSummary,
  KIND_VOICE_MESSAGE,
  MAX_VOICE_BYTES,
  type VoiceMessage,
} from './voice';
import type {Event} from 'nostr-tools/pure';

const AUDIO = 'AAAAAAAA'; // 6 decoded bytes, stand-in payload

/** A clip whose bytes are in hand — what the recorder produces and what every legacy body carries. */
function inlineClip(payloadBase64: string, over: Partial<VoiceMessage> = {}): VoiceMessage {
  return {
    source: {kind: 'inline', payloadBase64},
    mimeType: 'audio/mp4',
    durationSec: 12,
    weightBytes: payloadBase64.length,
    ...over,
  };
}

/** The audio a clip carries inline, or null when its bytes live in a blob. */
function payloadOf(voice: VoiceMessage): string | null {
  return voice.source.kind === 'inline' ? voice.source.payloadBase64 : null;
}

const sample: VoiceMessage = inlineClip(AUDIO, {waveform: [0.1, 0.8, 0.4]});

function sampleEvent(overrides?: Partial<Event>): Event {
  return {
    kind: KIND_VOICE_MESSAGE,
    created_at: 100,
    tags: [
      ['imeta', `url data:${sample.mimeType};base64,${AUDIO}`, `m ${sample.mimeType}`],
      ['duration', String(sample.durationSec)],
      ['waveform', ...(sample.waveform ?? []).map(n => n.toFixed(2))],
    ],
    content: `data:${sample.mimeType};base64,${AUDIO}`,
    id: 'id',
    pubkey: 'p'.repeat(64),
    sig: 's',
    ...overrides,
  } as Event;
}

describe('voice messages (NIP-A0, inline)', () => {
  it('round-trips a standalone voice message (kind 1222)', () => {
    const ev = sampleEvent();
    expect(ev.kind).toBe(KIND_VOICE_MESSAGE);
    const parsed = parseVoiceMessage(ev);
    expect(parsed).toEqual({
      // A standalone voice event's audio IS its content, so it always resolves inline — there is
      // nothing to fetch, and it plays without ever touching the network.
      source: {kind: 'inline', payloadBase64: 'AAAAAAAA'},
      mimeType: 'audio/mp4',
      durationSec: 12,
      waveform: [0.1, 0.8, 0.4],
      weightBytes: 8,
    });
  });

  it('returns null for non-voice or malformed events', () => {
    expect(parseVoiceMessage({kind: 1, content: 'hi', tags: []} as unknown as Event)).toBeNull();
    expect(parseVoiceMessage({kind: 1222, content: 'not-a-data-uri', tags: []} as unknown as Event)).toBeNull();
    expect(isVoiceEvent({kind: 1, content: '', tags: []} as unknown as Event)).toBe(false);
    expect(isVoiceEvent({kind: 1222, content: '', tags: []} as unknown as Event)).toBe(true);
  });

  it('estimates decoded byte length from base64', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('AAAA')).toBe(3);
    expect(base64ByteLength('AAA=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
  });
});

describe('inline voice embedding (No.9)', () => {
  it('round-trips a clip embedded inside a text body', () => {
    const body = `Listen to this:\n\n${encodeInlineVoice(sample)}\n\nthoughts?`;
    expect(hasInlineVoice(body)).toBe(true);
    const voices = extractInlineVoices(body);
    expect(voices).toEqual([
      {
        source: {kind: 'inline', payloadBase64: 'AAAAAAAA'},
        mimeType: 'audio/mp4',
        durationSec: 12,
        waveform: [0.1, 0.8, 0.4],
        weightBytes: 8,
      },
    ]);
  });

  it('encodes a clip with no waveform', () => {
    const noWave = inlineClip('BBBB', {mimeType: 'audio/ogg', durationSec: 5});
    const [v] = extractInlineVoices(encodeInlineVoice(noWave));
    expect(v).toEqual({
      source: {kind: 'inline', payloadBase64: 'BBBB'},
      mimeType: 'audio/ogg',
      durationSec: 5,
      weightBytes: 4,
    });
  });

  it('extracts multiple clips in document order', () => {
    const a = encodeInlineVoice(inlineClip('AAAA', {durationSec: 1, waveform: sample.waveform}));
    const b = encodeInlineVoice(inlineClip('BBBB', {durationSec: 2}));
    const got = extractInlineVoices(`first ${a} then ${b}`);
    expect(got.map(payloadOf)).toEqual(['AAAA', 'BBBB']);
    expect(got.map(v => v.durationSec)).toEqual([1, 2]);
  });

  it('strips the raw token from the displayed text', () => {
    const body = `before ${encodeInlineVoice(sample)} after`;
    expect(stripInlineVoices(body)).toBe('before  after');
    expect(hasInlineVoice(stripInlineVoices(body))).toBe(false);
  });

  it('skips an oversized embedded clip', () => {
    const big = encodeInlineVoice(inlineClip('A'.repeat(MAX_VOICE_BYTES * 2), {waveform: sample.waveform}));
    expect(extractInlineVoices(big)).toEqual([]);
  });

  it('reports no inline voice for plain text', () => {
    expect(hasInlineVoice('just words')).toBe(false);
    expect(extractInlineVoices('just words')).toEqual([]);
  });

  it('inlineVoiceSummary keeps surrounding text but never leaks the base64 token', () => {
    // text + clip → just the text (no base64)
    expect(inlineVoiceSummary(`hello ${encodeInlineVoice(sample)} world`)).toBe('hello world');
    // voice-only → a label, not the ~270KB token
    expect(inlineVoiceSummary(encodeInlineVoice(sample))).toBe('🎙️ Voice message');
    expect(inlineVoiceSummary(encodeInlineVoice(sample))).not.toContain('AAAA');
    // plain text passes through; empty stays empty
    expect(inlineVoiceSummary('  just  words ')).toBe('just words');
    expect(inlineVoiceSummary('')).toBe('');
  });
});
