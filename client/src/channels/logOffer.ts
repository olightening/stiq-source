/**
 * Log "space offer" — the owner-consent gate for listing a PRIVATE NIP-29 group in the organizer
 * dashboard's community log-page picker (`GET /api/discover`). Mirrors spaceRules.ts's structure
 * (unified per-space kind-30078 doc) but this doc has ONE job: let a group's OWNER opt a private
 * space into the public discover listing, and revoke that consent later.
 *
 * ⚠️ WIRE CONTRACT — MUST match `issuer/log-offer.mjs` byte-for-byte (that file is the authority;
 * `issuer/log_offer_test.mjs` pins the shape the dashboard reads):
 *
 *   - kind 30078, OWNER-signed, tag `["d", "space-offer:<groupId>"]`.
 *   - The `d` is NEVER `stiq:`-prefixed — the relay reserves that prefix for the organizer's own
 *     config events (relay/internal/policy/organizer.go) and rejects a non-organizer 30078 whose
 *     `d` carries it (code_config_reserved). A space owner is an ordinary bound member.
 *   - Live offer content JSON: {"v":1,"gid":"<gid>","n":"<name ≤80>","g":"<gradient wire ≤120,
 *     optional>","pr":<bool>,"cl":<bool>,"bc":<bool>,"at":<unix>} — pr/cl/bc mirror the group's
 *     private/closed/broadcast flags.
 *   - Revoke: republish the SAME `d` with {"v":1,"gid":"<gid>","rv":true,"at":<unix>}. NIP-33
 *     addressable replacement — latest per (pubkey,d) wins, so a revoke tombstone supersedes any
 *     earlier live offer.
 *   - Parsing is defensive: unparseable JSON / wrong version / missing gid / rv:true all mean "no
 *     live offer" (null). `n` capped at 80 chars, `g` at 120.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';

/** The kind-30078 doc that carries a group's log offer. */
export const KIND_LOG_OFFER = Kind.AppData; // 30078

/** The reserved `d`-tag namespace for a group's log offer. NEVER `stiq:`-prefixed. */
export const LOG_OFFER_D_PREFIX = 'space-offer:';

const OFFER_NAME_MAX = 80;
const OFFER_GRADIENT_MAX = 120;

/** Addressable `d` for a group's log offer. Never `stiq:`-prefixed (organizer-reserved). */
export function logOfferDTag(groupId: string): string {
  return `${LOG_OFFER_D_PREFIX}${groupId}`;
}

/** A live log offer, normalized. `rv:true` / garbage / wrong version all parse to `null` instead. */
export interface LogOffer {
  v: 1;
  gid: string;
  /** Group name at time of offer, capped 80 chars. */
  n: string;
  /** Group gradient wire string at time of offer (encodeGradient output), capped 120 chars. */
  g: string;
  /** Mirrors the group's `private` flag. */
  pr: boolean;
  /** Mirrors the group's `closed` flag. */
  cl: boolean;
  /** Mirrors the group's `broadcast` flag. */
  bc: boolean;
  at: number;
}

/** Params to build a live offer (the group's current name/gradient/access flags). */
export interface LogOfferParams {
  gid: string;
  name: string;
  /** Encoded gradient wire string (see media/gradient's `encodeGradient`); omit if none. */
  gradient?: string;
  private: boolean;
  closed: boolean;
  broadcast: boolean;
}

/** Build the unsigned kind-30078 LIVE offer event for a group (signed by the caller — gate on owner). */
export function buildLogOffer(params: LogOfferParams): UnsignedEvent {
  const at = Math.floor(Date.now() / 1000);
  const content: LogOffer = {
    v: 1,
    gid: params.gid,
    n: (params.name || '').slice(0, OFFER_NAME_MAX),
    g: (params.gradient || '').slice(0, OFFER_GRADIENT_MAX),
    pr: params.private,
    cl: params.closed,
    bc: params.broadcast,
    at,
  };
  return {
    kind: KIND_LOG_OFFER,
    created_at: at,
    tags: [['d', logOfferDTag(params.gid)]],
    content: JSON.stringify(content),
  };
}

/** Build the unsigned kind-30078 REVOKE tombstone for a group's offer (same `d`, `rv:true`). */
export function buildLogOfferRevoke(gid: string): UnsignedEvent {
  const at = Math.floor(Date.now() / 1000);
  return {
    kind: KIND_LOG_OFFER,
    created_at: at,
    tags: [['d', logOfferDTag(gid)]],
    content: JSON.stringify({v: 1, gid, rv: true, at}),
  };
}

/**
 * Parse a log-offer event's content JSON defensively. Returns a normalized LIVE offer, or `null`
 * when the content is unparseable, the wrong shape, or an explicit revoke (`rv:true`). All three
 * mean "no live offer". `n` is capped at 80 chars, `g` at 120 — mirrors `issuer/log-offer.mjs`'s
 * `parseOfferContent` exactly.
 */
export function parseLogOfferContent(content: string): LogOffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const j = parsed as Record<string, unknown>;
  if (j.rv === true) return null; // revoke tombstone — supersedes any earlier live offer
  if (j.v !== 1) return null; // unknown envelope version
  if (typeof j.gid !== 'string' || !j.gid) return null;
  return {
    v: 1,
    gid: j.gid,
    n: typeof j.n === 'string' ? j.n.slice(0, OFFER_NAME_MAX) : '',
    g: typeof j.g === 'string' ? j.g.slice(0, OFFER_GRADIENT_MAX) : '',
    pr: j.pr === true,
    cl: j.cl === true,
    bc: j.bc === true,
    at: typeof j.at === 'number' && Number.isFinite(j.at) ? j.at : 0,
  };
}

/** The `d`-tag value on an event, or undefined. */
function dTag(event: Event): string | undefined {
  return event.tags.find(t => t[0] === 'd' && t[1])?.[1];
}

/**
 * The current log offer for a group: the latest (greatest `created_at`) kind-30078 with this
 * group's offer `d`, signed by the group's OWNER (`ownerPubkey`) so an impostor's doc can never
 * shadow or forge an offer — mirrors spaceRules.ts's `getSpaceSettings`. Returns `null` when the
 * owner is unknown, no doc exists, or the latest doc is a revoke / unparseable.
 */
export function currentLogOffer(store: EventStore, groupId: string, ownerPubkey: string): LogOffer | null {
  if (!ownerPubkey) return null;
  const d = logOfferDTag(groupId);
  const latest = store
    .query({kinds: [KIND_LOG_OFFER]})
    .filter(ev => ev.pubkey === ownerPubkey && dTag(ev) === d)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  return parseLogOfferContent(latest.content);
}
