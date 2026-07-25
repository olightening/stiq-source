/**
 * NIP-92/94 `imeta` media metadata.
 *
 * A post that references an image carries an `imeta` tag describing it WITHOUT the client
 * having to fetch a single byte to know what it is:
 *
 *   ["imeta",
 *     "url https://blossom.example/<sha256>.jpg",
 *     "m image/jpeg",
 *     "dim 1024x768",
 *     "blurhash LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
 *     "x <sha256-hex>",          // hash of the file at `url` (Tier-2 hash-pin)
 *     "alt a description"]
 *
 * The `blurhash` gives an instant, leak-free preview (Tier 0), and `x` lets the client
 * verify the fetched bytes match what the poster signed (Tier 2). Each element after the
 * leading "imeta" is a single "<key> <value>" string; the value may itself contain spaces.
 */
import type {Event} from 'nostr-tools/pure';

export interface ImageMeta {
  /** Where the bytes live (a Blossom/NIP-96 host — NEVER the relay). */
  url: string;
  /** MIME type, e.g. image/jpeg. */
  mime?: string;
  /** Decoded blurhash for an offline, zero-fetch preview. */
  blurhash?: string;
  /** Intrinsic dimensions, so the placeholder reserves the right aspect ratio. */
  dim?: {width: number; height: number};
  /** sha256 of the file at `url` (NIP-94 `x`) — verified after a Tor fetch. */
  sha256?: string;
  /** sha256 of the original pre-processing file (NIP-94 `ox`). */
  originalSha256?: string;
  /** Accessibility / fallback text. */
  alt?: string;
  /** Declared byte size, used to reject over-cap responses early. */
  size?: number;
}

function parseDim(value: string): {width: number; height: number} | undefined {
  const m = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!m) {
    return undefined;
  }
  return {width: Number(m[1]), height: Number(m[2])};
}

/** Parse one `imeta` tag into structured metadata. Returns null if it has no usable `url`. */
export function parseImetaTag(tag: string[]): ImageMeta | null {
  if (!Array.isArray(tag) || tag[0] !== 'imeta') {
    return null;
  }
  const meta: Partial<ImageMeta> = {};
  for (let i = 1; i < tag.length; i++) {
    const entry = tag[i];
    if (typeof entry !== 'string') {
      continue;
    }
    const sp = entry.indexOf(' ');
    if (sp < 0) {
      continue;
    }
    const key = entry.slice(0, sp);
    const value = entry.slice(sp + 1).trim();
    if (!value) {
      continue;
    }
    switch (key) {
      case 'url':
        meta.url = value;
        break;
      case 'm':
        meta.mime = value;
        break;
      case 'blurhash':
        meta.blurhash = value;
        break;
      case 'dim':
        meta.dim = parseDim(value);
        break;
      case 'x':
        meta.sha256 = value.toLowerCase();
        break;
      case 'ox':
        meta.originalSha256 = value.toLowerCase();
        break;
      case 'alt':
        meta.alt = value;
        break;
      case 'size': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
          meta.size = n;
        }
        break;
      }
    }
  }
  if (!meta.url) {
    return null;
  }
  return meta as ImageMeta;
}

/** All image references declared on an event via `imeta` tags. */
export function imageMetaFromEvent(event: Pick<Event, 'tags'>): ImageMeta[] {
  const out: ImageMeta[] = [];
  for (const tag of event.tags) {
    const meta = parseImetaTag(tag);
    if (meta) {
      out.push(meta);
    }
  }
  return out;
}

/** Build an `imeta` tag from structured metadata (used when composing an upload). */
export function buildImetaTag(meta: ImageMeta): string[] {
  const tag = ['imeta', `url ${meta.url}`];
  if (meta.mime) {
    tag.push(`m ${meta.mime}`);
  }
  if (meta.dim) {
    tag.push(`dim ${meta.dim.width}x${meta.dim.height}`);
  }
  if (meta.blurhash) {
    tag.push(`blurhash ${meta.blurhash}`);
  }
  if (meta.sha256) {
    tag.push(`x ${meta.sha256.toLowerCase()}`);
  }
  if (meta.originalSha256) {
    tag.push(`ox ${meta.originalSha256.toLowerCase()}`);
  }
  if (typeof meta.size === 'number') {
    tag.push(`size ${meta.size}`);
  }
  if (meta.alt) {
    tag.push(`alt ${meta.alt}`);
  }
  return tag;
}
