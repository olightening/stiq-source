/**
 * EventsApi — the ONE seam between the events UI hosts (EventDetailHost / EventsOrganizerHost,
 * mounted by MainScreen) and the AppRuntime. App.tsx builds this facade from the runtime once and
 * passes it down as a single prop, instead of threading ~25 separate callbacks through
 * MainScreen's already-enormous prop surface. Pure types here — the implementation lives in
 * App.tsx closures over the runtime.
 */
import type {GradientSpec} from '../media/gradient';
import type {EventCardLive} from './eventCardState';
import type {EventDocView} from './eventsStore';
import type {EventDraftEntry} from './drafts';
import type {
  EventDraft,
  EventReveal,
  ManagedApplication,
  ManagedGuest,
  RsvpState,
  Waitlister,
} from './types';

/** The viewer's RSVP record for one event (AppRuntime's MyEventRsvp, shaped for the UI). */
export interface MyRsvpView {
  state: Exclude<RsvpState, null>;
  pos?: number;
  reveal?: EventReveal;
  autoAddLabel?: string;
  groupId?: string;
  at: number;
}

export interface ForwardTargets {
  /** Channels the viewer OWNS (broadcast surfaces — only the owner can post into one). */
  channels: {id: string; label: string}[];
  /** Groups the viewer is a member of (members post freely). */
  groups: {id: string; label: string}[];
  peers: {pubkey: string; name: string; grad?: GradientSpec}[];
}

export interface EventsApi {
  // ── Reads (synchronous — backed by the runtime's version-cached folds) ──
  live(coordinate: string): EventCardLive | null;
  doc(coordinate: string): EventDocView | null;
  myRsvp(coordinate: string): MyRsvpView | null;
  /** Self-contained stiq:event: token for a known event (Add to embeds / Forward). */
  token(coordinate: string): string | null;
  /** Same token encoded straight from a (possibly unpublished) draft — the editor's Add to embeds. */
  tokenForDraft(draft: EventDraft): string | null;
  myPubkey(): string | null;
  viewerIdentity(): {name: string; npub: string; grad: GradientSpec | string};
  /** Channels the viewer runs (editor: ama "hosted in" + auto-add channel select). */
  channelsIRun(): {id: string; label: string}[];
  forwardTargets(): ForwardTargets;

  // ── Viewer actions ──
  toggleInterested(coordinate: string): Promise<void>;
  apply(coordinate: string, note: string): Promise<void>;
  withdraw(coordinate: string): Promise<void>;
  joinWaitlist(coordinate: string): Promise<void>;
  leaveWaitlist(coordinate: string): Promise<void>;
  /** Send the event card into a channel, group, or DM (the Forward flow — a real send). */
  forwardTo(
    target: {kind: 'channel'; id: string} | {kind: 'group'; id: string} | {kind: 'dm'; pubkey: string},
    text: string,
  ): Promise<void>;

  // ── Host reads ──
  applications(coordinate: string): ManagedApplication[];
  guests(coordinate: string): ManagedGuest[];
  waitlist(coordinate: string): Waitlister[];
  stats(coordinate: string): {interested: number; pending: number; going: number; waitlist: number};

  // ── Host actions ──
  approve(coordinate: string, pubkey: string): Promise<void>;
  decline(coordinate: string, pubkey: string): Promise<void>;
  undoDecision(coordinate: string, pubkey: string): Promise<void>;
  offerSpot(coordinate: string, npub: string): Promise<void>;
  messageAll(coordinate: string, message: string): Promise<number>;
  cancel(coordinate: string): Promise<void>;
  /** Publish (or republish for an edit); returns the coordinate. */
  publish(draft: EventDraft, opts?: {notifyGoing?: boolean}): Promise<string | null>;
  /** Republish every event I host — fired when the events management surface opens, so a doc that
   * silently never landed on the relay (the 2026-07-21 incident) self-heals without waiting for the
   * next relay reconnect. Fire-and-forget; internally throttled. */
  republishMine(): void;

  // ── Draft/live records (host-local source of truth) ──
  listEntries(): Promise<EventDraftEntry[]>;
  getEntry(id: string): Promise<EventDraftEntry | null>;
  saveEntry(entry: EventDraftEntry): Promise<void>;
  removeEntry(id: string): Promise<void>;
}
