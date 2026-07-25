/**
 * SendProgress — delivery indicator for an optimistic write.
 *
 * Two visible states, by design:
 *   in flight (sending / accepted) → a thin indeterminate progress bar
 *   confirmed                      → a brief ✓ that fades out (post is simply there afterwards)
 *   failed (ambiguous/transient)   → red "failed" with Retry and Cancel (Cancel = stop retrying).
 *   rejected (permanent relay "no")→ red "failed" with Cancel ONLY — retrying the same signed event
 *                                    is futile (C3), so no Retry is offered. Both 'failed' and
 *                                    'rejected' show the relay's reason as muted subtext (when present)
 *                                    so the failure isn't opaque.
 *
 * There is intentionally no cancel control while a send is in flight; cancelling is only offered
 * after a failure. No SVG dependency — the bar is a clipped track with a sliding segment.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, type as typeScale, weight} from '../../ui/theme';
import type {SendStatus} from '../../nostr/outbox';
import {calmRejection} from '../rejectionMessages';

export interface SendProgressProps {
  status?: SendStatus;
  /** Relay's rejection reason (when status is 'rejected'); shown as muted subtext under "failed". */
  reason?: string;
  onRetry?: () => void;
  /** Stop retrying / dismiss after a failure. */
  onCancel?: () => void;
  /** Nominal scale; the bar width derives from it (kept for call-site compatibility). */
  size?: number;
  /**
   * True when a 'sending' status is a pre-connect QUEUE (relay/Tor not up yet) rather than an active
   * in-flight publish (see AppSnapshot.sendQueuedOffline). Only changes the label text next to the
   * indeterminate bar — "Queued — connecting…" instead of "Sending…" — so the deliberate wait during
   * a sync/reconnect reads as intentional, not stuck (M7). Ignored for any other status.
   */
  queuedOffline?: boolean;
}

export function SendProgress({status, reason, onRetry, onCancel, size = 16, queuedOffline}: SendProgressProps): React.JSX.Element | null {
  const trackWidth = Math.round(size * 2.6);
  const segWidth = Math.round(trackWidth * 0.4);
  const slide = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;

  const inFlight = status === 'sending' || status === 'accepted';
  const confirmed = status === 'confirmed';

  // Indeterminate sliding segment while the send is in flight.
  useEffect(() => {
    if (!inFlight) return;
    slide.setValue(0);
    const anim = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 950,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [inFlight, slide]);

  // On success: hold the ✓ briefly, then fade it out.
  useEffect(() => {
    if (!confirmed) return;
    fade.setValue(1);
    const anim = Animated.timing(fade, {
      toValue: 0,
      duration: 450,
      delay: 900,
      easing: Easing.in(Easing.ease),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [confirmed, fade]);

  if (!status) return null;

  // 'failed' (ambiguous/transient) and 'rejected' (a permanent relay OK-frame refusal) both render as
  // red "failed" with the relay's reason so the failure isn't opaque. Retry is offered ONLY for
  // 'failed': a permanent 'rejected' is terminal (see outbox.unsent) and re-sending the SAME signed
  // event just earns the same "no" (C3), so it shows Cancel only.
  if (status === 'failed' || status === 'rejected') {
    const canRetry = status === 'failed';
    // Map the raw relay reason to calm, plain-language copy at RENDER time only (the raw message
    // stays in the outbox/logs). An unknown/legacy code falls back to the raw prose with no
    // next-step — byte-identical to what the user saw before T12.
    const calm = reason ? calmRejection(reason) : null;
    return (
      <View style={s.failedWrap}>
        <View style={s.failedRow}>
          <Text style={s.failedText}>failed</Text>
          {canRetry && onRetry && (
            <Press onPress={onRetry}>
              <Text style={s.retry}>Retry</Text>
            </Press>
          )}
          {onCancel && (
            <Press onPress={onCancel}>
              <Text style={s.cancel}>Cancel</Text>
            </Press>
          )}
        </View>
        {calm ? (
          <>
            <Text style={s.reason} numberOfLines={2}>{calm.text}</Text>
            {calm.nextStep ? (
              <Text style={s.nextStep} numberOfLines={1}>{calm.nextStep}</Text>
            ) : null}
          </>
        ) : null}
      </View>
    );
  }

  if (confirmed) {
    return <Animated.Text style={[s.check, {opacity: fade}]}>✓</Animated.Text>;
  }

  // In flight: a quiet label + thin indeterminate bar. 'sending' while queued offline (relay/Tor not
  // up yet) reads "Queued — connecting…" instead of "Sending…" (M7) — a render-only distinction; the
  // delivery/retry logic behind it is unchanged.
  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-segWidth, trackWidth],
  });
  const inFlightLabel = status === 'sending' && queuedOffline ? 'Queued — connecting…' : 'Sending…';
  return (
    <View style={s.inFlightWrap}>
      <Text style={s.inFlightLabel} numberOfLines={1}>{inFlightLabel}</Text>
      <View style={[s.track, {width: trackWidth}]} accessibilityLabel="sending">
        <Animated.View style={[s.segment, {width: segWidth, transform: [{translateX}]}]} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  inFlightWrap: {flexDirection: 'row', alignItems: 'center', gap: 6},
  inFlightLabel: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: weight.regular},
  track: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.border,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  segment: {height: 3, borderRadius: 1.5, backgroundColor: colors.accent},
  check: {color: colors.accent, fontSize: typeScale.caption, fontWeight: weight.semibold},
  failedWrap: {alignItems: 'flex-end', gap: 2},
  failedRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  failedText: {fontSize: typeScale.micro + 1, color: colors.danger, fontWeight: weight.semibold},
  reason: {fontSize: typeScale.micro, color: colors.textMuted, textAlign: 'right', maxWidth: 200},
  nextStep: {fontSize: typeScale.micro, color: colors.textMuted, textAlign: 'right', maxWidth: 200},
  retry: {fontSize: typeScale.micro + 1, color: colors.accent, fontWeight: weight.semibold},
  cancel: {fontSize: typeScale.micro + 1, color: colors.textMuted, fontWeight: weight.semibold},
});
