/**
 * Per-post interaction gating — comments & reactions opened/closed per post.
 *
 * By default EVERY broadcast/channel post has comments AND reactions CLOSED. An admin
 * (NIP-29 group) or owner (NIP-53 channel) opens them on a specific post via a signed
 * control event:
 *   - NIP-29: kind-9009 (`Kind.SetInteractions`), relay-managed & relay-enforced. The relay
 *     mirrors it as an authoritative per-post kind-39005 (`PostState`).
 *   - NIP-53: kind-30078 (`Kind.AppData`) addressable by the owner, `d="stiq:interactions:<postId>"`;
 *     client-honored only.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind, PostState} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';

export interface PostInteractions {
  comments: boolean;
  reactions: boolean;
}

/** The default state for ANY post: both closed. */
export const CLOSED: PostInteractions = {comments: false, reactions: false};

function flag(on: boolean): string {
  return on ? '1' : '0';
}

function tagValue(event: Event, name: string): string | undefined {
  const t = event.tags.find(tag => tag[0] === name && tag[1]);
  return t?.[1];
}

function hasTag(event: Event, name: string, value: string): boolean {
  return event.tags.some(tag => tag[0] === name && tag[1] === value);
}

function readFlags(event: Event): PostInteractions {
  return {
    comments: tagValue(event, 'comments') === '1',
    reactions: tagValue(event, 'reactions') === '1',
  };
}

/** NIP-29 admin control (kind-9009) opening/closing interactions on a group post. */
export function buildGroupInteractionControl(
  groupId: string,
  postId: string,
  perm: PostInteractions,
): UnsignedEvent {
  return {
    kind: Kind.SetInteractions,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['h', groupId],
      ['e', postId],
      ['comments', flag(perm.comments)],
      ['reactions', flag(perm.reactions)],
    ],
    content: '',
  };
}

/** NIP-53 owner control (addressable kind-30078) opening/closing interactions on a channel message. */
export function buildChannelInteractionControl(
  postId: string,
  perm: PostInteractions,
): UnsignedEvent {
  return {
    kind: Kind.AppData,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'stiq:interactions:' + postId],
      ['e', postId],
      ['comments', flag(perm.comments)],
      ['reactions', flag(perm.reactions)],
    ],
    content: '',
  };
}

/**
 * The authoritative interaction state for a group post: the latest (greatest `created_at`)
 * among relay-signed kind-39005 (`PostState`) and any locally-cached own kind-9009 optimistic
 * control whose `e` tag is `postId`. Falls back to `fallback` (CLOSED unless the caller passes
 * the space's own default — see AppRuntime.getGroupPostInteractions/spaceRules' `defaultReactions`)
 * when no per-message override has ever been published; an explicit override always wins regardless
 * of what `fallback` says.
 */
export function groupPostInteractions(store: EventStore, postId: string, fallback: PostInteractions = CLOSED): PostInteractions {
  let latest: Event | undefined;
  for (const kind of [PostState, Kind.SetInteractions]) {
    for (const ev of store.query({kinds: [kind]})) {
      if (!hasTag(ev, 'e', postId)) continue;
      if (!latest || ev.created_at > latest.created_at) latest = ev;
    }
  }
  return latest ? readFlags(latest) : fallback;
}

/**
 * The interaction state an NIP-53 channel owner has set for a message: the latest kind-30078
 * authored by `ownerPubkey` addressable as `stiq:interactions:<postId>`. Falls back to `fallback`
 * (CLOSED unless the caller passes the space's own default) when no per-message override has ever
 * been published; an explicit override always wins regardless of what `fallback` says.
 */
export function channelPostInteractions(
  store: EventStore,
  ownerPubkey: string,
  postId: string,
  fallback: PostInteractions = CLOSED,
): PostInteractions {
  const d = 'stiq:interactions:' + postId;
  const latest = store
    .query({kinds: [Kind.AppData], authors: [ownerPubkey]})
    .filter(ev => tagValue(ev, 'd') === d)
    .sort((a, b) => b.created_at - a.created_at)[0];
  return latest ? readFlags(latest) : fallback;
}
