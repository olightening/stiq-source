/**
 * Event embed tokens — a SELF-CONTAINED card reference for an event (kind-31923) that can be
 * dropped into a post/comment/channel message/DM body and render a full EventCard OFFLINE, with
 * no relay round-trip, then upgrade live (counts/status/viewer RSVP) from the event store by
 * address. Mirrors channels/spaceEmbed.ts — same base64url wire discipline, same never-throws
 * parse, same "every renderer must recognize the token" bug-#12 lesson.
 *
 * PRIVACY (STATES §6): the token carries the PUBLIC card payload ONLY. It NEVER contains the
 * exact address, entry notes, stream link, or any guest identity — sharing a card can leak
 * nothing private by construction. Fields the organizer hid are simply absent.
 *
 * Wire format: `stiq:event:<base64url(JSON)>` with short keys, decoded to {@link EventRef}.
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';
import {sanitizeSpaceName} from '../channels/spaceEmbed';
import {KIND_EVENT} from '../contracts';
import type {CapacityMode, CoverMode, EventAddr, EventType} from './types';

/** Scheme + namespace prefix every event embed token starts with. */
export const EVENT_EMBED_PREFIX = 'stiq:event:';

/** Matches an event embed token inside a longer body of text (base64url charset, no padding). */
export const EVENT_EMBED_RE = /stiq:event:[A-Za-z0-9_-]+/g;

/** NIP-01 addressable coordinate for an event doc. */
export function eventCoordinate(addr: EventAddr): string {
  return `${KIND_EVENT}:${addr.pubkey}:${addr.d}`;
}

/** A decoded event embed — everything a card needs to paint, fully offline. */
export interface EventRef {
  addr: EventAddr;
  coordinate: string;
  title?: string;
  /** Description SNIPPET (clamped ~400 chars, MAX_DESC_LEN) — a teaser only; EventDetailHost
   * upgrades to the full doc description once that lands. Absent on older tokens (pre-2026-07-22). */
  description?: string;
  type: EventType;
  startsAt?: string; // ISO
  endsAt?: string; // ISO
  tz?: string; // "CET (UTC+1)"
  recurrence: 'none' | 'weekly' | 'monthly';
  area?: string; // public approximate area (absent when hidden)
  hostName?: string;
  hostGrad?: GradientSpec;
  cover: {mode: CoverMode; gradient?: GradientSpec; image?: string};
  /** Absent = capacity display hidden entirely (organizer hid it or external). */
  capacityMode?: CapacityMode;
  capacity?: number;
  waitlistEnabled: boolean;
  tag?: string;
  external: boolean;
  externalSource?: string;
  externalLink?: string;
  /** Auto-add target display label ("#backups-crew"), shown on card/detail access row. */
  autoAddLabel?: string;
}

/** Compact wire shape actually JSON-encoded into the token. */
interface EventEmbedWire {
  v: 1;
  p: string; // host pubkey (hex)
  d: string; // event id (d tag)
  t?: string; // title
  de?: string; // description snippet (clamped ~400 chars, MAX_DESC_LEN) — absent on older tokens
  y?: string; // type
  s?: string; // startsAt ISO
  e?: string; // endsAt ISO
  z?: string; // tz label
  r?: 'w' | 'm'; // recurrence (absent = none)
  a?: string; // area
  hn?: string; // host name
  hg?: string; // host gradient (encodeGradient)
  cm?: 'g' | 'i' | 'n'; // cover mode (absent = gradient)
  cg?: string; // cover gradient (encodeGradient)
  ci?: string; // cover image pic token
  km?: 'l' | 'c'; // capacity mode (absent = hidden)
  cp?: number; // capacity
  wl?: 0 | 1; // waitlist enabled
  tg?: string; // tag
  x?: 0 | 1; // external
  xs?: string; // external source
  xl?: string; // external link
  al?: string; // auto-add label
}

/** Payload cap — an event token (short keys, clamped strings) sits well under this; anything
 * larger is corrupt or adversarial and is rejected before base64/JSON work. Sized to leave room
 * for the `de` description snippet (MAX_DESC_LEN) on top of every other field maxed out at once. */
const MAX_PAYLOAD_LEN = 2600;

const MAX_TITLE_LEN = 120;
const MAX_AREA_LEN = 120;
const MAX_NAME_LEN = 80;
const MAX_TAG_LEN = 40;
const MAX_SOURCE_LEN = 80;
const MAX_LINK_LEN = 300;
const MAX_LABEL_LEN = 60;
const MAX_PIC_LEN = 500;
const MAX_ISO_LEN = 40;
const MAX_CAPACITY = 100000;
/** Description SNIPPET cap — deliberately far short of eventsStore's full-doc MAX_DESC (24000):
 * this rides in every share of the card (post/comment/DM body), not just the detail screen, so it
 * stays a teaser. EventDetailHost swaps it for the full doc description the moment that lands. */
const MAX_DESC_LEN = 400;

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const rem = base64.length % 4;
  const padded = rem === 0 ? base64 : base64 + '='.repeat(4 - rem);
  return base64ToBytes(padded);
}

/** Sanitized single-line string or undefined — clamp first so the sanitizer's own cap can't bite. */
function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const s = sanitizeSpaceName(v.slice(0, max)).slice(0, max);
  return s || undefined;
}

/** Multi-line clamp for the description snippet — mirrors eventsStore's clampBlock exactly (strip
 * control chars except newline, cap length, trim) so a description reads as short prose rather
 * than being flattened to one line like every other `cleanStr` field. */
function cleanBlock(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  let out = '';
  for (const ch of v.slice(0, max)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 || c === 10) out += ch;
  }
  const s = out.trim();
  return s || undefined;
}

const EVENT_TYPES: EventType[] = ['inperson', 'online', 'hybrid', 'ama'];

/**
 * Build a `stiq:event:…` token from the PUBLIC view of an event. The caller passes fields
 * already stripped per the organizer's hide flags — this codec never sees private data.
 */
export function encodeEventEmbed(ref: {
  addr: EventAddr;
  title?: string;
  description?: string;
  type: EventType;
  startsAt?: string;
  endsAt?: string;
  tz?: string;
  recurrence?: 'none' | 'weekly' | 'monthly';
  area?: string;
  hostName?: string;
  hostGrad?: GradientSpec;
  cover?: {mode: CoverMode; gradient?: GradientSpec; image?: string};
  capacityMode?: CapacityMode;
  capacity?: number;
  waitlistEnabled?: boolean;
  tag?: string;
  external?: boolean;
  externalSource?: string;
  externalLink?: string;
  autoAddLabel?: string;
}): string {
  const wire: EventEmbedWire = {v: 1, p: ref.addr.pubkey, d: ref.addr.d};
  if (ref.title) wire.t = ref.title.slice(0, MAX_TITLE_LEN);
  const de = cleanBlock(ref.description, MAX_DESC_LEN);
  if (de) wire.de = de;
  if (ref.type !== 'inperson') wire.y = ref.type;
  if (ref.startsAt) wire.s = ref.startsAt.slice(0, MAX_ISO_LEN);
  if (ref.endsAt) wire.e = ref.endsAt.slice(0, MAX_ISO_LEN);
  if (ref.tz) wire.z = ref.tz.slice(0, MAX_LABEL_LEN);
  if (ref.recurrence === 'weekly') wire.r = 'w';
  else if (ref.recurrence === 'monthly') wire.r = 'm';
  if (ref.area) wire.a = ref.area.slice(0, MAX_AREA_LEN);
  if (ref.hostName) wire.hn = ref.hostName.slice(0, MAX_NAME_LEN);
  const hg = encodeGradient(ref.hostGrad);
  if (hg) wire.hg = hg;
  const cover = ref.cover ?? {mode: 'gradient' as CoverMode};
  if (cover.mode === 'image') wire.cm = 'i';
  else if (cover.mode === 'none') wire.cm = 'n';
  const cg = encodeGradient(cover.gradient);
  if (cg) wire.cg = cg;
  // A cover image only travels when it is COMPACT (a blob-backed `[[pic:…;STIQBLOB<id>]]` ref —
  // publishEvent mints one). Slicing an inline-base64 token would ship un-decodable garbage, so an
  // oversize token is dropped instead: the card falls back to the gradient until the doc resolves.
  if (cover.image && cover.image.length <= MAX_PIC_LEN) wire.ci = cover.image;
  if (ref.capacityMode === 'limit') wire.km = 'l';
  else if (ref.capacityMode === 'count') wire.km = 'c';
  if (ref.capacityMode === 'limit' && typeof ref.capacity === 'number' && ref.capacity >= 1) {
    wire.cp = Math.min(Math.floor(ref.capacity), MAX_CAPACITY);
  }
  if (ref.waitlistEnabled) wire.wl = 1;
  if (ref.tag) wire.tg = ref.tag.slice(0, MAX_TAG_LEN);
  if (ref.external) {
    wire.x = 1;
    if (ref.externalSource) wire.xs = ref.externalSource.slice(0, MAX_SOURCE_LEN);
    if (ref.externalLink) wire.xl = ref.externalLink.slice(0, MAX_LINK_LEN);
  }
  if (ref.autoAddLabel) wire.al = ref.autoAddLabel.slice(0, MAX_LABEL_LEN);
  return EVENT_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a `stiq:event:…` token to an {@link EventRef}. NEVER throws — any malformation yields
 * `null` so renderers fall back to plain text instead of crashing on untrusted body content.
 * Every carried string is sanitized + clamped HERE, protecting all current and future renderers.
 */
export function parseEventEmbed(token: string): EventRef | null {
  try {
    if (!token.startsWith(EVENT_EMBED_PREFIX)) return null;
    const payload = token.slice(EVENT_EMBED_PREFIX.length);
    if (!payload || payload.length > MAX_PAYLOAD_LEN) return null;
    const json = bytesToUtf8(fromBase64Url(payload));
    const wire = JSON.parse(json) as Partial<EventEmbedWire> | null;
    if (!wire || typeof wire !== 'object') return null;
    if (typeof wire.p !== 'string' || !/^[0-9a-f]{64}$/.test(wire.p)) return null;
    const d = cleanStr(wire.d, MAX_LABEL_LEN);
    if (!d) return null;
    const addr: EventAddr = {pubkey: wire.p, d};
    const type: EventType = EVENT_TYPES.includes(wire.y as EventType) ? (wire.y as EventType) : 'inperson';
    const coverMode: CoverMode = wire.cm === 'i' ? 'image' : wire.cm === 'n' ? 'none' : 'gradient';
    const ref: EventRef = {
      addr,
      coordinate: eventCoordinate(addr),
      type,
      recurrence: wire.r === 'w' ? 'weekly' : wire.r === 'm' ? 'monthly' : 'none',
      cover: {mode: coverMode},
      waitlistEnabled: wire.wl === 1,
      external: wire.x === 1,
    };
    ref.title = cleanStr(wire.t, MAX_TITLE_LEN);
    ref.description = cleanBlock(wire.de, MAX_DESC_LEN);
    if (typeof wire.s === 'string' && wire.s) ref.startsAt = wire.s.slice(0, MAX_ISO_LEN);
    if (typeof wire.e === 'string' && wire.e) ref.endsAt = wire.e.slice(0, MAX_ISO_LEN);
    ref.tz = cleanStr(wire.z, MAX_LABEL_LEN);
    ref.area = cleanStr(wire.a, MAX_AREA_LEN);
    ref.hostName = cleanStr(wire.hn, MAX_NAME_LEN);
    if (typeof wire.hg === 'string' && wire.hg) {
      const g = decodeGradient(wire.hg);
      if (g) ref.hostGrad = g;
    }
    if (typeof wire.cg === 'string' && wire.cg) {
      const g = decodeGradient(wire.cg);
      if (g) ref.cover.gradient = g;
    }
    // Mirror the encoder: an oversize (or sliced-by-an-old-encoder) image token cannot decode —
    // drop it rather than hand renderers a truncated tail.
    if (typeof wire.ci === 'string' && wire.ci && wire.ci.length <= MAX_PIC_LEN) ref.cover.image = wire.ci;
    if (wire.km === 'l') ref.capacityMode = 'limit';
    else if (wire.km === 'c') ref.capacityMode = 'count';
    if (
      ref.capacityMode === 'limit' &&
      typeof wire.cp === 'number' &&
      isFinite(wire.cp) &&
      wire.cp >= 1
    ) {
      ref.capacity = Math.min(Math.floor(wire.cp), MAX_CAPACITY);
    }
    ref.tag = cleanStr(wire.tg, MAX_TAG_LEN);
    if (ref.external) {
      ref.externalSource = cleanStr(wire.xs, MAX_SOURCE_LEN);
      ref.externalLink = cleanStr(wire.xl, MAX_LINK_LEN);
    }
    ref.autoAddLabel = cleanStr(wire.al, MAX_LABEL_LEN);
    return ref;
  } catch {
    return null;
  }
}
