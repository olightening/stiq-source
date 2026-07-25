/**
 * Moderation events (PLAN.md §3.4). "Remove" emits a signed NIP-56 report (kind 1984)
 * referencing the offending post. The data is append-only: the post is never deleted;
 * clients hide it when they see a report from a moderator (Step 9).
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {UnsignedEvent} from '../keys/keystore';
import {LABEL_NAMESPACE} from '../feed/labels';
import type {PostLabel} from '../feed/labels';

/** NIP-56 report types (the 3rd element of the `e` tag). */
export type ReportType =
  | 'nudity'
  | 'malware'
  | 'profanity'
  | 'illegal'
  | 'spam'
  | 'impersonation'
  | 'other';

export interface RemoveOptions {
  /** Author pubkey of the offending post (adds a `p` tag). */
  authorPubkey?: string;
  /** Organizer-defined reason bucket id (3rd element of the `e` tag). Preferred. */
  reasonId?: string;
  /** Optional moderator note (event content). */
  note?: string;
  /**
   * Snapshot of the removed post's body, captured at removal time. Embedded as a
   * `content-snapshot` tag (bounded to {@link CONTENT_SNAPSHOT_MAX} chars) so the moderation log
   * can still display and search the removed text once the original event ages out of the cache.
   */
  contentSnapshot?: string;
  /** @deprecated legacy NIP-56 report type — still accepted as the bucket id. */
  reportType?: ReportType;
  /** @deprecated legacy free-text reason — still accepted as the note. */
  reason?: string;
}

/** Tag name carrying the removed content snapshot (see {@link RemoveOptions.contentSnapshot}). */
export const CONTENT_SNAPSHOT_TAG = 'content-snapshot';
/** Max length of an embedded content snapshot — bounded to avoid bloating the report event. */
export const CONTENT_SNAPSHOT_MAX = 280;

/** Anything that can sign — `Identity` satisfies this (keystore-backed). */
export interface Signer {
  sign(unsigned: UnsignedEvent): Promise<Event>;
}

/** Build the unsigned kind-1984 report that hides `postId`, tagged with the reason bucket id. */
export function buildRemoveReport(postId: string, opts: RemoveOptions = {}): UnsignedEvent {
  const bucket = opts.reasonId ?? opts.reportType ?? 'other';
  const tags: string[][] = [['e', postId, bucket]];
  if (opts.authorPubkey) {
    tags.push(['p', opts.authorPubkey]);
  }
  const snapshot = opts.contentSnapshot?.trim();
  if (snapshot) {
    tags.push([CONTENT_SNAPSHOT_TAG, snapshot.slice(0, CONTENT_SNAPSHOT_MAX)]);
  }
  return {
    kind: Kind.Report,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts.note ?? opts.reason ?? '',
  };
}

/**
 * Read the embedded content snapshot from a kind-1984 report, if one was captured at removal time.
 * Used by the moderation log as a fallback body when the original event is no longer cached.
 */
export function contentSnapshotOf(report: Event): string | undefined {
  return report.tags.find(t => t[0] === CONTENT_SNAPSHOT_TAG)?.[1] || undefined;
}

/** Sign a removal report via the keystore. The result is ready to publish to the relay. */
export function removePost(
  signer: Signer,
  postId: string,
  opts: RemoveOptions = {},
): Promise<Event> {
  return signer.sign(buildRemoveReport(postId, opts));
}

/**
 * Tag marking a moderator "restore" (un-hide). A kind-1984 carrying ['stiq-action','restore']
 * cancels an earlier hide of the same target (latest action wins). Append-only reversibility.
 */
export const ACTION_TAG = 'stiq-action';

/** All known stiq-action values. */
export type StiqAction = 'restore' | 'lock' | 'unlock' | 'retag' | 'pin' | 'unpin' | 'ban' | 'unban';

/**
 * Extract the stiq-action tag value from a kind-1984 report.
 * Returns null if the tag is absent or the value is not a known action.
 */
export function stiqActionOf(report: Event): StiqAction | null {
  for (const tag of report.tags) {
    if (tag[0] === ACTION_TAG) {
      const v = tag[1] as StiqAction;
      if (v === 'restore' || v === 'lock' || v === 'unlock' || v === 'retag' || v === 'pin' || v === 'unpin' || v === 'ban' || v === 'unban') {
        return v;
      }
    }
  }
  return null;
}

/**
 * Whether a kind-1984 is a plain hide report (no stiq-action tag, or an unknown one).
 * Only hide reports should suppress post visibility.
 */
export function isHideReport(report: Event): boolean {
  return stiqActionOf(report) === null;
}

/** Build a kind-1984 that RESTORES (un-hides) a previously hidden post/comment. */
export function buildRestore(targetId: string, opts: {authorPubkey?: string} = {}): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'restore']];
  if (opts.authorPubkey) {
    tags.push(['p', opts.authorPubkey]);
  }
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign a restore (un-hide) via the keystore. */
export function restorePost(
  signer: Signer,
  targetId: string,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildRestore(targetId, opts));
}

/** Build a kind-1984 that LOCKs a thread (prevents new replies). */
export function buildLockThread(targetId: string, opts: {authorPubkey?: string} = {}): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'lock']];
  if (opts.authorPubkey) tags.push(['p', opts.authorPubkey]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign a lock-thread action via the keystore. */
export function lockThread(
  signer: Signer,
  targetId: string,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildLockThread(targetId, opts));
}

/** Build a kind-1984 that UNLOCKs a previously locked thread. */
export function buildUnlockThread(targetId: string, opts: {authorPubkey?: string} = {}): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'unlock']];
  if (opts.authorPubkey) tags.push(['p', opts.authorPubkey]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign an unlock-thread action via the keystore. */
export function unlockThread(
  signer: Signer,
  targetId: string,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildUnlockThread(targetId, opts));
}

/** Build a kind-1984 that RETAGS a post with a new label (NIP-32 `l` tag). */
export function buildRetag(
  targetId: string,
  newLabel: PostLabel,
  opts: {authorPubkey?: string} = {},
): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'retag'], ['l', newLabel, LABEL_NAMESPACE]];
  if (opts.authorPubkey) tags.push(['p', opts.authorPubkey]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign a retag action via the keystore. */
export function retag(
  signer: Signer,
  targetId: string,
  newLabel: PostLabel,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildRetag(targetId, newLabel, opts));
}

/** Build a kind-1984 that PINs a post (pinned note). */
export function buildPin(targetId: string, opts: {authorPubkey?: string} = {}): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'pin']];
  if (opts.authorPubkey) tags.push(['p', opts.authorPubkey]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign a pin action via the keystore. */
export function pin(
  signer: Signer,
  targetId: string,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildPin(targetId, opts));
}

/** Build a kind-1984 that UNPINs a previously pinned post. */
export function buildUnpin(targetId: string, opts: {authorPubkey?: string} = {}): UnsignedEvent {
  const tags: string[][] = [['e', targetId], [ACTION_TAG, 'unpin']];
  if (opts.authorPubkey) tags.push(['p', opts.authorPubkey]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: ''};
}

/** Sign an unpin action via the keystore. */
export function unpin(
  signer: Signer,
  targetId: string,
  opts: {authorPubkey?: string} = {},
): Promise<Event> {
  return signer.sign(buildUnpin(targetId, opts));
}

/**
 * Build a kind-1984 that BANS a user. Targets a pubkey (`p` tag), carries the moderator's fixed
 * message (content), and an optional `ban-until` expiry. While active, the banned user's posts
 * are auto-hidden + logged with the message. Reversible via buildUnban (latest action wins).
 */
export function buildBan(pubkey: string, opts: {message?: string; untilSec?: number} = {}): UnsignedEvent {
  const tags: string[][] = [['p', pubkey], [ACTION_TAG, 'ban']];
  if (opts.untilSec && opts.untilSec > 0) tags.push(['ban-until', String(Math.floor(opts.untilSec))]);
  return {kind: Kind.Report, created_at: Math.floor(Date.now() / 1000), tags, content: opts.message ?? ''};
}

/** Build a kind-1984 that lifts a ban on a user. */
export function buildUnban(pubkey: string): UnsignedEvent {
  return {
    kind: Kind.Report,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', pubkey], [ACTION_TAG, 'unban']],
    content: '',
  };
}

/**
 * Whether a kind-1984 report is a "restore" (un-hide) rather than a "hide".
 * NOTE: returns 'restore' for ANY non-null stiq-action (so lock/retag/pin/unpin
 * do NOT hide posts). Callers that compute hidden-post-ids should prefer `isHideReport`.
 */
export function reportAction(report: Event): 'hide' | 'restore' {
  return isHideReport(report) ? 'hide' : 'restore';
}

/** The post id a report targets (its first `e` tag), or null. */
export function reportedPostId(report: Event): string | null {
  if (report.kind !== Kind.Report) {
    return null;
  }
  for (const tag of report.tags) {
    if (tag[0] === 'e' && tag[1]) {
      return tag[1];
    }
  }
  return null;
}
