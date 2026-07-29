/**
 * Events data layer — the PURE half: kind-31923 doc codec, latest-per-address folds, the 31925
 * interested tally, status derivation, and template builders. AppRuntime owns the effectful half
 * (publishing, DM frames, approval → group add, persisted RSVP/decision records) and calls in
 * here so every derivation exists exactly once.
 *
 * PRIVACY (STATES §6): a kind-31923 doc carries the event's PUBLIC fields only. The builder takes
 * an explicitly-public input shape (hidden fields already stripped by the caller), and the parser
 * DROPS any private-looking field a hostile doc might carry — exactAddress / entryNotes /
 * streamLink can only ever reach a viewer through an approve DM frame (events/eventFrames.ts).
 */
import type {Event} from 'nostr-tools/pure';
import type {GradientSpec} from '../media/gradient';
import {decodeGradient, encodeGradient} from '../media/gradient';
import {resolveContent} from '../blind/blindPost';
import {KIND_EVENT, KIND_EVENT_RSVP} from '../contracts';
import {sanitizeSpaceName} from '../channels/spaceEmbed';
import {eventCoordinate} from './eventEmbed';
import type {
  AutoAddPolicy,
  CapacityMode,
  CoverMode,
  EventAddr,
  EventStatus,
  EventType,
} from './types';

/** Unsigned template shape accepted by identity.sign / signOptimisticWrite. */
export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

const MAX_TITLE = 120;
// Sized for a description written in the full post editor: the article word ceiling (2000 words
// default) in prose plus compact blob refs — inline media never lands here (publishEvent blob-splits
// or drops it), so this clamp is a backstop against pathological input, not a working bound.
const MAX_DESC = 24000;
const MAX_TAG = 40;
const MAX_AREA = 120;
const MAX_LABEL = 60;
const MAX_NAME = 80;
const MAX_LINK = 300;
const MAX_SOURCE = 80;
const MAX_ID = 80;
const MAX_ISO = 40;
const MAX_CAPACITY = 100000;
const MAX_COUNT = 1000000;

/** The public event payload as published in a 31923 doc's content (short-ish keys, versioned). */
interface DocWire {
  v: 1;
  t?: string; // title
  y?: EventType; // type (absent = inperson)
  de?: string; // description
  tg?: string; // tag
  s?: string; // startsAt ISO
  e?: string; // endsAt ISO
  z?: string; // tz label
  r?: 'w' | 'm'; // recurrence
  ar?: string; // approximate area
  rk?: number; // approxRadiusKm
  ch?: string; // ama channel label
  km?: 'l' | 'c'; // capacity mode (absent = hidden from viewers)
  cp?: number; // capacity
  wl?: 0 | 1; // waitlist enabled
  aa?: {t: 'group' | 'channel'; l: string; g?: string; c?: string}; // auto-add policy
  cm?: 'g' | 'i' | 'n'; // cover mode (absent = gradient)
  cg?: string; // cover gradient wire
  ci?: string; // cover image pic token
  x?: 0 | 1; // external
  xs?: string; // external source
  xl?: string; // external link
  hn?: string; // host display name snapshot (offline card render)
  hg?: string; // host gradient wire snapshot
}

/** Everything the PUBLIC doc carries — the caller has already applied the hide flags. */
export interface PublicEventInput {
  title: string;
  type: EventType;
  description?: string;
  tag?: string;
  startsAt?: string;
  endsAt?: string;
  tz?: string;
  recurrence: 'none' | 'weekly' | 'monthly';
  area?: string;
  approxRadiusKm?: number;
  channel?: string;
  capacityMode?: CapacityMode; // undefined = capacity hidden from viewers
  capacity?: number;
  waitlistEnabled: boolean;
  autoAdd?: AutoAddPolicy & {groupId?: string; channelId?: string};
  cover: {mode: CoverMode; gradient?: GradientSpec; image?: string};
  external: boolean;
  externalSource?: string;
  externalLink?: string;
  hostName?: string;
  hostGrad?: GradientSpec;
}

/** A parsed public event doc plus its addressing + host-authoritative aggregates. */
export interface EventDocView {
  addr: EventAddr;
  coordinate: string;
  createdAt: number;
  public: PublicEventInput;
  going: number;
  waitlistCount: number;
  cancelled: boolean;
}

function clampLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const s = sanitizeSpaceName(v.slice(0, max)).slice(0, max);
  return s || undefined;
}

/** Multi-line clamp (descriptions): strip control chars except newline, cap length. */
function clampBlock(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  let out = '';
  for (const ch of v.slice(0, max)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 || c === 10) out += ch;
  }
  const s = out.trim();
  return s ? s : undefined;
}

function clampIso(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length < 10) return undefined;
  return v.slice(0, MAX_ISO);
}

// ── Doc content codec ─────────────────────────────────────────────────────────────────────────

export function buildEventDocContent(input: PublicEventInput): string {
  const w: DocWire = {v: 1};
  if (input.title) w.t = input.title.slice(0, MAX_TITLE);
  if (input.type !== 'inperson') w.y = input.type;
  if (input.description) w.de = input.description.slice(0, MAX_DESC);
  if (input.tag) w.tg = input.tag.slice(0, MAX_TAG);
  if (input.startsAt) w.s = input.startsAt.slice(0, MAX_ISO);
  if (input.endsAt) w.e = input.endsAt.slice(0, MAX_ISO);
  if (input.tz) w.z = input.tz.slice(0, MAX_LABEL);
  if (input.recurrence === 'weekly') w.r = 'w';
  else if (input.recurrence === 'monthly') w.r = 'm';
  if (input.area) w.ar = input.area.slice(0, MAX_AREA);
  if (typeof input.approxRadiusKm === 'number' && input.approxRadiusKm > 0) {
    w.rk = Math.min(input.approxRadiusKm, 500);
  }
  if (input.channel) w.ch = input.channel.slice(0, MAX_LABEL);
  if (input.capacityMode === 'limit') w.km = 'l';
  else if (input.capacityMode === 'count') w.km = 'c';
  if (input.capacityMode === 'limit' && typeof input.capacity === 'number' && input.capacity >= 1) {
    w.cp = Math.min(Math.floor(input.capacity), MAX_CAPACITY);
  }
  if (input.waitlistEnabled) w.wl = 1;
  if (input.autoAdd) {
    w.aa = {t: input.autoAdd.target, l: input.autoAdd.label.slice(0, MAX_LABEL)};
    if (input.autoAdd.groupId) w.aa.g = input.autoAdd.groupId.slice(0, MAX_ID);
    if (input.autoAdd.channelId) w.aa.c = input.autoAdd.channelId.slice(0, MAX_ID);
  }
  if (input.cover.mode === 'image') w.cm = 'i';
  else if (input.cover.mode === 'none') w.cm = 'n';
  const cg = encodeGradient(input.cover.gradient);
  if (cg) w.cg = cg;
  // Cover images travel only as COMPACT blob-backed pic refs (`[[pic:…;STIQBLOB<id>]]`, minted by
  // publishEvent). Slicing an inline-base64 token would publish un-decodable garbage — drop instead.
  if (input.cover.image && input.cover.image.length <= 500) w.ci = input.cover.image;
  if (input.external) {
    w.x = 1;
    if (input.externalSource) w.xs = input.externalSource.slice(0, MAX_SOURCE);
    if (input.externalLink) w.xl = input.externalLink.slice(0, MAX_LINK);
  }
  if (input.hostName) w.hn = input.hostName.slice(0, MAX_NAME);
  const hg = encodeGradient(input.hostGrad);
  if (hg) w.hg = hg;
  return JSON.stringify(w);
}

const EVENT_TYPES: EventType[] = ['inperson', 'online', 'hybrid', 'ama'];

/**
 * Parse a stored kind-31923 event into a doc view. NEVER throws; null on malformation. Sanitizes
 * and clamps every string (relay content is untrusted), and by construction cannot yield any
 * private field — the wire has no slot for one, and unknown keys are simply never read.
 */
export function parseEventDoc(ev: Event): EventDocView | null {
  if (ev.kind !== KIND_EVENT) return null;
  const d = ev.tags.find(t => t[0] === 'd')?.[1];
  if (!d || typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(ev.pubkey)) return null;
  let w: Partial<DocWire> | null = null;
  try {
    w = JSON.parse(ev.content) as Partial<DocWire>;
  } catch {
    return null;
  }
  if (!w || typeof w !== 'object' || w.v !== 1) return null;
  const addr: EventAddr = {pubkey: ev.pubkey, d: d.slice(0, MAX_ID)};
  const pub: PublicEventInput = {
    title: clampLine(w.t, MAX_TITLE) ?? '',
    type: EVENT_TYPES.includes(w.y as EventType) ? (w.y as EventType) : 'inperson',
    recurrence: w.r === 'w' ? 'weekly' : w.r === 'm' ? 'monthly' : 'none',
    waitlistEnabled: w.wl === 1,
    cover: {mode: w.cm === 'i' ? 'image' : w.cm === 'n' ? 'none' : 'gradient'},
    external: w.x === 1,
  };
  pub.description = clampBlock(w.de, MAX_DESC);
  pub.tag = clampLine(w.tg, MAX_TAG);
  pub.startsAt = clampIso(w.s);
  pub.endsAt = clampIso(w.e);
  pub.tz = clampLine(w.z, MAX_LABEL);
  pub.area = clampLine(w.ar, MAX_AREA);
  if (typeof w.rk === 'number' && Number.isFinite(w.rk) && w.rk > 0) {
    pub.approxRadiusKm = Math.min(w.rk, 500);
  }
  pub.channel = clampLine(w.ch, MAX_LABEL);
  if (w.km === 'l') pub.capacityMode = 'limit';
  else if (w.km === 'c') pub.capacityMode = 'count';
  if (pub.capacityMode === 'limit' && typeof w.cp === 'number' && Number.isFinite(w.cp) && w.cp >= 1) {
    pub.capacity = Math.min(Math.floor(w.cp), MAX_CAPACITY);
  }
  if (w.aa && typeof w.aa === 'object' && (w.aa.t === 'group' || w.aa.t === 'channel')) {
    const label = clampLine(w.aa.l, MAX_LABEL);
    if (label) {
      pub.autoAdd = {target: w.aa.t, label};
      const g = clampLine(w.aa.g, MAX_ID);
      if (g) pub.autoAdd.groupId = g;
      const c = clampLine(w.aa.c, MAX_ID);
      if (c) pub.autoAdd.channelId = c;
      if (w.aa.t === 'group') pub.autoAdd.groupName = label;
      else pub.autoAdd.channel = label;
    }
  }
  if (typeof w.cg === 'string' && w.cg) pub.cover.gradient = decodeGradient(w.cg);
  if (typeof w.ci === 'string' && w.ci && w.ci.length <= 500) pub.cover.image = w.ci;
  if (pub.external) {
    pub.externalSource = clampLine(w.xs, MAX_SOURCE);
    pub.externalLink = clampLine(w.xl, MAX_LINK);
  }
  pub.hostName = clampLine(w.hn, MAX_NAME);
  if (typeof w.hg === 'string' && w.hg) pub.hostGrad = decodeGradient(w.hg);

  const goingTag = ev.tags.find(t => t[0] === 'going')?.[1];
  const wlTag = ev.tags.find(t => t[0] === 'wl')?.[1];
  const going = clampCount(goingTag);
  const waitlistCount = clampCount(wlTag);
  const cancelled = ev.tags.some(t => t[0] === 'cancelled' && t[1] === '1');
  return {
    addr,
    coordinate: eventCoordinate(addr),
    createdAt: ev.created_at,
    public: pub,
    going,
    waitlistCount,
    cancelled,
  };
}

function clampCount(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_COUNT);
}

// ── Folds + tallies ───────────────────────────────────────────────────────────────────────────

/** Latest 31923 per (pubkey, d) — addressable-replace fold, `latestConfig` idiom. */
export function foldLatestEventDocs(events: Event[]): Map<string, Event> {
  const latest = new Map<string, Event>();
  for (const ev of events) {
    if (ev.kind !== KIND_EVENT) continue;
    const d = ev.tags.find(t => t[0] === 'd')?.[1];
    if (!d) continue;
    const key = `${KIND_EVENT}:${ev.pubkey}:${d}`;
    const cur = latest.get(key);
    if (!cur || ev.created_at > cur.created_at || (ev.created_at === cur.created_at && ev.id > cur.id)) {
      latest.set(key, ev);
    }
  }
  return latest;
}

/** The coordinate a 31925 RSVP targets (its `a`/`d` tag), or null. */
export function rsvpTarget(ev: Event): string | null {
  const a = ev.tags.find(t => t[0] === 'a')?.[1] ?? ev.tags.find(t => t[0] === 'd')?.[1];
  if (!a || a.length > 200) return null;
  const low = a.toLowerCase();
  return /^31923:[0-9a-f]{64}:.+$/.test(low) ? low : null;
}

export interface InterestedTally {
  count: number;
  /** Whether the RESOLVED viewer is currently interested (their latest RSVP is on). */
  mine: boolean;
}

/**
 * Fold 31925 RSVPs → per-coordinate interested tally, deduped latest-per-REAL-author (blind RSVPs
 * are signed by throwaway keys; `resolveAuthor` maps an event to its attributed author — the same
 * dedupe bar reactions clear). Content '+' = interested, anything else = retraction.
 *
 * An RSVP rides the same blind feedSigner as any other content, so its body can be sealed under a
 * content epoch key like a post/comment. A still-locked RSVP's ciphertext never equals '+' — it is
 * simply left uncounted rather than resolved to '' (this module is pure/shared, with no runtime
 * access to kick a background unlock); the tally self-corrects on the next fold once the epoch
 * unlocks and the real '+'/retraction becomes readable.
 */
export function interestedTallies(
  rsvps: Event[],
  resolveAuthor: (ev: Event) => string,
  myPubkey: string | null,
  isExcluded?: (ev: Event) => boolean,
): Map<string, InterestedTally> {
  // coordinate → author → latest rsvp
  const byCoord = new Map<string, Map<string, Event>>();
  for (const ev of rsvps) {
    if (ev.kind !== KIND_EVENT_RSVP) continue;
    // Member-roll enforcement (injected — this module is pure/shared): an excluded RSVP (off-roll
    // sock-puppet attribution) never counts as a distinct interested member. Absent predicate or
    // deferred roll ⇒ counts exactly as before.
    if (isExcluded?.(ev)) continue;
    const coord = rsvpTarget(ev);
    if (!coord) continue;
    const author = resolveAuthor(ev) || ev.pubkey;
    let authors = byCoord.get(coord);
    if (!authors) {
      authors = new Map();
      byCoord.set(coord, authors);
    }
    const cur = authors.get(author);
    if (!cur || ev.created_at > cur.created_at || (ev.created_at === cur.created_at && ev.id > cur.id)) {
      authors.set(author, ev);
    }
  }
  const out = new Map<string, InterestedTally>();
  for (const [coord, authors] of byCoord) {
    let count = 0;
    let mine = false;
    for (const [author, ev] of authors) {
      const body = resolveContent(ev);
      if (!body.locked && body.text === '+') {
        count++;
        if (myPubkey && author === myPubkey) mine = true;
      }
    }
    out.set(coord, {count, mine});
  }
  return out;
}

// ── Status ────────────────────────────────────────────────────────────────────────────────────

export function eventStatusOf(doc: EventDocView, nowSec: number): EventStatus {
  if (doc.cancelled) return 'cancelled';
  const end = doc.public.endsAt || doc.public.startsAt;
  if (end) {
    const t = Date.parse(end);
    if (!isNaN(t) && t / 1000 < nowSec) return 'past';
  }
  if (
    doc.public.capacityMode === 'limit' &&
    doc.public.capacity != null &&
    doc.going >= doc.public.capacity
  ) {
    return 'full';
  }
  return 'upcoming';
}

// ── Template builders ─────────────────────────────────────────────────────────────────────────

/** The 31923 doc template. `nowSec` is stamped by the caller so republish ordering is explicit. */
export function buildEventDocTemplate(args: {
  d: string;
  content: string;
  going: number;
  waitlistCount: number;
  cancelled: boolean;
  nowSec: number;
}): EventTemplate {
  const tags: string[][] = [['d', args.d]];
  if (args.going > 0) tags.push(['going', String(args.going)]);
  if (args.waitlistCount > 0) tags.push(['wl', String(args.waitlistCount)]);
  if (args.cancelled) tags.push(['cancelled', '1']);
  return {kind: KIND_EVENT, content: args.content, tags, created_at: args.nowSec};
}

/** A 31925 interested RSVP template ('+' on, '-' off). `d` = coordinate so a bound-npub RSVP is
 * addressable-replaced per author; blind RSVPs get unique throwaway keys and fold client-side. */
export function buildRsvpTemplate(coordinate: string, on: boolean, nowSec: number): EventTemplate {
  return {
    kind: KIND_EVENT_RSVP,
    content: on ? '+' : '-',
    tags: [
      ['d', coordinate],
      ['a', coordinate],
    ],
    created_at: nowSec,
  };
}
