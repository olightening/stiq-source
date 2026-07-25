/**
 * Moderation overlay — live effect state derived from moderator kind-1984 stiq-action events.
 *
 * For each action type, latest-wins per target id (by created_at). Only events signed by a
 * current moderator are considered.
 *
 * This is intentionally a pure, single-pass function over the store with no side effects —
 * safe to call on every snapshot.
 */
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {PostLabel} from '../feed/labels';
import {LABEL_NAMESPACE, isPostLabel} from '../feed/labels';
import {moderatorPubkeySet} from './moderators';
import {reportedPostId, stiqActionOf} from './report';

export interface ModerationOverlay {
  /** Post ids that are currently locked (lock after the latest unlock). */
  lockedPostIds: Set<string>;
  /** Post ids that are currently pinned (pin after the latest unpin). */
  pinnedPostIds: Set<string>;
  /** target id → latest moderator retag label. */
  modLabels: Map<string, PostLabel>;
}

/**
 * Compute the live moderation overlay from the store.
 *
 * For each target id, the latest stiq-action event by created_at wins.
 * - lock/unlock → determine locked state
 * - pin/unpin   → determine pinned state
 * - retag       → last label wins
 *
 * Only events from current moderators (per `npubs`) are considered.
 */
export function moderationOverlay(store: EventStore, npubs?: readonly string[]): ModerationOverlay {
  const mods = moderatorPubkeySet(npubs);

  // Track latest action per (target, action-class) pair. We separate lock/unlock and pin/unpin
  // into two independent "latest-wins" tracks, and retag into its own track.
  // key = targetId, value = {ts, action, label?}
  const latestLock = new Map<string, {ts: number; action: 'lock' | 'unlock'}>();
  const latestPin = new Map<string, {ts: number; action: 'pin' | 'unpin'}>();
  const latestRetag = new Map<string, {ts: number; label: PostLabel}>();

  for (const ev of store.query({kinds: [Kind.Report]})) {
    if (!mods.has(ev.pubkey)) continue;
    const targetId = reportedPostId(ev);
    if (!targetId) continue;
    const action = stiqActionOf(ev);
    if (!action) continue;

    if (action === 'lock' || action === 'unlock') {
      const prev = latestLock.get(targetId);
      if (!prev || ev.created_at > prev.ts) {
        latestLock.set(targetId, {ts: ev.created_at, action});
      }
    } else if (action === 'pin' || action === 'unpin') {
      const prev = latestPin.get(targetId);
      if (!prev || ev.created_at > prev.ts) {
        latestPin.set(targetId, {ts: ev.created_at, action});
      }
    } else if (action === 'retag') {
      const label = retagLabelFrom(ev);
      if (!label) continue;
      const prev = latestRetag.get(targetId);
      if (!prev || ev.created_at > prev.ts) {
        latestRetag.set(targetId, {ts: ev.created_at, label});
      }
    }
  }

  const lockedPostIds = new Set<string>();
  for (const [id, state] of latestLock) {
    if (state.action === 'lock') lockedPostIds.add(id);
  }

  const pinnedPostIds = new Set<string>();
  for (const [id, state] of latestPin) {
    if (state.action === 'pin') pinnedPostIds.add(id);
  }

  const modLabels = new Map<string, PostLabel>();
  for (const [id, state] of latestRetag) {
    modLabels.set(id, state.label);
  }

  return {lockedPostIds, pinnedPostIds, modLabels};
}

/** Extract a valid PostLabel from a retag report's `l` tag. */
function retagLabelFrom(ev: {tags: string[][]}): PostLabel | null {
  for (const tag of ev.tags) {
    if (tag[0] === 'l' && tag[2] === LABEL_NAMESPACE && tag[1] && isPostLabel(tag[1])) {
      return tag[1] as PostLabel;
    }
  }
  return null;
}
