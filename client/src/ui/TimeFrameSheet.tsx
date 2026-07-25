/**
 * TimeFrameSheet — a bottom-sheet for choosing the time window a search covers.
 *
 * Two ways to pick: quick presets (Any time / Past hour / 24h / 7d / 30d) or a precise custom
 * range with a start and end date, each with an optional time, and a "Now" toggle for an
 * open-ended end. It is presentation-only: it holds a draft while open and hands the parent a
 * {@link TimeSelection} on Apply. The same sheet backs the feed, channels, groups and DM search.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Press} from './Press';
import {DENSE_MAX_FONT_SCALE, colors, radius, space, type as typeScale, weight} from './theme';
import {
  ALL_TIME,
  fmtDate,
  fmtTime,
  parseDateTime,
  PRESETS,
  type PresetKey,
  selectionLabel,
  type TimeSelection,
} from './timeframe';

export interface TimeFrameSheetProps {
  visible: boolean;
  value: TimeSelection;
  onClose: () => void;
  onApply: (selection: TimeSelection) => void;
}

type Mode = 'all' | PresetKey | 'custom';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function TimeFrameSheet({visible, value, onClose, onApply}: TimeFrameSheetProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('all');
  const [fromDate, setFromDate] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toDate, setToDate] = useState('');
  const [toTime, setToTime] = useState('');
  const [toNow, setToNow] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Latest `value` without re-seeding the draft on every parent render — we only re-seed when the
  // sheet opens (see the effect below).
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!visible) return;
    const v = valueRef.current;
    const now = nowSec();
    setError(null);
    if (v.kind === 'custom') {
      setMode('custom');
      setFromDate(fmtDate(v.from));
      setFromTime(fmtTime(v.from));
      if (v.to == null) {
        setToNow(true);
        setToDate(fmtDate(now));
        setToTime(fmtTime(now));
      } else {
        setToNow(false);
        setToDate(fmtDate(v.to));
        setToTime(fmtTime(v.to));
      }
    } else {
      setMode(v.kind === 'preset' ? v.preset : 'all');
      // Seed the custom fields with a sensible default (last 7 days → now) so switching to custom
      // starts from something editable rather than blank.
      setFromDate(fmtDate(now - 604800));
      setFromTime('00:00');
      setToNow(true);
      setToDate(fmtDate(now));
      setToTime(fmtTime(now));
    }
  }, [visible]);

  const selectCustom = (): void => { setMode('custom'); setError(null); };

  // Live preview of a valid custom range (mirrors the button's label wording).
  const preview = useMemo<string | null>(() => {
    if (mode !== 'custom') return null;
    const from = parseDateTime(fromDate, fromTime, false);
    if (from == null) return null;
    if (toNow) return `Showing ${selectionLabel({kind: 'custom', from, to: null})}`;
    const to = parseDateTime(toDate, toTime, true);
    if (to == null) return null;
    return `Showing ${selectionLabel({kind: 'custom', from, to})}`;
  }, [mode, fromDate, fromTime, toDate, toTime, toNow]);

  const apply = (): void => {
    if (mode === 'all') { onApply(ALL_TIME); onClose(); return; }
    if (mode !== 'custom') { onApply({kind: 'preset', preset: mode}); onClose(); return; }

    const from = parseDateTime(fromDate, fromTime, false);
    if (from == null) { setError('Enter a valid start date, e.g. 2026-01-01.'); return; }
    let to: number | null = null;
    if (!toNow) {
      const parsed = parseDateTime(toDate, toTime, true);
      if (parsed == null) { setError('Enter a valid end date, e.g. 2026-07-01.'); return; }
      to = parsed;
    }
    if ((to ?? nowSec()) < from) { setError('The end must come after the start.'); return; }
    onApply({kind: 'custom', from, to});
    onClose();
  };

  const clear = (): void => { onApply(ALL_TIME); onClose(); };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Press variant="bare" style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="close-time-frame" accessibilityRole="none" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.sheet}>
            <View style={s.grabber} />
            <Text style={s.title} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Time frame</Text>
            <Text style={s.subtitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Filter results by when they were posted.
            </Text>

            <View style={s.presetRow}>
              <Chip label="Any time" active={mode === 'all'} onPress={() => { setMode('all'); setError(null); }} />
              {PRESETS.map(p => (
                <Chip key={p.key} label={p.label} active={mode === p.key} onPress={() => { setMode(p.key); setError(null); }} />
              ))}
            </View>

            <Text style={s.sectionLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>CUSTOM RANGE</Text>
            <View style={[s.customCard, mode === 'custom' && s.customCardActive]}>
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>From</Text>
                <TextInput
                  style={s.dateInput}
                  value={fromDate}
                  onChangeText={t => { setFromDate(t); selectCustom(); }}
                  onFocus={selectCustom}
                  placeholder="2026-01-01"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                />
                <TextInput
                  style={s.timeInput}
                  value={fromTime}
                  onChangeText={t => { setFromTime(t); selectCustom(); }}
                  onFocus={selectCustom}
                  placeholder="00:00"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                />
              </View>
              <View style={s.divider} />
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>To</Text>
                {toNow ? (
                  <Text style={s.nowText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Now</Text>
                ) : (
                  <>
                    <TextInput
                      style={s.dateInput}
                      value={toDate}
                      onChangeText={t => { setToDate(t); selectCustom(); }}
                      onFocus={selectCustom}
                      placeholder="2026-07-01"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="numbers-and-punctuation"
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={10}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                    />
                    <TextInput
                      style={s.timeInput}
                      value={toTime}
                      onChangeText={t => { setToTime(t); selectCustom(); }}
                      onFocus={selectCustom}
                      placeholder="23:59"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                    />
                  </>
                )}
                <Press
                  style={[s.nowChip, toNow && s.nowChipActive]}
                  onPress={() => { setToNow(n => !n); selectCustom(); }}>
                  <Text
                    style={[s.nowChipText, toNow && s.nowChipTextActive]}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Now
                  </Text>
                </Press>
              </View>
            </View>

            {error ? (
              <Text style={s.error} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{error}</Text>
            ) : preview ? (
              <Text style={s.preview} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{preview}</Text>
            ) : (
              <Text style={s.hint} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Dates are YYYY-MM-DD. Time is optional (24-hour).
              </Text>
            )}

            <View style={s.actions}>
              <Press style={s.clearBtn} onPress={clear}>
                <Text style={s.clearText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Clear</Text>
              </Press>
              <Press style={s.applyBtn} onPress={apply}>
                <Text style={s.applyText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Apply</Text>
              </Press>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function Chip({label, active, onPress}: {label: string; active: boolean; onPress: () => void}): React.JSX.Element {
  return (
    <Press style={[s.chip, active && s.chipActive]} onPress={onPress}>
      <Text style={[s.chipText, active && s.chipTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {label}
      </Text>
    </Press>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  grabber: {alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderLight, marginBottom: space.xs},
  title: {fontSize: typeScale.subheading, fontWeight: weight.bold, color: colors.textPrimary},
  subtitle: {fontSize: typeScale.caption, color: colors.textSecondary, marginBottom: space.xs},

  presetRow: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  chipActive: {backgroundColor: colors.accentSoft, borderColor: colors.accentTint},
  chipText: {color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: weight.semibold},
  chipTextActive: {color: colors.accent},

  sectionLabel: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: weight.semibold, letterSpacing: 0.6, marginTop: space.sm},
  customCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
  },
  customCardActive: {borderColor: colors.accentTint},
  fieldRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm},
  fieldLabel: {width: 40, fontSize: typeScale.label, color: colors.textSecondary, fontWeight: weight.medium},
  dateInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: weight.regular,
    paddingVertical: Platform.OS === 'ios' ? 6 : 2,
  },
  timeInput: {
    width: 58,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: weight.regular,
    textAlign: 'center',
    paddingVertical: Platform.OS === 'ios' ? 6 : 2,
  },
  nowText: {flex: 1, fontSize: typeScale.body, color: colors.textSecondary, fontWeight: weight.regular},
  divider: {height: 1, backgroundColor: colors.border},
  nowChip: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  nowChipActive: {backgroundColor: colors.accentSoft, borderColor: colors.accentTint},
  nowChipText: {fontSize: typeScale.caption, color: colors.textSecondary, fontWeight: weight.semibold},
  nowChipTextActive: {color: colors.accent},

  hint: {fontSize: typeScale.caption, color: colors.textMuted, marginTop: space.xs},
  preview: {fontSize: typeScale.caption, color: colors.accent, marginTop: space.xs},
  error: {fontSize: typeScale.caption, color: colors.danger, marginTop: space.xs},

  actions: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.sm, marginTop: space.sm},
  clearBtn: {paddingHorizontal: space.md, paddingVertical: space.sm},
  clearText: {color: colors.textSecondary, fontSize: typeScale.body, fontWeight: weight.medium},
  applyBtn: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: space.xl, paddingVertical: space.sm},
  applyText: {color: colors.onAccent, fontSize: typeScale.body, fontWeight: weight.semibold},
});
