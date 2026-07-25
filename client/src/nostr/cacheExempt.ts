/**
 * Cache-deletion / retention EXEMPT kinds — the single source of truth for "what a cache clear must
 * never touch".
 *
 * Two callers share this predicate so they can never drift:
 *   - the off-boot retention prune (sqliteStore.pruneRetention), which trims the OLDEST rows of
 *     high-volume timeline kinds down to a cap, and
 *   - the user-driven scoped cache-clear (Settings → Manage data → deleteCachedEvents), which deletes
 *     received feed events by date range / kind.
 *
 * Losing an exempt event is unacceptable: a lost DM is irrecoverable, and a lost STATE event
 * resurrects moderated content, drops a channel/group definition, or forgets a config/list. The
 * policy is intentionally conservative — "when in doubt, exempt." The number RANGES cover the
 * replaceable / addressable families wholesale; the {@link CACHE_EXEMPT_KINDS} set names the
 * sub-10000 kinds THIS app persists that carry state or DMs and would otherwise fall into the
 * prunable/deletable bucket:
 *   0    profile metadata (NIP-01)
 *   3    contacts / follow list (NIP-02)
 *   5    deletion request (NIP-09) — control event; dropping it could resurrect deleted content
 *   13   NIP-17 seal / 14 NIP-17 chat rumor — decrypted DM plaintext is never persisted here, but
 *        exempt defensively so a DM inner-kind never falls into the deletable path
 *   40   channel create (NIP-28) / 41 channel metadata — a channel's DEFINITION
 *   1059 gift-wrap DM envelope (NIP-59) — the ONLY DM form stored; dropping one loses a message
 *   1984 report (NIP-56) — moderation state; the mod filter re-derives hide/restore/ban from these,
 *        so a deleted report would un-hide moderated content (moderation/filter.ts)
 *   9009 per-post interaction preferences — durable per-post config state
 *
 * NOTE (what is NOT here, because it lives OUTSIDE the event store): identity keys, enrollment
 * credentials, the blind-token wallet, per-slot durable state, DRAFTS, the OUTBOX (unsent posts +
 * their tokens), joined-groups/spaces membership, and organizer config secrets are stored in the
 * hardware keystore / AsyncStorage, NOT the `events` table — so a store-level cache clear cannot
 * reach them at all. The addressable ranges below additionally protect the organizer-config /
 * group-state / space-key-delivery EVENTS that do live in the store.
 */

/** Sub-10000 kinds this app persists that carry DMs or durable state (see file doc). */
export const CACHE_EXEMPT_KINDS = new Set<number>([0, 3, 5, 13, 14, 40, 41, 1059, 1984, 9009]);

/**
 * True when kind `k` must never be pruned OR user-deleted from the cache. STRUCTURAL — decides on the
 * kind NUMBER alone, never on event content — so it can't mis-drop an encrypted DM or a state event.
 */
export function isCacheExempt(k: number): boolean {
  return (
    CACHE_EXEMPT_KINDS.has(k) ||
    (k >= 10000 && k <= 19999) || // NIP-51 replaceable lists (mutes, bookmarks, subscriptions…)
    (k >= 30000 && k <= 39999) //   addressable / parameterized-replaceable state (articles,
    //                              community/group config, relay PostState, space-key delivery…)
  );
}

/**
 * True when kind `k` is a REPLACEABLE or ADDRESSABLE (parameterized-replaceable) kind under Nostr
 * semantics — the families for which only the NEWEST event per (pubkey, kind[, d-tag]) is
 * authoritative. STRUCTURAL: decides on the kind NUMBER alone.
 *
 * This is DISTINCT from {@link isCacheExempt}. Exemption exists so the CURRENT state is never lost to
 * a cache clear; this predicate instead identifies where superseded-version COLLAPSE is sound
 * (SqliteEventStore.pruneSupersededReplaceable, COMPACTION_V2). Collapse deletes only strictly-older
 * versions, so the newest member of an exempt replaceable/addressable range is always kept — the two
 * predicates deliberately overlap on 10000-19999 / 30000-39999 without conflicting.
 */
export function isReplaceableOrAddressable(k: number): boolean {
  return (
    k === 0 || // profile metadata (NIP-01, replaceable)
    k === 3 || // contact / follow list (NIP-02, replaceable)
    (k >= 10000 && k <= 19999) || // NIP-51 replaceable lists
    (k >= 30000 && k <= 39999) //   addressable / parameterized-replaceable
  );
}

/**
 * True when kind `k` is an EPHEMERAL kind (NIP-16 range 20000–29999) — events relays are not expected
 * to persist. STRUCTURAL. Exposed alongside {@link isReplaceableOrAddressable} for the compaction
 * engine's transient-kind handling (COMPACTION_V2).
 */
export function isEphemeralKind(k: number): boolean {
  return k >= 20000 && k <= 29999;
}
