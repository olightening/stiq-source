/**
 * Nostr event kinds used by stiq, mapped to the standards in proto/README.md.
 *
 * The kind registry, the firehose ingest gate (SUBSCRIBED_KINDS), and the two off-firehose ingest
 * allow-lists (GROUP_KINDS, FETCH_ONLY_KINDS) now live in the shared contract module
 * ({@link ../contracts}) so the client can never drift from the relay/organizer. This file re-exports
 * them unchanged for the many importers that reference them via `../nostr/events` — the historical
 * home of `Kind`.
 */
export {
  Kind,
  PostState,
  SUBSCRIBED_KINDS,
  isSubscribedKind,
  GROUP_KINDS,
  FETCH_ONLY_KINDS,
} from '../contracts';
export type {Event, KindValue} from '../contracts';
