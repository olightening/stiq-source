/**
 * The ONE ref→EventCardProps derivation, mirroring the DC's cardProps mapping
 * (EventsOrganizer.dc.html:714-742) so every render pipeline (RichText/RefEmbed and
 * MessageBody/ReferencedCard) paints the same card from the same token — the derivation is
 * written once here precisely because it previously drifted when duplicated per surface.
 *
 * Live state (counts/status/viewer RSVP) comes from {@link eventLiveFor}; a card with no live
 * state renders the embed's own payload (offline-first), then upgrades when the store resolves.
 */
import type {EventCardProps, EventStatus} from './types';
import type {EventRef} from './eventEmbed';
import type {EventCardLive} from './eventCardState';
import {fmtWhenFromIso, recurLabel} from './format';
import {gradientFromSeed} from '../media/gradient';

/** Status when the store has nothing yet: derive `past` off the wire timestamps, else upcoming. */
function deriveStatus(ref: EventRef, nowMs: number): EventStatus {
  const end = ref.endsAt || ref.startsAt;
  if (end) {
    const t = Date.parse(end);
    if (!isNaN(t) && t < nowMs) return 'past';
  }
  return 'upcoming';
}

export function eventCardPropsFrom(
  ref: EventRef,
  live: EventCardLive | null,
  variant: 'Feed' | 'Compact',
  onPress?: () => void,
): EventCardProps {
  const w = fmtWhenFromIso(ref.startsAt, ref.tz);
  const status = live?.status ?? deriveStatus(ref, Date.now());
  // Capacity display gating, exactly per the DC: absent capacityMode = hidden (external events
  // never show spots; a hidden cap was stripped before encode, so it arrives absent).
  const isCount = ref.capacityMode === 'count';
  const capKnown = ref.capacityMode === 'limit' && ref.capacity != null;
  const showAttendance = !ref.external && ref.capacityMode != null;
  return {
    title: ref.title || 'Untitled event',
    variant,
    type: ref.type,
    month: w.month,
    day: w.day,
    dateLabel: w.dateLabel,
    timeLabel: w.timeLabel,
    locationLabel: ref.area || '',
    hostName: ref.hostName || 'Someone',
    hostGrad: ref.hostGrad ?? gradientFromSeed(ref.addr.pubkey),
    interestedCount: live?.interestedCount ?? 0,
    attendingCount: showAttendance ? live?.attendingCount ?? 0 : null,
    capacity: showAttendance && capKnown ? ref.capacity! : null,
    countOnly: showAttendance && isCount,
    tag: ref.tag || '',
    recurring: recurLabel(ref.recurrence),
    rsvp: live?.rsvp ?? null,
    status,
    external: ref.external,
    coverMode: ref.cover.mode,
    coverGradient: ref.cover.gradient,
    coverImage: ref.cover.image,
    onPress,
  };
}
