/**
 * Cross-modality helpers for bodies that carry NON-PROSE tokens — inline media (voice + pictures)
 * and embed/reference cards (see ./embedTokens).
 *
 * Voice clips, pictures and embeds all ride inside a message body as self-delimited machine payloads
 * that the reader never sees as text. Two places must treat such a token as content, not prose:
 *   - one-line PREVIEWS (inbox, reply quotes, pinned bars) must show a short label, never the
 *     multi-KB base64 blob → `inlineMediaSummary`.
 *   - LENGTH MEASUREMENT (composer length gate, draft readiness, auto-moderation) must not count a
 *     base64 token's thousands of characters against a note's character limit → `bodyForMeasure`.
 */
import {stripInlineVoices, hasInlineVoice, extractInlineVoices, countInlineVoices, type VoiceMessage} from './voice';
import {stripInlinePictures, hasInlinePicture, extractInlinePictures, countInlinePictures, type InlinePicture} from './picture';
import {stripEmbedTokens, labelEmbedTokens, firstEmbedLabel} from './embedTokens';
import {stripBlockMarkdown} from './plainText';

/**
 * Replace inline media and embed tokens with short placeholders IN PLACE, preserving surrounding
 * text and line breaks. Use where a body is shown verbatim as plain text (an edit-history view, a
 * draft row) rather than collapsed to one line — so a token never leaks its base64 blob but the
 * rest of the text is intact.
 */
export function labelInlineMedia(text: string): string {
  return labelEmbedTokens(
    text.replace(/\[\[pic:[^\]]+\]\]/g, '🖼️ picture').replace(/\[\[voice:[^\]]+\]\]/g, '🎙 voice'),
  );
}

/**
 * Strip every non-prose token — inline media, then embed/reference cards — so a body can be measured
 * as prose (chars/words).
 *
 * STRIP ORDER IS LOAD-BEARING, and the relay repeats it exactly (organizer.go `bodyForMeasure`):
 * media first, embeds second. A body like `[[pic:8;4;stiq:event:AAA]]` measures differently either
 * way — the pic frame is invalid while it still contains the `:`-bearing token, so stripping embeds
 * first would leave a DIFFERENT residue than stripping media first. Client and relay must land on
 * the same number or the relay rejects a post the composer accepted.
 */
export function bodyForMeasure(body: string): string {
  let out = body;
  if (hasInlineVoice(out)) out = stripInlineVoices(out);
  if (hasInlinePicture(out)) out = stripInlinePictures(out);
  return stripEmbedTokens(out);
}

/**
 * Count the inline media (pictures + voice notes) in a body — the value checked against a post
 * type's `mediaMax` cap. Counts the SAME tokens {@link bodyForMeasure} strips for length, so a body
 * that is exempt-from-length by N tokens is capped-by-count at exactly N. The relay counts these
 * identically (same token grammar) so the client gate and the relay's hard cap never disagree.
 */
export function countInlineMedia(body: string): number {
  return countInlinePictures(body) + countInlineVoices(body);
}

/**
 * One piece of a body split around its inline media, in document order: either a run of prose text
 * or a single decoded media clip. {@link segmentInlineMedia} produces these so a renderer can place a
 * picture/voice chip EXACTLY where it sits in the text (rather than collecting all media at the end).
 */
export type BodySegment =
  | {type: 'text'; value: string}
  | {type: 'pic'; pic: InlinePicture}
  | {type: 'voice'; voice: VoiceMessage};

// Loose scan for either media token; each candidate is then validated by the strict extractor below
// (`[[ ]]` never occurs in base64/markdown, and neither token body can contain `]`, so this is safe).
const MEDIA_TOKEN_RE = /\[\[pic:[^\]]+\]\]|\[\[voice:[^\]]+\]\]/g;

/**
 * Split a body into an ordered list of text runs and inline media (pictures + voice clips), so a
 * renderer can interleave the chips at their real position instead of appending them all at the end.
 * A token that fails strict validation (malformed / oversized) is left in the surrounding text run —
 * exactly what the strip/extract helpers already do — so nothing changes for such tokens.
 *
 * Only pictures and voice clips are segmented; nostr embeds and image URLs are NOT touched here (the
 * caller pulls those out separately and renders them as trailing cards).
 */
export function segmentInlineMedia(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MEDIA_TOKEN_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    // Validate the candidate with the same strict extractor the renderer trusts elsewhere. A single
    // clean token yields exactly one item; anything else (garbage/oversized) is treated as plain text.
    let parsed: BodySegment | null = null;
    if (tok.startsWith('[[pic:')) {
      const pics = extractInlinePictures(tok);
      if (pics.length === 1) parsed = {type: 'pic', pic: pics[0]!};
    } else {
      const voices = extractInlineVoices(tok);
      if (voices.length === 1) parsed = {type: 'voice', voice: voices[0]!};
    }
    if (!parsed) continue; // leave the malformed token inside the next text run (don't advance `last`)
    if (at > last) segments.push({type: 'text', value: body.slice(last, at)});
    segments.push(parsed);
    last = at + tok.length;
  }
  if (last < body.length) segments.push({type: 'text', value: body.slice(last)});
  return segments;
}

/**
 * Collapse a body into a one-line preview: prose if any, else a media label ("🎙️ Voice message" /
 * "🖼️ Picture"), else the label of the embed it carries ("📅 Event"), else ''. Replaces per-modality
 * summaries so a message that is media- or embed-only never leaks its base64 into a quote/preview.
 *
 * The prose is reduced through {@link stripBlockMarkdown} first. Bodies are RICH everywhere now —
 * the same dialect the feed uses — and this feeds the DM inbox row, notification excerpts, quoted
 * replies and collapsed broadcast previews, none of which render markdown. Without the reduction a
 * message containing a table or a collapsible block previewed as `| a | b | ::: spoiler ## Heading`.
 * The strip runs BEFORE the whitespace collapse because its rules are line-anchored (`^`), and a
 * body whose every line is markup can reduce to nothing — hence re-testing for emptiness after it,
 * so such a body still falls through to a media/embed label rather than previewing blank.
 */
export function inlineMediaSummary(text: string): string {
  const stripped = stripBlockMarkdown(bodyForMeasure(text)).replace(/\s+/g, ' ').trim();
  if (stripped) return stripped;
  if (hasInlineVoice(text)) return '🎙️ Voice message';
  if (hasInlinePicture(text)) return '🖼️ Picture';
  return firstEmbedLabel(text);
}
