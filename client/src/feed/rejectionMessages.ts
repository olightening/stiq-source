/**
 * Calm rejection copy (T12) — turns a relay OK-frame rejection into a short, plain-language message
 * with at most one next-step. This is the presentation half of the reject-code substrate: the pure
 * {@link parseRejection} in `../nostr/rejection` extracts the machine code + embedded numbers, and
 * this module maps each known code to a specific, non-technical sentence (never a bracket, a bare
 * `blocked:` prefix, or a raw code) with the real numbers filled in.
 *
 * RENDERING IS ALWAYS ON and never gated: an UNKNOWN code (one this table doesn't map) falls back to
 * the raw human prose with no next-step — byte-identical to what the user sees today — so shipping this
 * ahead of any relay is safe. The `retryable` field here is advisory copy metadata; the actual outbox
 * retry DECISION is made elsewhere (AppRuntime.deliver via {@link isRetryable}, gated on the relay's
 * advertised reject-code version + the kill-switch) — only the unknown fallback consults isRetryable.
 *
 * LEAF module: pure string mapping, no React / app state, trivially unit-testable.
 */
import {isRetryable, parseRejection, type RejectParams} from '../nostr/rejection';

export interface CalmRejection {
  /** A short, calm, non-technical sentence describing what happened. */
  text: string;
  /** Exactly one next-step, when there is a sensible action; omitted otherwise. */
  nextStep?: string;
  /** Whether re-sending the SAME signed event could land (copy metadata; the outbox decides for real). */
  retryable: boolean;
}

/** Map a relay rejection `message` to calm copy. Never throws; unknown codes fall back to raw prose. */
export function calmRejection(message: string): CalmRejection {
  const p = parseRejection(message);
  const {max, need, have, period, retryAfterSec} = p.params;

  const shortenAndResend = 'Shorten it and resend.';
  const getMoreTokens = 'Get more tokens, then resend.';
  const rejoinFromInvite = 'Rejoin from your invite.';
  const readAlong = 'You can still read along.';
  const soonNextStep = typeof retryAfterSec === 'number' ? `Try again in ${retryAfterSec}s.` : 'Try again in a minute.';

  switch (p.code) {
    // ── Token family ──────────────────────────────────────────────────────────────────────────
    case 'token_insufficient':
      return {
        text:
          typeof need === 'number' && typeof have === 'number'
            ? `This post needs ${need} tokens; you have ${have}.`
            : "You're out of posting tokens.",
        nextStep: getMoreTokens,
        retryable: false,
      };
    case 'token_required':
    case 'token_invalid':
    case 'token_malformed':
    case 'token_spent':
    case 'too_many_tokens':
      return {text: "You're out of posting tokens.", nextStep: getMoreTokens, retryable: false};
    // Tokens-everywhere (RejectCodesVersion 4, T0.5): a channel/group message or DM published without
    // the space-write token this community now requires. Same "out of tokens" shape as the posting-
    // token family above, worded for the space (channel/group/DM) surface instead of the feed's.
    case 'space_token_required':
      return {text: "You're out of tokens to send here.", nextStep: getMoreTokens, retryable: false};
    case 'holder_proof_invalid':
      return {
        text: "Your posting token couldn't be verified.",
        nextStep: getMoreTokens,
        retryable: false,
      };

    // ── Content / size limits (fill in the real cap) ──────────────────────────────────────────
    case 'content_too_long':
      return {text: lenText('This post is too long', max), nextStep: shortenAndResend, retryable: false};
    case 'author_note_too_long':
      return {text: lenText('Your note is too long', max), nextStep: shortenAndResend, retryable: false};
    // Both of these carry the organizer's long-body cap, which is measured in WORDS (see lenText).
    case 'article_too_long':
      return {text: lenText('This article is too long', max, 'words'), nextStep: shortenAndResend, retryable: false};
    // (RejectCodesVersion 5, rich-bodies-everywhere) The same word cap reaching a body that is not a
    // long-form article — a channel broadcast, a group message, a comment. A separate code purely so
    // the copy can say "message" on those surfaces.
    case 'body_too_long':
      return {text: lenText('This message is too long', max, 'words'), nextStep: shortenAndResend, retryable: false};
    case 'event_too_large':
      return {
        text: typeof max === 'number' ? `This post is too large (max ${Math.floor(max / 1024)} KB).` : 'This post is too large.',
        nextStep: shortenAndResend,
        retryable: false,
      };
    case 'too_much_media':
      return {text: countText('Too many attachments', max), nextStep: shortenAndResend, retryable: false};
    case 'article_too_much_media':
      return {
        text: countText('Too many images in this article', max),
        nextStep: shortenAndResend,
        retryable: false,
      };
    case 'too_many_tags':
      return {text: countText('Too many tags', max), nextStep: shortenAndResend, retryable: false};

    // ── Tag scope ─────────────────────────────────────────────────────────────────────────────
    case 'tag_scope':
    case 'tag_not_permitted':
      return {text: "That tag isn't allowed here.", nextStep: 'Remove the tag and resend.', retryable: false};

    // ── Rate limits ───────────────────────────────────────────────────────────────────────────
    case 'rate_limited':
      return {text: periodLimitText(period), nextStep: periodNextStep(period), retryable: false};
    case 'rate_limited_dm':
    case 'rate_limited_mailbox':
      return {text: 'The community is busy right now.', nextStep: soonNextStep, retryable: true};
    case 'mod_rate_limited':
      return {text: "You're doing that too fast.", nextStep: soonNextStep, retryable: false};

    // ── Permission / membership ───────────────────────────────────────────────────────────────
    case 'not_a_member':
      return {text: "You're not a member of this community.", nextStep: rejoinFromInvite, retryable: false};
    case 'not_group_member':
      return {text: "You're not in this group.", nextStep: rejoinFromInvite, retryable: false};
    case 'unknown_group':
      return {text: 'This group no longer exists.', nextStep: 'Pick another space.', retryable: false};
    case 'group_query_scope':
      return {text: "You can't view this group's messages.", nextStep: rejoinFromInvite, retryable: false};
    case 'group_missing_tag':
      return {text: "This message isn't tagged to a group.", nextStep: 'Reopen the group and resend.', retryable: false};
    case 'group_state_managed':
      return {text: 'The group manages this automatically.', nextStep: 'No action needed.', retryable: false};
    case 'moderator_denied':
      return {text: "Your role doesn't allow that.", nextStep: 'Ask an organizer for access.', retryable: false};
    case 'broadcast_only':
      return {text: 'Only admins can post here.', nextStep: readAlong, retryable: false};
    case 'comments_closed':
      return {text: 'Comments are closed on this post.', nextStep: 'You can still react.', retryable: false};
    case 'reactions_closed':
      return {text: 'Reactions are closed on this post.', nextStep: 'You can still comment.', retryable: false};
    case 'channel_organizer_only':
      return {text: 'Only the organizer can post in this channel.', nextStep: readAlong, retryable: false};
    case 'channel_mods_only':
      return {text: 'Only moderators can post in this channel.', nextStep: readAlong, retryable: false};
    case 'newcomer_links':
      return {text: "New members can't post links yet.", nextStep: 'Post without the link for now.', retryable: false};
    case 'newcomer_channels':
      return {text: "New members can't post in channels yet.", nextStep: 'Post in the main feed for now.', retryable: false};
    case 'voice_disabled':
      return {text: 'Voice messages are off in this community.', nextStep: 'Send it as text instead.', retryable: false};
    case 'config_reserved':
      return {text: 'Only the organizer can change this.', nextStep: 'Ask the organizer.', retryable: false};
    case 'kind_not_permitted':
      return {text: "This kind of message isn't allowed here.", retryable: false};

    // ── Proof-of-work security check ──────────────────────────────────────────────────────────
    case 'pow_insufficient':
    case 'pow_insufficient_committed':
      return {text: "Your device couldn't finish the security check.", nextStep: 'Retry.', retryable: false};
    case 'pow_disabled':
      return {text: "This isn't allowed here.", retryable: false};

    // ── Unknown code → raw prose, no next-step (byte-identical to today's behaviour) ───────────
    default:
      return {text: p.prose || message, retryable: isRetryable(p, {trustCodes: false})};
  }
}

/**
 * "<lead> (max N <unit>)." when N is known, else "<lead>."
 *
 * The unit is explicit because the relay's length caps are NOT all the same measure: a note and an
 * author-note are capped in CHARACTERS, while an article — and the universal long-body cap that
 * covers channel broadcasts, group messages and comments — is capped in WORDS. Saying "max 500
 * characters" for a 500-WORD cap tells the writer to cut roughly five times more than they need to.
 */
function lenText(lead: string, max: number | undefined, unit: 'characters' | 'words' = 'characters'): string {
  return typeof max === 'number' ? `${lead} (max ${max} ${unit}).` : `${lead}.`;
}

/** "<lead> (max N)." when N is known, else "<lead>." — for countable caps (tags, media). */
function countText(lead: string, max: number | undefined): string {
  return typeof max === 'number' ? `${lead} (max ${max}).` : `${lead}.`;
}

function periodLimitText(period: RejectParams['period']): string {
  switch (period) {
    case 'daily':
      return "You've reached the daily limit.";
    case 'weekly':
      return "You've reached the weekly limit.";
    case 'monthly':
      return "You've reached the monthly limit.";
    default:
      return "You've reached the limit.";
  }
}

function periodNextStep(period: RejectParams['period']): string {
  switch (period) {
    case 'daily':
      return 'Try again tomorrow.';
    case 'weekly':
      return 'Try again next week.';
    case 'monthly':
      return 'Try again next month.';
    default:
      return 'Try again later.';
  }
}
