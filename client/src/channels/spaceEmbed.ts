/**
 * Space embed tokens — a SELF-CONTAINED card reference for a channel (kind-30311) or private group
 * (kind-39000) that can be dropped into a post/comment/DM body and render a full card OFFLINE, with
 * no relay round-trip.
 *
 * WHY self-contained (not a bare `nostr:naddr…`): a private group's name/gradient live in its
 * relay-authoritative 39000 metadata event, which a non-member cannot fetch (the relay scopes group
 * state to members). A naddr embed would render as a nameless placeholder for exactly the audience
 * that most needs to see what they're being invited to look at. So the token itself CARRIES
 * `{kind, owner, identifier, name, private, gradient?}` — everything a card needs to paint — and is
 * NAVIGATE-ONLY: it never carries a key, invite code, or anything that grants access. Tapping it can
 * take you to a join/request-access flow; it can never let you in on its own.
 *
 * CRITICAL LESSON (bug #12): a custom `stiq:` token renders as dead text unless EVERY link detector
 * (composer preview, feed renderer, DM renderer, comment renderer, …) recognizes it. This module is
 * only the codec + the saved-embeds storage that produce/consume the token; downstream chunks own
 * wiring it into every detector/renderer.
 *
 * Wire format: `stiq:space:<base64url(JSON)>` where the JSON uses short keys to keep the token
 * compact — `{v:1, k, o, i, n?, p, g?}` — decoded back to the verbose {@link SpaceRef} shape.
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';

/** Scheme + namespace prefix every space embed token starts with. */
export const SPACE_EMBED_PREFIX = 'stiq:space:';

/**
 * Matches a space embed token inside a longer body of text. The payload charset is base64url
 * (`[A-Za-z0-9_-]`, no padding) — kept tight so the match never swallows trailing punctuation/prose.
 */
export const SPACE_EMBED_RE = /stiq:space:[A-Za-z0-9_-]+/g;

/** A decoded space embed — everything a card needs to render, fully offline. */
export interface SpaceRef {
  kind: 30311 | 39000;
  owner: string;
  identifier: string;
  /** NIP-01 addressable coordinate: `${kind}:${owner}:${identifier}` — matches Channel.id for 30311. */
  coordinate: string;
  name?: string;
  private: boolean;
  gradient?: GradientSpec;
}

/** Compact wire shape actually JSON-encoded into the token (short keys keep it small). */
interface SpaceEmbedWire {
  v: 1;
  k: 30311 | 39000;
  o: string;
  i: string;
  n?: string;
  p: 0 | 1;
  g?: string;
}

/** Hard cap on the base64url payload length (after the `stiq:space:` prefix) accepted at decode. A
 * legitimate token (short keys, a handful of small fields) is well under this; anything larger is
 * either corrupt or a deliberately oversized adversarial body and is rejected before we even touch
 * base64/JSON decoding. */
const MAX_PAYLOAD_LEN = 1024;

/** Name length clamp applied at decode — independent of whatever the encoder wrote. */
const MAX_NAME_LEN = 80;

/** Unicode bidi-override/isolate characters (U+202A-U+202E, U+2066-U+2069) can make a name render
 * misleadingly reversed or with nested direction runs; zero-width characters (U+200B-U+200D, U+FEFF)
 * can hide characters entirely. Both classes are stripped alongside ASCII control chars. */
const BIDI_AND_ZERO_WIDTH_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

/** ASCII control characters (incl. newline/tab/CR, U+0000-U+001F and U+007F) — a name is a single
 * display line, never multi-line. */
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/g;

export function sanitizeSpaceName(s: string): string {
  return s
    .replace(ASCII_CONTROL_RE, '')
    .replace(BIDI_AND_ZERO_WIDTH_RE, '')
    .slice(0, MAX_NAME_LEN)
    .trim();
}

/** ASCII control chars EXCEPT tab (U+0009) and newline (U+000A), which a multi-line body legitimately
 * carries. CR is normalized to LF before this runs, so U+000D is dropped here too. */
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_KEEP_NL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

/**
 * Multi-line body sanitizer for a carried message/draft body (as opposed to a single-line name):
 * normalizes CRLF→LF, strips bidi/zero-width and ASCII control chars but KEEPS `\n`/`\t`, and clamps
 * to `max`. Shared by the self-contained message and draft embed codecs so the untrusted body is
 * cleaned at exactly one place before it ever reaches a Text component.
 */
export function sanitizeBody(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(ASCII_CONTROL_KEEP_NL_RE, '')
    .replace(BIDI_AND_ZERO_WIDTH_RE, '')
    .slice(0, max);
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

/** Build a `stiq:space:…` token that carries everything a card needs to render offline. */
export function encodeSpaceEmbed(ref: {
  kind: 30311 | 39000;
  owner: string;
  identifier: string;
  name?: string;
  private: boolean;
  gradient?: GradientSpec;
}): string {
  const wire: SpaceEmbedWire = {v: 1, k: ref.kind, o: ref.owner, i: ref.identifier, p: ref.private ? 1 : 0};
  if (ref.name) wire.n = ref.name;
  const g = encodeGradient(ref.gradient);
  if (g) wire.g = g;
  return SPACE_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a `stiq:space:…` token back to a {@link SpaceRef}. NEVER throws — any malformation (bad
 * prefix, bad base64, bad JSON, wrong kind, missing owner/identifier) yields `null` so a renderer can
 * fall back to plain text instead of crashing on untrusted body content.
 */
export function parseSpaceEmbed(token: string): SpaceRef | null {
  try {
    if (!token.startsWith(SPACE_EMBED_PREFIX)) return null;
    const payload = token.slice(SPACE_EMBED_PREFIX.length);
    if (!payload) return null;
    // Untrusted body content — reject an implausibly large payload before spending any base64/JSON
    // decode work on it (an oversized token is either corrupt or adversarial).
    if (payload.length > MAX_PAYLOAD_LEN) return null;
    const json = bytesToUtf8(fromBase64Url(payload));
    const wire = JSON.parse(json) as Partial<SpaceEmbedWire> | null;
    if (!wire || typeof wire !== 'object') return null;
    if (wire.k !== 30311 && wire.k !== 39000) return null;
    if (typeof wire.o !== 'string' || !wire.o) return null;
    if (typeof wire.i !== 'string' || !wire.i) return null;
    const ref: SpaceRef = {
      kind: wire.k,
      owner: wire.o,
      identifier: wire.i,
      coordinate: `${wire.k}:${wire.o}:${wire.i}`,
      private: wire.p === 1,
    };
    if (typeof wire.n === 'string' && wire.n) {
      // Clamp + sanitize the untrusted carried name at decode — this single point protects every
      // current + future renderer (finding 3): strip control/bidi/zero-width chars and cap length
      // before the name ever reaches a Text component.
      const clean = sanitizeSpaceName(wire.n.slice(0, MAX_NAME_LEN));
      if (clean) ref.name = clean;
    }
    if (typeof wire.g === 'string' && wire.g) {
      const gradient = decodeGradient(wire.g);
      if (gradient) ref.gradient = gradient;
    }
    return ref;
  } catch {
    return null;
  }
}
