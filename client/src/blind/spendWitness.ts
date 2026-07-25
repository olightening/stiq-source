/**
 * spendWitness — P4 double-spend witness: a self-verifying, advisory conflict proof that names two
 * DISTINCT events which each VALIDLY spend the SAME holder-bound token (see ./doubleSpend and
 * ./holderProof).
 *
 * WHY it is safe to broadcast AND safe to act on (VERIFY-NEVER-TRUST): a P4 token is holder-bound —
 * only the true holder can produce a second valid spend of it. The organizer never saw the secret
 * `q`, and an outsider who copies the public `Q` off the wire cannot forge a fresh holder proof over
 * a DIFFERENT event.pubkey. So a token that appears WITH A VALID SPEND under two distinct event ids
 * can ONLY be its holder double-spending — detection can never hide an honest member's single legit
 * post, and neither the signer nor the relay can weaponise it. A witness therefore carries NO trust:
 * {@link verifySpendWitness} re-derives the conflict from the referenced events themselves before
 * returning any loser, so a forged or mislabelled witness proves — and hides — nothing.
 *
 * The witness is an ordinary bound-member event (kind {@link KIND_SPEND_WITNESS}, admitted like a
 * moderation report on the relay's bound-member path) so it rides the feed firehose and mirrors/
 * clients share the signal. Its winner/loser labelling is only a hint for humans; the crypto that
 * decides what gets hidden is re-checked locally, never read off the tags.
 */
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import type {EventStore} from '../nostr/store';
import {detectDoubleSpends} from './doubleSpend';
import {KIND_SPEND_WITNESS} from '../contracts';

/**
 * Tag naming the doubly-spent token by its hex TokenID (see doubleSpend.tokenId). This is CLIENT-ONLY
 * vocabulary — the relay admits the witness kind blindly and never reads this tag — so it lives here
 * beside its sole consumer rather than in the shared client/relay contract module. The two event
 * references use the bare Nostr `e` tag (winner first, loser second), matching moderation reports
 * (moderation/report.ts). Order is a hint only; verifySpendWitness re-derives which one is the loser.
 */
const DS_TAG = 'stiq_ds';

/**
 * Build the unsigned double-spend witness naming `winnerId` (the event kept) and `loserId` (the event
 * to hide) as the two distinct spenders of the token `tokenIdHex`. The caller signs it with the bound
 * member's real key — exactly like a moderation report (moderation/report.ts) — so it is attributable
 * and rides the feed firehose. Content is empty: everything the witness asserts lives in its tags, and
 * a consumer re-derives the conflict rather than trusting them (see {@link verifySpendWitness}).
 */
export function buildSpendWitness(tokenIdHex: string, winnerId: string, loserId: string): UnsignedEvent {
  return {
    kind: KIND_SPEND_WITNESS,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', winnerId],
      ['e', loserId],
      [DS_TAG, tokenIdHex],
    ],
    content: '',
  };
}

/**
 * Parse a witness event into its token id + referenced event ids. Returns null for the wrong kind,
 * fewer than the two required `e` tags, or a missing `stiq_ds` tag — i.e. anything that isn't
 * structurally a witness. This is a pure STRUCTURAL read; it asserts nothing about whether the named
 * events actually collide (that is {@link verifySpendWitness}'s job).
 */
export function parseSpendWitness(ev: Event): {tokenId: string; eventIds: string[]} | null {
  if (ev.kind !== KIND_SPEND_WITNESS) return null;
  const eventIds: string[] = [];
  let tokenId: string | undefined;
  for (const t of ev.tags) {
    // A witness names EXACTLY one winner + one loser; cap the collected ids at two so a padded
    // witness (thousands of bogus `e` tags) can't drive an unbounded by-id fetch in the consumer.
    if (t[0] === 'e' && t[1] && eventIds.length < 2) eventIds.push(t[1]);
    else if (t[0] === DS_TAG && t[1] && tokenId === undefined) tokenId = t[1];
  }
  if (eventIds.length < 2 || tokenId === undefined) return null;
  return {tokenId, eventIds};
}

/**
 * VERIFY-NEVER-TRUST a witness. Look the referenced event ids up in the local store, run
 * {@link detectDoubleSpends} over ONLY those events, and return the loser ids that detection PROVES
 * collide on the witness's own token — intersected with the events the witness actually named. The
 * witness's winner/loser labels are ignored entirely; the loser set is re-derived from the events'
 * verified spends, so swapping the labels can never change what gets hidden.
 *
 * Returns [] whenever no real conflict is locally provable: the event isn't structurally a witness, a
 * referenced event isn't held (a collision we can't see, we can't verify), the named token isn't the
 * one that actually collides, or the events don't validly double-spend at all (a false witness). A
 * caller can therefore hide `verifySpendWitness(ev, store)` with zero risk of hiding an honest post.
 */
export function verifySpendWitness(ev: Event, store: EventStore): string[] {
  const parsed = parseSpendWitness(ev);
  if (!parsed) return [];
  const {tokenId, eventIds} = parsed;
  // Resolve every named id from local state. A missing one means the conflict is not provable here,
  // so we prove nothing (fail closed) — never hide on a claim we can't independently re-derive.
  const named = new Map<string, Event>();
  for (const id of eventIds) {
    const e = store.getById(id);
    if (!e) return [];
    named.set(id, e);
  }
  // Re-derive the collision from the events THEMSELVES — the witness's own winner/loser claim is never
  // consulted. detectDoubleSpends returns one result keyed by tokenId; we read only the conflict for
  // the token this witness names, and still intersect its losers with the named events to keep the
  // guarantee explicit (a loser it reports is already one of them, since only they were scanned).
  const {conflicts} = detectDoubleSpends([...named.values()]);
  const conflict = conflicts.get(tokenId); // only the token this witness names
  const losers = new Set<string>();
  for (const loserId of conflict?.losers ?? []) {
    if (named.has(loserId)) losers.add(loserId); // intersect with the witness's named events
  }
  return [...losers];
}
