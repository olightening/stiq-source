/**
 * ReliabilitySheet — bottom sheet for the battery-optimization exemption + OEM reliability guidance
 * (W3, Tor stability+speed). Structurally mirrors ConnectionSheet: same Modal/overlay/sheet/header
 * chrome, same StyleSheet tokens (radius/space/type/weight), same "Done" close button.
 *
 * Shows live exemption status (re-checked on open and after returning from the system dialog), a
 * primary "Allow background connection" button that fires the OS request and re-checks, the detected
 * device's OEM-specific step list (dontkillmyapp.com-style), and a "lock the app in recents" tip. All
 * copy is pulled from reliability.ts's RELIABILITY_COPY — this file holds no strings of its own.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {DENSE_MAX_FONT_SCALE, radius, space, type as typeScale, weight, type Palette} from '../../ui/theme';
import {
  RELIABILITY_COPY,
  classifyOem,
  getDeviceVendorInfo,
  getOemGuidance,
  hasAcknowledgedOemSteps,
  isIgnoringBatteryOptimizations,
  reliabilityActionNeeded,
  requestIgnoreBatteryOptimizations,
  setOemStepsAcknowledged,
  type DeviceVendorInfo,
} from '../../power/reliability';

export interface ReliabilitySheetProps {
  visible: boolean;
  onClose: () => void;
  c: Palette;
}

export function ReliabilitySheet({visible, onClose, c}: ReliabilitySheetProps): React.JSX.Element {
  const [exempt, setExempt] = useState<boolean | null>(null);
  const [vendor, setVendor] = useState<DeviceVendorInfo | null>(null);
  const [acked, setAcked] = useState(false);
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const [nextExempt, nextVendor, nextAcked] = await Promise.all([
        isIgnoringBatteryOptimizations(),
        getDeviceVendorInfo(),
        hasAcknowledgedOemSteps(),
      ]);
      setExempt(nextExempt);
      setVendor(nextVendor);
      setAcked(nextAcked);
    } finally {
      setChecking(false);
    }
  }, []);

  // Re-check every time the sheet opens — the exemption may have changed since a prior visit (the
  // user could have granted it from Android's own Settings app, outside this sheet entirely).
  useEffect(() => {
    if (!visible) {
      return;
    }
    void recheck();
  }, [visible, recheck]);

  const handleAllow = useCallback(() => {
    requestIgnoreBatteryOptimizations();
    // The system dialog is a separate Activity; there's no callback for when it closes, so poll once
    // after a beat (long enough for a quick tap-through) rather than leaving stale status showing.
    setTimeout(() => {
      void recheck();
    }, 1200);
  }, [recheck]);

  const handleAcknowledge = useCallback(() => {
    setAcked(true);
    void setOemStepsAcknowledged(true);
  }, []);

  const handleUndoAcknowledge = useCallback(() => {
    setAcked(false);
    void setOemStepsAcknowledged(false);
  }, []);

  const tier = vendor ? classifyOem(vendor.manufacturer, vendor.brand) : 'clean';
  const guidance = vendor ? getOemGuidance(vendor.manufacturer, vendor.brand) : null;
  const showOemSteps = vendor !== null && (tier === 'aggressive' || tier === 'moderate');
  // Derived from the SAME predicate as the Settings row badge, so the sheet's status card and the
  // row never disagree (null while the initial check is still in flight).
  const actionNeeded =
    exempt !== null && vendor !== null ? reliabilityActionNeeded(exempt, tier, acked) : null;
  const stepsPending = exempt === true && tier === 'aggressive' && !acked;

  const statusColor = actionNeeded === null ? c.textMuted : actionNeeded ? c.warning : c.success;
  const statusLabel =
    actionNeeded === null
      ? RELIABILITY_COPY.recheckingLabel
      : exempt === false
        ? RELIABILITY_COPY.statusNotGrantedLabel
        : stepsPending
          ? RELIABILITY_COPY.statusStepsPendingLabel
          : RELIABILITY_COPY.statusGrantedLabel;
  const statusSub =
    actionNeeded === null
      ? ''
      : exempt === false
        ? RELIABILITY_COPY.statusNotGrantedSub
        : stepsPending
          ? RELIABILITY_COPY.statusStepsPendingSub
          : RELIABILITY_COPY.statusGrantedSub;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={[s.sheet, {backgroundColor: c.bg, borderColor: c.border}]}>
          <View style={[s.header, {borderBottomColor: c.border}]}>
            <View style={s.headerLeft}>
              <Text style={{color: statusColor, fontSize: 12}}>●</Text>
              <Text style={[s.title, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {RELIABILITY_COPY.sheetTitle}
              </Text>
            </View>
            <Press onPress={onClose} hitSlop={10}>
              <Text style={[s.done, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Done
              </Text>
            </Press>
          </View>

          <ScrollView style={s.list} showsVerticalScrollIndicator={false}>
            <View
              style={[
                s.statusCard,
                {
                  borderColor: actionNeeded === null ? c.border : actionNeeded ? c.warning : c.success,
                  backgroundColor:
                    actionNeeded === null ? c.surfaceAlt : actionNeeded ? c.warningBg : c.successBg,
                },
              ]}>
              <Text style={[s.statusTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {statusLabel}
              </Text>
              {statusSub ? (
                <Text
                  style={[s.statusSub, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {statusSub}
                </Text>
              ) : null}
            </View>

            {exempt === false && (
              <Press
                style={[s.allowBtn, {backgroundColor: c.accent}]}
                onPress={handleAllow}
                disabled={checking}>
                <Text
                  style={[s.allowText, {color: c.onAccent}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {RELIABILITY_COPY.allowButtonLabel}
                </Text>
              </Press>
            )}
            {exempt === false && (
              <Text
                style={[s.allowSub, {color: c.textSecondary}]}
                maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {RELIABILITY_COPY.allowButtonSub}
              </Text>
            )}

            {showOemSteps && guidance && (
              <>
                <Text
                  style={[s.sectionLabel, {color: c.textPrimary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {RELIABILITY_COPY.oemSectionTitle(guidance.label)}
                </Text>
                {guidance.steps.map((step, i) => (
                  <View key={i} style={s.stepRow}>
                    <Text
                      style={[s.stepBullet, {color: c.accent}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {i + 1}.
                    </Text>
                    <Text
                      style={[s.stepText, {color: c.textSecondary}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {step}
                    </Text>
                  </View>
                ))}
                {tier === 'aggressive' &&
                  (!acked ? (
                    <Press
                      style={[s.ackBtn, {borderColor: c.accent}]}
                      onPress={handleAcknowledge}>
                      <Text
                        style={[s.ackText, {color: c.accent}]}
                        maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {RELIABILITY_COPY.ackButtonLabel}
                      </Text>
                    </Press>
                  ) : (
                    <View style={s.ackedRow}>
                      <Text
                        style={[s.ackedText, {color: c.success}]}
                        maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {RELIABILITY_COPY.ackedLabel}
                      </Text>
                      <Press onPress={handleUndoAcknowledge} hitSlop={8}>
                        <Text
                          style={[s.ackedUndo, {color: c.textSecondary}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {RELIABILITY_COPY.ackedUndoLabel}
                        </Text>
                      </Press>
                    </View>
                  ))}
              </>
            )}

            <Text style={[s.sectionLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {RELIABILITY_COPY.recentsTipTitle}
            </Text>
            <Text style={[s.tipBody, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {RELIABILITY_COPY.recentsTipBody}
            </Text>

            <View style={s.bottomPad} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    paddingBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  title: {fontSize: typeScale.subheading, fontWeight: weight.bold},
  done: {fontSize: typeScale.body, fontWeight: weight.semibold},
  list: {paddingHorizontal: space.md, paddingTop: space.md},

  statusCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: space.sm,
  },
  statusTitle: {fontSize: typeScale.body, fontWeight: weight.semibold},
  statusSub: {fontSize: typeScale.caption, marginTop: 4, lineHeight: 18},

  allowBtn: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  allowText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  allowSub: {fontSize: typeScale.caption, marginTop: 6, marginBottom: space.sm, lineHeight: 18},

  sectionLabel: {fontSize: typeScale.label, fontWeight: weight.semibold, marginTop: space.md},
  stepRow: {flexDirection: 'row', gap: 6, marginTop: space.xs, paddingRight: 4},
  stepBullet: {fontSize: typeScale.caption, fontWeight: weight.semibold, minWidth: 16},
  stepText: {fontSize: typeScale.caption, lineHeight: 18, flex: 1},
  tipBody: {fontSize: typeScale.caption, lineHeight: 18, marginTop: 4},

  ackBtn: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  ackText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  ackedRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm},
  ackedText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  ackedUndo: {fontSize: typeScale.caption, fontWeight: weight.semibold, textDecorationLine: 'underline'},

  bottomPad: {height: 32},
});
