import * as nip19 from 'nostr-tools/nip19';

/**
 * Encode a hex pubkey as an `npub…`, falling back to the raw input when the hex is
 * malformed. Shared by the feed/channels/log views (previously copy-pasted as
 * `npubFor`/`safeNpub` in five places).
 */
export function safeNpubEncode(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/** Options for {@link shortenNpub}. */
export interface ShortenNpubOptions {
  /** Leading characters to keep (default 8). */
  lead?: number;
  /** Trailing characters to keep after the ellipsis (default 3). Pass 0 for a `lead…` (no tail) form. */
  tail?: number;
  /**
   * If set, strings whose length is `<= minLen` are returned unshortened. Several list rows guard
   * this way so an already-short fallback string isn't mangled; call sites without a guard omit it.
   */
  minLen?: number;
}

/**
 * The ONE npub/identity truncator. Historically re-implemented ~12 times with divergent lengths
 * (8…3, 8…4, 10…4, 10…8, 11…3, 12…4, 20…) and inconsistent length guards. It is now unified here
 * behind lead/tail/minLen params so every call site keeps its EXACT prior visible output — do not
 * collapse the per-site lengths to one "house" value, each maps to a real surface:
 *
 *   {lead:8,  tail:3}            — channel author chips (format.shortNpub default: AuthorHeader, DM/chat).
 *   {lead:8,  tail:4, minLen:16} — feed PostCard "who" row.
 *   {lead:8,  tail:4}            — GroupView member id (`short`), RefEmbed catch fallback.
 *   {lead:10, tail:4}            — ReferencedCard, CommentThread, feed CommentItem author fallback.
 *   {lead:10, tail:8, minLen:24} — ProfileScreen npub chip.
 *   {lead:11, tail:3}            — GroupView `npubShort` member list.
 *   {lead:12, tail:4}            — ChannelPostView, ChannelDetail, LogScreen, ModeratorConsole (minLen:16), InboxList (minLen:24).
 *   {lead:10, tail:0}           — RefEmbed avatar seed; {lead:20, tail:0} — SettingsScreen hero npub.
 *
 * Input is an already-encoded `npub…` (or any string). Hex pubkeys should be encoded first via
 * {@link safeNpubEncode}; a few call sites keep a bespoke encode+catch wrapper for their own
 * malformed-hex fallback and delegate only the slice here.
 */
export function shortenNpub(npub: string, opts: ShortenNpubOptions = {}): string {
  const {lead = 8, tail = 3, minLen} = opts;
  if (minLen !== undefined && npub.length <= minLen) return npub;
  const head = npub.slice(0, lead);
  return tail > 0 ? `${head}…${npub.slice(-tail)}` : `${head}…`;
}
