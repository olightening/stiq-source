/**
 * Per-channel emoji reactions.
 *
 * The channel owner configures an emoji set in the channel definition (see {@link Channel.reactions}).
 * Each broadcast renders those emojis as one-tap chips; a tap publishes a NIP-25 kind-7 reaction
 * whose `content` is the emoji and whose `e` tag is the message. Tallying counts one reaction per
 * pubkey per emoji (latest wins), and flags the ones the viewer themselves added.
 */
import {Kind} from '../nostr/events';
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {resolveAuthorPubkey, isOffRollBlindPost} from '../blind/identity';
import {resolveContent} from '../blind/blindPost';

/** Build an unsigned kind-7 reaction carrying `emoji` as its content, targeting a broadcast. */
export function buildEmojiReaction(messageId: string, messagePubkey: string, emoji: string): UnsignedEvent {
  return {
    kind: Kind.Reaction,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', messageId],
      ['p', messagePubkey],
    ],
    content: emoji,
  };
}

export interface EmojiTally {
  emoji: string;
  count: number;
  /** Whether the viewer has this reaction on the message. */
  mine: boolean;
  /** Hex pubkeys that reacted with this emoji (for a "who reacted" list). */
  pubkeys: string[];
}

/**
 * Fold kind-7 reactions into a per-emoji voter set (+ the viewer's own reactions), in the order each
 * emoji first appears in `events`. Shared counting core for {@link tallyEmojiReactions}'s two passes
 * (configured entries, then the off-palette union).
 */
function foldReactionEvents(
  events: ReadonlyArray<Event>,
  viewerPubkey?: string | null,
): {order: string[]; byEmoji: Map<string, Set<string>>; mine: Set<string>} {
  const order: string[] = [];
  const byEmoji = new Map<string, Set<string>>();
  const mine = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== Kind.Reaction) continue;
    // Channel reactions ride the blind feedSigner, so under content encryption the emoji body is
    // sealed. Resolve first: a still-locked reaction stays UNCOUNTED (its ciphertext must never
    // render as a chip label), and fills in once the epoch unlocks — same rule as feed voting.
    const {text, locked} = resolveContent(ev);
    if (locked) continue;
    const emoji = text.trim();
    if (!emoji) continue;
    // Off-roll reactions never count (member-roll enforcement — sock-puppet keys would otherwise
    // each read as a distinct voter). Defers while no roll is loaded.
    if (isOffRollBlindPost(ev)) continue;
    // Fold on the RESOLVED author: a public-channel reaction rides the blind path (throwaway
    // signer + encrypted attribution), so the raw pubkey is a fresh key per tap — dedup and
    // `mine` must use the attributed member. Attributed reactions resolve to their own pubkey.
    const voter = resolveAuthorPubkey(ev);
    let set = byEmoji.get(emoji);
    if (!set) { set = new Set(); byEmoji.set(emoji, set); order.push(emoji); }
    set.add(voter);
    if (viewerPubkey && voter === viewerPubkey) mine.add(emoji);
  }
  return {order, byEmoji, mine};
}

/**
 * Tally kind-7 reactions for one message into a UNION of two groups:
 *  1. one entry per emoji in the channel's configured set, in configured order, zero-count included
 *     — this is the one-tap palette (unchanged; a space with e.g. 3 configured emojis always shows
 *     exactly those 3 chips, tapped or not).
 *  2. any emoji actually present on the message but NOT in the configured set, count > 0 only,
 *     ordered by first appearance in `events`.
 * Group 2 exists because a palette change — or a space with no configured palette at all — must
 * never make real reactions people sent disappear; it only means those reactions won't ALSO get a
 * dedicated one-tap chip for everyone else. One reaction per (pubkey, emoji) is counted, so a
 * double-tap can't inflate a count.
 */
export function tallyEmojiReactions(
  events: ReadonlyArray<Event>,
  emojis: ReadonlyArray<string>,
  viewerPubkey?: string | null,
): EmojiTally[] {
  const configured = new Set(emojis);
  const {order, byEmoji, mine} = foldReactionEvents(events, viewerPubkey);
  const configuredTallies = emojis.map(emoji => {
    const set = byEmoji.get(emoji);
    return {emoji, count: set?.size ?? 0, mine: mine.has(emoji), pubkeys: set ? [...set] : []};
  });
  const offPalette = order
    .filter(emoji => !configured.has(emoji))
    .map(emoji => {
      const set = byEmoji.get(emoji)!;
      return {emoji, count: set.size, mine: mine.has(emoji), pubkeys: [...set]};
    });
  return [...configuredTallies, ...offPalette];
}

/**
 * Tally kind-7 reactions for one message across ANY emoji present (no configured set) — used by
 * groups and DMs, where members react with any emoji from the ⋯ menu. Most-used first; one reaction
 * per (pubkey, emoji).
 */
export function tallyAllReactions(
  events: ReadonlyArray<Event>,
  viewerPubkey?: string | null,
): EmojiTally[] {
  const byEmoji = new Map<string, Set<string>>();
  const mine = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== Kind.Reaction) continue;
    // Group/DM reactions are npub-signed (never sealed — resolveContent passes them through
    // verbatim), but route them anyway as permanent insurance, mirroring CommentThread's rule:
    // if one ever arrives sealed it stays uncounted rather than rendering ciphertext as a chip.
    const {text, locked} = resolveContent(ev);
    if (locked) continue;
    const emoji = text.trim();
    if (!emoji) continue;
    // Off-roll reactions never count — see foldReactionEvents.
    if (isOffRollBlindPost(ev)) continue;
    // Same resolved-author fold as tallyEmojiReactions: group/DM reactions are npub-signed today
    // (resolve to themselves), but any blind-signed reaction still dedups by real member.
    const voter = resolveAuthorPubkey(ev);
    let set = byEmoji.get(emoji);
    if (!set) { set = new Set(); byEmoji.set(emoji, set); }
    set.add(voter);
    if (viewerPubkey && voter === viewerPubkey) mine.add(emoji);
  }
  return [...byEmoji.entries()]
    .map(([emoji, set]) => ({emoji, count: set.size, mine: mine.has(emoji), pubkeys: [...set]}))
    .sort((a, b) => b.count - a.count);
}
