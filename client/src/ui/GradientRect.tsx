/**
 * GradientRect — a rectangular linear/radial SVG gradient fill (covers, swatches, presets).
 *
 * The root `<Svg>` is always sized from a real `onLayout` measurement (explicit pixel width/height),
 * never a percentage. A percentage-sized root `<Svg width="100%" height="100%">` is flaky on
 * Android's react-native-svg 15 — the SVG's own percentage resolution doesn't reliably track the
 * parent's Yoga-computed size, so the fill only partially covers its box. Every rectangular gradient
 * fill in the app should go through this component (see GradientAvatar/GradientDot for the analogous
 * explicit-pixel pattern on shaped avatars).
 *
 * Moved here (was originally local to CoverColorsSheet.tsx, the organizer's gradient-cover picker)
 * so EventCard/EventDetailScreen's cover fills — previously their own `%`-sized `<Svg>`s — can share
 * the same measured implementation.
 */
import React, {useId, useState} from 'react';
import {type StyleProp, View, type ViewStyle} from 'react-native';
import Svg, {Defs, LinearGradient, RadialGradient, Rect, Stop} from 'react-native-svg';
import {
  DEFAULT_LINEAR_ANGLE,
  decodeGradient,
  normalizeHex,
  radialFocus,
  type GradientSpec,
} from '../media/gradient';

const sanitizeId = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '');

/** The DC's create default is `linear-gradient(135deg,#7cb2ff,#b89aff)`. */
export const DEFAULT_COVER_GRADIENT: GradientSpec = {
  type: 'linear',
  angle: 135,
  stops: ['#7cb2ff', '#b89aff'],
};

/** Coerce a spec-or-wire-string cover gradient (or nothing) into a concrete {@link GradientSpec}. */
export function toGradientSpec(
  g: GradientSpec | string | undefined | null,
  fallback: GradientSpec = DEFAULT_COVER_GRADIENT,
): GradientSpec {
  if (!g) {return fallback;}
  if (typeof g === 'string') {return decodeGradient(g) ?? fallback;}
  return g;
}

export function GradientRect({
  gradient,
  radius = 0,
  style,
  fallbackStops,
}: {
  gradient: GradientSpec | string | undefined | null;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  /** Stops used when `gradient` resolves to a spec with an empty `stops` array (defensive-only —
   * a decoded/authored gradient should never actually have zero stops). Each call site historically
   * had its own such fallback wash; defaults to the cover-picker's blue→violet pair. */
  fallbackStops?: string[];
}): React.JSX.Element {
  const spec = toGradientSpec(gradient);
  const [size, setSize] = useState({w: 0, h: 0});
  const gid = `gr${sanitizeId(useId())}`;

  const r = ((spec.angle ?? DEFAULT_LINEAR_ANGLE) * Math.PI) / 180;
  const dx = Math.sin(r);
  const dy = -Math.cos(r);
  const x1 = 0.5 - dx * 0.5;
  const y1 = 0.5 - dy * 0.5;
  const x2 = 0.5 + dx * 0.5;
  const y2 = 0.5 + dy * 0.5;
  const focus = radialFocus(spec.angle);
  const stops = (spec.stops.length ? spec.stops : fallbackStops ?? DEFAULT_COVER_GRADIENT.stops).map(normalizeHex);

  return (
    <View
      style={[style, {borderRadius: radius, overflow: 'hidden'}]}
      onLayout={e => setSize({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})}>
      {size.w > 0 && size.h > 0 && (
        <Svg width={size.w} height={size.h}>
          <Defs>
            {spec.type === 'radial' ? (
              <RadialGradient id={gid} cx={focus.x} cy={focus.y} r="1.0" fx={focus.x} fy={focus.y}>
                {stops.map((c, i) => (
                  <Stop key={`${c}-${i}`} offset={stops.length <= 1 ? 0 : i / (stops.length - 1)} stopColor={c} />
                ))}
              </RadialGradient>
            ) : (
              <LinearGradient id={gid} x1={x1} y1={y1} x2={x2} y2={y2}>
                {stops.map((c, i) => (
                  <Stop key={`${c}-${i}`} offset={stops.length <= 1 ? 0 : i / (stops.length - 1)} stopColor={c} />
                ))}
              </LinearGradient>
            )}
          </Defs>
          <Rect x={0} y={0} width={size.w} height={size.h} fill={`url(#${gid})`} />
        </Svg>
      )}
    </View>
  );
}
