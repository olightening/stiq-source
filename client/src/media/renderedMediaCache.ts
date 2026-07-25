/**
 * In-memory cache of RENDERED media — decoded inline pixel-art and Tor-fetched images.
 *
 * These artifacts live ONLY in RAM. A Stiq Picture's bytes ride inside its source event and a remote
 * image is pulled fresh over Tor on tap; both are rendered to an in-memory `data:` URI (never written
 * to disk — the source events carry the wire form). Caching the rendered URI lets a re-opened card
 * repaint instantly instead of re-decoding / re-fetching over Tor, and gives Settings → "Delete
 * rendered media" a concrete thing to purge.
 *
 * {@link clearRenderedMedia} empties the cache AND bumps a generation counter; mounted cards subscribe
 * via {@link subscribeRenderedMedia} and, on a clear, drop their loaded image back to the tap-to-load
 * placeholder — so a remote image must be re-fetched over Tor (nothing is auto-loaded). Nothing here
 * is a secret: a remote image was already consented-to on tap this session and a picture's bytes were
 * already synced with the feed, and the whole cache is dropped on app restart / community switch.
 */

type Listener = () => void;

/** key (image URL or picture-payload id) → rendered `data:` URI. */
const cache = new Map<string, string>();
const listeners = new Set<Listener>();
let generation = 0;

/** A previously rendered media URI for `key`, or undefined if not cached. */
export function getRenderedMedia(key: string): string | undefined {
  return cache.get(key);
}

/** Remember a rendered media URI so a re-mounted card can repaint it without re-fetch/re-decode. */
export function putRenderedMedia(key: string, dataUri: string): void {
  cache.set(key, dataUri);
}

/** How many rendered-media entries are currently cached (drives the Settings preview). */
export function renderedMediaSize(): number {
  return cache.size;
}

/**
 * Monotonic counter bumped on every {@link clearRenderedMedia}. A card can compare it across renders,
 * but subscribing (below) is the usual path.
 */
export function renderedMediaGeneration(): number {
  return generation;
}

/** Subscribe to cache clears; the returned function unsubscribes. Fired synchronously on a clear. */
export function subscribeRenderedMedia(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Drop every cached rendered image + decoded picture and notify subscribers so open cards revert to
 * their tap-to-load placeholder. Returns how many entries were purged. The SOURCE events are never
 * touched — media re-renders (re-fetches over Tor / re-decodes) on the next tap.
 */
export function clearRenderedMedia(): number {
  const n = cache.size;
  cache.clear();
  generation++;
  // Snapshot the listener set: a subscriber's teardown may mutate `listeners` while we notify.
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener error must not block the rest of the clear */
    }
  }
  return n;
}
