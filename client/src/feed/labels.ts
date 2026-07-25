/**
 * Post labels (post "types"). A post may carry one label, stored as a NIP-32 label tag:
 * ['l', <id>, 'stiq.type']. The set is organizer-defined (kind-30078 d=stiq:labels — see the
 * config layer below); the seed below is the build-time fallback. Length/required rules live in
 * postRules.ts. A label is referenced by a stable id, so any non-empty string is a valid label.
 */

export const LABEL_NAMESPACE = 'stiq.type';

/** Seed label ids — the build-time fallback set (also seeds DEFAULT_LABELS). */
export const POST_LABELS = ['insight', 'question', 'discussion', 'personal', 'fun'] as const;
/** A label id. Organizer-defined, so any non-empty string is valid (unknown ids render neutrally). */
export type PostLabel = string;

export function isPostLabel(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}

import {colors} from '../ui/theme';
import {coercePostScope, type PostScope} from './postRules';

/** Display metadata for the built-in seed labels (chip text + accent color). */
export const LABEL_META: Record<(typeof POST_LABELS)[number], {text: string; color: string; bg: string}> = {
  insight: {text: 'INSIGHT', color: colors.labelInsight, bg: colors.labelInsightBg},
  question: {text: 'QUESTION', color: colors.labelQuestion, bg: colors.labelQuestionBg},
  discussion: {text: 'DISCUSSION', color: colors.labelDiscussion, bg: colors.labelDiscussionBg},
  personal: {text: 'PERSONAL', color: colors.labelPersonal, bg: colors.labelPersonalBg},
  fun: {text: 'FUN', color: colors.labelFun, bg: colors.labelFunBg},
};

// ─────────────────────────────────────────────────────────────────────────────
// Organizer-configurable label set (kind-30078, d=stiq:labels).
//
// Replaces the build-time POST_LABELS/LABEL_META above. A post references a label by its stable
// `id` in ['l', id, 'stiq.type'], so the organizer can rename, recolor, reorder, add, or delete
// labels without touching past posts: a removed id renders with a neutral fallback chip.
// ─────────────────────────────────────────────────────────────────────────────

export const KIND_LABELS = 30078;
export const LABELS_D_TAG = 'stiq:labels';

export interface LabelDef {
  /** Stable slug stored in the post's label tag; never reused after delete. */
  id: string;
  /** Display name (rendered upper-cased in chips). */
  name: string;
  /** Hex accent color. */
  color: string;
  /** Chip background; derived from `color` at low alpha when absent. */
  bg?: string;
  order: number;
  /** Which post types may carry this label (composer-enforced). Default 'all'. */
  appliesTo: PostScope;
}

export type LabelConfig = LabelDef[];

/** Default set = today's built-in labels, so an un-configured community looks unchanged. */
export const DEFAULT_LABELS: LabelConfig = POST_LABELS.map((id, i) => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  color: LABEL_META[id].color,
  bg: LABEL_META[id].bg,
  order: i,
  appliesTo: 'all',
}));

/**
 * Fill any missing fields on a (possibly old-shape / partial) LabelConfig read from storage or an
 * older join code. `appliesTo` was added with per-post-type label scoping; a label persisted before
 * that lacks it, which would make `scopeAppliesTo(l.appliesTo, kind)` treat every label as scoped
 * to neither type and hide the whole picker. Coercing each entry keeps old configs working. Returns
 * `undefined` for non-array input so callers fall back to their own default set.
 */
export function normalizeLabels(labels: LabelConfig | null | undefined): LabelConfig | undefined {
  if (!Array.isArray(labels)) return undefined;
  return labels
    .filter((l): l is LabelDef => !!l && typeof l.id === 'string' && l.id.length > 0)
    .map((l, i) => ({
      id: l.id,
      name: typeof l.name === 'string' && l.name ? l.name : l.id,
      color: typeof l.color === 'string' && l.color ? l.color : FALLBACK_LABEL_COLOR,
      bg: typeof l.bg === 'string' && l.bg ? l.bg : undefined,
      order: typeof l.order === 'number' && Number.isFinite(l.order) ? l.order : i,
      appliesTo: coercePostScope(l.appliesTo),
    }));
}

/** Compact on-wire shape (kind-30078 content). */
interface LabelDefWire {
  id?: string;
  nm?: string;
  c?: string;
  bg?: string;
  o?: number;
  a?: string;
}
interface LabelsWire {
  lbls?: LabelDefWire[];
}

export function encodeLabels(labels: LabelConfig): LabelsWire {
  return {lbls: labels.map(l => ({id: l.id, nm: l.name, c: l.color, bg: l.bg, o: l.order, a: l.appliesTo}))};
}

export function parseLabels(raw: unknown): LabelConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as LabelsWire;
  if (!Array.isArray(w.lbls)) return null;
  const out: LabelDef[] = [];
  for (const l of w.lbls) {
    if (!l || typeof l.id !== 'string' || !l.id) continue;
    out.push({
      id: l.id,
      name: typeof l.nm === 'string' && l.nm ? l.nm : l.id,
      color: typeof l.c === 'string' && l.c ? l.c : FALLBACK_LABEL_COLOR,
      bg: typeof l.bg === 'string' && l.bg ? l.bg : undefined,
      order: typeof l.o === 'number' && Number.isFinite(l.o) ? l.o : out.length,
      appliesTo: coercePostScope(l.a),
    });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

/** Parse a kind-30078 event's content into a LabelConfig (null if malformed). */
export function parseLabelsEvent(content: string): LabelConfig | null {
  try {
    return parseLabels(JSON.parse(content));
  } catch {
    return null;
  }
}

const FALLBACK_LABEL_COLOR = '#8a8f98';

/** Add ~15% alpha to a #RRGGBB color for the chip background (pass-through if not 7-char hex). */
function tintOf(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color + '26' : color;
}

/**
 * Resolve a label id to chip metadata against the active config. An unknown / deleted id falls
 * back to a neutral chip showing the raw id, so posts tagged with a since-removed label still
 * render (non-destructive deletion).
 */
export function labelMetaFor(
  id: string,
  labels: LabelConfig,
): {text: string; color: string; bg: string} {
  const def = labels.find(l => l.id === id);
  if (def) return {text: def.name.toUpperCase(), color: def.color, bg: def.bg ?? tintOf(def.color)};
  return {text: id.toUpperCase(), color: FALLBACK_LABEL_COLOR, bg: tintOf(FALLBACK_LABEL_COLOR)};
}
