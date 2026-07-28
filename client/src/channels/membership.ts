/**
 * Private-space membership — join requests with a sealed intro note, and accept-first invites.
 * (design_handoff_membership; see MEMBERSHIP_HANDOFF_PLAN.md at the repo root.)
 *
 * Three wire pieces, ALL client-side (zero relay changes — the NIP-29 state machine already does
 * everything needed: 9021 sets Pending and STORES its content untouched, 9022 clears Pending
 * (= withdraw), 9000 approves, 9001 silently declines):
 *
 *  1. JOIN-NOTE ENVELOPE — the optional "introduce yourself" line rides in the 9021's content,
 *     NIP-44-sealed per admin: `{v:1, s:{[adminPk]: ciphertext}}`, plaintext `{n?: name, t?: note}`.
 *     Sealed because 9021 is NOT in the relay's groupQueryKinds — any community member could REQ it
 *     broadly — and the spec promises "only the admins see this". No note → content stays ''
 *     (byte-identical to the pre-feature request).
 *
 *  2. INVITE FRAME — an invite is a NORMAL encrypted DM whose body leads with a control-framed
 *     header `SOH i <base64url(JSON)> SOH` (same framing as the display-name header, stripped by
 *     every renderer via displayName.parseHeaders) followed by readable fallback text + the
 *     stiq:space embed token. The frame carries a render snapshot `{v:1, g, n?, k?, m?}` so the
 *     recipient's inbox invitation card paints offline; consent is accept-first — the recipient
 *     becomes a member only after tapping Accept (which sends a 9021 an admin auto-approves).
 *
 *  3. INVITED-SET DOC — the admins' shared "Invited" strip state: kind-30078
 *     `d="space-invites:<spaceId>"`, one doc PER AUTHOR (addressable per (author,d) — two admins
 *     inviting concurrently can never clobber each other), content sealed under the space's current
 *     epoch key for an encrypted space (members-only readable; the relay and non-members see only
 *     ciphertext). Folded state = union of authorized authors' adds minus newer revokes minus
 *     current members.
 *
 * Requester-side state is LOCAL (AsyncStorage, per identity slot — mirrors groupMembership.ts):
 * `none → pending` (send) · `pending → none` (withdraw) · `pending → member` (39002 lists me).
 * A DECLINE IS INVISIBLE BY DESIGN: the relay clears Pending but the requester's client keeps
 * rendering "pending" from the local record — never render a rejected state anywhere.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {EventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {SPACE_KEY_REQUEST_D_PREFIX} from '../contracts';
import {joinRequestsKey, invitesDismissedKey, spaceKeysDeliveredKey} from '../app/workspaceKeys';
import {sanitizeSpaceName} from './spaceEmbed';
import {GroupKind, eventGroupId} from './groups';

// ── 1. Join-note envelope (9021 content) ─────────────────────────────────────────────────────

/** Cap on the intro note, matching the spirit of a "line about who you are". */
export const MAX_JOIN_NOTE = 500;

/** Plaintext each admin unseals: the requester's display name + optional intro note. */
export interface JoinNotePayload {
  /** Requester's display name at request time (admins may never have seen this npub). */
  n?: string;
  /** The optional intro note ("only the admins see this"). */
  t?: string;
}

/** Serialize the payload one admin's seal encrypts. */
export function encodeJoinNotePayload(p: JoinNotePayload): string {
  const out: JoinNotePayload = {};
  if (p.n) out.n = p.n.slice(0, 80);
  if (p.t) out.t = p.t.slice(0, MAX_JOIN_NOTE);
  return JSON.stringify(out);
}

/** Parse a decrypted seal back to the payload. Never throws. */
export function parseJoinNotePayload(json: string): JoinNotePayload | null {
  try {
    const p = JSON.parse(json) as Partial<JoinNotePayload> | null;
    if (!p || typeof p !== 'object') return null;
    const out: JoinNotePayload = {};
    if (typeof p.n === 'string' && p.n) out.n = p.n.slice(0, 80);
    if (typeof p.t === 'string' && p.t) out.t = p.t.slice(0, MAX_JOIN_NOTE);
    return out;
  } catch {
    return null;
  }
}

/** Build the 9021 content from per-admin seals. Empty seals → '' (byte-identical to a bare join). */
export function encodeJoinNoteContent(seals: Record<string, string>): string {
  if (Object.keys(seals).length === 0) return '';
  return JSON.stringify({v: 1, s: seals});
}

/** The per-admin seal map from a 9021's content, or null when there is none / it's malformed. */
export function parseJoinNoteContent(content: string): Record<string, string> | null {
  if (!content) return null;
  try {
    const wire = JSON.parse(content) as {v?: number; s?: Record<string, unknown>} | null;
    if (!wire || typeof wire !== 'object' || wire.v !== 1) return null;
    if (!wire.s || typeof wire.s !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [pk, ct] of Object.entries(wire.s)) {
      if (/^[0-9a-f]{64}$/i.test(pk) && typeof ct === 'string' && ct) out[pk.toLowerCase()] = ct;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The latest join-request event per pending pubkey for a group: the admin queue joins the relay's
 * authoritative 39004 pending set against these raw 9021s for the note + "when". A pending pubkey
 * with no fetchable 9021 still renders (just without note/timestamp).
 */
export function latestJoinRequests(store: EventStore, groupId: string): Map<string, Event> {
  const latest = new Map<string, Event>();
  for (const ev of store.query({kinds: [GroupKind.JoinRequest]})) {
    if (eventGroupId(ev) !== groupId) continue;
    const cur = latest.get(ev.pubkey);
    if (!cur || ev.created_at > cur.created_at) latest.set(ev.pubkey, ev);
  }
  return latest;
}

/** Whether a 9021 marks itself as accepting an invite (`['invite']` tag). */
export function isInviteAccept(ev: Event): boolean {
  return ev.tags.some(t => t[0] === 'invite');
}

// ── 2. Invite frame (rides inside the invite DM's body) ──────────────────────────────────────

/** Render snapshot carried by an invite DM so the invitation card paints offline. */
export interface InvitePayload {
  /** The NIP-29 group id being invited to. */
  g: string;
  /** Space name at invite time. */
  n?: string;
  /** Space flavour word for the card sub-line: 'group' (chat) vs 'channel' (private broadcast). */
  k?: 'group' | 'channel';
  /** Member count at invite time. */
  m?: number;
  /**
   * Relay-verifiable invite grant: a base64-encoded kind-9010 event the inviting ADMIN signed for
   * this recipient. The invitee attaches it to their accept (9021) so the relay admits them to
   * membership immediately — no online admin needed to approve. Absent for a non-admin inviter or a
   * legacy invite, in which case the accept falls to the normal pending queue. (See groups.go.)
   */
  gr?: string;
}

/** Bounds the base64 invite grant carried in a DM (a signed kind-9010 event ≈ 640 chars). */
const MAX_GRANT_B64 = 1000;
/** Frame budget for the whole base64url invite payload — large enough to carry the grant above. */
const MAX_INVITE_WIRE = 1600;

/** How long an invite grant stays usable (30 days). Bounds the window a leaked grant could admit
 *  its named recipient; after it the invitee simply falls back to admin approval. */
export const INVITE_GRANT_TTL_SECS = 30 * 24 * 3600;

/** The invite grant (a SIGNED kind-9010 event) as it rides in the invite payload and the 9021
 *  `invite_grant` tag: standard-base64 JSON, decoded by the relay with StdEncoding. */
export function encodeInviteGrant(grant: Event): string {
  return bytesToBase64(utf8ToBytes(JSON.stringify(grant)));
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const rem = base64.length % 4;
  return base64ToBytes(rem === 0 ? base64 : base64 + '='.repeat(4 - rem));
}

/** Encode the invite payload to the opaque wire that goes inside the SOH-i frame (base64url — the
 * charset can never collide with the SOH/newline framing). */
export function encodeInvitePayload(p: InvitePayload): string {
  const wire: InvitePayload = {g: p.g};
  if (p.n) wire.n = sanitizeSpaceName(p.n);
  if (p.k) wire.k = p.k;
  if (typeof p.m === 'number' && p.m > 0) wire.m = Math.floor(p.m);
  if (p.gr && p.gr.length <= MAX_GRANT_B64) wire.gr = p.gr;
  return toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

/** Decode an invite frame's wire back to the payload. Never throws (untrusted DM content). */
export function parseInvitePayload(wire: string): InvitePayload | null {
  try {
    if (!wire || wire.length > MAX_INVITE_WIRE) return null;
    const parsed = JSON.parse(bytesToUtf8(fromBase64Url(wire))) as Partial<InvitePayload> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.g !== 'string' || !parsed.g || parsed.g.length > 128) return null;
    const out: InvitePayload = {g: parsed.g};
    if (typeof parsed.n === 'string' && parsed.n) {
      const clean = sanitizeSpaceName(parsed.n);
      if (clean) out.n = clean;
    }
    if (parsed.k === 'group' || parsed.k === 'channel') out.k = parsed.k;
    if (typeof parsed.m === 'number' && Number.isFinite(parsed.m) && parsed.m > 0) {
      out.m = Math.floor(parsed.m);
    }
    // The invite grant is forwarded verbatim to the relay (which does the real verification); here
    // we only length-bound it so a hostile DM can't bloat the card state. Base64 charset only.
    if (typeof parsed.gr === 'string' && parsed.gr && parsed.gr.length <= MAX_GRANT_B64
        && /^[A-Za-z0-9+/=]+$/.test(parsed.gr)) {
      out.gr = parsed.gr;
    }
    return out;
  } catch {
    return null;
  }
}

// ── 3. Invited-set doc (kind-30078, d="space-invites:<spaceId>", one per author) ─────────────

export const KIND_SPACE_INVITES = Kind.AppData; // 30078
export const SPACE_INVITES_D_PREFIX = 'space-invites:';

/** Addressable `d` for a space's invited-set doc. Never `stiq:`-prefixed (organizer-reserved). */
export function spaceInvitesDTag(spaceId: string): string {
  return `${SPACE_INVITES_D_PREFIX}${spaceId}`;
}

/** One outstanding invite: target pubkey, inviting author, unix seconds. */
export interface SpaceInvite {
  p: string;
  by: string;
  at: number;
}

/** One author's doc: their adds + their revokes (a revoke may target ANY author's invite). */
export interface SpaceInvitesDoc {
  inv: SpaceInvite[];
  rev: {p: string; at: number}[];
}

export function encodeInvitesDoc(doc: SpaceInvitesDoc): string {
  return JSON.stringify({v: 1, inv: doc.inv, rev: doc.rev});
}

/** Parse one author's doc content (already decrypted for an encrypted space). Never throws. */
export function parseInvitesDoc(json: string): SpaceInvitesDoc | null {
  try {
    const wire = JSON.parse(json) as {
      v?: number;
      inv?: unknown;
      rev?: unknown;
    } | null;
    if (!wire || typeof wire !== 'object' || wire.v !== 1) return null;
    const inv: SpaceInvite[] = [];
    if (Array.isArray(wire.inv)) {
      for (const e of wire.inv) {
        const x = e as Partial<SpaceInvite> | null;
        if (!x || typeof x !== 'object') continue;
        if (typeof x.p !== 'string' || !/^[0-9a-f]{64}$/i.test(x.p)) continue;
        if (typeof x.at !== 'number' || !Number.isFinite(x.at)) continue;
        const by = typeof x.by === 'string' && /^[0-9a-f]{64}$/i.test(x.by) ? x.by.toLowerCase() : '';
        inv.push({p: x.p.toLowerCase(), by, at: Math.floor(x.at)});
      }
    }
    const rev: {p: string; at: number}[] = [];
    if (Array.isArray(wire.rev)) {
      for (const e of wire.rev) {
        const x = e as {p?: unknown; at?: unknown} | null;
        if (!x || typeof x !== 'object') continue;
        if (typeof x.p !== 'string' || !/^[0-9a-f]{64}$/i.test(x.p)) continue;
        if (typeof x.at !== 'number' || !Number.isFinite(x.at)) continue;
        rev.push({p: x.p.toLowerCase(), at: Math.floor(x.at)});
      }
    }
    return {inv, rev};
  } catch {
    return null;
  }
}

/**
 * Fold the authorized authors' docs into the current outstanding-invite set:
 *   • latest add per target pubkey wins (across authors);
 *   • dropped when ANY authorized author revoked it at-or-after the winning add
 *     (a re-invite AFTER a revoke stands — the add is newer);
 *   • current members drop off (their invite completed);
 *   • docs from non-authorized authors are ignored entirely (a random member can't fake the strip).
 */
export function foldInvites(
  docs: {author: string; doc: SpaceInvitesDoc}[],
  authorized: ReadonlySet<string>,
  members: readonly string[],
): SpaceInvite[] {
  const memberSet = new Set(members);
  const bestAdd = new Map<string, SpaceInvite>();
  const bestRev = new Map<string, number>();
  for (const {author, doc} of docs) {
    if (!authorized.has(author)) continue;
    for (const inv of doc.inv) {
      const cur = bestAdd.get(inv.p);
      // The doc omits `by` only for malformed entries; default the inviter to the doc author.
      const entry = inv.by ? inv : {...inv, by: author};
      if (!cur || entry.at > cur.at) bestAdd.set(inv.p, entry);
    }
    for (const r of doc.rev) {
      const cur = bestRev.get(r.p);
      if (cur === undefined || r.at > cur) bestRev.set(r.p, r.at);
    }
  }
  const out: SpaceInvite[] = [];
  for (const [pk, inv] of bestAdd) {
    if (memberSet.has(pk)) continue;
    const rev = bestRev.get(pk);
    if (rev !== undefined && rev >= inv.at) continue;
    out.push(inv);
  }
  return out.sort((a, b) => b.at - a.at);
}

// ── Local requester-side state (per identity slot, mirrors groupMembership.ts) ───────────────

/** The requester's own outstanding request (local; the relay's Pending is the admins' view). */
export interface MyJoinRequest {
  sentAt: number;
}

export async function loadMyJoinRequests(slotId?: string): Promise<Record<string, MyJoinRequest>> {
  try {
    const raw = await AsyncStorage.getItem(joinRequestsKey(slotId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, MyJoinRequest> = {};
    for (const [gid, v] of Object.entries(parsed as Record<string, unknown>)) {
      const x = v as {sentAt?: unknown} | null;
      if (x && typeof x === 'object' && typeof x.sentAt === 'number') {
        out[gid] = {sentAt: x.sentAt};
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveMyJoinRequests(
  map: Record<string, MyJoinRequest>,
  slotId?: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(joinRequestsKey(slotId), JSON.stringify(map));
  } catch {
    // best effort
  }
}

/** Space-invite dismissals ("Not now"), keyed space id → the `at` (invite DM created_at) of the
 * invite that was dismissed (local-only — a decline is never signalled to the space; the DM stays
 * in the thread). A STRICTLY NEWER invite — a deliberate re-invite after a leave/kick — re-surfaces
 * the card; the old flat-array shape suppressed every future invite to that space forever. A legacy
 * persisted ARRAY loads as "dismissed as of migration time": every invite already received stays
 * suppressed (old behaviour preserved), while an invite minted AFTER this load re-surfaces. */
export async function loadDismissedInvites(slotId?: string): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(invitesDismissedKey(slotId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const now = Math.floor(Date.now() / 1000);
      const out: Record<string, number> = {};
      for (const x of parsed) if (typeof x === 'string') out[x] = now;
      return out;
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [gid, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[gid] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveDismissedInvites(
  map: Record<string, number>,
  slotId?: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(invitesDismissedKey(slotId), JSON.stringify(map));
  } catch {
    // best effort
  }
}

/** Per-(space, member) highest space-key epoch this ADMIN device has already wrapped + delivered
 * as a kind-30079 — the dedupe behind the member-arrival key backfill (an admin observing a 39002
 * keys every member it hasn't yet keyed, covering relay grant-admits no admin action ever keyed).
 * Keys are `${groupId}:${memberPk}`. Local-only bookkeeping; holds no key material. */
export async function loadDeliveredSpaceKeys(slotId?: string): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(spaceKeysDeliveredKey(slotId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveDeliveredSpaceKeys(
  map: Record<string, number>,
  slotId?: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(spaceKeysDeliveredKey(slotId), JSON.stringify(map));
  } catch {
    // best effort
  }
}

// ── Space-key redelivery request (kind-30078, d="space-key-request:<spaceId>") ────────────────
//
// The self-heal for a member stranded in a private space whose kind-30079 key delivery never
// reached their device (relay lost/paged it out, or the admin's delivery watermark says "already
// keyed" so the 39002 backfill will never re-send). The keyless member publishes this tiny
// addressable doc; any keyed admin whose client sees it re-runs the per-member delivery for the
// CURRENT epoch (never old epochs — a rejoiner must not gain the history a rotation locked away).
//
// Wire choices, all deliberate:
//  • kind 30078 with a NON-`stiq:` `d` prefix — allowed from any bound member with zero relay
//    changes (`stiq:` d-tags are organizer-reserved; see spaceInvitesDTag's identical caveat).
//  • addressable per (author, d) — a member re-requesting REPLACES their own doc server-side, so
//    requests can never pile up; the responder dedupes on created_at.
//  • `['h', spaceId]` + the exact-`d` filter in buildSpaceKeyRecoveryFilters is how it reaches an
//    admin: it rides the group's own scoped subscription, so it has the same liveness as the
//    39002-driven key backfill (an admin opening the space answers it).
//  • content is EMPTY — the request carries no secret and needs none; the response is the normal
//    authenticated, NIP-44-wrapped 30079 path.

export {SPACE_KEY_REQUEST_D_PREFIX};

/** Addressable `d` for a member's key-redelivery request. Never `stiq:`-prefixed (organizer-reserved). */
export function spaceKeyRequestDTag(spaceId: string): string {
  return `${SPACE_KEY_REQUEST_D_PREFIX}${spaceId}`;
}

/** Build the UNSIGNED redelivery-request doc for `spaceId` (the caller signs + publishes). */
export function buildSpaceKeyRequest(spaceId: string): UnsignedEvent {
  return {
    kind: Kind.AppData,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', spaceKeyRequestDTag(spaceId)],
      ['h', spaceId],
    ],
    content: '',
  };
}

/** A parsed redelivery request: which space, who asks, and when (the responder's dedupe key). */
export interface SpaceKeyRequest {
  spaceId: string;
  requester: string;
  at: number;
}

/** Parse a kind-30078 redelivery request. Returns null for anything that isn't one. */
export function parseSpaceKeyRequest(event: Event): SpaceKeyRequest | null {
  if (event.kind !== Kind.AppData) return null;
  const d = event.tags.find(t => t[0] === 'd' && t[1])?.[1];
  if (!d || !d.startsWith(SPACE_KEY_REQUEST_D_PREFIX)) return null;
  const spaceId = d.slice(SPACE_KEY_REQUEST_D_PREFIX.length);
  if (!spaceId) return null;
  return {spaceId, requester: event.pubkey, at: event.created_at};
}
