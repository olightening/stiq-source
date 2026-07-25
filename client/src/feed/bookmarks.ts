/**
 * Post bookmarks (NIP-51 kind-10003).
 *
 * A user's bookmarked post ids are stored in a replaceable kind-10003 event. Each saved
 * post is referenced by an `["e", "<event-id>"]` tag. Publishing a new kind-10003 replaces
 * the previous one (latest created_at wins).
 */
import {Kind} from '../nostr/events';
import type {Event} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';

/** Build an unsigned NIP-51 kind-10003 bookmark list from a set of post ids. */
export function buildBookmarkList(postIds: readonly string[]): UnsignedEvent {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const id of postIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      tags.push(['e', id]);
    }
  }
  return {
    kind: Kind.Bookmarks,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** Extract bookmarked post ids from a kind-10003 event. */
export function parseBookmarks(event: Event): string[] {
  if (event.kind !== Kind.Bookmarks) return [];
  return event.tags.filter(t => t[0] === 'e' && t[1]).map(t => t[1]!);
}

/** The set of post ids the user has bookmarked, from their latest kind-10003 in the store. */
export function bookmarkedPostIds(store: EventStore, pubkey: string | undefined): string[] {
  if (!pubkey) return [];
  const lists = store
    .query({kinds: [Kind.Bookmarks], authors: [pubkey]})
    .sort((a, b) => b.created_at - a.created_at);
  const latest = lists[0];
  return latest ? parseBookmarks(latest) : [];
}
