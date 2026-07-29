/**
 * Advisory moderation — mods remove NOTHING (PLAN.md §3.4, user's final model).
 *
 * A moderator never deletes or blocks a post and never revokes anyone's ability to post. They
 * broadcast a signed kind-1984 event that tells every client how to *render* content: "posts
 * from npub X belong in the mod log, not the feed." The content stays on the relay forever;
 * clients decide placement. Because the directive is itself a public, signed event it is
 * transparent (everyone sees it) and reversible (send a counter-event, latest-wins).
 *
 * Three directive shapes, matching the three the user described:
 *   - log-user  — a STANDING rule: every post (past & future) from an author renders in the log
 *   - log       — a SINGLE event renders in the log
 *   - log-batch — a fixed set of PAST events from an author render in the log
 * Each has a reversal (unlog-user / restore) so any moderator can put content back in the feed.
 *
 * Author matching is on the REAL npub (recovered from a blind post's encrypted attribution by
 * the caller), not the throwaway signer — so a standing rule follows an author across the fresh
 * keys every blind post uses.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {UnsignedEvent} from '../keys/keystore';
import {ACTION_TAG} from './report';

/** Advisory directive values carried in the `stiq-action` tag. */
export type AdvisoryAction = 'log-user' | 'unlog-user' | 'log' | 'restore' | 'log-batch';

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * STANDING rule: render every post from `authorPubkey` (past and future) in the mod log. The
 * author can still post; their posts just don't appear in the main feed until a reversal.
 */
export function buildLogUser(authorPubkey: string): UnsignedEvent {
  return {
    kind: Kind.Report,
    created_at: now(),
    tags: [['p', authorPubkey], [ACTION_TAG, 'log-user']],
    content: '',
  };
}

/** Reverse a standing rule for `authorPubkey` — their posts return to the feed. */
export function buildUnlogUser(authorPubkey: string): UnsignedEvent {
  return {
    kind: Kind.Report,
    created_at: now(),
    tags: [['p', authorPubkey], [ACTION_TAG, 'unlog-user']],
    content: '',
  };
}

/** SINGLE event → mod log. `authorPubkey` is optional context for the log display. */
export function buildLogEvent(eventId: string, authorPubkey?: string): UnsignedEvent {
  const tags: string[][] = [['e', eventId], [ACTION_TAG, 'log']];
  if (authorPubkey) tags.push(['p', authorPubkey]);
  return {kind: Kind.Report, created_at: now(), tags, content: ''};
}

// NOTE: there is deliberately no `buildRestoreEvent` here. Reversing a single-event directive goes
// through the generic `report.buildRestore`, which emits the identical
// `[['e', id], ['stiq-action','restore']]` shape and is the ONE restore path every surface uses —
// the console, the post ⋯ menu, and the mod-log detail sheet. A second builder existed until
// 2026-07-29 and was never called outside its own test; two ways to spell one wire event is how the
// shapes drift apart. `advisory.test.ts` now exercises the real builder.

/**
 * BATCH: render a fixed set of PAST events from `authorPubkey` in the log. Used when a mod bans
 * an author and opts to also pull their existing posts. Emitted as ONE event carrying every id.
 */
export function buildLogBatch(eventIds: string[], authorPubkey: string): UnsignedEvent {
  const tags: string[][] = eventIds.map(id => ['e', id]);
  tags.push(['p', authorPubkey], [ACTION_TAG, 'log-batch']);
  return {kind: Kind.Report, created_at: now(), tags, content: ''};
}

/** Read the advisory action of a kind-1984 event, or null if it carries none we recognise. */
export function advisoryActionOf(ev: Event): AdvisoryAction | null {
  for (const tag of ev.tags) {
    if (tag[0] === ACTION_TAG) {
      const v = tag[1] as AdvisoryAction;
      if (v === 'log-user' || v === 'unlog-user' || v === 'log' || v === 'restore' || v === 'log-batch') {
        return v;
      }
    }
  }
  return null;
}

/**
 * An author currently under an active standing `log-user` rule — their posts render in the mod log
 * instead of the feed until a moderator reverses it. The moderator console's "Logged" tab lists
 * these so a moderator (any moderator, or the same one) can restore them.
 */
export interface LoggedAuthor {
  /** The author's REAL hex pubkey — the standing rule matches on this, across every throwaway key. */
  pubkey: string;
  /** When the standing rule was issued (unix seconds). */
  since: number;
  /** Hex pubkey of the moderator who issued it (for attribution). */
  moderatorPubkey: string;
}

/**
 * The authors under an active standing rule, newest first, from a folded overlay. A thin helper so
 * callers (the runtime) don't reach into `authorReports` directly.
 */
export function loggedAuthorsFrom(overlay: AdvisoryOverlay): LoggedAuthor[] {
  const out: LoggedAuthor[] = [];
  for (const [pubkey, ev] of overlay.authorReports) {
    out.push({pubkey, since: ev.created_at, moderatorPubkey: ev.pubkey});
  }
  return out.sort((a, b) => b.since - a.since);
}

/** The computed routing state: which authors and which events belong in the mod log. */
export interface AdvisoryOverlay {
  /** Real author pubkeys under an active standing rule — all their posts route to the log. */
  loggedAuthors: Set<string>;
  /** Individual event ids routed to the log (single directives + batch members). */
  loggedEvents: Set<string>;
  /** Author pubkey -> the directive event that logged them (for mod-log attribution). */
  authorReports: Map<string, Event>;
  /** Event id -> the directive event that logged it (for mod-log attribution). */
  eventReports: Map<string, Event>;
}

/**
 * Fold a set of kind-1984 advisory events (from anyone) into the live routing overlay, honoring
 * only directives signed by a current moderator and applying latest-wins per target so a reversal
 * cancels an earlier directive. Single-event directives (`log`) are handled together with the
 * pre-existing plain-hide flow elsewhere; here we also fold them so a unified overlay is possible.
 *
 * @param events candidate kind-1984 events
 * @param isModerator returns true for a pubkey on the organizer's current roster
 */
export function advisoryOverlay(
  events: Event[],
  isModerator: (pubkey: string) => boolean,
): AdvisoryOverlay {
  // Track the newest directive timestamp per author and per event so reversals win by recency.
  const authorTs = new Map<string, {ts: number; logged: boolean; ev: Event}>();
  const eventTs = new Map<string, {ts: number; logged: boolean; ev: Event}>();

  for (const ev of events) {
    if (ev.kind !== Kind.Report) continue;
    if (!isModerator(ev.pubkey)) continue;
    const action = advisoryActionOf(ev);
    if (!action) continue;

    if (action === 'log-user' || action === 'unlog-user') {
      const author = ev.tags.find(t => t[0] === 'p' && t[1])?.[1];
      if (!author) continue;
      const prev = authorTs.get(author);
      if (!prev || ev.created_at >= prev.ts) {
        authorTs.set(author, {ts: ev.created_at, logged: action === 'log-user', ev});
      }
      continue;
    }

    // Single (`log`/`restore`) and batch (`log-batch`) all act on event ids.
    const logged = action !== 'restore';
    for (const tag of ev.tags) {
      if (tag[0] !== 'e' || !tag[1]) continue;
      const id = tag[1];
      const prev = eventTs.get(id);
      if (!prev || ev.created_at >= prev.ts) {
        eventTs.set(id, {ts: ev.created_at, logged, ev});
      }
    }
  }

  const loggedAuthors = new Set<string>();
  const authorReports = new Map<string, Event>();
  for (const [author, s] of authorTs) {
    if (s.logged) {
      loggedAuthors.add(author);
      authorReports.set(author, s.ev);
    }
  }
  const loggedEvents = new Set<string>();
  const eventReports = new Map<string, Event>();
  for (const [id, s] of eventTs) {
    if (s.logged) {
      loggedEvents.add(id);
      eventReports.set(id, s.ev);
    }
  }
  return {loggedAuthors, loggedEvents, authorReports, eventReports};
}
