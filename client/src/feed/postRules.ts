/**
 * Per-post-type content rules — the organizer's control over post length and whether a post
 * must carry a label. Generalizes (and replaces) the build-time "insight needs substance" gate.
 *
 * Delivered as a kind-30078 doc (d=stiq:post-rules) signed by the organizer; consumed on the
 * composer hot path (soft guardrail) and by the deterministic auto-moderation evaluator.
 *
 * Two post types, each with its own unit:
 *   - note    (kind-1)     measured in CHARACTERS (today's 280 default)
 *   - article (kind-30023) measured in WORDS
 *
 * min/max of 0 means "no bound". Defaults preserve today's behaviour (note ≤ 280 chars,
 * articles unbounded, no required label) so an un-configured community sees no change.
 */

export const KIND_POST_RULES = 30078;
export const POST_RULES_D_TAG = 'stiq:post-rules';

/** Resulting post type. Title present ⇒ article (kind-30023); otherwise a note (kind-1). */
export type PostKind = 'note' | 'article';

/** Which post types an organizer-defined label or community tag is offered for. */
export type PostScope = 'all' | PostKind;

/** Coerce arbitrary JSON into a PostScope (anything unrecognized ⇒ 'all'). */
export function coercePostScope(v: unknown): PostScope {
  return v === 'note' || v === 'article' ? v : 'all';
}

/** True if a label/tag scoped to `scope` should be offered for a post of `kind`. */
export function scopeAppliesTo(scope: PostScope, kind: PostKind): boolean {
  return scope === 'all' || scope === kind;
}

export interface TypeRule {
  /** Minimum length (chars for notes, words for articles). 0 = no minimum. */
  min: number;
  /** Maximum length (chars for notes, words for articles). 0 = unbounded. */
  max: number;
  /**
   * Maximum number of inline media (pictures + voice notes) a post of this type may carry. Media is
   * EXEMPT from the character/word length rule (its base64 never counts toward {@link max}); this is
   * the separate, dedicated cap. 0 = unbounded. Design default: a note carries at most 1 (a "tweet"
   * with a single picture or voice clip), an article a larger organizer-set number.
   */
  mediaMax: number;
  /** When true, a post of this type must carry a label before it can publish. */
  labelRequired: boolean;
}

export interface PostRules {
  note: TypeRule;
  article: TypeRule;
  /** Max length (characters) of an author's note (the pinned comment). 0 = unbounded. Enforced
   * by the composer only — the note is a kind-1111 comment the relay does not length-check. */
  authorNoteMax: number;
}

/** Design default media caps: a note is a single picture/voice "tweet"; an article carries more. */
export const DEFAULT_NOTE_MEDIA_MAX = 1;
export const DEFAULT_ARTICLE_MEDIA_MAX = 8;

export const DEFAULT_POST_RULES: PostRules = {
  note: {min: 0, max: 280, mediaMax: DEFAULT_NOTE_MEDIA_MAX, labelRequired: false},
  article: {min: 0, max: 0, mediaMax: DEFAULT_ARTICLE_MEDIA_MAX, labelRequired: false},
  authorNoteMax: 280,
};

/** Compact on-wire shape (kind-30078 content). */
interface TypeRuleWire {
  mn?: number;
  mx?: number;
  /** Media cap (pictures + voice notes) per post of this type. 0 = unbounded. */
  mm?: number;
  lr?: boolean;
}
interface PostRulesWire {
  note?: TypeRuleWire;
  article?: TypeRuleWire;
  anmx?: number;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}

function parseTypeRule(raw: TypeRuleWire | undefined, fallback: TypeRule): TypeRule {
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    min: nonNegInt(raw.mn, fallback.min),
    max: nonNegInt(raw.mx, fallback.max),
    // Absent `mm` (a doc from an older organizer that predates media caps) → the design default, so a
    // community gets the "1 media per note" behaviour out of the box without republishing its rules.
    mediaMax: nonNegInt(raw.mm, fallback.mediaMax),
    labelRequired: typeof raw.lr === 'boolean' ? raw.lr : fallback.labelRequired,
  };
}

export function encodePostRules(r: PostRules): PostRulesWire {
  return {
    note: {mn: r.note.min, mx: r.note.max, mm: r.note.mediaMax, lr: r.note.labelRequired},
    article: {mn: r.article.min, mx: r.article.max, mm: r.article.mediaMax, lr: r.article.labelRequired},
    anmx: r.authorNoteMax,
  };
}

export function parsePostRules(raw: unknown): PostRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as PostRulesWire;
  return {
    note: parseTypeRule(w.note, DEFAULT_POST_RULES.note),
    article: parseTypeRule(w.article, DEFAULT_POST_RULES.article),
    authorNoteMax: nonNegInt(w.anmx, DEFAULT_POST_RULES.authorNoteMax),
  };
}

/** Parse a kind-30078 event's content into PostRules (null if malformed). */
export function parsePostRulesEvent(content: string): PostRules | null {
  try {
    return parsePostRules(JSON.parse(content));
  } catch {
    return null;
  }
}

/** Count words in a body (whitespace-delimited; empty ⇒ 0). Used for article measurement. */
export function wordCount(body: string): number {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export type PostViolation = 'too-short' | 'too-long' | 'label-required';

export interface PostInput {
  kind: PostKind;
  /** The post body (note text or article body). */
  body: string;
  /** The label id applied to the post, if any. */
  label?: string | null;
}

/**
 * Deterministic check of a post against the rules. Returns the list of violations (empty ⇒ ok).
 * The SAME measurement is used by the composer guardrail, auto-moderation, and (for max length)
 * the relay — so client and relay must agree: notes count characters, articles count words.
 */
export function evaluatePost(input: PostInput, rules: PostRules): PostViolation[] {
  const rule = input.kind === 'article' ? rules.article : rules.note;
  const measure = input.kind === 'article' ? wordCount(input.body) : input.body.length;
  const out: PostViolation[] = [];
  if (rule.min > 0 && measure < rule.min) out.push('too-short');
  if (rule.max > 0 && measure > rule.max) out.push('too-long');
  if (rule.labelRequired && !input.label) out.push('label-required');
  return out;
}

/** Human-readable message for a violation, for inline composer hints + the mod-log reason. */
export function violationMessage(v: PostViolation, kind: PostKind, rules: PostRules): string {
  const rule = kind === 'article' ? rules.article : rules.note;
  const unit = kind === 'article' ? 'words' : 'characters';
  switch (v) {
    case 'too-short':
      return `${kind === 'article' ? 'Article' : 'Post'} must be at least ${rule.min} ${unit}.`;
    case 'too-long':
      return `${kind === 'article' ? 'Article' : 'Post'} must be at most ${rule.max} ${unit}.`;
    case 'label-required':
      return `${kind === 'article' ? 'Articles' : 'Posts'} must have a label.`;
  }
}
