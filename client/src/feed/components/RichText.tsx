/**
 * RichText — minimal, dependency-free Markdown renderer for post & comment bodies.
 *
 * Inline: **bold**, _italic_/*italic*, __underline__, `code`, `## headings`, nostr: @mentions, and
 * links. Links flow INLINE as tappable chips (🔗 title, underlined, link-coloured) that hand the URL
 * to the app-root link dialog — matching the design `.link-chip`. Quoted-post embeds (nostr:) and
 * images render as blocks beneath the text.
 */
import React, {useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle} from 'react-native';
import * as nip19 from 'nostr-tools/nip19';
import {Press} from '../../ui/Press';
import {colors, type as typeScale} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {openLinkDialog} from '../../ui/openLink';
import {prettyDomain} from '../../util/url';
import {ImagePlaceholderCard} from './ImagePlaceholderCard';
import {VoicePlayer} from './VoicePlayer';
import {stripInlineVoices, hasInlineVoice, type VoiceMessage} from '../voice';
import {PictureChip} from './PictureChip';
import {stripInlinePictures, hasInlinePicture, type InlinePicture} from '../picture';
import {segmentInlineMedia, type BodySegment} from '../inlineMedia';
import {NostrLinkPreview, type NostrEventSummary} from '../../ui/NostrLinkPreview';
import {decodeNameHeader} from '../../profile/displayName';
import {dirAlign, firstStrongDir} from '../../ui/textDirection';
import type {ImageMeta} from '../../nostr/imeta';
import {SPACE_EMBED_RE} from '../../channels/spaceEmbed';
import {MSG_EMBED_RE} from '../../channels/msgEmbed';
import {DRAFT_EMBED_RE} from '../draftEmbed';
import {INVITE_LINK_RE} from '../../channels/invite';
import {EVENT_EMBED_RE} from '../../events/eventEmbed';

/** NIP-21/27: a nostr:npub…/nprofile… mention → a short @handle for the chip. */
function mentionHandle(token: string): string {
  try {
    const ref = token.replace(/^nostr:/, '');
    const decoded = nip19.decode(ref);
    const pubkey = decoded.type === 'npub' ? (decoded.data as string)
      : decoded.type === 'nprofile' ? decoded.data.pubkey
      : null;
    if (!pubkey) return '@…';
    const npub = nip19.npubEncode(pubkey);
    return `@${npub.slice(4, 12)}…`;
  } catch {
    return '@…';
  }
}

export interface RichTextProps {
  content: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Resolve a quoted post (NIP-18/27 nostr:nevent…/note…) for an inline embed card. */
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  /** Open a quoted post when its embed card is tapped. */
  onOpenNostrPost?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card → run the in-app accept-invite flow with the RAW url. */
  onOpenInviteLink?: (url: string) => void;
  /** Density for a `stiq:event:` embed card — 'Feed' in feed post bodies (PostCard/post detail),
   * 'Compact' (default) everywhere else (group messages, DMs, comments). */
  eventDensity?: 'Feed' | 'Compact';
  /** Structured image metadata (NIP-94 `imeta`). Bare image URLs in the body are merged in. */
  imageMetas?: ImageMeta[];
  /** Vertical gap between paragraphs (design article body = 15). Ignored when clamped. */
  paragraphSpacing?: number;
  /**
   * Collapse line breaks into spaces so a preview body flows and fills every line (feed cards),
   * instead of breaking early and leaving the card half-empty. Matches the mockup's
   * `white-space: normal` cards. Full article/detail bodies omit this to keep paragraph breaks.
   */
  flow?: boolean;
  /**
   * Enable native text selection on the body's prose — long-press starts a selection, then the
   * system floating bar offers Copy / Select-all (exactly the reader-copy gesture). Defaults to ON
   * for a FULL body (post detail, comment, chat bubble, channel message) and OFF for a clamped or
   * flowed feed teaser, whose tap opens the post — selecting inside it would fight that gesture.
   * Pass explicitly to override either default.
   */
  selectable?: boolean;
  /**
   * Which surface this body is painted on. Defaults to the app background; `'onAccent'` repaints the
   * BLOCK CHROME for an accent-filled surface — today, your own chat bubble (see ChatBubble's `mine`
   * branch). Without it a heading, blockquote, pullquote, footer, checkbox or table you sent renders
   * in the feed's dark `textPrimary` on the accent fill, i.e. very nearly illegible: the `style` prop
   * recolours the PROSE, but every block construct carries its own hardcoded colour.
   */
  tone?: RichTextTone;
}

/** The surface a body is painted on — see {@link RichTextProps.tone}. */
export type RichTextTone = 'default' | 'onAccent';

/**
 * The block-chrome keys that carry a hardcoded colour and therefore have to follow the surface.
 * Everything else in `s` is a metric (size, padding, border WIDTH) and is tone-neutral.
 */
type ToneKey =
  | 'h1' | 'h2' | 'h3'
  | 'bulletGlyph' | 'olIndex'
  | 'quoteBar' | 'quoteText'
  | 'hr'
  | 'pullRule' | 'pullText'
  | 'footer' | 'footerText'
  | 'taskBox' | 'taskBoxChecked' | 'taskCheck' | 'taskTextChecked'
  | 'details' | 'detailsChevron' | 'detailsSummary' | 'detailsBody' | 'detailsBodyText'
  | 'tableWrap' | 'tableCellHead' | 'tableCellBorder' | 'tableHeadText' | 'tableBodyText'
  | 'code' | 'mention' | 'linkChip';

/** Applied as `[s.x, tone.x]`, so an ABSENT key means "this one is already right". */
type ToneOverrides = Partial<Record<ToneKey, TextStyle>>;

const TONE_DEFAULT: ToneOverrides = {};

// On an accent fill there is no second ink to reach for — the palette's `onAccent` is the only
// guaranteed-legible one — so every rule, border and fill becomes a translucent white rather than a
// named grey, and the "muted" tier becomes the same ink at reduced opacity.
const ACCENT_RULE = 'rgba(255,255,255,0.28)';
const ACCENT_FILL = 'rgba(255,255,255,0.12)';
const TONE_ON_ACCENT: ToneOverrides = {
  h1: {color: colors.onAccent},
  h2: {color: colors.onAccent},
  h3: {color: colors.onAccent},
  bulletGlyph: {color: colors.onAccent, opacity: 0.75},
  olIndex: {color: colors.onAccent, opacity: 0.75},
  quoteBar: {backgroundColor: ACCENT_RULE},
  quoteText: {color: colors.onAccent, opacity: 0.86},
  hr: {backgroundColor: ACCENT_RULE},
  pullRule: {backgroundColor: ACCENT_RULE},
  pullText: {color: colors.onAccent},
  footer: {borderTopColor: ACCENT_RULE},
  footerText: {color: colors.onAccent, opacity: 0.72},
  taskBox: {borderColor: ACCENT_RULE, backgroundColor: ACCENT_FILL},
  // Checked flips to a SOLID onAccent box with the accent showing through the tick — the inverse of
  // the default tone, where the accent is the fill and onAccent is the tick.
  taskBoxChecked: {backgroundColor: colors.onAccent, borderColor: colors.onAccent},
  taskCheck: {color: colors.accent},
  taskTextChecked: {color: colors.onAccent, opacity: 0.6},
  details: {borderColor: ACCENT_RULE, backgroundColor: ACCENT_FILL},
  detailsChevron: {color: colors.onAccent, opacity: 0.72},
  detailsSummary: {color: colors.onAccent},
  detailsBody: {borderTopColor: ACCENT_RULE},
  detailsBodyText: {color: colors.onAccent},
  tableWrap: {borderColor: ACCENT_RULE},
  tableCellHead: {backgroundColor: ACCENT_FILL},
  tableCellBorder: {borderRightColor: ACCENT_RULE, borderBottomColor: ACCENT_RULE},
  tableHeadText: {color: colors.onAccent, opacity: 0.8},
  tableBodyText: {color: colors.onAccent},
  code: {color: colors.onAccent},
  mention: {color: colors.onAccent},
  linkChip: {color: colors.onAccent, textDecorationColor: ACCENT_RULE},
};

const toneStyles = (tone: RichTextTone | undefined): ToneOverrides =>
  tone === 'onAccent' ? TONE_ON_ACCENT : TONE_DEFAULT;

// Inline style tokens (links handled separately).
const INLINE =
  /(nostr:(?:npub1|nprofile1)[a-z0-9]+|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g;
const MENTION = /^nostr:(?:npub1|nprofile1)[a-z0-9]+$/;
const IMAGE_MD = /!\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)/g;
const IMAGE_EXT = /\.(?:jpg|jpeg|png|gif|webp)(?:[?#]\S*)?$/i;
// Markdown link or bare URL.
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s]+)/g;
// Quoted-post refs, PLUS a self-contained `stiq:space:…` channel/group card token (see spaceEmbed.ts)
// AND a `stiq://channel/<id>` invite link (see invite.ts) — each built from its own RE's source so a
// pattern has exactly one definition (bug #12 lesson: every detector must recognize the token, and
// they must never drift from each other). All three render as trailing embed cards.
const EMBED_RE = new RegExp(
  `nostr:(?:nevent1|note1|naddr1)[a-z0-9]+|${SPACE_EMBED_RE.source}|${INVITE_LINK_RE.source}|${EVENT_EMBED_RE.source}|${MSG_EMBED_RE.source}|${DRAFT_EMBED_RE.source}`,
  'g',
);

/** Apply bold/italic/underline/code/mention styling to a plain run of text. */
function renderStyled(text: string, keyBase: string, t: ToneOverrides): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    const key = `${keyBase}-${i++}`;
    if (MENTION.test(part)) {
      out.push(<Text key={key} style={[s.mention, t.mention]}>{mentionHandle(part)}</Text>);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<Text key={key} style={s.bold}>{part.slice(2, -2)}</Text>);
    } else if (part.startsWith('__') && part.endsWith('__')) {
      out.push(<Text key={key} style={s.underline}>{part.slice(2, -2)}</Text>);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      out.push(<Text key={key} style={[s.code, t.code]}>{part.slice(1, -1)}</Text>);
    } else if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      out.push(<Text key={key} style={s.italic}>{part.slice(1, -1)}</Text>);
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Render a run of text with inline link chips interleaved with styled text. */
function renderInline(
  text: string,
  keyBase: string,
  onLinkPress: (url: string, title: string) => void,
  t: ToneOverrides,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const [full, mdLabel, mdUrl, bareUrl] = m;
    const offset = m.index;
    if (offset > last) out.push(...renderStyled(text.slice(last, offset), `${keyBase}-${i++}`, t));
    const url = (mdUrl ?? bareUrl) as string;
    const label = mdLabel ?? prettyDomain(url);
    out.push(
      <Text key={`${keyBase}-lk${i++}`} style={[s.linkChip, t.linkChip]} onPress={() => onLinkPress(url, label)}>
        <Text style={s.lcIc}>🔗</Text>{' '}{label}
      </Text>,
    );
    last = offset + full.length;
  }
  if (last < text.length) out.push(...renderStyled(text.slice(last), `${keyBase}-${i++}`, t));
  return out;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
function renderLine(
  line: string,
  key: string,
  onLinkPress: (url: string, title: string) => void,
  t: ToneOverrides,
): React.ReactNode {
  const h = HEADING.exec(line);
  if (h) {
    const level = (h[1] ?? '#').length;
    const hStyle = level === 1 ? [s.h1, t.h1] : level === 2 ? [s.h2, t.h2] : [s.h3, t.h3];
    // A heading is its own <Text>, so it carries its own first-strong direction (Arabic heading
    // right-aligns RTL, English heading stays LTR) independent of the surrounding paragraphs.
    return <Text style={[hStyle, dirAlign(firstStrongDir(h[2] ?? ''))]}>{renderInline(h[2] ?? '', key, onLinkPress, t)}</Text>;
  }
  return renderInline(line, key, onLinkPress, t);
}

// ── Block grouping ───────────────────────────────────────────────────────────────────────────────
//
// Beyond inline marks + headings, the shared markdown dialect has line/block constructs that span
// (or stand apart from) a paragraph: bullet lists, numbered lists, blockquotes, and dividers. These
// can't live inside a single flowing <Text> (they need accent bars, indents, sequential numbers), so
// we first group consecutive lines into typed blocks, then render each block as its own element.

const BULLET = /^[-*]\s+(.*)$/; // "- item" or "* item"
const ORDERED = /^\d+\.\s+(.*)$/; // "1. item", "2. item", …
const QUOTE = /^>\s?(.*)$/; // "> quoted"
const DIVIDER = /^(?:---|\*\*\*)$/; // a line that is exactly --- or ***
// ">> pull quote" (also a bare ">>"). MUST be tested before QUOTE above — QUOTE's own `>\s?` would
// otherwise happily eat the first `>` of a `>>` line and mistake it for an ordinary blockquote.
const PULLQUOTE = /^>>\s?(.*)$/;
const FOOTER = /^-#\s+(.*)$/; // "-# small print"
// "- [ ] item" / "- [x] item" (capital X ok). MUST be tested before BULLET — BULLET's `-\s+` would
// otherwise swallow the same line and render "[ ] item"/"[x] item" as a literal bullet's text.
const TASK = /^-\s+\[([ xX])\]\s+(.*)$/;
const TABLE_ROW = /^\|.*\|\s*$/; // "|cell|cell|"
const TABLE_SEP = /^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/; // "|---|:--:|--:|" header/body divider row

export type Block =
  | {kind: 'text'; lines: string[]}
  | {kind: 'ul'; items: string[]}
  | {kind: 'ol'; items: string[]}
  | {kind: 'quote'; lines: string[]}
  | {kind: 'hr'}
  | {kind: 'pull'; lines: string[]}
  | {kind: 'footer'; lines: string[]}
  | {kind: 'task'; items: {checked: boolean; text: string}[]}
  | {kind: 'details'; summary: string; body: string[]}
  | {kind: 'table'; header: string[]; rows: string[][]};

/**
 * Split one "|a|b\|c|" table row into its cells: strip exactly one leading and one trailing `|`,
 * then split on a `|` that is NOT escaped (`\|` unescapes to a literal pipe inside a cell), and trim
 * each cell. Assumes `line` already matched {@link TABLE_ROW} (so it has a leading and trailing `|`
 * once trailing whitespace is trimmed).
 */
function splitTableRow(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  return inner.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

/**
 * Pad a short row with '' so it has exactly `count` cells. NEVER truncates — a body row longer than
 * the header used to have its extra cells silently dropped; groupBlocks now derives `count` as the
 * WIDEST row (header included), so a long body row instead grows every other row (including the
 * header) out to meet it, and no cell a user typed is ever discarded.
 */
function padTableRow(cells: string[], count: number): string[] {
  return cells.length >= count ? cells : [...cells, ...Array(count - cells.length).fill('')];
}

/**
 * Group a body's lines into typed blocks. Consecutive list/quote/task/pull/footer lines coalesce
 * into one block each; "---"/"***" become a divider; a `:::…`/`:::` pair becomes a collapsible
 * details block; a pipe-row + separator-row pair opens a table (consuming every consecutive pipe row
 * after it); everything else accumulates into a flowing text block (where headings and plain
 * paragraphs are rendered per-line by renderLine). Pure + exported for tests.
 *
 * An index loop, not a for..of: table and details both need to look AHEAD past the current line (a
 * separator row; a later bare ":::" closer) and, once found, swallow a variable run of lines in one
 * step — a per-line iterator can't express either.
 */
export function groupBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let text: string[] | null = null;
  const flushText = (): void => {
    if (text && text.length > 0) blocks.push({kind: 'text', lines: text});
    text = null;
  };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trimEnd();
    let m: RegExpExecArray | null;

    // Table: a "|cell|cell|" row is only a table when the VERY NEXT line is a separator row — a
    // stray "|" in ordinary prose (with no separator under it) must fall through to plain text.
    if (TABLE_ROW.test(trimmed) && TABLE_SEP.test((lines[i + 1] ?? '').trimEnd())) {
      flushText();
      const header = splitTableRow(trimmed);
      i += 2; // skip the header row + the separator row
      const rawRows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test((lines[i] ?? '').trimEnd())) {
        rawRows.push(splitTableRow((lines[i] ?? '').trimEnd()));
        i++;
      }
      // Column count follows the WIDEST row, not the header: a body row with more cells than the
      // header used to have its extras truncated away. Padding the header (and every shorter row) up
      // to that width instead means a user's data always survives — the header just grows an extra
      // blank column rather than eating the overflow.
      const width = rawRows.reduce((w, r) => Math.max(w, r.length), header.length);
      blocks.push({
        kind: 'table',
        header: padTableRow(header, width),
        rows: rawRows.map(r => padTableRow(r, width)),
      });
      continue;
    }

    // Collapsible details: a "::: summary" (or bare ":::") opener is only a details block when a
    // LATER line in this chunk is exactly ":::" (trimmed) — its closer. No closer anywhere ahead
    // means this was never a details block at all, so it falls through to plain text below.
    if (trimmed.startsWith(':::')) {
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if ((lines[j] ?? '').trim() === ':::') { closeIdx = j; break; }
      }
      if (closeIdx !== -1) {
        flushText();
        blocks.push({kind: 'details', summary: trimmed.slice(3).trim(), body: lines.slice(i + 1, closeIdx)});
        i = closeIdx + 1;
        continue;
      }
    }

    if (DIVIDER.test(trimmed)) {
      flushText();
      blocks.push({kind: 'hr'});
    } else if ((m = PULLQUOTE.exec(trimmed))) {
      flushText();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'pull') prev.lines.push(m[1] ?? '');
      else blocks.push({kind: 'pull', lines: [m[1] ?? '']});
    } else if ((m = FOOTER.exec(trimmed))) {
      flushText();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'footer') prev.lines.push(m[1] ?? '');
      else blocks.push({kind: 'footer', lines: [m[1] ?? '']});
    } else if ((m = TASK.exec(trimmed))) {
      flushText();
      const item = {checked: m[1] !== ' ', text: m[2] ?? ''};
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'task') prev.items.push(item);
      else blocks.push({kind: 'task', items: [item]});
    } else if ((m = BULLET.exec(trimmed))) {
      flushText();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'ul') prev.items.push(m[1] ?? '');
      else blocks.push({kind: 'ul', items: [m[1] ?? '']});
    } else if ((m = ORDERED.exec(trimmed))) {
      flushText();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'ol') prev.items.push(m[1] ?? '');
      else blocks.push({kind: 'ol', items: [m[1] ?? '']});
    } else if ((m = QUOTE.exec(trimmed))) {
      flushText();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'quote') prev.lines.push(m[1] ?? '');
      else blocks.push({kind: 'quote', lines: [m[1] ?? '']});
    } else {
      (text ??= []).push(raw);
    }
    i++;
  }
  flushText();
  return blocks;
}

/** Render one grouped block (list / quote / divider / flowing text) as an element. */
function renderBlock(
  block: Block,
  key: string,
  style: StyleProp<TextStyle>,
  onLinkPress: (url: string, title: string) => void,
  selectable: boolean,
  t: ToneOverrides,
): React.ReactNode {
  switch (block.kind) {
    case 'hr':
      return <View key={key} style={[s.hr, t.hr]} />;
    case 'ul':
      return (
        <View key={key} style={s.list}>
          {block.items.map((item, i) => (
            <View key={i} style={s.bulletRow}>
              <Text style={[s.bulletGlyph, t.bulletGlyph]}>{'• '}</Text>
              <Text style={[style, s.listText]} selectable={selectable}>{renderInline(item, `${key}i${i}`, onLinkPress, t)}</Text>
            </View>
          ))}
        </View>
      );
    case 'ol':
      return (
        <View key={key} style={s.list}>
          {block.items.map((item, i) => (
            <View key={i} style={s.bulletRow}>
              <Text style={[s.olIndex, t.olIndex]}>{`${i + 1}. `}</Text>
              <Text style={[style, s.listText]} selectable={selectable}>{renderInline(item, `${key}i${i}`, onLinkPress, t)}</Text>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View key={key} style={s.quoteBlock}>
          <View style={[s.quoteBar, t.quoteBar]} />
          <Text style={[style, s.quoteText, t.quoteText]} selectable={selectable}>
            {block.lines.map((line, li) => (
              <Text key={li}>{li > 0 ? '\n' : ''}{renderInline(line, `${key}l${li}`, onLinkPress, t)}</Text>
            ))}
          </Text>
        </View>
      );
    case 'pull':
      // Pullquote (design .pullquote): a centred serif-italic emphasis line, bracketed by a short
      // hairline above and below rather than the quote block's left accent bar.
      return (
        <View key={key} style={s.pull}>
          <View style={[s.pullRule, t.pullRule, s.pullRuleTop]} />
          <Text style={[s.pullText, t.pullText]} selectable={selectable}>
            {block.lines.map((line, li) => (
              <Text key={li}>{li > 0 ? '\n' : ''}{renderInline(line, `${key}l${li}`, onLinkPress, t)}</Text>
            ))}
          </Text>
          <View style={[s.pullRule, t.pullRule, s.pullRuleBottom]} />
        </View>
      );
    case 'footer':
      // Footer / small print (design .footer): a hairline-topped strip of muted caption text.
      return (
        <View key={key} style={[s.footer, t.footer]}>
          <Text style={[s.footerText, t.footerText]} selectable={selectable}>
            {block.lines.map((line, li) => (
              <Text key={li}>{li > 0 ? '\n' : ''}{renderInline(line, `${key}l${li}`, onLinkPress, t)}</Text>
            ))}
          </Text>
        </View>
      );
    case 'task':
      // Task list — display-only (never interactive here): a checkbox glyph column + item text,
      // struck through and muted once checked. Mirrors ul/ol's marker-column + inline-text shape.
      return (
        <View key={key} style={s.task}>
          {block.items.map((item, i) => (
            <View key={i} style={s.taskRow}>
              <View style={[s.taskBox, t.taskBox, item.checked && [s.taskBoxChecked, t.taskBoxChecked]]}>
                {item.checked && <Text style={[s.taskCheck, t.taskCheck]}>{'✓'}</Text>}
              </View>
              <Text
                style={[style, s.taskText, item.checked && [s.taskTextChecked, t.taskTextChecked]]}
                selectable={selectable}>
                {renderInline(item.text, `${key}i${i}`, onLinkPress, t)}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'details':
      // Collapsible details needs its own open/closed state, so it's a real component rather than a
      // static element (see DetailsBlock below).
      return <DetailsBlock key={key} summary={block.summary} body={block.body} onLinkPress={onLinkPress} selectable={selectable} t={t} />;
    case 'table': {
      // Table (design .table-wrap): a bordered grid inside a horizontal ScrollView so a wide table
      // scrolls in place rather than clipping or squeezing every column unreadably thin. The column
      // widths are computed ONCE, shared by every row (see tableColumnWidths) — without that, header
      // and body rows were independent flex rows that sized column N off only THEIR OWN cell's text,
      // so columns drifted out of alignment row to row.
      const colWidths = tableColumnWidths(block.header, block.rows);
      return (
        <View key={key} style={[s.tableWrap, t.tableWrap]}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              {renderTableRow(block.header, `${key}h`, true, block.rows.length === 0, onLinkPress, selectable, t, colWidths)}
              {block.rows.map((row, ri) =>
                renderTableRow(row, `${key}r${ri}`, false, ri === block.rows.length - 1, onLinkPress, selectable, t, colWidths),
              )}
            </View>
          </ScrollView>
        </View>
      );
    }
    default:
      return (
        <Text key={key} style={style} selectable={selectable}>
          {block.lines.map((line, li) => (
            <Text key={li}>{li > 0 ? '\n' : ''}{renderLine(line, `${key}l${li}`, onLinkPress, t)}</Text>
          ))}
        </Text>
      );
  }
}

// Column sizing constants for tableColumnWidths — a deterministic, content-length model (not a
// measured/onLayout one) so header and body cells can be given the SAME width in one pass, before
// anything renders, and so the model stays a plain pure function that's trivial to assert on in a
// test (no waiting on a native layout pass).
const TABLE_CELL_MIN = 104; // matches the old flat minWidth — short cells still get a comfortable floor
const TABLE_CELL_MAX = 220; // cap so one huge cell can't blow the whole table out; it wraps instead
const TABLE_CELL_CHAR_PX = 7.2; // rough advance width per character at the table's font size
const TABLE_CELL_PAD = 24; // paddingHorizontal(12) * 2 — RN sizes width/maxWidth as the outer box

/**
 * One width per column, shared by the header AND every body row — the fix for the misalignment bug:
 * previously each row was an independent flex row, so column N's rendered width came from only THAT
 * row's own cell text, and header/body columns drifted apart whenever their cell N text lengths
 * differed. Sizing off the widest cell in each column (clamped to [MIN, MAX]) means every row's
 * cell N is IDENTICAL in width, and a cell whose text still exceeds the cap wraps (via the cell's
 * `maxWidth`) instead of clipping mid-word or only being reachable by scrolling.
 */
export function tableColumnWidths(header: string[], rows: string[][]): number[] {
  const cols = header.length;
  const widths = new Array<number>(cols).fill(TABLE_CELL_MIN);
  const consider = (cells: string[]): void => {
    for (let ci = 0; ci < cols; ci++) {
      const text = cells[ci] ?? '';
      const w = Math.min(TABLE_CELL_MAX, Math.max(TABLE_CELL_MIN, Math.ceil(text.length * TABLE_CELL_CHAR_PX) + TABLE_CELL_PAD));
      if (w > (widths[ci] ?? 0)) widths[ci] = w;
    }
  };
  consider(header);
  rows.forEach(consider);
  return widths;
}

/** Render one table row (header or body) — a cell per column, bordered on every side but the last. */
function renderTableRow(
  cells: string[],
  key: string,
  isHeader: boolean,
  isLastRow: boolean,
  onLinkPress: (url: string, title: string) => void,
  selectable: boolean,
  t: ToneOverrides,
  colWidths: number[],
): React.ReactNode {
  return (
    <View key={key} style={s.tableRow}>
      {cells.map((cell, ci) => (
        <View
          key={ci}
          style={[
            s.tableCell,
            // The shared per-column width (see tableColumnWidths) — every row's cell `ci` gets the
            // exact same width/maxWidth, so header and body columns can never drift apart, and text
            // that overflows the cap wraps instead of clipping.
            {width: colWidths[ci] ?? TABLE_CELL_MIN, maxWidth: colWidths[ci] ?? TABLE_CELL_MIN},
            isHeader && [s.tableCellHead, t.tableCellHead],
            ci < cells.length - 1 && [s.tableCellBorderRight, t.tableCellBorder],
            !isLastRow && [s.tableCellBorderBottom, t.tableCellBorder],
          ]}>
          <Text
            style={isHeader ? [s.tableHeadText, t.tableHeadText] : [s.tableBodyText, t.tableBodyText]}
            selectable={selectable}>
            {renderInline(cell, `${key}c${ci}`, onLinkPress, t)}
          </Text>
        </View>
      ))}
    </View>
  );
}

interface DetailsBlockProps {
  summary: string;
  body: string[];
  onLinkPress: (url: string, title: string) => void;
  /** Make the expanded body's prose selectable (long-press → Copy / Select-all). */
  selectable: boolean;
  /** Surface-dependent block-chrome overrides — see {@link RichTextProps.tone}. */
  t: ToneOverrides;
}

/**
 * Collapsible `:::summary … :::` block (design <details>). Ships COLLAPSED — that's the design
 * contract, not a default that happens to start false — so a reader always chooses to expand it
 * rather than being handed the spoiler up front.
 */
function DetailsBlock({summary, body, onLinkPress, selectable, t}: DetailsBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={[s.details, t.details]}>
      <Press variant="row" style={s.detailsHead} onPress={() => setOpen(o => !o)}>
        <Text style={[s.detailsChevron, t.detailsChevron, open && s.detailsChevronOpen]}>{'▸'}</Text>
        <Text style={[s.detailsSummary, t.detailsSummary]}>{summary || 'Details'}</Text>
      </Press>
      {open && (
        <View style={[s.detailsBody, t.detailsBody]}>
          <Text style={[s.detailsBodyText, t.detailsBodyText]} selectable={selectable}>
            {body.map((line, li) => (
              <Text key={li}>{li > 0 ? '\n' : ''}{renderInline(line, `db${li}`, onLinkPress, t)}</Text>
            ))}
          </Text>
        </View>
      )}
    </View>
  );
}

/** The pure product of parsing a body: what to render, independent of styling & callbacks. */
export interface ParsedRichText {
  /** Body text with identity headers, voice tokens, embeds, and image URLs stripped out. */
  text: string;
  /** Whether {@link text} has any visible content. */
  hasText: boolean;
  /**
   * Inline voice clips (document order), rendered as lazy player bars. Like {@link pics}, these are
   * REFERENCES: each carries only its metadata (mime/duration/waveform) plus a source saying where
   * the audio lives, so parsing a body never touches a clip's payload. The bytes are fetched on the
   * first press of play.
   *
   * (This used to read "rendered as player blocks", against pictures' "lazy chips" — a real asymmetry
   * that this described accurately: a voice clip WAS eagerly parsed and fully staged at parse time
   * while a picture waited for a tap. Both modalities are now lazy, through one shared machine.)
   */
  voices: VoiceMessage[];
  /** Inline pictures (document order), rendered as lazy chips. */
  pics: InlinePicture[];
  /**
   * The body split into ordered text runs + inline media (pictures/voice), so a FULL view can render
   * each media chip exactly where it occurs in the text. Previews ignore this and collect the media
   * at the bottom instead (see {@link RichText}).
   */
  segments: BodySegment[];
  /** Extracted quoted-post embed URIs (nostr:nevent/note/naddr), rendered as cards. */
  embeds: string[];
  /** Merged image list (NIP-94 imeta + bare/markdown image URLs from the body). */
  imageList: ImageMeta[];
}

/** Normalize a text chunk for rendering: collapse blank-line runs + repeated spaces, trim edges. */
function cleanChunk(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
}

/**
 * Parse a body into its renderable pieces — a pure function of the input text and image metadata,
 * so it can be memoized on those alone (styling, clamping, and link callbacks don't affect it).
 * This is the expensive part of a render: decodeNameHeader + several full-body regex passes
 * (embeds, images, links, whitespace collapse). Memoizing it (see {@link RichText}) means a host
 * re-render that only changes styles/callbacks — e.g. a composer keystroke re-rendering a whole
 * transcript — no longer re-parses every message body. Exported for tests.
 */
export function parseRichText(content: string, imageMetas?: ImageMeta[]): ParsedRichText {
  const rawBody = decodeNameHeader(content).text;
  // Pull quoted-post embeds (nostr:nevent/note/naddr) + image URLs OUT of the body (they render as
  // trailing cards, never as raw text) — but KEEP inline picture/voice tokens in place so they can be
  // positioned within the text (embeds/images don't overlap the `[[…]]` media tokens).
  const embeds: string[] = [];
  const withoutEmbeds = rawBody.replace(EMBED_RE, m => { embeds.push(m); return ''; });
  const images: string[] = [];
  let work = withoutEmbeds.replace(IMAGE_MD, (_m, url: string) => { images.push(url); return ''; });
  work = work.replace(LINK_RE, (full, _md: string | undefined, _mdUrl: string | undefined, bareUrl: string | undefined) => {
    if (bareUrl && IMAGE_EXT.test(bareUrl)) { images.push(bareUrl); return ''; }
    return full;
  });

  // Split the remaining body into an ordered run of text + inline media (No.9 voice + pictures), so a
  // full view can place each chip where it actually sits in the prose.
  const segments: BodySegment[] =
    hasInlineVoice(work) || hasInlinePicture(work)
      ? segmentInlineMedia(work)
      : [{type: 'text', value: work}];
  const voices: VoiceMessage[] = segments.flatMap(seg => (seg.type === 'voice' ? [seg.voice] : []));
  const pics: InlinePicture[] = segments.flatMap(seg => (seg.type === 'pic' ? [seg.pic] : []));

  // Prose-only text (media tokens stripped) for previews + the hasText gate. Collapse runs and trim
  // leading/trailing blank lines so a body that starts with newlines doesn't render an empty gap.
  const stripped =
    voices.length > 0 || pics.length > 0 ? stripInlineVoices(stripInlinePictures(work)) : work;
  const text = cleanChunk(stripped);
  const hasText = text.trim().length > 0;

  const imageList: ImageMeta[] = [...(imageMetas ?? [])];
  const seen = new Set(imageList.map(m => m.url));
  for (const url of images) if (!seen.has(url)) { seen.add(url); imageList.push({url}); }

  return {text, hasText, voices, pics, segments, embeds, imageList};
}

/**
 * Preview-only (feed teaser) line transform: the full/detail path gives the 5 block constructs
 * above their own chrome (checkbox rows, a collapsible card, a bordered grid, …), but a clamped or
 * flowed teaser has no room for any of that AND must never leak their raw markdown syntax onto the
 * card. So a teaser instead gets one compact line per construct — `☑ item`, a dropped `-#`/`>>`
 * marker, `▸ summary`, or `▦ Table` for an entire pipe-row run. Pure, single pass over the lines, and
 * exported for tests; wired in ONLY on RichText's non-full render path (see below) — full bodies
 * never call this and keep their real blocks untouched.
 */
export function previewCompactLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trimEnd();
    let m: RegExpExecArray | null;
    if (TABLE_ROW.test(trimmed) && TABLE_SEP.test((lines[i + 1] ?? '').trimEnd())) {
      // Collapse the WHOLE run of consecutive pipe rows (header + separator + every body row) into
      // one line — a teaser has no grid to show it in.
      out.push('▦ Table');
      i += 2;
      while (i < lines.length && TABLE_ROW.test((lines[i] ?? '').trimEnd())) i++;
      continue;
    }
    if ((m = TASK.exec(trimmed))) {
      out.push(`${m[1] === ' ' ? '☐' : '☑'} ${m[2] ?? ''}`);
    } else if ((m = PULLQUOTE.exec(trimmed))) {
      out.push(m[1] ?? '');
    } else if ((m = FOOTER.exec(trimmed))) {
      out.push(m[1] ?? '');
    } else if (trimmed.startsWith(':::')) {
      // Only a non-empty opener gets a compact line; a bare ":::" (an empty-summary opener, or a
      // closer) contributes nothing to the teaser.
      const summary = trimmed.slice(3).trim();
      if (summary) out.push(`▸ ${summary}`);
    } else {
      out.push(line);
    }
    i++;
  }
  return out.join('\n');
}

export function RichText({
  content,
  style,
  numberOfLines,
  onLookupEvent,
  onOpenNostrPost,
  onOpenInviteLink,
  eventDensity,
  imageMetas,
  paragraphSpacing,
  flow,
  selectable,
  tone,
}: RichTextProps): React.JSX.Element {
  // Tapping an inline link hands it to the app-root dialog ([[../../ui/LinkDialog]]) — the one place
  // that decides where a link opens. This body renders links; it never opens them itself.
  const onLinkPress = (url: string, title: string): void => openLinkDialog({url, title});
  // Block-chrome overrides for the surface this body is painted on. Two frozen module constants, so
  // this is a reference pick, not an allocation — safe to read on every render.
  const t = toneStyles(tone);

  // Memoize the expensive parse (decodeNameHeader + several whole-body regex passes) on its ONLY
  // inputs — the content string and image metadata. Everything below (styling, clamping, link
  // callbacks) is cheap element assembly. This is prop-driven, not a module cache, so it can't leak
  // across posts: a different content string is a different memo. Result: a host that re-renders
  // for unrelated reasons (a composer keystroke re-rendering the whole transcript) reuses the parse.
  const metaKey = imageMetas ? imageMetas.map(m => m.url).join('|') : '';
  const {text, hasText, voices, pics, segments, embeds, imageList} = useMemo(
    () => parseRichText(content, imageMetas),
    // metaKey is the stable derived key for imageMetas (parse depends only on the image URLs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, metaKey],
  );

  // Paragraph blocks (real 15px gaps) only when unclamped AND a spacing is requested; otherwise a
  // single clamp-friendly Text.
  const asParagraphs = !numberOfLines && !!paragraphSpacing;
  // A FULL body (post detail, comment, chat bubble) is unclamped and not collapsed into one flowed
  // line. There, lists / quotes / dividers render as their own block elements (accent bars, indents,
  // sequential numbers), AND inline media (pictures / voice) is placed EXACTLY where it sits in the
  // prose. A clamped/flowed teaser (feed card) instead keeps a single Text so numberOfLines can clamp
  // and white-space:normal cards fill every line, and collects its media at the bottom (below).
  const full = !numberOfLines && !flow;
  // Reader-copy: selection defaults ON for a full body (a post/comment/message being read) and OFF
  // for a clamped/flowed teaser (whose tap opens the post). A caller can force either way.
  const canSelect = selectable ?? full;

  // Render one text chunk (a run of prose between inline media) as paragraphs-with-spacing or grouped
  // blocks. Returns null for an empty/whitespace-only chunk so media that abuts media leaves no gap.
  const renderTextChunk = (chunk: string, keyBase: string): React.ReactNode => {
    const chunkText = cleanChunk(chunk);
    if (!chunkText) return null;
    if (asParagraphs) {
      // PER-PARAGRAPH direction: each paragraph resolves its OWN first-strong direction so an Arabic
      // paragraph right-aligns RTL while an adjacent English one stays LTR. The direction rides on the
      // text style passed into renderBlock, so the inline runs (bold/link/mention) inherit it.
      const paras = chunkText.split(/\n{2,}/).filter(p => p.trim().length > 0);
      return paras.map((para, pi) => {
        const blocks = groupBlocks(para.split('\n'));
        const wrapStyle = pi < paras.length - 1 ? {marginBottom: paragraphSpacing} : null;
        const paraStyle = [style, dirAlign(firstStrongDir(para))];
        return (
          <View key={`${keyBase}p${pi}`} style={wrapStyle}>
            {blocks.map((b, bi) => renderBlock(b, `${keyBase}p${pi}b${bi}`, paraStyle, onLinkPress, canSelect, t))}
          </View>
        );
      });
    }
    // Group line/block constructs (lists, quotes, dividers) as blocks. Direction from first-strong.
    const blocks = groupBlocks(chunkText.split('\n'));
    const blockStyle = [style, dirAlign(firstStrongDir(chunkText))];
    return (
      <View key={keyBase}>{blocks.map((b, bi) => renderBlock(b, `${keyBase}b${bi}`, blockStyle, onLinkPress, canSelect, t))}</View>
    );
  };

  let bodyContent: React.ReactNode = null;
  if (full) {
    // Interleave text + media in document order: a picture/voice chip renders right where it was
    // inserted, not appended after the whole body.
    bodyContent = segments.map((seg, i) => {
      if (seg.type === 'pic') return <PictureChip key={`seg${i}`} picture={seg.pic} />;
      if (seg.type === 'voice') return <VoicePlayer key={`seg${i}`} voice={seg.voice} />;
      return renderTextChunk(seg.value, `seg${i}`);
    });
  } else if (hasText) {
    // Preview-only: compact the 5 new block constructs into single lines (see previewCompactLines)
    // BEFORE the flow-collapse/split below — a teaser has no room for their real block chrome and
    // must never leak their raw markdown syntax. Applies to both the flowed and clamped variants;
    // the `full` branch above never touches this and keeps its real blocks.
    const compact = previewCompactLines(text);
    // A flowed preview collapses newlines into spaces so the teaser fills every line instead of
    // breaking early (matches the mockup's white-space:normal cards). Unflowed bodies keep breaks.
    // This is a single collapsed <Text>, so it can carry only one direction — use the first
    // paragraph's first-strong direction (the teaser's lead).
    const lines = (flow ? compact.replace(/\s*\n+\s*/g, ' ') : compact).split('\n');
    bodyContent = (
      <Text style={[style, dirAlign(firstStrongDir(compact))]} numberOfLines={numberOfLines} selectable={canSelect}>
        {lines.map((line, li) => (
          <Text key={li}>{li > 0 ? '\n' : ''}{renderLine(line, `l${li}`, onLinkPress, t)}</Text>
        ))}
      </Text>
    );
  }

  return (
    <View>
      {bodyContent}
      {/* PREVIEW/teaser only: voice + picture chips collect at the bottom of the card (so a picture
          added at the START of a post shows UNDER the teaser). In FULL mode they're already inline. */}
      {!full && voices.map((v, i) => (
        <VoicePlayer key={`voice-${i}`} voice={v} />
      ))}
      {!full && pics.map((p, i) => (
        <PictureChip key={`pic-${i}`} picture={p} />
      ))}
      {imageList.map((m, i) => (
        <ImagePlaceholderCard key={`img-${i}`} meta={m} />
      ))}
      {embeds.map((uri, i) => (
        <NostrLinkPreview key={`em-${i}`} uri={uri} onLookup={onLookupEvent} onOpen={onOpenNostrPost} onOpenInvite={onOpenInviteLink} eventDensity={eventDensity} />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  bold: {fontWeight: '700'},
  italic: {fontStyle: 'italic', fontWeight: '400'},
  underline: {textDecorationLine: 'underline', fontWeight: '400'},
  code: {fontFamily: fonts.mono, color: colors.link},
  mention: {color: colors.accent, fontWeight: '600'},
  h1: {fontSize: typeScale.heading, fontWeight: '700', color: colors.textPrimary},
  h2: {fontSize: typeScale.subheading, fontWeight: '700', color: colors.textPrimary},
  h3: {fontSize: typeScale.body, fontWeight: '600', color: colors.textPrimary},

  // Bullet / numbered lists — a marker column + the inline-rendered item text.
  list: {marginVertical: 4},
  bulletRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3},
  bulletGlyph: {color: colors.textSecondary, fontWeight: '700'},
  olIndex: {color: colors.textSecondary, fontWeight: '600', fontVariant: ['tabular-nums']},
  listText: {flex: 1},

  // Blockquote — a left accent bar + muted italic text (design quoted block).
  quoteBlock: {flexDirection: 'row', marginVertical: 6},
  quoteBar: {width: 3, borderRadius: 2, backgroundColor: colors.accent, marginRight: 10, alignSelf: 'stretch'},
  quoteText: {flex: 1, fontStyle: 'italic', color: colors.textSecondary},

  // Divider — a thin horizontal rule.
  hr: {height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12},

  // Pullquote (design .pullquote) — centred serif-italic emphasis, bracketed by a short hairline
  // above and below rather than the blockquote's left accent bar.
  pull: {marginVertical: 12, alignItems: 'center'},
  pullRule: {width: 44, height: 1, backgroundColor: colors.borderLight},
  pullRuleTop: {marginBottom: 10},
  pullRuleBottom: {marginTop: 10},
  pullText: {
    fontFamily: fonts.serif,
    fontStyle: 'italic',
    fontWeight: '600',
    fontSize: 19,
    lineHeight: 27,
    color: colors.textPrimary,
    textAlign: 'center',
  },

  // Footer / small print (design .footer) — a hairline-topped strip of muted caption text.
  footer: {borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, marginTop: 14, marginBottom: 6},
  footerText: {fontSize: 13, lineHeight: 20, color: colors.textMuted},

  // Task list — a marker column (checkbox, not a glyph) + item text; struck through once checked.
  task: {marginVertical: 4},
  taskRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3},
  taskBox: {
    width: 19,
    height: 19,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.borderLight,
    backgroundColor: colors.surfaceAlt,
    marginRight: 11,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskBoxChecked: {backgroundColor: colors.accent, borderColor: colors.accent},
  taskCheck: {color: colors.onAccent, fontSize: 12, fontWeight: '700'},
  taskText: {flex: 1},
  taskTextChecked: {color: colors.textMuted, textDecorationLine: 'line-through'},

  // Collapsible details (design <details>) — a bordered card; the body only mounts while open.
  details: {borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surfaceAlt, marginVertical: 8},
  detailsHead: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 11, paddingHorizontal: 13},
  detailsChevron: {fontSize: 11, color: colors.textMuted},
  detailsChevronOpen: {transform: [{rotate: '90deg'}]},
  detailsSummary: {fontWeight: '600', fontSize: 15.5, color: colors.textPrimary, flex: 1},
  detailsBody: {borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9, paddingHorizontal: 13, paddingBottom: 12},
  detailsBodyText: {fontSize: 15, lineHeight: 22, color: colors.textPrimary},

  // Table (design .table-wrap) — a bordered grid, horizontally scrollable so a wide table scrolls
  // in place instead of clipping or squeezing every column unreadably thin.
  tableWrap: {borderWidth: 1, borderColor: colors.border, borderRadius: 12, marginVertical: 8, overflow: 'hidden'},
  tableRow: {flexDirection: 'row'},
  // width/maxWidth are set per-cell inline (see renderTableRow / tableColumnWidths) — a shared
  // per-column model so header and body rows can never drift apart.
  tableCell: {paddingVertical: 9, paddingHorizontal: 12},
  tableCellHead: {backgroundColor: colors.surfaceAlt},
  tableCellBorderRight: {borderRightWidth: 1, borderRightColor: colors.border},
  tableCellBorderBottom: {borderBottomWidth: 1, borderBottomColor: colors.border},
  tableHeadText: {fontWeight: '600', fontSize: 13, color: colors.textSecondary},
  tableBodyText: {fontSize: 14, lineHeight: 20, color: colors.textPrimary},

  // Inline link chip (design .link-chip) + its 🔗 prefix (.lc-ic: faded, slightly smaller)
  linkChip: {color: colors.link, fontWeight: '500', textDecorationLine: 'underline', textDecorationColor: 'rgba(158,198,255,0.42)'},
  lcIc: {opacity: 0.8, fontSize: 12},
});
