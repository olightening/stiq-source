/**
 * GradientMaker — craft your identity gradient. A full colour picker: a saturation/value square
 * + hue slider (native react-native-svg, draggable), direct hex-code entry, and a large swatch
 * palette. Linear/radial toggle, a detented angle slider (applies to both kinds), shuffle.
 * Controlled via `value`/`onChange`.
 *
 * Two things make the drag feel smooth and predictable:
 *  1. The active stop's colour is held as live HSV state, NOT re-derived from the hex each frame.
 *     That keeps hue/saturation alive at the extremes — drag brightness to black or saturation to
 *     zero and the hue no longer collapses to red (the classic "the picker fights me" bug).
 *  2. Every drag re-measures the surface in window space on grant, then tracks the finger with the
 *     gesture's absolute coordinates. That is immune to the child-view `locationX` ambiguity and to
 *     the surface having scrolled since layout — the maker lives inside a ScrollView on every screen.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {
  DEFAULT_LINEAR_ANGLE,
  hexToHsv,
  hslToHex,
  hsvToHex,
  isCompleteHex,
  normalizeHex,
  randomGradient,
  type GradientSpec,
  type HSV,
} from '../media/gradient';
import {GradientAvatar} from './GradientAvatar';
import {Press} from './Press';
import {colors, radius, space, type as typeScale, weight} from './theme';

/** A large, hue-spanning palette: fine hue steps across three value bands, plus neutrals. */
const PALETTE: string[] = (() => {
  const out: string[] = [];
  for (const l of [66, 52, 38]) {
    for (let h = 0; h < 360; h += 20) out.push(hslToHex(h, 78, l));
  }
  out.push('#ffffff', '#d6d6db', '#98989e', '#5a5a60', '#2c2c2e', '#000000');
  return out;
})();

const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const HUE_STOPS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'];

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A drag surface that reports the finger position as a normalised (nx, ny) in [0,1].
 *
 * The surface is re-measured in window coordinates on every grant, so the reading is correct even
 * after the enclosing ScrollView has scrolled since layout. Tracking then uses the gesture's
 * absolute screen coordinates (`x0/y0`, `moveX/moveY`) rather than `locationX/locationY`, which on
 * Android are relative to whichever child view happens to be under the finger — the root cause of
 * the old jumpiness. The parent scroll is blocked for the duration so a vertical drag on the
 * value axis is never stolen.
 */
function useDragSurface(onMove: (nx: number, ny: number) => void) {
  const ref = useRef<View>(null);
  const frame = useRef({px: 0, py: 0, w: 0, h: 0});
  const cb = useRef(onMove);
  cb.current = onMove;

  const remeasure = useCallback(() => {
    ref.current?.measure((_x, _y, w, h, px, py) => {
      if (w > 0 && h > 0) frame.current = {px, py, w, h};
    });
  }, []);

  const emit = useCallback((px: number, py: number) => {
    const f = frame.current;
    if (f.w <= 0 || f.h <= 0) return;
    cb.current(clamp01((px - f.px) / f.w), clamp01((py - f.py) / f.h));
  }, []);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (_e, g) => {
        // Re-measure fresh, then place the thumb exactly under the finger. Doing it in the measure
        // callback (not before) guarantees the frame reflects the current scroll position.
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

// ── Saturation/Value square ──────────────────────────────────────────────────────
function SVSquare({
  hue,
  sat,
  val,
  onChange,
  uid,
}: {
  hue: number;
  sat: number;
  val: number;
  onChange: (s: number, v: number) => void;
  uid: string;
}): React.JSX.Element {
  const {ref, onLayout, panHandlers} = useDragSurface((nx, ny) => onChange(nx, 1 - ny));
  return (
    <View ref={ref} onLayout={onLayout} style={sq.square} {...panHandlers}>
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
        style={[
          sq.thumb,
          {left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, backgroundColor: hsvToHex(hue, sat, val)},
        ]}
      />
    </View>
  );
}

// ── Hue slider ───────────────────────────────────────────────────────────────────
function HueSlider({hue, onChange, uid}: {hue: number; onChange: (h: number) => void; uid: string}): React.JSX.Element {
  const {ref, onLayout, panHandlers} = useDragSurface(nx => onChange(nx * 360));
  return (
    <View ref={ref} onLayout={onLayout} style={sq.hue} {...panHandlers}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={`${uid}-hue`} x1="0" y1="0" x2="1" y2="0">
            {/* Keyed by position, not colour: the wheel starts AND ends on #ff0000, so a colour key
                collides and React drops one end of the ramp. */}
            {HUE_STOPS.map((c, i) => (
              <Stop key={i} offset={i / (HUE_STOPS.length - 1)} stopColor={c} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100" height="100" fill={`url(#${uid}-hue)`} />
      </Svg>
      <View pointerEvents="none" style={[sq.hueThumb, {left: `${(hue / 360) * 100}%`, backgroundColor: hsvToHex(hue, 1, 1)}]} />
    </View>
  );
}

// ── Angle slider (snaps to the 8 anchor angles) ────────────────────────────────────
// A detented slider rather than a free one: dragging jumps the handle from one 45° anchor to the
// next, so linear direction and radial highlight land on the same clean set of angles. Reuses the
// scroll-proof drag surface; the thumb sits on whichever anchor the finger is nearest.
function AngleSlider({angle, onChange}: {angle: number; onChange: (a: number) => void}): React.JSX.Element {
  const n = ANGLES.length;
  const activeIdx = ((Math.round(((angle % 360) + 360) % 360 / 45) % n) + n) % n;
  const {ref, onLayout, panHandlers} = useDragSurface(nx => onChange(ANGLES[Math.round(clamp01(nx) * (n - 1))]!));
  return (
    <View ref={ref} onLayout={onLayout} style={as.track} {...panHandlers}>
      <View pointerEvents="none" style={as.rail} />
      {ANGLES.map((a, i) => (
        <View
          key={a}
          pointerEvents="none"
          style={[as.tick, {left: `${(i / (n - 1)) * 100}%`}, i === activeIdx && as.tickActive]}
        />
      ))}
      <View pointerEvents="none" style={[as.thumb, {left: `${(activeIdx / (n - 1)) * 100}%`}]} />
    </View>
  );
}

export interface GradientMakerProps {
  value: GradientSpec;
  onChange: (next: GradientSpec) => void;
  previewSize?: number;
}

export function GradientMaker({value, onChange, previewSize = 120}: GradientMakerProps): React.JSX.Element {
  const [activeStop, setActiveStop] = useState(0);
  const uid = useMemo(() => `gm${Math.floor(Math.random() * 1e9).toString(36)}`, []);
  const stops = value.stops.map(normalizeHex);
  const activeColor = normalizeHex(value.stops[activeStop] ?? '#888888');

  // The active stop's colour lives here as HSV — the source of truth while the user drags. Deriving
  // it from the hex each frame would collapse hue at value/saturation 0 (black/grey carry no hue),
  // making the hue slider and thumb snap around. We only re-read from hex on an *external* change
  // (stop switch, hex entry, palette, shuffle), tracked via `selfHex`.
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(activeColor));
  const selfHex = useRef(activeColor);
  useEffect(() => {
    if (activeColor !== selfHex.current) {
      setHsv(hexToHsv(activeColor));
      selfHex.current = activeColor;
    }
  }, [activeColor, activeStop]);

  const [hexDraft, setHexDraft] = useState(activeColor);
  useEffect(() => { setHexDraft(activeColor); }, [activeColor]);

  const update = (next: Partial<GradientSpec>): void => onChange({...value, ...next});
  const setStop = (i: number, color: string): void => {
    const next = [...value.stops];
    next[i] = color;
    update({stops: next});
  };
  const setActive = (color: string): void => setStop(activeStop, color);

  /** Commit an HSV edit: keep it as live state and write the resulting hex to the active stop. */
  const commitHsv = (next: HSV): void => {
    setHsv(next);
    const hex = hsvToHex(next.h, next.s, next.v);
    selfHex.current = hex; // pre-mark so the sync effect doesn't clobber our own write
    setActive(hex);
  };

  const addStop = (): void => {
    if (value.stops.length >= 3) return;
    update({stops: [...value.stops, value.stops[value.stops.length - 1]!]});
    setActiveStop(value.stops.length);
  };
  const removeStop = (i: number): void => {
    if (value.stops.length <= 2) return;
    update({stops: value.stops.filter((_, j) => j !== i)});
    setActiveStop(0);
  };

  const onHexChange = (text: string): void => {
    const t = text.startsWith('#') ? text : `#${text}`;
    setHexDraft(t);
    if (isCompleteHex(t)) setActive(normalizeHex(t));
  };

  return (
    <View style={s.wrap}>
      {/* Live preview + shuffle */}
      <View style={s.previewCol}>
        <GradientAvatar gradient={value} size={previewSize} ring />
        <Press style={s.shuffle} onPress={() => onChange(randomGradient())} accessibilityLabel="shuffle gradient">
          <Text style={s.shuffleText}>🎲  Shuffle</Text>
        </Press>
      </View>

      {/* Stops */}
      <Text style={s.sectionLabel}>COLORS</Text>
      <View style={s.stopRow}>
        {stops.map((c, i) => (
          <View key={i} style={s.stopWrap}>
            <Press
              onPress={() => setActiveStop(i)}
              style={[s.stop, {backgroundColor: c}, i === activeStop && s.stopActive]}
              accessibilityLabel={`color stop ${i + 1}`}
            />
            {value.stops.length > 2 && (
              <Press style={s.stopRemove} onPress={() => removeStop(i)} accessibilityLabel="remove color">
                <Text style={s.stopRemoveText}>×</Text>
              </Press>
            )}
          </View>
        ))}
        {value.stops.length < 3 && (
          <Press style={s.stopAdd} onPress={addStop} accessibilityLabel="add color">
            <Text style={s.stopAddText}>+</Text>
          </Press>
        )}
      </View>

      {/* Picker: saturation/value square + hue slider */}
      <SVSquare hue={hsv.h} sat={hsv.s} val={hsv.v} uid={uid} onChange={(sNew, vNew) => commitHsv({h: hsv.h, s: sNew, v: vNew})} />
      <HueSlider hue={hsv.h} uid={uid} onChange={hNew => commitHsv({h: hNew, s: hsv.s, v: hsv.v})} />

      {/* Hex entry */}
      <View style={s.hexRow}>
        <View style={[s.hexSwatch, {backgroundColor: activeColor}]} />
        <TextInput
          style={s.hexInput}
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

      {/* Swatch palette */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.palette}>
        {PALETTE.map(c => (
          <Press
            key={c}
            onPress={() => setActive(c)}
            style={[s.swatch, {backgroundColor: c}, c === activeColor && s.swatchActive]}
            accessibilityLabel={`pick ${c}`}
          />
        ))}
      </ScrollView>

      {/* Style toggle */}
      <Text style={s.sectionLabel}>STYLE</Text>
      <View style={s.segment}>
        {(['linear', 'radial'] as const).map(t => (
          <Press
            key={t}
            style={[s.segmentBtn, value.type === t && s.segmentBtnActive]}
            onPress={() => update({type: t})}>
            <Text style={[s.segmentText, value.type === t && s.segmentTextActive]}>
              {t === 'linear' ? 'Linear' : 'Radial'}
            </Text>
          </Press>
        ))}
      </View>

      {/* Angle — sweep direction for linear, highlight position for radial. Snaps to 45° anchors. */}
      <View style={s.angleHeader}>
        <Text style={s.sectionLabel}>ANGLE</Text>
        <Text style={s.angleValue}>{Math.round(value.angle ?? DEFAULT_LINEAR_ANGLE)}°</Text>
      </View>
      <AngleSlider angle={value.angle ?? DEFAULT_LINEAR_ANGLE} onChange={a => update({angle: a})} />
    </View>
  );
}

const THUMB = 22;
const HUE_THUMB = 26;

const sq = StyleSheet.create({
  square: {
    width: '100%',
    height: 190,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    marginTop: -THUMB / 2,
    borderRadius: THUMB / 2,
    borderWidth: 3,
    borderColor: '#ffffff',
    // A soft ring so the white handle stays legible on white/black corners of the square.
    shadowColor: '#000000',
    shadowOpacity: 0.55,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 4,
  },
  hue: {
    width: '100%',
    height: 26,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginTop: space.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
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
});

const s = StyleSheet.create({
  wrap: {gap: space.lg},
  previewCol: {alignItems: 'center', gap: space.md},
  shuffle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderLight,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
  },
  shuffleText: {color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: weight.semibold},

  sectionLabel: {
    fontSize: typeScale.micro,
    color: colors.textMuted,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
  },

  stopRow: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  stopWrap: {position: 'relative'},
  stop: {width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: colors.surface},
  stopActive: {borderColor: colors.accent},
  stopRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopRemoveText: {color: colors.textMuted, fontSize: 12, lineHeight: 14},
  stopAdd: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopAddText: {color: colors.textMuted, fontSize: 22, lineHeight: 24},

  hexRow: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  hexSwatch: {width: 38, height: 38, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border},
  hexInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: typeScale.body,
    letterSpacing: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },

  palette: {gap: space.sm, paddingVertical: 2},
  swatch: {width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.border},
  swatchActive: {borderWidth: 2, borderColor: colors.accent},

  segment: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentBtn: {flex: 1, paddingVertical: 7, borderRadius: radius.sm, alignItems: 'center'},
  segmentBtnActive: {backgroundColor: colors.surface},
  segmentText: {fontSize: typeScale.caption, color: colors.textMuted, fontWeight: weight.semibold},
  segmentTextActive: {color: colors.textPrimary},

  angleHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  angleValue: {
    fontSize: typeScale.caption,
    color: colors.accent,
    fontFamily: 'monospace',
    fontWeight: weight.semibold,
  },
});

const ANGLE_THUMB = 22;
const ANGLE_TICK = 6;

const as = StyleSheet.create({
  track: {height: 40, justifyContent: 'center', marginHorizontal: ANGLE_THUMB / 2},
  rail: {position: 'absolute', left: 0, right: 0, top: '50%', marginTop: -2, height: 4, borderRadius: 2, backgroundColor: colors.border},
  tick: {
    position: 'absolute',
    top: '50%',
    width: ANGLE_TICK,
    height: ANGLE_TICK,
    marginLeft: -ANGLE_TICK / 2,
    marginTop: -ANGLE_TICK / 2,
    borderRadius: ANGLE_TICK / 2,
    backgroundColor: colors.borderLight,
  },
  tickActive: {backgroundColor: colors.accentTint},
  thumb: {
    position: 'absolute',
    top: '50%',
    width: ANGLE_THUMB,
    height: ANGLE_THUMB,
    marginLeft: -ANGLE_THUMB / 2,
    marginTop: -ANGLE_THUMB / 2,
    borderRadius: ANGLE_THUMB / 2,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.bg,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 4,
  },
});
