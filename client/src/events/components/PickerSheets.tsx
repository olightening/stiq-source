/**
 * PickerSheets — the event editor's date/time/timezone picker sheets.
 *
 * The event editor originally asked for date/time/timezone as raw text fields; these three
 * bottom sheets replace that with real pickers (user-requested). They follow the house
 * bottom-sheet chrome (scrim Pressable → card Pressable with a centered grabber) and the
 * Android RN 0.76 always-mounted Modal law: each Modal here is rendered unconditionally by
 * the parent and only its `visible` prop toggles — never wrap the Modal itself in a condition.
 *
 * - `DatePickerSheet` — a plain-Date-math month calendar (Monday-first week), no external libs.
 * - `TimePickerSheet` — two scrollable hour/minute columns, pending-state until "Set time".
 * - `OptionSheet` — a generic single-select list sheet (used for timezone and similar dropdowns).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, weight} from '../../ui/theme';

// ── Shared date helpers (plain Date math, no external libs) ────────────────────────────────────

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Parse 'YYYY-MM-DD' into {year, month(0-based), day}, or null if empty/invalid. */
function parseDate(value: string): {year: number; month: number; day: number} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return {year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3])};
}

/** Sunday-0 getDay() → Monday-first offset (0 = Monday … 6 = Sunday). */
function mondayFirstOffset(jsDay: number): number {
  return (jsDay + 6) % 7;
}

// ── DatePickerSheet ──────────────────────────────────────────────────────────────────────────

export interface DatePickerSheetProps {
  visible: boolean;
  /** 'YYYY-MM-DD', or '' when no date has been chosen yet. */
  value: string;
  /** Called with a zero-padded 'YYYY-MM-DD' when a day is tapped; the parent closes the sheet. */
  onSelect: (date: string) => void;
  /** "No date yet" — events support TBD dates. */
  onClear: () => void;
  onClose: () => void;
}

export function DatePickerSheet({visible, value, onSelect, onClear, onClose}: DatePickerSheetProps): React.JSX.Element {
  const selected = parseDate(value);
  const today = new Date();
  const initial = selected ?? {year: today.getFullYear(), month: today.getMonth(), day: today.getDate()};
  const [viewYear, setViewYear] = useState<number>(initial.year);
  const [viewMonth, setViewMonth] = useState<number>(initial.month);

  // Reset the displayed month to the selected date's month (or today's) each time the sheet opens.
  useEffect(() => {
    if (visible) {
      const base = parseDate(value);
      const now = new Date();
      setViewYear(base ? base.year : now.getFullYear());
      setViewMonth(base ? base.month : now.getMonth());
    }
  }, [visible, value]);

  const goPrevMonth = (): void => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const goNextMonth = (): void => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const firstOffset = mondayFirstOffset(new Date(viewYear, viewMonth, 1).getDay());
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < firstOffset; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: Array<Array<number | null>> = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const now = new Date();
  const isToday = (d: number): boolean =>
    viewYear === now.getFullYear() && viewMonth === now.getMonth() && d === now.getDate();
  const isSelected = (d: number): boolean =>
    !!selected && selected.year === viewYear && selected.month === viewMonth && selected.day === d;

  const pick = (d: number): void => {
    onSelect(`${viewYear}-${pad2(viewMonth + 1)}-${pad2(d)}`);
  };

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close date picker">
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none" accessibilityLabel="Date picker">
          <View style={s.grabber} />

          <View style={s.calHeader}>
            <Press
              style={s.calNavBtn}
              onPress={goPrevMonth}
              accessibilityLabel="Previous month">
              <Text style={s.calNavText}>‹</Text>
            </Press>
            <Text style={s.calMonthLabel}>{`${MONTH_NAMES[viewMonth]} ${viewYear}`}</Text>
            <Press
              style={s.calNavBtn}
              onPress={goNextMonth}
              accessibilityLabel="Next month">
              <Text style={s.calNavText}>›</Text>
            </Press>
          </View>

          <View style={s.weekdayRow}>
            {WEEKDAY_LABELS.map(label => (
              <View key={label} style={s.dayCell}>
                <Text style={s.weekdayText}>{label}</Text>
              </View>
            ))}
          </View>

          {rows.map((row, rowIdx) => (
            <View key={rowIdx} style={s.dayRow}>
              {row.map((d, colIdx) => {
                if (d === null) {
                  return <View key={colIdx} style={s.dayCell} />;
                }
                const sel = isSelected(d);
                const todayFlag = !sel && isToday(d);
                return (
                  <Press
                    key={colIdx}
                    style={[s.dayCell, sel ? s.dayCellSelected : null]}
                    onPress={() => pick(d)}
                    accessibilityLabel={`${MONTH_NAMES[viewMonth]} ${d}, ${viewYear}`}>
                    <Text style={[s.dayText, sel ? s.dayTextSelected : null, todayFlag ? s.dayTextToday : null]}>
                      {d}
                    </Text>
                  </Press>
                );
              })}
            </View>
          ))}

          <View style={s.footerRow}>
            <Press
              style={s.ghostBtn}
              onPress={onClear}
              accessibilityLabel="No date yet">
              <Text style={s.ghostBtnText}>No date yet</Text>
            </Press>
            <Press
              style={s.accentBtn}
              onPress={onClose}
              accessibilityLabel="Done choosing date">
              <Text style={s.accentBtnText}>Done</Text>
            </Press>
          </View>
        </Press>
      </Press>
    </Modal>
  );
}

// ── TimePickerSheet ──────────────────────────────────────────────────────────────────────────

export interface TimePickerSheetProps {
  visible: boolean;
  /** 'HH:MM' 24h, or '' when no time has been chosen yet. */
  value: string;
  /** Called with a zero-padded 'HH:MM' when "Set time" is pressed; the parent closes the sheet. */
  onSelect: (time: string) => void;
  /** "No time yet". */
  onClear: () => void;
  onClose: () => void;
}

const HOURS: number[] = Array.from({length: 24}, (_, i) => i);
const MINUTES: number[] = Array.from({length: 12}, (_, i) => i * 5);
const ROW_HEIGHT = 38;
const DEFAULT_HOUR = 18;
const DEFAULT_MINUTE = 0;

function parseTime(value: string): {hour: number; minute: number} | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return {hour: Number(m[1]), minute: Number(m[2])};
}

export function TimePickerSheet({visible, value, onSelect, onClear, onClose}: TimePickerSheetProps): React.JSX.Element {
  const [pendingHour, setPendingHour] = useState<number>(DEFAULT_HOUR);
  const [pendingMinute, setPendingMinute] = useState<number>(DEFAULT_MINUTE);
  const hourScrollRef = useRef<ScrollView>(null);
  const minuteScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!visible) return;
    const parsed = parseTime(value);
    const hour = parsed ? parsed.hour : DEFAULT_HOUR;
    // Snap to the nearest 5-minute step so the minute column always has a matching row.
    const minute = parsed ? Math.round(parsed.minute / 5) * 5 % 60 : DEFAULT_MINUTE;
    setPendingHour(hour);
    setPendingMinute(minute);

    const hourIdx = HOURS.indexOf(hour);
    const minuteIdx = MINUTES.indexOf(minute);
    requestAnimationFrame(() => {
      if (hourIdx >= 0) hourScrollRef.current?.scrollTo({y: hourIdx * ROW_HEIGHT, animated: false});
      if (minuteIdx >= 0) minuteScrollRef.current?.scrollTo({y: minuteIdx * ROW_HEIGHT, animated: false});
    });
  }, [visible, value]);

  const setTime = (): void => {
    onSelect(`${pad2(pendingHour)}:${pad2(pendingMinute)}`);
  };

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close time picker">
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none" accessibilityLabel="Time picker">
          <View style={s.grabber} />

          <View style={s.timeColumns}>
            <View style={s.timeColumn}>
              <Text style={s.timeColumnHeader}>HOUR</Text>
              <ScrollView ref={hourScrollRef} style={s.timeScroll} showsVerticalScrollIndicator={false}>
                {HOURS.map(h => {
                  const sel = h === pendingHour;
                  return (
                    <Press
                      key={h}
                      style={[s.timeRow, sel ? s.timeRowSelected : null]}
                      onPress={() => setPendingHour(h)}
                      accessibilityLabel={`${pad2(h)} hours`}>
                      <Text style={[s.timeRowText, sel ? s.timeRowTextSelected : null]}>{pad2(h)}</Text>
                    </Press>
                  );
                })}
              </ScrollView>
            </View>
            <View style={s.timeColumn}>
              <Text style={s.timeColumnHeader}>MIN</Text>
              <ScrollView ref={minuteScrollRef} style={s.timeScroll} showsVerticalScrollIndicator={false}>
                {MINUTES.map(m => {
                  const sel = m === pendingMinute;
                  return (
                    <Press
                      key={m}
                      style={[s.timeRow, sel ? s.timeRowSelected : null]}
                      onPress={() => setPendingMinute(m)}
                      accessibilityLabel={`${pad2(m)} minutes`}>
                      <Text style={[s.timeRowText, sel ? s.timeRowTextSelected : null]}>{pad2(m)}</Text>
                    </Press>
                  );
                })}
              </ScrollView>
            </View>
          </View>

          <View style={s.footerRow}>
            <Press
              style={s.ghostBtn}
              onPress={onClear}
              accessibilityLabel="No time yet">
              <Text style={s.ghostBtnText}>No time yet</Text>
            </Press>
            <Press
              style={s.accentBtn}
              onPress={setTime}
              accessibilityLabel="Set time">
              <Text style={s.accentBtnText}>Set time</Text>
            </Press>
          </View>
        </Press>
      </Press>
    </Modal>
  );
}

// ── OptionSheet ───────────────────────────────────────────────────────────────────────────────

export interface PickerOption {
  value: string;
  label: string;
}

export interface OptionSheetProps {
  visible: boolean;
  title: string;
  options: PickerOption[];
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function OptionSheet({visible, title, options, value, onSelect, onClose}: OptionSheetProps): React.JSX.Element {
  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel={`Close ${title}`}>
        <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none" accessibilityLabel={title}>
          <View style={s.grabber} />
          <Text style={s.optionTitle}>{title}</Text>
          <ScrollView style={s.optionScroll} showsVerticalScrollIndicator={false}>
            {options.map(opt => {
              const sel = opt.value === value;
              return (
                <Press
                  key={opt.value}
                  variant="row"
                  style={s.optionRow}
                  onPress={() => onSelect(opt.value)}
                  accessibilityLabel={opt.label}>
                  <Text style={[s.optionLabel, sel ? s.optionLabelSelected : null]}>{opt.label}</Text>
                  {sel ? <Text style={s.optionCheck}>✓</Text> : null}
                </Press>
              );
            })}
          </ScrollView>
          <Press style={s.cancelBtn} onPress={onClose} accessibilityLabel="Cancel">
            <Text style={s.cancelBtnText}>Cancel</Text>
          </Press>
        </Press>
      </Press>
    </Modal>
  );
}

// ── Shared bottom-sheet chrome ───────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.borderLight,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 9,
    paddingHorizontal: 18,
    paddingBottom: 20,
  },
  grabber: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.borderLight,
    alignSelf: 'center',
    marginBottom: 6,
  },

  footerRow: {flexDirection: 'row', gap: 10, marginTop: 14},
  ghostBtn: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
  },
  ghostBtnText: {fontSize: 14.5, fontWeight: weight.semibold, color: colors.textSecondary},
  accentBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
  },
  accentBtnText: {fontSize: 14.5, fontWeight: weight.semibold, color: colors.onAccent},

  // ── calendar ──
  calHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6},
  calNavBtn: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center'},
  calNavText: {fontSize: 20, fontWeight: weight.semibold, color: colors.textPrimary},
  calMonthLabel: {fontSize: 16, fontWeight: weight.bold, color: colors.textPrimary},
  weekdayRow: {flexDirection: 'row', marginTop: 4},
  weekdayText: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted},
  dayRow: {flexDirection: 'row'},
  dayCell: {flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md},
  dayCellSelected: {backgroundColor: colors.accent},
  dayText: {fontSize: 14.5, color: colors.textPrimary},
  dayTextSelected: {color: colors.onAccent, fontWeight: weight.semibold},
  dayTextToday: {color: colors.accent, fontWeight: weight.semibold},

  // ── time columns ──
  timeColumns: {flexDirection: 'row', gap: 12, marginTop: 6},
  timeColumn: {flex: 1},
  timeColumnHeader: {
    fontSize: 10,
    fontWeight: weight.bold,
    color: colors.textMuted,
    letterSpacing: 0.8,
    textAlign: 'center',
    marginBottom: 4,
  },
  timeScroll: {height: 200},
  timeRow: {paddingVertical: 9, alignItems: 'center', borderRadius: radius.md},
  timeRowSelected: {backgroundColor: colors.accent},
  timeRowText: {fontSize: 16, color: colors.textPrimary},
  timeRowTextSelected: {color: colors.onAccent, fontWeight: weight.bold},

  // ── option list ──
  optionTitle: {fontSize: 16, fontWeight: weight.bold, color: colors.textPrimary, marginTop: 4, marginBottom: 4},
  optionScroll: {maxHeight: 420},
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
  },
  optionLabel: {fontSize: 14.5, color: colors.textPrimary},
  optionLabelSelected: {fontWeight: weight.semibold},
  optionCheck: {fontSize: 14.5, color: colors.accent, fontWeight: weight.bold},
  cancelBtn: {alignItems: 'center', paddingVertical: 12, marginTop: 4},
  cancelBtnText: {fontSize: 14.5, fontWeight: weight.semibold, color: colors.textSecondary},
});
