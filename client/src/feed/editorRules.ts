/**
 * editorRules — the single source of truth for the Post Editor's size-rule meter, the two step
 * gates (Next / Publish), and the Drafts status chip.
 *
 * This is the "byte-for-byte validator" the design handoff insists on: the live composer meter and
 * the Drafts screen's status chip must NEVER disagree, so both read the same functions here. The
 * numbers (`Limits`) are organizer policy — derived from the community's PostRules — so changing a
 * limit re-renders both surfaces identically.
 *
 * The load-bearing asymmetry (from the handoff):
 *   • Note character cap  → HARD (over → blocked, red).
 *   • Article word floor  → HARD (under → blocked).
 *   • Article word ceiling → SOFT advisory (amber, NOT blocked) UNLESS the organizer set an explicit
 *     hard `article.max` in PostRules — that ceiling is relay-enforced, so we must block on it too.
 */
import {DEFAULT_POST_RULES, wordCount, type PostKind, type PostRules} from './postRules';
import {bodyForMeasure} from './inlineMedia';

/** A non-breaking space (U+00A0). Built from a char code so the source stays plain ASCII. */
const NBSP = String.fromCharCode(0xa0);

/** Note vs Article — DERIVED from the title, never stored as a toggle. */
export type Mode = PostKind; // 'note' | 'article'
export const modeOf = (title: string): Mode => (title.trim() !== '' ? 'article' : 'note');

/** Design defaults, used when the organizer's PostRules leave a bound unset (0 = "no bound"). */
export const DEFAULT_NOTE_MAX = 280; // characters — a tweet-style ceiling
export const DEFAULT_ARTICLE_MIN = 150; // words — "write enough to publish" floor
export const DEFAULT_ARTICLE_MAX = 2000; // words — soft advisory ceiling

/** Resolved organizer size rules the meter renders against. */
export interface Limits {
  /** Hard character cap for notes. */
  noteMax: number;
  /** Hard word floor for articles. */
  articleMin: number;
  /** Word ceiling for articles (soft unless {@link articleMaxHard}). */
  articleMax: number;
  /** True when the organizer set an explicit, relay-enforced `article.max` → the ceiling blocks. */
  articleMaxHard: boolean;
  /** Max inline media (pictures + voice) per note. 0 = unbounded. Relay-enforced. */
  noteMediaMax: number;
  /** Max inline media (pictures + voice) per article. 0 = unbounded. Relay-enforced. */
  articleMediaMax: number;
}

export const DEFAULT_LIMITS: Limits = {
  noteMax: DEFAULT_NOTE_MAX,
  articleMin: DEFAULT_ARTICLE_MIN,
  articleMax: DEFAULT_ARTICLE_MAX,
  articleMaxHard: false,
  noteMediaMax: DEFAULT_POST_RULES.note.mediaMax,
  articleMediaMax: DEFAULT_POST_RULES.article.mediaMax,
};

/**
 * Derive the meter's {@link Limits} from the community's PostRules. A bound left at 0 ("no bound")
 * falls back to the design default so the editor demonstrates its intended shape out of the box; an
 * organizer-set bound (>0) wins. An explicit `article.max` is relay-enforced, so it becomes a hard
 * ceiling rather than the default soft advisory.
 */
export function limitsFromRules(rules: PostRules = DEFAULT_POST_RULES): Limits {
  const hasHardArticleMax = rules.article.max > 0;
  return {
    noteMax: rules.note.max > 0 ? rules.note.max : DEFAULT_NOTE_MAX,
    articleMin: rules.article.min > 0 ? rules.article.min : DEFAULT_ARTICLE_MIN,
    articleMax: hasHardArticleMax ? rules.article.max : DEFAULT_ARTICLE_MAX,
    articleMaxHard: hasHardArticleMax,
    // Media caps pass through verbatim — unlike length, `0` here is the organizer's explicit "no
    // media limit", not "fall back to a default" (the default is already applied at parse time).
    noteMediaMax: rules.note.mediaMax,
    articleMediaMax: rules.article.mediaMax,
  };
}

/** The media cap that applies to a post of `mode` (0 = unbounded). */
export function mediaMaxFor(mode: Mode, L: Limits): number {
  return mode === 'article' ? L.articleMediaMax : L.noteMediaMax;
}

export interface MediaValidation {
  /** Gates Next/Publish alongside the length check. */
  ok: boolean;
  count: number;
  /** The applicable cap (0 = unbounded). */
  max: number;
  /** Advisory shown on the insert bar; '' when unbounded. */
  hint: string;
  /** Error shown when over the cap; '' when ok. */
  error: string;
}

/**
 * Validate a post's inline-media COUNT against the per-type cap. Media is exempt from the length
 * meter (see {@link measureBody}); this is the separate, dedicated gate. Mirrors the relay's hard
 * cap so a body the composer accepts is never rejected on media count at write time.
 */
export function validateMedia(mode: Mode, count: number, L: Limits): MediaValidation {
  const max = mediaMaxFor(mode, L);
  if (max <= 0) return {ok: true, count, max: 0, hint: '', error: ''}; // unbounded
  const noun = max === 1 ? '1 picture or voice note' : `${max} pictures or voice notes`;
  const where = mode === 'article' ? 'article' : 'post';
  const hint = `Up to ${noun} per ${where}`;
  return count > max
    ? {ok: false, count, max, hint, error: `Only ${noun} allowed per ${where} — remove ${count - max}`}
    : {ok: true, count, max, hint, error: ''};
}

export interface CountStats {
  chars: number;
  words: number;
  /** True when there is nothing to publish (no text and no embed). */
  empty: boolean;
}

/**
 * Count characters/words of a body. Notes are gated on characters, articles on words — the same
 * measurement the relay uses, so client and relay agree. `hasEmbed` keeps a body that carries only
 * an inserted reference (an embed with no prose) from reading as empty.
 */
export function countStats(text: string, hasEmbed: boolean): CountStats {
  const t = text.split(NBSP).join(' ').trim();
  const chars = t.length;
  const words = t ? t.split(/\s+/).length : 0;
  return {chars, words, empty: chars === 0 && !hasEmbed};
}

export type WriteState = 'empty' | 'ok' | 'under' | 'over' | 'long';

export interface WriteValidation {
  /** Gates the Next button. */
  ok: boolean;
  /** Drives the meter treatment (neutral / green / accent / red / amber). */
  state: WriteState;
  /** The live count shown as `count / denom`. */
  count: number;
  denom: number;
  /** Progress-track fill, 0..1. */
  ratio: number;
  /** One of the seven meter messages. */
  msg: string;
}

/**
 * Validate the Write step. Returns the meter model + whether Next is enabled. Mirror of the handoff
 * `validateWrite`, extended only so an organizer's hard article ceiling blocks (see file header).
 */
export function validateWrite(mode: Mode, s: CountStats, L: Limits): WriteValidation {
  if (mode === 'article') {
    const min = L.articleMin;
    const max = L.articleMax;
    const w = s.words;
    if (s.empty || w === 0) {
      return {ok: false, state: 'empty', count: 0, denom: min, ratio: 0, msg: `${min}+ words to publish an article`};
    }
    if (w < min) {
      return {ok: false, state: 'under', count: w, denom: min, ratio: w / min, msg: `${min - w} more words to publish an article`};
    }
    if (w > max) {
      // Soft advisory unless the organizer set a hard cap (then it's a relay-enforced wall).
      return L.articleMaxHard
        ? {ok: false, state: 'over', count: w, denom: max, ratio: 1, msg: `${w - max} over the ${max}-word limit — shorten`}
        : {ok: true, state: 'long', count: w, denom: max, ratio: 1, msg: `${w - max} over the ${max}-word limit`};
    }
    return {ok: true, state: 'ok', count: w, denom: max, ratio: Math.min(w / max, 1), msg: 'Good length — ready for details'};
  }
  const cmax = L.noteMax;
  const c = s.chars;
  // A note is publishable once it has ANY content. Media (picture/voice/embed) counts as content:
  // `s.empty` is false when the body carries an inline picture, voice clip, or embed even with zero
  // prose characters (the base64 token is excluded from `c` upstream via bodyForMeasure). So a
  // caption-less picture — a "tweet" that is only an image — is valid; only a truly blank note is not.
  if (s.empty) {
    return {ok: false, state: 'empty', count: 0, denom: cmax, ratio: 0, msg: `Up to ${cmax} characters`};
  }
  if (c > cmax) {
    return {ok: false, state: 'over', count: c, denom: cmax, ratio: 1, msg: `${c - cmax} over the ${cmax} limit — shorten, or add a title`};
  }
  return {ok: true, state: 'ok', count: c, denom: cmax, ratio: c / cmax, msg: `${cmax - c} characters left`};
}

export interface DetailsValidation {
  /** Gates the Publish button. */
  ok: boolean;
  tagsOk: boolean;
  labelNeeded: boolean;
  labelOk: boolean;
}

/**
 * Validate the Details step. Tags are always required (≥1). A label is required for articles — but
 * only when the community actually offers article labels (`labelRequired`), so a community with no
 * article-scoped labels can't deadlock. Notes never surface the Label section.
 */
export function validateDetails(
  mode: Mode,
  tags: string[],
  label: string | null | undefined,
  labelRequired: boolean,
): DetailsValidation {
  const tagsOk = tags.length >= 1;
  const labelNeeded = mode === 'article' && labelRequired;
  const labelOk = !labelNeeded || label != null;
  return {ok: tagsOk && labelOk, tagsOk, labelNeeded, labelOk};
}

/**
 * The organizer's caps for a LONG body, applied universally — to channel broadcasts, group messages,
 * DMs and comments, not just to the feed's article. 0 means unbounded on either axis.
 *
 * Deliberately NOT derived through {@link limitsFromRules}. That function substitutes design
 * defaults (a 2000-word ceiling) wherever the organizer left a bound at 0, which is right for the
 * feed's soft advisory — it demonstrates the editor's intended shape out of the box — and wrong
 * here: inventing a 2000-word ceiling for a message would block writing that the relay is perfectly
 * happy to accept. These numbers are the organizer's alone, and match what the relay enforces (see
 * relay/internal/policy/organizer.go checkPostRules).
 *
 * The note rule is deliberately absent. A note's character cap is the feed note's own; every other
 * surface answers to the long-body rule.
 */
export interface UniversalLimits {
  /** Word ceiling for any long body. 0 = unbounded. */
  words: number;
  /** Inline-media (picture + voice) ceiling for any long body. 0 = unbounded. */
  media: number;
}

export function universalLimits(rules: PostRules = DEFAULT_POST_RULES): UniversalLimits {
  return {words: rules.article.max, media: rules.article.mediaMax};
}

export interface UniversalValidation {
  /** False once the body exceeds a cap the relay would reject it for. */
  ok: boolean;
  /** A single quiet sentence when over; '' when fine. NEVER a running count — see the note below. */
  msg: string;
}

/**
 * Check a body against {@link UniversalLimits}.
 *
 * Returns a message ONLY when the body is actually over a cap. This is the whole difference from the
 * feed's meter: writing on a message surface is not narrated by a live counter ticking toward a
 * limit. In a default community both caps are 0, so this never says anything at all.
 *
 * `words` must already be measured on PROSE (media and embed tokens stripped — see `bodyForMeasure`),
 * matching how the relay measures it, so a body this accepts is never rejected on the wire.
 */
export function validateUniversalBody(words: number, mediaCount: number, L: UniversalLimits): UniversalValidation {
  if (L.words > 0 && words > L.words) {
    const over = words - L.words;
    return {ok: false, msg: `${over} word${over === 1 ? '' : 's'} over this community's limit of ${L.words}`};
  }
  if (L.media > 0 && mediaCount > L.media) {
    const noun = L.media === 1 ? '1 picture or voice note' : `${L.media} pictures or voice notes`;
    return {ok: false, msg: `Only ${noun} allowed here — remove ${mediaCount - L.media}`};
  }
  return {ok: true, msg: ''};
}

export type DraftStatus = {cls: 'ok' | 'warn'; msg: string};

/**
 * The composer's rule set collapsed onto a draft's stored numbers — this is why a draft's status
 * chip and the live editor can never contradict each other. Keep it identical to validateWrite +
 * validateDetails.
 */
export function draftStatus(
  kind: Mode,
  chars: number,
  words: number,
  label: string | null | undefined,
  L: Limits = DEFAULT_LIMITS,
): DraftStatus {
  if (kind === 'note') {
    if (chars > L.noteMax) return {cls: 'warn', msg: `${chars - L.noteMax} over the ${L.noteMax} limit`};
    return {cls: 'ok', msg: 'Ready to publish'};
  }
  if (words < L.articleMin) return {cls: 'warn', msg: `${L.articleMin - words} more words to publish`};
  if (!label) return {cls: 'warn', msg: 'Add a label to publish'};
  return {cls: 'ok', msg: 'Ready to publish'};
}

/** Convenience: measure a body + title into the numbers `draftStatus` wants. */
export function measureBody(title: string, body: string): {kind: Mode; chars: number; words: number} {
  // Strip inline media tokens (voice/picture base64) first so they don't inflate the char/word count
  // against the length rules — a picture is not prose.
  const measured = bodyForMeasure(body);
  const t = measured.split(NBSP).join(' ').trim();
  return {kind: modeOf(title), chars: t.length, words: wordCount(measured)};
}
