/**
 * Channel design tokens — the EXACT measured values from the Channels mockup (§6 of the redesign
 * spec). This is the single source of truth for the Channels area's visuals; the shared message
 * primitives consume ONLY these, never the app's semantic `typeScale`/`space` tokens (which are
 * near-but-not-equal to the mockup and were the root cause of the redesign's pixel drift — RC-3).
 *
 * The palette lives in the app theme (its dark values already equal the mockup, so we re-export it
 * here rather than duplicate hex codes). The numeric metrics below are mockup-derived and live
 * nowhere else.
 *
 * Phone frame renders at ~411px ≈ device dp, so mockup px map to RN dp 1:1.
 */
import {colors, DENSE_MAX_FONT_SCALE} from '../ui/theme';

export {colors, DENSE_MAX_FONT_SCALE};

/** Type ramp — `{size, lineHeight}` pairs as measured on the channel detail screen. */
export const ctType = {
  /** Message body text. Mockup native 16/25.92; user-confirmed target 17/27. */
  body: {fontSize: 17, lineHeight: 27},
  /** Header channel/group name. */
  name: {fontSize: 18, lineHeight: 22},
  /** Header subtitle (accent "… ›"). */
  subtitle: {fontSize: 13, lineHeight: 17},
  /** Card author name (inline, beside the npub). Mockup: 12.5 / 600 / text-secondary. */
  authorName: {fontSize: 12.5, lineHeight: 16},
  /** Card author npub (inline monospace). Mockup: 10.5 / text-muted. */
  authorNpub: {fontSize: 10.5, lineHeight: 14},
  /** Reaction chip count + comment count. */
  chipCount: {fontSize: 13, lineHeight: 16},
  /** Footer timestamp + ⋯ dots size. */
  time: {fontSize: 12, lineHeight: 15},
  /** PINNED / SAVED uppercase labels. */
  microLabel: {fontSize: 11, lineHeight: 14},
  /** Referenced-card accent label. */
  refLabel: {fontSize: 10, lineHeight: 13},
  /** Referenced-card title line. */
  refTitle: {fontSize: 14.5, lineHeight: 19},
  /** Referenced-card snippet + pinned preview. */
  refSnippet: {fontSize: 13, lineHeight: 18},
  /** Referenced-card author name. */
  refAuthor: {fontSize: 11.5, lineHeight: 15},
} as const;

/** Letter-spacing for the uppercase labels (RN uses absolute dp, not em). */
export const ctTracking = {
  pinned: 0.55,
  refLabel: 0.7,
  saved: 0.6,
} as const;

/** Font weights, mirroring the mockup's 400/600/700 usage. */
export const ctWeight = {
  regular: '400',
  semibold: '600',
  bold: '700',
} as const;

/** Corner radii (dp). */
export const ctRadius = {
  card: 14,
  pinned: 12,
  ref: 10,
  chip: 999,
  pill: 999,
  sheet: 14,
  avatarMd: 10,
} as const;

/** Avatar sizes (dp). */
export const ctAvatar = {
  /** Channel/group header avatar. */
  header: 44,
  /** Group header avatar (slightly smaller in the group layout). */
  headerGroup: 40,
  /** Card author header avatar (inline name + npub row). */
  cardAuthor: 22,
  /** Bubble incoming sender avatar. */
  bubbleSender: 18,
  /** Referenced-card author avatar. */
  refAuthor: 16,
} as const;

/** Spacing primitives used across the card/bubble/composer (dp). */
export const ctSpace = {
  /** Card & pinned-bar horizontal side margin. */
  side: 12,
  /** Card & pinned-bar top margin (gap between stacked cards). */
  stackGap: 10,
  /** Card padding: top / horizontal / bottom. */
  cardPadTop: 14,
  cardPadX: 15,
  cardPadBottom: 12,
  /** Pinned bar / referenced card padding. */
  pinnedPadY: 10,
  pinnedPadX: 13,
  refPadY: 11,
  refPadX: 13,
  /** Reaction-chip row: top margin and inter-chip gap. */
  chipRowTop: 12,
  chipGap: 8,
  /** Chip inner padding. */
  chipPadX: 10,
  chipPadY: 4,
  /** Footer row: top margin and inter-item gap. */
  footerTop: 12,
  footerGap: 14,
  /** Author header gap + bottom margin. */
  authorGap: 8,
  authorBottom: 8,
  /** Referenced card top margin (sits under the body). */
  refTop: 8,
  /** Accent left-bar width on the referenced card. */
  refBar: 3,
} as const;

/** The accent ↑ send button (composer). */
export const ctSend = {
  size: 36,
  radius: 18,
  arrow: 18,
} as const;
