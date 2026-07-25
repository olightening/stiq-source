/**
 * Log "space offer" wire contract — the owner-consent gate for listing PRIVATE NIP-29 groups in the
 * community log-page picker (issuer/log-offer.mjs, used by organizer-server.mjs's GET /api/discover).
 *
 * Unlike mirrors_test.mjs, this does NOT re-implement the logic in lockstep — the pure offer helpers
 * were extracted into issuer/log-offer.mjs precisely so both the server and this test import the SAME
 * code (organizer-server.mjs itself can't be imported without booting the dashboard + minting keys).
 * The CLIENT half publishes offers to this exact shape; these tests pin the shape the dashboard reads.
 */
import {test} from 'node:test';
import assert from 'node:assert';
import {
  SPACE_OFFER_D_PREFIX,
  spaceOfferD,
  parseSpaceOfferD,
  parseOfferContent,
  latestOffersByGid,
  newestOfferOf,
  resolveOfferedGroup,
  offeredGroupFromOffer,
} from './log-offer.mjs';

const GID = 'group-abc123';
const OWNER = 'a'.repeat(64);
const IMPOSTER = 'b'.repeat(64);

// A live offer event as the client publishes it: kind 30078, owner-signed, d=space-offer:<gid>.
function offerEvent({pubkey = OWNER, gid = GID, content, created_at = 1000} = {}) {
  const body = content !== undefined ? content : JSON.stringify({
    v: 1, gid, n: 'Secret Garden', g: 'grad-wire', pr: true, cl: false, bc: false, at: created_at,
  });
  return {kind: 30078, pubkey, created_at, tags: [['d', spaceOfferD(gid)]], content: body};
}

// A resolvable 39000 base entry, as GET /api/discover builds it from group metadata.
function baseEntry(overrides = {}) {
  return {ref: GID, name: 'Secret Garden', gradient: '', closed: false, private: true, broadcast: false, ...overrides};
}

// ── 1. d-tag builder/parse round-trip ────────────────────────────────────────────
test('d-tag builder/parse round-trip and prefix reservation', () => {
  assert.strictEqual(spaceOfferD(GID), 'space-offer:' + GID);
  assert.strictEqual(SPACE_OFFER_D_PREFIX, 'space-offer:');
  assert.strictEqual(parseSpaceOfferD(spaceOfferD(GID)), GID, 'round-trips back to the gid');
  // The d must NEVER be stiq:-prefixed (relay reserves that for the organizer) — never mistaken for one.
  assert.strictEqual(parseSpaceOfferD('stiq:space-offer:' + GID), null, 'a stiq:-prefixed d is not an offer d');
  assert.strictEqual(parseSpaceOfferD('space-offer:'), null, 'an empty gid is not a valid offer d');
  assert.strictEqual(parseSpaceOfferD('39000:' + GID), null, 'a non-offer d is rejected');
  assert.strictEqual(parseSpaceOfferD(null), null, 'a non-string d is rejected');
});

// ── 2. parseOfferContent: live vs revoke vs garbage ──────────────────────────────
test('parseOfferContent honors live offers, revokes, and rejects garbage', () => {
  const live = parseOfferContent(JSON.stringify({v: 1, gid: GID, n: 'Name', g: 'grad', pr: true, cl: true, bc: false, at: 5}));
  assert.deepStrictEqual(live, {v: 1, gid: GID, n: 'Name', g: 'grad', pr: true, cl: true, bc: false, at: 5});
  // Revoke tombstone ⇒ no live offer.
  assert.strictEqual(parseOfferContent(JSON.stringify({v: 1, gid: GID, rv: true, at: 6})), null, 'rv:true ⇒ no live offer');
  // Defensive rejections.
  assert.strictEqual(parseOfferContent('{not json'), null, 'unparseable ⇒ no offer');
  assert.strictEqual(parseOfferContent(JSON.stringify({v: 2, gid: GID})), null, 'unknown version ⇒ no offer');
  assert.strictEqual(parseOfferContent(JSON.stringify({v: 1})), null, 'missing gid ⇒ no offer');
  assert.strictEqual(parseOfferContent('null'), null, 'JSON null ⇒ no offer');
  // Length caps: n at 80, g at 120.
  const capped = parseOfferContent(JSON.stringify({v: 1, gid: GID, n: 'x'.repeat(200), g: 'y'.repeat(200)}));
  assert.strictEqual(capped.n.length, 80, 'n is capped at 80 chars');
  assert.strictEqual(capped.g.length, 120, 'g is capped at 120 chars');
  assert.strictEqual(capped.pr, false, 'absent pr defaults to false');
});

// ── 3. owner-pubkey verification accept/reject ───────────────────────────────────
test('owner verification accepts the owner and rejects an imposter', () => {
  // Owner-signed ⇒ offered + verified, kept.
  const ok = resolveOfferedGroup(baseEntry(), OWNER, offerEvent({pubkey: OWNER}));
  assert.ok(ok, 'a private group with an owner-signed offer is kept');
  assert.strictEqual(ok.offered, true);
  assert.strictEqual(ok.offerVerified, true);

  // Signed by someone other than the resolved owner ⇒ offer dropped ⇒ private group filtered out.
  const dropped = resolveOfferedGroup(baseEntry(), OWNER, offerEvent({pubkey: IMPOSTER}));
  assert.strictEqual(dropped, null, 'a private group whose offer is NOT owner-signed is dropped');

  // Same imposter offer on a NON-private group: offer not verified, but the group still passes.
  const openImposter = resolveOfferedGroup(baseEntry({private: false}), OWNER, offerEvent({pubkey: IMPOSTER}));
  assert.ok(openImposter, 'a non-private group is never dropped');
  assert.strictEqual(openImposter.offered, false, 'the imposter offer is not honored');
  assert.strictEqual(openImposter.offerVerified, false);
});

// ── 4. revoke supersedes a live offer (latest per gid+signer) ────────────────────
test('a later revoke tombstone supersedes an earlier live offer', () => {
  const live = offerEvent({created_at: 1000});
  const revoke = offerEvent({created_at: 2000, content: JSON.stringify({v: 1, gid: GID, rv: true, at: 2000})});
  // Order-independent: latestOffersByGid keeps the newest created_at per (gid, signer).
  for (const batch of [[live, revoke], [revoke, live]]) {
    const latest = latestOffersByGid(batch).get(GID).get(OWNER);
    assert.strictEqual(latest.created_at, 2000, 'newest event per (gid, signer) wins');
    // The revoke wins ⇒ the private group is dropped by resolveOfferedGroup.
    assert.strictEqual(resolveOfferedGroup(baseEntry(), OWNER, latest), null, 'revoke ⇒ private group dropped');
  }
  // And with only the live offer present, the group survives.
  assert.ok(resolveOfferedGroup(baseEntry(), OWNER, latestOffersByGid([live]).get(GID).get(OWNER)));
});

// ── 4b. a non-owner's newer event can never shadow the owner's offer ─────────────
test('shadowing regression: an imposter’s newer offer does not displace the owner’s live offer', () => {
  const ownerLive = offerEvent({pubkey: OWNER, created_at: 1000});
  const imposterNewer = offerEvent({pubkey: IMPOSTER, created_at: 9999});
  for (const batch of [[ownerLive, imposterNewer], [imposterNewer, ownerLive]]) {
    const signers = latestOffersByGid(batch).get(GID);
    // Owner-known path: the lookup is BY the owner's pubkey — the imposter's newer event is
    // invisible to it, so the group stays listed (before the per-signer dedupe, the imposter's
    // event shadowed the owner's out of a flat latest-per-gid map ⇒ silent delisting).
    const entry = resolveOfferedGroup(baseEntry(), OWNER, signers.get(OWNER));
    assert.ok(entry, 'the group stays listed despite the imposter’s newer event');
    assert.strictEqual(entry.offerVerified, true);
    // Degraded path (owner unknown): newest-across-signers is all it can do — and it is marked
    // offerVerified:false for exactly this reason.
    assert.strictEqual(newestOfferOf(signers).pubkey, IMPOSTER, 'degraded fallback is newest-across-signers');
  }
});

// ── 5. private-without-verified-offer dropped while non-private passes ────────────
test('enforcement: unoffered private groups drop, non-private groups pass unfiltered', () => {
  // Private + NO offer at all ⇒ dropped.
  assert.strictEqual(resolveOfferedGroup(baseEntry(), OWNER, undefined), null, 'private + no offer ⇒ dropped');
  // Non-private + no offer ⇒ passes through, offered:false.
  const openEntry = resolveOfferedGroup(baseEntry({private: false, closed: true}), OWNER, undefined);
  assert.ok(openEntry, 'a closed (non-private) group with no offer still lists');
  assert.strictEqual(openEntry.offered, false);
  assert.strictEqual(openEntry.offerVerified, false);
  assert.strictEqual(openEntry.private, false, 'non-private flags pass through unchanged');
  assert.strictEqual(openEntry.closed, true);
});

// ── 6. degraded unverified path carries n/g/flags ────────────────────────────────
test('degraded (39000 unresolvable) path builds the entry from the offer and marks it unverified', () => {
  const ev = offerEvent({
    content: JSON.stringify({v: 1, gid: GID, n: 'Carried Name', g: 'carried-grad', pr: true, cl: true, bc: false, at: 9}),
  });
  const entry = offeredGroupFromOffer(GID, ev);
  assert.deepStrictEqual(entry, {
    ref: GID,
    name: 'Carried Name',
    gradient: 'carried-grad',
    closed: true,
    private: true,
    broadcast: false,
    offered: true,
    offerVerified: false,
  }, 'the entry carries the offer’s own n/g/pr/cl/bc and is marked unverified');

  // A revoke / garbage offer yields no degraded entry.
  assert.strictEqual(offeredGroupFromOffer(GID, offerEvent({content: JSON.stringify({v: 1, gid: GID, rv: true, at: 1})})), null,
    'a revoked offer produces no degraded entry');
  assert.strictEqual(offeredGroupFromOffer(GID, undefined), null, 'no offer ⇒ no degraded entry');
});
