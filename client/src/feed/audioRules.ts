/**
 * Organizer control over voice/audio — how big and how long a clip may be, at what quality the
 * recorder captures it (the compression knobs), how much a member may post per period, and whether
 * voice is allowed at all.
 *
 * The audio analogue of feed/pictureRules.ts: a kind-30078 doc (d=stiq:audio-limits) signed by the
 * organizer, consumed on the voice-composer hot path. Before this existed, voice governance was a
 * single `allow_voice` boolean inside stiq:limits plus hardcoded client caps (MAX_VOICE_BYTES /
 * MAX_VOICE_SECONDS / a fixed 48kbps encoder) that the dashboard could not touch — so audio "rules"
 * could never be synced. This doc makes all of it organizer-tunable and, crucially, lets the
 * organizer dial the recording bitrate to trade quality for size community-wide.
 *
 * Enforcement split (deliberate, mirrors pictures, keeps the relay blind — see voice.ts):
 *   - allow / maxDurationSec / bitrateKbps / sampleRateHz / per-period allowance → CLIENT-side. Posts
 *     are relay-blind (throwaway per-post signatures), so the relay can neither attribute a member's
 *     cumulative audio bytes nor tell a clip from any other bytes. The recorder + composer enforce.
 *   - maxBytesPerClip → backstopped by the relay's CONTENT-NEUTRAL per-event size cap
 *     (max_event_bytes), which the dashboard raises (never shrinks) to clear the configured clip cap
 *     so a legitimate clip never trips a confusing generic "event too large".
 *
 * Bytes here are DECODED audio bytes (what the recorder produces and caps), the same unit as
 * MAX_VOICE_BYTES — NOT the ~4/3-larger base64 wire length. Keep that consistent within voice.
 */
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  DEFAULT_VOICE_BITRATE_KBPS,
  DEFAULT_VOICE_SAMPLE_RATE_HZ,
} from './voice';

export const KIND_AUDIO_RULES = 30078;
export const AUDIO_RULES_D_TAG = 'stiq:audio-limits';

export interface AudioRules {
  /** Whether members may post voice/audio at all. Off ⇒ the composer hides the mic + upload. */
  allow: boolean;
  /** Per-period decoded-byte budget for one member. 0 = unlimited. */
  allowanceBytes: number;
  /** Length of the allowance window in hours (the budget resets each window). */
  periodHours: number;
  /** Hard per-clip decoded-byte cap. Keep ≤ the relay's max_event_bytes (dashboard raises it). */
  maxBytesPerClip: number;
  /** Longest clip the recorder allows before it auto-stops (seconds). */
  maxDurationSec: number;
  /** AAC-LC recording bitrate in kbps — the primary size/quality knob (lower = smaller clips). */
  bitrateKbps: number;
  /** Recording sample rate in Hz (voice needs far less than music; lower helps the encoder). */
  sampleRateHz: number;
}

export const DEFAULT_AUDIO_RULES: AudioRules = {
  allow: true,
  // ~1 MB/period ≈ ~5-6 min of 24kbps voice.
  allowanceBytes: 1024 * 1024,
  periodHours: 24,
  maxBytesPerClip: MAX_VOICE_BYTES,
  maxDurationSec: MAX_VOICE_SECONDS,
  bitrateKbps: DEFAULT_VOICE_BITRATE_KBPS,
  sampleRateHz: DEFAULT_VOICE_SAMPLE_RATE_HZ,
};

/** Compact on-wire shape (kind-30078 content). */
interface AudioRulesWire {
  al?: boolean;
  ab?: number;
  ph?: number;
  mbc?: number;
  md?: number;
  br?: number;
  sr?: number;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}
function posInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v > 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}
/** An int that must sit within [lo, hi]; anything non-finite OR out of range falls back to the
 *  default (a garbage bitrate/sample-rate must not silently become a clamped surprise value —
 *  fall back to the known-good default, exactly as posInt/nonNegInt do for their fields). */
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return n >= lo && n <= hi ? n : fallback;
}

export function encodeAudioRules(r: AudioRules): AudioRulesWire {
  return {al: r.allow, ab: r.allowanceBytes, ph: r.periodHours, mbc: r.maxBytesPerClip, md: r.maxDurationSec, br: r.bitrateKbps, sr: r.sampleRateHz};
}

export function parseAudioRules(raw: unknown): AudioRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as AudioRulesWire;
  return {
    allow: typeof w.al === 'boolean' ? w.al : DEFAULT_AUDIO_RULES.allow,
    allowanceBytes: nonNegInt(w.ab, DEFAULT_AUDIO_RULES.allowanceBytes),
    periodHours: posInt(w.ph, DEFAULT_AUDIO_RULES.periodHours),
    maxBytesPerClip: posInt(w.mbc, DEFAULT_AUDIO_RULES.maxBytesPerClip),
    maxDurationSec: posInt(w.md, DEFAULT_AUDIO_RULES.maxDurationSec),
    // Bitrate/sample-rate are clamped to what the native AAC encoder accepts (see StiqAudioModule.kt).
    bitrateKbps: clampInt(w.br, 8, 128, DEFAULT_AUDIO_RULES.bitrateKbps),
    sampleRateHz: clampInt(w.sr, 8000, 48000, DEFAULT_AUDIO_RULES.sampleRateHz),
  };
}

/** Repair a possibly-old-shape persisted value to a complete AudioRules (defense-in-depth). */
export function normalizeAudioRules(r: AudioRules | null | undefined): AudioRules {
  if (!r || typeof r !== 'object') return DEFAULT_AUDIO_RULES;
  return {
    allow: typeof r.allow === 'boolean' ? r.allow : DEFAULT_AUDIO_RULES.allow,
    allowanceBytes: nonNegInt(r.allowanceBytes, DEFAULT_AUDIO_RULES.allowanceBytes),
    periodHours: posInt(r.periodHours, DEFAULT_AUDIO_RULES.periodHours),
    maxBytesPerClip: posInt(r.maxBytesPerClip, DEFAULT_AUDIO_RULES.maxBytesPerClip),
    maxDurationSec: posInt(r.maxDurationSec, DEFAULT_AUDIO_RULES.maxDurationSec),
    bitrateKbps: clampInt(r.bitrateKbps, 8, 128, DEFAULT_AUDIO_RULES.bitrateKbps),
    sampleRateHz: clampInt(r.sampleRateHz, 8000, 48000, DEFAULT_AUDIO_RULES.sampleRateHz),
  };
}

/** Parse a kind-30078 event's content into AudioRules (null if malformed). */
export function parseAudioRulesEvent(content: string): AudioRules | null {
  try {
    return parseAudioRules(JSON.parse(content));
  } catch {
    return null;
  }
}

export type AudioViolation = 'not-allowed' | 'too-large' | 'over-allowance';

/**
 * Check a candidate clip against the rules. `decodedBytes` is the clip's decoded audio size (the
 * unit the recorder caps); `spentBytes` is what the member has already spent this period. Returns
 * the violations (empty ⇒ ok).
 */
export function evaluateVoice(decodedBytes: number, spentBytes: number, rules: AudioRules): AudioViolation[] {
  const out: AudioViolation[] = [];
  if (!rules.allow) out.push('not-allowed');
  if (rules.maxBytesPerClip > 0 && decodedBytes > rules.maxBytesPerClip) out.push('too-large');
  if (rules.allowanceBytes > 0 && spentBytes + decodedBytes > rules.allowanceBytes) out.push('over-allowance');
  return out;
}

/** Human-readable reason for a violation, for the composer's inline hint. */
export function audioViolationMessage(v: AudioViolation, rules: AudioRules): string {
  switch (v) {
    case 'not-allowed':
      return 'Voice messages are turned off in this community.';
    case 'too-large':
      return `That clip is too large — record a shorter one (max ${Math.round(rules.maxBytesPerClip / 1024)} KB).`;
    case 'over-allowance':
      return "Over this period's voice allowance — record a shorter clip or wait for the next period.";
  }
}

// ── Active-rules accessor ────────────────────────────────────────────────────────────────────────
//
// The voice composer/recorder is instantiated deep in six different composers; rather than thread an
// `audioRules` prop through all of them (as pictures do), the recorder knobs — a per-community
// GLOBAL, not a per-composer value — live here, kept in sync by AppRuntime on config change + on
// every community switch (exactly like media/pictureAllowance.setPicturePeriodHours). VoiceComposer
// reads them via activeAudioRules() at record time.

let _activeAudioRules: AudioRules = DEFAULT_AUDIO_RULES;

/** AppRuntime calls this whenever the active community's audio rules change (or on switch). */
export function setActiveAudioRules(rules: AudioRules): void {
  _activeAudioRules = normalizeAudioRules(rules);
}

/** The audio rules for the active community — recorder knobs + caps. Never null. */
export function activeAudioRules(): AudioRules {
  return _activeAudioRules;
}
