/**
 * Headless notification derivation for the push-triggered background sync (T1 — real push over Tor).
 *
 * A UnifiedPush wake is CONTENT-FREE: it carries no title, npub, body, or event id (the whole point
 * of the keyless-watcher design — the relay stays author/content-blind and ntfy never sees anything).
 * So the actual notification text is derived here, locally, on-device, AFTER the wake's headless sync
 * has pulled the newly-arrived events over Tor. This module turns those freshly-STORED events into
 * title-only notifications by delegating to the SAME composers the foreground uses
 * ({@link notifyDm}/{@link notifyChannel}/{@link notifyComment} in ./notifications), so every gate is
 * honoured verbatim:
 *   - the shared persisted per-source HWM (`stiq.notif.hwm`) dedupes against the foreground, so a
 *     wake never double-notifies an event the app already surfaced;
 *   - the headless session-floor override (setSessionFloor, PUSH_NOTIFY_LOOKBACK_SECONDS) lets a
 *     within-lookback event notify while an older backlog is marked seen without firing;
 *   - isNotifAllowed (prefs) + the legacy mute set still decide whether anything fires.
 *
 * PRIVACY: the DM and comment composers are always called with an EMPTY displayName. Headless never
 * resolves profiles (no display-name phonebook is loaded in the background JS context), so the title
 * collapses to the anonymized "Message from Someone" / "Someone replied" / "New message" form — the
 * title-only product lock holds even on the push path.
 *
 * WHAT THE HEADLESS CONTEXT CAN ACTUALLY RESOLVE (this shapes the comment logic below): this module's
 * ONLY inputs are {@link HeadlessNotifyDeps} — the flat batch of events THIS sync just stored
 * (`RelayClient.onEvent`, never the full persisted cache), `mySk`/`myPubkey`, and `followedGroupIds`.
 * There is no event-store handle, no display-name phonebook, and no channel roster passed in (the
 * caller, syncTask.ts, is owned by a separate workstream and its call site is not to be changed — see
 * the exported signature note below). So "is this comment genuinely for me" and "what type of post is
 * it" can ONLY be answered from fields already stamped onto the comment event's own tags — never via a
 * lookup of the root post. That turns out to be enough for BOTH comment shapes Stiq produces
 * (feed/comments.ts). The root AUTHOR is resolved via the shared `commentRootAuthor()` helper (see
 * its doc in feed/comments.ts for the 'P'-vs-first-'p' domain rule); the root's KIND still needs its
 * own resolution here (rootPostTypeOf below), since that helper doesn't cover it:
 *   - kind-1111 (NIP-22, buildComment): the root's KIND is the uppercase 'K' tag, stamped directly on
 *     the comment, exactly mirroring the field the foreground's handleIncomingEvent already keys its
 *     own notifyComment call on.
 *   - hybrid kind-1 (isStiqComment, buildNoteComment): there's no NIP-22 'K' tag, but buildPostComment
 *     only ever produces the hybrid shape when `root.kind === Kind.Post`, so the root kind is
 *     implicitly known (always Kind.Post) without a tag at all.
 * The one thing genuinely NOT resolvable headless is note-vs-picture: an inline picture is a plain
 * kind-1 note with an image embedded in its CONTENT (feed/feed.ts extractImageUrl), and headless never
 * has the root event's content — only the comment's. Rather than guess, postType is left `undefined`
 * for every Kind.Post-rooted comment (both a plain note reply and a picture-post reply), which simply
 * means notifyComment's note/picture-toggle gate doesn't apply to it (replies pref still gates it) —
 * that is the honest "can't resolve, don't fake it" choice, not a silent drop.
 *
 * SIGNATURE STABILITY: deriveHeadlessNotifications' exported shape is unchanged by the comment work
 * below on purpose — syncTask.ts:298 (owned by the Tor-lifecycle workstream, not editable here) calls
 * it with exactly {events, mySk, myPubkey, followedGroupIds} and nothing else is threaded through.
 *
 * CHANNEL-KIND RECONCILIATION (foreground vs headless): the foreground (AppRuntime.handleIncomingEvent)
 * notifies on NIP-53 LiveChat (1311); headless notifies on NIP-29 group chat (9/11/12) + NIP-28 channel
 * messages (42) via `followedGroupIds`. This mismatch is NOT resolved by this module, deliberately:
 * 1311 scopes by an `a`-tag ADDRESSABLE COORDINATE (`kind:pubkey:d-tag`), resolved against the
 * foreground's live channel roster (`this.listChannels()`) — an entirely different id space from the
 * NIP-29 `followedGroupIds` set this module receives, and there is no channel-coordinate roster in
 * {@link HeadlessNotifyDeps} to resolve it against. Firing on every 1311 without that roster would
 * notify for channels the user never joined. Adding one requires syncTask.ts to load and pass a new
 * dep — out of scope for this file under the ownership split; flagged here rather than silently
 * dropped. 9/11/12/42 stay correctly gated on `followedGroupIds` exactly as before.
 */
import {notifyChannel, notifyComment, notifyDm} from './notifications';
import {openDM} from '../dm/dm';
import {Kind, GroupKind, KIND_VOICE_MESSAGE} from '../contracts';
import {isStiqComment, commentParentAuthor, commentRootAuthor, commentRootId} from '../feed/comments';
import type {PostType} from './prefs';
import type {Event} from '../nostr/events';

/**
 * Group/channel message kinds a headless wake derives a channel notification from: NIP-29 group chat
 * (9/11/12) and NIP-28 channel messages (42). Each carries its space in an `['h', id]` tag; we only
 * notify for a space the user actually follows. NIP-53 LiveChat (1311) is intentionally excluded — see
 * the CHANNEL-KIND RECONCILIATION note in the module doc above.
 */
const GROUP_CHANNEL_KINDS: ReadonlySet<number> = new Set<number>([
  GroupKind.Chat, //     9
  GroupKind.Thread, //   11
  GroupKind.Reply, //    12
  Kind.ChannelMessage, // 42
]);

/**
 * Best-effort postType classification from fields already on the comment event — see the module doc's
 * "what headless can resolve" section for why note/picture can't be distinguished here.
 */
function rootPostTypeOf(ev: Event): PostType | undefined {
  let rootKind: number | undefined;
  if (ev.kind === Kind.Comment) {
    const k = ev.tags.find(t => t[0] === 'K' && t[1])?.[1];
    rootKind = k !== undefined ? Number(k) : undefined;
  } else if (isStiqComment(ev)) {
    rootKind = Kind.Post; // buildPostComment only emits the hybrid shape for Kind.Post roots.
  }
  if (rootKind === Kind.Article) return 'article';
  if (rootKind === Kind.Poll) return 'poll';
  if (rootKind === KIND_VOICE_MESSAGE) return 'voice';
  return undefined; // Kind.Post root: could be a plain note or an inline picture — can't tell headless.
}

export interface HeadlessNotifyDeps {
  /** Newly-STORED events collected from this sync (RelayClient.onEvent) — never the full store. */
  events: Event[];
  /** The active identity's secret key, held only for this derive pass, or null when locked/absent. */
  mySk: Uint8Array | null;
  /** The active identity's pubkey, to skip self-authored group posts. */
  myPubkey: string | undefined;
  /** The NIP-29 group ids the user follows — only these raise a channel notification. */
  followedGroupIds: Set<string>;
}

/**
 * Turn the events a headless sync just stored into title-only notifications, best-effort:
 *   (a) each kind-1059 gift wrap that decrypts with `mySk` → notifyDm(sender, '', dm.createdAt).
 *       Uses the inner rumor's true `createdAt` (a few seconds old) — NOT the wrap's fuzzed
 *       created_at (up to 2 days back) — so it lands within the lookback window and matches the
 *       foreground's HWM key so the shared dedupe works. An undecryptable wrap (not for us) throws
 *       from openDM and is silently skipped.
 *   (b) each followed-group/channel message authored by someone else → notifyChannel(hId, hId,
 *       'public', ev.created_at). The channel name isn't resolvable headless, so the h-tag id doubles
 *       as the display name (the composer renders "#<id> — new post").
 *   (c) each comment (kind-1111 NIP-22, or the hybrid kind-1 'stiq-comment') whose thread ROOT author
 *       OR immediate PARENT author is `myPubkey` (commentRootAuthor / commentParentAuthor — read
 *       straight off the comment's own tags, see their docs in feed/comments.ts; a reply to MY comment
 *       inside someone else's thread notifies too, not just a reply to my own post) and whose own
 *       author is NOT me (never notify a self-reply) → notifyComment(rootId, '', postType,
 *       ev.created_at). A single `if` below fires at most once per event, so a reply to my comment on
 *       my own post (root===me AND parent===me) still yields exactly one notifyComment call — never
 *       two. A comment whose root AND parent author can't be established (neither shape matched, or
 *       the relevant tags are missing/malformed) is SKIPPED rather than guessed at.
 *
 * The composers own all suppression (HWM, session floor, isNotifAllowed, mute); this only picks which
 * events to offer them. Never throws — a bad event is skipped so the sync task always completes.
 */
export async function deriveHeadlessNotifications(deps: HeadlessNotifyDeps): Promise<void> {
  const {events, mySk, myPubkey, followedGroupIds} = deps;
  for (const ev of events) {
    if (ev.kind === Kind.GiftWrap) {
      if (!mySk) continue;
      try {
        const dm = openDM(ev, mySk);
        await notifyDm(dm.sender, '', dm.createdAt);
      } catch {
        // Not addressed to us / undecryptable — the wrap was for someone else. Skip, never throw.
      }
      continue;
    }
    if (GROUP_CHANNEL_KINDS.has(ev.kind)) {
      const hId = ev.tags.find(t => t[0] === 'h' && t[1])?.[1];
      if (!hId || !followedGroupIds.has(hId)) continue;
      // A self-authored message must never notify the author.
      if (myPubkey && ev.pubkey === myPubkey) continue;
      await notifyChannel(hId, hId, 'public', ev.created_at);
      continue;
    }
    if (ev.kind === Kind.Comment || isStiqComment(ev)) {
      if (!myPubkey || ev.pubkey === myPubkey) continue; // no active identity, or a self-reply
      const rootAuthor = commentRootAuthor(ev);
      const parentAuthor = commentParentAuthor(ev);
      // Reply to my post OR reply to my comment (even inside someone else's thread). Root===me AND
      // parent===me (a reply to my own comment on my own post) still only reaches this single call.
      if (rootAuthor !== myPubkey && parentAuthor !== myPubkey) continue;
      const rootId = commentRootId(ev);
      if (!rootId) continue;
      await notifyComment(rootId, '', rootPostTypeOf(ev), ev.created_at);
    }
  }
}
