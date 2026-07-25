/**
 * Post identifiers (NIP-19). Every feed item carries a shareable bech32 identifier so later
 * work (embedding, saving, sharing) has a stable handle. Plumbing only here — no share/save
 * UI yet.
 *
 *   - kind 1 (note)    → `nevent…` (event id + author + relay hint kind)
 *   - kind 30023 (article, NIP-23) → `naddr…` (addressable: kind + pubkey + `d` identifier)
 */
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';

/** The `d` tag value of an addressable event, or '' if absent. */
function dTag(event: Event): string {
  return event.tags.find(tag => tag[0] === 'd')?.[1] ?? '';
}

/**
 * Build the NIP-19 identifier for a post/article event. Never throws: a malformed event
 * (e.g. a non-hex id) falls back to the raw event id so the feed always renders.
 */
export function postIdentifier(event: Event): string {
  try {
    if (event.kind === Kind.Article) {
      return nip19.naddrEncode({
        identifier: dTag(event),
        pubkey: event.pubkey,
        kind: Kind.Article,
      });
    }
    return nip19.neventEncode({id: event.id, author: event.pubkey, kind: event.kind});
  } catch {
    return event.id;
  }
}
