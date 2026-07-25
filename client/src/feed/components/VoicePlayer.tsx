/**
 * VoicePlayer — a NIP-A0 voice clip (kind 1222/1244, or an inline `[[voice:…]]` token), played on tap.
 *
 * Press play → the audio is fetched over Tor → it plays. That whole lifecycle is the SHARED
 * `useMediaBlob` machine — the same one PictureChip runs — so a picture and a voice clip can never
 * drift in how they load, how they cache, or how they fail. `decodeVoicePayload` is the only
 * voice-specific part; it is module-scope, so it is referentially stable for the hook.
 *
 * ## What changed, and why
 *
 * This component used to receive a VoiceMessage with the full base64 already in it, and mount its
 * whole waveform UI on render — so every clip in the feed was parsed and staged whether or not anyone
 * pressed play, at ~267KB of base64 each (over 4× a picture). The clip's bytes now arrive only when
 * asked for. Everything needed to draw the bar at rest — duration and the waveform — rides in the
 * token metadata, so an idle clip still looks like a real clip and costs nothing.
 *
 * A LEGACY inline clip (a standalone 1222 event, or an old body whose base64 rode with the post)
 * resolves through the same path without touching the network: it simply plays immediately. Nothing
 * about it is made to look slow, and nothing about it needs a migration.
 *
 * ## Failure is a routine state here
 *
 * These fetches cross Tor, which drops circuits. A load that fails says so on the bar and — when
 * retrying could plausibly work — invites another press. Corrupt audio does not: it stops inviting a
 * tap that can never succeed.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {voiceDecoderFor, type VoiceMessage} from '../voice';
import {playVoice, stopPlayback} from '../../media/voiceRecorder';
import {useMediaBlob, type MediaLoadError} from '../../media/useMediaBlob';
import {colors, radius, space, type as typeScale} from '../../ui/theme';

export interface VoicePlayerProps {
  voice: VoiceMessage;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const BARS = 28;

/**
 * What to tell the viewer when a load fails. Cause-specific on purpose: "couldn't load" is honest for
 * corrupt audio, but for a dropped Tor circuit it hides the one fact the viewer can act on (retry).
 * Worded to match PictureChip's `errorLabel` — one mechanism, one vocabulary.
 */
function errorLabel(error: MediaLoadError | null): string {
  switch (error) {
    case 'offline':
      return 'Not connected';
    case 'timeout':
      return "Couldn't fetch voice";
    default:
      return "Couldn't load voice";
  }
}

export function VoicePlayer({voice}: VoicePlayerProps): React.JSX.Element {
  // The load lifecycle (fetch over Tor → validate → loaded/error) is the SHARED one. The validator is
  // the only voice-specific part, and it depends on where the bytes come from: audio fetched from a
  // blob is size-capped, audio that arrived with its event is not (see voice.ts). Both are
  // module-scope, so the reference stays stable for the hook.
  const {state, value: payload, error, retryable, load} = useMediaBlob(voice.source, voiceDecoderFor(voice.source));
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  // A native playback failure, which is NOT a load failure — the bytes are in hand and fine; the
  // device just wouldn't play them. Previously swallowed entirely: the button went back to ▶ and the
  // viewer was told nothing at all.
  const [playFailed, setPlayFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // Set when a PRESS starts a load, so playback follows automatically the moment the bytes land —
  // one press means "play", not "fetch, then press again". Cleared as soon as it is honoured, so a
  // load triggered any other way never auto-plays.
  const wantPlay = useRef(false);
  // Mirrors `playing` for the reset effect below, which must read it without depending on it (a
  // `playing` dep would re-run the effect on every play/stop and re-fire its teardown).
  const playingRef = useRef(false);

  const markPlaying = useCallback((next: boolean): void => {
    playingRef.current = next;
    setPlaying(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const startPlayback = useCallback(
    async (audio: string): Promise<void> => {
      setBusy(true);
      setPlayFailed(false);
      try {
        await playVoice(audio);
        if (!mounted.current) return;
        markPlaying(true);
        // No native completion event is wired; clear the indicator after the clip length.
        const ms = Math.max(1000, (voice.durationSec || 1) * 1000);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          if (mounted.current) markPlaying(false);
        }, ms);
      } catch {
        if (!mounted.current) return;
        markPlaying(false);
        setPlayFailed(true);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [voice.durationSec, markPlaying],
  );

  // Back to `idle` — the hook reset us because this row was RECYCLED onto a different clip, or
  // Settings cleared the rendered-media cache. Either way, any audio still coming out of this player
  // belongs to a clip that is no longer on screen, and any pending intent to play is void. Without
  // this, a FlatList row recycled mid-playback would show a fresh clip's ▶ bar while the previous
  // clip kept playing, and the next press would stack a second stream on top.
  useEffect(() => {
    if (state !== 'idle') return;
    wantPlay.current = false;
    if (playingRef.current) {
      markPlaying(false);
      void stopPlayback().catch(() => {});
    }
  }, [state, markPlaying]);

  // The bytes landed for a press that asked to play → play. The reset above clears `wantPlay`, so
  // the arriving audio of an abandoned load can never start playing over the top of a new clip.
  useEffect(() => {
    if (state === 'loaded' && payload && wantPlay.current) {
      wantPlay.current = false;
      void startPlayback(payload);
    }
  }, [state, payload, startPlayback]);

  // A static bar pattern from the waveform metadata (free — it rides in the token, no audio needed),
  // or a gentle default. Memoized: 28 bars rebuilt on every render of every clip in a feed is exactly
  // the kind of avoidable JS-thread work this round is removing.
  const bars: number[] = useMemo(() => {
    const w = voice.waveform;
    return w && w.length > 0
      ? Array.from({length: BARS}, (_, i) => w[Math.floor((i / BARS) * w.length)] ?? 0.3)
      : Array.from({length: BARS}, (_, i) => 0.35 + 0.45 * Math.abs(Math.sin(i * 1.1)));
  }, [voice.waveform]);

  const failed = state === 'error';
  const loading = state === 'loading';
  // Nothing to press when the audio is unreadable — retrying cannot fix bad bytes.
  const dead = failed && !retryable;

  const onPress = (): void => {
    if (busy || loading || dead) return;
    if (playing) {
      markPlaying(false);
      void stopPlayback().catch(() => {});
      return;
    }
    // Bytes already in hand (loaded earlier, or a legacy inline clip that has been played once) —
    // replay straight away, no second trip.
    if (state === 'loaded' && payload) {
      void startPlayback(payload);
      return;
    }
    // idle, or a retryable failure: this press means "play", so remember that and go get the audio.
    wantPlay.current = true;
    setPlayFailed(false);
    load();
  };

  const status = failed ? errorLabel(error) : playFailed ? "Couldn't play voice" : loading ? 'Fetching over Tor…' : null;

  return (
    <View style={s.row}>
      <Press
        style={[s.playBtn, dead && s.playBtnDead]}
        onPress={onPress}
        disabled={dead}
        accessibilityLabel="voice-play">
        {busy || loading ? (
          <ActivityIndicator size="small" color={colors.bg} />
        ) : failed ? (
          // ↻ when another go could work; ⚠ when it provably can't.
          <Text style={s.glyph}>{retryable ? '↻' : '⚠'}</Text>
        ) : playing ? (
          // A crisp geometric ▮ / ▶ drawn from Views, not a font glyph, so the ink is provably
          // centered in the accent disc (a ▶/■ glyph carries its own side-bearing and sits off-centre).
          <View style={s.stopShape} />
        ) : (
          <View style={s.playTri} />
        )}
      </Press>
      {/* The status line replaces the waveform rather than sitting beside it: the bar is one row in a
          feed card, and a clip that can't play should say why in the space it already occupies. */}
      {status ? (
        <Text style={[s.status, failed && s.statusFail]} numberOfLines={1}>
          {status}
          {failed && retryable && <Text style={s.statusDim}> · tap to retry</Text>}
        </Text>
      ) : (
        <View style={s.waveform}>
          {bars.map((h, i) => (
            <View key={i} style={[s.bar, {height: 4 + Math.round(h * 22)}]} />
          ))}
        </View>
      )}
      <Text style={s.duration}>{fmt(voice.durationSec)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: space.sm,
    // marginVertical on the same scale as the other inline media (picture, image card): these render
    // as bare siblings in RichText's segment list, so each element's own margin is the only spacing
    // there is — top-only left the following text crowded against it.
    marginVertical: space.sm,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Right-pointing play triangle (CSS-triangle from borders). A triangle's visual mass sits toward
  // its base, so a tiny marginLeft nudges the optical centre onto the disc centre.
  playTri: {
    width: 0,
    height: 0,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 12,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: colors.bg,
    marginLeft: 3,
  },
  stopShape: {width: 12, height: 12, borderRadius: 2, backgroundColor: colors.bg},
  // A failed clip's disc goes quiet rather than sitting there in accent colour inviting a press that
  // is refused.
  playBtnDead: {backgroundColor: colors.surfaceHover},
  glyph: {color: colors.bg, fontSize: 15, fontWeight: '700'},
  waveform: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 28},
  bar: {flex: 1, backgroundColor: colors.accent, opacity: 0.55, borderRadius: 1},
  // Occupies the waveform's slot (same flex/height) so the bar never reflows between states.
  status: {flex: 1, height: 28, lineHeight: 28, fontSize: typeScale.caption, color: colors.textSecondary},
  statusFail: {color: colors.textPrimary},
  statusDim: {color: colors.textMuted},
  duration: {fontSize: typeScale.caption, color: colors.textSecondary, minWidth: 34, textAlign: 'right'},
});
