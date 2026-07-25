/**
 * MessageBody — the rendered content of a message: Markdown text (bold/italic/links via RichText),
 * http link chips, and REFERENCED cards for any nostr: ref. The relay-blind identity header is
 * stripped so it never shows as text. Shared by every card layout (channel + group authored).
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {NostrEventSummary} from '../../../ui/NostrLinkPreview';
import {RichText} from '../../../feed/components/RichText';
import {LinkChip} from '../../../ui/LinkChip';
import {decodeNameHeader} from '../../../profile/displayName';
import {paragraphAlign} from '../../../ui/textDirection';
import {colors, ctType} from '../../tokens';
import {ReferencedCard} from './ReferencedCard';
import {SPACE_EMBED_RE} from '../../spaceEmbed';
import {MSG_EMBED_RE} from '../../msgEmbed';
import {DRAFT_EMBED_RE} from '../../../feed/draftEmbed';
import {INVITE_LINK_RE} from '../../invite';
import {EVENT_EMBED_RE} from '../../../events/eventEmbed';

/** Prefix of a `stiq://channel/<id>` navigate-only invite link. */
const INVITE_LINK_PREFIX = 'stiq://channel/';

/**
 * An http(s) link is lifted out into its own {@link LinkChip} card ONLY when it stands alone on its
 * own line — the "someone pasted a link" case the card was built for.
 *
 * A URL sitting INSIDE prose stays in the text, where RichText renders it as an inline 🔗 chip
 * (same safe-link dialog, no card). Lifting those out was actively destructive once bodies became
 * rich: the old `https?://[^\s]+` alternative ate the closing paren of `[Docs](https://ex.com)` and
 * left a literal `[Docs](` in the message, and pulling a URL out of a table cell or a list item
 * punched a hole in the row while the link reappeared, orphaned, below the whole body.
 *
 * The capture group is what distinguishes this alternative from the machine-token ones at match
 * time (none of those declare a group — see splitContent), and it also strips the line's padding
 * so the chip's URL never carries leading/trailing whitespace.
 */
const STANDALONE_URL_SRC = String.raw`^[ \t]*(https?://\S+)[ \t]*$`;

// Nostr refs + standalone http links, PLUS a self-contained `stiq:space:…` channel/group card token
// (see spaceEmbed.ts) AND a `stiq://channel/<id>` invite link (see invite.ts) — each built from its
// own RE's source so there's exactly one definition of each token pattern (bug #12 lesson: every
// detector must recognize it, and never drift from each other). The invite alternative precedes the
// http one so a `stiq://` link never falls into the external-link chip. `m` is for STANDALONE_URL_SRC's
// `^`/`$` alone; no other alternative uses an anchor.
const CONTENT_RE = new RegExp(
  `nostr:(?:nevent1|note1|naddr1|nprofile1|npub1)[a-z0-9]+|${SPACE_EMBED_RE.source}|${INVITE_LINK_RE.source}|${EVENT_EMBED_RE.source}|${MSG_EMBED_RE.source}|${DRAFT_EMBED_RE.source}|${STANDALONE_URL_SRC}`,
  'gm',
);

type ContentPart =
  | {type: 'text'; value: string}
  | {type: 'link'; url: string}
  | {type: 'nostr'; uri: string}
  | {type: 'invite'; url: string};

function splitContent(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CONTENT_RE)) {
    if (match.index! > last) parts.push({type: 'text', value: text.slice(last, match.index)});
    const m = match[0];
    // Only STANDALONE_URL_SRC declares a capture group, so a defined `match[1]` IS "this match was a
    // link on its own line" — no prefix sniffing needed, and it carries the padding-stripped URL.
    const standaloneUrl = match[1];
    // A stiq:space token routes through the same 'nostr' bucket as nostr: refs — ReferencedCard
    // detects the SPACE_EMBED_PREFIX itself and renders the offline channel/group card. A
    // `stiq://channel/<id>` invite link is its OWN bucket — a tappable card whose tap runs the
    // in-app accept-invite flow, never the external-link chip.
    if (standaloneUrl) parts.push({type: 'link', url: standaloneUrl});
    else if (m.startsWith(INVITE_LINK_PREFIX)) parts.push({type: 'invite', url: m});
    else {
      // Every remaining alternative is a machine token — a nostr: ref, or stiq:space/event/msg/draft.
      // They all ride the 'nostr' bucket; ReferencedCard detects each prefix itself and renders the
      // right offline card (channel/space, EventCard, referenced private post, draft).
      parts.push({type: 'nostr', uri: m});
    }
    last = match.index! + m.length;
  }
  if (last < text.length) parts.push({type: 'text', value: text.slice(last)});
  return parts;
}

export function MessageBody({
  content,
  onLookupEvent,
  onOpenRef,
  onOpenInviteLink,
}: {
  content: string;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  /** Tap a REFERENCED card → open that event. */
  onOpenRef?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card → run the in-app accept-invite flow with the RAW url. */
  onOpenInviteLink?: (url: string) => void;
}): React.JSX.Element {
  const parts = splitContent(decodeNameHeader(content).text);
  const textOnly = parts.filter(p => p.type === 'text').map(p => (p.type === 'text' ? p.value : '')).join('');
  const httpLinks = parts.filter(p => p.type === 'link');
  const nostrLinks = parts.filter(p => p.type === 'nostr');
  const inviteLinks = parts.filter(p => p.type === 'invite');

  return (
    <View>
      {/* RichText applies per-paragraph direction internally; we also pass the message's own
          first-strong alignment so a single-line channel message aligns correctly. */}
      {textOnly.trim().length > 0 && <RichText content={textOnly} style={[s.text, paragraphAlign(textOnly)]} />}
      {httpLinks.map((p, i) => (p.type === 'link' ? <LinkChip key={i} url={p.url} /> : null))}
      {nostrLinks.map((p, i) =>
        p.type === 'nostr' ? (
          <ReferencedCard key={i} uri={p.uri} onLookup={onLookupEvent} onOpenRef={onOpenRef} />
        ) : null,
      )}
      {inviteLinks.map((p, i) =>
        p.type === 'invite' ? (
          <ReferencedCard key={`inv-${i}`} uri={p.url} onLookup={onLookupEvent} onOpenInvite={onOpenInviteLink} />
        ) : null,
      )}
    </View>
  );
}

const s = StyleSheet.create({
  text: {color: colors.textPrimary, fontSize: ctType.body.fontSize, lineHeight: ctType.body.lineHeight},
});
