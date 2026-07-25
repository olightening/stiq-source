import {hasBlockMarkdown, stripBlockMarkdown} from './plainText';
import {inlineMediaSummary} from './inlineMedia';

/**
 * The reduction every non-rendering excerpt surface shares. Bodies are RICH on every surface now, so
 * a DM inbox row / notification / quoted reply that shows raw `| a | b |` or `:::` is a leak, not a
 * cosmetic nit — those surfaces have no renderer and never will.
 */
describe('stripBlockMarkdown', () => {
  it('flattens a table into its cells, dropping the separator row', () => {
    expect(stripBlockMarkdown('| site | url |\n|---|---|\n| Ex | here |')).toBe('site · url\nEx · here');
  });

  it('turns a details block into its summary, and drops a bare closer', () => {
    expect(stripBlockMarkdown(':::Spoiler\nhidden\n:::')).toBe('▸ Spoiler\nhidden');
  });

  it('drops pullquote and footer markers before the quote/bullet rules can eat them', () => {
    // The ordering trap: `>` would swallow the first char of `>>`, and `-` the first of `-#`.
    expect(stripBlockMarkdown('>> a pullquote')).toBe('a pullquote');
    expect(stripBlockMarkdown('-# small print')).toBe('small print');
  });

  it('maps task markers to boxes rather than leaving them as bullets', () => {
    expect(stripBlockMarkdown('- [x] done\n- [ ] todo')).toBe('☑ done\n☐ todo');
  });

  it('strips headings, quotes, bullets and inline marks', () => {
    expect(stripBlockMarkdown('## Title')).toBe('Title');
    expect(stripBlockMarkdown('> quoted')).toBe('quoted');
    expect(stripBlockMarkdown('- one\n* two')).toBe('• one\n• two');
    expect(stripBlockMarkdown('**bold** and _it_ and `code`')).toBe('bold and it and code');
  });

  it('keeps a markdown link label and drops its target', () => {
    expect(stripBlockMarkdown('read the [Docs](https://example.com) now')).toBe('read the Docs now');
  });

  it('leaves ordinary prose untouched', () => {
    expect(stripBlockMarkdown('just a normal sentence')).toBe('just a normal sentence');
  });

  it('is safe on a body that is nothing but markup', () => {
    expect(stripBlockMarkdown('|---|---|')).toBe('');
  });
});

describe('inlineMediaSummary — rich bodies preview as prose', () => {
  it('previews a table-bearing message without leaking pipe syntax', () => {
    const preview = inlineMediaSummary('here you go\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(preview).not.toContain('|');
    expect(preview).toContain('here you go');
    expect(preview).toContain('a · b');
  });

  it('previews a collapsible block by its summary, not its ":::" fence', () => {
    expect(inlineMediaSummary(':::The twist\nit was him\n:::')).not.toContain(':::');
  });

  it('still falls through to the media label when the prose reduces to nothing', () => {
    // Regression guard for running the strip BEFORE the emptiness test: a caption of pure markup
    // reduces to '', and the preview must then fall through to the media label rather than go blank.
    expect(inlineMediaSummary('[[voice:audio/mp4;3;AAAA]]')).toBe('🎙️ Voice message');
    expect(inlineMediaSummary('|---|---|\n[[pic:2;2;AAAA]]')).toBe('🖼️ Picture');
  });

  it('leaves a plain message exactly as it was', () => {
    expect(inlineMediaSummary('see you at six')).toBe('see you at six');
  });
});

/**
 * Powers the composer bubble's "Formatted draft" affordance: a body written in the expanded editor
 * comes back to the compact input as raw markdown, and this is what decides whether to offer the way
 * back to the editor that can actually render it.
 */
describe('hasBlockMarkdown', () => {
  it.each([
    ['a table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['a collapsible block', ':::Spoiler\nhidden\n:::'],
    ['a heading', '## Title'],
    ['a quote', '> quoted'],
    ['a pullquote', '>> emphasised'],
    ['a footer', '-# small print'],
    ['a task list', '- [ ] todo'],
    ['a bullet list', '- one\n- two'],
    ['a numbered list', '1. first'],
    ['a divider', 'before\n---\nafter'],
    ['a block after ordinary prose', 'here you go\n\n| a | b |\n|---|---|'],
  ])('detects %s', (_label, body) => {
    expect(hasBlockMarkdown(body)).toBe(true);
  });

  it.each([
    ['plain prose', 'see you at six'],
    ['an empty draft', ''],
    ['inline marks only', 'that is **important** and _urgent_'],
    ['a bare link', 'https://example.com'],
    ['a markdown link', 'read the [Docs](https://example.com)'],
    ['an em dash mid-sentence', 'it was fine - mostly'],
    ['a snowman', '☃'],
  ])('does not flag %s', (_label, body) => {
    expect(hasBlockMarkdown(body)).toBe(false);
  });

  it('agrees with stripBlockMarkdown: anything it flags actually reduces', () => {
    // If a construct is flagged, the reduction must have something to do — otherwise the chip would
    // appear for a body that renders identically either way.
    const body = '## Title\n\n- one\n- two';
    expect(hasBlockMarkdown(body)).toBe(true);
    expect(stripBlockMarkdown(body)).not.toBe(body);
  });
});
