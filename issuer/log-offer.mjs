/**
 * Log "space offer" wire contract — the owner-consent gate for listing PRIVATE NIP-29 groups in the
 * community log-page picker.
 *
 * A private group used to appear in `GET /api/discover` with no say from its owner. New rule: a
 * `private:true` group is listable ONLY when its owner has published a live "log offer" event:
 *
 *   - kind 30078, OWNER-signed, tag ["d", "space-offer:<groupId>"]. The `d` is NEVER `stiq:`-prefixed
 *     (the relay reserves that prefix for the organizer's own config events).
 *   - Live offer content JSON: {"v":1,"gid":"<gid>","n":"<name ≤80>","g":"<gradient ≤120, opt>",
 *     "pr":<bool>,"cl":<bool>,"bc":<bool>,"at":<unix>} — pr/cl/bc mirror private/closed/broadcast.
 *   - Revoke: republish the same `d` with {"v":1,"gid":"<gid>","rv":true,"at":<unix>}. NIP-33
 *     addressable replacement — latest per (pubkey,d) wins, so a revoke tombstone supersedes any
 *     earlier live offer.
 *
 * These are the PURE helpers, split out of organizer-server.mjs so `issuer/log_offer_test.mjs` can
 * import and exercise them directly — organizer-server.mjs itself can't be imported without booting
 * the whole dashboard + minting keys. The CLIENT half (owner publishes the offer) is built to this
 * EXACT shape; do not deviate.
 */

/** The reserved `d`-tag namespace for a group's log offer. NEVER `stiq:`-prefixed. */
export const SPACE_OFFER_D_PREFIX = 'space-offer:';

const OFFER_NAME_MAX = 80;
const OFFER_GRADIENT_MAX = 120;

/** Build the addressable `d`-tag for a group's log offer. */
export function spaceOfferD(gid) {
  return SPACE_OFFER_D_PREFIX + String(gid || '');
}

/** Parse a `space-offer:<gid>` d-tag back to its groupId, or null if it isn't one. */
export function parseSpaceOfferD(d) {
  if (typeof d !== 'string' || !d.startsWith(SPACE_OFFER_D_PREFIX)) return null;
  const gid = d.slice(SPACE_OFFER_D_PREFIX.length);
  return gid || null;
}

/** First value of the named tag on an event, or '' when absent. (Local copy of the server's evTag.) */
function offerTag(ev, name) {
  const t = ev && ev.tags && ev.tags.find(x => x && x[0] === name);
  return t && typeof t[1] === 'string' ? t[1] : '';
}

/**
 * Parse a log-offer event's content JSON defensively. Returns a normalized LIVE offer
 * {v,gid,n,g,pr,cl,bc,at} — or null when the content is unparseable, the wrong shape, or an explicit
 * revoke (`rv:true`). All three mean "no live offer". `n` is capped at 80 chars, `g` at 120.
 */
export function parseOfferContent(content) {
  let j;
  try { j = JSON.parse(content); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  if (j.rv === true) return null;            // revoke tombstone — supersedes any earlier live offer
  if (j.v !== 1) return null;                // unknown envelope version
  if (typeof j.gid !== 'string' || !j.gid) return null;
  return {
    v: 1,
    gid: j.gid,
    n: typeof j.n === 'string' ? j.n.slice(0, OFFER_NAME_MAX) : '',
    g: typeof j.g === 'string' ? j.g.slice(0, OFFER_GRADIENT_MAX) : '',
    pr: j.pr === true,
    cl: j.cl === true,
    bc: j.bc === true,
    at: Number.isFinite(j.at) ? j.at : 0,
  };
}

/**
 * De-dupe a batch of log-offer events to gid → (signer pubkey → that signer's latest event by
 * created_at). NIP-33 replacement is per (pubkey,d), so different signers' events legitimately
 * coexist on the relay — and the dedupe MUST be keyed per signer too: a flat latest-per-gid map
 * would let any bound member publish a newer bogus `space-offer:<gid>` that shadows the owner's
 * real offer out of the map, silently delisting the space (griefing, not spoofing — verification
 * would fail — but still a wrongful drop). The owner-known path looks up exactly the owner's entry;
 * the degraded path (owner unknown) falls back to {@link newestOfferOf}.
 */
export function latestOffersByGid(offerEvents) {
  const byGid = new Map();
  for (const ev of offerEvents || []) {
    const gid = parseSpaceOfferD(offerTag(ev, 'd'));
    if (!gid) continue;
    let signers = byGid.get(gid);
    if (!signers) { signers = new Map(); byGid.set(gid, signers); }
    const prev = signers.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) signers.set(ev.pubkey, ev);
  }
  return byGid;
}

/** Newest offer event across ALL signers of one gid's signer-map — degraded-path only (with no
 *  resolvable 39000 there is no owner to prefer; the entry is marked offerVerified:false anyway). */
export function newestOfferOf(signers) {
  let best = null;
  for (const ev of signers ? signers.values() : []) {
    if (!best || ev.created_at > best.created_at) best = ev;
  }
  return best;
}

/**
 * Finalize a group discover entry whose 39000 metadata IS resolvable (the normal case today).
 *   - `base`: the entry built from 39000 {ref,name,gradient,closed,private,broadcast}.
 *   - `ownerHex`: evTag(metaEvent,'owner') — the group's claimed owner.
 *   - `offerEvent`: the latest offer event for this gid, or undefined.
 * Returns `{...base, offered, offerVerified}` — or null when enforcement drops it. Because the owner
 * is known here, an offer is honored ONLY if it is owner-signed (`offerEvent.pubkey === ownerHex`); a
 * mismatch drops the offer entirely (silently invalidates offers after an ownership transfer). A
 * `private:true` group without a verified offer is dropped; non-private groups always pass through.
 */
export function resolveOfferedGroup(base, ownerHex, offerEvent) {
  const parsed = offerEvent ? parseOfferContent(offerEvent.content) : null;
  let offered = false;
  let offerVerified = false;
  if (parsed && offerEvent.pubkey === ownerHex) {
    offered = true;
    offerVerified = true;
  }
  const entry = {...base, offered, offerVerified};
  if (entry.private && !(offered && offerVerified)) return null;
  return entry;
}

/**
 * Future hardened-relay state: a groupId known from kind-9007 whose 39000 metadata is NOT resolvable,
 * but which carries a live owner-signed offer. Ownership can't be checked (no 39000 owner to compare
 * against), so build the entry from the offer's own carried fields and mark it offerVerified:false so
 * the picker can surface an "unverified owner" caveat. Returns null if there is no live offer. These
 * degraded entries are always kept (they're offered, just unverifiable).
 */
export function offeredGroupFromOffer(gid, offerEvent) {
  const parsed = offerEvent ? parseOfferContent(offerEvent.content) : null;
  if (!parsed) return null;
  return {
    ref: gid,
    name: parsed.n || 'group',
    gradient: parsed.g || '',
    closed: parsed.cl,
    private: parsed.pr,
    broadcast: parsed.bc,
    offered: true,
    offerVerified: false,
  };
}
