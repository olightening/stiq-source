/**
 * Unified moderation log (Phase D). Every moderator action — hiding a post, hiding a comment,
 * hiding a user, or restoring something — is recorded as a Nostr event (kind-1984 report /
 * restore, or kind-10000 mute list). This module reconstructs a flat, searchable, filterable
 * timeline of those actions from the cache, joining each action to the content it targeted.
 *
 * Pure functions over the EventStore — no UI, fully unit-testable.
 */
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {isModerator, moderatorPubkeySet} from './moderators';
import {contentSnapshotOf, reportedPostId, stiqActionOf} from './report';
import type {PostLabel} from '../feed/labels';
import {LABEL_NAMESPACE, isPostLabel} from '../feed/labels';
import {isStiqComment} from '../feed/comments';
import {autoHiddenPosts, autoHideReason, type AutoModConfig} from './autoModeration';
import {spaceAutoHidden, spaceAutoHideReason, type SpaceAutoModConfig} from './spaceAutoModeration';
import {messageChannelId, getChannel} from '../channels/channels';
import {eventGroupId, groupState, GroupKind} from '../channels/groups';
import {safeNpubEncode} from '../util/npub';
import {filterFeed, moderatorMutedAuthors} from './filter';
import {advisoryActionOf, advisoryOverlay} from './advisory';
import {resolveAuthorPubkey, isUnattributedBlindPost} from '../blind/identity';
import {resolveContent} from '../blind/blindPost';
import {KIND_VOICE_MESSAGE} from '../feed/voice';

export type ModAction = 'hide' | 'restore' | 'lock' | 'unlock' | 'retag' | 'pin' | 'unpin' | 'ban' | 'unban';
export type ModTargetType = 'post' | 'comment' | 'user';

export const UNATTRIBUTED_REASON = 'Auto-removed: no member signature (unattributable)';
/** reportType flair; a STRUCTURAL removal (no member to reinstate) → detail sheet hides Restore. */
export const UNATTRIBUTED_REPORT_TYPE = 'unattributable';

export interface ModLogEntry {
  /** Stable id for list keys (the action event id + target). */
  key: string;
  action: ModAction;
  targetType: ModTargetType;
  /** The targeted event id (post/comment) or pubkey (user). */
  target: string;
  /** Author pubkey of the targeted content, when known (posts/comments). */
  targetAuthorPubkey?: string;
  /** Snapshot of the targeted content for display + search. Taken from the cached target event
   * when available, otherwise from a `content-snapshot` tag embedded on the removal report at
   * action time, so removed posts stay searchable after they age out of the cache. */
  targetContent?: string;
  moderatorPubkey: string;
  moderatorNpub: string;
  /** When the action was taken (unix seconds). */
  timestamp: number;
  /** Free-text reason / report type (kind-1984 content / e-tag type). */
  reason?: string;
  /** NIP-56 report-type keyword (the e-tag's 3rd element, e.g. "spam"), when present. Surfaced
   * as a flair tag in the log UI. Absent for restores and user (mute-list) actions. */
  reportType?: string;
  /** Channel or group display name, when the target is a channel/group message. Undefined for
   * global-feed posts. Included in the search haystack. */
  where?: string;
  /** For 'retag' actions: the new label the moderator applied. */
  newLabel?: PostLabel;
  /** True when this entry is an automatic (rule-based) hide, not a human moderator action. */
  auto?: boolean;
}

/** A comment is either a kind-1111 event or a hybrid kind-1 'stiq-comment' note. */
function isComment(ev: Event): boolean {
  return ev.kind === Kind.Comment || isStiqComment(ev);
}

function targetTypeOf(store: EventStore, targetId: string): {type: ModTargetType; ev?: Event} {
  const ev = store.getById(targetId);
  if (!ev) return {type: 'post'}; // not cached — assume post; refined if we ever see it
  return {type: isComment(ev) ? 'comment' : 'post', ev};
}

/**
 * The log's display body for a cached target — resolveContent already collapses a still-locked
 * sealed body to '' (passthrough for everything else), so this is the one place every mod-log
 * entry's `targetContent` reads through: ciphertext can never reach search, the snippet, or the
 * detail sheet. Returns undefined for an uncached target so callers keep their existing
 * content-snapshot fallback.
 */
function bodyOf(ev: Event | undefined): string | undefined {
  return ev ? resolveContent(ev).text : undefined;
}

/**
 * Resolve the channel/group display name for a cached target event, if it belongs to one.
 * Returns undefined for global-feed posts.
 */
function resolveWhere(store: EventStore, ev: Event | undefined): string | undefined {
  if (!ev) return undefined;
  // NIP-53 channel message (kind 1311)
  if (ev.kind === Kind.LiveChat) {
    const coord = messageChannelId(ev);
    if (coord) return getChannel(store, coord)?.name;
  }
  // NIP-29 group events (kind 9, 11, 12)
  if (ev.kind === GroupKind.Chat || ev.kind === GroupKind.Thread || ev.kind === GroupKind.Reply) {
    const gid = eventGroupId(ev);
    if (gid) return groupState(store, gid)?.name;
  }
  return undefined;
}

/** Extract the retag label from a kind-1984 retag event's `l` tag. */
function retagLabel(report: Event): PostLabel | undefined {
  for (const tag of report.tags) {
    if (tag[0] === 'l' && tag[2] === LABEL_NAMESPACE && tag[1] && isPostLabel(tag[1])) {
      return tag[1] as PostLabel;
    }
  }
  return undefined;
}

/**
 * A space (channel/group) whose admin-set content rules feed the mod log. `messages` is the space's
 * resolved message list (as the read path computes it) and `cfg` its auto-moderation config.
 */
export interface SpaceAutoContext {
  messages: readonly Event[];
  cfg: SpaceAutoModConfig;
}

/**
 * Build the full moderation-action log (newest first) from the cache. Includes only actions
 * signed by a current moderator (per `npubs`). `spaceAuto` adds per-space automatic hides (a space
 * admin's content rules) so they surface in the log exactly like feed auto-hides.
 */
export function buildModLog(
  store: EventStore,
  npubs?: readonly string[],
  autoCfg?: AutoModConfig,
  spaceAuto?: readonly SpaceAutoContext[],
): ModLogEntry[] {
  const mods = moderatorPubkeySet(npubs);
  const entries: ModLogEntry[] = [];
  const reports = store.query({kinds: [Kind.Report]});

  // 1. kind-1984 reports/restores on posts & comments.
  for (const r of reports) {
    if (!mods.has(r.pubkey)) continue;
    const stiqAction = stiqActionOf(r);

    // Bans/unbans target a pubkey (p tag), not an event — record as a user action with message.
    if (stiqAction === 'ban' || stiqAction === 'unban') {
      const p = r.tags.find(t => t[0] === 'p')?.[1];
      if (!p) continue;
      entries.push({
        key: `${r.id}:${p}`,
        action: stiqAction,
        targetType: 'user',
        target: p,
        targetAuthorPubkey: p,
        moderatorPubkey: r.pubkey,
        moderatorNpub: nip19.npubEncode(r.pubkey),
        timestamp: r.created_at,
        reason: r.content || undefined,
      });
      continue;
    }

    const targetId = reportedPostId(r);
    if (!targetId) continue;
    const {type, ev} = targetTypeOf(store, targetId);

    let action: ModAction;
    if (stiqAction === null) {
      action = 'hide';
    } else {
      action = stiqAction; // 'restore'|'lock'|'unlock'|'retag'|'pin'|'unpin'
    }

    const entry: ModLogEntry = {
      key: `${r.id}:${targetId}`,
      action,
      targetType: type,
      target: targetId,
      targetAuthorPubkey: ev?.pubkey,
      // Prefer the live cached body; fall back to the snapshot captured on the report at action
      // time so removed posts stay searchable once the original event leaves the cache. A live
      // body still sealed under a locked epoch resolves to '' (never the fallback) — an untrusted
      // pre-fix snapshot could itself carry ciphertext (see report.ts), so a lock must never spill
      // into a "try the snapshot instead" path.
      targetContent: bodyOf(ev) ?? contentSnapshotOf(r),
      moderatorPubkey: r.pubkey,
      moderatorNpub: nip19.npubEncode(r.pubkey),
      timestamp: r.created_at,
      reason: r.content || reportTypeOf(r),
      reportType: stiqAction === null ? reportTypeOf(r) : undefined,
      where: resolveWhere(store, ev),
    };

    if (stiqAction === 'retag') {
      entry.newLabel = retagLabel(r);
    }

    entries.push(entry);
  }

  // 2. kind-10000 mute lists → one "hide user" entry per muted pubkey in the latest list.
  const latestMutePerMod = new Map<string, Event>();
  for (const ev of store.query({kinds: [Kind.MuteList]})) {
    if (!mods.has(ev.pubkey)) continue;
    const prev = latestMutePerMod.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) latestMutePerMod.set(ev.pubkey, ev);
  }
  for (const ev of latestMutePerMod.values()) {
    for (const t of ev.tags) {
      if (t[0] === 'p' && t[1]) {
        entries.push({
          key: `${ev.id}:${t[1]}`,
          action: 'hide',
          targetType: 'user',
          target: t[1],
          targetAuthorPubkey: t[1],
          moderatorPubkey: ev.pubkey,
          moderatorNpub: nip19.npubEncode(ev.pubkey),
          timestamp: ev.created_at,
        });
      }
    }
  }

  // 3. Automatic hides — computed from the organizer's rules (no event). Surfaced as "Automatic".
  if (autoCfg) {
    for (const [id, hide] of autoHiddenPosts(store, autoCfg, npubs)) {
      const ev = store.getById(id);
      entries.push({
        key: `auto:${id}`,
        action: 'hide',
        targetType: 'post',
        target: id,
        targetAuthorPubkey: ev?.pubkey,
        targetContent: bodyOf(ev),
        moderatorPubkey: '',
        moderatorNpub: '',
        timestamp: ev?.created_at ?? 0,
        reason: autoHideReason(hide.code),
        reportType: hide.code,
        where: resolveWhere(store, ev),
        auto: true,
      });
    }
  }

  // 4. Automatic SPACE hides — a space admin's content rules auto-remove a message (no event
  // written; verdict is derived, like block 3). Surfaced as "Automatic" with the space name.
  if (spaceAuto) {
    for (const ctx of spaceAuto) {
      for (const [id, hide] of spaceAutoHidden(store, ctx.messages, ctx.cfg)) {
        const ev = store.getById(id);
        entries.push({
          key: `space-auto:${id}`,
          action: 'hide',
          targetType: 'post',
          target: id,
          targetAuthorPubkey: ev?.pubkey,
          targetContent: bodyOf(ev),
          moderatorPubkey: '',
          moderatorNpub: '',
          timestamp: ev?.created_at ?? 0,
          reason: spaceAutoHideReason(hide.code),
          reportType: hide.code,
          where: resolveWhere(store, ev),
          auto: true,
        });
      }
    }
  }

  // 5. Comprehensive currently-hidden content — every post/comment the advisory model routes to the
  // mod log that the e-tag-driven blocks above can't see: a `log-user` STANDING rule carries only a
  // `p` tag (no `e`, so block 1 skips it entirely), a `log-batch` names many events but block 1 reads
  // only the first, and a mute list routes an author's every post/comment (block 2 records only the
  // "member" action). Reuse the FEED'S EXACT routing (filterFeed) over posts AND comments so the log
  // lists precisely what is hidden, and dedupe by target id against everything recorded above.
  const seen = new Set(entries.map(e => e.target));
  const advisory = advisoryOverlay(reports, pk => isModerator(pk, npubs));
  const muted = moderatorMutedAuthors(store, npubs);
  const candidates = store.query({
    kinds: [Kind.Post, Kind.Article, Kind.Poll, KIND_VOICE_MESSAGE, Kind.Comment],
  });
  const {moderationLog} = filterFeed(candidates, reports, npubs, muted, advisory);
  for (const m of moderationLog) {
    if (seen.has(m.post.id)) continue;
    seen.add(m.post.id);
    entries.push(hiddenContentEntry(store, m.post, m.report));
  }

  // 6. Unattributable blind posts/comments — a token was spent but no valid, member-signed
  // attestation backs the event (patched client stripping/forging `stiq_attr` to evade ban-author).
  // Conforming clients hide these from the feed/thread; surface them here as automatic (no-moderator)
  // hides so a moderator can still see the content. Structural removal — NO targetAuthorPubkey (the
  // absence of a resolvable author is the point) and no member to reinstate. Only judged once the
  // community key is loaded (isUnattributedBlindPost defers otherwise).
  for (const ev of candidates) {
    if (seen.has(ev.id)) continue;
    if (!isUnattributedBlindPost(ev)) continue;
    seen.add(ev.id);
    entries.push({
      key: `unattr:${ev.id}`,
      action: 'hide',
      targetType: ev.kind === Kind.Comment || isStiqComment(ev) ? 'comment' : 'post',
      target: ev.id,
      targetContent: resolveContent(ev).text,
      moderatorPubkey: '',
      moderatorNpub: '',
      timestamp: ev.created_at,
      reason: UNATTRIBUTED_REASON,
      reportType: UNATTRIBUTED_REPORT_TYPE,
      where: resolveWhere(store, ev),
      auto: true,
    });
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

/**
 * Build a log entry for a post/comment routed to the mod log by the advisory model (a single `log`
 * directive, a `log-batch`, a `log-user` standing rule, or a mute list). The routing `report` is the
 * signed moderator event that hid it; the full body is taken from the cached post (it stays on the
 * relay — advisory moderation never deletes it).
 */
function hiddenContentEntry(store: EventStore, post: Event, report: Event): ModLogEntry {
  const isComment = post.kind === Kind.Comment || isStiqComment(post);
  // A plain kind-1984 hide carries a reason bucket / note; advisory directives and mute lists don't.
  const plainHide =
    report.kind === Kind.Report && stiqActionOf(report) === null && advisoryActionOf(report) === null;
  const body = resolveContent(post);
  return {
    key: `${report.id}:${post.id}`,
    action: 'hide',
    targetType: isComment ? 'comment' : 'post',
    target: post.id,
    targetAuthorPubkey: resolveAuthorPubkey(post),
    // The body is live (the post is still on the relay); fall back to a report snapshot if present —
    // but NEVER for a still-locked sealed post: an old snapshot may itself predate the
    // ciphertext-snapshot fix (see report.ts's contentSnapshot capture) and must not be trusted as a
    // substitute for a body this device simply hasn't unlocked yet.
    targetContent: body.locked ? '' : body.text || contentSnapshotOf(report),
    moderatorPubkey: report.pubkey,
    moderatorNpub: nip19.npubEncode(report.pubkey),
    // A per-event hide happens after the post exists; a standing rule can predate an author's later
    // posts — use whichever is later so the row reads as "moderated" at a sensible time.
    timestamp: Math.max(report.created_at, post.created_at),
    reason: report.content || (plainHide ? reportTypeOf(report) : undefined) || undefined,
    reportType: plainHide ? reportTypeOf(report) : undefined,
    where: resolveWhere(store, post),
  };
}

function reportTypeOf(report: Event): string | undefined {
  const e = report.tags.find(t => t[0] === 'e');
  return e?.[2];
}

export interface ModLogFilter {
  /** Free-text — matches target id, content, moderator npub, target author npub, reason. */
  search?: string;
  action?: ModAction;
  targetType?: ModTargetType;
  /** Restrict to a single moderator (hex pubkey). */
  moderatorPubkey?: string;
  /** Inclusive unix-second bounds. */
  since?: number;
  until?: number;
}

function matchesSearch(entry: ModLogEntry, q: string): boolean {
  const hay = [
    entry.action,
    entry.target,
    entry.targetContent ?? '',
    entry.moderatorNpub,
    entry.reason ?? '',
    entry.reportType ?? '',
    entry.targetAuthorPubkey ? safeNpubEncode(entry.targetAuthorPubkey) : '',
    entry.where ?? '',
    entry.newLabel ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/** Apply search + filters to a built log. Pure; does not re-query. */
export function filterModLog(entries: ModLogEntry[], filter: ModLogFilter): ModLogEntry[] {
  const q = filter.search?.trim().toLowerCase();
  return entries.filter(e => {
    if (filter.action && e.action !== filter.action) return false;
    if (filter.targetType && e.targetType !== filter.targetType) return false;
    if (filter.moderatorPubkey && e.moderatorPubkey !== filter.moderatorPubkey) return false;
    if (filter.since !== undefined && e.timestamp < filter.since) return false;
    if (filter.until !== undefined && e.timestamp > filter.until) return false;
    if (q && !matchesSearch(e, q)) return false;
    return true;
  });
}

/** The distinct moderators that appear in a built log (for a filter dropdown). */
export function moderatorsInLog(entries: ModLogEntry[]): {pubkey: string; npub: string}[] {
  const seen = new Map<string, string>();
  for (const e of entries) seen.set(e.moderatorPubkey, e.moderatorNpub);
  return [...seen].map(([pubkey, npub]) => ({pubkey, npub}));
}
