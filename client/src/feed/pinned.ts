/**
 * Pinned/accompanying comment on a post (PLAN.md Phase 3).
 *
 * The post author may attach a running commentary note to their post. Each edit
 * is a new public signed event — the latest version is shown pinned at the top
 * of the post page; a "view edit history" button reveals all prior versions.
 *
 * Event format: kind-1111 (NIP-22 comment) tagged as:
 *   ['E', <postId>, '', <postPubkey>]  — root scope (the post)
 *   ['K', '1']                          — root kind
 *   ['P', <postPubkey>]                 — root author
 *   ['e', <postId>, '', <postPubkey>]  — parent (same as root for a top-level pin)
 *   ['stiq-pin', <postId>]              — app marker: this is a pinned comment
 *
 * Only events authored by the post's own pubkey count as pinned comments.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {UnsignedEvent} from '../keys/keystore';
import type {EventStore} from '../nostr/store';
import type {EventRef} from './comments';

const PIN_MARKER = 'stiq-pin';

/** Build an unsigned pinned comment event for a post. */
export function buildPinnedComment(content: string, postRef: EventRef): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('pinned comment content is empty');
  return {
    kind: Kind.Comment,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['E', postRef.id, '', postRef.pubkey],
      ['K', String(postRef.kind)],
      ['P', postRef.pubkey],
      ['e', postRef.id, '', postRef.pubkey],
      ['k', String(postRef.kind)],
      ['p', postRef.pubkey],
      [PIN_MARKER, postRef.id],
    ],
    content: trimmed,
  };
}

/** True if an event is a pinned comment for the given post. */
function isPinnedFor(event: Event, postId: string, postAuthor: string): boolean {
  if (event.kind !== Kind.Comment) return false;
  if (event.pubkey !== postAuthor) return false;
  return event.tags.some(t => t[0] === PIN_MARKER && t[1] === postId);
}

/**
 * True if a comment is an author's-note pin (carries the stiq-pin marker), regardless of which
 * post it targets. Used by the thread builder and comment counter to keep notes OUT of the
 * regular comment list — a note lives exclusively in the author's-note block, never as a reply.
 */
export function isPinnedComment(event: Event): boolean {
  return event.kind === Kind.Comment && event.tags.some(t => t[0] === PIN_MARKER);
}

export interface PinnedCommentHistory {
  /** Most recent pinned comment (shown at top of post page). */
  latest: Event | null;
  /** All prior versions, oldest first (for "view edit history"). */
  history: Event[];
}

/** Load all pinned comment versions for a post from the store, sorted oldest→newest. */
export function loadPinnedHistory(
  store: EventStore,
  postId: string,
  postAuthor: string,
): PinnedCommentHistory {
  const all = store
    .query({kinds: [Kind.Comment], authors: [postAuthor]})
    .filter(ev => isPinnedFor(ev, postId, postAuthor))
    .sort((a, b) => a.created_at - b.created_at);

  if (all.length === 0) return {latest: null, history: []};
  const latest = all[all.length - 1]!;
  const history = all.slice(0, -1);
  return {latest, history};
}
