/**
 * Voice messages (NIP-A0), adapted for STIQ's Tor-only / relay-only architecture.
 *
 * Standard NIP-A0 references an audio file hosted on a media server (URL in an `imeta` tag).
 * STIQ has NO media host and never opens a clearnet/media connection — everything rides the
 * relay over Tor. So the audio travels as base64 in relay events; the organizer can disable voice
 * entirely (see the `allowVoice` policy + relay gate).
 *
 * Kinds (NIP-A0):
 *   1222 — voice message (a standalone voice note / post)
 *   1244 — voice comment (a voice reply to another event)
 *
 * ## Load-on-tap: voice rides the SAME transport as pictures
 *
 * A clip's bytes may sit in the body token (`;<base64>`) or in a separate blob event
 * (`;w=<n>;STIQBLOB<id>` — see feed/mediaBlob.ts), fetched over Tor only when the viewer hits play.
 * Both forms parse to the SAME {@link VoiceMessage}, differing only in its {@link VoiceMessage.source};
 * `VoicePlayer` resolves that source through the shared `useMediaBlob` machine and cannot tell which
 * form the body used. This mirrors `InlinePicture` exactly, deliberately: pictures and voice are ONE
 * mechanism, because two "load over Tor" implementations would inevitably drift apart.
 *
 * Inline is the LEGACY form and is NOT going away: every voice post already in the wild, every row in
 * every user's local cache, and every standalone kind-1222 event carries it. It stays first-class,
 * forever — parsing it is not a migration step.
 *
 * `MAX_VOICE_BYTES` bounds the DECODED audio so a single event can't bloat the relay DB; the recorder
 * caps duration to stay under it, and {@link decodeVoicePayload} re-checks it on arrival so a fetched
 * blob can't hand the native player an unbounded buffer.
 */
import type {Event} from 'nostr-tools/pure';
import {parseMediaSource, payloadWeightBytes, mediaSourceTail, type MediaSource} from './mediaBlob';

export const KIND_VOICE_MESSAGE = 1222;
export const KIND_VOICE_COMMENT = 1244;

/** Hard cap on the decoded audio payload. At the default 24kbps mono AAC, ~200 KB ≈ 68s, so a clip
 *  at the 60s duration cap (~176 KB) always fits — the byte cap and the duration cap finally agree
 *  (they didn't at the old 48kbps, where 200 KB bit at ~34s and produced a false "clip too long"). */
export const MAX_VOICE_BYTES = 200 * 1024;
/** Recommended max clip length the recorder enforces (keeps payload under the byte cap). */
export const MAX_VOICE_SECONDS = 60;

/**
 * Default AAC-LC recording knobs — voice-optimised mono speech, lowered from the old 48kbps/44.1kHz
 * to roughly halve a clip's bytes with no perceptible loss for speech. Organizer-tunable per
 * community via `stiq:audio-limits` (feed/audioRules.ts); the recorder clamps to native-safe bounds.
 */
export const DEFAULT_VOICE_BITRATE_KBPS = 24;
export const DEFAULT_VOICE_SAMPLE_RATE_HZ = 24_000;

/**
 * A lightweight reference to a voice clip, as pulled out during render. It carries only the metadata
 * the player needs to draw its IDLE state (mime/duration/waveform) plus a {@link MediaSource} saying
 * where the audio is — never the audio itself.
 *
 * This is why a feed render is cheap: a voice clip is a quiet player bar until you hit play, whether
 * its bytes are already inline or still sitting on the relay. Resolve `source` with `loadMediaSource`
 * (media/mediaBlobService.ts) — or, in a component, the shared `useMediaBlob` hook — then hand the
 * payload to {@link decodeVoicePayload}.
 */
export interface VoiceMessage {
  /**
   * Where the audio lives: inline in the token/event (legacy) or in a blob event to fetch on tap.
   * Replaced the old eager `audioBase64` field: holding the payload here meant every rendered
   * message parsed its full ~267KB of base64 whether or not anyone ever pressed play.
   */
  source: MediaSource;
  /** MIME type, e.g. 'audio/mp4' (AAC) or 'audio/ogg' (Opus). */
  mimeType: string;
  /** Clip length in whole seconds (for the UI scrubber + duration label). */
  durationSec: number;
  /** Optional coarse amplitude samples (0..1) for a static waveform preview. */
  waveform?: number[];
  /**
   * Length of the base64 payload (≈ wire bytes) — read from the token's `w=` field for a blob-backed
   * clip, or the payload's own length for an inline one, so the figure means the same thing in both
   * forms (see `payloadWeightBytes`).
   *
   * NOTE the unit: this is BASE64 length, matching `InlinePicture.weightBytes` and the organizer's
   * byte accounting. {@link MAX_VOICE_BYTES} is in DECODED bytes — a different unit, deliberately, as
   * it always has been. Do not compare the two.
   *
   * Nothing meters voice bytes TODAY (voice governance is the `allowVoice` boolean + the hardcoded
   * caps here; the per-period byte allowance is pictures-only — see media/pictureAllowance.ts and
   * AppRuntime.accountPictures). This field exists so that if a voice allowance is ever added it
   * meters the real payload rather than the 72-char blob pointer — the fail-open trap that splitting
   * pictures out of the body would otherwise have sprung. See payloadWeightBytes' doc.
   */
  weightBytes: number;
}

const DATA_URI_RE = /^data:([^;]+);base64,(.*)$/s;

/** The base64 alphabet — what a well-formed audio payload is made of, and nothing else. */
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

/** Approximate decoded byte length of a base64 string (without allocating it). */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Parse a STANDALONE voice event (kind 1222/1244, whose whole `content` is a `data:` URI) back into
 * a VoiceMessage, or null if it isn't a well-formed one.
 *
 * Always yields an `inline` source: a standalone voice event's audio IS its content, so the bytes
 * arrive with the event and there is nothing to fetch. Such an event is READ-ONLY legacy/interop
 * surface — this client composes voice exclusively as an inline body token (`encodeInlineVoice`) and
 * has never published a 1222/1244 of its own. Kept first-class regardless: these events exist in
 * users' caches and on the relay, and PostCard renders them.
 *
 * Deliberately NOT size-capped, exactly as before: an event that already arrived costs nothing more
 * to play, and refusing to play a clip the user already downloaded would be a pure regression.
 * {@link decodeVoicePayload} still bounds what reaches the native player.
 */
export function parseVoiceMessage(event: Event): VoiceMessage | null {
  if (event.kind !== KIND_VOICE_MESSAGE && event.kind !== KIND_VOICE_COMMENT) return null;
  const m = DATA_URI_RE.exec(event.content.trim());
  if (!m) return null;
  const mimeType = m[1]!;
  const audioBase64 = m[2]!.trim();
  if (!audioBase64) return null;
  const durTag = event.tags.find(t => t[0] === 'duration');
  const durationSec = durTag ? parseInt(durTag[1] ?? '0', 10) || 0 : 0;
  const waveTag = event.tags.find(t => t[0] === 'waveform');
  const waveform = waveTag
    ? waveTag.slice(1).map(n => parseFloat(n)).filter(n => Number.isFinite(n))
    : undefined;
  return {
    source: {kind: 'inline', payloadBase64: audioBase64},
    mimeType,
    durationSec,
    waveform,
    weightBytes: audioBase64.length,
  };
}

/**
 * Validate audio that ARRIVED WITH ITS EVENT — an inline body token, or a standalone kind-1222
 * `data:` URI post. Alphabet only, NO size cap.
 *
 * That omission is deliberate and preserves today's behaviour exactly: these bytes are already on the
 * device (and already bounded by the relay's own per-event cap), so refusing to play them would cost
 * the user a clip they had already paid to download over Tor, and save nothing. The inline BODY token
 * is separately capped at extract time by {@link extractInlineVoices}, unchanged; a standalone post
 * never was capped, and still isn't.
 */
export function decodeVoiceInline(payloadBase64: string): string | null {
  return payloadBase64 && BASE64_RE.test(payloadBase64) ? payloadBase64 : null;
}

/**
 * Validate audio FETCHED FROM A BLOB — alphabet + the size cap. Null if unusable, which lands the
 * shared load machine in `error: 'decode'`, a state the UI renders honestly.
 *
 * The cap belongs HERE because this is the only point at which a blob's bytes can be checked: they
 * arrive long after the token was parsed, and the token's `w=` is author-supplied so it must never be
 * trusted as a size gate. A legitimate blob is always ≤ {@link MAX_VOICE_BYTES} (the recorder enforces
 * that at capture), so an oversized one is corrupt or hostile and is refused rather than handed to the
 * native player.
 */
export function decodeVoicePayload(payloadBase64: string): string | null {
  const audio = decodeVoiceInline(payloadBase64);
  if (audio === null) return null;
  return base64ByteLength(audio) > MAX_VOICE_BYTES ? null : audio;
}

/**
 * The right validator for where a clip's bytes came from — the modality-specific half of
 * `useMediaBlob`, and the voice analogue of `decodePicturePayload`.
 *
 * There is no JS decode step for voice: `StiqAudio.playBase64` takes the base64 string and decodes it
 * natively, so the "decoded artifact" IS the validated payload.
 *
 * Both branches return a MODULE-SCOPE function, so the reference `useMediaBlob` receives is stable
 * (it is a `load` dependency). It changes only when the source's kind does — and a changed source
 * already resets that hook, so the two move in lockstep.
 */
export function voiceDecoderFor(source: MediaSource): (payloadBase64: string) => string | null {
  return source.kind === 'blob' ? decodeVoicePayload : decodeVoiceInline;
}

/** True when the event is a voice message or voice comment. */
export function isVoiceEvent(event: Event): boolean {
  return event.kind === KIND_VOICE_MESSAGE || event.kind === KIND_VOICE_COMMENT;
}

// ── Inline voice embedding (No.9) ──────────────────────────────────────────────────────────────
//
// `[[voice:<mime>;<durSec>[;wf=<csv>][;w=<bytes>];<tail>]]`. A voice clip can be embedded INSIDE a
// text post or channel message, rendered where it sits in the prose. mime/duration/waveform ride in
// the text prefix so the player can draw a full, labelled bar WITHOUT the audio — which is what makes
// a lazy clip look like a real one at zero cost. `[[ ]]` never occurs in base64 or markdown, so the
// token is collision-free.
//
// `<tail>` is EITHER the base64 audio (legacy, inline) or a `STIQBLOB<id>` reference to a blob event
// (feed/mediaBlob.ts) — one alphabet, so this single regex matches both and old bodies parse
// byte-identically. `w=` is the payload's real size, written only on a blob reference; both optional
// groups are absent from a legacy token, so it still matches exactly as it did before blobs existed.
//
// `;w=` and `;wf=` cannot be confused: `w=` must be followed by digits, `wf=` by `f`. And `w=` sits
// before the LAST `;`, so mediaBlob's / mediaRefs' greedy `.+;` prefix split still lands exactly on
// the payload delimiter.
const INLINE_VOICE_RE = /\[\[voice:(audio\/[a-z0-9.+-]+);(\d+)(?:;wf=([\d.,]+))?(?:;w=(\d+))?;([A-Za-z0-9+/=]+)\]\]/g;

/**
 * Encode a voice clip as an inline body token (No.9). The exact inverse of
 * {@link extractInlineVoices} for both token forms, so a parsed clip can be re-encoded losslessly.
 *
 * Composers only ever call this with a freshly recorded/imported clip (an `inline` source), matching
 * `encodeInlinePicture`: bodies are composed INLINE and the payload is moved out to a blob later, at
 * publish, by the shared `splitMediaBlobs`. The blob branch here exists so re-encoding a
 * already-split token can't silently drop its `w=` and zero out the weight.
 */
export function encodeInlineVoice(voice: VoiceMessage): string {
  const dur = Math.max(0, Math.round(voice.durationSec));
  const wf = voice.waveform && voice.waveform.length > 0
    ? `;wf=${voice.waveform.map(n => n.toFixed(2)).join(',')}`
    : '';
  const w = voice.source.kind === 'blob' ? `;w=${voice.weightBytes}` : '';
  return `[[voice:${voice.mimeType};${dur}${wf}${w};${mediaSourceTail(voice.source)}]]`;
}

/**
 * Extract every inline voice clip from a body, in document order. CHEAP: only the regex + a size-cap
 * check run here — no base64 is parsed into a payload and nothing touches the network. The player
 * resolves the source and calls {@link decodeVoicePayload} on tap.
 *
 * This function used to hand back the full ~267KB base64 for every clip in every rendered message,
 * tapped or not. That eagerness — not the network — is what made voice heavy on the feed.
 */
export function extractInlineVoices(body: string): VoiceMessage[] {
  const out: VoiceMessage[] = [];
  for (const m of body.matchAll(INLINE_VOICE_RE)) {
    const tail = m[5]!;
    if (!tail) continue;
    const source = parseMediaSource(tail);
    // The cap bounds a hostile INLINE token, exactly as before (a blob reference is 72 chars by
    // construction; its payload is capped on arrival by decodeVoicePayload instead, which is the only
    // place it can be — `w=` is author-supplied and must never be trusted as a size gate).
    if (source.kind === 'inline' && base64ByteLength(source.payloadBase64) > MAX_VOICE_BYTES) continue;
    const mimeType = m[1]!;
    const durationSec = parseInt(m[2] ?? '0', 10) || 0;
    const waveform = m[3]
      ? m[3].split(',').map(n => parseFloat(n)).filter(n => Number.isFinite(n))
      : undefined;
    out.push({source, mimeType, durationSec, ...(waveform ? {waveform} : {}), weightBytes: payloadWeightBytes(m[4], tail)});
  }
  return out;
}

/** Remove inline voice tokens from a body (so the raw token never renders as text). */
export function stripInlineVoices(body: string): string {
  return body.replace(INLINE_VOICE_RE, '');
}

/**
 * Count inline voice tokens in a body — raw token occurrences (the same tokens
 * {@link stripInlineVoices} removes), for the per-post media cap. Matches the relay's count exactly.
 */
export function countInlineVoices(body: string): number {
  return (body.match(INLINE_VOICE_RE) || []).length;
}

/** True when the body contains at least one inline voice clip. */
export function hasInlineVoice(body: string): boolean {
  return body.includes('[[voice:audio/');
}

/**
 * Collapse a (name-header-decoded) message body into a one-line plain-text preview/quote, with any
 * inline voice clip replaced by a short label instead of leaking its ~270KB base64 token (No.9).
 * Returns '' for a genuinely empty body. Use everywhere a message is shown as a single line:
 * inbox previews, swipe-to-reply quotes, pinned bars.
 */
export function inlineVoiceSummary(text: string): string {
  const stripped = stripInlineVoices(text).replace(/\s+/g, ' ').trim();
  if (stripped) return stripped;
  return hasInlineVoice(text) ? '🎙️ Voice message' : '';
}
