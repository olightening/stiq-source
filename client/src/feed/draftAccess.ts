/**
 * Draft access control — "a key to enter" (Phase 5§D; see the plan's Phase 5 intro).
 *
 * A shared `stiq:draft:` embed (draftEmbed.ts, v2) is a PREVIEW POINTER, not the content: the real
 * writing is delivered only to pubkeys the owner has approved, and that approval is revocable. This
 * module is the pure data layer behind that — it mirrors `channels/membership.ts`'s join-request
 * shape as closely as the two domains allow, reusing the SAME primitives rather than inventing a
 * parallel pattern:
 *
 *  1. DRAFT ACCESS REQUEST (kind `Kind.DraftAccessRequest`, regular — see contracts/index.ts) — a
 *     viewer who opens a teaser asks the owner for the real writing. Tags `[['d', draftId],
 *     ['p', ownerPubkey]]`; content is a NIP-44 seal-to-owner of `{v:1, n?: requesterDisplayName}`
 *     (mirrors `JoinNotePayload`, minus the free-text `t` note — a draft request carries only a
 *     name). Unlike a 9021 join request, there is only ONE recipient (the owner), so the content is
 *     a single ciphertext string, not the per-admin seal MAP `encodeJoinNoteContent` builds — the
 *     actual `sealForPeer`/`openFromPeer` calls happen in AppRuntime (see `requestDraftAccess`),
 *     exactly where `sealJoinNoteFor`/`unsealJoinNote` live for the join flow; this module only
 *     owns the plaintext payload's wire codec.
 *
 *  2. DRAFT-ACCESS DOC (kind-30078 AppData, `d = "draft-access:<draftId>"`, ONE per owner) — the
 *     owner's grant/revoke ledger: `{v:1, grants:[{p,at}], revokes:[{p,at}]}`. {@link foldDraftAccess}
 *     mirrors `foldInvites` (membership.ts:278) in shape: latest grant per pubkey wins unless a
 *     same-or-later revoke exists. Simpler than `foldInvites` in one respect — a draft has exactly
 *     ONE owner (no multi-admin "anyone can invite" concept), so there is no "current members drop
 *     off" step; once granted, a viewer stays granted until an explicit revoke, full stop. The
 *     `authorized` parameter is kept anyway (rather than assuming a single implicit author) so the
 *     fold algorithm stays a byte-for-byte structural twin of `foldInvites` and so a caller can
 *     never accidentally fold in a doc from a spoofing non-owner pubkey.
 *
 *  3. DRAFT DELIVERY (kind `Kind.DraftDelivery`, parameterized-replaceable — see contracts/index.ts)
 *     — the owner's response to an approved request: the FULL frozen snapshot
 *     `{v1, ti?, b, tg?, l?, cw?}`, NIP-44-sealed DIRECTLY to the requester's pubkey. Same primitive
 *     as `groupCrypto.ts`'s `wrapKeyForMember` (`getConversationKey` + `nip44.encrypt`) — in practice
 *     just `Identity.sealForPeer`/`openFromPeer`, since a draft snapshot has no ongoing stream to
 *     re-key the way a group's symmetric space key does, so there is no wrap-a-key indirection here,
 *     only the content itself. Being parameterized-replaceable is not just idle plumbing — it is
 *     what lets "re-approving delivers an updated snapshot" (the locked "edit propagation" decision)
 *     AND revocation both work as a plain republish under the SAME `d` tag with a newer
 *     `created_at`: {@link AppRuntime.revokeDraftAccess} republishes a TOMBSTONE delivery (sealed
 *     {@link DRAFT_DELIVERY_TOMBSTONE} plaintext — NIP-44 rejects a truly empty one) at the same
 *     slot, so any FRESH read of "the latest delivery for
 *     (draftId, requesterPubkey)" no longer resolves to real content — while a requester's client
 *     that already decrypted the real snapshot before the revoke keeps whatever it already cached,
 *     exactly the forward-secrecy-not-retroactive posture already accepted for a group kick.
 *
 * Everything that needs the requester's or owner's SECRET KEY (the actual seal/unseal calls) lives
 * in `app/AppRuntime.ts`'s new methods, not here — this module stays PURE (no Identity import, no
 * React), exactly like `channels/membership.ts` keeps its own crypto calls out and lets AppRuntime's
 * `sealJoinNoteFor`/`unsealJoinNote` own them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Event} from 'nostr-tools/pure';
import type {EventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {draftAccessDeniedKey} from '../app/workspaceKeys';

// ── 1. Draft access request (kind DraftAccessRequest) ──────────────────────────────────────────

/** Cap on the requester's carried display name — mirrors `JoinNotePayload.n`'s 80-char clamp. */
export const MAX_DRAFT_ACCESS_NAME = 80;

/** Plaintext the owner unseals: the requester's display name at request time (the owner may never
 *  have seen this npub before). Mirrors {@link JoinNotePayload}, minus the free-text `t` note — a
 *  draft-access ask needs no separate "why", the request itself IS the ask. */
export interface DraftAccessRequestPayload {
  n?: string;
}

/** Serialize the payload the requester seals to the owner. */
export function encodeDraftAccessPayload(p: DraftAccessRequestPayload): string {
  const out: DraftAccessRequestPayload = {};
  if (p.n) out.n = p.n.slice(0, MAX_DRAFT_ACCESS_NAME);
  return JSON.stringify({v: 1, ...out});
}

/** Parse a decrypted seal back to the payload. Never throws (untrusted content once decrypted). */
export function parseDraftAccessPayload(json: string): DraftAccessRequestPayload | null {
  try {
    const p = JSON.parse(json) as {v?: unknown; n?: unknown} | null;
    if (!p || typeof p !== 'object' || p.v !== 1) return null;
    const out: DraftAccessRequestPayload = {};
    if (typeof p.n === 'string' && p.n) out.n = p.n.slice(0, MAX_DRAFT_ACCESS_NAME);
    return out;
  } catch {
    return null;
  }
}

/** The wire tags for a `DraftAccessRequest` event: `[['d', draftId], ['p', ownerPubkey]]`. */
export function buildDraftAccessRequestTags(draftId: string, ownerPubkey: string): string[][] {
  return [
    ['d', draftId],
    ['p', ownerPubkey],
  ];
}

/**
 * The latest `DraftAccessRequest` per requester pubkey, addressed to `ownerPubkey` for `draftId`.
 * Mirrors `latestJoinRequests` (membership.ts:107) — a re-request supersedes an older one from the
 * same pubkey rather than accumulating duplicates in the owner's queue.
 */
export function latestDraftAccessRequests(
  store: EventStore,
  draftId: string,
  ownerPubkey: string,
): Map<string, Event> {
  const latest = new Map<string, Event>();
  for (const ev of store.query({kinds: [Kind.DraftAccessRequest]})) {
    if (!ev.tags.some(t => t[0] === 'd' && t[1] === draftId)) continue;
    if (!ev.tags.some(t => t[0] === 'p' && t[1] === ownerPubkey)) continue;
    const cur = latest.get(ev.pubkey);
    if (!cur || ev.created_at > cur.created_at) latest.set(ev.pubkey, ev);
  }
  return latest;
}

// ── 2. Draft-access doc (kind-30078 AppData, d = "draft-access:<draftId>") ─────────────────────

/** Re-exported for callers that want the literal kind number without importing `Kind` too. */
export const KIND_DRAFT_ACCESS = Kind.AppData; // 30078
export const DRAFT_ACCESS_D_PREFIX = 'draft-access:';

/** Addressable `d` tag for a draft's access-control doc. */
export function draftAccessDTag(draftId: string): string {
  return `${DRAFT_ACCESS_D_PREFIX}${draftId}`;
}

/** One grant or revoke entry: the target pubkey + when the owner recorded it (unix seconds). */
export interface DraftGrant {
  p: string;
  at: number;
}
export type DraftRevoke = DraftGrant;

/** One owner's doc: their current grants + their revokes (a full ledger, not an incremental diff —
 *  every publish carries the complete state, mirroring `SpaceInvitesDoc`). */
export interface DraftAccessDoc {
  grants: DraftGrant[];
  revokes: DraftRevoke[];
}

export function encodeDraftAccessDoc(doc: DraftAccessDoc): string {
  return JSON.stringify({v: 1, grants: doc.grants, revokes: doc.revokes});
}

/** Parse one owner's doc content. Never throws. */
export function parseDraftAccessDoc(json: string): DraftAccessDoc | null {
  try {
    const wire = JSON.parse(json) as {v?: number; grants?: unknown; revokes?: unknown} | null;
    if (!wire || typeof wire !== 'object' || wire.v !== 1) return null;
    const grants = parseGrantArray(wire.grants);
    const revokes = parseGrantArray(wire.revokes);
    return {grants, revokes};
  } catch {
    return null;
  }
}

function parseGrantArray(raw: unknown): DraftGrant[] {
  const out: DraftGrant[] = [];
  if (!Array.isArray(raw)) return out;
  for (const e of raw) {
    const x = e as Partial<DraftGrant> | null;
    if (!x || typeof x !== 'object') continue;
    if (typeof x.p !== 'string' || !/^[0-9a-f]{64}$/i.test(x.p)) continue;
    if (typeof x.at !== 'number' || !Number.isFinite(x.at)) continue;
    out.push({p: x.p.toLowerCase(), at: Math.floor(x.at)});
  }
  return out;
}

/**
 * Fold the authorized owner's draft-access doc(s) into the current granted set: latest grant per
 * pubkey wins unless a same-or-later revoke exists for that pubkey. Mirrors `foldInvites`
 * (membership.ts:278) in shape and algorithm; the one deliberate omission is `foldInvites`'
 * "current members drop off" step — a draft grant has no membership-completion event that would
 * retire it, so a grant simply stands until an explicit revoke outranks it.
 */
export function foldDraftAccess(
  docs: {author: string; doc: DraftAccessDoc}[],
  authorized: ReadonlySet<string>,
): DraftGrant[] {
  const bestGrant = new Map<string, DraftGrant>();
  const bestRevokeAt = new Map<string, number>();
  for (const {author, doc} of docs) {
    if (!authorized.has(author)) continue;
    for (const g of doc.grants) {
      const cur = bestGrant.get(g.p);
      if (!cur || g.at > cur.at) bestGrant.set(g.p, g);
    }
    for (const r of doc.revokes) {
      const cur = bestRevokeAt.get(r.p);
      if (cur === undefined || r.at > cur) bestRevokeAt.set(r.p, r.at);
    }
  }
  const out: DraftGrant[] = [];
  for (const [pk, g] of bestGrant) {
    const revokedAt = bestRevokeAt.get(pk);
    if (revokedAt !== undefined && revokedAt >= g.at) continue;
    out.push(g);
  }
  return out.sort((a, b) => b.at - a.at);
}

// ── 3. Draft delivery (kind DraftDelivery, d = "draft-delivery:<draftId>:<requesterPubkey>") ───

export const DRAFT_DELIVERY_D_PREFIX = 'draft-delivery:';

/** Addressable `d` tag for one requester's delivery slot of one draft. */
export function draftDeliveryDTag(draftId: string, requesterPubkey: string): string {
  return `${DRAFT_DELIVERY_D_PREFIX}${draftId}:${requesterPubkey}`;
}

/** The wire tags for a `DraftDelivery` event: `[['d', <slot>], ['p', requesterPubkey]]`. */
export function buildDraftDeliveryTags(draftId: string, requesterPubkey: string): string[][] {
  return [
    ['d', draftDeliveryDTag(draftId, requesterPubkey)],
    ['p', requesterPubkey],
  ];
}

/**
 * The frozen snapshot delivered on approval — the real content the v2 draft-embed teaser withholds
 * (draftEmbed.ts's `DraftEmbedWireV2` carries only `id`/`ti`/`sn`/identity; this carries the rest).
 * `b` (the full body) is the only required field; everything else mirrors what a draft may carry.
 */
export interface DraftDeliverySnapshot {
  ti?: string;
  b: string;
  tg?: string[];
  l?: string;
  cw?: string;
}

/** Generous corruption/DoS guard on PARSE only — never applied to encode/truncate a real body; a
 *  draft can legitimately be a long article. */
const MAX_SNAPSHOT_JSON_LEN = 200_000;

export function encodeDraftDeliverySnapshot(s: DraftDeliverySnapshot): string {
  const wire: {v: 1} & DraftDeliverySnapshot = {v: 1, b: s.b};
  if (s.ti) wire.ti = s.ti;
  if (s.tg && s.tg.length > 0) wire.tg = s.tg;
  if (s.l) wire.l = s.l;
  if (s.cw) wire.cw = s.cw;
  return JSON.stringify(wire);
}

/**
 * The plaintext {@link AppRuntime.revokeDraftAccess} seals as its tombstone delivery. NIP-44 v2
 * REJECTS a truly empty plaintext (`invalid plaintext size: must be between 1 and 4294967295
 * bytes`), so a revoke cannot seal `''` — it seals this instead: valid JSON, but missing the
 * required `v:1` envelope, so {@link parseDraftDeliverySnapshot} rejects it exactly like a
 * corrupt/malicious payload would. A tombstone and a genuinely unreadable delivery therefore read
 * the same way to every caller: "nothing valid was delivered here."
 */
export const DRAFT_DELIVERY_TOMBSTONE = '{}';

/**
 * Parse a decrypted delivery snapshot. Never throws. Returns `null` (rather than an empty-body
 * snapshot) for {@link DRAFT_DELIVERY_TOMBSTONE}'s plaintext — it parses as valid JSON but carries
 * no `v:1`/`b`, so it falls through the same validation an actually-corrupt payload would.
 */
export function parseDraftDeliverySnapshot(json: string): DraftDeliverySnapshot | null {
  try {
    if (json.length > MAX_SNAPSHOT_JSON_LEN) return null;
    const wire = JSON.parse(json) as
      | {v?: number; ti?: unknown; b?: unknown; tg?: unknown; l?: unknown; cw?: unknown}
      | null;
    if (!wire || typeof wire !== 'object' || wire.v !== 1) return null;
    if (typeof wire.b !== 'string') return null;
    const out: DraftDeliverySnapshot = {b: wire.b};
    if (typeof wire.ti === 'string' && wire.ti) out.ti = wire.ti;
    if (Array.isArray(wire.tg)) {
      const tags = wire.tg.filter((t): t is string => typeof t === 'string');
      if (tags.length > 0) out.tg = tags;
    }
    if (typeof wire.l === 'string' && wire.l) out.l = wire.l;
    if (typeof wire.cw === 'string' && wire.cw) out.cw = wire.cw;
    return out;
  } catch {
    return null;
  }
}

// ── Local requester-side bookkeeping the owner needs (no relay-side pending list exists) ───────

/**
 * Draft-access requests THIS OWNER has silently denied — {@link AppRuntime.denyDraftAccess}
 * publishes nothing at all (the locked "stays pending forever, requester never told" decision), so
 * unlike a NIP-29 join deny (a real 9001 the relay's 39004 pending set then omits), nothing else
 * would ever stop the same request from re-appearing in `getDraftAccessQueue` forever. This local,
 * per-account record is that memory. Keyed `${draftId}:${requesterPubkey}` → the denied request's
 * `at` (its `created_at`); a STRICTLY NEWER re-request (bigger `at`) re-surfaces in the queue —
 * mirrors membership.ts's `loadDismissedInvites`/`saveDismissedInvites` "Not now" precedent exactly.
 *
 * Best-effort and DEVICE-LOCAL: denying on one device doesn't stop a sibling device (or a fresh
 * install) from showing the same pending request again — an accepted limitation of a feature that
 * is, by design, client-enforced only (see the module doc's "no relay-side pending list" point).
 */
export async function loadDeniedDraftAccess(slotId?: string): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(draftAccessDeniedKey(slotId));
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

export async function saveDeniedDraftAccess(map: Record<string, number>, slotId?: string): Promise<void> {
  try {
    await AsyncStorage.setItem(draftAccessDeniedKey(slotId), JSON.stringify(map));
  } catch {
    // best effort
  }
}

// ── Phase 7§A: synthetic comment-thread root (runtime half consumed by AppRuntime.getDraftThread) ─

/**
 * Sentinel "kind" for the synthetic {@link EventRef}-shaped root object a draft's comment thread
 * hangs off (`{id: shareId, pubkey: draft.author ?? '', kind: DRAFT_COMMENT_ROOT_KIND}`), used the
 * same way `App.tsx`'s post-comment handler builds a real post's root. MUST be ≠ `Kind.Post` (1) so
 * `buildPostComment` (feed/comments.ts) takes the plain kind-1111 branch instead of the hybrid
 * kind-1 "stiq-comment" branch reserved for actual published notes — a draft (which may never be
 * published at all, or may be published as an ARTICLE rather than a note) has no business claiming
 * the kind-1-note comment shape. Never signed or published itself; it exists purely as the in-memory
 * value passed to `runtime.comment(text, draftRoot, parent)` / `buildThread`.
 */
export const DRAFT_COMMENT_ROOT_KIND = 800_001;
