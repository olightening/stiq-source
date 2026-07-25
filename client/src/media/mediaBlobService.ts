/**
 * mediaBlobService — the app-wide binding that turns a tap on a media chip into a REAL relay fetch.
 *
 * A `[[pic:…]]` / `[[voice:…]]` token whose tail is a blob reference carries no bytes; they live in a
 * kind-30351 event (feed/mediaBlob.ts) that is deliberately NOT on the firehose. This service is the
 * only thing that pulls one in: an id-scoped REQ over Tor, issued when the viewer actually asks.
 *
 * Set once at startup against the live RelayClient + store (App.tsx, mirroring `setMediaService`).
 * When unset — tests, or before Tor is up — it degrades to a safe offline state exactly like
 * MediaService does: a blob-backed chip reports a genuine failure rather than silently spinning.
 *
 * ## This replaces a lie
 *
 * `PictureChip` previously showed "Fetching over Tor…" behind a hardcoded `780 + random*480` ms
 * timer. Nothing was fetched — the bytes had already arrived with the feed. Every state this service
 * reports is now driven by a real request's real lifecycle, including the failures: Tor is slow and
 * flaky, so `error` is a state the UI must genuinely render, not a theoretical branch.
 *
 * ## Caching: the event store IS the cache
 *
 * A fetched blob is ingested by RelayClient into the (encrypted, on-disk) event store like any other
 * event. So {@link MediaBlobService.peek} answers from the store synchronously, forever — a scroll
 * past a loaded picture never re-fetches, and the cache survives an app restart. That is strictly
 * better than an in-RAM map, so no second cache is introduced here.
 *
 * `renderedMediaCache` stays exactly what it was and is NOT used for blob bytes: it caches the
 * *rendered artifact* (the decoded pixel-art `data:` URI), whereas a blob is a *source event*. Its
 * own contract says "The SOURCE events are never touched" by a clear — so Settings → "Delete rendered
 * media" keeps dropping the decoded image and reverting the chip to tap-to-load, and the re-tap now
 * re-decodes from the local store without re-fetching over Tor. Identical semantics to today, where a
 * picture's bytes rode in its (equally un-purged) source event.
 */
import {FETCH_TIMEOUT_MS} from '../nostr/RelayClient';
import {readMediaBlobPayload, type MediaSource} from '../feed/mediaBlob';
import type {Event} from '../contracts';

/**
 * The transport + store seam this service needs, duck-typed so it stays testable with a plain fake
 * and free of any concrete RelayClient/SQLite import.
 */
export interface MediaBlobDeps {
  /** Read an event already held locally (the durable blob cache). */
  getById(id: string): Event | undefined;
  /** Issue an id-scoped REQ. Matching events ingest into the store; see RelayClient.fetchById. */
  fetchById(ids: string[]): void;
  /** Subscribe to newly-stored events; returns an unsubscribe. */
  onEvent(cb: (event: Event) => void): () => void;
  /** Whether a fetch could plausibly succeed right now (relay/Tor up). Optional. */
  isConnected?(): boolean;
}

/** Why a blob fetch failed — distinct causes the UI may word differently. */
export type BlobFetchFailure =
  /** No transport bound / relay not connected — the request was never even attempted. */
  | 'offline'
  /** The REQ went out but the blob never arrived within the deadline. */
  | 'timeout'
  /** The blob arrived but was not a well-formed payload. */
  | 'malformed';

export class MediaBlobFetchError extends Error {
  constructor(readonly reason: BlobFetchFailure, readonly blobId: string) {
    super(`media blob ${blobId.slice(0, 8)}…: ${reason}`);
    this.name = 'MediaBlobFetchError';
  }
}

export interface MediaBlobService {
  /** The payload for `blobId` if it is already held locally, else null. Synchronous; never fetches. */
  peek(blobId: string): string | null;
  /**
   * Whether a blob event for `blobId` is held locally AT ALL — true even when its payload is
   * unreadable. The only way to tell "the blob never arrived" (timeout) from "the blob arrived and is
   * corrupt" (malformed) once a fetch has settled, since both read back as a null {@link peek}.
   * Retrying is futile in the second case and worth it in the first, so the distinction is real.
   */
  hasBlob(blobId: string): boolean;
  /**
   * Whether a fetch could plausibly succeed right now. Lets a tap while Tor is down fail FAST and
   * honestly ("offline") instead of spinning for the full 12s deadline to reach the same answer.
   */
  isConnected(): boolean;
  /**
   * Fetch blobs BY IDS over Tor, resolving a map of id → payload for those that arrived. Ids that
   * never arrived are simply absent — this resolves rather than rejects, because a multi-id fetch is
   * partially useful and the caller decides which id it actually needed.
   *
   * ARRAY-FIRST BY DESIGN: only one id is passed today, but the whole point of the signature is that
   * a decoy cover set can be layered on later with no call-site rework — `fetchBlobs([wanted,
   * ...buildCoverSet(...)])` so the relay cannot tell which picture was actually tapped. It matches
   * `subscriptionPlan.buildCoverSet`'s idiom (a real target hidden among stable, per-identity
   * decoys), and RelayClient.fetchById already chunks and paces an arbitrary id list over Tor.
   */
  fetchBlobs(ids: readonly string[]): Promise<Map<string, string>>;
}

class RelayMediaBlobService implements MediaBlobService {
  /** In-flight fetches, id → the promise resolving it. Collapses a double-tap into one REQ. */
  private readonly inFlight = new Map<string, Promise<Map<string, string>>>();

  constructor(private readonly deps: MediaBlobDeps) {}

  peek(blobId: string): string | null {
    return readMediaBlobPayload(this.deps.getById(blobId));
  }

  hasBlob(blobId: string): boolean {
    return this.deps.getById(blobId) !== undefined;
  }

  isConnected(): boolean {
    // No probe supplied ⇒ assume reachable and let the real REQ decide; never block an attempt on
    // an unknown.
    return this.deps.isConnected?.() ?? true;
  }

  async fetchBlobs(ids: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const want: string[] = [];
    for (const id of ids) {
      const cached = this.peek(id);
      if (cached !== null) {
        found.set(id, cached);
      } else if (!want.includes(id)) {
        want.push(id);
      }
    }
    if (want.length === 0) return found;

    // Collapse concurrent requests for the same id (a double-tap, or two cards showing one picture)
    // onto a single in-flight fetch instead of racing two REQs for the same bytes over Tor.
    const pending = want.map(id => this.inFlight.get(id)).filter((p): p is Promise<Map<string, string>> => p !== undefined);
    const fresh = want.filter(id => !this.inFlight.has(id));
    if (fresh.length > 0) {
      const run = this.runFetch(fresh);
      for (const id of fresh) this.inFlight.set(id, run);
      // Clear the in-flight entries however this settles, so a failed fetch is retryable on the next
      // tap (RelayClient.fetchById likewise un-blacklists ids whose events never arrived).
      const clear = (): void => {
        for (const id of fresh) {
          if (this.inFlight.get(id) === run) this.inFlight.delete(id);
        }
      };
      run.then(clear, clear);
      pending.push(run);
    }
    for (const map of await Promise.all(pending)) {
      for (const [id, payload] of map) found.set(id, payload);
    }
    return found;
  }

  /**
   * One real REQ. Registers the arrival listener BEFORE issuing the request — an event that lands
   * between "check the store" and "start listening" would otherwise be missed and reported as a
   * bogus timeout.
   */
  private runFetch(ids: string[]): Promise<Map<string, string>> {
    return new Promise<Map<string, string>>(resolve => {
      const found = new Map<string, string>();
      const outstanding = new Set(ids);
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
        resolve(found);
      };

      const take = (event: Event): void => {
        if (!outstanding.has(event.id)) return;
        const payload = readMediaBlobPayload(event);
        outstanding.delete(event.id);
        // A malformed blob is simply not "found" — the caller reports it as a failure rather than
        // handing a renderer bytes it will choke on halfway through paint.
        if (payload !== null) found.set(event.id, payload);
        if (outstanding.size === 0) settle();
      };

      unsubscribe = this.deps.onEvent(take);

      // Re-check the store now the listener is live: the blob may have landed during the await above.
      for (const id of ids) {
        const cached = this.peek(id);
        if (cached !== null) {
          found.set(id, cached);
          outstanding.delete(id);
        }
      }
      if (outstanding.size === 0) {
        settle();
        return;
      }

      // Give up no sooner than the REQ itself does (RelayClient closes an id-fetch at FETCH_TIMEOUT_MS)
      // — reporting a failure while the bytes are still in flight would be its own kind of lie.
      timer = setTimeout(settle, FETCH_TIMEOUT_MS);
      (timer as {unref?: () => void}).unref?.();

      try {
        this.deps.fetchById([...outstanding]);
      } catch {
        settle(); // transport gone — resolve with whatever the store already had
      }
    });
  }
}

export function createMediaBlobService(deps: MediaBlobDeps): MediaBlobService {
  return new RelayMediaBlobService(deps);
}

let service: MediaBlobService | null = null;

/** Bind the service to the live relay/store (App.tsx startup), or null to tear it down. */
export function setMediaBlobService(next: MediaBlobService | null): void {
  service = next;
}

/** The live service, or null when unbound (tests / pre-Tor) — callers degrade, never fall back. */
export function getMediaBlobService(): MediaBlobService | null {
  return service;
}

/**
 * Resolve a {@link MediaSource} to its base64 payload — the ONE entry point both PictureChip and
 * VoicePlayer use, so the two modalities can never drift in how they load.
 *
 * An `inline` source resolves immediately (legacy bodies still carry their bytes; nothing is
 * fetched, ever). A `blob` source hits the local store, else issues a real id-scoped REQ over Tor.
 * Rejects with {@link MediaBlobFetchError} — a genuine failure the UI must render, not swallow.
 *
 * `cover` ids, when supplied, are fetched ALONGSIDE the wanted blob purely as decoy traffic; they are
 * requested and discarded, so the relay sees a set rather than the one picture actually tapped.
 */
export async function loadMediaSource(source: MediaSource, opts?: {cover?: readonly string[]}): Promise<string> {
  if (source.kind === 'inline') return source.payloadBase64;
  const svc = getMediaBlobService();
  if (!svc) throw new MediaBlobFetchError('offline', source.blobId);

  // Already held locally (fetched earlier, or our own just-published picture) — no network at all.
  const cached = svc.peek(source.blobId);
  if (cached !== null) return cached;

  // Fail fast rather than spin for the full deadline to learn what we already know.
  if (!svc.isConnected()) throw new MediaBlobFetchError('offline', source.blobId);

  const found = await svc.fetchBlobs([source.blobId, ...(opts?.cover ?? [])]);
  const payload = found.get(source.blobId);
  if (payload === undefined) {
    // The blob either never arrived (retry may help) or arrived corrupt (it never will) — report
    // which, now that the fetch has settled and anything that did land is in the store.
    throw new MediaBlobFetchError(svc.hasBlob(source.blobId) ? 'malformed' : 'timeout', source.blobId);
  }
  return payload;
}
