/**
 * Text direction — per-paragraph RTL/LTR detection for Arabic-compatible content.
 *
 * STIQ is a bilingual (Arabic / English) community: any single post, comment, channel message
 * or embed can be Arabic, English, or a mix. Rather than flip the whole app to RTL, we detect
 * direction per *paragraph* using the Unicode "first strong character" rule (the same rule the
 * platform bidi algorithm uses to pick a paragraph's base direction): the first character that
 * carries strong directionality decides the paragraph; neutral characters (spaces, digits,
 * punctuation, emoji, URLs' leading symbols) are skipped.
 *
 * Display renderers split content into paragraphs and apply {@link dirAlign} per block, so an
 * Arabic paragraph right-aligns RTL while an adjacent English paragraph stays left-aligned LTR.
 * Composers detect the direction of the paragraph being typed and align the field accordingly.
 *
 * This module is pure (no React, no platform deps) so it is trivially unit-testable and safe to
 * import from any layer.
 */
import type {TextStyle} from 'react-native';

export type Dir = 'rtl' | 'ltr';

/**
 * Strong right-to-left scripts. Covers Hebrew, Arabic (+ Supplement, Extended-A/B), Thaana,
 * Syriac, NKo, Samaritan, Mandaic, and the Arabic Presentation Forms. This is the set of code
 * points classified by Unicode as strong R or AL — the ones that should flip a paragraph to RTL.
 */
const RTL_STRONG =
  '֐-׿' + // Hebrew
  '؀-ۿ' + // Arabic
  '܀-ݏ' + // Syriac
  'ݐ-ݿ' + // Arabic Supplement
  'ހ-޿' + // Thaana
  '߀-߿' + // NKo
  'ࠀ-࠿' + // Samaritan
  'ࡀ-࡟' + // Mandaic
  'ࢠ-ࣿ' + // Arabic Extended-A
  'יִ-ﭏ' + // Hebrew Presentation Forms
  'ﭐ-﷿' + // Arabic Presentation Forms-A
  'ﹰ-﻿'; // Arabic Presentation Forms-B

/**
 * Strong left-to-right letters. We intentionally restrict to *letters* (not every non-RTL char)
 * so that a paragraph beginning with neutrals — "123 مرحبا", "@user مرحبا", "#tag", "http://…" —
 * is decided by its first strong *letter*, not by the leading digit/symbol. Latin, Greek,
 * Cyrillic and the CJK/Hangul/Hiragana/Katakana ideographic blocks all count as strong LTR here.
 */
const LTR_STRONG =
  'A-Za-z' +
  'À-ʯ' + // Latin-1 Supplement … Latin Extended-B / IPA
  'Ͱ-Ͽ' + // Greek
  'Ѐ-ӿ' + // Cyrillic
  'Ḁ-ỿ' + // Latin Extended Additional
  '぀-ヿ' + // Hiragana + Katakana
  '㐀-䶿' + // CJK Extension A
  '一-鿿' + // CJK Unified Ideographs
  '가-힯'; // Hangul Syllables

const RTL_RE = new RegExp(`[${RTL_STRONG}]`);
// Walks the string and matches the first character that is strong in EITHER direction.
const FIRST_STRONG_RE = new RegExp(`[${RTL_STRONG}${LTR_STRONG}]`);

/** True if the string contains any strong RTL character at all (used for quick mixed-content checks). */
export function hasRtl(text: string): boolean {
  return RTL_RE.test(text);
}

/**
 * Direction of a single paragraph by the first-strong-character rule.
 * Returns 'ltr' when the paragraph has no strong character (neutral-only or empty).
 */
export function firstStrongDir(text: string): Dir {
  if (!text) return 'ltr';
  const m = FIRST_STRONG_RE.exec(text);
  if (!m) return 'ltr';
  return RTL_RE.test(m[0]) ? 'rtl' : 'ltr';
}

/** Split content into paragraphs on hard line breaks, preserving empty lines' positions. */
export function splitParagraphs(text: string): string[] {
  return text.split(/\r?\n/);
}

const RTL_STYLE: TextStyle = {writingDirection: 'rtl', textAlign: 'right'};
const LTR_STYLE: TextStyle = {writingDirection: 'ltr', textAlign: 'left'};

/**
 * Style fragment to apply a resolved direction to a `<Text>`/`<TextInput>`.
 * Spread AFTER the base style so it wins: `style={[s.body, dirAlign(dir)]}`.
 */
export function dirAlign(dir: Dir): TextStyle {
  return dir === 'rtl' ? RTL_STYLE : LTR_STYLE;
}

/** Convenience: resolve a paragraph's direction straight to its alignment style. */
export function paragraphAlign(text: string): TextStyle {
  return dirAlign(firstStrongDir(text));
}

const RTL_VCENTER: TextStyle = {textAlignVertical: 'center'};

/**
 * Android reserves a tall line box for Arabic/RTL runs (the system Arabic fallback font carries
 * large vertical metrics for vowel marks even when none are present) and TOP-aligns the glyph,
 * dumping all the slack BELOW a single line. Centring the glyph (`textAlignVertical: 'center'`)
 * balances that box — but it only *relocates* the slack, splitting it above and below the glyph.
 * So the leading gap under an Arabic title becomes `surroundingMargin + slack/2`, which reads as
 * "too much space above."
 *
 * `pullUp` reclaims that: pass the design's above-margin (the sibling's marginBottom, in dp) and it
 * applies a matching negative `marginTop`, cancelling the surrounding margin so the Arabic title
 * hugs the row above it just like a Latin one — leaving only the irreducible font slack. The pull
 * lands in the neighbour's empty margin (not its content), so there's no overlap. The line height
 * itself can't be clamped below the script's minimum, so this is the tightest safe correction.
 *
 * No-op for LTR (and `marginTop`/`textAlignVertical` are ignored on iOS). Spread AFTER the base
 * style on single-line user text that may be Arabic (titles, headings).
 */
export function rtlVerticalFix(text: string, pullUp = 0): TextStyle {
  if (firstStrongDir(text) !== 'rtl') return {};
  return pullUp > 0 ? {...RTL_VCENTER, marginTop: -pullUp} : RTL_VCENTER;
}
