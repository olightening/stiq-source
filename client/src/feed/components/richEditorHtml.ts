/**
 * richEditorHtml — a self-contained WYSIWYG editor as a single HTML document, loaded into a
 * react-native-webview via `source={{ html }}`. No external resources (no remote CSS/fonts/JS):
 * everything is inline, so it runs fully offline inside a sandboxed WebView with no network.
 *
 * The editor speaks the app's shared Markdown dialect (see RichText.tsx): it SERIALIZES the
 * contenteditable DOM down to that markdown (`domToMarkdown`) and PARSES markdown back into a
 * safe element set (`markdownToHtml`) when RN pushes a value in. nostr: embeds, inline-voice tokens,
 * and the four self-contained `stiq:event:`/`stiq:space:`/`stiq:msg:`/`stiq:draft:` embed tokens
 * (events/eventEmbed.ts, channels/spaceEmbed.ts, channels/msgEmbed.ts, feed/draftEmbed.ts) are all
 * shown as atomic, non-editable "chips" that round-trip to their exact data-token.
 *
 * SECURITY: markdown → HTML always HTML-escapes text before insertion, so a malicious body can
 * never inject markup or script into the editor's DOM. The editor only ever emits the supported
 * element set; it never sets innerHTML from raw untrusted strings.
 *
 * Bridge protocol (window.ReactNativeWebView.postMessage(JSON.stringify(...))):
 *   → RN: {type:'ready'} | {type:'change', md} | {type:'height', px} | {type:'linkRequest'}
 *         | {type:'state', block}   (the block style the caret sits in — drives the RN block sheet)
 *         | {type:'blockSheet'}     (the bubble's Aa style button asks RN to open the block sheet)
 *         | {type:'clip', op:'copy'|'cut'|'paste', text?}   (copy/cut carry the plain-text selection;
 *                                                            paste asks RN to read the OS clipboard)
 *   ← RN: {type:'setMarkdown', md} | {type:'cmd', name} | {type:'insertToken', token}
 *         | {type:'insertLink', text, url} | {type:'insertText', text} | {type:'focus'}
 *
 * The v2 block vocabulary (design_handoff_post_editor_v2) rides the same markdown dialect with
 * line-based syntax that degrades to readable plain text on older builds:
 *   pullquote '>> line' · footer small-print '-# line' · task list '- [ ] x' / '- [x] x'
 *   collapsible details '::: summary' … body … ':::' · table '| a | b |' + '| --- | --- |' rows
 *
 * Clipboard: the OS selection menu is suppressed (menuItems=[] native prop + -webkit-touch-callout
 * on #ed); our bubble owns Copy/Cut/Paste. To dodge the WebView's blocked execCommand('paste') and
 * clipboard-permission restrictions, ALL clipboard I/O is routed through RN's native clipboard: the
 * page posts the selection for copy/cut and requests a paste, which RN fulfils via insertText.
 */

export interface RichEditorTheme {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  code: string;
  /** Extra tokens used to render inline media chips so they echo their published (feed) form:
   *  surfaceAlt = chip ground, accentSoft = picture icon tile, link = picture glyph, onAccent =
   *  the play triangle on the voice disc, textSecondary = the dim duration/secondary text. */
  surfaceAlt: string;
  accentSoft: string;
  link: string;
  onAccent: string;
  textSecondary: string;
  /** Inner padding of the writing surface (px). The composer uses padX 0 so the body text aligns
   *  with the title gutter (the design has no box around the body). */
  padX: number;
  padY: number;
}

/** JSON-escape a color/string so it can't break out of the inline CSS/JS string context. */
function safe(s: string): string {
  return JSON.stringify(String(s)).slice(1, -1);
}

/** Build the complete editor document for the given theme. */
export function richEditorHtml(theme: RichEditorTheme): string {
  const t = {
    bg: safe(theme.bg),
    surface: safe(theme.surface),
    text: safe(theme.text),
    muted: safe(theme.muted),
    accent: safe(theme.accent),
    border: safe(theme.border),
    code: safe(theme.code),
    surfaceAlt: safe(theme.surfaceAlt),
    accentSoft: safe(theme.accentSoft),
    link: safe(theme.link),
    onAccent: safe(theme.onAccent),
    textSecondary: safe(theme.textSecondary),
  };
  // Writing-surface padding — numeric, clamped to a safe integer (no injection risk).
  const px = Math.max(0, Math.min(64, Math.floor(Number(theme.padX))) || 0);
  const py = Math.max(0, Math.min(64, Math.floor(Number(theme.padY))) || 0);

  // The page script is a single template; the dialect logic (domToMarkdown / markdownToHtml) is
  // the core. Kept in one string so the document is self-contained.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; height: 100%; background: ${t.bg}; }
  body {
    color: ${t.text};
    font: 16px/1.45 -apple-system, system-ui, Roboto, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; height: 100%;
    -webkit-text-size-adjust: 100%;
  }
  /* The selection bubble is the ONLY formatting surface, and it FLOATS over the selected text —
     exactly where the OS copy/paste bubble used to appear (that native toolbar is now suppressed, so
     nothing collides with it). Hidden by default; on a non-empty selection, positionBubble() shows it
     centered just ABOVE the selection (flipping BELOW when there's no headroom) by setting left/top
     inline. A single compact ICON row, grouped by hairline separators:
       clipboard (Copy Cut Paste) . B I U link . Clear (T-x) . Aa style (current block + chevron)
     The block styles (H2/H3/quote and the v2 blocks) are FOLDED behind the Aa button, which asks RN
     to open the native block sheet (design_handoff_post_editor_v2). No strikethrough (the dialect
     has no ~~), no PRE. */
  #bar {
    display: none; position: fixed; top: 0; left: 0; z-index: 30;
    flex-direction: row; align-items: center; gap: 0;
    padding: 3px; background: ${t.surface};
    border: 1px solid ${t.border}; border-radius: 12px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    max-width: calc(100vw - 12px);
    overflow-x: auto; overflow-y: hidden; white-space: nowrap;
    -webkit-overflow-scrolling: touch;
  }
  #bar.sel { display: flex; }
  #bar::-webkit-scrollbar { height: 0; width: 0; }
  #bar button {
    flex: none; min-width: 28px; height: 34px; padding: 0 3px; margin: 0;
    border: none; border-radius: 8px;
    background: transparent; color: ${t.text};
    font-size: 15px; font-weight: 600; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; user-select: none; -webkit-user-select: none;
  }
  #bar button:active { background: ${t.bg}; }
  /* Active inline mark / current block reflects the selection's state. */
  #bar button.on { background: ${t.accent}; color: #fff; }
  /* Clipboard emoji sit a touch smaller so the 10-button row fits a phone width without clipping. */
  #bar button.clip { font-size: 14px; }
  #bar button.b { font-weight: 800; }
  #bar button.i { font-style: italic; }
  #bar button.u { text-decoration: underline; }
  #bar button.blk { font-size: 13px; }
  #bar button.q { font-size: 19px; }
  #bar button.lnk { font-size: 14px; }
  /* Aa style button — the folded block-style entry: shows the current block's short name + a
     chevron; tapping it opens the native block sheet (H2/H3/quote + the v2 blocks live there). */
  #bar button.sty { font-size: 13px; padding: 0 8px; }
  #bar button.sty .chev { font-size: 9px; color: ${t.muted}; margin-left: 3px; }
  /* Clear = a monochrome T-with-x glyph (remove-formatting): an icon, not a word, between marks + blocks. */
  #bar button.clr .cf { position: relative; font-weight: 800; }
  #bar button.clr .cfx { font-size: 9px; font-weight: 700; vertical-align: super; margin-left: 0.5px; }
  #bar .sep { flex: none; width: 1px; height: 20px; background: ${t.border}; margin: 0 2px; }
  #ed {
    flex: 1 1 auto; overflow-y: auto; padding: ${py}px ${px}px;
    outline: none; -webkit-user-select: text; user-select: text;
    /* Keep text SELECTABLE but kill the OS long-press callout (iOS) — our floating bubble replaces
       it. The Android selection ActionMode (Cut/Copy/Paste) is killed natively by the wrapping
       StiqNoCabView, which returns null from startActionModeForChild (see RichEditor.tsx /
       NoCabView.kt); this rule handles the iOS callout + link long-press. */
    -webkit-touch-callout: none;
    word-wrap: break-word; overflow-wrap: break-word;
    /* Arabic / bilingual: each paragraph takes its OWN base direction from its first strong
       character (Unicode P2/P3 — the same rule firstStrongDir() applies everywhere else in the
       app), live as you type, so an Arabic line right-aligns RTL while an adjacent English line
       stays LTR. unicode-bidi is NOT inherited, so it's re-declared on every block element below. */
    unicode-bidi: plaintext; text-align: start;
  }
  #ed:empty::before {
    content: attr(data-ph); color: ${t.muted}; pointer-events: none;
  }
  /* Per-paragraph first-strong direction for every block the editor can contain (contenteditable
     also spawns bare <div> lines). Verified in headless Chromium (= Android WebView): Arabic and
     digit-led-Arabic paragraphs align RIGHT, English LEFT. */
  #ed p, #ed div, #ed h1, #ed h2, #ed h3, #ed li, #ed blockquote {
    unicode-bidi: plaintext; text-align: start;
  }
  #ed h1 { font-size: 1.5em; font-weight: 700; margin: 0.4em 0 0.3em; }
  #ed h2 { font-size: 1.25em; font-weight: 700; margin: 0.4em 0 0.3em; }
  #ed h3 { font-size: 1.08em; font-weight: 600; margin: 0.4em 0 0.3em; }
  #ed p { margin: 0 0 0.6em; }
  /* Logical (inline-start) padding/border so lists + quotes flip with each block's dir="auto"
     direction (set by syncDir): Arabic bullets/numbers and the quote bar sit on the RIGHT, English
     on the LEFT. Physical padding-left/border-left would strand them on the left in RTL. */
  #ed ul, #ed ol { margin: 0 0 0.6em; padding-inline-start: 1.4em; }
  #ed li { margin: 0.1em 0; }
  #ed blockquote {
    margin: 0 0 0.6em; padding: 2px 0; padding-inline-start: 12px;
    border-inline-start: 3px solid ${t.accent}; color: ${t.muted};
  }
  #ed hr {
    border: none; border-top: 1px solid ${t.border};
    margin: 0.8em 0;
  }
  /* v2 rich blocks (design_handoff_post_editor_v2): pullquote, footer small-print, task list,
     collapsible details, editable table. Class names + structure mirror the handoff prototype so
     this editor and the feed/detail renderers speak one vocabulary. */
  #ed blockquote.pull {
    border: none; padding: 10px 6px; margin: 0 0 0.6em; text-align: center;
    font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 600;
    font-size: 1.2em; line-height: 1.45; color: ${t.text};
  }
  #ed blockquote.pull::before, #ed blockquote.pull::after {
    content: ""; display: block; width: 44px; height: 1px; background: ${t.border}; margin: 0 auto;
  }
  #ed blockquote.pull::before { margin-bottom: 10px; }
  #ed blockquote.pull::after { margin-top: 10px; }
  #ed p.np-footer {
    font-size: 0.82em; line-height: 1.55; color: ${t.muted};
    border-top: 1px solid ${t.border}; padding-top: 9px; margin: 1em 0 0.6em;
  }
  #ed ul.np-task { list-style: none; padding-inline-start: 2px; }
  #ed ul.np-task li { position: relative; padding-inline-start: 30px; margin: 0.3em 0; }
  #ed ul.np-task li::before {
    content: ""; position: absolute; inset-inline-start: 0; top: 2px; width: 19px; height: 19px;
    border-radius: 6px; border: 1.5px solid ${t.border}; background: ${t.surfaceAlt};
    font-size: 13px; line-height: 19px; font-weight: 700; text-align: center;
  }
  #ed ul.np-task li[data-checked="1"]::before {
    content: "\\2713"; color: ${t.onAccent}; background: ${t.accent}; border-color: ${t.accent};
  }
  #ed ul.np-task li[data-checked="1"] { color: ${t.muted}; text-decoration: line-through; }
  #ed .np-details { border: 1px solid ${t.border}; border-radius: 12px; margin: 0 0 0.6em; background: ${t.surfaceAlt}; }
  #ed .np-details .dt-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; cursor: pointer; }
  #ed .np-details .dt-chev { flex: none; font-size: 11px; color: ${t.muted}; transition: transform 0.2s; }
  #ed .np-details[data-open="1"] .dt-chev { transform: rotate(90deg); }
  #ed .np-details .dt-sum { flex: 1; min-width: 0; font-weight: 600; outline: none; unicode-bidi: plaintext; text-align: start; }
  #ed .np-details .dt-sum:empty::before { content: "Summary"; color: ${t.muted}; }
  #ed .np-details .dt-body { display: none; padding: 8px 12px 11px; outline: none; border-top: 1px solid ${t.border}; unicode-bidi: plaintext; text-align: start; }
  #ed .np-details[data-open="1"] .dt-body { display: block; }
  #ed .np-tablewrap { position: relative; margin: 0 0 0.7em; }
  #ed .np-tablewrap .tb-scroll { overflow-x: auto; border: 1px solid ${t.border}; border-radius: 12px; -webkit-overflow-scrolling: touch; }
  #ed table.np-table { border-collapse: collapse; min-width: 100%; }
  #ed .np-table th, #ed .np-table td {
    border-right: 1px solid ${t.border}; border-bottom: 1px solid ${t.border};
    padding: 8px 10px; font-size: 0.9em; line-height: 1.45; text-align: start; vertical-align: top;
    min-width: 88px; outline: none; color: ${t.text}; unicode-bidi: plaintext;
  }
  #ed .np-table th:last-child, #ed .np-table td:last-child { border-right: none; }
  #ed .np-table tbody tr:last-child td { border-bottom: none; }
  #ed .np-table th { background: ${t.surfaceAlt}; font-weight: 600; font-size: 0.8em; color: ${t.textSecondary}; }
  #ed .np-table th:empty::before { content: "Header"; color: ${t.muted}; font-weight: 500; }
  #ed .np-table td:empty::before { content: "Cell"; color: ${t.muted}; }
  #ed .np-table th:focus, #ed .np-table td:focus { box-shadow: inset 0 0 0 1.5px ${t.accent}; }
  /* Floating table edit controls — shown only while the caret is inside that table (.live). */
  #ed .tb-add, #ed .tb-del {
    position: absolute; display: none; align-items: center; justify-content: center; padding: 0;
    border: 1px solid ${t.border}; background: ${t.surface}; color: ${t.textSecondary};
    cursor: pointer; z-index: 5; font-size: 14px; box-shadow: 0 3px 10px rgba(0,0,0,0.4);
  }
  #ed .np-tablewrap.live .tb-add, #ed .np-tablewrap.live .tb-del { display: flex; }
  #ed .tb-addcol { right: 2px; top: 50%; transform: translateY(-50%); width: 24px; height: 46px; border-radius: 9px; }
  #ed .tb-addrow { bottom: -12px; left: 50%; transform: translateX(-50%); height: 24px; width: 64px; border-radius: 9px; }
  #ed .tb-del { top: -10px; right: 2px; width: 22px; height: 22px; border-radius: 50%; font-size: 10px; }
  #ed a { color: ${t.accent}; text-decoration: underline; }
  #ed code {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.92em; color: ${t.code};
    background: ${t.surface}; border-radius: 4px; padding: 1px 4px;
  }
  /* Inline media chips echo their PUBLISHED (feed) form so the composer preview matches what ships:
     a picture chip = accent-soft tile + 🖼️ + label (like PictureChip); a voice chip = an accent disc
     with a play triangle + a mini waveform + duration (like VoicePlayer); a referenced post AND each
     self-contained stiq: embed (event/space/private-post/draft) = a quiet tile + label, distinguished
     only by chipGlyph's icon. Each is ONE atomic contenteditable=false unit that still serializes back
     to its exact data-token (nodeInline reads data-token, not the inner DOM). Its internal order is
     pinned LTR so an RTL paragraph never reverses the icon/label. */
  #ed .chip {
    display: inline-flex; align-items: center; vertical-align: middle; direction: ltr;
    gap: 6px; margin: 1px 2px; padding: 3px 10px 3px 3px;
    border: 1px solid ${t.border}; border-radius: 11px;
    background: ${t.surfaceAlt}; color: ${t.text};
    font-size: 0.86em; line-height: 1.1; white-space: nowrap;
    user-select: none; -webkit-user-select: none; cursor: default;
  }
  #ed .chip .ci {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto; width: 22px; height: 22px; font-size: 12px; line-height: 1;
  }
  #ed .chip.pic .ci { border-radius: 6px; background: ${t.accentSoft}; color: ${t.link}; }
  /* Referenced post + the four self-contained stiq: embeds (event/space/private-post/draft) all share
     the same quiet tile — only the glyph (chipGlyph) tells them apart. */
  #ed .chip.ref .ci, #ed .chip.event .ci, #ed .chip.space .ci, #ed .chip.msg .ci, #ed .chip.draft .ci {
    border-radius: 6px; background: ${t.surface}; color: ${t.textSecondary};
  }
  #ed .chip.voice .ci { border-radius: 999px; background: ${t.accent}; }
  #ed .chip .cl { font-weight: 600; color: ${t.text}; }
  #ed .chip .cd { color: ${t.muted}; font-weight: 500; }
  /* Play triangle drawn from borders so it is optically centered in the disc (a ▶ glyph is not). */
  #ed .chip.voice .tri {
    width: 0; height: 0; margin-left: 2px;
    border-top: 5px solid transparent; border-bottom: 5px solid transparent;
    border-left: 8px solid ${t.onAccent};
  }
  /* Mini static waveform — the visual body VoicePlayer gives a clip, compacted for the chip. */
  #ed .chip.voice .wf { display: inline-flex; align-items: center; gap: 2px; height: 15px; }
  #ed .chip.voice .wf i { width: 2px; border-radius: 1px; background: ${t.accent}; opacity: 0.55; }
</style>
</head>
<body>
  <div id="bar" role="toolbar" aria-label="Formatting">
    <button class="clip" data-cmd="copy" title="Copy" aria-label="Copy">&#128203;</button>
    <button class="clip" data-cmd="cut" title="Cut" aria-label="Cut">&#9986;&#65039;</button>
    <button class="clip" data-cmd="paste" title="Paste" aria-label="Paste">&#128229;</button>
    <span class="sep"></span>
    <button class="b" data-cmd="bold" title="Bold" aria-label="Bold">B</button>
    <button class="i" data-cmd="italic" title="Italic" aria-label="Italic">I</button>
    <button class="u" data-cmd="underline" title="Underline" aria-label="Underline">U</button>
    <button class="lnk" data-cmd="link" title="Add link" aria-label="Add link">&#128279;</button>
    <span class="sep"></span>
    <button class="clr" data-cmd="clear" title="Clear formatting" aria-label="Clear formatting"><span class="cf">T<span class="cfx">&#10005;</span></span></button>
    <span class="sep"></span>
    <button class="sty" data-cmd="style" title="Text style" aria-label="Text style"><span id="styLabel">Body</span><span class="chev">&#9662;</span></button>
  </div>
  <div id="ed" contenteditable="true" data-ph=""></div>
<script>
(function () {
  "use strict";
  var ed = document.getElementById('ed');
  var bar = document.getElementById('bar');
  var applying = false;       // true while setMarkdown is rewriting the DOM (suppress 'change')
  var lastMd = null;          // last markdown we emitted, to avoid echo loops
  var changeTimer = 0;
  var heldRange = null;       // selection snapshot taken when a bubble button press BEGINS, so a
                              // command can restore it if the tap collapsed the live selection
                              // (Android WebViews collapse on a touch outside the selection).

  // ── messaging ──────────────────────────────────────────────────────────────
  function post(obj) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
      }
    } catch (e) {}   // postMessage can throw if the RN bridge isn't ready; failure is cosmetic (message just drops)
  }
  function reportHeight() {
    var px = Math.max(ed.scrollHeight, document.body.scrollHeight) | 0;
    post({ type: 'height', px: px });
  }
  function emitChange() {
    if (applying) return;
    var md = domToMarkdown(ed);
    if (md === lastMd) return;
    lastMd = md;
    post({ type: 'change', md: md });
  }
  // Arabic RTL for the block chrome that unicode-bidi:plaintext CAN'T fix: list bullets/numbers and
  // the blockquote bar. Those follow the element's CSS direction, which plaintext leaves as ltr, so we
  // set dir="auto" on the list/quote CONTAINERS to make direction follow their first strong character
  // (Arabic → rtl → markers/bar on the RIGHT; English → ltr → left). Text alignment of ordinary
  // paragraphs/headings/list-items is already handled by plaintext, so they get NO dir here — and that
  // is deliberate: HTML's dir=auto ignores the subtree of any descendant that itself carries a dir
  // attribute, so dir-ing a container's own text child (a <li>, or the <p> markdownToHtml nests inside
  // a <blockquote>) would starve the container of strong characters and leave it stuck LTR. Only the
  // containers get dir; their text children inherit direction from them.
  function syncDir(root) {
    var blocks = root.querySelectorAll('ul, ol, blockquote');
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].getAttribute('dir') !== 'auto') blocks[i].setAttribute('dir', 'auto');
    }
  }
  function scheduleChange() {
    if (applying) return;
    syncDir(ed);            // keep block dirs current as the user types (cheap; a handful of blocks)
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(function () {
      changeTimer = 0; emitChange(); reportHeight();
    }, 120);
  }
  // Force an immediate serialization and report it back tagged as 'flushed'. RN calls this the moment
  // the user taps Send/Publish so the final keystrokes aren't lost to the 120ms change debounce.
  // Always responds (even when unchanged) so the host has a definite value to publish against.
  function flushNow() {
    if (changeTimer) { clearTimeout(changeTimer); changeTimer = 0; }
    var md = domToMarkdown(ed);
    lastMd = md;
    post({ type: 'flushed', md: md });
  }

  // ── html escaping (used by markdownToHtml; user content is NEVER trusted) ───
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── chips (nostr embeds + inline voice + self-contained stiq: embeds) ──────
  // Unanchored forms — used for scanning tokens WITHIN a line (chipLabel / the TOKEN splitter).
  var EMBED_RE = /nostr:(?:nevent1|note1|naddr1)[a-z0-9]+/;
  var VOICE_RE = /\\[\\[voice:[^\\]]+\\]\\]/;
  var PIC_RE = /\\[\\[pic:[^\\]]+\\]\\]/;
  // The four self-contained \`stiq:\` embed tokens (events/eventEmbed.ts, channels/spaceEmbed.ts,
  // channels/msgEmbed.ts, feed/draftEmbed.ts) — same base64url charset each module's own RE uses
  // (bug #12 lesson: every detector must recognize the token, sourced from one definition so they
  // never drift; here that means matching the charset exactly since the token can't be imported
  // into this self-contained WebView document).
  var STIQ_EVENT_RE = /stiq:event:[A-Za-z0-9_-]+/;
  var STIQ_SPACE_RE = /stiq:space:[A-Za-z0-9_-]+/;
  var STIQ_MSG_RE = /stiq:msg:[A-Za-z0-9_-]+/;
  var STIQ_DRAFT_RE = /stiq:draft:[A-Za-z0-9_-]+/;
  // Anchored forms — used to VALIDATE a host-supplied token: it must be exactly one clean token
  // with no surrounding markup, whitespace, or trailing junk. Rejects e.g.
  // "x<script>[[voice:audio/mp4;1;AAAA]]" or " nostr:note1abc " or "nostr:note1abc<b>".
  var EMBED_ANCHOR = /^nostr:(?:nevent1|note1|naddr1)[a-z0-9]+$/;
  var VOICE_ANCHOR = /^\\[\\[voice:[^\\]]+\\]\\]$/;
  var PIC_ANCHOR = /^\\[\\[pic:[^\\]]+\\]\\]$/;
  var STIQ_EVENT_ANCHOR = /^stiq:event:[A-Za-z0-9_-]+$/;
  var STIQ_SPACE_ANCHOR = /^stiq:space:[A-Za-z0-9_-]+$/;
  var STIQ_MSG_ANCHOR = /^stiq:msg:[A-Za-z0-9_-]+$/;
  var STIQ_DRAFT_ANCHOR = /^stiq:draft:[A-Za-z0-9_-]+$/;
  function isChipToken(tok) {
    return EMBED_ANCHOR.test(tok) || VOICE_ANCHOR.test(tok) || PIC_ANCHOR.test(tok) ||
      STIQ_EVENT_ANCHOR.test(tok) || STIQ_SPACE_ANCHOR.test(tok) || STIQ_MSG_ANCHOR.test(tok) ||
      STIQ_DRAFT_ANCHOR.test(tok);
  }
  // Static waveform bar heights (px) for the compact voice chip — a fixed pattern that reads as an
  // audio clip without decoding the payload (the feed's VoicePlayer draws the live one).
  var WF = [5, 9, 13, 8, 15, 11, 6, 12, 8, 10, 6];
  function fmtDur(sec) {
    var s = sec > 0 ? (sec | 0) : 0;
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  // Classify a token + pull the bits a chip shows: a picture's label, a voice clip's duration, or —
  // for a self-contained \`stiq:\` embed — its own type + a short label (matches the wording
  // savedEmbedRowLabel uses for the same kinds in the composer's saved-embeds picker).
  function chipParts(tok) {
    if (VOICE_RE.test(tok)) {
      var dm = /\\[\\[voice:[^;]+;(\\d+)/.exec(tok);
      return { type: 'voice', dur: dm ? (parseInt(dm[1], 10) || 0) : 0 };
    }
    if (PIC_RE.test(tok)) {
      var label = 'Picture';
      var lm = /;l=([^;\\]]*)/.exec(tok);
      if (lm && lm[1]) { try { label = decodeURIComponent(lm[1]); } catch (e) { label = lm[1]; } }
      return { type: 'pic', label: label };
    }
    if (STIQ_EVENT_RE.test(tok)) return { type: 'event', label: 'Event' };
    if (STIQ_SPACE_RE.test(tok)) return { type: 'space', label: 'Space' };
    if (STIQ_MSG_RE.test(tok)) return { type: 'msg', label: 'Private post' };
    if (STIQ_DRAFT_RE.test(tok)) return { type: 'draft', label: 'Draft' };
    return { type: 'ref', label: 'Referenced post' };
  }
  // The icon glyph per chip type — shared by chipEl (DOM) and chipHtml (string) so the two rendering
  // paths (live insert vs. markdown→HTML on load) can never show a different icon for the same token.
  function chipGlyph(type) {
    if (type === 'pic') return '\\uD83D\\uDDBC\\uFE0F';       // 🖼️ framed picture
    if (type === 'event') return '\\uD83D\\uDCC5';            // 📅 event card
    if (type === 'space') return '#';                        // channel/private-space card
    if (type === 'msg') return '\\uD83D\\uDD12';              // 🔒 private post carried out of a space
    if (type === 'draft') return '\\u270D\\uFE0F';            // ✍️ unpublished draft
    return '\\uD83D\\uDD17';                                  // 🔗 referenced post (nostr:)
  }
  // Build a chip element WITHOUT innerHTML — the token lives in data-token; the visible structure is
  // assembled from createElement + textContent (user text never becomes markup). Mirrors chipHtml().
  function chipEl(tok) {
    var span = document.createElement('span');
    span.setAttribute('contenteditable', 'false');
    span.setAttribute('data-token', tok);
    var p = chipParts(tok);
    span.className = 'chip ' + p.type;
    var ci = document.createElement('span');
    ci.className = 'ci';
    if (p.type === 'voice') {
      var tri = document.createElement('span'); tri.className = 'tri'; ci.appendChild(tri);
      span.appendChild(ci);
      var wf = document.createElement('span'); wf.className = 'wf';
      for (var i = 0; i < WF.length; i++) {
        var b = document.createElement('i'); b.style.height = WF[i] + 'px'; wf.appendChild(b);
      }
      span.appendChild(wf);
      var d = document.createElement('span'); d.className = 'cd'; d.textContent = fmtDur(p.dur);
      span.appendChild(d);
    } else {
      ci.textContent = chipGlyph(p.type);
      span.appendChild(ci);
      var l = document.createElement('span'); l.className = 'cl'; l.textContent = p.label;
      span.appendChild(l);
    }
    return span;
  }

  // ── inline serialization: a run of inline nodes → markdown ─────────────────
  function inlineToMd(node) {
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      out += nodeInline(node.childNodes[i]);
    }
    return out;
  }
  function wrapMarks(el, inner) {
    // Read computed-ish style from the element + ancestors that execCommand produced.
    var tag = el.tagName;
    if (tag === 'BR') return '\\n';
    if (tag === 'CODE') return '\`' + inner + '\`';
    if (tag === 'A') {
      var href = el.getAttribute('href') || '';
      return '[' + inner + '](' + href + ')';
    }
    var s = '';
    var e = '';
    var bold = tag === 'B' || tag === 'STRONG' || el.style.fontWeight === 'bold' || el.style.fontWeight === '700';
    var ital = tag === 'I' || tag === 'EM' || el.style.fontStyle === 'italic';
    var und = tag === 'U' || (el.style.textDecorationLine || el.style.textDecoration || '').indexOf('underline') >= 0;
    if (bold) { s = '**' + s; e = e + '**'; }
    if (ital) { s = '_' + s; e = e + '_'; }
    if (und) { s = '__' + s; e = e + '__'; }
    return s + inner + e;
  }
  function nodeInline(n) {
    if (n.nodeType === 3) return n.nodeValue || '';        // text
    if (n.nodeType !== 1) return '';                        // comment etc.
    var el = n;
    if (el.classList && el.classList.contains('chip')) {
      return el.getAttribute('data-token') || '';          // verbatim token
    }
    if (el.tagName === 'BR') return '\\n';
    var inner = inlineToMd(el);
    if (inner === '' && el.tagName !== 'A') return '';
    return wrapMarks(el, inner);
  }

  // ── block serialization ────────────────────────────────────────────────────
  var BLOCK = { P: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
                UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, HR: 1, PRE: 1 };
  function prefixLines(text, prefix) {
    return text.split('\\n').map(function (l) { return prefix + l; }).join('\\n');
  }
  function blockToMd(el, lines) {
    var tag = el.tagName;
    var cls = el.classList;
    // v2 rich blocks first — each is a DIV/P/UL/BLOCKQUOTE that must NOT fall into the generic
    // branches below (a details/table DIV would otherwise recurse via hasBlockChild).
    if (cls && cls.contains('np-tablewrap')) { tableToMd(el, lines); return; }
    if (cls && cls.contains('np-details')) { detailsToMd(el, lines); return; }
    if (cls && cls.contains('np-footer')) {
      var fmd = blockChildrenToMd(el).replace(/\\n{2,}/g, '\\n').trim();
      lines.push(fmd === '' ? '-# ' : prefixLines(fmd, '-# '));
      return;
    }
    if (tag === 'BLOCKQUOTE' && cls && cls.contains('pull')) {
      var pmd = blockChildrenToMd(el).replace(/\\n{2,}/g, '\\n').trim();
      lines.push(pmd === '' ? '>> ' : prefixLines(pmd, '>> '));
      return;
    }
    if (tag === 'HR') { lines.push('---'); return; }
    if (tag === 'UL' || tag === 'OL') {
      // Serialize the whole list as ONE tight block: items on consecutive lines with NO blank
      // line between them. (blockChildrenToMd joins blocks with a blank line, so a blank line is
      // emitted only BEFORE/AFTER the list, not between items.) This keeps md→html→md idempotent —
      // blank-separated items would otherwise be re-parsed as separate lists, each restarting at 1.
      // A task list (ul.np-task) emits GFM checkboxes instead of plain bullets.
      var isTask = cls && cls.contains('np-task');
      var items = [];
      var n = 0;
      for (var i = 0; i < el.children.length; i++) {
        var li = el.children[i];
        if (li.tagName !== 'LI') { continue; }
        n++;
        var im = inlineBlockOfLi(li).trim();
        var pre = isTask
          ? (li.getAttribute('data-checked') === '1' ? '- [x] ' : '- [ ] ')
          : (tag === 'OL' ? (n + '. ') : '- ');
        items.push(pre + im);
      }
      if (items.length) lines.push(items.join('\\n'));
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      var bq = blockChildrenToMd(el).trim();
      if (bq === '') { lines.push('> '); return; }
      lines.push(prefixLines(bq, '> '));
      return;
    }
    if (tag === 'H1') { lines.push('# ' + inlineToMd(el).trim()); return; }
    if (tag === 'H2') { lines.push('## ' + inlineToMd(el).trim()); return; }
    if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      lines.push('### ' + inlineToMd(el).trim()); return;
    }
    // P / DIV / fallthrough: if it nests block children, recurse; else emit one paragraph line.
    if (hasBlockChild(el)) {
      var nested = blockChildrenToMd(el);
      if (nested !== '') lines.push(nested);
      return;
    }
    var md = inlineToMd(el).replace(/\\u00a0/g, ' ');
    lines.push(md);
  }
  function inlineBlockOfLi(li) {
    // A list item may itself wrap inline content (and stray <br>s) — serialize inline only.
    return inlineToMd(li).replace(/\\u00a0/g, ' ');
  }
  // Details serialize to a fenced block: an opener line ('::: ' + summary), single-newline body
  // lines, and a closing ':::' line. The body is flattened to single newlines so a details block
  // never contains a blank line — the display renderer groups blocks within one paragraph chunk.
  function detailsToMd(el, lines) {
    var sum = el.querySelector('.dt-sum');
    var dbody = el.querySelector('.dt-body');
    var sumMd = sum ? inlineToMd(sum).replace(/\\u00a0/g, ' ').replace(/\\n+/g, ' ').trim() : '';
    var bodyMd = dbody ? blockChildrenToMd(dbody).replace(/\\n{2,}/g, '\\n').trim() : '';
    // A body line that IS ':::' would close the fence early — pad it so the round-trip stays honest.
    bodyMd = bodyMd.split('\\n').map(function (l) { return l.replace(/^\\s*:::\\s*$/, ': : :'); }).join('\\n');
    lines.push('::: ' + sumMd + (bodyMd ? '\\n' + bodyMd : '') + '\\n:::');
  }
  // Tables serialize to GFM pipe rows: header, a '| --- |' separator, then body rows. Cell text is
  // flattened to one line; literal pipes are escaped so they can't split a cell on re-parse.
  function cellMd(cell) {
    return inlineToMd(cell).replace(/\\u00a0/g, ' ').replace(/\\n+/g, ' ').replace(/\\|/g, '\\\\|').trim();
  }
  function tableToMd(el, lines) {
    var table = el.querySelector('table');
    if (!table) return;
    var heads = table.querySelectorAll('thead th');
    var cols = heads.length;
    if (!cols) return;
    var out = [];
    var row = [];
    var i;
    for (i = 0; i < cols; i++) row.push(cellMd(heads[i]));
    out.push('| ' + row.join(' | ') + ' |');
    row = [];
    for (i = 0; i < cols; i++) row.push('---');
    out.push('| ' + row.join(' | ') + ' |');
    var trs = table.querySelectorAll('tbody tr');
    for (i = 0; i < trs.length; i++) {
      var tds = trs[i].querySelectorAll('td');
      row = [];
      for (var c = 0; c < cols; c++) row.push(tds[c] ? cellMd(tds[c]) : '');
      out.push('| ' + row.join(' | ') + ' |');
    }
    lines.push(out.join('\\n'));
  }
  function hasBlockChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (BLOCK[el.children[i].tagName]) return true;
    }
    return false;
  }
  function blockChildrenToMd(root) {
    var lines = [];
    var buf = '';   // accumulates inline runs between block children
    function flush() {
      if (buf !== '') { lines.push(buf.replace(/\\u00a0/g, ' ')); buf = ''; }
    }
    for (var i = 0; i < root.childNodes.length; i++) {
      var n = root.childNodes[i];
      if (n.nodeType === 1 && BLOCK[n.tagName]) {
        flush();
        blockToMd(n, lines);
      } else {
        buf += nodeInline(n);
      }
    }
    flush();
    return lines.join('\\n\\n');
  }
  // The public serializer.
  function domToMarkdown(rootEl) {
    var md = blockChildrenToMd(rootEl);
    // Normalize: collapse 3+ blank lines, trim trailing whitespace per line + overall.
    md = md.replace(/[ \\t]+(\\n)/g, '$1').replace(/\\n{3,}/g, '\\n\\n');
    return md.replace(/^\\s+|\\s+$/g, '');
  }
  window.__domToMarkdown = domToMarkdown; // exposed for debugging / tests

  // ── markdown → safe HTML (inverse, for setMarkdown) ────────────────────────
  // Inline tokens, all from ESCAPED text so nothing can inject markup. Code spans are extracted
  // into placeholders FIRST so the bold/italic/link regexes can never reinterpret markdown that
  // lives literally inside backticks (e.g. \`a*b_c[d](e)\` must round-trip verbatim); they're
  // restored after all other inline substitution. The placeholder sentinel uses \\u0000, which can
  // never appear in escaped user text.
  function inlineMd(escaped) {
    var s = escaped;
    var codes = [];
    // 1) extract inline code \`x\` → placeholder (content kept verbatim, no further substitution)
    s = s.replace(/\`([^\`]+)\`/g, function (_m, c) {
      var idx = codes.length;
      codes.push(c);
      return '\\u0000C' + idx + '\\u0000';
    });
    // 2) links [text](url) — url restricted to http(s)/nostr-ish/stiq: (our own deep-link scheme),
    // escaped already
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_m, txt, url) {
      if (!/^(https?:|nostr:|stiq:)/i.test(url.replace(/&amp;/g, '&'))) return txt;
      return '<a href="' + url + '">' + txt + '</a>';
    });
    // 3) bold **x**
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
    // 4) underline __x__
    s = s.replace(/__([^_]+)__/g, '<u>$1</u>');
    // 5) italic _x_ or *x*
    s = s.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
    // 6) restore code spans as <code> with their original (escaped) content untouched
    s = s.replace(/\\u0000C(\\d+)\\u0000/g, function (_m, idx) {
      return '<code>' + codes[+idx] + '</code>';
    });
    return s;
  }
  // Split a single line into escaped-text + chip placeholders, then style the text segments.
  function lineToHtml(line) {
    var TOKEN = /(nostr:(?:nevent1|note1|naddr1)[a-z0-9]+|\\[\\[voice:[^\\]]+\\]\\]|\\[\\[pic:[^\\]]+\\]\\]|stiq:event:[A-Za-z0-9_-]+|stiq:space:[A-Za-z0-9_-]+|stiq:msg:[A-Za-z0-9_-]+|stiq:draft:[A-Za-z0-9_-]+)/g;
    var out = '';
    var last = 0; var m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(line)) !== null) {
      if (m.index > last) out += inlineMd(esc(line.slice(last, m.index)));
      out += chipHtml(m[0]);
      last = m.index + m[0].length;
    }
    if (last < line.length) out += inlineMd(esc(line.slice(last)));
    return out;
  }
  // String form of chipEl() for markdownToHtml(): identical structure + classes. Every dynamic value
  // (token, label, duration) is esc()'d; the glyphs/bars are static — safe against markup injection.
  function chipHtml(tok) {
    var p = chipParts(tok);
    var inner;
    if (p.type === 'voice') {
      var bars = '';
      for (var i = 0; i < WF.length; i++) bars += '<i style="height:' + WF[i] + 'px"></i>';
      inner = '<span class="ci"><span class="tri"></span></span>' +
              '<span class="wf">' + bars + '</span>' +
              '<span class="cd">' + esc(fmtDur(p.dur)) + '</span>';
    } else {
      var glyph = chipGlyph(p.type);
      inner = '<span class="ci">' + glyph + '</span><span class="cl">' + esc(p.label) + '</span>';
    }
    return '<span class="chip ' + p.type + '" contenteditable="false" data-token="' + esc(tok) + '">' +
           inner + '</span>';
  }

  // Parse one GFM pipe row into trimmed cells; a backslash-escaped pipe stays literal.
  function splitTableRow(line) {
    var s = line.replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '');
    var cells = [];
    var cur = '';
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\\\' && s.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }
  // Rebuild an editable table (np-tablewrap) from its pipe rows: header, separator (skipped), body.
  // Column count follows the header; short rows pad, long rows truncate.
  function tableRowsToHtml(rows) {
    var header = splitTableRow(rows[0]);
    var cols = header.length;
    var h = '<div class="np-tablewrap" contenteditable="false"><div class="tb-scroll"><table class="np-table"><thead><tr>';
    var c;
    for (c = 0; c < cols; c++) h += '<th contenteditable="true">' + lineToHtml(header[c] || '') + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 2; r < rows.length; r++) {
      var cells = splitTableRow(rows[r]);
      h += '<tr>';
      for (c = 0; c < cols; c++) h += '<td contenteditable="true">' + lineToHtml(cells[c] || '') + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table></div>' + TB_CTRL + '</div>';
  }

  function markdownToHtml(md) {
    var text = String(md == null ? '' : md);
    var rawLines = text.replace(/\\r\\n?/g, '\\n').split('\\n');
    var html = '';
    var i = 0;
    // Tracks whether the last thing actually EMITTED was a non-editable island (.np-tablewrap /
    // .np-details) — untouched by a blank line, which emits nothing. Only insertBlockHTML used to
    // guarantee a trailing paragraph after one of these (for a fresh toolbar insert); a document that
    // reaches here (any markdown round-trip — autosave/reopen, or setMarkdown generally) had no such
    // guarantee, so a doc ending in a table/details left the DOM ending in a contenteditable="false"
    // node with nowhere for the caret to go. See the unconditional append after the loop below.
    var lastIsland = false;
    while (i < rawLines.length) {
      var line = rawLines[i];
      var trimmed = line.replace(/\\s+$/, '');
      // divider
      if (/^---\\s*$/.test(trimmed)) { html += '<hr />'; lastIsland = false; i++; continue; }
      // heading
      var h = /^(#{1,3})\\s+(.*)$/.exec(trimmed);
      if (h) {
        var lvl = h[1].length;
        html += '<h' + lvl + '>' + lineToHtml(h[2]) + '</h' + lvl + '>';
        lastIsland = false;
        i++; continue;
      }
      // v2 pullquote — consecutive '>>' lines (checked BEFORE the '>' blockquote below)
      if (/^>>\\s?/.test(trimmed)) {
        var plines = [];
        while (i < rawLines.length && /^>>\\s?/.test(rawLines[i].replace(/\\s+$/, ''))) {
          plines.push(rawLines[i].replace(/\\s+$/, '').replace(/^>>\\s?/, ''));
          i++;
        }
        html += '<blockquote class="pull">' + plines.map(lineToHtml).join('<br />') + '</blockquote>';
        lastIsland = false;
        continue;
      }
      // v2 footer small-print — consecutive '-# ' lines
      if (/^-#\\s/.test(trimmed) || trimmed === '-#') {
        var flines = [];
        while (i < rawLines.length) {
          var fl = rawLines[i].replace(/\\s+$/, '');
          if (!(/^-#\\s/.test(fl) || fl === '-#')) break;
          flines.push(fl.replace(/^-#\\s?/, ''));
          i++;
        }
        html += '<p class="np-footer">' + flines.map(lineToHtml).join('<br />') + '</p>';
        lastIsland = false;
        continue;
      }
      // v2 task list — '- [ ] item' / '- [x] item' (checked BEFORE the generic bullet below)
      if (/^-\\s+\\[[ xX]\\]/.test(trimmed)) {
        html += '<ul class="np-task">';
        while (i < rawLines.length && /^-\\s+\\[[ xX]\\]/.test(rawLines[i].replace(/\\s+$/, ''))) {
          var tl = rawLines[i].replace(/\\s+$/, '');
          var done = /^-\\s+\\[[xX]\\]/.test(tl);
          html += '<li data-checked="' + (done ? '1' : '0') + '">' +
            lineToHtml(tl.replace(/^-\\s+\\[[ xX]\\]\\s?/, '')) + '</li>';
          i++;
        }
        html += '</ul>';
        lastIsland = false;
        continue;
      }
      // v2 collapsible details — an opener ('::: summary', summary may be empty) fenced by a LATER
      // line that is exactly ':::'. Without a closing fence the line is plain paragraph text.
      if (/^:::/.test(trimmed)) {
        var close = -1;
        for (var dx = i + 1; dx < rawLines.length; dx++) {
          if (rawLines[dx].replace(/^\\s+/, '').replace(/\\s+$/, '') === ':::') { close = dx; break; }
        }
        if (close > i) {
          var dsum = trimmed.replace(/^:::\\s?/, '');
          var dlines = rawLines.slice(i + 1, close);
          var dbodyHtml = dlines.length
            ? '<p>' + dlines.map(lineToHtml).join('<br />') + '</p>'
            : '<p><br /></p>';
          html += '<div class="np-details" data-open="0" contenteditable="false">' +
            '<div class="dt-head"><span class="dt-chev">\\u25B8</span>' +
            '<div class="dt-sum" contenteditable="true">' + lineToHtml(dsum) + '</div></div>' +
            '<div class="dt-body" contenteditable="true">' + dbodyHtml + '</div></div>';
          i = close + 1;
          lastIsland = true; // .np-details is contenteditable="false" — an island (see trailing-<p> note above)
          continue;
        }
        html += '<p>' + lineToHtml(line) + '</p>';
        lastIsland = false;
        i++;
        continue;
      }
      // v2 table — a pipe row directly followed by a '| --- |' separator row
      if (/^\\|.*\\|\\s*$/.test(trimmed)) {
        var sepNext = i + 1 < rawLines.length &&
          /^\\|(?:\\s*:?-{2,}:?\\s*\\|)+\\s*$/.test(rawLines[i + 1].replace(/\\s+$/, ''));
        if (sepNext) {
          var rows = [];
          while (i < rawLines.length && /^\\|.*\\|\\s*$/.test(rawLines[i].replace(/\\s+$/, ''))) {
            rows.push(rawLines[i].replace(/\\s+$/, ''));
            i++;
          }
          html += tableRowsToHtml(rows);
          lastIsland = true; // .np-tablewrap is contenteditable="false" — an island (see trailing-<p> note above)
          continue;
        }
        html += '<p>' + lineToHtml(line) + '</p>';
        lastIsland = false;
        i++;
        continue;
      }
      // bullet list
      if (/^-\\s+/.test(trimmed)) {
        html += '<ul>';
        while (i < rawLines.length && /^-\\s+/.test(rawLines[i].replace(/\\s+$/, ''))) {
          html += '<li>' + lineToHtml(rawLines[i].replace(/^-\\s+/, '')) + '</li>';
          i++;
        }
        html += '</ul>'; lastIsland = false; continue;
      }
      // numbered list
      if (/^\\d+\\.\\s+/.test(trimmed)) {
        html += '<ol>';
        while (i < rawLines.length && /^\\d+\\.\\s+/.test(rawLines[i].replace(/\\s+$/, ''))) {
          html += '<li>' + lineToHtml(rawLines[i].replace(/^\\d+\\.\\s+/, '')) + '</li>';
          i++;
        }
        html += '</ol>'; lastIsland = false; continue;
      }
      // blockquote (consecutive "> " lines → one blockquote of paragraphs)
      if (/^>\\s?/.test(trimmed)) {
        html += '<blockquote>';
        var qparas = [];
        var cur = [];
        while (i < rawLines.length && /^>\\s?/.test(rawLines[i].replace(/\\s+$/, ''))) {
          var ql = rawLines[i].replace(/^>\\s?/, '');
          if (ql.trim() === '') { if (cur.length) { qparas.push(cur); cur = []; } }
          else { cur.push(ql); }
          i++;
        }
        if (cur.length) qparas.push(cur);
        if (qparas.length === 0) html += '<p><br /></p>';
        for (var q = 0; q < qparas.length; q++) {
          html += '<p>' + qparas[q].map(lineToHtml).join('<br />') + '</p>';
        }
        html += '</blockquote>'; lastIsland = false; continue;
      }
      // blank line → paragraph break (skip; runs are split below). Emits nothing, so it deliberately
      // leaves lastIsland untouched — a table/details followed only by trailing blank lines is
      // still, in effect, document-final.
      if (trimmed === '') { i++; continue; }
      // a paragraph: gather consecutive non-blank, non-block lines as <br>-joined lines
      var para = [];
      while (i < rawLines.length) {
        var ln = rawLines[i].replace(/\\s+$/, '');
        if (ln === '' || /^---\\s*$/.test(ln) || /^(#{1,3})\\s+/.test(ln) ||
            /^-\\s+/.test(ln) || /^\\d+\\.\\s+/.test(ln) || /^>\\s?/.test(ln) ||
            /^-#(\\s|$)/.test(ln) || /^:::/.test(ln) || /^\\|.*\\|\\s*$/.test(ln)) break;
        para.push(rawLines[i]);
        i++;
      }
      html += '<p>' + para.map(lineToHtml).join('<br />') + '</p>';
      lastIsland = false;
    }
    // A document-final table/details is a contenteditable="false" island with no editable node after
    // it — nowhere for the caret to go, and no way to start a new paragraph below it. Only a fresh
    // toolbar insert (insertBlockHTML) used to guard against this; every OTHER path into the DOM goes
    // through here (setMarkdown — autosave/reopen, or any markdown round-trip), so make it structural.
    if (lastIsland) html += '<p><br /></p>';
    return html || '<p><br /></p>';
  }
  window.__markdownToHtml = markdownToHtml; // exposed for debugging / tests (mirrors __domToMarkdown)

  // ── commands ───────────────────────────────────────────────────────────────
  function focusEd() {
    ed.focus();
    // Ensure there's a selection inside the editor so execCommand targets it.
    var sel = window.getSelection();
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
      var r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
  }
  function exec(cmd, val) {
    focusEd();
    try { document.execCommand(cmd, false, val); } catch (e) {}   // execCommand can throw for unsupported/no-op commands; failure is cosmetic (formatting simply doesn't apply)
  }
  // ── keep the selection alive across a bubble-button tap ──────────────────────
  // A tap on the floating bubble is a touch OUTSIDE the selection; Android WebViews collapse the
  // selection on such a touch (and can transiently blur), which would drop the highlight and hide
  // the bubble mid-command. We snapshot the range the instant a press begins (captureHeld, wired on
  // touchstart+mousedown) and, if the live selection was lost by the time the command runs, put it
  // back (restoreHeld) so the command targets the intended text and the bubble persists.
  function captureHeld() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0);
      if (!r.collapsed && ed.contains(r.commonAncestorContainer)) { heldRange = r.cloneRange(); }
    }
  }
  function restoreHeld() {
    if (!heldRange) return;
    var sel = window.getSelection();
    var cur = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var lost = !cur || cur.collapsed || !ed.contains(cur.commonAncestorContainer);
    if (lost) {
      try { ed.focus(); sel.removeAllRanges(); sel.addRange(heldRange); } catch (e) {}   // selection API can throw if heldRange's nodes were since removed from the doc; failure is cosmetic (selection just stays lost)
    }
  }
  // Inline code has no execCommand — wrap/unwrap the selection in <code> manually.
  function toggleCode() {
    focusEd();
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var anc = range.commonAncestorContainer;
    var node = anc.nodeType === 1 ? anc : anc.parentNode;
    var codeEl = null;
    while (node && node !== ed) {
      if (node.tagName === 'CODE') { codeEl = node; break; }
      node = node.parentNode;
    }
    if (codeEl) {
      // unwrap
      var parent = codeEl.parentNode;
      while (codeEl.firstChild) parent.insertBefore(codeEl.firstChild, codeEl);
      parent.removeChild(codeEl);
    } else {
      var text = range.toString();
      if (!text) {
        // insert an empty code placeholder and put caret inside it
        var empty = document.createElement('code');
        empty.appendChild(document.createTextNode('\\u200b'));
        range.insertNode(empty);
        var rr = document.createRange();
        rr.selectNodeContents(empty); rr.collapse(false);
        sel.removeAllRanges(); sel.addRange(rr);
      } else {
        var code = document.createElement('code');
        code.appendChild(document.createTextNode(text));
        range.deleteContents();
        range.insertNode(code);
        var r2 = document.createRange();
        r2.setStartAfter(code); r2.collapse(true);
        sel.removeAllRanges(); sel.addRange(r2);
      }
    }
    scheduleChange();
  }
  function runCommand(name) {
    restoreHeld();   // put the selection back if the bubble tap collapsed it
    switch (name) {
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'underline': exec('underline'); break;
      case 'code': toggleCode(); break;
      // Block styles all route through applyBlock — toggle-aware and class-correct for the v2
      // vocabulary (pull/np-footer/np-task/details), whether they come from the bubble or the
      // RN block sheet.
      case 'paragraph': case 'body': applyBlock('body'); return;
      case 'h1': case 'h2': case 'h3': applyBlock(name); return;
      case 'bullet': applyBlock('ul'); return;
      case 'number': applyBlock('ol'); return;
      case 'quote': case 'pull': case 'footer': case 'task': case 'details': applyBlock(name); return;
      case 'table': insertTable(); postBlockState(); return;
      case 'undo': exec('undo'); scheduleChange(); reportHeight(); updateToolbar(); postBlockState(); return;
      case 'redo': exec('redo'); scheduleChange(); reportHeight(); updateToolbar(); postBlockState(); return;
      // The bubble's Aa button: ask RN to open the native block sheet.
      case 'style': post({ type: 'blockSheet' }); return;
      case 'divider': exec('insertHorizontalRule'); break;
      case 'clear': clearFormatting(); break;
      case 'link': post({ type: 'linkRequest' }); return;
      case 'selectAll': focusEd(); try { document.execCommand('selectAll'); } catch (e) {} /* execCommand throw is cosmetic — a no-op selection */ refreshStates(); return;
      case 'copy': clip('copy'); return;
      case 'cut': clip('cut'); return;
      case 'paste': post({ type: 'clip', op: 'paste' }); return;   // RN reads the OS clipboard → insertText
      default: return;
    }
    // Reposition after the edit: Clear can turn a heading/list back into Body, reflowing the line the
    // floating bubble is anchored to. updateToolbar() re-measures (and refreshes the active states).
    scheduleChange();
    updateToolbar();
  }

  // ── clipboard: routed through RN's native clipboard (WebView execCommand('copy'|'cut'|'paste') is
  //    unreliable/blocked in a data: WebView, and navigator.clipboard needs a permission we can't get
  //    there). Copy/Cut put the selection's VISIBLE PLAIN TEXT on the OS clipboard — the range's text is
  //    exactly what's on screen, so pasting into another app (or back here) is clean, with NO markdown
  //    markers and no whitespace-trimming surprises. (Earlier this serialized to markdown to preserve
  //    chip tokens, but that made an ordinary copy→paste round-trip show literal ** _ etc. — plain
  //    text is what the user picked and what "just works".) Cut also removes the selection locally.
  //    chipTokensIn() appends any embed/voice tokens in the selection so a copied reference still
  //    carries its nostr:/[[voice:]] payload as plain text rather than only its human label. ─────────
  function chipTokensIn(range) {
    var frag = range.cloneContents();
    var chips = frag.querySelectorAll ? frag.querySelectorAll('.chip') : [];
    var toks = [];
    for (var i = 0; i < chips.length; i++) {
      var t = chips[i].getAttribute('data-token');
      if (t) toks.push(t);
    }
    return toks;
  }
  function clip(op) {
    // Source of truth = the live selection if it's still a real in-editor range, else the snapshot
    // captured the instant the bubble press began (captureHeld). On touch the tap can collapse the
    // live selection before this runs, so the snapshot is what makes copy/cut reliable. Range.toString()
    // reads the plain text straight from the range — no live selection needed.
    var sel = window.getSelection();
    var live = sel && sel.rangeCount && !sel.isCollapsed &&
      ed.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0) : null;
    var r = live || heldRange;
    if (!r || r.collapsed || !ed.contains(r.commonAncestorContainer)) return;   // nothing usable
    var text = r.toString();                                   // visible plain text of the range
    var toks = chipTokensIn(r);
    if (toks.length) text = (text ? text + '\\n' : '') + toks.join('\\n');
    if (!text) return;
    post({ type: 'clip', op: op, text: text });                // RN writes it to the OS clipboard
    if (op === 'cut') {
      try { sel.removeAllRanges(); sel.addRange(r); } catch (e) {}   // ensure the doc selection is r matches before deleting; selection API can throw on a stale range, which is cosmetic (falls through to deleteContents on r regardless)
      r.deleteContents();                                            // …then remove it
      sel.removeAllRanges();
      heldRange = null;   // the snapshot now points at removed nodes
      scheduleChange();
      reportHeight();
    }
  }
  // Insert plain text at the caret (or over the selection), preserving line breaks as <br>. Text
  // goes in via text nodes (never innerHTML), so pasted content can NEVER inject markup/script.
  // atCaret=true (the Insert-bar Paste, which has no selection intent) collapses a lingering
  // non-collapsed selection to its end first, so it inserts rather than overwriting it.
  function insertText(text, atCaret) {
    // Bubble Paste replaces the selection. The tap→RN-clipboard→insertText round-trip is async, so the
    // live selection may have collapsed in the gap; restore the snapshot first so we overwrite the
    // intended text (never for the caret-insert path, which deliberately keeps the caret where it is).
    if (!atCaret) restoreHeld();
    // Strip control chars (keep \\t and \\n) — a NUL would collide with the code-span placeholder
    // sentinel used by markdownToHtml and corrupt re-parsing; other control chars are junk. Also
    // clamp the length so a poisoned multi-megabyte OS clipboard can't freeze the JS thread.
    var raw = String(text == null ? '' : text).replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/g, '');
    if (raw.length > 100000) raw = raw.slice(0, 100000);
    focusEd();
    var sel = window.getSelection();
    var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !ed.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
    } else if (atCaret && !range.collapsed) {
      range.collapse(false);   // don't clobber a leftover selection when pasting "at the caret"
    }
    range.deleteContents();
    var frag = document.createDocumentFragment();
    var lines = raw.replace(/\\r\\n?/g, '\\n').split('\\n');
    var lastNode = null;
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) { var br = document.createElement('br'); frag.appendChild(br); lastNode = br; }
      if (lines[i] !== '') { var tn = document.createTextNode(lines[i]); frag.appendChild(tn); lastNode = tn; }
    }
    range.insertNode(frag);
    if (lastNode) {
      var after = document.createRange();
      after.setStartAfter(lastNode); after.collapse(true);
      sel.removeAllRanges(); sel.addRange(after);
    }
    heldRange = null;   // snapshot consumed by this paste
    scheduleChange();
    reportHeight();
  }

  // ── the block the selection currently sits in (for the Aa label + clear) ─────
  function currentBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var node = sel.getRangeAt(0).startContainer;
    node = node.nodeType === 1 ? node : node.parentNode;
    while (node && node !== ed) {
      var tag = node.tagName;
      if (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE' ||
          tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'P') return node;
      node = node.parentNode;
    }
    return null;
  }
  // Anchor-relative closest() constrained to the editor (null when outside it / the root itself).
  function anchorClosest(selector) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var n = sel.getRangeAt(0).startContainer;
    n = n.nodeType === 1 ? n : n.parentNode;
    var e = n && n.closest ? n.closest(selector) : null;
    return (e && ed.contains(e) && e !== ed) ? e : null;
  }
  // Swap an element's tag, keeping its children (used for UL⇄OL / task-list conversion).
  function replaceTag(node, tag) {
    var e = document.createElement(tag);
    while (node.firstChild) e.appendChild(node.firstChild);
    node.parentNode.replaceChild(e, node);
    return e;
  }
  // The current block by NAME (the v2 vocabulary) — drives the bubble's Aa label, applyBlock's
  // toggle, and the 'state' message that marks the current row in RN's block sheet.
  function currentBlockName() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 'body';
    var node = sel.getRangeAt(0).startContainer;
    node = node.nodeType === 1 ? node : node.parentNode;
    while (node && node !== ed) {
      var tag = node.tagName;
      if (tag === 'TH' || tag === 'TD') return 'table';
      if (node.classList && node.classList.contains('np-details')) return 'details';
      if (tag === 'LI') {
        var list = node.closest ? node.closest('ul,ol') : null;
        if (list && list.classList.contains('np-task')) return 'task';
        return list && list.tagName === 'OL' ? 'ol' : 'ul';
      }
      if (tag === 'UL') return node.classList.contains('np-task') ? 'task' : 'ul';
      if (tag === 'OL') return 'ol';
      if (tag === 'BLOCKQUOTE') return node.classList.contains('pull') ? 'pull' : 'quote';
      if (tag === 'H1') return 'h1';
      if (tag === 'H2') return 'h2';
      if (tag === 'H3') return 'h3';
      if (tag === 'P') return node.classList.contains('np-footer') ? 'footer' : 'body';
      node = node.parentNode;
    }
    return 'body';
  }
  var BLOCK_LABEL = { body: 'Body', h1: 'H1', h2: 'H2', h3: 'H3', quote: 'Quote', pull: 'Pull',
                      footer: 'Footer', ul: 'List', ol: 'List', task: 'Tasks', details: 'Details',
                      table: 'Table' };
  var lastBlockState = '';
  // Tell RN which block the caret sits in (the block sheet's checkmark) — only when it changes.
  function postBlockState() {
    var b = currentBlockName();
    if (b !== lastBlockState) {
      lastBlockState = b;
      post({ type: 'state', block: b });
    }
    return b;
  }

  // ── Clear (remove-formatting): strip the selection back to plain body text ───
  // list → off, block → paragraph, removeFormat, unlink, and unwrap inline <code>.
  function clearFormatting() {
    focusEd();
    var blk = currentBlock();
    if (blk) {
      // execCommand toggles the list off; it can throw for an unsupported/no-op state, which is cosmetic (list just stays as-is)
      if (blk.tagName === 'UL') {
        if (blk.classList.contains('np-task')) stripTask(blk);
        try { document.execCommand('insertUnorderedList'); } catch (e) {}
      } else if (blk.tagName === 'OL') { try { document.execCommand('insertOrderedList'); } catch (e) {} }
    }
    // Each of these execCommand calls can throw for an unsupported/no-op state; every failure is
    // cosmetic (that particular formatting step is simply skipped) so clearFormatting keeps going.
    try { document.execCommand('formatBlock', false, '<p>'); } catch (e) {}
    try { document.execCommand('removeFormat'); } catch (e) {}
    try { document.execCommand('unlink'); } catch (e) {}
    // Strip the v2 block classes too — Clear must return a pullquote/footer to a plain Body line.
    var pe = anchorClosest('p,blockquote,h1,h2,h3');
    if (pe && pe.classList) {
      pe.classList.remove('pull');
      pe.classList.remove('np-footer');
    }
    // Unwrap any inline <code> intersecting the selection.
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var range = sel.getRangeAt(0);
      var codes = ed.querySelectorAll('code');
      for (var i = 0; i < codes.length; i++) {
        var c = codes[i];
        if (range.intersectsNode ? range.intersectsNode(c) : true) {
          var parent = c.parentNode;
          while (c.firstChild) parent.insertBefore(c.firstChild, c);
          parent.removeChild(c);
        }
      }
    }
  }

  // ── reflect active inline marks + the current block onto the bubble ──────────
  function markOn(cmd, on) {
    var b = bar.querySelector('button[data-cmd="' + cmd + '"]');
    if (b) { if (on) b.classList.add('on'); else b.classList.remove('on'); }
  }
  function refreshStates() {
    try {
      markOn('bold', document.queryCommandState('bold'));
      markOn('italic', document.queryCommandState('italic'));
      markOn('underline', document.queryCommandState('underline'));
    } catch (e) {}   // queryCommandState can throw for an unsupported command; failure is cosmetic (toolbar just doesn't light up)
    // The Aa style button shows the current block's short name (the folded block-style entry).
    var b = postBlockState();
    var lab = document.getElementById('styLabel');
    if (lab) lab.textContent = BLOCK_LABEL[b] || 'Body';
  }

  // Apply/toggle a block style — from the RN block sheet (opened by the bubble's Aa button or the
  // insert bar's Aa chip). Picking the style the caret already sits in reverts to Body — a real
  // toggle, like the inline marks (plain formatBlock never toggles back on its own). Handles the
  // whole v2 vocabulary: body/h1/h2/h3/quote/pull/footer + ul/ol/task lists + collapsible details.
  function applyBlock(name) {
    restoreHeld();   // put the selection back if the bubble tap collapsed it
    var cur = currentBlockName();
    if (name === cur && name !== 'details') name = 'body';
    if (name === 'ul' || name === 'ol' || name === 'task') {
      setListBlock(name);
    } else if (name === 'details') {
      toggleDetailsBlock(cur);
    } else {
      unlist(cur);
      var target = (name === 'quote' || name === 'pull') ? 'blockquote'
        : (name === 'h1' || name === 'h2' || name === 'h3') ? name : 'p';
      exec('formatBlock', '<' + target + '>');
      var el2 = anchorClosest('p,blockquote,h1,h2,h3');
      if (el2 && el2.classList) {
        el2.classList.remove('pull');
        el2.classList.remove('np-footer');
        if (name === 'pull') el2.classList.add('pull');
        if (name === 'footer') el2.classList.add('np-footer');
      }
    }
    scheduleChange();
    updateToolbar();
    postBlockState();
    reportHeight();
  }
  // Leave any list the caret sits in (task class stripped first so a plain list never keeps it).
  function unlist(cur) {
    if (cur !== 'ul' && cur !== 'ol' && cur !== 'task') return;
    var list = anchorClosest('ul,ol');
    if (list && list.classList.contains('np-task')) stripTask(list);
    try { document.execCommand(cur === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'); } catch (e) {}   // no-op failure just leaves the list; cosmetic
  }
  function stripTask(list) {
    list.classList.remove('np-task');
    var items = list.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) items[i].removeAttribute('data-checked');
  }
  // Bullet / numbered / task switching (applyBlock already mapped a same-style tap to 'body').
  function setListBlock(tag) {
    focusEd();
    var list = anchorClosest('ul,ol');
    if (tag === 'task') {
      if (list) {
        if (list.tagName === 'OL') list = replaceTag(list, 'ul');
        list.classList.add('np-task');
      } else {
        try { document.execCommand('insertUnorderedList'); } catch (e) {}   // cosmetic on failure
        list = anchorClosest('ul');
        if (list) list.classList.add('np-task');
      }
      return;
    }
    if (list) {
      if (list.classList.contains('np-task')) stripTask(list);
      if (tag === 'ol' && list.tagName === 'UL') replaceTag(list, 'ol');
      else if (tag === 'ul' && list.tagName === 'OL') replaceTag(list, 'ul');
      return;
    }
    try { document.execCommand(tag === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'); } catch (e) {}   // cosmetic on failure
  }
  // Details — a collapsible section. Picking it wraps the caret's top-level block; picking it again
  // from inside one unwraps it (a non-empty summary becomes an H3 so no text is lost).
  function toggleDetailsBlock(cur) {
    if (cur === 'details') {
      var d = anchorClosest('.np-details');
      if (d) {
        var frag = document.createDocumentFragment();
        var sum = d.querySelector('.dt-sum');
        var dbody = d.querySelector('.dt-body');
        if (sum && sum.textContent.replace(/\\s+/g, '') !== '') {
          var hh = document.createElement('h3');
          hh.textContent = sum.textContent;
          frag.appendChild(hh);
        }
        if (dbody) { while (dbody.firstChild) frag.appendChild(dbody.firstChild); }
        d.parentNode.replaceChild(frag, d);
      }
      return;
    }
    var blk = topBlock();
    // The wrapped block comes from the editor's OWN DOM (the safe element set) — not raw user text.
    var inner = blk ? blk.outerHTML : '<p><br /></p>';
    var html = '<div class="np-details" data-open="1" contenteditable="false">' +
      '<div class="dt-head"><span class="dt-chev">\\u25B8</span><div class="dt-sum" contenteditable="true"></div></div>' +
      '<div class="dt-body" contenteditable="true">' + inner + '</div></div>';
    if (blk && blk.parentNode === ed) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html + '<p><br /></p>';
      var first = tmp.firstChild;
      while (tmp.firstChild) ed.insertBefore(tmp.firstChild, blk);
      blk.parentNode.removeChild(blk);
      var ns = first.querySelector('.dt-sum');
      if (ns) ns.focus();
    } else {
      try { document.execCommand('insertHTML', false, html + '<p><br /></p>'); } catch (e) {}   // cosmetic on failure
    }
  }
  // Nearest ancestor that is a DIRECT child of the editor root.
  function topBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var n = sel.getRangeAt(0).startContainer;
    while (n && n !== ed && n.parentNode !== ed) n = n.parentNode;
    return (n && n !== ed) ? n : null;
  }
  // If the caret sits inside an embedded island (table cell / details), structural inserts must not
  // nest — move the caret just after that block first.
  function escapeIsland() {
    var wrap = anchorClosest('.np-tablewrap, .np-details');
    if (!wrap) return;
    var nxt = wrap.nextElementSibling;
    if (!nxt || nxt.tagName !== 'P') {
      var p = document.createElement('p');
      p.innerHTML = '<br />';
      wrap.parentNode.insertBefore(p, wrap.nextSibling);
      nxt = p;
    }
    var sel = window.getSelection();
    var r = document.createRange();
    r.selectNodeContents(nxt);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function insertBlockHTML(html) {
    focusEd();
    escapeIsland();
    try { document.execCommand('insertHTML', false, html + '<p><br /></p>'); } catch (e) {}   // cosmetic on failure
    scheduleChange();
    reportHeight();
  }
  // The floating add-row / add-column / remove controls a live table carries (see the .live CSS).
  var TB_CTRL = '<button class="tb-add tb-addcol" contenteditable="false" aria-label="Add column">\\uFF0B</button>' +
    '<button class="tb-add tb-addrow" contenteditable="false" aria-label="Add row">\\uFF0B</button>' +
    '<button class="tb-del" contenteditable="false" aria-label="Remove table">\\u2715</button>';
  function tableHtml(rows, cols) {
    var h = '<div class="np-tablewrap" contenteditable="false"><div class="tb-scroll"><table class="np-table"><thead><tr>';
    var c;
    for (c = 0; c < cols; c++) h += '<th contenteditable="true"></th>';
    h += '</tr></thead><tbody>';
    for (var r = 0; r < rows; r++) {
      h += '<tr>';
      for (c = 0; c < cols; c++) h += '<td contenteditable="true"></td>';
      h += '</tr>';
    }
    return h + '</tbody></table></div>' + TB_CTRL + '</div>';
  }
  function insertTable() { insertBlockHTML(tableHtml(2, 3)); }
  function addTableCol(wrap) {
    if (!wrap) return;
    var trs = wrap.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var cell = document.createElement(trs[i].parentNode.tagName === 'THEAD' ? 'th' : 'td');
      cell.setAttribute('contenteditable', 'true');
      trs[i].appendChild(cell);
    }
    scheduleChange();
    reportHeight();
  }
  function addTableRow(wrap) {
    if (!wrap) return;
    var cols = wrap.querySelectorAll('thead th').length || 3;
    var tbody = wrap.querySelector('tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    for (var i = 0; i < cols; i++) {
      var td = document.createElement('td');
      td.setAttribute('contenteditable', 'true');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    scheduleChange();
    reportHeight();
  }

  // Insert a chip (embed/voice token) at the caret. Never inside a table cell or details island —
  // the feed's media segmenter runs over the whole body, so a token inside a fenced block would
  // split that block's lines across segments and break its render. escapeIsland hops out first.
  function insertToken(tok) {
    if (!isChipToken(tok)) return;
    focusEd();
    escapeIsland();
    var sel = window.getSelection();
    var range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !ed.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
    }
    range.deleteContents();
    var chip = chipEl(tok);
    var space = document.createTextNode('\\u00a0');
    range.insertNode(space);
    range.insertNode(chip);
    var after = document.createRange();
    after.setStartAfter(space); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);
    scheduleChange();
  }

  // Insert a link [text](url) at the caret (from RN's link sheet). stiq: is the app's own deep-link
  // scheme (stiq://join…, stiq://channel/…) — accepted alongside http(s)/nostr: so join/invite links
  // can be shared inline; javascript:/data:/etc. remain rejected.
  function insertLink(text, url) {
    if (!/^(https?:|nostr:|stiq:)/i.test(String(url || ''))) return;
    focusEd();
    var sel = window.getSelection();
    var range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !ed.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
    }
    var a = document.createElement('a');
    a.setAttribute('href', String(url));
    a.textContent = String(text || url);
    range.deleteContents();
    range.insertNode(a);
    var after = document.createRange();
    after.setStartAfter(a); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);
    scheduleChange();
  }

  // ── apply markdown coming from RN ──────────────────────────────────────────
  function setMarkdown(md) {
    applying = true;
    try {
      // markdownToHtml only ever returns the safe element set; text is escaped within.
      ed.innerHTML = markdownToHtml(md);
      syncDir(ed); // tag the freshly-parsed blocks (incl. lists/quotes from a draft) with dir="auto"
    } finally {
      applying = false;
    }
    lastMd = domToMarkdown(ed); // sync echo guard to what's now shown
    reportHeight();
  }

  // ── inbound messages from RN (both window + document for Android) ───────────
  // Defensive origin/source guard: RN delivers its bridge messages by dispatching a 'message'
  // event IN-PAGE (source is this window, or null on some Android builds). Reject anything that
  // carries a foreign source (e.g. a postMessage from a parent/child frame) so only the RN bridge
  // can drive the editor. We never run with frames, but this closes the listener defensively.
  function onHostMessage(ev) {
    if (!ev) return;
    var src = ev.source;
    if (src != null && src !== window) return;       // foreign window/frame → ignore
    var data = ev.data;
    if (typeof data !== 'string') return;            // RN bridge is always a JSON string
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return; // only the RN bridge {type,...} shape
    switch (msg.type) {
      case 'setMarkdown': setMarkdown(msg.md || ''); break;
      case 'cmd': runCommand(msg.name); break;
      case 'insertToken': insertToken(msg.token || ''); break;
      case 'insertLink': insertLink(msg.text, msg.url); break;
      case 'insertText': insertText(msg.text || '', !!msg.atCaret); break;
      case 'flush': flushNow(); break;
      case 'focus': focusEd(); break;
      default: break;
    }
  }
  window.addEventListener('message', onHostMessage);
  document.addEventListener('message', onHostMessage);

  // ── local UI wiring ────────────────────────────────────────────────────────
  // Snapshot the selection the instant a bubble press BEGINS — touchstart fires before the WebView
  // reacts to the touch, so we capture the live range before anything can collapse it. mousedown
  // also preventDefaults (desktop + as a second line of defence) to keep the caret while tapping.
  bar.addEventListener('touchstart', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b) captureHeld();
  }, {passive: true});
  bar.addEventListener('mousedown', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b) { captureHeld(); e.preventDefault(); } // keep the editor selection while tapping the toolbar
  });
  bar.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    e.preventDefault();
    // Two button kinds: a block button (H2/H3/quote) toggles that block style; everything else is an
    // inline mark (B/I/U/clear) or a clipboard action (copy/cut/paste).
    var block = b.getAttribute('data-block');
    if (block) { applyBlock(block); return; }
    runCommand(b.getAttribute('data-cmd'));
  });
  ed.addEventListener('input', scheduleChange);
  ed.addEventListener('keyup', function () { reportHeight(); });
  window.addEventListener('resize', reportHeight);

  // ── in-body interactions for the v2 blocks ─────────────────────────────────
  // Task checkboxes toggle on a tap in the box zone (inline-start 30px, RTL-aware); a details
  // header expands/collapses; the floating table controls add a row/column or remove the table.
  ed.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var li = t.closest('ul.np-task li');
    if (li && ed.contains(li)) {
      var r = li.getBoundingClientRect();
      var rtl = false;
      try { rtl = getComputedStyle(li).direction === 'rtl'; } catch (err) {}   // cosmetic — LTR zone fallback
      var hit = rtl ? (r.right - e.clientX < 30) : (e.clientX - r.left < 30);
      if (hit) {
        li.setAttribute('data-checked', li.getAttribute('data-checked') === '1' ? '0' : '1');
        scheduleChange();
        return;
      }
    }
    var head = t.closest('.np-details .dt-head');
    if (head && (t.classList.contains('dt-chev') || t === head)) {
      var d = head.closest('.np-details');
      d.setAttribute('data-open', d.getAttribute('data-open') === '1' ? '0' : '1');
      reportHeight();
      return;
    }
    if (t.classList.contains('tb-addcol')) { addTableCol(t.closest('.np-tablewrap')); return; }
    if (t.classList.contains('tb-addrow')) { addTableRow(t.closest('.np-tablewrap')); return; }
    if (t.classList.contains('tb-del')) {
      var w = t.closest('.np-tablewrap');
      if (w && w.parentNode) {
        w.parentNode.removeChild(w);
        scheduleChange();
        reportHeight();
      }
      return;
    }
  });
  // Table edit controls follow the caret: only the table being edited shows its +row/+col/remove.
  ed.addEventListener('focusin', function (e) {
    var wrap = e.target && e.target.closest ? e.target.closest('.np-tablewrap') : null;
    var wraps = ed.querySelectorAll('.np-tablewrap');
    for (var i = 0; i < wraps.length; i++) {
      if (wraps[i] === wrap) wraps[i].classList.add('live');
      else wraps[i].classList.remove('live');
    }
  });
  // Enter escapes an island the browser has no useful default for:
  //  (1) in a details summary, it moves into the body instead of splitting the header row;
  //  (2) in the LAST cell of a document-final table, it hops OUT to the trailing paragraph. A table's
  //      wrapper is contenteditable="false", so a plain Enter inside a cell has nowhere to go once
  //      the table is the very last thing in the doc — reuses escapeIsland(), the same fix-up
  //      insertBlockHTML already relies on for a fresh insert (see markdownToHtml's own trailing-<p>
  //      guarantee above for the OTHER half of this bug: a table/details reached via setMarkdown).
  ed.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var sum = e.target && e.target.closest ? e.target.closest('.dt-sum') : null;
    if (sum) {
      e.preventDefault();
      var d = sum.closest('.np-details');
      var b = d ? d.querySelector('.dt-body') : null;
      if (b) {
        d.setAttribute('data-open', '1');
        b.focus();
      }
      return;
    }
    var cell = e.target && e.target.closest ? e.target.closest('td, th') : null;
    if (!cell) return;
    var wrap = cell.closest('.np-tablewrap');
    if (!wrap || wrap.nextElementSibling) return;   // not a table, or not document-final
    var cells = wrap.querySelectorAll('td, th');
    if (!cells.length || cell !== cells[cells.length - 1]) return;   // only the very last cell
    e.preventDefault();
    escapeIsland();
    scheduleChange();
  });

  // Float the bubble centered just ABOVE the selection, flipping BELOW when there's no headroom and
  // clamping within the viewport — the geometry the OS bubble used. Coordinates are viewport px
  // (getBoundingClientRect) and the bar is position:fixed, so both share one frame; #ed scrolling is
  // handled by re-running updateToolbar on scroll. Must run AFTER the bar is display:flex so its
  // measured width/height are real.
  function positionBubble(r) {
    var rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return false;
    var bw = bar.offsetWidth, bh = bar.offsetHeight;
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var vh = document.documentElement.clientHeight || window.innerHeight || 0;
    var left = rect.left + rect.width / 2 - bw / 2;
    if (left > vw - bw - 6) left = vw - bw - 6;
    if (left < 6) left = 6;                       // also wins when bw > viewport (pinned left, scrolls)
    var top = rect.top - bh - 8;                  // above the selection…
    if (top < 6) top = rect.bottom + 8;           // …or below it when the top is too tight
    if (top > vh - bh - 6) top = Math.max(6, vh - bh - 6);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    return true;
  }

  // The bubble is shown ONLY while a non-empty selection is active inside the editor, and hidden the
  // moment the selection collapses or focus leaves. The bar's mousedown handler above preventDefaults,
  // so tapping a format button keeps the selection (and the bar) alive.
  function updateToolbar() {
    var sel = window.getSelection();
    var r = null;
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      var rr = sel.getRangeAt(0);
      if (ed.contains(rr.startContainer) && ed.contains(rr.endContainer) &&
          String(sel).replace(/\\s/g, '').length > 0) {
        r = rr;
      }
    }
    if (r) {
      bar.classList.add('sel');   // display:flex first so positionBubble can measure the bar
      refreshStates();
      if (!positionBubble(r)) bar.classList.remove('sel');
    } else {
      bar.classList.remove('sel');
    }
  }
  // Drive visibility off selectionchange: collapsing the selection (tapping elsewhere in the text)
  // hides the bar. We deliberately do NOT hide on 'blur' — on touch WebViews a format-button tap can
  // transiently blur the editor, and hiding the bar mid-tap would swallow the button press. Also
  // reposition as the editor or window scrolls so the bubble stays glued to the selected text.
  document.addEventListener('selectionchange', function () {
    updateToolbar();
    postBlockState();   // keep RN's block sheet current even for a collapsed caret
  });
  function repositionIfShown() { if (bar.classList.contains('sel')) updateToolbar(); }
  ed.addEventListener('scroll', repositionIfShown);
  window.addEventListener('scroll', repositionIfShown, true);
  window.addEventListener('resize', repositionIfShown);

  // ── ready ──────────────────────────────────────────────────────────────────
  lastMd = '';
  post({ type: 'ready' });
  reportHeight();
})();
</script>
</body>
</html>`;
}
