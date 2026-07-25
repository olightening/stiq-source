/**
 * Hardcoded moderator identities (PLAN.md §3.4). Moderation authority is fixed in the
 * frontend: only reports signed by one of these npubs count when filtering the feed
 * (Step 9). Moderators act on a posting npub — they never learn the real-world identity
 * behind it (§3.3).
 *
 * Fill MODERATOR_NPUBS per community deployment with the organizers' moderator npubs.
 */
import * as nip19 from 'nostr-tools/nip19';

export const MODERATOR_NPUBS: readonly string[] = [
  // 'npub1...'  // add moderator npubs here at build time
];

/** Decode a list of moderator npubs to a set of hex pubkeys (skips malformed entries). */
export function moderatorPubkeySet(npubs: readonly string[] = MODERATOR_NPUBS): Set<string> {
  const set = new Set<string>();
  for (const npub of npubs) {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        set.add(decoded.data);
      }
    } catch {
      // ignore malformed entries
    }
  }
  return set;
}

/** Whether a hex pubkey belongs to a hardcoded moderator. */
export function isModerator(
  pubkeyHex: string,
  npubs: readonly string[] = MODERATOR_NPUBS,
): boolean {
  return moderatorPubkeySet(npubs).has(pubkeyHex);
}
