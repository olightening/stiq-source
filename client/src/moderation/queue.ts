/**
 * Moderator review queue (multi-level moderation, human layer).
 *
 * Members report content with the same kind-1984 hide-report a moderator uses (moderation/report
 * `buildRemoveReport`); the only difference is the signer. A member report changes nothing on its
 * own — it surfaces here, in the moderator-only console, for a human decision (uphold / dismiss).
 *
 * `pendingReports` collects member (NON-moderator) hide-reports on content that no moderator has
 * acted on yet, grouped by target. Targets already hidden by a moderator (a kind-1984 hide or a
 * kind-10000 mute) or authored by a banned user are excluded — there's nothing left to review.
 * The result is COMPUTED from the cache (no event is written), so every moderator derives the same
 * queue and it updates instantly as reports arrive or actions land.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {moderatorPubkeySet} from './moderators';
import {isHideReport, reportedPostId} from './report';
import {moderatorHides} from './filter';
import {advisoryOverlay} from './advisory';
import {bannedAuthors} from './bans';
import {bucketMetaFor, type ReasonsConfig} from './reasons';
import {restoredIds} from './autoModeration';
import {isStiqComment} from '../feed/comments';
import {decodeNameHeader} from '../profile/displayName';
import {resolveAuthorPubkey} from '../blind/identity';
import {resolveContent} from '../blind/blindPost';

/** One item awaiting moderator review, aggregated across every member who reported it. */
export interface PendingReport {
  /** Event id of the reported post/comment. */
  targetId: string;
  targetType: 'post' | 'comment';
  /** Author of the reported content (absent when the target isn't cached). */
  authorPubkey?: string;
  /** A short, header-stripped excerpt of the reported content ('' when not cached). */
  snippet: string;
  /** Distinct members who reported this target. */
  reporterCount: number;
  /** Reason buckets the reporters chose, resolved to display name + color (deleted ids degrade). */
  reasons: {id: string; name: string; color: string}[];
  /** Free-text notes reporters attached (deduped, capped). */
  notes: string[];
  /** Newest report timestamp (unix seconds), for sorting + "dismiss until re-reported". */
  latestAt: number;
  /** True when reporterCount has reached the organizer's auto-hide threshold (0 = disabled). */
  thresholdReached: boolean;
}

/**
 * Targets auto-hidden by the organizer's report threshold: ids that at least `reportThreshold`
 * DISTINCT members have reported, pending a moderator's decision.
 *
 * This is the suppression half of the feature. The organizer doc has carried `reportThreshold`
 * (prod: 5) since the feature shipped, `reasons.ts` documents it as "auto-hidden pending moderator
 * review", and the queue has flagged + sorted on it — but nothing ever hid anything, so a post
 * crossing the threshold stayed fully visible to every member until a human acted (audit
 * 2026-07-29, D3).
 *
 * Deliberately shaped like `autoHiddenPosts`: PURE over the store, materialized as no event, so
 * every client reaches the same verdict instantly, offline, with nothing to forge. Reversal reuses
 * the identical `restoredIds` override — one explicit moderator Restore clears it for good, even if
 * reports keep arriving. Threshold 0 (the default, and every community that never set one) returns
 * an empty set: no behavior change.
 *
 * Only NON-moderator reports count. Moderators act directly, and their own hides route through the
 * ordinary hide map — counting them here would let one moderator's report masquerade as consensus.
 */
export function thresholdHiddenTargets(
  store: EventStore,
  npubs: readonly string[] | undefined,
  reasons: ReasonsConfig,
): Set<string> {
  const out = new Set<string>();
  if (!(reasons.reportThreshold > 0)) return out;
  const mods = moderatorPubkeySet(npubs);
  const reporters = new Map<string, Set<string>>();
  for (const r of store.query({kinds: [Kind.Report]})) {
    if (mods.has(r.pubkey)) continue;
    if (!isHideReport(r)) continue; // ignore restore/lock/retag/pin/ban stiq-actions
    const id = reportedPostId(r);
    if (!id) continue;
    const seen = reporters.get(id);
    if (seen) seen.add(r.pubkey);
    else reporters.set(id, new Set([r.pubkey]));
  }
  if (reporters.size === 0) return out;
  // A moderator's explicit Restore is the override, and it is FINAL for this mechanism: it stays
  // the latest visibility action no matter how many further reports land, so a brigade can't
  // re-hide something a moderator already cleared.
  const restored = restoredIds(store, mods);
  for (const [id, who] of reporters) {
    if (who.size >= reasons.reportThreshold && !restored.has(id)) out.add(id);
  }
  return out;
}

/** Header-stripped, whitespace-collapsed excerpt of an event (title preferred for articles). A
 *  still-locked sealed body resolves to '' (never ciphertext) — the title still shows when present. */
function snippetOf(ev: Event): string {
  const title = ev.tags.find(t => t[0] === 'title')?.[1]?.trim();
  const base = title || decodeNameHeader(resolveContent(ev).text).text;
  return base.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Member reports awaiting moderator review, grouped by target and ordered
 * threshold-reached → most-reported → newest. Only counts kind-1984 hide-reports from
 * NON-moderators (moderators act directly), and only on content not already actioned.
 */
export function pendingReports(
  store: EventStore,
  npubs: readonly string[] | undefined,
  reasons: ReasonsConfig,
  nowSec: number,
): PendingReport[] {
  const mods = moderatorPubkeySet(npubs);
  const hides = moderatorHides(store, npubs);
  const banned = bannedAuthors(store, npubs, nowSec);
  // Advisory routing (mods remove nothing): a standing log-user or a single/batch log already
  // sends the target to the mod log for everyone, so there is nothing left to review.
  const advisory = advisoryOverlay(store.query({kinds: [Kind.Report]}), pk => mods.has(pk));

  interface Agg {
    reporters: Set<string>;
    reasonIds: Set<string>;
    notes: string[];
    latestAt: number;
  }
  const byTarget = new Map<string, Agg>();

  for (const r of store.query({kinds: [Kind.Report]})) {
    if (mods.has(r.pubkey)) continue; // moderators act directly; this queue is member reports only
    if (!isHideReport(r)) continue; // ignore restore/lock/retag/pin/ban stiq-actions
    const id = reportedPostId(r);
    if (!id) continue;
    if (hides.reports.has(id)) continue; // a moderator already hid this target
    if (advisory.loggedEvents.has(id)) continue; // routed to the log by a single/batch advisory
    const target = store.getById(id);
    if (target) {
      // Match on the REAL author (recovered from a blind post's attribution), so a mute/ban/standing
      // rule clears an author's reports across the throwaway key each blind post is signed with.
      const author = resolveAuthorPubkey(target);
      if (hides.mutedAuthors.has(author)) continue; // author globally muted by a moderator
      if (banned.has(author)) continue; // author already banned
      if (advisory.loggedAuthors.has(author)) continue; // author under a standing advisory rule
    }
    const agg = byTarget.get(id) ?? {reporters: new Set<string>(), reasonIds: new Set<string>(), notes: [], latestAt: 0};
    agg.reporters.add(r.pubkey);
    const reasonId = r.tags.find(t => t[0] === 'e' && t[1] === id)?.[2];
    if (reasonId) agg.reasonIds.add(reasonId);
    const note = r.content.trim();
    if (note && !agg.notes.includes(note)) agg.notes.push(note);
    if (r.created_at > agg.latestAt) agg.latestAt = r.created_at;
    byTarget.set(id, agg);
  }

  const out: PendingReport[] = [];
  for (const [id, agg] of byTarget) {
    const target = store.getById(id);
    const targetType: 'post' | 'comment' =
      target && (target.kind === Kind.Comment || isStiqComment(target)) ? 'comment' : 'post';
    out.push({
      targetId: id,
      targetType,
      // The REAL author, so advisory log-user / log-batch (and the legacy ban path) target the
      // author across every throwaway key their blind posts are signed with — not a one-off signer.
      authorPubkey: target ? resolveAuthorPubkey(target) : undefined,
      snippet: target ? snippetOf(target) : '',
      reporterCount: agg.reporters.size,
      reasons: [...agg.reasonIds].map(rid => bucketMetaFor(rid, reasons)),
      notes: agg.notes.slice(0, 5),
      latestAt: agg.latestAt,
      thresholdReached: reasons.reportThreshold > 0 && agg.reporters.size >= reasons.reportThreshold,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.thresholdReached) - Number(a.thresholdReached) ||
      b.reporterCount - a.reporterCount ||
      b.latestAt - a.latestAt,
  );
  return out;
}
