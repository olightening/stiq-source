/**
 * voiceRecorder — JS bridge to the native StiqAudio module for NIP-A0 voice messages.
 *
 * Records to a temp AAC/m4a file natively and returns the audio as base64 (STIQ carries voice
 * INLINE in the relay event — no media host). Requests RECORD_AUDIO on demand and enforces the
 * size/duration caps from feed/voice.ts so a clip never bloats the relay.
 */
import {NativeModules, PermissionsAndroid, Platform} from 'react-native';
import {
  MAX_VOICE_BYTES,
  DEFAULT_VOICE_BITRATE_KBPS,
  DEFAULT_VOICE_SAMPLE_RATE_HZ,
  base64ByteLength,
  type VoiceMessage,
} from '../feed/voice';

interface ImportedAudio {
  base64: string;
  mime: string;
  durationSec: number;
  size: number;
}

/** Recording knobs, sourced from the organizer's `stiq:audio-limits` (all optional → voice defaults). */
export interface VoiceRecordOptions {
  /** AAC-LC bitrate in kbps (lower = smaller clip). Defaults to {@link DEFAULT_VOICE_BITRATE_KBPS}. */
  bitRateKbps?: number;
  /** Sampling rate in Hz. Defaults to {@link DEFAULT_VOICE_SAMPLE_RATE_HZ}. */
  sampleRateHz?: number;
}

interface StiqAudioNative {
  startRecording(bitRate: number, sampleRate: number): Promise<void>;
  stopRecording(): Promise<{base64: string; mime: string; durationSec: number; size: number}>;
  cancelRecording(): Promise<void>;
  playBase64(base64: string): Promise<void>;
  stopPlayback(): Promise<void>;
  /** Open the system audio picker; resolves the chosen clip, or null when the user cancels. Absent
   *  on native builds that predate the upload feature (feature-detect via voiceImportSupported). */
  importAudio?(): Promise<ImportedAudio | null>;
  /** iOS: request AVAudioSession record permission (Android uses PermissionsAndroid). Optional so an
   *  older native binary is handled by the feature-detect in ensureMicPermission. */
  requestMicPermission?(): Promise<boolean>;
}

function native(): StiqAudioNative | undefined {
  return (NativeModules as {StiqAudio?: StiqAudioNative}).StiqAudio;
}

/** True when the native audio module is linked (voice can be recorded/played on this build). */
export function voiceSupported(): boolean {
  return !!native();
}

/** True when this build's native module can import an audio file (upload-a-clip is offered only then). */
export function voiceImportSupported(): boolean {
  return typeof native()?.importAudio === 'function';
}

/** Ask for microphone permission. Returns true when granted. */
export async function ensureMicPermission(): Promise<boolean> {
  // iOS: actually PROMPT via the native AVAudioSession request. Returning true unconditionally (the
  // old behavior) reported "granted" without ever asking, so the OS then silently blocked recording.
  if (Platform.OS === 'ios') {
    const mod = native();
    if (typeof mod?.requestMicPermission === 'function') {
      try { return await mod.requestMicPermission(); } catch { return false; }
    }
    // No native module (module absent) — nothing can record anyway; report not-granted.
    return false;
  }
  if (Platform.OS !== 'android') return true;
  try {
    const perm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
    if (!perm) return false;
    const granted = await PermissionsAndroid.request(
      perm,
      {
        title: 'Microphone access',
        message: 'Allow recording a voice message.',
        buttonPositive: 'Allow',
        buttonNegative: 'Cancel',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/**
 * Begin recording at the given (organizer-tuned) bitrate/sample rate — lower values shrink the clip.
 * Throws if the module is missing or permission is denied. Native clamps the knobs to safe bounds.
 */
export async function startRecording(opts: VoiceRecordOptions = {}): Promise<void> {
  const mod = native();
  if (!mod) throw new Error('voice recording is not available on this build');
  if (!(await ensureMicPermission())) throw new Error('microphone permission denied');
  const bitRate = Math.round((opts.bitRateKbps ?? DEFAULT_VOICE_BITRATE_KBPS) * 1000);
  const sampleRate = Math.round(opts.sampleRateHz ?? DEFAULT_VOICE_SAMPLE_RATE_HZ);
  await mod.startRecording(bitRate, sampleRate);
}

/**
 * Stop recording and return the clip as a VoiceMessage. Rejects (and the caller should discard)
 * if the clip exceeds the inline size cap.
 *
 * A freshly recorded clip's bytes are in hand, so its source is `inline` — the composer embeds it
 * inline and the shared `splitMediaBlobs` moves the payload out to a blob at publish (gated on
 * LAZY_MEDIA_BLOBS), exactly as it does for a freshly framed picture.
 */
export async function stopRecording(maxBytes: number = MAX_VOICE_BYTES): Promise<VoiceMessage> {
  const mod = native();
  if (!mod) throw new Error('voice recording is not available on this build');
  const {base64, mime, durationSec} = await mod.stopRecording();
  // Byte cap, not a duration cap: at the default 24kbps a 60s clip fits, but a higher organizer
  // bitrate (or a long clip) can still exceed it, so the message names the real limit — KB — rather
  // than a seconds figure that may not be why it was rejected.
  if (base64ByteLength(base64) > maxBytes) {
    throw new Error(`clip too large — record a shorter one (max ${Math.round(maxBytes / 1024)} KB)`);
  }
  return {source: {kind: 'inline', payloadBase64: base64}, mimeType: mime, durationSec, weightBytes: base64.length};
}

/**
 * Let the user pick an audio file from the device and return it as a VoiceMessage, or null if they
 * cancel. Rejects (with a message safe to surface) if the clip exceeds the inline size cap — the
 * caller should show it and let the user pick a shorter clip.
 */
export async function importVoiceFile(): Promise<VoiceMessage | null> {
  const mod = native();
  if (!mod || typeof mod.importAudio !== 'function') {
    throw new Error('audio import is not available on this build');
  }
  const res = await mod.importAudio();
  if (!res) return null; // cancelled
  if (base64ByteLength(res.base64) > MAX_VOICE_BYTES) {
    throw new Error(`that file is too long — keep voice clips under ~${Math.round(MAX_VOICE_BYTES / 1024)} KB`);
  }
  const mime = res.mime && res.mime.startsWith('audio/') ? res.mime : 'audio/mp4';
  return {
    source: {kind: 'inline', payloadBase64: res.base64},
    mimeType: mime,
    durationSec: Math.max(0, Math.round(res.durationSec || 0)),
    weightBytes: res.base64.length,
  };
}

/** Discard an in-progress recording. */
export async function cancelRecording(): Promise<void> {
  await native()?.cancelRecording();
}

/**
 * Play an audio payload (base64, no data-URI prefix). Native decodes it — there is no JS decode step.
 *
 * Takes the PAYLOAD, not a VoiceMessage: a clip's bytes may live in a blob event rather than in the
 * message, so only the caller (which has resolved the clip's `source` through the shared load
 * machine — see feed/components/VoicePlayer.tsx) knows the audio is actually in hand. Handing this a
 * VoiceMessage would mean reaching into a source that might hold nothing but a blob id.
 */
export async function playVoice(payloadBase64: string): Promise<void> {
  const mod = native();
  if (!mod) throw new Error('voice playback is not available on this build');
  await mod.playBase64(payloadBase64);
}

/** Stop any current playback. */
export async function stopPlayback(): Promise<void> {
  await native()?.stopPlayback();
}
