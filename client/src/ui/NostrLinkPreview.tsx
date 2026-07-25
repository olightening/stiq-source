/**
 * NostrLinkPreview — inline card for nostr:nevent1… / nostr:naddr1… / nostr:note1… URIs.
 *
 * If a lookup function is provided and the referenced event is in the local store, shows the
 * author name and a short content excerpt. Otherwise falls back to a generic "Nostr post" chip.
 * Tapping the card calls onOpen with the resolved event ID.
 */
import React from 'react';
import * as nip19 from 'nostr-tools/nip19';
import {RefEmbed, embedFromSummary, embedFromSpaceRef, embedFromInviteLink, embedFromMsgRef, embedFromDraftRef} from '../feed/components/RefEmbed';
import {SPACE_EMBED_PREFIX, parseSpaceEmbed} from '../channels/spaceEmbed';
import {MSG_EMBED_PREFIX, parseMsgEmbed} from '../channels/msgEmbed';
import {DRAFT_EMBED_PREFIX, parseDraftEmbed} from '../feed/draftEmbed';
import {parseInviteLink} from '../channels/invite';
import {EVENT_EMBED_PREFIX, parseEventEmbed} from '../events/eventEmbed';
import {eventCardPropsFrom} from '../events/cardProps';
import {eventLiveFor} from '../events/eventCardState';
import {EventCard} from '../events/components/EventCard';

export interface NostrEventSummary {
  /** Resolved hex event id of the referenced event (for navigation). */
  id?: string;
  pubkey: string;
  content: string;
  name?: string;
  /** Event kind — lets an embed label itself "Referenced post / comment / channel post". */
  kind?: number;
  /** Article title (NIP-23 `title` / NIP-14 `subject`), if any. */
  title?: string;
  /** The author's gradient identity, for the embed's avatar. */
  gradient?: import('../media/gradient').GradientSpec;
  /** For comment embeds: the title (or short excerpt) of the root post the comment lives under. */
  rootTitle?: string;
  /** For comment embeds: the id of the root post — lets a tapped embed open that thread. */
  rootId?: string;
}

/** Prefix of a `stiq://channel/<id>` navigate-only invite link. */
const INVITE_LINK_PREFIX = 'stiq://channel/';

export interface NostrLinkPreviewProps {
  uri: string;
  onLookup?: (id: string) => NostrEventSummary | null;
  onOpen?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card → run the in-app accept-invite flow with the RAW url. */
  onOpenInvite?: (url: string) => void;
  /** Density for a `stiq:event:` embed — 'Feed' inside feed post bodies, 'Compact' (default)
   * everywhere else (group messages, DMs, comments). */
  eventDensity?: 'Feed' | 'Compact';
}

export function decodeNostrUri(uri: string): string | null {
  try {
    const ref = uri.replace(/^nostr:/, '');
    const decoded = nip19.decode(ref);
    if (decoded.type === 'nevent') return decoded.data.id;
    if (decoded.type === 'note') return decoded.data as string;
    if (decoded.type === 'naddr') {
      // Addressable event (e.g. a NIP-23 article) — there's no single event id to return, so
      // resolve to its {kind,pubkey,d-tag} coordinate instead (the same `kind:pubkey:identifier`
      // format the runtime's naddr lookup/fetch path keys on), rather than dropping the ref.
      const {kind, pubkey, identifier} = decoded.data;
      return `${kind}:${pubkey}:${identifier}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function NostrLinkPreview({uri, onLookup, onOpen, onOpenInvite, eventDensity}: NostrLinkPreviewProps): React.JSX.Element {
  // A `stiq:event:…` token renders as the REAL EventCard (not the generic ref chrome) — the
  // token is self-contained (offline card), then upgrades live (counts/status/viewer RSVP) via
  // the module-level resolver (events/eventCardState.ts). Tap hands the RAW token to onOpen so
  // the host opens the event detail. Malformed → nothing (untrusted body content).
  if (uri.startsWith(EVENT_EMBED_PREFIX)) {
    const eventRef = parseEventEmbed(uri);
    if (!eventRef) return <></>;
    const live = eventLiveFor(eventRef.coordinate);
    const props = eventCardPropsFrom(eventRef, live, eventDensity ?? 'Compact', onOpen ? () => onOpen(uri) : undefined);
    return <EventCard {...props} />;
  }
  // A `stiq://channel/<id>` invite link renders as a tappable card whose tap runs the IN-APP
  // accept-invite flow (never the external-link dialog). The bare link carries no name — resolve a
  // richer card from onLookup when the space's metadata happens to be cached, else fall back to the
  // id-shape label. The RAW url is handed to onOpenInvite so parseInviteLink can split the fragment.
  if (uri.startsWith(INVITE_LINK_PREFIX)) {
    const parsed = parseInviteLink(uri);
    if (!parsed) return <></>;
    const summary = onLookup ? onLookup(parsed.spaceId) : null;
    return <RefEmbed view={embedFromInviteLink(parsed, summary)} onPress={() => onOpenInvite?.(uri)} />;
  }
  // A `stiq:space:…` token is SELF-CONTAINED (name + gradient carried in the token) — render it
  // fully offline, no onLookupEvent round-trip. Per the tap contract, the FULL raw token (not a
  // decoded id/coordinate) is handed to onOpen so the handler can read the carried name for the
  // request-to-join dialog. A malformed token (parseSpaceEmbed returns null) renders nothing.
  if (uri.startsWith(SPACE_EMBED_PREFIX)) {
    const ref = parseSpaceEmbed(uri);
    if (!ref) return <></>;
    return <RefEmbed view={embedFromSpaceRef(ref)} onPress={() => onOpen?.(uri)} />;
  }
  // A `stiq:draft:…` token (an unpublished piece of writing) and a `stiq:msg:…` token (a decrypted
  // snapshot of a PRIVATE channel/group post) are both SELF-CONTAINED — render fully offline and hand
  // the RAW token to onOpen so the host opens the read view (a draft/private post has no navigable id).
  if (uri.startsWith(DRAFT_EMBED_PREFIX)) {
    const ref = parseDraftEmbed(uri);
    if (!ref) return <></>;
    return <RefEmbed view={embedFromDraftRef(ref)} onPress={() => onOpen?.(uri)} />;
  }
  if (uri.startsWith(MSG_EMBED_PREFIX)) {
    const ref = parseMsgEmbed(uri);
    if (!ref) return <></>;
    return <RefEmbed view={embedFromMsgRef(ref)} onPress={() => onOpen?.(uri)} />;
  }
  // Resolve straight from the URI so addressable refs (naddr / articles) work too — the resolver
  // returns the event's hex id for navigation. Fall back to the id/coordinate decodable directly
  // from a nevent/note/naddr URI (used when the ref hasn't resolved through onLookup yet).
  const summary = onLookup ? onLookup(uri) : null;
  const id = summary?.id ?? decodeNostrUri(uri);
  const view = embedFromSummary(summary) ?? {
    kind: 'Referenced post',
    where: 'the community',
    title: 'Tap to open',
  };
  return <RefEmbed view={view} onPress={() => { if (id && onOpen) onOpen(id); }} />;
}
