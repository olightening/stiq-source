/**
 * Posting guidelines — the organizer's "rules at the point of posting" doc (design
 * design_handoff_community_rules + design_handoff_post_editor_v2): a short rules blurb shown in a
 * collapsible banner at the top of the composer, plus the full, versioned community covenant opened
 * from it (sections + a "what changed" diff of the last revision).
 *
 * Delivered as a kind-30078 doc (d=stiq:posting-guidelines) signed by the organizer — the same
 * privileged config path as post rules / labels / the log page, so a moderator or member can never
 * overwrite it. Absent doc ⇒ null ⇒ the composer shows no banner and no ⓘ button (an un-configured
 * community looks exactly like today).
 *
 * Versioning contract (mirrored by the organizer dashboard): `ver` bumps ONLY when the covenant's
 * CONTENT changes — the client re-opens the banner for a member exactly once per version (seen-state
 * is persisted locally per space, see guidelinesSeen.ts).
 */

export const KIND_POSTING_GUIDELINES = 30078;
export const POSTING_GUIDELINES_D_TAG = 'stiq:posting-guidelines';

/** One row of the "what changed" diff: `~` a change, `+` an addition. */
export interface GuidelinesDiffRow {
  sign: '~' | '+';
  text: string;
}

/** One covenant section: an uppercase heading + its bullet items. */
export interface CovenantSection {
  heading: string;
  items: string[];
}

export interface PostingGuidelines {
  /** Covenant revision, ≥1. Bumps only on content change (dashboard-enforced). */
  version: number;
  /** Unix seconds of the last content change (shown as "updated Jun 30"). */
  updatedAt: number;
  /** The short rules blurb for the composer banner (≤{@link MAX_BLURB_ITEMS} lines). */
  blurb: string[];
  /** The full covenant, section by section. */
  sections: CovenantSection[];
  /** The latest revision's diff, or null when none was written. */
  diff: {from: number; rows: GuidelinesDiffRow[]} | null;
}

// Caps — mirrored by the organizer dashboard's sanitizer (issuer/organizer-server.mjs). A doc that
// exceeds them is CLAMPED, not rejected, so a slightly-over hand-published doc still renders.
export const MAX_BLURB_ITEMS = 4;
export const MAX_BLURB_CHARS = 200;
export const MAX_SECTIONS = 8;
export const MAX_SECTION_HEADING_CHARS = 80;
export const MAX_SECTION_ITEMS = 10;
export const MAX_SECTION_ITEM_CHARS = 300;
export const MAX_DIFF_ROWS = 6;
export const MAX_DIFF_ROW_CHARS = 220;

/** Compact on-wire shape (kind-30078 content). */
interface GuidelinesWire {
  v?: number;
  ver?: number;
  at?: number;
  b?: unknown[];
  sec?: {h?: unknown; it?: unknown[]}[];
  df?: {f?: unknown; rows?: unknown[]};
}

function cleanLine(v: unknown, maxChars: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, maxChars) : '';
}

function posInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 0;
}

export function parsePostingGuidelines(raw: unknown): PostingGuidelines | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as GuidelinesWire;
  if (w.v !== 1) return null;
  const version = posInt(w.ver);
  const updatedAt = posInt(w.at);
  if (!version || !updatedAt) return null;

  const blurb = (Array.isArray(w.b) ? w.b : [])
    .map(x => cleanLine(x, MAX_BLURB_CHARS))
    .filter(x => x !== '')
    .slice(0, MAX_BLURB_ITEMS);

  const sections: CovenantSection[] = (Array.isArray(w.sec) ? w.sec : [])
    .map(sec => {
      if (!sec || typeof sec !== 'object') return null;
      const heading = cleanLine(sec.h, MAX_SECTION_HEADING_CHARS);
      const items = (Array.isArray(sec.it) ? sec.it : [])
        .map(x => cleanLine(x, MAX_SECTION_ITEM_CHARS))
        .filter(x => x !== '')
        .slice(0, MAX_SECTION_ITEMS);
      return heading && items.length > 0 ? {heading, items} : null;
    })
    .filter((sec): sec is CovenantSection => sec !== null)
    .slice(0, MAX_SECTIONS);

  // An empty doc (nothing to show) parses to null so the banner/ⓘ hide entirely.
  if (blurb.length === 0 && sections.length === 0) return null;

  let diff: PostingGuidelines['diff'] = null;
  if (w.df && typeof w.df === 'object') {
    const rows: GuidelinesDiffRow[] = (Array.isArray(w.df.rows) ? w.df.rows : [])
      .map(row => {
        if (!Array.isArray(row)) return null;
        const sign = row[0] === '~' || row[0] === '+' ? (row[0] as '~' | '+') : null;
        const text = cleanLine(row[1], MAX_DIFF_ROW_CHARS);
        return sign && text ? {sign, text} : null;
      })
      .filter((row): row is GuidelinesDiffRow => row !== null)
      .slice(0, MAX_DIFF_ROWS);
    const from = posInt(w.df.f);
    if (rows.length > 0) diff = {from: from || Math.max(1, version - 1), rows};
  }

  return {version, updatedAt, blurb, sections, diff};
}

export function encodePostingGuidelines(g: PostingGuidelines): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    v: 1,
    ver: g.version,
    at: g.updatedAt,
    b: g.blurb,
    sec: g.sections.map(sec => ({h: sec.heading, it: sec.items})),
  };
  if (g.diff) wire.df = {f: g.diff.from, rows: g.diff.rows.map(r => [r.sign, r.text])};
  return wire;
}

/** Parse a kind-30078 event's content into PostingGuidelines (null if malformed/empty). */
export function parsePostingGuidelinesEvent(content: string): PostingGuidelines | null {
  try {
    return parsePostingGuidelines(JSON.parse(content));
  } catch {
    return null;
  }
}
