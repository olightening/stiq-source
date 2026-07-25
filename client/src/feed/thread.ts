/**
 * Thread builder (PLAN.md §2 / Step 14, sub-step 2).
 *
 * Reconstructs a nested comment tree for a post from cached kind-1111 comments (NIP-22).
 * Reads from the cache, so threads render offline. Cycle-guarded against malformed parents.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {commentParentId, commentRootId, isStiqComment} from './comments';
import {isPinnedComment} from './pinned';

export interface CommentNode {
  event: Event;
  depth: number;
  children: CommentNode[];
}

/** Build the comment tree under a post (top-level comments, each with nested replies). */
export function buildThread(store: EventStore, rootPostId: string): CommentNode[] {
  // Both representations: NIP-22 kind-1111 comments, and hybrid kind-1 'stiq-comment' notes.
  // Query the Post bucket once and partition in a single pass instead of a separate .filter call.
  const kind1111 = store.query({kinds: [Kind.Comment]});
  const kind1Posts = store.query({kinds: [Kind.Post]});
  const stiqComments: typeof kind1Posts = [];
  for (const ev of kind1Posts) {
    if (isStiqComment(ev)) stiqComments.push(ev);
  }
  // Exclude author's-note pins: they render in the dedicated note block, never as thread comments.
  const comments = [...kind1111, ...stiqComments].filter(
    comment => commentRootId(comment) === rootPostId && !isPinnedComment(comment),
  );

  const byParent = new Map<string, Event[]>();
  for (const comment of comments) {
    const parent = commentParentId(comment) ?? rootPostId;
    const bucket = byParent.get(parent);
    if (bucket) {
      bucket.push(comment);
    } else {
      byParent.set(parent, [comment]);
    }
  }

  const MAX_COMMENT_DEPTH = 100;
  const visited = new Set<string>();
  const build = (parentId: string, depth: number): CommentNode[] => {
    if (depth >= MAX_COMMENT_DEPTH) return [];
    const children = (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.created_at - b.created_at);
    const nodes: CommentNode[] = [];
    for (const event of children) {
      if (visited.has(event.id)) {
        continue; // cycle / duplicate guard
      }
      visited.add(event.id);
      nodes.push({event, depth, children: build(event.id, depth + 1)});
    }
    return nodes;
  };

  return build(rootPostId, 0);
}

/**
 * Split a thread into visible vs hidden by an owner-moderation predicate. A hidden node takes
 * its whole subtree with it (replies under a removed comment are removed too). Returns the
 * pruned visible tree and a flat list of the hidden top-most nodes (for an owner mod-log view).
 */
export function partitionThread(
  nodes: CommentNode[],
  isHidden: (event: Event) => boolean,
): {visible: CommentNode[]; hidden: CommentNode[]} {
  const visible: CommentNode[] = [];
  const hidden: CommentNode[] = [];
  for (const node of nodes) {
    if (isHidden(node.event)) {
      hidden.push(node);
      continue;
    }
    const childResult = partitionThread(node.children, isHidden);
    visible.push({...node, children: childResult.visible});
    hidden.push(...childResult.hidden);
  }
  return {visible, hidden};
}

/** Total number of comments in a thread. */
export function countComments(nodes: CommentNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countComments(node.children);
  }
  return total;
}

/** Pre-order flatten (parent before children), for list rendering. */
export function flattenThread(nodes: CommentNode[]): CommentNode[] {
  const out: CommentNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenThread(node.children));
  }
  return out;
}
