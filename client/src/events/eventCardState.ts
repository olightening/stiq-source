/**
 * Live card state for event embeds — module-level resolver, cloned from channels/spaceCta.ts.
 *
 * WHY a resolver and not a prop: the EventCard renders inside ReferencedCard/RefEmbed, which sit
 * under MessageBody/ChatBubble/RichText across FIVE independent surfaces (DM, group, channel,
 * comments, feed). The live state (counts, status, the viewer's RSVP) lives on the AppRuntime;
 * threading a getter prop through every layer of every surface is exactly the bug-#12 drift trap.
 * The host (App.tsx) registers the runtime-backed resolver once; render paths read it. Every
 * state change that can flip a card (interest toggled, application sent/decided, cancel/edit
 * republish) also emits a runtime snapshot, so the tree re-renders and the card is never stale.
 */
import type {EventStatus, RsvpState} from './types';

/** Live, relay-backed card state for one event, keyed by its 31923 coordinate. */
export interface EventCardLive {
  interestedCount: number;
  /** Raw host-authoritative "going" count (display gating happens in cardProps). */
  attendingCount: number;
  status: EventStatus;
  rsvp: RsvpState;
}

type EventLiveResolver = (coordinate: string) => EventCardLive | null;

let resolver: EventLiveResolver | null = null;

/** Register (or clear, with null) the host's live-state resolver. */
export function setEventLiveResolver(r: EventLiveResolver | null): void {
  resolver = r;
}

/** Live state for an event coordinate, or null when unknown (render from the embed's own data). */
export function eventLiveFor(coordinate: string): EventCardLive | null {
  return resolver ? resolver(coordinate) : null;
}
