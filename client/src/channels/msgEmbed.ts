/**
 * Message embed tokens — a SELF-CONTAINED reference to a post/message from a PRIVATE channel or group
 * (kind 9/11/12/1311) that can be dropped into a body and render a full referenced card OFFLINE, with
 * no relay round-trip. Mirrors channels/spaceEmbed.ts + events/eventEmbed.ts — same base64url wire
 * discipline, same never-throws parse, same "every renderer must recognize the token" bug-#12 lesson.
 *
 * WHY self-contained (not a bare `nostr:nevent…`): a private group/channel message is stored on the
 * relay as NIP-44 CIPHERTEXT and the relay refuses to serve it to a non-scoped/non-member query, so
 * an id-only reference resolves to a blank/garbage card for exactly the audience the embedder is
 * trying to show it to. The token therefore CARRIES the decrypted `{author, name, gradient, body,
 * kind}` snapshot the embedder was looking at.
 *
 * PRIVACY: this token carries what was private plaintext. That is intentional and gated at the UI —
 * the composer warns before inserting one ("this content becomes visible to anyone who can see where
 * you post it"). The codec itself only ferries data; it grants no access and carries no key, no space
 * coordinate, and nothing that would let a viewer INTO the source space.
 *
 * Wire format: `stiq:msg:<base64url(JSON)>` with short keys `{v:1, p, n?, g?, b, k?, sn?}`.
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';
import {sanitizeSpaceName, sanitizeBody} from './spaceEmbed';

/** Scheme + namespace prefix every message embed token starts with. */
export const MSG_EMBED_PREFIX = 'stiq:msg:';

/** Matches a message embed token inside a longer body of text (base64url charset, no padding). */
export const MSG_EMBED_RE = /stiq:msg:[A-Za-z0-9_-]+/g;

/** A decoded message embed — everything the referenced card needs to paint, fully offline. */
export interface MsgRef {
  /** Referenced author's hex pubkey (for identity/gradient seed). */
  author: string;
  /** Referenced author's display name, if known. */
  name?: string;
  /** Referenced author's gradient identity, if any. */
  gradient?: GradientSpec;
  /** The referenced message's plaintext body (may be multi-line). */
  body: string;
  /** The referenced message's original kind (9/11/12/1311), when known. */
  kind?: number;
  /** The source space's display name ("from #secret-crew"), for context. */
  spaceName?: string;
}

/** Compact wire shape actually JSON-encoded into the token. */
interface MsgEmbedWire {
  v: 1;
  p: string; // author pubkey (hex)
  n?: string; // author name
  g?: string; // author gradient (encodeGradient)
  b: string; // body plaintext
  k?: number; // original kind
  sn?: string; // source space name
}

/** Payload cap — a message token (short keys, a clamped body) sits well under this; anything larger
 * is corrupt or adversarial and is rejected before base64/JSON work. */
const MAX_PAYLOAD_LEN = 6144;

/** Body clamp applied at encode AND decode — a quoted message is a snapshot, not a whole thread. */
const MAX_BODY_LEN = 2000;
const MAX_NAME_LEN = 80;

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const rem = base64.length % 4;
  const padded = rem === 0 ? base64 : base64 + '='.repeat(4 - rem);
  return base64ToBytes(padded);
}

/** Build a `stiq:msg:…` token carrying the decrypted snapshot the embedder was looking at. */
export function encodeMsgEmbed(ref: {
  author: string;
  name?: string;
  gradient?: GradientSpec;
  body: string;
  kind?: number;
  spaceName?: string;
}): string {
  const wire: MsgEmbedWire = {v: 1, p: ref.author, b: sanitizeBody(ref.body ?? '', MAX_BODY_LEN)};
  if (ref.name) wire.n = ref.name.slice(0, MAX_NAME_LEN);
  const g = encodeGradient(ref.gradient);
  if (g) wire.g = g;
  if (typeof ref.kind === 'number' && isFinite(ref.kind)) wire.k = Math.floor(ref.kind);
  if (ref.spaceName) wire.sn = ref.spaceName.slice(0, MAX_NAME_LEN);
  return MSG_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a `stiq:msg:…` token to a {@link MsgRef}. NEVER throws — any malformation yields `null` so
 * renderers fall back to plain text instead of crashing on untrusted body content. Every carried
 * string is sanitized + clamped HERE, protecting all current and future renderers.
 */
export function parseMsgEmbed(token: string): MsgRef | null {
  try {
    if (!token.startsWith(MSG_EMBED_PREFIX)) return null;
    const payload = token.slice(MSG_EMBED_PREFIX.length);
    if (!payload || payload.length > MAX_PAYLOAD_LEN) return null;
    const json = bytesToUtf8(fromBase64Url(payload));
    const wire = JSON.parse(json) as Partial<MsgEmbedWire> | null;
    if (!wire || typeof wire !== 'object') return null;
    if (typeof wire.p !== 'string' || !/^[0-9a-f]{64}$/.test(wire.p)) return null;
    const body = typeof wire.b === 'string' ? sanitizeBody(wire.b, MAX_BODY_LEN) : '';
    const ref: MsgRef = {author: wire.p, body};
    if (typeof wire.n === 'string' && wire.n) {
      const clean = sanitizeSpaceName(wire.n.slice(0, MAX_NAME_LEN));
      if (clean) ref.name = clean;
    }
    if (typeof wire.g === 'string' && wire.g) {
      const gradient = decodeGradient(wire.g);
      if (gradient) ref.gradient = gradient;
    }
    if (typeof wire.k === 'number' && isFinite(wire.k)) ref.kind = Math.floor(wire.k);
    if (typeof wire.sn === 'string' && wire.sn) {
      const clean = sanitizeSpaceName(wire.sn.slice(0, MAX_NAME_LEN));
      if (clean) ref.spaceName = clean;
    }
    return ref;
  } catch {
    return null;
  }
}
