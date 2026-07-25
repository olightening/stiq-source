/**
 * Draft embed tokens — a PREVIEW POINTER to an unpublished piece of writing, gated behind the
 * owner's approval. Mirrors channels/spaceEmbed.ts + events/eventEmbed.ts — same base64url wire
 * discipline, same never-throws parse, same "every renderer must recognize the token" bug-#12
 * lesson.
 *
 * v2 (current): the token carries only what's safe to show BEFORE access is granted — a stable
 * `id` (the draftId a `DraftAccessRequest`/`DraftDelivery` anchor to, see feed/draftAccess.ts), a
 * title, a short excerpt, and the author's identity. It does NOT carry the body, tags, label, or
 * content warning — those live only in the sealed `DraftDelivery` the owner sends once they approve
 * a request. This reverses v1's design (see below) deliberately: a token that carries the whole
 * body can't be gated by anything downstream, since anyone holding it already has everything.
 *
 * v1 (retired, kept only so `parseDraftEmbed` can recognize and reject it cleanly): the original
 * shipped shape was fully self-contained — "the token IS the content", no id, no gating, the whole
 * body/tags/label/CW inline. A v1 token predates access control entirely and cannot be retrofitted
 * (there is nothing to anchor a request/grant to), so it is treated as **broken by design** — see
 * `parseDraftEmbed`'s `'legacy'` result.
 *
 * Wire format: `stiq:draft:<base64url(JSON)>`.
 *   v2: `{v:2, id, ti?, sn, p?, an?, ag?}`
 *   v1 (legacy, rejected): `{v:1, ti?, b, tg?, l?, cw?, p?, an?, ag?}`
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';
import {sanitizeSpaceName, sanitizeBody} from '../channels/spaceEmbed';

/** Unicode bidi-override/isolate characters (U+202A-U+202E, U+2066-U+2069) can make a title render
 * misleadingly reversed or with nested direction runs; zero-width characters (U+200B-U+200D, U+FEFF)
 * can hide characters entirely. A local copy of spaceEmbed.ts's own set: that module's regex isn't
 * exported, and it's not worth exporting just to share four character classes across two clamps. */
const BIDI_AND_ZERO_WIDTH_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

/** ASCII control characters (incl. newline/tab/CR, U+0000-U+001F and U+007F) — a title is a single
 * display line, never multi-line. */
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/g;

/** Scheme + namespace prefix every draft embed token starts with. */
export const DRAFT_EMBED_PREFIX = 'stiq:draft:';

/** Matches a draft embed token inside a longer body of text (base64url charset, no padding). */
export const DRAFT_EMBED_RE = /stiq:draft:[A-Za-z0-9_-]+/g;

/** A decoded draft embed pointer — everything the TEASER needs, fully offline. The full body only
 * ever arrives via a `DraftDelivery` once the owner approves a request for `id` (draftAccess.ts). */
export interface DraftRef {
  /** The stable draft/share id — what a `DraftAccessRequest`/`DraftDelivery` anchors to. */
  id: string;
  title?: string;
  /** A short, non-sensitive preview of the writing (NOT the full body). */
  excerpt: string;
  /** Original author's hex pubkey, if carried (drives the identity chip + gradient seed). */
  author?: string;
  authorName?: string;
  authorGradient?: GradientSpec;
}

/** Compact wire shape actually JSON-encoded into the v2 token. */
interface DraftEmbedWireV2 {
  v: 2;
  id: string;
  ti?: string; // title
  sn: string; // excerpt/snippet
  p?: string; // author pubkey (hex)
  an?: string; // author name
  ag?: string; // author gradient (encodeGradient)
}

/** Excerpt clamp — a teaser, not the writing itself. Generous enough to be a real hook, short
 * enough that it never leaks meaningful content pre-approval. */
export const MAX_DRAFT_EXCERPT_LEN = 160;

/** Payload cap — comfortably above a clamped excerpt + a title + identity fields; anything larger
 * is corrupt or adversarial and is rejected before base64/JSON work. */
const MAX_PAYLOAD_LEN = 2048;

const MAX_ID_LEN = 128;
const MAX_TITLE_LEN = 200;
const MAX_NAME_LEN = 80;

/**
 * Sanitizes + clamps a decoded draft title to {@link MAX_TITLE_LEN} (200). A title is carried
 * through the same untrusted wire as a space/message name, so it gets the same control/bidi/
 * zero-width stripping `sanitizeSpaceName` applies — but NOT that function's own 80-char clamp,
 * which is `spaceEmbed.ts`'s own constant for a channel/group name and unrelated to a draft title's
 * declared 200-char budget. (Previously this module ran a title through `sanitizeSpaceName` for the
 * sanitizing, which silently re-clamped it to 80 as a side effect — this gives the title its own
 * clamp instead, local to this module, so `sanitizeSpaceName`'s 80-char behavior for its actual
 * callers is untouched.)
 */
function sanitizeDraftTitle(s: string): string {
  return s
    .replace(ASCII_CONTROL_RE, '')
    .replace(BIDI_AND_ZERO_WIDTH_RE, '')
    .slice(0, MAX_TITLE_LEN)
    .trim();
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const rem = base64.length % 4;
  const padded = rem === 0 ? base64 : base64 + '='.repeat(4 - rem);
  return base64ToBytes(padded);
}

/** True when an excerpt would be trimmed by {@link encodeDraftEmbed} — the share flow uses this to
 * warn the author BEFORE it silently ships a truncated preview. */
export function draftExcerptWouldTrim(excerpt: string): boolean {
  return sanitizeBody(excerpt ?? '', MAX_DRAFT_EXCERPT_LEN + 1).length > MAX_DRAFT_EXCERPT_LEN;
}

/** Build a `stiq:draft:…` v2 POINTER token — a teaser, never the full body. `id` is the stable
 * draftId a viewer's access request/the owner's delivery anchor to (see draftAccess.ts). */
export function encodeDraftEmbed(ref: {
  id: string;
  title?: string;
  excerpt: string;
  author?: string;
  authorName?: string;
  authorGradient?: GradientSpec;
}): string {
  const wire: DraftEmbedWireV2 = {
    v: 2,
    id: ref.id.slice(0, MAX_ID_LEN),
    sn: sanitizeBody(ref.excerpt ?? '', MAX_DRAFT_EXCERPT_LEN),
  };
  if (ref.title) wire.ti = ref.title.slice(0, MAX_TITLE_LEN);
  if (ref.author && /^[0-9a-f]{64}$/.test(ref.author)) {
    wire.p = ref.author;
    if (ref.authorName) wire.an = ref.authorName.slice(0, MAX_NAME_LEN);
    const ag = encodeGradient(ref.authorGradient);
    if (ag) wire.ag = ag;
  }
  return DRAFT_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a `stiq:draft:…` token.
 *  - A valid v2 pointer → the {@link DraftRef} teaser.
 *  - A v1 token (the retired self-contained format) → the string `'legacy'`, so renderers can show
 *    an explicit "this shared draft is no longer available" state instead of a silent misrender.
 *  - Anything malformed/corrupt → `null` (NEVER throws — untrusted content must not crash a renderer).
 * Every carried string is sanitized + clamped HERE, protecting all current and future renderers.
 */
export function parseDraftEmbed(token: string): DraftRef | 'legacy' | null {
  try {
    if (!token.startsWith(DRAFT_EMBED_PREFIX)) return null;
    const payload = token.slice(DRAFT_EMBED_PREFIX.length);
    if (!payload) return null;
    // v1 tokens carried up to ~16KB (a whole body); only reject early on payload length once we know
    // which version we're looking at (below) — an oversized v2 payload is rejected explicitly.
    if (payload.length > 21_845) return null; // ~16KB of base64url — outer sanity bound for either version
    const json = bytesToUtf8(fromBase64Url(payload));
    const wire = JSON.parse(json) as {v?: unknown} | null;
    if (!wire || typeof wire !== 'object') return null;
    if (wire.v === 1) return 'legacy';
    if (wire.v !== 2) return null;
    if (payload.length > MAX_PAYLOAD_LEN) return null;
    const w = wire as Partial<DraftEmbedWireV2>;
    if (typeof w.id !== 'string' || !w.id) return null;
    const ref: DraftRef = {
      id: w.id.slice(0, MAX_ID_LEN),
      excerpt: typeof w.sn === 'string' ? sanitizeBody(w.sn, MAX_DRAFT_EXCERPT_LEN) : '',
    };
    if (typeof w.ti === 'string' && w.ti) {
      const clean = sanitizeDraftTitle(w.ti.slice(0, MAX_TITLE_LEN));
      if (clean) ref.title = clean;
    }
    if (typeof w.p === 'string' && /^[0-9a-f]{64}$/.test(w.p)) {
      ref.author = w.p;
      if (typeof w.an === 'string' && w.an) {
        const clean = sanitizeSpaceName(w.an.slice(0, MAX_NAME_LEN));
        if (clean) ref.authorName = clean;
      }
      if (typeof w.ag === 'string' && w.ag) {
        const gradient = decodeGradient(w.ag);
        if (gradient) ref.authorGradient = gradient;
      }
    }
    return ref;
  } catch {
    return null;
  }
}
