/**
 * Event control frames — the application rail of the events surface. Every RSVP-review message
 * (apply / withdraw / waitlist / approve / decline / undo / position) rides an ordinary NIP-17
 * encrypted DM, framed at the head of the rumor body as `SOH a <base64url(JSON)> SOH` (see
 * profile/displayName.ts, which strips it from every rendered text exactly like the identity and
 * invite headers).
 *
 * WHY DMs and not relay kinds: the relay then sees only gift wraps — it never learns who applied
 * to what, who was approved, or where anything is. A declined applicant receives zero event
 * details by construction; the guest list exists only on the host's device; the exact address /
 * entry notes / stream link travel ONLY inside an approve frame to that one guest (privacy
 * invariants 1/2/5). The visible DM text is a human-readable fallback (plus the event's embed
 * card), so an out-of-date client still shows something sensible.
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {sanitizeSpaceName} from '../channels/spaceEmbed';
import type {EventReveal} from './types';

/** Must match displayName.ts MAX_EVENT_WIRE — an oversized frame is dropped, not half-framed. */
export const MAX_EVENT_FRAME_WIRE = 2048;

const MAX_NOTE_LEN = 500;
const MAX_ADDRESS_LEN = 200;
const MAX_NOTES_LEN = 300;
const MAX_LINK_LEN = 300;
const MAX_LABEL_LEN = 60;
const MAX_COORD_LEN = 160; // "31923:<64 hex>:<id>"
const MAX_ID_LEN = 80;

/** Every control frame names its event by the 31923 coordinate (`31923:<host pk>:<d>`). */
export type EventFrame =
  | {t: 'apply'; a: string; note?: string}
  | {t: 'withdraw'; a: string}
  | {t: 'wl-join'; a: string}
  | {t: 'wl-leave'; a: string}
  | {
      t: 'approve';
      a: string;
      /** The post-approval private payload — the ONLY channel it ever travels on. */
      reveal?: EventReveal;
      /** Display label of the space guests are added to ("#backups-crew"). */
      autoAddLabel?: string;
      /** Group the host added the guest to — the guest's client opens its scoped sub + joined-set
       * (they never sent a join request, so nothing else would ever subscribe them). */
      groupId?: string;
      /** Channel auto-add target (the guest's client subscribes it). */
      channelId?: string;
    }
  | {t: 'decline'; a: string}
  /** Undo of an approve/decline — the applicant returns to pending ('applied'); their client
   * drops any reveal it was holding. */
  | {t: 'restore'; a: string}
  | {t: 'wl-pos'; a: string; pos: number};

/** Compact wire form (short keys). */
interface FrameWire {
  v: 1;
  t: string;
  a: string;
  n?: string; // apply note
  ad?: string; // reveal exactAddress
  en?: string; // reveal entryNotes
  sl?: string; // reveal streamLink
  al?: string; // autoAddLabel
  g?: string; // groupId
  c?: string; // channelId
  p?: number; // waitlist position
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const rem = base64.length % 4;
  return base64ToBytes(rem === 0 ? base64 : base64 + '='.repeat(4 - rem));
}

/** Multi-line-tolerant clamp for the reveal fields (entry notes may hold a short paragraph):
 * strips SOH/control chars except newline, clamps length. */
function cleanBlock(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  let out = '';
  for (const ch of v.slice(0, max)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 || c === 10) out += ch;
  }
  const s = out.trim();
  return s ? s : undefined;
}

function cleanLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const s = sanitizeSpaceName(v.slice(0, max)).slice(0, max);
  return s || undefined;
}

const COORD_RE = /^31923:[0-9a-f]{64}:.+$/;

/** Encode a frame to the base64url wire that goes inside the `SOH a` header. */
export function encodeEventFrame(f: EventFrame): string {
  const wire: FrameWire = {v: 1, t: f.t, a: f.a.slice(0, MAX_COORD_LEN)};
  if (f.t === 'apply' && f.note) wire.n = f.note.slice(0, MAX_NOTE_LEN);
  if (f.t === 'approve') {
    if (f.reveal?.exactAddress) wire.ad = f.reveal.exactAddress.slice(0, MAX_ADDRESS_LEN);
    if (f.reveal?.entryNotes) wire.en = f.reveal.entryNotes.slice(0, MAX_NOTES_LEN);
    if (f.reveal?.streamLink) wire.sl = f.reveal.streamLink.slice(0, MAX_LINK_LEN);
    if (f.autoAddLabel) wire.al = f.autoAddLabel.slice(0, MAX_LABEL_LEN);
    if (f.groupId) wire.g = f.groupId.slice(0, MAX_ID_LEN);
    if (f.channelId) wire.c = f.channelId.slice(0, MAX_ID_LEN);
  }
  if (f.t === 'wl-pos') wire.p = Math.max(1, Math.floor(f.pos));
  return toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a received frame wire. NEVER throws — a malformed/oversized frame from a hostile peer
 * yields null and the DM renders as its plain fallback text. Every carried string is sanitized
 * and clamped HERE, before it can reach any store or Text component.
 */
export function parseEventFrame(wire: string): EventFrame | null {
  try {
    if (!wire || wire.length > MAX_EVENT_FRAME_WIRE) return null;
    const parsed = JSON.parse(bytesToUtf8(fromBase64Url(wire))) as Partial<FrameWire> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
    if (typeof parsed.a !== 'string' || parsed.a.length > MAX_COORD_LEN) return null;
    const a = parsed.a.toLowerCase();
    if (!COORD_RE.test(a)) return null;
    switch (parsed.t) {
      case 'apply': {
        const out: EventFrame = {t: 'apply', a};
        const note = cleanBlock(parsed.n, MAX_NOTE_LEN);
        if (note) out.note = note;
        return out;
      }
      case 'withdraw':
        return {t: 'withdraw', a};
      case 'wl-join':
        return {t: 'wl-join', a};
      case 'wl-leave':
        return {t: 'wl-leave', a};
      case 'approve': {
        const out: EventFrame = {t: 'approve', a};
        const ad = cleanBlock(parsed.ad, MAX_ADDRESS_LEN);
        const en = cleanBlock(parsed.en, MAX_NOTES_LEN);
        const sl = cleanLine(parsed.sl, MAX_LINK_LEN);
        if (ad || en || sl) {
          out.reveal = {};
          if (ad) out.reveal.exactAddress = ad;
          if (en) out.reveal.entryNotes = en;
          if (sl) out.reveal.streamLink = sl;
        }
        const al = cleanLine(parsed.al, MAX_LABEL_LEN);
        if (al) out.autoAddLabel = al;
        const g = cleanLine(parsed.g, MAX_ID_LEN);
        if (g) out.groupId = g;
        const c = cleanLine(parsed.c, MAX_ID_LEN);
        if (c) out.channelId = c;
        return out;
      }
      case 'decline':
        return {t: 'decline', a};
      case 'restore':
        return {t: 'restore', a};
      case 'wl-pos': {
        if (typeof parsed.p !== 'number' || !Number.isFinite(parsed.p) || parsed.p < 1) return null;
        return {t: 'wl-pos', a, pos: Math.floor(parsed.p)};
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
