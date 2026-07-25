/**
 * LockScreen — shown when an enrolled app is locked (PLAN.md §3.5). Renders the SAME PinKeypad as
 * OnboardingScreen's PIN step (design_handoff_onboarding) so the recurring lock screen is
 * pixel-identical to the PIN step the member set it up with, not a separately-designed surface —
 * see stiq-onboarding-pin-lock-unification. A completed entry submits to onSubmitPin, which routes
 * through LockController (standard vs duress).
 *
 * Security-critical UI rule (lock/controller.ts): a 'wiped' (duress) outcome MUST be
 * indistinguishable from a normal 'unlocked' — both simply let the app open. Only a
 * 'rejected' outcome surfaces anything to the user, and it shows a generic error (plus the same
 * shake PinKeypad uses for an onboarding PIN mismatch) so a shoulder-surfer can't tell a wrong PIN
 * from a duress PIN. On success this component does nothing visible: the snapshot's lock state
 * flips and routing moves on by itself.
 */
import React, {useState} from 'react';
import {SafeAreaView, StyleSheet} from 'react-native';
import type {UnlockOutcome} from '../../lock/controller';
import {PinKeypad} from '../../ui/PinKeypad';
import {colors} from '../../ui/theme';
import {useSubmitGuard} from '../../ui/useSubmitGuard';

/**
 * Onboarding is the only place a PIN is ever enrolled (OnboardingScreen's PIN step), and it always
 * produces a 4-digit PIN — the PIN vault stores only a salted hash, never a length, so this is not
 * discoverable at runtime and must match that enrollment constant.
 */
const ENROLLED_PIN_LENGTH = 4;

export interface LockScreenProps {
  /** Verifies the PIN; resolves to the unlock outcome. Absent on builds without a vault. */
  onSubmitPin?: (pin: string) => Promise<UnlockOutcome>;
}

export function LockScreen({onSubmitPin}: LockScreenProps): React.JSX.Element {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped on every rejection to replay PinKeypad's shake — the pad has already self-cleared by the
  // time an async verify resolves, so this is how a caller (rather than a same-tick mismatch, as in
  // onboarding) triggers the same cue.
  const [shakeSignal, setShakeSignal] = useState(0);
  const guard = useSubmitGuard();

  const submit = async (pin: string): Promise<void> => {
    if (!onSubmitPin) return;
    await guard(async () => {
      setBusy(true);
      setError('');
      try {
        const outcome = await onSubmitPin(pin);
        // 'unlocked' and 'wiped' both just open the app (routing reacts to the snapshot).
        // Only a rejected PIN is surfaced — with a generic message (no duress disclosure).
        if (outcome === 'rejected') {
          setError('Incorrect PIN. Try again.');
          setShakeSignal(n => n + 1);
        }
      } catch {
        setError('Incorrect PIN. Try again.');
        setShakeSignal(n => n + 1);
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <SafeAreaView style={s.root}>
      <PinKeypad
        title="Enter your PIN"
        helper="Unlock Stiq to continue."
        error={error}
        busy={busy}
        length={ENROLLED_PIN_LENGTH}
        onComplete={submit}
        // Start the (slow, KDF-backed) verify the instant the last digit lands so it overlaps the
        // confirmation flash instead of adding ~200ms of dead time before unlock.
        asyncComplete
        shakeSignal={shakeSignal}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
});
