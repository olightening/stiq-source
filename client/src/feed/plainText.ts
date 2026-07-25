/**
 * plainText — reduce the app's markdown dialect to readable prose.
 *
 * Every surface that shows a body WITHOUT rendering it needs this: the DM inbox row, a notification's
 * two-line excerpt, a collapsed broadcast preview, a quoted reply, a saved-embed snippet, and the
 * composer's own Details-step recap. They all used to differ — some stripped nothing, some stripped a
 * little — which is why a rich body leaked `| a | b |`, `:::`, `-#` and `## ` into places that are
 * supposed to read as a sentence.
 *
 * This is the single reduction they share. It is deliberately NOT the same thing as
 * `RichText.previewCompactLines`: that one keeps a teaser's LINE structure (it feeds a real renderer
 * that still draws inline marks), whereas this flattens all the way down to plain characters for a
 * one- or two-line excerpt. Keeping both is the point — they answer different questions.
 *
 * Pure and dependency-free, so it can be imported from data modules (`inlineMedia.ts`, conversation
 * builders) as well as components, with no cycle risk.
 */

/**
 * Strip block + inline markdown syntax, leaving the words.
 *
 * The order below is load-bearing in three places:
 *  - the table SEPARATOR row (`|---|---|`) is dropped BEFORE the generic table-row rule, or it would
 *    survive as `--- · ---`;
 *  - `>>` (pullquote) and `-#` (footer) are stripped BEFORE `>` (quote) and `-` (bullet), whose
 *    patterns would otherwise eat their first character and leave a stray marker;
 *  - task markers (`- [x]`) go before the bullet rule for the same reason.
 *
 * Media and embed TOKENS are not handled here — a caller that has them either labels them first
 * (the composer's `previewText`) or strips them first (`inlineMediaSummary`), because the two want
 * different answers for the same token.
 */
/**
 * Whether a body carries any BLOCK construct — the things that need the real editor to write and a
 * renderer to read, and that look like debris in a one-line chat input: a table, a collapsible
 * `:::` block, a heading, a quote, a pullquote, a footer, a task item, a list, or a divider.
 *
 * Inline marks (`**bold**`, `_italic_`, a link) are deliberately NOT block constructs. They read
 * perfectly well as plain text in a compact composer, and flagging them would light up on almost
 * every message that happens to contain an underscore.
 */
export function hasBlockMarkdown(md: string): boolean {
  return BLOCK_LINE.test(md);
}

// One line-anchored alternation over the block openers. `m` so `^` means "start of any line".
const BLOCK_LINE =
  /^(?:\|.*\||:::|#{1,3}\s|>{1,2}\s?|-#\s|-\s+\[[ xX]\]\s|[-*]\s+|\d+\.\s+|(?:---|\*\*\*)\s*$)/m;

export function stripBlockMarkdown(md: string): string {
  return md
    .replace(/^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/gm, '') // table separator row → nothing
    .replace(/^\|(.*)\|\s*$/gm, (_m, inner: string) => inner.replace(/\s*\|\s*/g, ' · ').trim())
    .replace(/^:::\s?(.*)$/gm, (_m, sum: string) => (sum.trim() ? `▸ ${sum.trim()}` : ''))
    .replace(/^>>\s?/gm, '')
    .replace(/^-#\s?/gm, '')
    .replace(/^-\s+\[[xX]\]\s?/gm, '☑ ')
    .replace(/^-\s+\[ \]\s?/gm, '☐ ')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [label](url) → label
    .replace(/\n{2,}/g, '\n')
    .trim();
}
