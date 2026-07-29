/**
 * Moderator roster: signing + the publish state machine.
 *
 * The 2026-07-15 audit recorded "no issuer test for signRoster / /api/moderators*" as a gap; the
 * 2026-07-29 re-audit found it still open — the only `sign*` in the dashboard with zero coverage
 * across 22 test files, and simultaneously the one whose failure mode is a moderator who was
 * "removed" but still has power. Both halves are pinned here:
 *
 *   1. `signRoster` (the real signer, imported) yields the kind-30078 d=stiq:moderators event whose
 *      `p` tags the relay reads in internal/policy/organizer.go and the client reads in
 *      moderation/organizerConfig.ts currentModerators — hex pubkeys, not npubs.
 *   2. `rosterUnpublished` — the disagreement detector behind the dashboard's stale-roster warning.
 *      moderators.json is NOT the enforced roster; the last PUBLISHED event is. While they differ,
 *      a removed moderator keeps full power, so the dashboard has to be able to say so.
 *
 * A REVOCATION is the asymmetric case throughout: failing to publish an ADD just means a new
 * moderator can't act yet (annoying), while failing to publish a REMOVE means someone you fired is
 * still moderating (an incident). That is why add/remove now publish automatically instead of
 * leaving it to a button.
 */
import assert from 'assert';
import {fileURLToPath, pathToFileURL} from 'url';
import {dirname, join} from 'path';
import {signRoster} from './organizer-nostr.mjs';
import {rosterUnpublished} from './roster.mjs';

// The issuer has no node_modules of its own — it resolves deps from ../client/node_modules, in
// production as well as here (see organizer-nostr.mjs's NT_PATH). Load nostr-tools the same way.
const nt = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../client/node_modules/nostr-tools/lib/esm/index.js')).href
);
const {nip19, generateSecretKey, getPublicKey} = nt;

const hexA = getPublicKey(generateSecretKey());
const hexB = getPublicKey(generateSecretKey());
const npubA = nip19.npubEncode(hexA);
const npubB = nip19.npubEncode(hexB);

// ── 1. signRoster: the cross-layer wire contract ─────────────────────────────────

{
  const event = signRoster([npubA, npubB]);
  assert.strictEqual(event.kind, 30078, 'the roster publishes as kind-30078');
  assert.ok(
    event.tags.some(t => t[0] === 'd' && t[1] === 'stiq:moderators'),
    'addressed by d=stiq:moderators (the relay reserves the whole stiq: prefix to the organizer)',
  );
  assert.deepStrictEqual(
    event.tags.filter(t => t[0] === 'p').map(t => t[1]),
    [hexA, hexB],
    'moderators ride as HEX p tags — both the relay gate and the client fold compare hex pubkeys',
  );
  assert.strictEqual(event.content, '', 'the roster carries no content; the tags are the roster');
  assert.ok(event.sig && event.id, 'the event is signed by the organizer key');
}

// A malformed npub must be SKIPPED, never crash the publish and never land as a garbage tag: one bad
// row in moderators.json would otherwise take down every roster publish, including a revocation.
{
  const event = signRoster([npubA, 'npub1notvalid', '', null, undefined, 'garbage']);
  assert.deepStrictEqual(
    event.tags.filter(t => t[0] === 'p').map(t => t[1]),
    [hexA],
    'malformed entries are dropped and the valid moderators still publish',
  );
}

// The empty roster is LEGAL and load-bearing: it is how an organizer removes their last moderator.
// (Contrast the member roll, where an empty set is refused — there it would hide every member.)
{
  const event = signRoster([]);
  assert.deepStrictEqual(event.tags.filter(t => t[0] === 'p'), [],
    'an empty roster signs cleanly — removing the last moderator must be expressible');
}

// Wholesale replacement is the revocation mechanism (relay: organizer.go applies the newest roster
// as the WHOLE set, it does not merge), so a later roster omitting someone IS the removal.
{
  const before = signRoster([npubA, npubB]);
  const after = signRoster([npubA]);
  assert.strictEqual(before.tags.filter(t => t[0] === 'p').length, 2);
  assert.deepStrictEqual(after.tags.filter(t => t[0] === 'p').map(t => t[1]), [hexA],
    'the published roster is the complete set — omission is how a moderator is revoked');
}

// ── 2. rosterUnpublished: the stale-roster detector ──────────────────────────────

assert.strictEqual(rosterUnpublished(null, [npubA]), null,
  'nothing published this process yet ⇒ UNKNOWN, not "stale" — a previous run may hold a correct roster');
assert.strictEqual(rosterUnpublished(undefined, []), null, 'undefined is treated as unknown too');

assert.strictEqual(rosterUnpublished([npubA], [npubA]), false,
  'file matches what the relay was told ⇒ nothing stranded');

assert.strictEqual(rosterUnpublished([npubA, npubB], [npubA]), true,
  'a REMOVAL that has not been published is stranded — the removed moderator still has power');

assert.strictEqual(rosterUnpublished([npubA], [npubA, npubB]), true,
  'an unpublished ADD is stranded too (the new moderator simply cannot act yet)');

assert.strictEqual(rosterUnpublished([npubA, npubB], [npubB, npubA]), false,
  'order is not a difference — the roster is a SET; a reorder must not raise a false alarm');

assert.strictEqual(rosterUnpublished([], []), false, 'empty vs empty agrees');
assert.strictEqual(rosterUnpublished([], [npubA]), true, 'first moderator added, not yet published');
assert.strictEqual(rosterUnpublished([npubA], []), true,
  'the LAST moderator removed but not published — every client still honours them');

// The comparison must not mutate its inputs (it sorts copies): organizer-server.mjs passes the live
// arrays straight in, and reordering `moderators.json`'s in-memory list would rewrite the file's
// order on the next save for no reason.
{
  const published = [npubB, npubA];
  const current = [npubB, npubA];
  rosterUnpublished(published, current);
  assert.deepStrictEqual(published, [npubB, npubA], 'the published array is left untouched');
  assert.deepStrictEqual(current, [npubB, npubA], 'the current array is left untouched');
}

console.log('roster_publish_test: OK');
