/**
 * Candidate pool for the DM inbox's decoy COVER SET (PLAN.md §4 / audit #1).
 *
 * ## Why this module exists
 *
 * The DM inbox REQ is `{kinds:[1059], '#p': cover}` — it must name the member's real npub, because a
 * gift wrap is addressed by a plaintext `p` tag (that is NIP-17, and the relay's own pushwatcher
 * routes on it). `subscriptionPlan.ts` therefore hides `me` inside a k+1 cover set: `me` plus `k`
 * decoy pubkeys, so the relay cannot tell which of the k+1 owns the connection. The SAME set is
 * reused as `authors` for the self-lists (10000/10003/10009) and self identity-enc profile (30078)
 * subs, and as `#p` for the space-key (30079) and draft-delivery (30500) subs.
 *
 * That whole construction is only as strong as the decoys' PLAUSIBILITY. A decoy that the relay can
 * recognise as "not a real member npub" is not a decoy at all — the relay simply subtracts it, and a
 * set of k+1 with k recognisable decoys identifies `me` exactly.
 *
 * `subscriptionPlan.decoyPool()` draws candidates from the authors of cached kind-1 posts. In a
 * community with blind posting ON (the shipped configuration), that is precisely the recognisable
 * case: a blind post is signed by its spent token's own secret, so `event.pubkey === hex(token0)`
 * (blind/blindPost.ts `assembleBlindEvent`) — a ONE-SHOT pubkey that is not anybody's npub, that the
 * relay itself minted/verified via the `stiq_token` tag on that very event, and that can never
 * receive a DM, hold a NIP-51 list, or publish an identity-enc profile. Every decoy drawn that way is
 * self-identifying, and `me` is the only entry left standing.
 *
 * ## What this module does instead
 *
 * {@link npubCoverPool} returns only pubkeys observed as the author of a kind this client signs with
 * the member's BOUND NPUB — never through the blind signer:
 *
 *   • 1311 NIP-53 channel messages and 9/11/12 NIP-29 group chat. AppRuntime signs these with the
 *     bound npub directly (the relay's GroupGuard checks the author's role, and the relay excludes
 *     these kinds from its blind content set), so their authors ARE real member npubs.
 *   • kind-30078 identity carriers — `d="identity"` (beacon) and `d="identity-enc"` (encrypted self
 *     profile, profile/identityDoc.ts). Signed by the member's own key, one per member.
 *
 * These are exactly the population that plausibly receives a gift wrap and plausibly authors a
 * NIP-51 list, which is what the cover set claims about every entry it emits.
 *
 * Any event carrying a `stiq_token` tag is skipped regardless of kind (belt-and-braces: if a kind on
 * the list is ever routed through `feedSigner`, its author becomes a token pubkey and must not leak
 * back into the pool through the kind allow-list).
 *
 * ## Deliberately smaller, and that is the point
 *
 * This pool is smaller than the kind-1 author pool it replaces. In a community where nobody has
 * posted in a channel or group and nobody has published an identity carrier, it can fall below
 * `MIN_DECOY_POOL` and the plan degrades to its existing cold shapes — an unscoped, since/limit
 * bounded DM firehose (heavier, but it reveals NOTHING about `me`) and an omitted self-lists sub.
 * That degradation is already implemented and already tested in subscriptionPlan; it is strictly
 * safer than emitting a cover set whose decoys the relay can subtract. Bandwidth is recoverable;
 * a deanonymised inbox subscription is not.
 */
import {Kind} from '../nostr/events';
import {GroupKind} from '../contracts';
import type {EventStore} from '../nostr/store';
import {isBlindPost} from '../blind/blindPost';
import {D_IDENTITY_BEACON, D_IDENTITY_PROFILE} from '../profile/identityDoc';

/**
 * Kinds whose author is, by construction, a member's REAL bound npub rather than a per-event blind
 * token pubkey. Kept as one list so the "is this author a real npub" question has a single answer in
 * the client; adding a kind here is a claim that {@link isBlindPost} can never be true of it and that
 * AppRuntime does not route it through `feedSigner`.
 */
export const NPUB_SIGNED_KINDS: readonly number[] = [
  Kind.LiveChat, //        1311  — NIP-53 channel broadcast (bound npub; GroupGuard role check)
  GroupKind.Chat, //          9  — NIP-29 group chat
  GroupKind.Thread, //       11
  GroupKind.Reply, //        12
  Kind.AppData, //        30078  — identity carriers only, see D_TAGS below
];

/** The only kind-30078 `d` values this pool accepts: the per-member identity carriers. Excludes the
 *  organizer config doc, space settings and every other 30078 payload, so a well-known operational
 *  key is never offered as a "member" decoy. */
const IDENTITY_D_TAGS: readonly string[] = [D_IDENTITY_BEACON, D_IDENTITY_PROFILE];

/**
 * Distinct real-npub pubkeys usable as cover-set decoys, newest-activity first, excluding `exclude`
 * (the member's own pubkey).
 *
 * Drop-in replacement for `subscriptionPlan.decoyPool(store, exclude)` — same signature, same
 * ordering contract (the caller freezes a prefix of it as the per-identity candidate snapshot), so
 * wiring it in is an import swap.
 */
export function npubCoverPool(store: EventStore, exclude: string | undefined): string[] {
  const seen = new Set<string>();
  for (const ev of store.query({kinds: [...NPUB_SIGNED_KINDS]})) {
    if (ev.pubkey === exclude) continue;
    if (seen.has(ev.pubkey)) continue;
    // A token-signed event's pubkey is a one-shot blind token, never an npub — the leak this module
    // exists to close. Checked before the kind rules so no kind list can reintroduce it.
    if (isBlindPost(ev)) continue;
    if (ev.kind === Kind.AppData) {
      const d = ev.tags.find(t => t[0] === 'd')?.[1];
      if (d === undefined || !IDENTITY_D_TAGS.includes(d)) continue;
    }
    seen.add(ev.pubkey);
  }
  return [...seen];
}
