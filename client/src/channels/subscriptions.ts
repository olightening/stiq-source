/**
 * Channel subscriptions (NIP-51 lists).
 *
 * A user's subscribed channels are stored in a replaceable kind-10009 ("user groups")
 * event. Each subscribed NIP-53 channel is referenced by an `["a", "<coord>"]` tag, where
 * coord is the addressable coordinate `30311:<owner>:<d>`. Publishing a new kind-10009
 * replaces the previous one (latest created_at wins), so subscribing/unsubscribing simply
 * republishes the updated list.
 *
 * Persisting this list in the encrypted store is what makes a user's channel set survive a
 * restart; fetching it per-author from the relay (scoped) syncs it across devices.
 */
import type {Event} from '../nostr/events';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';
import type {Channel} from './channels';

/** Build an unsigned NIP-51 kind-10009 subscription list from a set of channel ids. */
export function buildSubscriptionList(channelIds: readonly string[]): UnsignedEvent {
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const id of channelIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      tags.push(['a', id]);
    }
  }
  return {
    kind: Kind.ChannelSubscriptions,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** Extract the subscribed channel ids from a kind-10009 event. */
export function parseSubscriptions(event: Event): string[] {
  if (event.kind !== Kind.ChannelSubscriptions) return [];
  return event.tags.filter(t => t[0] === 'a' && t[1]).map(t => t[1]!);
}

/**
 * The set of channel ids the given user is subscribed to, from their latest kind-10009 list
 * in the store. Returns an empty array if they have no subscription list yet.
 */
export function subscribedChannelIds(store: EventStore, pubkey: string | undefined): string[] {
  if (!pubkey) return [];
  const lists = store
    .query({kinds: [Kind.ChannelSubscriptions], authors: [pubkey]})
    .sort((a, b) => b.created_at - a.created_at);
  const latest = lists[0];
  return latest ? parseSubscriptions(latest) : [];
}

/**
 * The channels this member is a part of FOR SYNC PURPOSES — the real values the scoped `channels`
 * subscription's decoy cover set hides (bug 8; config's SCOPED_CHANNEL_SYNC). Three sources, unioned:
 *   • FOLLOWED — their NIP-51 kind-10009 list ({@link subscribedChannelIds}). The primary signal:
 *     `AppRuntime.subscribeChannel` republishes this list on every Follow, so joining a channel is
 *     what puts it here.
 *   • OWNED — you are implicitly in a channel you run, without ever following it.
 *   • ADMINISTERED — owner-granted `['p', <pubkey>, 'admin']` on the 30311 ({@link Channel.admins}).
 *     A channel admin is NOT necessarily a follower, and they need that channel's messages off the
 *     wire to moderate it at all: `AppRuntime.administeredSpaceAutoContexts` feeds the moderation
 *     log from `channelMessages(store, ch.id)` for every channel the viewer owns OR administers, and
 *     with 1311 off the firehose an unfollowed admin would silently see an EMPTY message list for
 *     their own channel — no error, just a mod log missing that channel's auto-hides.
 *
 * DELIBERATELY SEPARATE from AppRuntime.subscribedChannelSet(), which answers a different question —
 * "does the UI show this member as Following?" — and drives the Follow/Leave button and the channel
 * list's rows. Folding "administered" into that one would silently mark every admin as Following and
 * flip their button. Two questions, two functions: what I FOLLOW (UI) vs what I SYNC (wire).
 */
export function channelSyncIds(
  store: EventStore,
  pubkey: string | undefined,
  channels: readonly Channel[],
): string[] {
  if (!pubkey) return [];
  const ids = new Set(subscribedChannelIds(store, pubkey));
  for (const ch of channels) {
    if (ch.owner === pubkey || (ch.admins?.includes(pubkey) ?? false)) ids.add(ch.id);
  }
  return [...ids];
}
