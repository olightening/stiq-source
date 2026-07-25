/**
 * Mute-list + channel-owner moderation helpers.
 *
 * Two distinct authorities use these:
 *   1. Community moderators (organizer's signed roster) maintain a NIP-51 mute list; muted authors
 *      are hidden community-wide by the moderation filter.
 *   2. A CHANNEL owner is sovereign over their own channel: they may hide posts/comments within it
 *      (a kind-1984 report), honoured only inside that channel. A channel's id is the coordinate
 *      `30311:<owner>:<d>`, so the owner authorised to moderate is parseable from the channel id.
 *
 * Note: ordinary post authors have NO moderation authority over comments on their public-feed
 * posts — only the organizer's roster can hide public-feed content.
 */
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';

/** Event ids reported (kind-1984) by `ownerPubkey` — used for channel-owner content moderation. */
export function ownerReportedIds(store: EventStore, ownerPubkey: string): Set<string> {
  const out = new Set<string>();
  for (const r of store.query({kinds: [Kind.Report], authors: [ownerPubkey]})) {
    for (const t of r.tags) if (t[0] === 'e' && t[1]) out.add(t[1]);
  }
  return out;
}

/** The owner pubkey embedded in a channel coordinate `30311:<owner>:<d>` (empty if malformed). */
export function channelOwnerOf(channelId: string): string {
  return channelId.split(':')[1] ?? '';
}

/** Build/replace a NIP-51 mute list (kind 10000) from a set of blocked pubkeys. */
export function buildMuteList(pubkeys: readonly string[]): UnsignedEvent {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const pk of pubkeys) {
    if (pk && !seen.has(pk)) {
      seen.add(pk);
      tags.push(['p', pk]);
    }
  }
  return {kind: Kind.MuteList, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Pubkeys muted by `ownerPubkey`, from their latest kind-10000 list. */
export function blockedPubkeys(store: EventStore, ownerPubkey: string): Set<string> {
  const latest = store
    .query({kinds: [Kind.MuteList], authors: [ownerPubkey]})
    .sort((a, b) => b.created_at - a.created_at)[0];
  const out = new Set<string>();
  if (latest) {
    for (const t of latest.tags) if (t[0] === 'p' && t[1]) out.add(t[1]);
  }
  return out;
}
