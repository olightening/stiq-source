/**
 * Inline content split into plain-text / external-link / nostr-reference runs.
 * Shared by ChannelView (broadcast messages) and ConversationView (DMs), which
 * previously each carried an identical `splitContent`/`splitText` + regex.
 */
export type ContentPart =
  | {type: 'text'; value: string}
  | {type: 'link'; url: string}
  | {type: 'nostr'; uri: string};

const CONTENT_RE = /nostr:(?:nevent1|note1)[a-z0-9]+|https?:\/\/[^\s]+/g;

/** Split free text into order-preserving runs of text, URLs, and `nostr:` references. */
export function splitContent(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CONTENT_RE)) {
    if (match.index! > last) parts.push({type: 'text', value: text.slice(last, match.index)});
    const m = match[0];
    if (m.startsWith('nostr:')) {
      parts.push({type: 'nostr', uri: m});
    } else {
      parts.push({type: 'link', url: m});
    }
    last = match.index! + m.length;
  }
  if (last < text.length) parts.push({type: 'text', value: text.slice(last)});
  return parts;
}
