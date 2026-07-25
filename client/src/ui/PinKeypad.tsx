/**
 * PinKeypad — the shared 4-digit numeric PIN keypad, ported verbatim from OnboardingScreen's PIN
 * step (design_handoff_onboarding) so onboarding's "choose/confirm your PIN" step and the recurring
 * lock screen render PIXEL-IDENTICAL: the same dots, the same 76×64 bordered keys, the same
 * shake-on-error — see stiq-onboarding-pin-lock-unification.
 *
 * Fully synchronous and self-contained: it owns its own entered-digits state and clears itself the
 * moment a full-length entry is handed off via {@link PinKeypadProps.onComplete}, so it is always
 * instantly ready for the next attempt. It never dims or disables its keys while a caller's async
 * work (e.g. LockScreen's PIN verification, which runs a deliberately slow KDF) is in flight — see
 * `busy` below — which is what keeps the recurring lock screen as responsive as onboarding.
 *
 * Security note (mirrors PinPad.tsx): this component never reveals or distinguishes a duress PIN —
 * `error` must always be caller-supplied generic copy.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';
import {Press} from './Press';
import {colors, weight} from './theme';

/** How long the final filled dot is shown before the pad clears + hands off — long enough to read
 *  as a deliberate confirmation, short enough that the pad never feels like it's stalling. */
const COMPLETE_DELAY_MS = 200;

export interface PinKeypadProps {
  title: string;
  helper?: string;
  /** Generic error line under the dots (never real duress-specific copy). */
  error?: string;
  /** PIN length to collect before auto-completing. Default 4 — the only length onboarding enrolls. */
  length?: number;
  /** Small caption under the keypad (e.g. onboarding's "stored only on this phone" note). */
  footnote?: string;
  /**
   * Fires once `length` digits are entered, after the brief flash above. The pad has already
   * cleared its own entry by the time this runs, so it's instantly ready for another attempt —
   * callers that need to compare/verify asynchronously (LockScreen) don't have to manage that.
   */
  onComplete: (pin: string) => void;
  /**
   * Bump to a new value (e.g. an incrementing counter) to play the rejection shake. For a caller
   * that only learns a PIN was wrong AFTER an async check (LockScreen) — the pad has already
   * cleared by then, so the shake plays over the (now empty) dots, exactly like a shoulder-surfer-
   * proof "that was wrong" cue with no timing tell about WHY (duress vs wrong).
   */
  shakeSignal?: number;
  /**
   * True while a previous completion is still being verified. New digit presses are ignored (so a
   * fast second entry can't race the in-flight check — the same protection PinPad's old `busy` gate
   * gave) but — unlike PinPad — the pad's APPEARANCE never changes: no opacity dimming, no
   * "disabled" look. A blocked tap is simply a no-op, exactly like this component's own built-in
   * debounce during the brief post-entry flash above.
   */
  busy?: boolean;
  /**
   * When the caller's `onComplete` does SLOW async work (LockScreen's PIN verify runs a deliberately
   * slow KDF), set this so `onComplete` fires the INSTANT the final digit lands — the confirmation
   * flash then overlaps the verify instead of adding ~200ms of dead time in front of it. The dots
   * stay filled during the flash (unchanged confirmation UX); `busy` + the length guard still block a
   * second entry. Leave false (default) for a synchronous handoff (onboarding's set→confirm), where
   * the pad clears itself BEFORE calling onComplete so the next phase starts with empty dots.
   */
  asyncComplete?: boolean;
}

export function PinKeypad({
  title,
  helper,
  error,
  length = 4,
  footnote,
  onComplete,
  shakeSignal,
  busy = false,
  asyncComplete = false,
}: PinKeypadProps): React.JSX.Element {
  const [entry, setEntry] = useState('');
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shake = useRef(new Animated.Value(0)).current;
  const lastShakeSignal = useRef(shakeSignal);

  useEffect(
    () => () => {
      if (completeTimer.current) clearTimeout(completeTimer.current);
    },
    [],
  );

  // Stable across renders (closes only over the never-reassigned `shake` ref) so it can be a
  // legitimate effect dependency below without re-arming the shake on every unrelated re-render.
  const runShake = useCallback((): void => {
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, {toValue: 1, duration: 70, useNativeDriver: true}),
      Animated.timing(shake, {toValue: -1, duration: 70, useNativeDriver: true}),
      Animated.timing(shake, {toValue: 0.6, duration: 70, useNativeDriver: true}),
      Animated.timing(shake, {toValue: 0, duration: 70, useNativeDriver: true}),
    ]).start();
  }, [shake]);

  // An externally-driven shake (LockScreen, after an async rejection) — only on a real CHANGE, so
  // mounting with a nonzero initial value never shakes on first render.
  useEffect(() => {
    if (shakeSignal !== undefined && shakeSignal !== lastShakeSignal.current) {
      lastShakeSignal.current = shakeSignal;
      runShake();
    }
  }, [shakeSignal, runShake]);

  const press = (digit: string): void => {
    if (busy || entry.length >= length) return;
    const next = entry + digit;
    setEntry(next);
    if (next.length === length) {
      if (asyncComplete) {
        // Kick off the caller's (slow, async) verify NOW so it overlaps the flash; the timer below is
        // purely cosmetic — it just clears the (still-filled) dots after the confirmation beat.
        onComplete(next);
        completeTimer.current = setTimeout(() => {
          completeTimer.current = null;
          setEntry('');
        }, COMPLETE_DELAY_MS);
      } else {
        // Synchronous handoff: show the confirmation flash, then clear the pad and hand off — so the
        // next phase (onboarding set→confirm) starts with empty dots.
        completeTimer.current = setTimeout(() => {
          completeTimer.current = null;
          setEntry('');
          onComplete(next);
        }, COMPLETE_DELAY_MS);
      }
    }
  };

  const backspace = (): void => {
    if (busy) return;
    if (completeTimer.current) {
      // A full-length entry is pending. In asyncComplete mode onComplete has ALREADY fired (the
      // verify is in flight, the flash is now cosmetic) — a backspace must NOT slice the submitted
      // entry, so it's a no-op. In sync mode the handoff hasn't happened yet, so a backspace still
      // cancels the pending complete (pre-existing behavior).
      if (asyncComplete) return;
      clearTimeout(completeTimer.current);
      completeTimer.current = null;
    }
    setEntry(e => e.slice(0, -1));
  };

  const tx = shake.interpolate({inputRange: [-1, 1], outputRange: [-8, 8]});

  return (
    <View style={s.wrap}>
      <View style={s.top}>
        <Text style={s.title}>{title}</Text>
        {helper ? <Text style={s.helper}>{helper}</Text> : null}
        <Animated.View style={[s.dots, {transform: [{translateX: tx}]}]}>
          {Array.from({length}).map((_, i) => (
            <View key={i} style={[s.dot, i < entry.length && s.dotFilled]} />
          ))}
        </Animated.View>
        <Text style={s.error}>{error || ' '}</Text>
      </View>

      <View style={s.keypad}>
        {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['', '0', '⌫']].map((row, r) => (
          <View key={r} style={s.keyRow}>
            {row.map((k, c) =>
              k === '' ? (
                <View key={c} style={s.keyBlank} />
              ) : k === '⌫' ? (
                <Press key={c} style={s.keyBack} onPress={backspace} accessibilityLabel="backspace">
                  <Text style={s.keyBackText}>⌫</Text>
                </Press>
              ) : (
                <Press
                  key={c}
                  style={s.key}
                  pressedStyle={s.keyPressed}
                  onPress={() => press(k)}>
                  <Text style={s.keyText}>{k}</Text>
                </Press>
              ),
            )}
          </View>
        ))}
      </View>
      {footnote ? <Text style={s.footnote}>{footnote}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {flex: 1, paddingHorizontal: 26, paddingBottom: 22, alignItems: 'center'},
  top: {flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%'},
  title: {fontSize: 27, fontWeight: weight.bold, color: colors.textPrimary, textAlign: 'center'},
  helper: {fontSize: 14.5, lineHeight: 22, color: colors.textSecondary, marginTop: 10, textAlign: 'center', maxWidth: 270},
  dots: {flexDirection: 'row', gap: 16, marginTop: 30},
  dot: {width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.borderLight},
  dotFilled: {backgroundColor: colors.accent, borderColor: colors.accent},
  error: {height: 20, marginTop: 13, fontSize: 13, fontWeight: weight.semibold, color: colors.danger},
  keypad: {gap: 14, marginTop: 8},
  keyRow: {flexDirection: 'row', gap: 14, justifyContent: 'center'},
  key: {width: 76, height: 64, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'},
  keyPressed: {backgroundColor: colors.surfaceHover},
  keyText: {fontSize: 26, color: colors.textPrimary, fontWeight: weight.medium},
  keyBlank: {width: 76, height: 64},
  keyBack: {width: 76, height: 64, alignItems: 'center', justifyContent: 'center'},
  keyBackText: {fontSize: 24, color: colors.textSecondary},
  footnote: {textAlign: 'center', fontSize: 13, color: colors.textMuted, marginTop: 14},
});
