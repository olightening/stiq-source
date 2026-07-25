import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, ScrollView, StyleSheet} from 'react-native';
import {RichText, groupBlocks, parseRichText, previewCompactLines, tableColumnWidths} from './RichText';
import * as displayName from '../../profile/displayName';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';

/** Render a RichText body and return its JSON tree as a searchable string. */
function renderBody(content: string, props: Partial<React.ComponentProps<typeof RichText>> = {}): string {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<RichText content={content} {...props} />);
  });
  return JSON.stringify(
    tree!.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

describe('groupBlocks classification', () => {
  it('coalesces consecutive bullet lines into one ul block', () => {
    const blocks = groupBlocks(['- one', '- two', '* three']);
    expect(blocks).toEqual([{kind: 'ul', items: ['one', 'two', 'three']}]);
  });

  it('coalesces consecutive numbered lines into one ol block', () => {
    const blocks = groupBlocks(['1. first', '2. second']);
    expect(blocks).toEqual([{kind: 'ol', items: ['first', 'second']}]);
  });

  it('coalesces consecutive quote lines into one quote block', () => {
    const blocks = groupBlocks(['> a', '> b']);
    expect(blocks).toEqual([{kind: 'quote', lines: ['a', 'b']}]);
  });

  it('treats --- and *** as a divider', () => {
    expect(groupBlocks(['---'])).toEqual([{kind: 'hr'}]);
    expect(groupBlocks(['***'])).toEqual([{kind: 'hr'}]);
  });

  it('keeps plain text (and headings) as flowing text blocks, splitting around blocks', () => {
    const blocks = groupBlocks(['intro', '- item', 'outro']);
    expect(blocks).toEqual([
      {kind: 'text', lines: ['intro']},
      {kind: 'ul', items: ['item']},
      {kind: 'text', lines: ['outro']},
    ]);
  });
});

describe('RichText block rendering', () => {
  it('renders a bullet list with the bullet glyph and item text', () => {
    const text = renderBody('- apples\n- bananas');
    expect(text).toContain('•');
    expect(text).toContain('apples');
    expect(text).toContain('bananas');
  });

  it('renders a numbered list with sequential numbers', () => {
    const text = renderBody('1. first\n1. second');
    // Editor may emit "1." for every item; renderer numbers them sequentially.
    expect(text).toContain('1. ');
    expect(text).toContain('2. ');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('renders a blockquote with the quoted text', () => {
    const text = renderBody('> a wise quote');
    expect(text).toContain('a wise quote');
  });

  it('renders a divider for ---', () => {
    const before = renderBody('above text\nbelow text');
    const withHr = renderBody('above text\n\n---\n\nbelow text');
    // The hr block is a View with the hairline rule background; assert the divider colour appears.
    expect(withHr).toContain('above text');
    expect(withHr).toContain('below text');
    // The plain version has no hairline divider element.
    expect(withHr.length).toBeGreaterThan(before.length);
  });

  it('renders inline marks inside list items (bold)', () => {
    const text = renderBody('- this is **strong**');
    expect(text).toContain('strong');
    expect(text).toContain('700'); // bold fontWeight
  });
});

describe('parseRichText (pure parse)', () => {
  it('strips the identity header, pulls out embeds/images, and keeps the visible text', () => {
    const parsed = parseRichText('hello world ![alt](https://x.test/a.png)');
    expect(parsed.text).toBe('hello world');
    expect(parsed.hasText).toBe(true);
    expect(parsed.imageList.map(m => m.url)).toEqual(['https://x.test/a.png']);
  });

  it('merges NIP-94 imeta with bare image URLs, de-duplicating', () => {
    const parsed = parseRichText('see https://x.test/b.jpg', [{url: 'https://x.test/b.jpg'}]);
    expect(parsed.imageList.map(m => m.url)).toEqual(['https://x.test/b.jpg']);
  });
});

describe('RichText memoization', () => {
  it('parses a body ONCE and does not re-parse when an unrelated prop changes (same content)', () => {
    // decodeNameHeader is the first step of the (memoized) parse pipeline. Spying on it counts
    // parses: with the useMemo keyed on content, an unrelated re-render must not re-invoke it.
    const spy = jest.spyOn(displayName, 'decodeNameHeader');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<RichText content="stable body text" numberOfLines={2} />);
    });
    const afterMount = spy.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    // Re-render with the SAME content but a changed unrelated prop — must reuse the memoized parse.
    act(() => {
      tree!.update(<RichText content="stable body text" numberOfLines={4} />);
    });
    expect(spy.mock.calls.length).toBe(afterMount);

    // A genuinely different content string DOES re-parse (memo is prop-driven, not a global cache).
    act(() => {
      tree!.update(<RichText content="a different body" numberOfLines={4} />);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(afterMount);
    spy.mockRestore();
  });
});

describe('RichText regression — existing behavior preserved', () => {
  it('renders a plain paragraph', () => {
    const text = renderBody('just a normal paragraph of text');
    expect(text).toContain('just a normal paragraph of text');
  });

  it('renders a bold span', () => {
    const text = renderBody('hello **world**');
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(text).toContain('700'); // bold weight token
  });

  it('renders a heading', () => {
    const text = renderBody('## Big Heading');
    expect(text).toContain('Big Heading');
  });

  it('still renders inline voice clips as a player block (not raw token)', () => {
    // Minimal inline voice token: mime;duration;base64 (no waveform).
    const token = '[[voice:audio/mp4;3;AAAA]]';
    const text = renderBody(`listen up ${token}`);
    expect(text).toContain('listen up');
    // The raw token must not leak into the rendered text.
    expect(text).not.toContain('[[voice:');
  });
});

describe('RichText inline media positioning (Goal 2)', () => {
  const PIC = '[[pic:2;2;AAAA]]';

  it('FULL view: a picture renders WHERE it sits in the text (between the two runs)', () => {
    // No flow / numberOfLines → full view. The chip must appear between "before" and "after".
    const out = renderBody(`before ${PIC} after`);
    const iBefore = out.indexOf('before');
    const iChip = out.indexOf('tap to load'); // idle PictureChip label
    const iAfter = out.indexOf('after');
    expect(iBefore).toBeGreaterThanOrEqual(0);
    expect(iChip).toBeGreaterThan(iBefore);
    expect(iAfter).toBeGreaterThan(iChip);
    expect(out).not.toContain('[[pic:'); // raw token never leaks
  });

  it('FULL view: a LEADING picture renders ABOVE the text', () => {
    const out = renderBody(`${PIC}the caption`);
    expect(out.indexOf('tap to load')).toBeLessThan(out.indexOf('the caption'));
  });

  it('PREVIEW (feed card): a LEADING picture collects at the BOTTOM, under the teaser', () => {
    // flow + numberOfLines → teaser. Even though the picture is first in the body, its chip renders
    // AFTER the text (at the bottom of the card).
    const out = renderBody(`${PIC}the caption`, {flow: true, numberOfLines: 3});
    expect(out.indexOf('the caption')).toBeLessThan(out.indexOf('tap to load'));
    expect(out).not.toContain('[[pic:');
  });
});

describe('RichText stiq:space embed detection (chunk 2)', () => {
  const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd', name: 'My Channel', private: false});

  it('extracts a stiq:space token out of a mixed body and renders the carried name as a card', () => {
    const out = renderBody(`check out ${token} it is great`);
    expect(out).toContain('check out');
    expect(out).toContain('it is great');
    expect(out).toContain('My Channel');
    // The raw token never leaks into the rendered text.
    expect(out).not.toContain('stiq:space:');
  });

  it('calls onOpenNostrPost with the FULL raw token (not a decoded coordinate) on tap', () => {
    const onOpenNostrPost = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<RichText content={`hello ${token}`} onOpenNostrPost={onOpenNostrPost} />);
    });
    const pressables = tree!.root.findAllByType(Pressable);
    // Fire every top-level Pressable found in the card (the embed card itself); at least one call
    // must carry the exact raw token string.
    pressables.forEach(p => { if (typeof p.props.onPress === 'function') p.props.onPress(); });
    expect(onOpenNostrPost).toHaveBeenCalledWith(token);
  });

  it('renders nothing (no crash) for a garbage stiq:space-looking token', () => {
    // Well-formed prefix + charset but not valid base64url JSON underneath — parseSpaceEmbed must
    // return null and the renderer must degrade gracefully rather than throwing.
    const garbage = 'stiq:space:not-real-payload-zzz';
    expect(() => renderBody(`before ${garbage} after`)).not.toThrow();
    const out = renderBody(`before ${garbage} after`);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('stiq:space:');
  });
});

describe('New dialect blocks — pullquote / footer / task / details / table', () => {
  describe('groupBlocks classification', () => {
    it('coalesces consecutive ">> " lines into one pull block', () => {
      const blocks = groupBlocks(['>> a', '>> b']);
      expect(blocks).toEqual([{kind: 'pull', lines: ['a', 'b']}]);
    });

    it('checks ">> " BEFORE "> " — a pull line never falls into the quote branch', () => {
      // QUOTE's own `>\s?` would happily eat the first ">" of ">> a" and mis-read it as "> > a".
      const blocks = groupBlocks(['>> a']);
      expect(blocks).toEqual([{kind: 'pull', lines: ['a']}]);
    });

    it('accepts a bare ">>" with no trailing space', () => {
      const blocks = groupBlocks(['>>']);
      expect(blocks).toEqual([{kind: 'pull', lines: ['']}]);
    });

    it('coalesces consecutive "-# " lines into one footer block', () => {
      const blocks = groupBlocks(['-# a', '-# b']);
      expect(blocks).toEqual([{kind: 'footer', lines: ['a', 'b']}]);
    });

    it('coalesces "- [ ]"/"- [x]" lines into one task block with correct checked flags', () => {
      const blocks = groupBlocks(['- [ ] a', '- [x] b']);
      expect(blocks).toEqual([
        {kind: 'task', items: [{checked: false, text: 'a'}, {checked: true, text: 'b'}]},
      ]);
    });

    it('accepts a capital X as checked', () => {
      const blocks = groupBlocks(['- [X] done']);
      expect(blocks).toEqual([{kind: 'task', items: [{checked: true, text: 'done'}]}]);
    });

    it('checks task BEFORE the generic bullet rule — "- [ ] a" is a task, not a "[ ] a" bullet', () => {
      const blocks = groupBlocks(['- [ ] a']);
      expect(blocks).toEqual([{kind: 'task', items: [{checked: false, text: 'a'}]}]);
    });

    it('groups a ":::" opener/body/closer run into a details block', () => {
      const blocks = groupBlocks([':::summary', 'body line 1', 'body line 2', ':::']);
      expect(blocks).toEqual([
        {kind: 'details', summary: 'summary', body: ['body line 1', 'body line 2']},
      ]);
    });

    it('a ":::" opener with NO closer anywhere ahead stays plain text', () => {
      const blocks = groupBlocks([':::summary with no closer', 'more text']);
      expect(blocks).toEqual([{kind: 'text', lines: [':::summary with no closer', 'more text']}]);
    });

    it('parses a table: header + separator + rows, "\\|" unescapes, short rows pad', () => {
      const blocks = groupBlocks([
        '|a|b|c|',
        '|---|---|---|',
        '|1|2|3|',
        '|x\\|y|z|', // an escaped pipe inside a cell
        '|only one|', // short row → padded with ''
      ]);
      expect(blocks).toEqual([
        {
          kind: 'table',
          header: ['a', 'b', 'c'],
          rows: [
            ['1', '2', '3'],
            ['x|y', 'z', ''],
            ['only one', '', ''],
          ],
        },
      ]);
    });

    it('a long row (more cells than the header) grows the header instead of truncating the row', () => {
      // Bug: padTableRow used to silently DROP a body row's extra cells beyond the header's column
      // count. It must now pad the HEADER (and every other row) out to the widest row instead, so no
      // cell the user typed is ever discarded.
      const blocks = groupBlocks([
        '|a|b|c|',
        '|---|---|---|',
        '|1|2|3|4|', // long row → header grows to 4 columns, not truncated to 3
      ]);
      expect(blocks).toEqual([
        {
          kind: 'table',
          header: ['a', 'b', 'c', ''],
          rows: [['1', '2', '3', '4']],
        },
      ]);
    });

    it('a pipe line whose next line is NOT a separator stays plain text', () => {
      const blocks = groupBlocks(['|a|b|', 'not a separator']);
      expect(blocks).toEqual([{kind: 'text', lines: ['|a|b|', 'not a separator']}]);
    });
  });

  describe('RichText full-mode rendering', () => {
    it('renders a task list, showing ✓ only for the checked item', () => {
      const text = renderBody('- [ ] todo\n- [x] done');
      expect(text).toContain('todo');
      expect(text).toContain('done');
      expect(text).toContain('✓');
    });

    it('renders pullquote and footer text as visible content', () => {
      const text = renderBody('>> a striking pull quote\n\nregular text\n\n-# small print footer');
      expect(text).toContain('a striking pull quote');
      expect(text).toContain('regular text');
      expect(text).toContain('small print footer');
    });

    it('renders a table with its header and cell text', () => {
      const text = renderBody('| Name | Age |\n|---|---|\n| Ada | 30 |');
      expect(text).toContain('Name');
      expect(text).toContain('Age');
      expect(text).toContain('Ada');
      expect(text).toContain('30');
    });

    describe('table column alignment (Bug: header/body cells sized independently, columns drifted)', () => {
      // Every rendered table cell (header or body) carries this exact padding — used below to find
      // the cell Views in the tree and read their declared width off StyleSheet.flatten. Restricted
      // to type === 'View' (the host instance) because findAll also walks the composite `View`
      // wrapper carrying the identical style prop, which would otherwise double-count every cell.
      function cellWidths(content: string): number[] {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<RichText content={content} />); });
        return tree!.root
          .findAll(n => {
            if ((n.type as unknown as string) !== 'View') return false;
            const flat = StyleSheet.flatten(n.props?.style) as Record<string, unknown> | undefined;
            return !!flat && flat.paddingVertical === 9 && flat.paddingHorizontal === 12;
          })
          .map(n => (StyleSheet.flatten(n.props.style) as {width: number}).width);
      }

      it('gives every row’s cell N the SAME width, even when a body cell is much longer than the header', () => {
        const widths = cellWidths('| A | B |\n|---|---|\n| Population 3,200,000 | X |');
        // 2 header cells + 2 body cells.
        expect(widths).toHaveLength(4);
        const [headA, headB, bodyA, bodyB] = widths;
        expect(headA).toBe(bodyA); // column 0: 'A' (header) vs the long cell (body) — same width
        expect(headB).toBe(bodyB); // column 1: 'B' (header) vs 'X' (body) — same width
        // The long cell actually widened its column past the bare floor.
        expect(headA).toBeGreaterThan(104);
      });

      it('matches tableColumnWidths, the pure per-column model, directly — deterministic + test-assertable, no onLayout wait', () => {
        const widths = tableColumnWidths(['A', 'B'], [['Population 3,200,000', 'X']]);
        expect(widths).toHaveLength(2);
        expect(widths[0]).toBeGreaterThan(widths[1]!); // the long cell's column is wider than 'X''s
      });

      it('caps a column width so one huge cell cannot blow out the whole table — long words wrap, not clip', () => {
        const huge = 'a'.repeat(500);
        const widths = tableColumnWidths(['A'], [[huge]]);
        expect(widths[0]).toBeLessThanOrEqual(220);
      });

      it('every table cell View carries a maxWidth (so overflow text wraps instead of clipping mid-word)', () => {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<RichText content={'| A |\n|---|\n| ' + 'a'.repeat(500) + ' |'} />); });
        const cells = tree!.root.findAll(n => {
          if ((n.type as unknown as string) !== 'View') return false;
          const flat = StyleSheet.flatten(n.props?.style) as Record<string, unknown> | undefined;
          return !!flat && flat.paddingVertical === 9 && flat.paddingHorizontal === 12;
        });
        expect(cells.length).toBeGreaterThan(0);
        for (const c of cells) {
          const flat = StyleSheet.flatten(c.props.style) as {maxWidth?: number};
          expect(typeof flat.maxWidth).toBe('number');
        }
      });

      it('the horizontal scroll affordance is visible (was showsHorizontalScrollIndicator={false})', () => {
        let tree: renderer.ReactTestRenderer | undefined;
        act(() => { tree = renderer.create(<RichText content={'| A | B |\n|---|---|\n| 1 | 2 |'} />); });
        const scroller = tree!.root.findByType(ScrollView);
        expect(scroller.props.showsHorizontalScrollIndicator).toBe(true);
      });
    });

    it('details renders the summary but NOT the body text until the header is pressed (starts collapsed)', () => {
      let tree: renderer.ReactTestRenderer | undefined;
      act(() => {
        tree = renderer.create(<RichText content={':::Read more\nhidden body text\n:::'} />);
      });
      const before = JSON.stringify(tree!.toJSON());
      expect(before).toContain('Read more');
      expect(before).not.toContain('hidden body text');

      // Same harness the embed-card tests above use: find every Pressable and fire it (there's no
      // testing-library fireEvent in this file's harness — react-test-renderer + direct onPress calls).
      const pressables = tree!.root.findAllByType(Pressable);
      act(() => {
        pressables.forEach(p => { if (typeof p.props.onPress === 'function') p.props.onPress(); });
      });
      const after = JSON.stringify(tree!.toJSON());
      expect(after).toContain('Read more');
      expect(after).toContain('hidden body text');
    });

    it('a details block with an empty summary falls back to "Details"', () => {
      const text = renderBody(':::\nsome body\n:::');
      expect(text).toContain('Details');
    });
  });

  describe('previewCompactLines (preview/teaser line transform)', () => {
    it('maps checked/unchecked task markers to ☑/☐', () => {
      expect(previewCompactLines('- [x] done\n- [ ] todo')).toBe('☑ done\n☐ todo');
    });

    it('drops the ">> " pullquote marker, keeping the content', () => {
      expect(previewCompactLines('>> a quote')).toBe('a quote');
    });

    it('drops the "-# " footer marker, keeping the content', () => {
      expect(previewCompactLines('-# small print')).toBe('small print');
    });

    it('maps a ":::" opener to "▸ summary" and drops a bare ":::" line entirely', () => {
      expect(previewCompactLines(':::Read more\nbody\n:::')).toBe('▸ Read more\nbody');
    });

    it('collapses a WHOLE table run (header + separator + every row) into one "▦ Table" line', () => {
      const input = 'before\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\nafter';
      expect(previewCompactLines(input)).toBe('before\n▦ Table\nafter');
    });

    it('leaves a pipe line with no separator underneath untouched', () => {
      expect(previewCompactLines('|a|b|\nnot a separator')).toBe('|a|b|\nnot a separator');
    });
  });
});

describe('reader-copy text selection (selectable)', () => {
  // A body being READ (post detail, comment, chat bubble, channel message) renders in full mode, so
  // its prose is `selectable` — long-press starts a selection and the system Copy / Select-all bar
  // appears. A clamped/flowed feed teaser is NOT, because its tap opens the post.
  it('a FULL body is selectable by default (long-press → Copy / Select-all)', () => {
    expect(renderBody('a paragraph worth copying')).toContain('"selectable":true');
  });

  it('block constructs (list / quote / table) are selectable too', () => {
    expect(renderBody('- one\n- two')).toContain('"selectable":true');
    expect(renderBody('> a quoted line')).toContain('"selectable":true');
    expect(renderBody('| A | B |\n|---|---|\n| 1 | 2 |')).toContain('"selectable":true');
  });

  it('a clamped/flowed feed teaser is NOT selectable (its tap opens the post)', () => {
    expect(renderBody('a teaser body', {flow: true, numberOfLines: 3})).not.toContain('"selectable":true');
  });

  it('selection can be forced OFF on a full body via the prop', () => {
    expect(renderBody('a paragraph', {selectable: false})).not.toContain('"selectable":true');
  });

  it('selection can be forced ON for a teaser via the prop', () => {
    expect(renderBody('a teaser body', {flow: true, numberOfLines: 3, selectable: true})).toContain('"selectable":true');
  });
});

/**
 * `tone="onAccent"` — a body painted on the ACCENT fill (your own chat bubble).
 *
 * The bug this exists for: `style` recolours only the PROSE. Every block construct — heading, quote
 * bar, pullquote rule, footer, checkbox, details card, table border/header — carries its own
 * hardcoded feed colour, so a rich message you SENT rendered dark-grey ink on the accent fill.
 * Now that every surface has the full editor, that stopped being a corner case.
 */
describe('tone="onAccent" repaints the block chrome for an accent surface', () => {
  // One body carrying every construct whose chrome is colour-bearing.
  const EVERY_BLOCK = [
    '## A heading',
    '',
    '> a quoted line',
    '',
    '>> a pullquote',
    '',
    '- [x] done',
    '- [ ] todo',
    '',
    ':::Spoiler',
    'hidden prose',
    ':::',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '---',
    '',
    '-# small print',
  ].join('\n');

  // The feed inks that must never SURVIVE onto an accent fill: textPrimary, textSecondary,
  // textMuted, and the surface/border greys used for card fills and rules.
  const FEED_INKS = ['#f5f5f7', '#98989e', '#7c7c82', '#3a3a3c', '#2c2c2e', '#161618'];

  /**
   * Every colour this body actually PAINTS with. A tone override is applied as `[base, override]`,
   * so the base object is still in the tree and a plain substring search on the serialized JSON
   * would find it and prove nothing — only `StyleSheet.flatten` reports what the user sees.
   */
  function paintedColors(content: string, props: Partial<React.ComponentProps<typeof RichText>> = {}): Set<string> {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(<RichText content={content} {...props} />); });
    const COLOR_KEYS = [
      'color', 'backgroundColor', 'borderColor',
      'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    ] as const;
    const out = new Set<string>();
    for (const node of tree!.root.findAll(() => true, {deep: true})) {
      const flat = StyleSheet.flatten(node.props?.style) as Record<string, unknown> | undefined;
      if (!flat) continue;
      for (const k of COLOR_KEYS) {
        const v = flat[k];
        if (typeof v === 'string') out.add(v);
      }
    }
    return out;
  }

  it('paints the default tone with the feed palette', () => {
    const painted = paintedColors(EVERY_BLOCK);
    expect(painted.has('#4f8eec')).toBe(true); // quote bar / checked box = accent
    expect(FEED_INKS.some(c => painted.has(c))).toBe(true);
  });

  it('paints no feed ink at all under onAccent', () => {
    const painted = paintedColors(EVERY_BLOCK, {tone: 'onAccent'});
    // This is the whole bug in one assertion: not one dark-on-accent colour survives.
    expect([...painted].filter(c => FEED_INKS.includes(c))).toEqual([]);
  });

  it('uses onAccent ink and translucent-white rules instead', () => {
    const painted = paintedColors(EVERY_BLOCK, {tone: 'onAccent'});
    expect(painted.has('#ffffff')).toBe(true); // headings / pullquote / table body / details
    expect(painted.has('rgba(255,255,255,0.28)')).toBe(true); // quote bar, rules, borders
    expect(painted.has('rgba(255,255,255,0.12)')).toBe(true); // details card + table header fill
  });

  it('inverts the checked task box (solid onAccent box, accent tick)', () => {
    const painted = paintedColors('- [x] done', {tone: 'onAccent'});
    // Default tone is the reverse — accent fill, white tick. On an accent surface that would be an
    // accent box on an accent background: a checkbox you cannot see.
    expect(painted.has('#4f8eec')).toBe(true); // the TICK is now the accent
    expect(painted.has('#ffffff')).toBe(true); // the BOX is now solid onAccent
  });

  it('does not disturb the default tone when the prop is absent or explicit', () => {
    expect(renderBody(EVERY_BLOCK)).toBe(renderBody(EVERY_BLOCK, {tone: 'default'}));
  });
});
