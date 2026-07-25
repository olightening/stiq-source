/* eslint-disable no-bitwise -- gradient seed derivation uses bit manipulation */
/**
 * Gradient identity (Tier 0) — pure, deterministic, zero-network helpers.
 *
 * A gradient identity is a tiny free-form spec: `{type, angle, stops}`. It is the ONE place colour
 * lives in the Stiq UI — people and channels wear a gradient; every other surface stays neutral.
 *
 * Bare React Native has no gradient primitive and this app ships no SVG/native module (the same
 * Tier-0 stance as BlurhashView / GenerativeBanner). So a gradient is *sampled* into a grid of
 * solid colours that `GradientAvatar` paints as plain Views — no canvas, nothing fetched.
 *
 * The math (FNV-1a seed → HSL stops, linear/radial sampling) is ported verbatim from the design
 * mockup so a seeded gradient renders identically to the reference design.
 */
import {randomFloat} from '../util/random';

/** Gradient kinds we render. */
export type GradientType = 'linear' | 'radial';

/** A gradient identity: 2–3 hex stops, a kind, and (for linear) an angle in degrees. */
export interface GradientSpec {
  type: GradientType;
  /**
   * CSS-style angle in degrees (0 = up, clockwise). For a linear gradient it is the direction of
   * the colour sweep; for a radial gradient it is the direction the off-centre highlight points
   * (0 = highlight at top, 90 = right, 180 = bottom, 270 = left).
   */
  angle: number;
  /** Lower-case `#rrggbb` colour stops, evenly spaced. Length 2–3. */
  stops: string[];
}

/** Max stops a gradient may carry (keeps the header tiny and the picker simple). */
export const MAX_GRADIENT_STOPS = 3;

/** Default direction for a linear gradient when none is specified (down-right, matches the design). */
export const DEFAULT_LINEAR_ANGLE = 135;
/**
 * Default direction for a radial highlight when none is specified. 315° (up-left) reproduces the
 * classic off-centre `at 30% 28%` highlight the design shipped, so legacy radial wire forms that
 * carried no angle keep their original look.
 */
export const DEFAULT_RADIAL_ANGLE = 315;

/** How far a radial gradient's highlight sits from the centre (0 = centre, 0.5 ≈ edge). */
const RADIAL_OFFSET = 0.3;

/**
 * The off-centre focus point (in the unit box, 0..1) of a radial gradient for a given angle.
 * 0° puts the highlight at the top and it rotates clockwise, mirroring the linear angle convention
 * so a single `angle` control reads the same for both gradient kinds. Shared by every render path
 * (SVG avatar + sampled grid) so they never drift.
 */
export function radialFocus(angle: number | undefined): {x: number; y: number} {
  const rad = ((angle ?? DEFAULT_RADIAL_ANGLE) * Math.PI) / 180;
  return {
    x: 0.5 + RADIAL_OFFSET * Math.sin(rad),
    y: 0.5 - RADIAL_OFFSET * Math.cos(rad),
  };
}

/**
 * Structural equality for two (possibly undefined) gradient specs. Used by the
 * `React.memo` comparators on avatar-bearing list rows (CommentItem, BroadcastCard)
 * to skip re-renders when a row's gradient is unchanged.
 */
export function gradientSpecEqual(a: GradientSpec | undefined, b: GradientSpec | undefined): boolean {
  return (
    (!a && !b) ||
    (!!a &&
      !!b &&
      a.type === b.type &&
      a.angle === b.angle &&
      a.stops.length === b.stops.length &&
      a.stops.every((s, i) => s === b.stops[i]))
  );
}

// ── Colour helpers ────────────────────────────────────────────────────────────

/** HSL → `#rrggbb`. h in [0,360), s/l in [0,100]. (Matches the mockup's hslToHex.) */
export function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toHex = (x: number): string =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Parse `#rgb`/`#rrggbb` → [r,g,b] (0–255). Falls back to mid-grey on garbage. */
function parseHex(hex: string): [number, number, number] {
  let h = (hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [128, 128, 128];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex2(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, '0');
}

/** Normalise any accepted colour to lower-case `#rrggbb`. */
export function normalizeHex(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/** True when `hex` is a complete, valid `#rgb`/`#rrggbb` (used to gate live hex-input edits). */
export function isCompleteHex(hex: string): boolean {
  const h = (hex || '').trim().replace(/^#/, '');
  return (h.length === 3 || h.length === 6) && !/[^0-9a-fA-F]/.test(h);
}

export interface HSV { h: number; s: number; v: number } // h 0–360, s/v 0–1

/** `#rrggbb` → HSV. The colour picker works in HSV (the standard saturation/value square space). */
export function hexToHsv(hex: string): HSV {
  const [r255, g255, b255] = parseHex(hex);
  const r = r255 / 255, g = g255 / 255, b = b255 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return {h, s, v: max};
}

/** HSV (h 0–360, s/v 0–1) → `#rrggbb`. */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return `#${toHex2((r + m) * 255)}${toHex2((g + m) * 255)}${toHex2((b + m) * 255)}`;
}

/** Linear RGB interpolation between two hex colours, t in [0,1]. */
function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return `#${toHex2(ar + (br - ar) * t)}${toHex2(ag + (bg - ag) * t)}${toHex2(ab + (bb - ab) * t)}`;
}

/** Colour at position p in [0,1] across the (evenly-spaced) stop list. */
function colorAt(stops: string[], p: number): string {
  if (stops.length === 0) return '#888888';
  if (stops.length === 1) return normalizeHex(stops[0]!);
  const clamped = Math.max(0, Math.min(1, p));
  const seg = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  return lerpHex(stops[i]!, stops[i + 1]!, seg - i);
}

// ── Generators ────────────────────────────────────────────────────────────────

/** The calm slate used when a spec is missing/empty. */
const FALLBACK: GradientSpec = {type: 'linear', angle: 135, stops: ['#3a4150', '#222834']};

/**
 * Deterministic gradient from a seed (pubkey/handle) — stable per identity, so every device
 * derives the same gradient with no stored spec. (FNV-1a, ported from the mockup.)
 */
export function gradientFromSeed(seed: string): GradientSpec {
  let h = 2166136261;
  const s = String(seed || 'anon');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  const h0 = u % 360;
  const h1 = (h0 + 36 + ((u >> 9) % 92)) % 360;
  return {
    type: ((u >> 17) & 3) === 0 ? 'radial' : 'linear',
    angle: ((u >> 19) % 8) * 45,
    stops: [hslToHex(h0, 70, 60), hslToHex(h1, 73, 62)],
  };
}

/**
 * The angle anchors {@link randomGradient} may draw (0, 15, 30 … 345). The picker's slider offers
 * only the 8 coarse 45° detents (GradientMaker's ANGLES); those are a strict SUBSET of these 24, so
 * a shuffled angle still renders and round-trips exactly (encodeGradient carries any integer
 * 0–359) and the maker's numeric readout stays truthful — dragging its slider simply re-snaps to
 * the nearer coarse detent, which is what a detented control is for. Tripling the anchors triples
 * the visual space of a generated identity at no cost to how "designed" it looks.
 */
const RANDOM_ANGLE_STEPS = 24;

/**
 * The visual *character* of a generated gradient.
 *
 * The generator used to draw every gradient from a single narrow band (saturation 60–86%, lightness
 * 54–68%). Hue was genuinely random, but the character never varied, so eight draws read as one
 * pastel palette — the shuffle was random and didn't look it. Families restore the missing axis:
 * hue says *which* colour, the family says *what kind* of gradient.
 */
export type GradientFamily = 'vivid' | 'pastel' | 'deep' | 'mono' | 'contrast';

/** Every family, in a fixed order. {@link randomGradientSet} guarantees a set covers all of them. */
export const GRADIENT_FAMILIES: readonly GradientFamily[] = ['vivid', 'pastel', 'deep', 'mono', 'contrast'];

/** An inclusive integer band, `[lo, hi]`. */
type Band = readonly [number, number];

interface FamilyRecipe {
  /** Hue separation between the first and last stop, in degrees. */
  delta: Band;
  /** Saturation band, drawn per stop. */
  sat: Band;
  /** Lightness band for the first stop. */
  lightA: Band;
  /** Lightness band for the last stop — deliberately offset from `lightA` on the tonal families. */
  lightB: Band;
  /** Chance of a third, mid-hue stop. */
  thirdStop: number;
}

/**
 * The five recipes. Lightness floors are set against the app's near-black background (`theme.bg`
 * is `#111111`): `deep` bottoms out at 30% so a dark identity still reads as a colour rather than
 * dissolving into the page.
 */
const FAMILY_RECIPES: Record<GradientFamily, FamilyRecipe> = {
  // Punchy and saturated — the loudest a gradient gets.
  vivid: {delta: [30, 120], sat: [82, 96], lightA: [46, 58], lightB: [46, 58], thirdStop: 0.34},
  // Soft and light, closest to what the old single-band generator produced.
  pastel: {delta: [25, 105], sat: [48, 72], lightA: [66, 80], lightB: [66, 80], thirdStop: 0.34},
  // Dark and rich; reads as depth rather than as colour-wash.
  deep: {delta: [25, 110], sat: [58, 88], lightA: [30, 42], lightB: [30, 42], thirdStop: 0.3},
  // Near-monochrome: one hue, carried by a light→dark tonal ramp instead of a hue sweep.
  mono: {delta: [8, 22], sat: [35, 70], lightA: [40, 50], lightB: [62, 74], thirdStop: 0.4},
  // Opposed hues AND opposed lightness — the most dramatic pairing on offer.
  contrast: {delta: [120, 190], sat: [62, 92], lightA: [34, 44], lightB: [62, 74], thirdStop: 0.25},
};

/**
 * An integer in `[lo, hi]` (inclusive), clamped so an injected `rand` returning exactly 1 lands on
 * `hi` rather than overshooting. Every draw below goes through here or {@link pickIndex} — there is
 * deliberately NO rejection sampling anywhere in this file, because callers legitimately inject a
 * *constant* `rand` (see resolveDisplayIdentity.test.ts's `randomGradient(() => 0.3)`) and a
 * redraw-until-it-looks-good loop would hang on one.
 */
function pick(rand: () => number, [lo, hi]: Band): number {
  return lo + Math.min(hi - lo, Math.floor(rand() * (hi - lo + 1)));
}

/** An index in `[0, n)`, clamped the same way. */
function pickIndex(rand: () => number, n: number): number {
  return Math.min(n - 1, Math.floor(rand() * n));
}

/** Fisher–Yates, in place, drawing from the injected `rand`. */
function shuffleInPlace<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = pickIndex(rand, i + 1);
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
}

/**
 * One gradient of a given hue and family. The building block both public generators share, so a
 * shuffled swatch and a hand-rolled "surprise me" are the same kind of object.
 */
export function gradientInFamily(
  hue: number,
  family: GradientFamily,
  rand: () => number = randomFloat,
): GradientSpec {
  const recipe = FAMILY_RECIPES[family];
  const h0 = ((Math.round(hue) % 360) + 360) % 360;
  const dir = rand() < 0.5 ? 1 : -1;
  const delta = pick(rand, recipe.delta);
  const h1 = (h0 + dir * delta + 360) % 360;
  const stops = [
    hslToHex(h0, pick(rand, recipe.sat), pick(rand, recipe.lightA)),
    hslToHex(h1, pick(rand, recipe.sat), pick(rand, recipe.lightB)),
  ];
  if (rand() < recipe.thirdStop) {
    // The mid stop sits at the mid hue AND the mid lightness, so a 3-stop ramp stays monotonic
    // instead of bulging light-dark-light in the middle of the sweep.
    const hm = (h0 + dir * delta * 0.5 + 360) % 360;
    const lm = Math.round((pick(rand, recipe.lightA) + pick(rand, recipe.lightB)) / 2);
    stops.splice(1, 0, hslToHex(hm, pick(rand, recipe.sat), lm));
  }
  return {
    type: rand() < 0.7 ? 'linear' : 'radial',
    // Snap to the 24 fine anchors (0,15,…,345) — see RANDOM_ANGLE_STEPS for why not the picker's 8.
    angle: pickIndex(rand, RANDOM_ANGLE_STEPS) * (360 / RANDOM_ANGLE_STEPS),
    stops,
  };
}

/**
 * A fresh, tasteful, free-colour gradient — the maker's 🎲 shuffle, new channels, and the enrol
 * fallback. Random hue, random family.
 *
 * `rand` defaults to the CSPRNG (util/random `randomFloat`), NOT `Math.random`: Hermes seeds
 * `Math.random` weakly, and this draw decides an identity a member is asked to believe is theirs
 * alone. Callers that need determinism (tests, and any future seeded preview) keep injecting their
 * own `rand`, exactly as before.
 */
export function randomGradient(rand: () => number = randomFloat): GradientSpec {
  const family = GRADIENT_FAMILIES[pickIndex(rand, GRADIENT_FAMILIES.length)]!;
  return gradientInFamily(pickIndex(rand, 360), family, rand);
}

/**
 * `count` gradients meant to be seen *side by side* — the onboarding identity grid.
 *
 * Drawing each one independently is the honest thing to do and the wrong thing to look at: eight
 * independent hues collide often enough that a given shuffle lands three blues and no warm colour,
 * which reads as "it isn't really shuffling". So the set is stratified on both axes that carry the
 * variety:
 *
 *  - **Hue** — the wheel is rotated by a random offset, then divided into `count` equal sectors, one
 *    per swatch, each jittered within its sector. Every set spans the spectrum; no two swatches can
 *    land on the same hue (the jitter is capped below half a sector, so sectors never touch).
 *  - **Family** — a bag seeded with every family, padded at random to `count`. Every set shows every
 *    character.
 *
 * Both are then shuffled into the grid so the result never reads as a tidy rainbow ramp. The draw
 * stays fully CSPRNG-backed; stratification removes clumping, not randomness.
 */
export function randomGradientSet(count: number, rand: () => number = randomFloat): GradientSpec[] {
  if (count <= 0) return [];
  const sector = 360 / count;
  const rotation = rand() * 360;
  // Strictly less than half a sector, so sector i and i+1 can never produce the same hue.
  const jitter = Math.min(18, sector / 2.5);
  const hues = Array.from(
    {length: count},
    (_, i) => rotation + i * sector + (rand() - 0.5) * 2 * jitter,
  );
  shuffleInPlace(hues, rand);

  const families: GradientFamily[] = [];
  while (families.length + GRADIENT_FAMILIES.length <= count) families.push(...GRADIENT_FAMILIES);
  while (families.length < count) {
    families.push(GRADIENT_FAMILIES[pickIndex(rand, GRADIENT_FAMILIES.length)]!);
  }
  shuffleInPlace(families, rand);

  return hues.map((hue, i) => gradientInFamily(hue, families[i]!, rand));
}

// ── Sampling → grid (the RN render path) ────────────────────────────────────────

/** Position [0,1] of a normalised point (x,y in [0,1], y down) along the gradient. */
function samplePosition(spec: GradientSpec, x: number, y: number): number {
  if (spec.type === 'radial') {
    // Distance from the (angle-driven) off-centre focus, normalised by the distance to the
    // farthest corner. The focus rotates with `spec.angle` — see radialFocus.
    const {x: cx, y: cy} = radialFocus(spec.angle);
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(1 - cx, cy),
      Math.hypot(cx, 1 - cy),
      Math.hypot(1 - cx, 1 - cy),
    );
    return maxDist === 0 ? 0 : dist / maxDist;
  }
  // Linear: project onto the axis for the CSS angle (0° = up, clockwise).
  const rad = ((spec.angle ?? 135) * Math.PI) / 180;
  const dirX = Math.sin(rad);
  const dirY = -Math.cos(rad);
  // Project the centred point; halve the extent so corners map to ~[0,1].
  return 0.5 + ((x - 0.5) * dirX + (y - 0.5) * dirY);
}

/**
 * Sample a gradient into an n×n grid of `#rrggbb` colours (row-major), so it can be painted as a
 * grid of solid Views. n≈6 reads as smooth at avatar sizes; bump it for large previews.
 */
export function gradientGrid(spec: GradientSpec | null | undefined, n = 6): string[] {
  const g = spec && Array.isArray(spec.stops) && spec.stops.length > 0 ? spec : FALLBACK;
  const out: string[] = new Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col + 0.5) / n;
      const y = (row + 0.5) / n;
      out[row * n + col] = colorAt(g.stops, samplePosition(g, x, y));
    }
  }
  return out;
}

// ── Serialisation (rides inside authored content, like the name header) ─────────

/**
 * Compact wire form: `<L|R><angle>:<hex>,<hex>[,<hex>]` (hex without '#').
 * e.g. `L135:7ec8ff,8a5bd0` or `R:ff8a80,c25b9e`. Kept short + control-char-free so it can sit in
 * the SOH-framed identity header. Returns '' for an empty/invalid spec.
 */
export function encodeGradient(spec: GradientSpec | null | undefined): string {
  if (!spec || !Array.isArray(spec.stops) || spec.stops.length < 2) return '';
  const stops = spec.stops
    .slice(0, MAX_GRADIENT_STOPS)
    .map(s => normalizeHex(s).slice(1))
    .join(',');
  const defAngle = spec.type === 'radial' ? DEFAULT_RADIAL_ANGLE : DEFAULT_LINEAR_ANGLE;
  const angle = Math.round(spec.angle ?? defAngle) % 360;
  const head = `${spec.type === 'radial' ? 'R' : 'L'}${angle}`;
  return `${head}:${stops}`;
}

/** Parse the wire form back to a spec, or undefined if malformed. */
export function decodeGradient(wire: string): GradientSpec | undefined {
  if (!wire) return undefined;
  const m = /^([LR])(\d{0,3}):([0-9a-fA-F,]+)$/.exec(wire.trim());
  if (!m) return undefined;
  const stops = m[3]!
    .split(',')
    .filter(Boolean)
    .map(h => normalizeHex(h));
  if (stops.length < 2 || stops.length > MAX_GRADIENT_STOPS) return undefined;
  const isRadial = m[1] === 'R';
  // An empty angle field is a legacy wire form → fall back to the kind's default. A present "0"
  // must stay 0 (the old `parseInt(...) || 135` collapsed a real 0° to 135°).
  const rawAngle = m[2] ? parseInt(m[2], 10) : isRadial ? DEFAULT_RADIAL_ANGLE : DEFAULT_LINEAR_ANGLE;
  return {
    type: isRadial ? 'radial' : 'linear',
    angle: ((rawAngle % 360) + 360) % 360,
    stops,
  };
}

/** Structural sanity check for a spec coming from anywhere untrusted. */
export function isValidGradient(spec: unknown): spec is GradientSpec {
  if (!spec || typeof spec !== 'object') return false;
  const g = spec as Partial<GradientSpec>;
  if (g.type !== 'linear' && g.type !== 'radial') return false;
  if (!Array.isArray(g.stops) || g.stops.length < 2 || g.stops.length > MAX_GRADIENT_STOPS) return false;
  return g.stops.every(s => typeof s === 'string' && /^#?[0-9a-fA-F]{3,6}$/.test(s));
}
