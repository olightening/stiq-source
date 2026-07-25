/**
 * Embed / reference tokens — the body tokens that render as a CARD, never as prose.
 *
 * Five kinds ride inside a body as a machine payload (a base64url snapshot, or a bech32 id) that a
 * reader never sees as text: every renderer replaces the token with a card. So — exactly like an
 * inline picture or voice clip — a token must not count toward a post's character/word limit, must
 * not leak its payload into a one-line preview, and must not decide a post's card shape. Embedding
 * an event card into a note used to spend ~2 KB of that note's 280-character budget, which made the
 * composer's meter read "over the limit" for a body the reader sees as one short line plus a card.
 *
 * This module is the one place that knows the whole set. `feed/inlineMedia.ts` folds it into
 * `bodyForMeasure`, so every measuring surface — composer meter, draft status chip, auto-moderation,
 * feed scoring, tweet-vs-article card shape — picks up a new embed kind at once.
 *
 * SINGLE SOURCE OF TRUTH: the four `stiq:` grammars are imported from their own codecs rather than
 * re-typed here, so a fifth embed kind is wired in by adding one line below. That is the bug-#12
 * lesson (a token is dead text to every detector that does not know it) applied to measurement.
 *
 * MIRRORED IN THE RELAY (relay/internal/policy/organizer.go `bodyForMeasure`): the relay strips the
 * same tokens, in the same order, before applying the community's note/article length rule. A body
 * the composer measures at N characters MUST measure N at the relay — otherwise the relay
 * hard-rejects a post the composer accepted, which is a "failed post" the author cannot diagnose.
 */
import {EVENT_EMBED_RE} from '../events/eventEmbed';
import {SPACE_EMBED_RE} from '../channels/spaceEmbed';
import {MSG_EMBED_RE} from '../channels/msgEmbed';
import {DRAFT_EMBED_RE} from './draftEmbed';

/**
 * The self-contained `stiq:` embeds in one alternation, built from each codec's own regex so the
 * grammars can never drift apart. Case-SENSITIVE — the payload is base64url.
 */
const STIQ_EMBED_SOURCE = [EVENT_EMBED_RE, SPACE_EMBED_RE, MSG_EMBED_RE, DRAFT_EMBED_RE]
  .map(re => re.source)
  .join('|');

/** A nostr reference to a public post/article. bech32, so matched case-insensitively (as elsewhere). */
const NOSTR_REF_SOURCE = 'nostr:(?:nevent1|note1|naddr1)[a-z0-9]+';

// Global copies drive replace/scan; separate non-global copies drive test/exec. A module-level `/g/`
// regex carries `lastIndex` from call to call, so testing with one silently starts skipping matches —
// the reason callers elsewhere rebuild these from `.source` before every `.test()`.
const STIQ_EMBED_ALL = new RegExp(STIQ_EMBED_SOURCE, 'g');
const NOSTR_REF_ALL = new RegExp(NOSTR_REF_SOURCE, 'gi');
const STIQ_EMBED_ONE = new RegExp(STIQ_EMBED_SOURCE);
const NOSTR_REF_ONE = new RegExp(NOSTR_REF_SOURCE, 'i');

type EmbedKind = 'event' | 'space' | 'msg' | 'draft' | 'ref';

/**
 * Two registers per kind: `inline` reads as a phrase in the middle of surrounding prose (preview
 * snippets, draft rows, edit history), `alone` names the whole body when there is no prose at all
 * (inbox rows, reply quotes, pinned bars).
 */
const LABELS: Record<EmbedKind, {inline: string; alone: string}> = {
  // No label may start with '#': preview reduction strips markdown headings (`^#{1,3}\s+`) and would
  // silently eat the marker along with it.
  event: {inline: '📅 event card', alone: '📅 Event'},
  space: {inline: '🌐 space card', alone: '🌐 Space'},
  msg: {inline: '🔒 private post', alone: '🔒 Private post'},
  draft: {inline: '✍ draft', alone: '✍ Draft'},
  ref: {inline: '🔗 referenced post', alone: '🔗 Referenced post'},
};

function kindOf(token: string): EmbedKind {
  if (token.startsWith('stiq:event:')) return 'event';
  if (token.startsWith('stiq:space:')) return 'space';
  if (token.startsWith('stiq:msg:')) return 'msg';
  if (token.startsWith('stiq:draft:')) return 'draft';
  return 'ref';
}

/**
 * Strip every embed/reference token so what remains can be measured as prose.
 *
 * The two passes are independent: a `stiq:` payload is base64url (no `:`) and a bech32 id is
 * `[a-z0-9]`, so neither grammar can contain the other and their order does not change the residue.
 * Order against INLINE MEDIA does matter, and is fixed in {@link bodyForMeasure} (media first).
 */
export function stripEmbedTokens(body: string): string {
  return body.replace(STIQ_EMBED_ALL, '').replace(NOSTR_REF_ALL, '');
}

/** True when the body carries at least one embed/reference token — an embed-only body is not empty. */
export function hasEmbedToken(body: string): boolean {
  return STIQ_EMBED_ONE.test(body) || NOSTR_REF_ONE.test(body);
}

/**
 * Replace each token with its short label IN PLACE, keeping the surrounding text. Use wherever a body
 * is shown as plain text rather than rendered into cards, so a token never leaks its base64.
 */
export function labelEmbedTokens(body: string): string {
  return body
    .replace(STIQ_EMBED_ALL, tok => LABELS[kindOf(tok)].inline)
    .replace(NOSTR_REF_ALL, LABELS.ref.inline);
}

/** The stand-alone label of the FIRST token in the body; '' when the body carries none. */
export function firstEmbedLabel(body: string): string {
  const stiq = STIQ_EMBED_ONE.exec(body);
  const ref = NOSTR_REF_ONE.exec(body);
  const first = stiq && ref ? (stiq.index <= ref.index ? stiq : ref) : (stiq ?? ref);
  return first ? LABELS[kindOf(first[0])].alone : '';
}
