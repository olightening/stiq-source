/**
 * VoiceComposer — record + send a NIP-A0 voice message (inline audio).
 *
 * Tap record → speak → stop → preview/send. Enforces the clip-length cap (auto-stops). Only
 * mounted when the organizer allows voice (snapshot.allowVoice).
 */
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {BackModal, useBackDismiss} from '../../ui/back';
import type {VoiceMessage} from '../voice';
import {activeAudioRules} from '../audioRules';
import {
  startRecording,
  stopRecording,
  cancelRecording,
  importVoiceFile,
  voiceImportSupported,
} from '../../media/voiceRecorder';
import {VoicePlayer} from './VoicePlayer';
import {colors, radius, space, type as typeScale} from '../../ui/theme';
import {Icon} from '../../ui/icons';

export interface VoiceComposerProps {
  visible: boolean;
  onClose: () => void;
  onSend: (voice: VoiceMessage) => Promise<void> | void;
}

type Phase = 'idle' | 'recording' | 'recorded' | 'sending';

export function VoiceComposer({visible, onClose, onSend}: VoiceComposerProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<VoiceMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How the current clip was obtained — labels the "redo" button (Re-record vs Choose another).
  const [source, setSource] = useState<'record' | 'upload'>('record');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Only offer file upload when the native module supports it (older builds record-only).
  const canUpload = voiceImportSupported();
  // Organizer-tuned recorder knobs + caps (bitrate/sample-rate/duration/byte cap). Read per render
  // so a live stiq:audio-limits update takes effect on the next recording without a remount.
  const rules = activeAudioRules();

  const clearTimer = (): void => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  // Reset everything whenever the sheet is dismissed.
  useEffect(() => {
    if (!visible) {
      clearTimer();
      void cancelRecording().catch(() => {});
      setPhase('idle');
      setElapsed(0);
      setClip(null);
      setError(null);
      setSource('record');
    }
  }, [visible]);

  const finish = async (): Promise<void> => {
    clearTimer();
    try {
      const voice = await stopRecording(activeAudioRules().maxBytesPerClip);
      setClip(voice);
      setPhase('recorded');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'recording failed');
      setPhase('idle');
    }
  };

  const chooseFile = async (): Promise<void> => {
    setError(null);
    try {
      const voice = await importVoiceFile();
      if (!voice) return; // user cancelled the picker
      setClip(voice);
      setSource('upload');
      setPhase('recorded');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not import that file');
    }
  };

  const beginRecording = async (): Promise<void> => {
    setError(null);
    setSource('record');
    const active = activeAudioRules();
    try {
      await startRecording({bitRateKbps: active.bitrateKbps, sampleRateHz: active.sampleRateHz});
      setPhase('recording');
      setElapsed(0);
      timer.current = setInterval(() => {
        setElapsed(prev => {
          const next = prev + 1;
          if (next >= active.maxDurationSec) void finish();
          return next;
        });
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not start recording');
      setPhase('idle');
    }
  };

  const send = async (): Promise<void> => {
    if (!clip) return;
    setPhase('sending');
    try {
      await onSend(clip);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to send');
      setPhase('recorded');
    }
  };

  const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // A recorded-but-unsent clip cannot be reproduced by retyping, so BACK asks before dropping it.
  // While RECORDING, BACK is swallowed entirely — matching the scrim, which already refuses to
  // dismiss mid-take (below): a stray gesture must not end a recording in progress. Sending is
  // likewise uninterruptible. See ui/back.tsx contract rule 5.
  const dismiss = useBackDismiss(phase === 'recorded' && !!clip, onClose, {
    title: 'Discard this recording?',
    discardLabel: 'Discard',
  });
  const handleBack = (): boolean => {
    if (phase === 'recording' || phase === 'sending') return true; // consume, do nothing
    dismiss();
    return true;
  };

  return (
    <BackModal visible={visible} transparent animationType="slide" onClose={onClose} onBack={handleBack}>
      <Press variant="bare" style={s.overlay} onPress={phase === 'recording' ? undefined : dismiss} accessibilityRole="none">
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
          <Text style={s.title}>Voice message</Text>

          {error && <Text style={s.error}>{error}</Text>}

          {phase === 'recording' && (
            <View style={s.center}>
              <View style={s.recDot} />
              <Text style={s.timer}>{fmt(elapsed)}</Text>
              <Text style={s.hint}>Recording… (max {rules.maxDurationSec}s)</Text>
            </View>
          )}

          {phase === 'recorded' && clip && (
            <View style={s.previewBox}>
              <VoicePlayer voice={clip} />
            </View>
          )}

          {phase === 'idle' && (
            <Text style={s.hint}>
              {canUpload
                ? 'Record a short voice note, or upload an audio file.'
                : 'Tap the mic to record a short voice note.'}
            </Text>
          )}

          <View style={s.actions}>
            {phase === 'idle' && (
              <View style={s.idleCol}>
                <Press style={s.micBtn} onPress={beginRecording} accessibilityLabel="voice-record">
                  <Icon name="🎙️" size={28} />
                </Press>
                {canUpload && (
                  <Press style={s.uploadBtn} onPress={chooseFile} accessibilityLabel="voice-upload">
                    <Icon name="📁" size={18} />
                    <Text style={s.uploadText}>Upload a file</Text>
                  </Press>
                )}
              </View>
            )}
            {phase === 'recording' && (
              <Press style={[s.micBtn, s.stopBtn]} onPress={finish}>
                <Text style={s.stopIcon}>■</Text>
              </Press>
            )}
            {phase === 'recorded' && (
              <View style={s.recordedActions}>
                <Press
                  style={[s.btn, s.ghost]}
                  onPress={source === 'upload' ? chooseFile : beginRecording}>
                  <Text style={s.ghostText}>{source === 'upload' ? 'Choose another' : 'Re-record'}</Text>
                </Press>
                <Press style={s.btn} onPress={send}>
                  <Text style={s.btnText}>Send</Text>
                </Press>
              </View>
            )}
            {phase === 'sending' && <ActivityIndicator color={colors.accent} />}
          </View>
        </Press>
      </Press>
    </BackModal>
  );
}

const s = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    paddingBottom: space.xxl,
  },
  title: {fontSize: typeScale.subheading, fontWeight: '700', color: colors.textPrimary, marginBottom: space.md},
  error: {color: colors.danger, fontSize: typeScale.caption, fontWeight: '400', marginBottom: space.sm},
  center: {alignItems: 'center', paddingVertical: space.lg, gap: space.xs},
  recDot: {width: 14, height: 14, borderRadius: 7, backgroundColor: colors.danger},
  timer: {fontSize: typeScale.heading, fontWeight: '700', color: colors.textPrimary},
  hint: {fontSize: typeScale.caption, fontWeight: '400', color: colors.textSecondary, textAlign: 'center', paddingVertical: space.sm},
  previewBox: {paddingVertical: space.sm},
  actions: {alignItems: 'center', marginTop: space.md},
  idleCol: {alignItems: 'center', gap: space.md},
  micBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  uploadText: {color: colors.textPrimary, fontSize: typeScale.label, fontWeight: '600'},
  stopBtn: {backgroundColor: colors.danger},
  stopIcon: {color: '#fff', fontSize: 24, fontWeight: '700'},
  recordedActions: {flexDirection: 'row', gap: space.md},
  btn: {backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md},
  btnText: {color: colors.bg, fontWeight: '700', fontSize: typeScale.body},
  ghost: {backgroundColor: colors.bg},
  ghostText: {color: colors.textSecondary, fontWeight: '600', fontSize: typeScale.body},
});
