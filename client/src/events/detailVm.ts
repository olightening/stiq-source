/**
 * Detail-VM builder — composes the pure StiqEvent view the EventDetailScreen renders from a
 * parsed public doc + the live card state. One derivation, shared by the viewer's detail open
 * and the organizer's "Preview ↗" (both must show exactly what a guest sees).
 */
import * as nip19 from 'nostr-tools/nip19';
import {gradientFromSeed} from '../media/gradient';
import type {EventCardLive} from './eventCardState';
import type {EventDocView} from './eventsStore';
import type {EventRef} from './eventEmbed';
import type {StiqEvent} from './types';

export function detailEventFrom(
  doc: EventDocView,
  live: EventCardLive | null,
  nowSec: number,
): {event: StiqEvent; showSpots: boolean} {
  const p = doc.public;
  let npub = doc.addr.pubkey;
  try {
    npub = nip19.npubEncode(doc.addr.pubkey);
  } catch {
    // keep hex
  }
  const status = live?.status ?? (doc.cancelled ? 'cancelled' : 'upcoming');
  const event: StiqEvent = {
    id: doc.addr.d,
    host: {
      name: p.hostName || `${npub.slice(0, 12)}…${npub.slice(-4)}`,
      npub,
      grad: p.hostGrad ?? gradientFromSeed(doc.addr.pubkey),
    },
    external: p.external,
    externalSource: p.externalSource,
    externalLink: p.externalLink,
    type: p.type,
    title: p.title || 'Untitled event',
    description: p.description,
    tag: p.tag,
    startsAt: p.startsAt ?? '',
    endsAt: p.endsAt,
    tz: p.tz ?? '',
    recurrence: p.recurrence,
    location: {
      kind: p.type === 'ama' ? 'channel' : p.type === 'online' ? 'link' : 'physical',
      area: p.area,
      approxRadiusKm: p.approxRadiusKm,
      channel: p.channel,
      // Private fields (exactAddress/entryNotes/streamLink) NEVER come from the doc — the host
      // renders them from the viewer's own approve-frame reveal (vm.reveal), post-approval only.
    },
    capacityMode: p.capacityMode ?? 'count',
    capacity: p.capacity,
    waitlistEnabled: p.waitlistEnabled,
    interestedCount: live?.interestedCount ?? 0,
    attendingCount: live?.attendingCount ?? doc.going,
    autoAdd: p.autoAdd,
    cover: p.cover,
    status,
  };
  // Suppress the derived 'past' only when the doc genuinely has no time — keep it honest.
  if (status === 'upcoming' && event.endsAt) {
    const t = Date.parse(event.endsAt);
    if (!isNaN(t) && t / 1000 < nowSec) event.status = 'past';
  }
  // The organizer hid the attendee count (or the event is external) → no Spots row at all.
  const showSpots = !p.external && p.capacityMode != null;
  return {event, showSpots};
}

/**
 * Degraded detail VM, built straight from a `stiq:event:` embed token (opened before the real
 * kind-31923 doc has resolved) — every field the token carries (title/type/when/cover/host + the
 * `de` description snippet) is real; anything the token deliberately never carries (exact address,
 * host-authoritative aggregates beyond the live tally, autoAdd's private groupId/channelId) is
 * simply absent, same as a freshly-opened card always was before the doc landed. EventDetailHost
 * upgrades to {@link detailEventFrom} in place the moment the doc arrives.
 */
export function degradedEventFrom(
  ref: EventRef,
  live: EventCardLive | null,
  nowSec: number,
): {event: StiqEvent; showSpots: boolean} {
  let npub = ref.addr.pubkey;
  try {
    npub = nip19.npubEncode(ref.addr.pubkey);
  } catch {
    // keep hex
  }
  const status = live?.status ?? 'upcoming';
  const event: StiqEvent = {
    id: ref.addr.d,
    host: {
      name: ref.hostName || `${npub.slice(0, 12)}…${npub.slice(-4)}`,
      npub,
      grad: ref.hostGrad ?? gradientFromSeed(ref.addr.pubkey),
    },
    external: ref.external,
    externalSource: ref.externalSource,
    externalLink: ref.externalLink,
    type: ref.type,
    title: ref.title || 'Untitled event',
    description: ref.description,
    tag: ref.tag,
    startsAt: ref.startsAt ?? '',
    endsAt: ref.endsAt,
    tz: ref.tz ?? '',
    recurrence: ref.recurrence,
    location: {
      kind: ref.type === 'ama' ? 'channel' : ref.type === 'online' ? 'link' : 'physical',
      area: ref.area,
      // approxRadiusKm/channel/private fields never travel in the token — absent until the doc lands.
    },
    capacityMode: ref.capacityMode ?? 'count',
    capacity: ref.capacity,
    waitlistEnabled: ref.waitlistEnabled,
    interestedCount: live?.interestedCount ?? 0,
    attendingCount: live?.attendingCount ?? 0,
    autoAdd: ref.autoAddLabel ? {target: 'group', label: ref.autoAddLabel} : undefined,
    cover: ref.cover,
    status,
  };
  if (status === 'upcoming' && event.endsAt) {
    const t = Date.parse(event.endsAt);
    if (!isNaN(t) && t / 1000 < nowSec) event.status = 'past';
  }
  const showSpots = !ref.external && ref.capacityMode != null;
  return {event, showSpots};
}
