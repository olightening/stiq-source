/**
 * Inbox grouping (PLAN.md §3 / Step 17). Groups decrypted direct messages into
 * conversations by peer. Decryption happens upstream (Identity.readInbox) so plaintext is
 * never persisted; this is pure grouping over in-memory messages.
 */
import * as nip19 from 'nostr-tools/nip19';
import {isBlocked} from './blocklist';
import type {DirectMessage} from './dm';
import type {EmojiTally} from '../channels/reactions';
import {decodeNameHeader} from '../profile/displayName';
import {inlineMediaSummary} from '../feed/inlineMedia';

export interface Conversation {
  peer: string; // hex pubkey
  peerNpub: string;
  messages: DirectMessage[]; // oldest first
  lastAt: number;
  preview: string;
}

/**
 * Group decrypted DMs into conversations, dropping any peer for whom `isHidden` is true so their
 * conversation never surfaces and their DMs stay hidden. `isHidden` defaults to the LOCAL DM
 * blocklist (`isBlocked`) for standalone use; production passes AppRuntime.effectiveDmBlocked so a
 * moderator-removed peer is hidden too. Reads are synchronous (false until the blocklist hydrates),
 * so an un-loaded state simply means "nothing hidden yet".
 */
export function buildConversations(
  messages: DirectMessage[],
  isHidden: (peer: string) => boolean = isBlocked,
): Conversation[] {
  const byPeer = new Map<string, DirectMessage[]>();
  for (const message of messages) {
    if (isHidden(message.sender)) continue;
    const bucket = byPeer.get(message.sender);
    if (bucket) {
      bucket.push(message);
    } else {
      byPeer.set(message.sender, [message]);
    }
  }

  const conversations: Conversation[] = [];
  for (const [peer, msgs] of byPeer.entries()) {
    msgs.sort((a, b) => a.createdAt - b.createdAt);
    const last = msgs[msgs.length - 1]!;
    conversations.push({
      peer,
      peerNpub: nip19.npubEncode(peer),
      messages: msgs,
      lastAt: last.createdAt,
      preview: inlineMediaSummary(decodeNameHeader(last.text).text),
    });
  }
  conversations.sort((a, b) => b.lastAt - a.lastAt);
  return conversations;
}

/** A decrypted DM reaction: who reacted, which message (shared rumor id), and the emoji. */
export interface DmReactionRecord {
  sender: string;
  targetRumorId: string;
  emoji: string;
}

/**
 * Fold reactions onto each message's `reactions` tally, matched by the shared rumor id (the only
 * id both parties agree on). `selfPubkey` flags the viewer's own reactions. Idempotent — recomputes
 * `reactions` from scratch each call. In a 1:1 DM the reactor is always the viewer or the peer, so
 * "who reacted" resolves to two known identities.
 */
export function attachDmReactions(
  conversations: Conversation[],
  reactions: DmReactionRecord[],
  selfPubkey: string,
): Conversation[] {
  if (reactions.length === 0) return conversations;
  // targetRumorId -> emoji -> set of reactor pubkeys.
  const byTarget = new Map<string, Map<string, Set<string>>>();
  for (const r of reactions) {
    if (!r.targetRumorId || !r.emoji) continue;
    let emojis = byTarget.get(r.targetRumorId);
    if (!emojis) { emojis = new Map(); byTarget.set(r.targetRumorId, emojis); }
    let who = emojis.get(r.emoji);
    if (!who) { who = new Set(); emojis.set(r.emoji, who); }
    who.add(r.sender);
  }
  for (const c of conversations) {
    for (const msg of c.messages) {
      const emojis = byTarget.get(msg.rumorId);
      if (!emojis) continue;
      msg.reactions = [...emojis.entries()]
        .map(([emoji, who]): EmojiTally => ({emoji, count: who.size, mine: who.has(selfPubkey), pubkeys: [...who]}))
        .sort((a, b) => b.count - a.count);
    }
  }
  return conversations;
}
