/**
 * GradientAvatar — a gradient that IS the identity. Rendered with react-native-svg, so each avatar
 * is a SINGLE GPU-backed native view drawing a true linear/radial gradient: high quality (smooth,
 * no banding) AND cheap (one view, not a grid of ~36 plain Views). Pass an explicit `gradient`
 * spec, or a `seed` (pubkey/handle) to derive a stable one.
 */
import React, {useId, useMemo} from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import Svg, {ClipPath, Defs, LinearGradient, Polygon, RadialGradient, Rect, Stop} from 'react-native-svg';
import {gradientFromSeed, normalizeHex, radialFocus, type GradientSpec} from '../media/gradient';
import {safeNpubEncode} from '../util/npub';
import {colors} from './theme';

/**
 * Avatar shape variants matching the design spec (the shape IS the type):
 * - 'circle'   — people / DMs (perfect circle)
 * - 'square'   — public NIP-53 channels (17% rounded square)
 * - 'diamond'  — private channels (72%-size rotated square, 26% radius)
 * - 'octagon'  — open communities (a public channel with admins — open on every side)
 * - 'hexagon'  — group chats (pointy-top hexagon polygon)
 */
export type AvatarShape = 'circle' | 'square' | 'hexagon' | 'diamond' | 'octagon';

export interface GradientAvatarProps {
  /** Explicit gradient spec. Takes precedence over `seed`. */
  gradient?: GradientSpec | null;
  /** Seed (pubkey/handle) used to derive a stable gradient when no spec is given. */
  seed?: string;
  size?: number;
  /**
   * Shape variant. When provided, overrides `radius`:
   *   circle  → DMs; square → channels; hexagon → groups; diamond → private groups.
   * Falls back to `radius` prop when omitted (legacy behavior).
   */
  shape?: AvatarShape;
  /** Corner radius. Used only when `shape` is omitted. Defaults to full circle (size/2). */
  radius?: number;
  /** Adds a subtle separating halo (used on overlapping/over-surface placements). */
  ring?: boolean;
  /** Deprecated (was grid resolution); ignored now that rendering is vector. */
  resolution?: number;
  style?: StyleProp<ViewStyle>;
}

// gradientFromSeed is deterministic per seed but not free — cache it once per pubkey for the session.
const _specCache = new Map<string, GradientSpec>();
function resolveSpec(gradient: GradientSpec | null | undefined, seed: string): GradientSpec {
  if (gradient) return gradient;
  // Normalise the fallback seed so a hex pubkey and its npub encoding — used interchangeably across
  // surfaces (the conversation list seeds with hex, the DM bubble/profile/inbox with npub) — resolve
  // to the SAME gradient. Without this an unclaimed user shows different colours per surface.
  // safeNpubEncode is idempotent for our purposes: hex→npub, npub→npub (unchanged, encode throws and
  // falls back), and a non-pubkey seed like a channel coordinate is returned untouched.
  const key = safeNpubEncode(seed);
  let spec = _specCache.get(key);
  if (!spec) { spec = gradientFromSeed(key); _specCache.set(key, spec); }
  return spec;
}

/** Evenly-spaced SVG <Stop>s for a stop list. */
function offsetFor(i: number, n: number): number {
  return n <= 1 ? 0 : i / (n - 1);
}

// Pointy-top hexagon polygon points from the design spec:
// polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%)
function hexPoints(s: number): string {
  const pts: [number, number][] = [
    [s * 0.5,   0],
    [s * 0.933, s * 0.25],
    [s * 0.933, s * 0.75],
    [s * 0.5,   s],
    [s * 0.067, s * 0.75],
    [s * 0.067, s * 0.25],
  ];
  return pts.map(([x, y]) => `${x},${y}`).join(' ');
}

// Octagon polygon points from the design spec (open community — a channel open on every side):
// polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)
function octPoints(s: number): string {
  const pts: [number, number][] = [
    [s * 0.3, 0],
    [s * 0.7, 0],
    [s,       s * 0.3],
    [s,       s * 0.7],
    [s * 0.7, s],
    [s * 0.3, s],
    [0,       s * 0.7],
    [0,       s * 0.3],
  ];
  return pts.map(([x, y]) => `${x},${y}`).join(' ');
}

export const GradientAvatar = React.memo(function GradientAvatar({
  gradient,
  seed = '',
  size = 32,
  shape,
  radius,
  ring = false,
  style,
}: GradientAvatarProps): React.JSX.Element {
  const spec = resolveSpec(gradient, seed);
  // Unique, stable ids for <Defs> (sanitised — useId() can contain ':').
  const uid = useId().replace(/[^a-zA-Z0-9_]/g, '');
  const gid = `g${uid}`;
  const clipId = `c${uid}`;

  const stops = useMemo(() => {
    const list = (spec.stops.length ? spec.stops : ['#3a4150', '#222834']).map(normalizeHex);
    // Keyed by position, not colour: a spec may legitimately repeat a stop (a hand-rolled gradient,
    // or a generated 3-stop whose mid hue rounds onto an end), and a colour key would collide.
    return list.map((color, i) => (
      <Stop key={i} offset={offsetFor(i, list.length)} stopColor={color} />
    ));
  }, [spec.stops]);

  // Hoisted so the container/ring style objects and the hex/octagon polygon path string are not
  // reallocated on every render — only recomputed when the inputs that actually affect them change.
  // (GradientAvatar is already React.memo'd with stable props end-to-end on the feed-card path, so
  // in steady state this component doesn't re-render at all; this just keeps the occasional
  // re-render — e.g. a size change — from redoing work unrelated to what changed.)
  const sizeStyle = useMemo(() => ({width: size, height: size}), [size]);
  const ringStyle = useMemo(
    () => ({width: size + 6, height: size + 6, borderRadius: (size + 6) / 2}),
    [size],
  );
  const polygonPoints = useMemo(
    () => (shape === 'octagon' ? octPoints(size) : shape === 'hexagon' ? hexPoints(size) : ''),
    [shape, size],
  );

  // Linear axis from the CSS-style angle (0° = up, clockwise), projected onto the unit box.
  const rad = ((spec.angle ?? 135) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const x1 = 0.5 - dx * 0.5;
  const y1 = 0.5 - dy * 0.5;
  const x2 = 0.5 + dx * 0.5;
  const y2 = 0.5 + dy * 0.5;

  // Resolve corner radius from shape or explicit radius prop.
  let corner: number;
  if (shape === 'circle') { corner = size / 2; }
  else if (shape === 'square') { corner = Math.round(size * 0.17); }
  else { corner = radius ?? size / 2; }

  // For diamond: inner square side + radius
  const diamondSide = Math.round(size * 0.72);
  const diamondRx   = Math.round(diamondSide * 0.26);
  const cx = size / 2;
  const cy = size / 2;

  const focus = radialFocus(spec.angle);
  const gradientDef = spec.type === 'radial' ? (
    <RadialGradient id={gid} cx={focus.x} cy={focus.y} r="1.0" fx={focus.x} fy={focus.y}>
      {stops}
    </RadialGradient>
  ) : (
    <LinearGradient id={gid} x1={x1} y1={y1} x2={x2} y2={y2}>
      {stops}
    </LinearGradient>
  );

  let svgContent: React.ReactNode;
  if (shape === 'hexagon' || shape === 'octagon') {
    svgContent = (
      <>
        <Defs>
          {gradientDef}
          <ClipPath id={clipId}>
            <Polygon points={polygonPoints} />
          </ClipPath>
        </Defs>
        <Rect x={0} y={0} width={size} height={size} fill={`url(#${gid})`} clipPath={`url(#${clipId})`} />
      </>
    );
  } else if (shape === 'diamond') {
    svgContent = (
      <>
        <Defs>{gradientDef}</Defs>
        <Rect
          x={cx - diamondSide / 2}
          y={cy - diamondSide / 2}
          width={diamondSide}
          height={diamondSide}
          rx={diamondRx}
          ry={diamondRx}
          fill={`url(#${gid})`}
          transform={`rotate(45, ${cx}, ${cy})`}
        />
      </>
    );
  } else {
    svgContent = (
      <>
        <Defs>{gradientDef}</Defs>
        <Rect x={0} y={0} width={size} height={size} rx={corner} ry={corner} fill={`url(#${gid})`} />
      </>
    );
  }

  const avatar = (
    <View style={[sizeStyle, style]} accessibilityLabel="identity gradient">
      <Svg width={size} height={size}>
        {svgContent}
      </Svg>
    </View>
  );

  if (!ring) return avatar;

  return (
    <View style={[styles.ring, ringStyle]}>
      {avatar}
    </View>
  );
});

const styles = StyleSheet.create({
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bg,
  },
});
