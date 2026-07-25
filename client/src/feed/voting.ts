/**
 * Voting (PLAN.md §2 / Step 13). Up/down votes are NIP-25 reactions (kind 7) with `+` / `-`
 * content, referencing the post via an `e` tag. Score is aggregated client-side from cached
 * reactions — so it survives restarts (the reactions live in the SQLite cache). One vote per
 * pubkey counts: the latest reaction wins.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';
import type {Signer} from './compose';
import {resolveAuthorPubkey} from '../blind/identity';

export type VoteDirection = 'up' | 'down';

/**
 * Marker content for a *retracted* vote. NIP-25 has no native "unvote", but it counts the
 * latest reaction per pubkey — so re-reacting with this neutral marker (value 0) cleanly
 * removes a prior up/down vote on a relay that doesn't accept kind-5 deletions.
 */
export const RETRACT_MARKER = '✖'; // ✖

/** Build an unsigned kind-7 reaction that retracts the viewer's prior vote on a post. */
export function buildRetraction(postId: string, authorPubkey: string): UnsignedEvent {
  return {
    kind: Kind.Reaction,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', postId],
      ['p', authorPubkey],
    ],
    content: RETRACT_MARKER,
  };
}

export interface Score {
  up: number;
  down: number;
  score: number;
  /** Unix timestamps (seconds) of each counted vote, used for velocity-based ranking. */
  voteTimestamps: number[];
}

/** Build an unsigned kind-7 reaction for a post. */
export function buildReaction(
  postId: string,
  authorPubkey: string,
  direction: VoteDirection,
): UnsignedEvent {
  return {
    kind: Kind.Reaction,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', postId],
      ['p', authorPubkey],
    ],
    content: direction === 'up' ? '+' : '-',
  };
}

/**
 * Build a group-scoped kind-7 reaction: same as {@link buildReaction} plus an `['h', groupId]`
 * tag so the relay can scope and enforce it (NIP-29). `content` is the raw reaction value.
 */
export function buildGroupReaction(
  groupId: string,
  targetId: string,
  targetPubkey: string,
  content = '+',
): UnsignedEvent {
  return {
    kind: Kind.Reaction,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', targetId],
      ['p', targetPubkey],
      ['h', groupId],
    ],
    content,
  };
}

/** Sign a vote via the keystore. */
export function castVote(
  signer: Signer,
  postId: string,
  authorPubkey: string,
  direction: VoteDirection,
): Promise<Event> {
  return signer.sign(buildReaction(postId, authorPubkey, direction));
}

/** +1 for an upvote, -1 for a downvote, 0 for a non-vote reaction (custom emoji). */
export function reactionValue(event: Event): number {
  if (event.kind !== Kind.Reaction) {
    return 0;
  }
  const content = event.content.trim();
  if (content === '-') {
    return -1;
  }
  if (content === '+' || content === '') {
    return 1; // NIP-25: empty content means a like
  }
  return 0;
}

/** The post a reaction targets (its first `e` tag), or null. */
export function reactionTarget(event: Event): string | null {
  if (event.kind !== Kind.Reaction) {
    return null;
  }
  for (const tag of event.tags) {
    if (tag[0] === 'e' && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/** Aggregate a score, counting one (latest) vote per REAL voter. For blind reactions the signer
 * is a throwaway key, so we dedup on the author resolved from the encrypted attribution — this
 * keeps "one vote per person" even though each blind vote uses a fresh key. Non-blind reactions
 * resolve to their own pubkey, so behaviour is unchanged. */
export function scoreReactions(reactions: Event[]): Score {
  const latest = new Map<string, Event>();
  for (const reaction of reactions) {
    if (reaction.kind !== Kind.Reaction) {
      continue;
    }
    const voter = resolveAuthorPubkey(reaction);
    const existing = latest.get(voter);
    if (!existing || reaction.created_at > existing.created_at) {
      latest.set(voter, reaction);
    }
  }
  let up = 0;
  let down = 0;
  const voteTimestamps: number[] = [];
  for (const reaction of latest.values()) {
    const value = reactionValue(reaction);
    if (value > 0) {
      up += 1;
      voteTimestamps.push(reaction.created_at);
    } else if (value < 0) {
      down += 1;
      // Deliberately NOT pushed. `voteTimestamps` is read by the Rising sort as *approval*
      // velocity (feed/sort.ts), so pushing a '-' here made hostility PROMOTE a post: the more a
      // post was disliked, the faster it rose. Stiq has no downvote affordance at all — every
      // onVote call site passes 'up' — so a '-' can only arrive from a patched or hostile client
      // and must never read as engagement. It still counts against `score` below.
    }
  }
  return {up, down, score: up - down, voteTimestamps};
}

/** This viewer's current vote on a post, from cached reactions. */
export function myVote(reactions: Event[], viewerPubkey: string): VoteDirection | null {
  let latest: Event | undefined;
  for (const reaction of reactions) {
    // Match on the resolved real voter so a blind vote (throwaway-signed) is still recognized as
    // the viewer's own.
    if (reaction.kind === Kind.Reaction && resolveAuthorPubkey(reaction) === viewerPubkey) {
      if (!latest || reaction.created_at > latest.created_at) {
        latest = reaction;
      }
    }
  }
  if (!latest) {
    return null;
  }
  const value = reactionValue(latest);
  if (value === 0) {
    return null; // a retraction (or non-counting reaction) means no active vote
  }
  return value < 0 ? 'down' : 'up';
}

/** Score a single post from the cache (includes voteTimestamps for velocity ranking). */
export function scoreForPost(store: EventStore, postId: string): Score {
  const reactions = store
    .query({kinds: [Kind.Reaction]})
    .filter(reaction => reactionTarget(reaction) === postId);
  return scoreReactions(reactions);
}
