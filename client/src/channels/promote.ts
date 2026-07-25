/**
 * Promote a channel post into a feed thread (No.5 — "enable replies").
 *
 * Public/private/broadcast channel posts no longer carry in-channel reply threads. Instead the
 * post's AUTHOR can promote it: they edit it into the standard editor (adding a title/tags/label),
 * publish it as a real feed post (kind-1 note or kind-30023 article), and the original channel
 * message is edited in place to (a) show the final text and (b) carry a `['promoted', <feedEventId>]`
 * marker. A promoted message renders a special frame and, when tapped, opens the feed thread — whose
 * comments follow the normal feed rules (the author has no special control over them).
 *
 * The promote ride-along uses the existing position-preserving edit (`buildChannelMessageEdit` /
 * `buildGroupChatEdit`); `withPromotedTag` appends the marker, and the message fold
 * (`channelMessages` / `groupChat`) carries it onto the folded message via `promotedTagFrom`.
 */
import type {Event} from 'nostr-tools/pure';

export const PROMOTED_TAG = 'promoted';

/** The feed event id a channel/group message was promoted to (its `['promoted', id]` tag), or undefined. */
export function promotedFeedId(event: Event): string | undefined {
  return event.tags.find(t => t[0] === PROMOTED_TAG && t[1])?.[1];
}

/** True when this (folded) message has been promoted into a feed thread. */
export function isPromoted(event: Event): boolean {
  return promotedFeedId(event) !== undefined;
}

/** Append the promoted marker to a message-edit template. */
export function withPromotedTag<T extends {tags: string[][]}>(template: T, feedEventId: string): T {
  return {...template, tags: [...template.tags, [PROMOTED_TAG, feedEventId]]};
}

/** The promoted marker to carry from an edit onto its folded message (empty when not a promotion). */
export function promotedTagFrom(edit: Event): string[][] {
  const id = promotedFeedId(edit);
  return id ? [[PROMOTED_TAG, id]] : [];
}
