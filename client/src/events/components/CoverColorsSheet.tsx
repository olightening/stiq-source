/**
 * CoverColorsSheet — the organizer's gradient-cover picker bottom sheet (EventsOrganizer org-04).
 *
 * The web DC picks cover colours with two `<input type="color">` chips + a `<input type="range">`
 * direction + a preset row. The app has no native colour input, so — per the handoff fidelity rule —
 * tapping a Start/End chip opens the app's HSV pick surface (the saturation/value square + hue slider
 * ported from ui/GradientMaker), which is how the app maps web colour inputs. org-04's layout wins:
 * preview → Start/End rows → Direction → Presets → Done, measured to REDLINES §4.
 *
 * Pure VM: operates on a {@link GradientSpec} via `value`/`onChange`; no runtime/store imports.
 * Re-exports {@link GradientRect} (a rectangular SVG gradient fill, now shared at ui/GradientRect —
 * EventCard/EventDetailScreen's covers use the same measured implementation) + gradient seed helpers
 * reused by the editor's cover swatch.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {Press} from '../../ui/Press';
import {
  DEFAULT_LINEAR_ANGLE,
  gradientSpecEqual,
  hexToHsv,
  hsvToHex,
  isCompleteHex,
  normalizeHex,
  type GradientSpec,
  type HSV,
} from '../../media/gradient';
import {colors, radius as rad, space, type as typeScale, weight} from '../../ui/theme';
import {DEFAULT_COVER_GRADIENT, GradientRect, toGradientSpec} from '../../ui/GradientRect';

export {DEFAULT_COVER_GRADIENT, GradientRect, toGradientSpec};

/** The DC's six cover presets (org-04 `gradients` list), as specs. */
const PRESET_GRADIENTS: GradientSpec[] = [
  {type: 'linear', angle: 135, stops: ['#7cb2ff', '#b89aff']},
  {type: 'linear', angle: 135, stops: ['#10b981', '#06b6d4']},
  {type: 'linear', angle: 135, stops: ['#f59e0b', '#ec4899']},
  {type: 'linear', angle: 135, stops: ['#8b5cf6', '#ec4899']},
  {type: 'linear', angle: 135, stops: ['#3b82f6', '#8b5cf6']},
  {type: 'linear', angle: 135, stops: ['#ffd08a', '#ff9ec6']},
];

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// ── Scroll-proof drag surface (ported from ui/GradientMaker) ────────────────────────────────────
function useDragSurface(onMove: (nx: number, ny: number) => void): {
  ref: React.RefObject<View>;
  onLayout: () => void;
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
} {
  const ref = useRef<View>(null);
  const frame = useRef({px: 0, py: 0, w: 0, h: 0});
  const cb = useRef(onMove);
  cb.current = onMove;

  const remeasure = useCallback(() => {
    ref.current?.measure((_x, _y, w, h, px, py) => {
      if (w > 0 && h > 0) {frame.current = {px, py, w, h};}
    });
  }, []);

  const emit = useCallback((px: number, py: number) => {
    const f = frame.current;
    if (f.w <= 0 || f.h <= 0) {return;}
    cb.current(clamp01((px - f.px) / f.w), clamp01((py - f.py) / f.h));
  }, []);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (_e, g) => {
        ref.current?.measure((_x, _y, w, h, px, py) => {
          if (w > 0 && h > 0) {
            frame.current = {px, py, w, h};
            emit(g.x0, g.y0);
          }
        });
      },
      onPanResponderMove: (_e, g) => emit(g.moveX, g.moveY),
    }),
  ).current;

  return {ref, onLayout: remeasure, panHandlers: responder.panHandlers};
}

const HUE_STOPS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'];

function SVSquare({hue, sat, val, uid, onChange}: {hue: number; sat: number; val: number; uid: string; onChange: (s: number, v: number) => void}): React.JSX.Element {
  const {ref, onLayout, panHandlers} = useDragSurface((nx, ny) => onChange(nx, 1 - ny));
  return (
    <View ref={ref} onLayout={onLayout} style={pk.square} {...panHandlers}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={`${uid}-sat`} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#ffffff" />
            <Stop offset="1" stopColor={hsvToHex(hue, 1, 1)} />
          </LinearGradient>
          <LinearGradient id={`${uid}-val`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100" height="100" fill={`url(#${uid}-sat)`} />
        <Rect width="100" height="100" fill={`url(#${uid}-val)`} />
      </Svg>
      <View
        pointerEvents="none"
        style={[pk.svThumb, {left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, backgroundColor: hsvToHex(hue, sat, val)}]}
      />
    </View>
  );
}

function HueSlider({hue, uid, onChange}: {hue: number; uid: string; onChange: (h: number) => void}): React.JSX.Element {
  const {ref, onLayout, panHandlers} = useDragSurface(nx => onChange(nx * 360));
  return (
    <View ref={ref} onLayout={onLayout} style={pk.hue} {...panHandlers}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={`${uid}-hue`} x1="0" y1="0" x2="1" y2="0">
            {HUE_STOPS.map((c, i) => (
              <Stop key={c} offset={i / (HUE_STOPS.length - 1)} stopColor={c} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100" height="100" fill={`url(#${uid}-hue)`} />
      </Svg>
      <View pointerEvents="none" style={[pk.hueThumb, {left: `${(hue / 360) * 100}%`, backgroundColor: hsvToHex(hue, 1, 1)}]} />
    </View>
  );
}

/**
 * The HSV pick surface for a single stop. Held HSV state (not re-derived from hex each frame) keeps
 * hue/saturation alive at the extremes; keyed by the caller so switching stops remounts it fresh.
 */
function StopPicker({color, onChange}: {color: string; onChange: (hex: string) => void}): React.JSX.Element {
  const uid = useMemo(() => `sp${Math.floor(Math.random() * 1e9).toString(36)}`, []);
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(normalizeHex(color)));
  const [hexDraft, setHexDraft] = useState(normalizeHex(color));

  const commit = (next: HSV): void => {
    setHsv(next);
    const hex = hsvToHex(next.h, next.s, next.v);
    setHexDraft(hex);
    onChange(hex);
  };
  const onHexChange = (text: string): void => {
    const t = text.startsWith('#') ? text : `#${text}`;
    setHexDraft(t);
    if (isCompleteHex(t)) {
      const n = normalizeHex(t);
      setHsv(hexToHsv(n));
      onChange(n);
    }
  };

  return (
    <View style={pk.wrap}>
      <SVSquare hue={hsv.h} sat={hsv.s} val={hsv.v} uid={uid} onChange={(s, v) => commit({h: hsv.h, s, v})} />
      <HueSlider hue={hsv.h} uid={uid} onChange={h => commit({h, s: hsv.s, v: hsv.v})} />
      <View style={pk.hexRow}>
        <View style={[pk.hexSwatch, {backgroundColor: normalizeHex(hexDraft)}]} />
        <TextInput
          style={pk.hexInput}
          value={hexDraft}
          onChangeText={onHexChange}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={7}
          placeholder="#RRGGBB"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="hex colour code"
        />
      </View>
    </View>
  );
}

// ── Direction slider — detented to 15° steps (DC input[type=range] step 15) ──────────────────────
const DIR_STEPS = 24; // 0,15,…,345
function DirectionSlider({angle, onChange}: {angle: number; onChange: (a: number) => void}): React.JSX.Element {
  const activeIdx = ((Math.round((((angle % 360) + 360) % 360) / 15) % DIR_STEPS) + DIR_STEPS) % DIR_STEPS;
  const {ref, onLayout, panHandlers} = useDragSurface(nx => onChange(Math.round(clamp01(nx) * (DIR_STEPS - 1)) * 15));
  return (
    <View ref={ref} onLayout={onLayout} style={dir.track} {...panHandlers}>
      <View pointerEvents="none" style={dir.rail} />
      <View pointerEvents="none" style={[dir.thumb, {left: `${(activeIdx / (DIR_STEPS - 1)) * 100}%`}]} />
    </View>
  );
}

// ── The sheet ───────────────────────────────────────────────────────────────────────────────────
export interface CoverColorsSheetProps {
  visible: boolean;
  value: GradientSpec;
  onChange: (g: GradientSpec) => void;
  onDone: () => void;
  onClose: () => void;
}

export function CoverColorsSheet({visible, value, onChange, onDone, onClose}: CoverColorsSheetProps): React.JSX.Element {
  // Which stop the HSV surface is editing: 0 = Start, 1 = End, null = collapsed.
  const [picking, setPicking] = useState<0 | 1 | null>(null);

  const start = normalizeHex(value.stops[0] ?? DEFAULT_COVER_GRADIENT.stops[0]!);
  const end = normalizeHex(value.stops[value.stops.length - 1] ?? DEFAULT_COVER_GRADIENT.stops[1]!);
  const angle = Math.round(value.angle ?? DEFAULT_LINEAR_ANGLE);

  const setStop = (idx: 0 | 1, hex: string): void => {
    onChange({type: 'linear', angle, stops: idx === 0 ? [hex, end] : [start, hex]});
  };
  const activeColor = picking === 0 ? start : end;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetRoot}>
        <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close" />
        <KeyboardAvoidingView
          style={s.card}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
          <View style={s.grabber} />
          <Text style={s.title}>Cover colors</Text>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scrollBody}>
            <GradientRect gradient={value} radius={14} style={s.preview} />

            <View style={s.stopRow}>
              {([0, 1] as const).map(idx => {
                const isActive = picking === idx;
                const hex = idx === 0 ? start : end;
                return (
                  <Press
                    key={idx}
                    onPress={() => setPicking(isActive ? null : idx)}
                    style={[s.stopChip, isActive && s.stopChipActive]}
                    accessibilityLabel={idx === 0 ? 'Start colour' : 'End colour'}>
                    <View style={[s.stopSwatch, {backgroundColor: hex}]} />
                    <View style={s.flexMin}>
                      <Text style={s.stopLabel}>{idx === 0 ? 'Start' : 'End'}</Text>
                      <Text style={s.stopHex} numberOfLines={1}>{hex.toUpperCase()}</Text>
                    </View>
                  </Press>
                );
              })}
            </View>

            {picking !== null && (
              <StopPicker key={picking} color={activeColor} onChange={hex => setStop(picking, hex)} />
            )}

            <View style={s.dirHeader}>
              <Text style={s.dirLabel}>Direction</Text>
              <Text style={s.dirValue}>{angle}°</Text>
            </View>
            <DirectionSlider angle={angle} onChange={a => onChange({type: 'linear', angle: a, stops: [start, end]})} />

            <Text style={s.presetsEyebrow}>Presets</Text>
            <View style={s.presetsRow}>
              {PRESET_GRADIENTS.map((g, i) => {
                const selected = gradientSpecEqual(value, g);
                return (
                  <Press
                    key={i}
                    onPress={() => onChange(g)}
                    style={[s.preset, {borderColor: selected ? colors.accent : 'rgba(255,255,255,0.16)'}]}
                    accessibilityLabel={`Preset ${i + 1}`}>
                    <GradientRect gradient={g} radius={9} style={StyleSheet.absoluteFill} />
                  </Press>
                );
              })}
            </View>

            <Press onPress={onDone} style={s.doneBtn}>
              <Text style={s.doneText}>Done</Text>
            </Press>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const SV_THUMB = 22;
const HUE_THUMB = 26;
const pk = StyleSheet.create({
  wrap: {gap: space.md, marginTop: space.md},
  square: {width: '100%', height: 176, borderRadius: rad.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border},
  svThumb: {
    position: 'absolute',
    width: SV_THUMB,
    height: SV_THUMB,
    marginLeft: -SV_THUMB / 2,
    marginTop: -SV_THUMB / 2,
    borderRadius: SV_THUMB / 2,
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowColor: '#000000',
    shadowOpacity: 0.55,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 4,
  },
  hue: {width: '100%', height: 26, borderRadius: rad.pill, overflow: 'hidden', borderWidth: 1, borderColor: colors.border},
  hueThumb: {
    position: 'absolute',
    top: -1,
    width: HUE_THUMB,
    height: HUE_THUMB,
    marginLeft: -HUE_THUMB / 2,
    borderRadius: HUE_THUMB / 2,
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 4,
  },
  hexRow: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  hexSwatch: {width: 34, height: 34, borderRadius: rad.sm, borderWidth: 1, borderColor: colors.border},
  hexInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: rad.sm,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: typeScale.body,
    letterSpacing: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
});

const DIR_THUMB = 22;
const dir = StyleSheet.create({
  track: {height: 40, justifyContent: 'center', marginTop: space.sm, marginHorizontal: DIR_THUMB / 2},
  rail: {position: 'absolute', left: 0, right: 0, top: '50%', marginTop: -2, height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt},
  thumb: {
    position: 'absolute',
    top: '50%',
    width: DIR_THUMB,
    height: DIR_THUMB,
    marginLeft: -DIR_THUMB / 2,
    marginTop: -DIR_THUMB / 2,
    borderRadius: DIR_THUMB / 2,
    backgroundColor: '#ffffff',
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 4,
  },
});

const s = StyleSheet.create({
  sheetRoot: {flex: 1, justifyContent: 'flex-end'},
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 18,
    paddingTop: 9,
    paddingBottom: 22,
    maxHeight: '92%',
  },
  scrollBody: {paddingBottom: 4},
  grabber: {width: 38, height: 5, borderRadius: 3, backgroundColor: colors.borderLight, alignSelf: 'center', marginBottom: 6},
  title: {fontSize: typeScale.subheading, fontWeight: weight.bold, color: colors.textPrimary, marginTop: 8, marginBottom: 4},
  preview: {width: '100%', height: 90, borderWidth: 1, borderColor: colors.border, marginTop: 14},

  stopRow: {flexDirection: 'row', gap: 12, marginTop: 16},
  stopChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  stopChipActive: {borderColor: colors.accent},
  stopSwatch: {width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: colors.border},
  flexMin: {flex: 1, minWidth: 0},
  stopLabel: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: weight.semibold},
  stopHex: {fontSize: typeScale.caption, color: colors.textPrimary, fontFamily: 'monospace'},

  dirHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16},
  dirLabel: {fontSize: typeScale.caption, color: colors.textSecondary, fontWeight: weight.semibold},
  dirValue: {fontSize: typeScale.caption, color: colors.textMuted, fontFamily: 'monospace'},

  presetsEyebrow: {
    fontSize: typeScale.micro,
    color: colors.textMuted,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 9,
  },
  presetsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  preset: {width: 48, height: 40, borderRadius: 11, borderWidth: 2, overflow: 'hidden'},

  doneBtn: {backgroundColor: colors.accent, borderRadius: rad.pill, paddingVertical: 13, alignItems: 'center', marginTop: 20},
  doneText: {color: colors.onAccent, fontSize: typeScale.label, fontWeight: weight.semibold},
});
