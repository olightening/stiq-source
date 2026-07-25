/**
 * Flair-style tag handling (PLAN.md §2 / Step 12). Tags are NIP-12 `t` tags: lowercase,
 * trimmed, de-duplicated. The leading `#` a user might type is stripped.
 */
import type {Event} from 'nostr-tools/pure';

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase();
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/** The `t` tag values on an event. */
export function postTags(event: Event): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 't' && tag[1]) {
      out.push(tag[1]);
    }
  }
  return out;
}
