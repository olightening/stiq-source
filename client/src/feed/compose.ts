/**
 * Post composition (PLAN.md §2 / Step 12). A post is a kind-1 event carrying flair-style
 * `t` tags (NIP-12), signed via the keystore.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {UnsignedEvent} from '../keys/keystore';
import {normalizeTags} from './tags';
import {LABEL_NAMESPACE, isPostLabel, type PostLabel} from './labels';
import {buildImetaTag, type ImageMeta} from '../nostr/imeta';

export interface Signer {
  sign(unsigned: UnsignedEvent): Promise<Event>;
}

/**
 * Build an unsigned kind-1 post with normalized `t` tags. Throws on empty content.
 * `images` (NIP-94 imeta) are attached as `imeta` tags so referenced media carries its
 * BlurHash + sha256 to every reader (leak-free preview + hash-pinned download). An optional
 * `label` rides along as a NIP-32 ['l', id, 'stiq.type'] tag, the same as articles, so a
 * tweet-like note can carry a post-type label the feed renders.
 */
export function buildPost(
  content: string,
  tags: string[] = [],
  images: ImageMeta[] = [],
  contentWarning?: string,
  label?: PostLabel,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('post content is empty');
  }
  const cwTag: string[][] = contentWarning ? [['content-warning', contentWarning]] : [];
  const labelTag: string[][] = label && isPostLabel(label) ? [['l', label, LABEL_NAMESPACE]] : [];
  return {
    kind: Kind.Post,
    created_at: Math.floor(Date.now() / 1000),
    tags: [...cwTag, ...labelTag, ...normalizeTags(tags).map(t => ['t', t]), ...images.map(buildImetaTag)],
    content: trimmed,
  };
}

/** Sign a post via the keystore. The result is ready to publish to the relay. */
export function publishPost(
  signer: Signer,
  content: string,
  tags: string[] = [],
  images: ImageMeta[] = [],
  contentWarning?: string,
  label?: PostLabel,
): Promise<Event> {
  return signer.sign(buildPost(content, tags, images, contentWarning, label));
}

/**
 * Build an unsigned NIP-23 article (kind 30023): `title`, optional `summary`, markdown body,
 * a slug `d` tag (addressable identity), `t` topic tags, and an optional `l` post label.
 * A unique suffix is appended to the slug so distinct posts with the same title don't collide
 * (NIP-23 addressable events replace by author+d).
 */
export function buildArticle(
  title: string,
  content: string,
  tags: string[] = [],
  summary?: string,
  label?: PostLabel,
): UnsignedEvent {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('article title is empty');
  // A title-only post is valid: fall back the body to the title.
  const trimmedContent = content.trim() || trimmedTitle;
  const slug =
    trimmedTitle
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 48) || 'post';
  const dTag = `${slug}-${Date.now().toString(36)}`;
  const labelTag = label && isPostLabel(label) ? [['l', label, LABEL_NAMESPACE]] : [];
  const summaryTag = summary?.trim() ? [['summary', summary.trim()]] : [];
  return {
    kind: Kind.Article,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['title', trimmedTitle],
      ['d', dTag],
      ...summaryTag,
      ...labelTag,
      ...normalizeTags(tags).map(t => ['t', t]),
    ],
    content: trimmedContent,
  };
}

/** Sign an article via the keystore. */
export function publishArticle(
  signer: Signer,
  title: string,
  content: string,
  tags: string[] = [],
  summary?: string,
  label?: PostLabel,
): Promise<Event> {
  return signer.sign(buildArticle(title, content, tags, summary, label));
}
