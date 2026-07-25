/**
 * Threaded comments — event model (PLAN.md §2 / Step 14, sub-step 1).
 *
 * Comments are NIP-22 kind-1111 events. NIP-22 distinguishes the thread ROOT (uppercase
 * tags `E`/`K`/`P`) from the immediate PARENT (lowercase `e`/`k`/`p`):
 *   - a top-level comment on a post: root = parent = the post.
 *   - a reply to a comment: root = the post, parent = the comment.
 * This lets the thread builder (sub-step 2) reconstruct the tree from the cache.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {UnsignedEvent} from '../keys/keystore';
import type {Signer} from './compose';

export interface EventRef {
  id: string;
  pubkey: string;
  kind: number;
}

export function refOf(event: Event): EventRef {
  return {id: event.id, pubkey: event.pubkey, kind: event.kind};
}

/** Build an unsigned kind-1111 comment under `parent`, scoped to thread `root`. */
export function buildComment(content: string, root: EventRef, parent: EventRef): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('comment content is empty');
  }
  return {
    kind: Kind.Comment,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      // Root scope (uppercase).
      ['E', root.id, '', root.pubkey],
      ['K', String(root.kind)],
      ['P', root.pubkey],
      // Immediate parent (lowercase).
      ['e', parent.id, '', parent.pubkey],
      ['k', String(parent.kind)],
      ['p', parent.pubkey],
    ],
    content: trimmed,
  };
}

/**
 * Build a kind-1111 comment for a channel broadcast message, tagged with
 * `['context', 'channel']` so profile queries can exclude it.
 */
export function buildChannelComment(content: string, root: EventRef, parent: EventRef): UnsignedEvent {
  const base = buildComment(content, root, parent);
  return {...base, tags: [...base.tags, ['context', 'channel']]};
}

/**
 * NIP-22 conflict resolution: comments on a root *kind-1 note* are NOT valid kind-1111 targets
 * per NIP-22 (1111 is for non-kind-1 roots). Instead publish a standard kind-1 event with
 * NIP-10 marked threading and a `['t','stiq-comment']` marker, so it is 100% relay-standard
 * yet routable back into our dedicated comment UI on ingestion.
 */
export const STIQ_COMMENT_MARKER = 'stiq-comment';

/**
 * Build a hybrid kind-1 comment: a thread edge that states its own shape.
 *
 * Every reference is SELF-DESCRIBING — the `e` (which event) and `p` (whose event) tags each carry a
 * `'root'`/`'reply'` marker in NIP-10's 4th slot, and the pair for a given role is emitted together:
 *
 *   ['e', root.id,       '', 'root' ]   ['p', root.pubkey,   '', 'root' ]   ← always: the thread root
 *   ['e', parent.id,     '', 'reply']   ['p', parent.pubkey, '', 'reply']   ← iff this is a reply to a
 *                                                                             comment rather than to the
 *                                                                             root itself
 *   ['t', 'stiq-comment']
 *
 * Both role pairs are gated on the SAME condition (`parent.id !== root.id`, i.e. "is this a daughter of
 * a comment or of the post itself"), so `e` and `p` can never disagree about the thread's shape, and a
 * reader never has to infer a role from tag ORDER. That ordering dependency was the old format's flaw:
 * `p` tags used to be unmarked and were disambiguated purely by emission position, with the parent's
 * `p` suppressed whenever `parent.pubkey === root.pubkey` — which silently conflated "top-level comment"
 * with "reply to a comment written by the root author". A reply whose parent author happens to be the
 * root author now emits both markers (same pubkey twice, different roles) rather than collapsing: the
 * duplicate is deliberate, and it is what makes absence of a `'reply'` marker mean exactly one thing —
 * "this is a top-level comment" — instead of two.
 *
 * Readers must still accept the OLD unmarked shape; see commentRootAuthor/commentParentAuthor.
 */
export function buildNoteComment(content: string, root: EventRef, parent: EventRef): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('comment content is empty');
  }
  // A daughter of a comment, rather than of the root post itself. Gates BOTH parent tags — keep them
  // emitted as a pair so the e/p views of the thread stay in lockstep.
  const isReplyToComment = parent.id !== root.id;
  const tags: string[][] = [['e', root.id, '', 'root']];
  if (isReplyToComment) {
    tags.push(['e', parent.id, '', 'reply']);
  }
  tags.push(['p', root.pubkey, '', 'root']);
  if (isReplyToComment) {
    tags.push(['p', parent.pubkey, '', 'reply']);
  }
  tags.push(['t', STIQ_COMMENT_MARKER]);
  return {
    kind: Kind.Post,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: trimmed,
  };
}

/** Whether an event is a hybrid kind-1 Stiq comment (NIP-10 + 'stiq-comment' marker). */
export function isStiqComment(event: Event): boolean {
  return event.kind === Kind.Post && event.tags.some(t => t[0] === 't' && t[1] === STIQ_COMMENT_MARKER);
}

/**
 * Build a comment under any root, choosing the representation per NIP-22:
 *   - root is a kind-1 note  → hybrid kind-1 + 'stiq-comment'
 *   - root is anything else  → kind-1111 (articles, polls, channel messages)
 */
export function buildPostComment(content: string, root: EventRef, parent: EventRef): UnsignedEvent {
  return root.kind === Kind.Post
    ? buildNoteComment(content, root, parent)
    : buildComment(content, root, parent);
}

/**
 * The value of the `name` tag carrying `marker` in NIP-10's 4th slot, or undefined. Shared by the `e`
 * (which event) and `p` (whose event) views of a hybrid comment's thread edge — both are marked by
 * buildNoteComment, so both are read the same way.
 */
function markedTag(event: Event, name: string, marker: string): string | undefined {
  return event.tags.find(t => t[0] === name && t[1] && t[3] === marker)?.[1];
}

/**
 * Whether a hybrid comment uses the MARKED `p`-tag scheme at all. Distinguishes events from the current
 * producer (markers, order-independent) from ones already on relays and in local stores from before the
 * markers existed (unmarked, position-dependent) — the two shapes must be read by different rules, and
 * only the presence of a marker can tell them apart. An unmarked event is legacy by definition: this is
 * the ONLY use of tag position left, and it is confined to reading history.
 */
function hasMarkedPTag(event: Event): boolean {
  return event.tags.some(t => t[0] === 'p' && t[1] && (t[3] === 'root' || t[3] === 'reply'));
}

/** Sign a comment via the keystore. */
export function publishComment(
  signer: Signer,
  content: string,
  root: EventRef,
  parent: EventRef,
): Promise<Event> {
  return signer.sign(buildComment(content, root, parent));
}

function firstTagValue(event: Event, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/** The immediate parent id of a comment, across both kind-1111 and hybrid kind-1 forms. */
export function commentParentId(event: Event): string | null {
  if (event.kind === Kind.Comment) {
    return firstTagValue(event, 'e');
  }
  if (isStiqComment(event)) {
    // NIP-10: a 'reply' marker is the immediate parent; a top-level comment has only 'root'.
    return markedTag(event, 'e', 'reply') ?? markedTag(event, 'e', 'root') ?? firstTagValue(event, 'e');
  }
  return null;
}

/** The thread root id of a comment, across both kind-1111 and hybrid kind-1 forms. */
export function commentRootId(event: Event): string | null {
  if (event.kind === Kind.Comment) {
    return firstTagValue(event, 'E');
  }
  if (isStiqComment(event)) {
    return markedTag(event, 'e', 'root') ?? firstTagValue(event, 'e');
  }
  return null;
}

/**
 * The thread ROOT's author pubkey of a comment, across both kind-1111 and hybrid kind-1 forms.
 * NIP-22 kind-1111 comments carry it in the uppercase 'P' tag. Hybrid kind-1 'stiq-comment' notes have
 * no NIP-22 'P' tag at all, so buildNoteComment marks the root author's 'p' tag `'root'` — read that.
 *
 * LEGACY FALLBACK: hybrid comments published before the markers existed have unmarked 'p' tags, where
 * the root author is the FIRST one by emission order. `markedTag` returning undefined for an unmarked
 * event makes the fallback exact rather than a guess — old events have no 'root'-marked tag at all.
 *
 * Returns null for anything that isn't one of the two comment shapes Stiq produces, or when the
 * relevant tag is missing/empty.
 */
export function commentRootAuthor(event: Event): string | null {
  if (event.kind === Kind.Comment) {
    return firstTagValue(event, 'P');
  }
  if (isStiqComment(event)) {
    return markedTag(event, 'p', 'root') ?? firstTagValue(event, 'p');
  }
  return null;
}

/**
 * The immediate PARENT's author pubkey of a comment, across both kind-1111 and hybrid kind-1 forms.
 * NIP-22 kind-1111 comments carry it in the lowercase 'p' tag. Hybrid kind-1 'stiq-comment' notes carry
 * a `'reply'`-marked 'p' tag when the comment is a daughter of another comment; a top-level comment has
 * no 'reply' marker because its parent IS the root, so the `'root'`-marked tag is its parent author too.
 * Both reads are order-independent.
 *
 * LEGACY FALLBACK (unmarked events already on relays / in local stores): the old producer disambiguated
 * by POSITION — root author's 'p' first, parent author's 'p' second and only when the two pubkeys
 * differed. So for an unmarked event: two 'p' tags → the second is the parent author; one 'p' tag → the
 * parent author IS the root author (either a genuine top-level comment, or a daughter of a comment
 * written by the root author — the old format could not distinguish those, which is precisely why the
 * markers exist). Either way the single tag correctly IS the parent author, so it is returned rather
 * than treated as unknown. This branch is only ever reached by events the old producer wrote; it is not
 * a fallback for malformed or foreign events, which resolve to null via `hasMarkedPTag` + no 'p' tag.
 *
 * Returns null for anything that isn't one of the two comment shapes Stiq produces, or when no 'p' tag
 * is present at all.
 */
export function commentParentAuthor(event: Event): string | null {
  if (event.kind === Kind.Comment) {
    return firstTagValue(event, 'p');
  }
  if (!isStiqComment(event)) {
    return null;
  }
  if (hasMarkedPTag(event)) {
    // A top-level comment's parent is the root, so it legitimately has no 'reply' marker.
    return markedTag(event, 'p', 'reply') ?? markedTag(event, 'p', 'root') ?? null;
  }
  const pTags = event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
  if (pTags.length === 0) {
    return null;
  }
  return (pTags.length >= 2 ? pTags[1] : pTags[0]) ?? null;
}
