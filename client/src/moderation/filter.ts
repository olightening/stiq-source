/**
 * Client-side moderation filtering (PLAN.md §3.4 / Step 9, extended in Phase C).
 *
 * Append-only: the relay never deletes content. Before rendering, the client hides any item
 * a current moderator has acted on:
 *   - a kind-1984 report targeting the item id (a "hide"), unless a later moderator "restore"
 *     event (kind-1984 carrying ['stiq-action','restore']) cancels it — latest action wins;
 *   - any item authored by a pubkey on a current moderator's kind-10000 mute list (a global
 *     "hide user", reversible by republishing the list without them).
 * The Moderation Log inverts this — it shows exactly the hidden items, attributed to the
 * moderator that hid each. Actions from non-moderators are ignored.
 */
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {isModerator, moderatorPubkeySet} from './moderators';
import {reportedPostId, reportAction, stiqActionOf} from './report';
import {isStiqComment} from '../feed/comments';
import {KIND_VOICE_MESSAGE} from '../feed/voice';
import {autoHiddenPosts, type AutoModConfig} from './autoModeration';
import {advisoryOverlay, type AdvisoryOverlay} from './advisory';
import {resolveAuthorPubkey, isUnattributedBlindPost} from '../blind/identity';
import {detectDoubleSpends} from '../blind/doubleSpend';

export interface ModerationEntry {
  /** The hidden post. */
  post: Event;
  /** The moderator event that hid it (a kind-1984 report, or a kind-10000 mute list). */
  report: Event;
  /** The moderator's hex pubkey and npub (for attribution in the log). */
  moderatorPubkey: string;
  moderatorNpub: string;
}

export interface ModeratedFeed {
  /** Posts to render in the main feed (newest first). */
  visible: Event[];
  /** Hidden posts and who hid them (newest post first). */
  moderationLog: ModerationEntry[];
}

/**
 * `buildModeratedFeed`'s result, additionally exposing the hybrid kind-1 'stiq-comment' notes it
 * split off from `visible`/`moderationLog` while querying the SAME combined
 * Post/Article/Poll/Voice bucket. `feed.ts`'s `prepareFeedItems` needs exactly this set to count
 * comments; returning it here lets it reuse this pass instead of re-querying + re-sorting the
 * whole Post-kind bucket a second time (C3 — redundant build-path sort).
 */
export interface ModeratedFeedWithComments extends ModeratedFeed {
  stiqComments: Event[];
}

// Memoize the decoded moderator hex set on the roster identity (its joined string), so the common
// case — the same roster re-passed across many reports and across successive feed rebuilds — decodes
// each npub via nip19 exactly once instead of once per report (audit finding #42). One-entry cache:
// the roster is a single stable list for the whole app, so this collapses to a hit on nearly every call.
let _rosterKey: string | undefined;
let _rosterSet: Set<string> | undefined;
function moderatorPubkeySetCached(npubs?: readonly string[]): Set<string> {
  const key = (npubs ?? []).join('\0');
  if (_rosterSet && _rosterKey === key) return _rosterSet;
  const set = moderatorPubkeySet(npubs);
  _rosterKey = key;
  _rosterSet = set;
  return set;
}

/** Moderator-global hide context, reusable for both the feed and thread views. */
export interface ModeratorHides {
  /** target id -> the (earliest) moderator report currently hiding it. */
  reports: Map<string, Event>;
  /** muted pubkey -> the moderator mute-list event that hides their content. */
  mutedAuthors: Map<string, Event>;
}

/**
 * Map of postId/commentId -> the earliest valid moderator report hiding it. Only reports
 * signed by a current moderator count, and a target is excluded when the moderator's LATEST
 * action on it is a "restore". Attribution stays with the earliest hide.
 */
export function moderatorReportsByPost(
  reports: Event[],
  npubs?: readonly string[],
): Map<string, Event> {
  const earliestHide = new Map<string, Event>();
  const latestAction = new Map<string, {ts: number; action: string}>();
  // Decode the roster npubs → hex ONCE (memoized on the roster identity), then test membership with
  // an O(1) Set lookup per report — instead of isModerator() re-bech32-decoding the whole roster per
  // report (O(reports × roster) nip19 decodes per feed rebuild — audit finding #42).
  const mods = moderatorPubkeySetCached(npubs);
  for (const report of reports) {
    if (report.kind !== Kind.Report || !mods.has(report.pubkey)) {
      continue;
    }
    const id = reportedPostId(report);
    if (!id) {
      continue;
    }
    // Only plain hides and restores affect post VISIBILITY. Lock / re-tag / pin (and their
    // reverses) are recorded moderator actions that do NOT hide the post — skip them here so
    // they never pollute the earliest-hide / latest-action bookkeeping below (which would
    // otherwise wrongly hide a post on a lock, or un-hide one whose latest action is a pin).
    const sa = stiqActionOf(report);
    if (sa && sa !== 'restore') {
      continue;
    }
    const action = reportAction(report);
    const seen = latestAction.get(id);
    if (!seen || report.created_at > seen.ts) {
      latestAction.set(id, {ts: report.created_at, action});
    }
    if (action === 'hide') {
      const existing = earliestHide.get(id);
      if (!existing || report.created_at < existing.created_at) {
        earliestHide.set(id, report);
      }
    }
  }
  const hidden = new Map<string, Event>();
  for (const [id, report] of earliestHide) {
    if (latestAction.get(id)?.action !== 'restore') {
      hidden.set(id, report);
    }
  }
  return hidden;
}

/**
 * Map of muted pubkey -> the latest moderator kind-10000 mute-list event that hides their
 * content globally. Built from the union of every current moderator's latest mute list.
 */
export function moderatorMutedAuthors(
  store: EventStore,
  npubs?: readonly string[],
): Map<string, Event> {
  const mods = moderatorPubkeySetCached(npubs);
  const latestPerMod = new Map<string, Event>();
  for (const ev of store.query({kinds: [Kind.MuteList]})) {
    if (!mods.has(ev.pubkey)) continue;
    const prev = latestPerMod.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) latestPerMod.set(ev.pubkey, ev);
  }
  const muted = new Map<string, Event>();
  for (const ev of latestPerMod.values()) {
    for (const t of ev.tags) {
      if (t[0] === 'p' && t[1]) {
        const prev = muted.get(t[1]);
        if (!prev || ev.created_at > prev.created_at) muted.set(t[1], ev);
      }
    }
  }
  return muted;
}

/** Build the moderator-global hide context from the cache. */
export function moderatorHides(store: EventStore, npubs?: readonly string[]): ModeratorHides {
  return {
    reports: moderatorReportsByPost(store.query({kinds: [Kind.Report]}), npubs),
    mutedAuthors: moderatorMutedAuthors(store, npubs),
  };
}

/** Whether a comment/post is hidden by a current moderator (reported, or author muted). Uses the
 * REAL author (resolved from a blind post's attribution) for the mute check, so a ban follows an
 * author across the throwaway keys their blind posts are signed with. */
export function isModeratorHidden(event: Event, hides: ModeratorHides): boolean {
  return hides.reports.has(event.id) || hides.mutedAuthors.has(resolveAuthorPubkey(event));
}

function entryFor(post: Event, report: Event): ModerationEntry {
  return {
    post,
    report,
    moderatorPubkey: report.pubkey,
    moderatorNpub: nip19.npubEncode(report.pubkey),
  };
}

/** Split posts into the visible feed and the moderation log. */
export function filterFeed(
  posts: Event[],
  reports: Event[],
  npubs?: readonly string[],
  mutedAuthors?: Map<string, Event>,
  advisory?: AdvisoryOverlay,
): ModeratedFeed {
  const reportsByPost = moderatorReportsByPost(reports, npubs);
  const visible: Event[] = [];
  const moderationLog: ModerationEntry[] = [];

  for (const post of posts) {
    // Plain hide (kind-1984 with no stiq-action) targeting this event id.
    const report = reportsByPost.get(post.id);
    if (report) {
      moderationLog.push(entryFor(post, report));
      continue;
    }
    // Advisory "render this event in the log" (single directive or a past-batch member).
    const evAdvisory = advisory?.eventReports.get(post.id);
    if (evAdvisory) {
      moderationLog.push(entryFor(post, evAdvisory));
      continue;
    }
    // Ban / standing "render this author in the log" — matched on the REAL author, so it follows
    // a blind author across the throwaway key each post is signed with.
    const author = resolveAuthorPubkey(post);
    const mute = mutedAuthors?.get(author);
    if (mute) {
      moderationLog.push(entryFor(post, mute));
      continue;
    }
    const authorAdvisory = advisory?.authorReports.get(author);
    if (authorAdvisory) {
      moderationLog.push(entryFor(post, authorAdvisory));
      continue;
    }
    visible.push(post);
  }

  if (visible.length > 1) visible.sort((a, b) => b.created_at - a.created_at);
  if (moderationLog.length > 1) moderationLog.sort((a, b) => b.post.created_at - a.post.created_at);
  return {visible, moderationLog};
}

/** Build the moderated feed straight from the cache (posts + reports + moderator mutes).
 * When `autoCfg` is given, posts the organizer's rules auto-hide are also dropped from `visible`
 * (they surface in the mod log via buildModLog). */
export function buildModeratedFeed(
  store: EventStore,
  npubs?: readonly string[],
  autoCfg?: AutoModConfig,
): ModeratedFeedWithComments {
  // Single combined query across Post/Article/Poll/Voice, split in ONE pass into the feed's posts
  // and the hybrid kind-1 'stiq-comment' notes (they are comments, not feed posts). The comments
  // are captured (not discarded) and returned as `stiqComments` so feed.ts's comment-count pass
  // can reuse them instead of re-querying + re-sorting the Post-kind bucket a second time.
  // unordered: filterFeed (below) unconditionally re-sorts `visible`/`moderationLog` itself
  // (created_at DESC) regardless of input order; latestArticle keeps the newest per coordinate by
  // created_at COMPARISON; detectDoubleSpends is documented pure/order-independent. Nothing here
  // depends on this query's own order, so the up-to-~3000-row combined bucket skips the sort
  // (P0-3/C1) on every feed build.
  const raw = store.query({kinds: [Kind.Post, Kind.Article, Kind.Poll, KIND_VOICE_MESSAGE], unordered: true});
  // NIP-23 articles are addressable (replaceable by author+d): keep only the latest per
  // coordinate so an edited article doesn't appear twice.
  const latestArticle = new Map<string, Event>();
  const posts: Event[] = [];
  const stiqComments: Event[] = [];
  for (const ev of raw) {
    if (isStiqComment(ev)) {
      stiqComments.push(ev);
    } else if (ev.kind === Kind.Article) {
      const d = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const coord = `${ev.pubkey}:${d}`;
      const prev = latestArticle.get(coord);
      if (!prev || ev.created_at > prev.created_at) latestArticle.set(coord, ev);
    } else {
      posts.push(ev);
    }
  }
  posts.push(...latestArticle.values());
  const reports = store.query({kinds: [Kind.Report]});
  const advisory = advisoryOverlay(reports, pk => isModerator(pk, npubs));
  const feed = filterFeed(posts, reports, npubs, moderatorMutedAuthors(store, npubs), advisory);
  // Drop unattributable blind posts (token spent but no member-signed attestation) — a patched
  // client evading ban-author. They surface in the Mod Log via buildModLog. Deferred when the
  // community key isn't loaded (isUnattributedBlindPost returns false), so a legit feed isn't emptied.
  feed.visible = feed.visible.filter(p => !isUnattributedBlindPost(p));
  if (autoCfg) {
    const auto = autoHiddenPosts(store, autoCfg, npubs);
    const banned = autoCfg.bannedAuthors;
    if (auto.size > 0 || (banned && banned.size > 0)) {
      feed.visible = feed.visible.filter(
        p => !auto.has(p.id) && !banned?.has(resolveAuthorPubkey(p)),
      );
    }
  }
  // P4 — hide holder DOUBLE-SPEND losers. A P3 posting token IS a BIP-340 pubkey Q whose secret q only
  // the true holder knows, so ONLY that holder can mint a SECOND valid spend of the same token over a
  // DIFFERENT event. detectDoubleSpends verifies every spend CRYPTOGRAPHICALLY here (never trusts a
  // tag) and, for any token spent by >=2 DISTINCT events, keeps the deterministic winner (lowest
  // created_at, ties by lowest id) and marks the rest losers. Two properties this leans on:
  //   1. a single honest post spends a token exactly once, so this can NEVER hide an honest member's
  //      post — a false conflict would need a forged holder proof no one but the holder can make;
  //   2. the winner/loser split is PURE + deterministic over the event set, so every client hides the
  //      same losers with zero coordination and neither the relay nor the organizer can weaponise it.
  // Run over the FULL pre-moderation `posts` set (NOT feed.visible): the split must be identical on
  // every client regardless of local moderation state, and a loser stays a protocol-invalid duplicate
  // even if its winner was independently moderator-hidden. Losers are dropped from the feed only — they
  // are NOT moderator actions, so they never enter moderationLog (nothing/no one moderated them).
  // Scope: the main feed post set (Post/Article/Poll/Voice); kind-1111 comment double-spends ride a
  // separate filtering path (moderatedThread/modlog) and are a documented follow-up.
  const ds = detectDoubleSpends(posts);
  if (ds.loserIds.size > 0) feed.visible = feed.visible.filter(p => !ds.loserIds.has(p.id));
  return {...feed, stiqComments};
}
