/**
 * Design tokens — the visual language of the app.
 *
 * Dark-only, drawn verbatim from the Stiq Feed design. There is no light palette and no theme
 * toggle: the design is a single dark surface and the app commits to it.
 */
import {fonts} from './typography';

// ── Font families ─────────────────────────────────────────────────────────────

/** Serif family for the "Stiq." wordmark — platform serif (Georgia / Noto Serif). */
export const fontSerif = fonts.serif;

// ── Palette ──────────────────────────────────────────────────────────────────

export const darkColors = {
  bg: '#111111',
  surface: '#1c1c1e',
  surfaceAlt: '#161618',
  surfaceHover: '#242426',

  border: '#2c2c2e',
  borderLight: '#3a3a3c',

  // Inline-embed surface — a card dropped INTO a reading surface (channel message, chat bubble,
  // post body, comment). Deliberately one step ABOVE every background it can land on — bg #111111,
  // surfaceAlt #161618, surface #1c1c1e, surfaceHover #242426, and the accent-blue "mine" bubble —
  // so an embed never merges with its host. Neutral grey by design: it must not compete with the
  // identity gradients or the accent. Always paired with `embedBorder`; the hairline is what keeps
  // it separate on the one background it sits close to (a pressed #242426 card).
  embed: '#2b2b2f',
  embedHover: '#343439',
  embedBorder: '#48484d',

  // Cornflower accent — aligned to blue end of identity gradient (#7cb2ff, hue ~258)
  accent: '#4f8eec',
  accentPressed: '#3970c2',
  accentSoft: 'rgba(79,142,236,0.18)',
  // Slightly stronger accent wash for borders on active hairline chips (design --accent-tint).
  accentTint: 'rgba(79,142,236,0.30)',
  onAccent: '#ffffff',

  textPrimary: '#f5f5f7',
  textSecondary: '#98989e',
  // Muted meta (timestamps, npubs, tag separators, captions). Raised from #6c6c70 — which measured
  // only ~3.6:1 on bg #111111, below WCAG AA (4.5:1) — to #7c7c82 (~4.6:1) so the ~360 small-size
  // meta labels that use it are legible, while staying clearly dimmer than textSecondary (#98989e).
  textMuted: '#7c7c82',

  link: '#9ec6ff',
  tagBg: '#203149',

  success: '#4caf80',
  successBg: '#14361f',
  warning: '#c9a227',
  warningBg: '#2a2010',
  danger: '#d4504e',
  dangerBg: '#3a1f1f',
  // Faintest danger wash — for AMBIENT trouble (a stalled connection strip), where dangerBg's solid
  // #3a1f1f reads as an alert the user must act on. Sits ~one step off bg #111111, so the surface is
  // legible as "something's wrong" without colouring the whole screen.
  dangerSoft: 'rgba(212,80,78,0.12)',

  // Post label accents (NIP-32 label types) — soft, low-chroma tints (matches the design spec).
  // Backgrounds are the accent at ~15% alpha (color-mix-with-transparent equivalent for RN).
  labelInsight: '#6f90c0',
  labelInsightBg: 'rgba(111,144,192,0.15)',
  labelQuestion: '#9b8cc6',
  labelQuestionBg: 'rgba(155,140,198,0.15)',
  labelDiscussion: '#6fab90',
  labelDiscussionBg: 'rgba(111,171,144,0.15)',
  labelPersonal: '#c79583',
  labelPersonalBg: 'rgba(199,149,131,0.15)',
  labelFun: '#bfa75e',
  labelFunBg: 'rgba(191,167,94,0.15)',
} as const;

export type Palette = Record<keyof typeof darkColors, string>;

// The app's single palette. `colors` and `darkColors` are the same object; both names are kept
// so existing imports keep working.
export const colors: Palette = darkColors;

// ── Spacing / radii / type scale ─────────────────────────────────────────────

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const type = {
  title: 27,
  heading: 22,
  subheading: 18,
  body: 17,
  label: 15,
  caption: 13,
  micro: 11,
} as const;

export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const theme = {colors, space, radius, type, weight} as const;
export type Theme = typeof theme;

// ── Dynamic Type policy ──────────────────────────────────────────────────────

// Dense chrome (rows, chips, tab labels, headers, sheet titles) scales up to 30%
// with the user's Dynamic Type setting, then clamps so layouts survive
// accessibility text sizes. Reading surfaces (post bodies, comments, DMs,
// composer input) are left unbounded so users get their full requested size.
export const DENSE_MAX_FONT_SCALE = 1.3;
