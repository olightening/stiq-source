import {richEditorHtml, type RichEditorTheme} from './richEditorHtml';

const THEME: RichEditorTheme = {
  bg: '#111111',
  surface: '#1c1c1e',
  text: '#f5f5f7',
  muted: '#6c6c70',
  accent: '#4f8eec',
  border: '#2c2c2e',
  code: '#9ec6ff',
  surfaceAlt: '#161618',
  accentSoft: 'rgba(79,142,236,0.18)',
  link: '#9ec6ff',
  onAccent: '#ffffff',
  textSecondary: '#98989e',
  padX: 14,
  padY: 12,
};

describe('richEditorHtml', () => {
  const html = richEditorHtml(THEME);

  it('is a single compact icon row: clipboard · B I U link · Clear · Aa style (folded blocks, v2)', () => {
    // Inline marks + link + Clear.
    expect(html).toContain('data-cmd="bold"');
    expect(html).toContain('data-cmd="italic"');
    expect(html).toContain('data-cmd="underline"');
    expect(html).toContain('data-cmd="link"');
    expect(html).toContain('data-cmd="clear"');
    // v2: the block styles are FOLDED behind the Aa style button (label + chevron → the RN block
    // sheet). No standalone H2/H3/quote buttons in the bubble any more.
    expect(html).toContain('data-cmd="style"');
    expect(html).toContain('id="styLabel"');
    expect(html).not.toContain('data-block="h2"');
    expect(html).not.toContain('data-block="h3"');
    expect(html).not.toContain('data-block="quote"');
    // The pre-rework two-row / Body▾ scaffolding stays gone.
    expect(html).not.toContain('id="styleBtn"');
    expect(html).not.toContain('id="clipRow"');
    expect(html).not.toContain('id="fmtRow"');
    expect(html).not.toContain('id="blockRow"');
    // Strikethrough stays absent (the dialect has no ~~); the editor never emits a PRE code block.
    expect(html).not.toContain('data-cmd="strike"');
    expect(html).not.toContain('&lt;pre&gt;');
  });

  it('v2 rich blocks: page carries the block vocabulary, sheet bridge, and undo/redo commands', () => {
    // The serializer + parser speak the v2 line syntax (pull '>>', footer '-#', task '- [ ]',
    // details ':::' fences, GFM pipe tables) via these page functions.
    expect(html).toContain('function detailsToMd');
    expect(html).toContain('function tableToMd');
    expect(html).toContain('function splitTableRow');
    expect(html).toContain('function tableRowsToHtml');
    expect(html).toContain('function toggleDetailsBlock');
    expect(html).toContain('function setListBlock');
    expect(html).toContain('function insertTable');
    expect(html).toContain('function escapeIsland');
    // Block classes (shared vocabulary with RichText.tsx renders).
    expect(html).toContain('np-task');
    expect(html).toContain('np-details');
    expect(html).toContain('np-tablewrap');
    expect(html).toContain('np-footer');
    expect(html).toContain('blockquote.pull');
    // The bubble's Aa button asks RN to open the native block sheet; the page reports the caret's
    // block back as a 'state' message so the sheet can mark the current row.
    expect(html).toContain("post({ type: 'blockSheet' })");
    expect(html).toContain("post({ type: 'state', block: b })");
    // Undo/redo ride the dock's history group as host commands.
    expect(html).toContain("case 'undo':");
    expect(html).toContain("case 'redo':");
  });

  it('labels the inline picture chip with the framed-image emoji, not the retired ▦ glyph', () => {
    // chipLabel() emits 🖼️ (U+1F5BC) for [[pic:…]] tokens, matching the framed-image icon used
    // app-wide, and no longer the ▦ crosshatch (U+25A6).
    expect(html).toContain('\\uDDBC'); // low surrogate of 🖼️ (U+1F5BC)
    expect(html).not.toContain('\\u25A6'); // the retired ▦ crosshatch
  });

  it('the bubble FLOATS over the selection (fixed, JS-positioned) instead of pinning to the top', () => {
    // position:fixed + inline left/top set by positionBubble() = a bubble that tracks the selection.
    expect(html.replace(/\s+/g, ' ')).toContain('#bar { display: none; position: fixed;');
    expect(html).toContain('function positionBubble');
    expect(html).toContain('.sel { display: flex; }');
    // Toggle-aware block styling: tapping the current block reverts to Body (a real toggle).
    expect(html).toContain('function applyBlock');
    // Repositions as the editor scrolls so it stays glued to the selected text.
    expect(html).toContain("ed.addEventListener('scroll'");
  });

  it('keeps the selection + bubble alive across a bubble-button tap (capture/restore the range)', () => {
    // The range is snapshotted when a bubble press begins (touchstart, before the WebView can
    // collapse it) and restored before the command runs, so tapping B/I/U/H2/… never drops the text.
    expect(html).toContain('function captureHeld');
    expect(html).toContain('function restoreHeld');
    expect(html).toContain("bar.addEventListener('touchstart'");
    expect(html).toContain('restoreHeld();'); // called at the top of runCommand + applyBlock
  });

  it('carries the clipboard trio as icons and routes I/O through RN (Copy/Cut/Paste)', () => {
    expect(html).toContain('data-cmd="copy"');
    expect(html).toContain('data-cmd="cut"');
    expect(html).toContain('data-cmd="paste"');
    // Select-all was dropped from the compact bubble (not in the spec).
    expect(html).not.toContain('data-cmd="selectAll"');
    // Clipboard I/O is routed to RN (page posts a 'clip' message; RN answers paste via 'insertText').
    expect(html).toContain("type: 'clip'");
    expect(html).toContain("case 'insertText':");
  });

  it('editor padding is themeable so the composer body can align to the title gutter (no box)', () => {
    expect(richEditorHtml({...THEME, padX: 0}).replace(/\s+/g, ' ')).toContain('padding: 12px 0px');
  });

  it('keeps text selectable while the OS callout is suppressed on the editing surface', () => {
    expect(html).toContain('-webkit-touch-callout: none');
    expect(html).toContain('user-select: text');
  });

  it('clipboard: plain-text copy/cut, chip tokens preserved, control-char strip, paste size clamp', () => {
    // Copy/Cut put the VISIBLE plain text on the OS clipboard (no markdown markers, no trimming) so a
    // copy→paste round-trip is clean — NOT the old markdown serialization. Range.toString() reads it
    // straight from the range, and the range falls back to the captured snapshot so a tap that collapses
    // the live selection can't make copy/cut grab nothing.
    expect(html).toContain('r.toString()');
    expect(html).toContain('var r = live || heldRange;');
    expect(html).not.toContain('domToMarkdown(r.cloneContents())');
    // …but any embed/voice chip tokens in the selection are appended so a copied reference keeps its
    // nostr:/[[voice:]] payload as plain text.
    expect(html).toContain('function chipTokensIn');
    // Bubble Paste restores the held selection first (the RN round-trip can collapse it) so it replaces
    // the selection rather than inserting at a stray caret.
    expect(html).toMatch(/function insertText\(text, atCaret\) \{\s*\/\/[^]*?if \(!atCaret\) restoreHeld\(\);/);
    // Pasted text is stripped of control chars (NUL would collide with the code-span sentinel)…
    expect(html).toContain('\\u0000-\\u0008');
    // …and clamped so a poisoned multi-MB clipboard can't freeze the JS thread.
    expect(html).toContain('slice(0, 100000)');
  });

  it('auto-directions each paragraph by its first strong character (Arabic/bilingual RTL)', () => {
    // unicode-bidi: plaintext is the CSS form of firstStrongDir()'s per-paragraph rule — an Arabic
    // line right-aligns RTL while an adjacent English line stays LTR, live as typed. It is applied to
    // the editing surface AND (since unicode-bidi is not inherited) to every block it can contain.
    // Alignment verified visually in headless Chromium, which is Android's WebView engine.
    const css = html.slice(0, html.indexOf('</style>')).replace(/\s+/g, ' ');
    expect(css).toMatch(/#ed \{[^}]*unicode-bidi: plaintext; text-align: start;/);
    expect(css).toContain('#ed p, #ed div, #ed h1, #ed h2, #ed h3, #ed li, #ed blockquote { unicode-bidi: plaintext; text-align: start; }');
  });

  it('lists and quotes flip fully in Arabic: dir="auto" on containers + logical padding/border', () => {
    // plaintext can't move a list marker or the quote bar (those follow the element's `direction`),
    // so syncDir tags the CONTAINERS (ul/ol/blockquote — never <li> / inner <p>, which would starve
    // the container via HTML's dir=auto skip rule) so their direction follows the first strong char.
    expect(html).toContain('function syncDir');
    expect(html).toContain("querySelectorAll('ul, ol, blockquote')");
    // Called live on input AND after a draft/markdown load repopulates the body.
    expect(html).toMatch(/if \(applying\) return;\s*syncDir\(ed\);/);
    expect(html).toMatch(/ed\.innerHTML = markdownToHtml\(md\);\s*syncDir\(ed\);/);
    // Logical (inline-start) box so the marker/bar sit on the RIGHT in RTL, LEFT in LTR.
    const css = html.slice(0, html.indexOf('</style>')).replace(/\s+/g, ' ');
    expect(css).toContain('#ed ul, #ed ol { margin: 0 0 0.6em; padding-inline-start: 1.4em; }');
    expect(css).toContain('border-inline-start: 3px solid');
    expect(css).not.toMatch(/#ed ul, #ed ol \{[^}]*padding-left/);
  });

  it('renders inline media chips per-type so the composer preview echoes the published (feed) chip', () => {
    // The single muted pill is gone: a chip now carries a type class + inner structure that mirrors
    // its feed renderer — a picture = accent-soft tile + ▦ + label (PictureChip); a voice clip = an
    // accent disc with a border-drawn play triangle + a mini waveform + duration (VoicePlayer).
    expect(html).toContain('function chipParts');
    expect(html).toContain("span.className = 'chip ' + p.type;");
    expect(html).toContain('function fmtDur'); // voice duration, parsed from the token
    // Per-type CSS hooks.
    expect(html).toContain('#ed .chip.pic .ci');
    expect(html).toContain('#ed .chip.voice .ci');
    expect(html).toContain('#ed .chip.voice .tri'); // play triangle drawn from borders (centered)
    expect(html).toContain('#ed .chip.voice .wf');  // mini waveform
    // The chip ground is the feed surface (surfaceAlt), laid out as an icon+label row — not the old
    // baseline pill on `surface` with muted text. Its internal order is pinned LTR (RTL-safe).
    const css = html.slice(0, html.indexOf('</style>')).replace(/\s+/g, ' ');
    expect(css).toMatch(/#ed \.chip \{[^}]*display: inline-flex;[^}]*direction: ltr;[^}]*background: #161618;/);
    // chipHtml (markdown→html path) also emits the type class + structure, not a bare label pill.
    expect(html).toContain('<span class="chip \' + p.type + \'"');
  });

  it('the link scheme allowlist accepts stiq: deep links at BOTH the insert-time guard and the ' +
    'markdown-parse (round-trip) guard, and still rejects javascript:/data:', () => {
    // The exact scheme guard shipped in richEditorHtml.ts, used by both:
    //   - insertLink(text, url) — applies an "Add a link" insert coming from RN in real time;
    //   - inlineMd()'s markdown→HTML link regex — re-parses a link every time markdown is pushed
    //     back into the editor (setMarkdown), e.g. reopening a draft or an echoed `onChange`.
    // Before the fix this literal was `/^(https?:|nostr:)/i`, which silently dropped `stiq:` at
    // both sites (see the composer's insertLink() drop point in ComposerScreen.tsx and
    // RichEditor.tsx's postMessage bridge that carries the URL in). Asserting the exact source text
    // appears exactly twice ties this test to both real call sites, not a copy.
    const GUARD_SRC = '/^(https?:|nostr:|stiq:)/i';
    const occurrences = html.split(GUARD_SRC).length - 1;
    expect(occurrences).toBe(2);

    // eslint-disable-next-line no-eval -- reconstruct the exact shipped regex literal from source
    const guard = eval(GUARD_SRC) as RegExp;
    expect(guard.test('stiq://join?c=abc123')).toBe(true);
    expect(guard.test('stiq://channel/xyz')).toBe(true);
    expect(guard.test('https://example.com')).toBe(true);
    expect(guard.test('http://example.com')).toBe(true);
    expect(guard.test('nostr:nevent1qqq')).toBe(true);
    expect(guard.test('javascript:alert(1)')).toBe(false);
    expect(guard.test('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(guard.test('vbscript:msgbox(1)')).toBe(false);
  });

  describe('stiq: embed tokens (event/space/msg/draft) flow through the chip pipeline (bug: only ' +
    'the feed post composer / FullMessageEditor dropped them — plain-TextInput composers were fine)', () => {
    const TOKENS: {type: string; label: string; sample: string}[] = [
      {type: 'event', label: 'Event', sample: 'stiq:event:eyJ2IjoxfQ'},
      {type: 'space', label: 'Space', sample: 'stiq:space:eyJraW5kIjozMDMxMX0'},
      {type: 'msg', label: 'Private post', sample: 'stiq:msg:eyJwIjoiYWJjIn0'},
      {type: 'draft', label: 'Draft', sample: 'stiq:draft:eyJiIjoiaGVsbG8ifQ'},
    ];

    it('isChipToken recognizes all four (insertToken silently discards anything it fails)', () => {
      // The exact guard insertToken() gates on — a missed anchor here is the exact silent-drop bug.
      expect(html).toContain(
        'return EMBED_ANCHOR.test(tok) || VOICE_ANCHOR.test(tok) || PIC_ANCHOR.test(tok) ||\n' +
        '      STIQ_EVENT_ANCHOR.test(tok) || STIQ_SPACE_ANCHOR.test(tok) || STIQ_MSG_ANCHOR.test(tok) ||\n' +
        '      STIQ_DRAFT_ANCHOR.test(tok);',
      );
      expect(html).toContain('if (!isChipToken(tok)) return;'); // insertToken's guard, unchanged
      for (const {sample} of TOKENS) {
        const kind = sample.split(':')[1] ?? '';
        const anchorName = 'STIQ_' + kind.toUpperCase() + '_ANCHOR';
        const anchorSrc = html.match(new RegExp(`var ${anchorName} = (/\\^stiq:[a-z]+:[^$]+\\$/);`));
        expect(anchorSrc).toBeTruthy();
        // eslint-disable-next-line no-eval -- reconstruct the exact shipped regex literal from source
        const anchor = eval(anchorSrc?.[1] ?? '') as RegExp;
        expect(anchor.test(sample)).toBe(true);
        expect(anchor.test(sample + '<b>')).toBe(false); // no surrounding markup
        expect(anchor.test(' ' + sample)).toBe(false); // no leading whitespace
      }
    });

    it('chipParts classifies each stiq: token with its own type + label (mirrors savedEmbedRowLabel)', () => {
      for (const {type, label} of TOKENS) {
        expect(html).toContain(`return { type: '${type}', label: '${label}' };`);
      }
    });

    it('chipGlyph gives each stiq: type its own icon, shared by chipEl (DOM) and chipHtml (string)', () => {
      expect(html).toContain("if (type === 'event') return '\\uD83D\\uDCC5';"); // 📅
      expect(html).toContain("if (type === 'space') return '#';");
      expect(html).toContain("if (type === 'msg') return '\\uD83D\\uDD12';"); // 🔒
      expect(html).toContain("if (type === 'draft') return '\\u270D\\uFE0F';"); // ✍️
      // Both rendering paths route through the one glyph function — no independent ternary to drift.
      expect(html).toContain('ci.textContent = chipGlyph(p.type);');
      expect(html).toContain('var glyph = chipGlyph(p.type);');
    });

    it('lineToHtml’s TOKEN splitter recognizes stiq: tokens loaded from markdown, so a chip ' +
      'survives a draft reload instead of flattening to raw base64 text', () => {
      const m = html.match(/var TOKEN = (\/.*\/g);/);
      expect(m).toBeTruthy();
      // eslint-disable-next-line no-eval -- reconstruct the exact shipped TOKEN regex from source
      const TOKEN = eval(m?.[1] ?? '') as RegExp;
      for (const {sample} of TOKENS) {
        TOKEN.lastIndex = 0;
        expect(TOKEN.test(sample)).toBe(true);
        TOKEN.lastIndex = 0;
        expect(`before ${sample} after`.match(TOKEN)?.[0]).toBe(sample);
      }
    });

    it('chipHtml/chipEl assign a distinct CSS class per stiq: token type, quiet-tile styled like "ref"', () => {
      const css = html.slice(0, html.indexOf('</style>')).replace(/\s+/g, ' ');
      expect(css).toContain(
        '#ed .chip.ref .ci, #ed .chip.event .ci, #ed .chip.space .ci, #ed .chip.msg .ci, ' +
        '#ed .chip.draft .ci {',
      );
      // chipEl (DOM path) and chipHtml (string path) both set className/class from `'chip ' + p.type`
      // — already asserted generically above — so an 'event'/'space'/'msg'/'draft' token gets its
      // own class name through the SAME code every other chip type uses (no per-type special-casing
      // that could fork the two paths).
      expect(html).toContain("span.className = 'chip ' + p.type;");
      expect(html).toContain(`<span class="chip ' + p.type + '"`);
    });

    it('a stiq: token round-trips through insertToken -> chip -> domToMarkdown back to the exact ' +
      'original token string (data-token is read verbatim, never re-derived)', () => {
      // insertToken builds the chip from chipEl(tok), which stores the token VERBATIM in data-token
      // (chipEl never re-encodes it from chipParts' type/label). nodeInline — domToMarkdown's inline
      // serializer — reads data-token straight back off any '.chip' element, so what goes in via
      // insertToken/setMarkdown is byte-identical to what requestMarkdown/flush hands back to RN.
      expect(html).toContain("span.setAttribute('data-token', tok);");
      expect(html).toContain("if (el.classList && el.classList.contains('chip')) {\n" +
        "      return el.getAttribute('data-token') || '';          // verbatim token\n    }");
      // And chipHtml (the markdown→HTML path used by setMarkdown when a draft is reloaded) escapes
      // but never mutates the token into data-token, so the SAME verbatim contract holds on load too.
      expect(html).toContain(`data-token="' + esc(tok) + '"`);
    });
  });

  it('the embedded page script parses (guards the WebView editor against a syntax error)', () => {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const body = m?.[1] ?? '';
    expect(body.length).toBeGreaterThan(0);
    // new Function only COMPILES the body — it never runs it — so this is a pure syntax check that
    // needs no DOM. An invalid template edit throws SyntaxError here instead of failing on-device.
    // eslint-disable-next-line no-new-func -- compile-only syntax check of our own static template
    expect(() => new Function(body)).not.toThrow();
  });

  /**
   * Bug: a document ending in a table/details left the editor's DOM ending in a non-editable
   * `.np-tablewrap`/`.np-details` island (contenteditable="false") — there was no editable node after
   * it, so the caret had nowhere to go and Enter/tap-below did nothing. insertBlockHTML already
   * guarded a FRESH toolbar insert with a trailing `<p><br /></p>`, but markdownToHtml (the ONLY path
   * a markdown round-trip goes through — autosave/reopen, any setMarkdown) didn't.
   *
   * markdownToHtml() and everything it transitively calls (lineToHtml/inlineMd/chipHtml/chipParts/
   * tableRowsToHtml/splitTableRow) are pure STRING functions with no DOM dependency, so it's exercised
   * here directly by actually RUNNING the page's own script (not just string-matching its source, as
   * the rest of this file does) in a minimal stubbed sandbox — just enough `document`/`window` surface
   * for the IIFE's one-time setup (element lookups + event-listener registration) to finish without
   * throwing. `window.__markdownToHtml` is the same debug/test export `__domToMarkdown` already uses.
   */
  describe('markdownToHtml (executed): a document-final table/details gets a trailing empty paragraph', () => {
    function stubEl(): Record<string, unknown> {
      return {
        addEventListener: () => {},
        removeEventListener: () => {},
        classList: {contains: () => false, add: () => {}, remove: () => {}},
        contains: () => false,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        setAttribute: () => {},
        getAttribute: () => null,
        getBoundingClientRect: () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0}),
        style: {},
        focus: () => {},
        scrollHeight: 0,
      };
    }
    function extractMarkdownToHtml(src: string): (md: string) => string {
      const m = src.match(/<script>([\s\S]*?)<\/script>/);
      const body = m?.[1] ?? '';
      expect(body.length).toBeGreaterThan(0);
      const ed = stubEl();
      const bar = stubEl();
      const doc: Record<string, unknown> = {
        getElementById: (id: string) => (id === 'ed' ? ed : id === 'bar' ? bar : stubEl()),
        addEventListener: () => {},
        removeEventListener: () => {},
        createElement: () => stubEl(),
        createRange: () => ({selectNodeContents: () => {}, collapse: () => {}}),
        body: {scrollHeight: 0},
        documentElement: {clientWidth: 0, clientHeight: 0},
      };
      const win: Record<string, unknown> = {
        addEventListener: () => {},
        removeEventListener: () => {},
        getSelection: () => ({rangeCount: 0}),
        innerWidth: 0,
        innerHeight: 0,
      };
      // Executing the page's own (self-contained, non-user) script in a stubbed sandbox to reach
      // markdownToHtml, which is otherwise private to the page.
      // eslint-disable-next-line no-new-func
      const fn = new Function('window', 'document', body);
      fn(win, doc);
      const impl = (win as {__markdownToHtml?: unknown}).__markdownToHtml;
      expect(typeof impl).toBe('function');
      return impl as (md: string) => string;
    }
    const md2html = extractMarkdownToHtml(html);

    it('a document ending in a table gets a trailing empty <p> — the caret has somewhere to go', () => {
      const out = md2html('| A | B |\n|---|---|\n| 1 | 2 |');
      expect(out).toContain('np-tablewrap');
      expect(out.trim().endsWith('<p><br /></p>')).toBe(true);
    });

    it('a document ending in a details block gets the same trailing empty <p>', () => {
      const out = md2html('::: summary\nbody\n:::');
      expect(out).toContain('np-details');
      expect(out.trim().endsWith('<p><br /></p>')).toBe(true);
    });

    it('a trailing blank line after a document-final table still counts as document-final', () => {
      const out = md2html('| A | B |\n|---|---|\n| 1 | 2 |\n');
      expect(out.trim().endsWith('<p><br /></p>')).toBe(true);
    });

    it('a table is NOT last: no trailing-paragraph guard fires, only the real following content', () => {
      const out = md2html('| A | B |\n|---|---|\n| 1 | 2 |\n\nmore text');
      expect(out.trim().endsWith('<p>more text</p>')).toBe(true);
      // Exactly one <p> from "more text" — no extra empty <p><br /></p> inserted before it.
      expect((out.match(/<p><br \/><\/p>/g) ?? []).length).toBe(0);
    });

    it('a document NOT ending in an island is unaffected (no spurious trailing empty paragraph)', () => {
      expect(md2html('just a plain paragraph')).toBe('<p>just a plain paragraph</p>');
    });

    it('a heading after a table is not swallowed by the island guard', () => {
      const out = md2html('| A | B |\n|---|---|\n| 1 | 2 |\n\n## after');
      expect(out.trim().endsWith('<h2>after</h2>')).toBe(true);
    });
  });

  it('Enter in the LAST cell of a document-final table escapes to a trailing paragraph (reuses ' +
    'escapeIsland — the SAME rescue insertBlockHTML uses for a fresh insert)', () => {
    // The keydown listener now handles two island escapes: the pre-existing dt-sum → dt-body one,
    // and this new td/th → trailing-<p> one. Asserting the exact guards (not just "contains
    // escapeIsland", already pinned generically elsewhere) ties this to the real implementation.
    expect(html).toContain("e.target.closest('td, th')");
    expect(html).toContain('wrap.nextElementSibling');   // bails when the table isn't document-final
    expect(html).toContain('cell !== cells[cells.length - 1]'); // only the very last cell escapes
    expect(html).toMatch(/cell !== cells\[cells\.length - 1\][^]*?escapeIsland\(\);/);
    // The pre-existing details-summary rescue is preserved in the SAME listener, unchanged.
    expect(html).toContain(".closest('.dt-sum')");
  });
});
