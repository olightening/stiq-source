/** Shared identity/text formatting for the channel message primitives. */
import {relTime} from '../../../ui/relTime';
import {safeNpubEncode, shortenNpub} from '../../../util/npub';
import {Kind} from '../../../nostr/events';

/** A user's npub (gradient seed) from their hex pubkey; falls back to the hex on failure. */
export function npubFor(pubkey: string): string {
  return safeNpubEncode(pubkey);
}

/** Compact "npub1abc…xyz" (mockup form: npub1 + 3 + … + 3) for inline display beside a name. */
export function shortNpub(npub: string, lead = 8, tail = 3): string {
  return shortenNpub(npub, {lead, tail});
}

/** Relative time, long form ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function relativeTime(ts: number): string {
  return relTime(ts, 'ago');
}

/** Relative time, short form ("now" / "5m" / "3h" / "2d") used in dense comment headers. */
export function relTimeShort(ts: number): string {
  return relTime(ts, 'short-days');
}

/**
 * Uppercase row label for a referenced post/comment (the "save to embed" / REFERENCED card):
 * kind-1111 (NIP-22 comment) reads "REFERENCED COMMENT", everything else "REFERENCED POST".
 * `kind` is optional because a saved/embedded reference doesn't always have a resolved kind yet.
 */
export function referencedLabel(kind?: number): string {
  return kind === Kind.Comment ? 'REFERENCED COMMENT' : 'REFERENCED POST';
}
