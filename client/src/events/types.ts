/**
 * Events surface — FROZEN type contracts (Phase 0 of the one-shot events build).
 *
 * Every parallel build agent codes against THIS file; it is the anti-drift sheet for the whole
 * surface. Core types are transcribed from the design handoff's DATA-MODEL.md (§1–3) with the
 * production substitutions the handoff itself prescribes (every prototype CSS-gradient string
 * becomes a {@link GradientSpec} or its encoded wire string; every `npub…` a real key).
 *
 * RULES:
 *  - Pure types only (string-literal unions included). NO runtime code — screens are pure
 *    VM + callback components, so no agent needs the app runtime to typecheck.
 *  - Frozen during the parallel build phase: integration may EXTEND, never break.
 */
import type {GradientSpec} from '../media/gradient';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Core types (DATA-MODEL.md §1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A person identity — the guest/host. `grad` derives from npub when uncrafted. A string value
 * is the {@link GradientSpec} wire form (media/gradient encodeGradient), NEVER a CSS gradient. */
export interface Identity {
  name: string;
  npub: string;
  grad: GradientSpec | string;
}

export type EventType = 'inperson' | 'online' | 'hybrid' | 'ama';
export type EventStatus = 'upcoming' | 'full' | 'cancelled' | 'past';
export type RsvpState = null | 'interested' | 'applied' | 'approved' | 'waitlist';
export type CoverMode = 'gradient' | 'image' | 'none';
/** limited spots | running count, no cap */
export type CapacityMode = 'limit' | 'count';

/** The event itself. THIS OBJECT IS EMBEDDED INSIDE A POST — it is not a post. (README #1) */
export interface StiqEvent {
  /** Event id — the `d` tag of the addressable kind-31923 doc. */
  id: string;
  /** Organizer (or the sharer, when external). */
  host: Identity;
  /** Shared by a non-organizer; Stiq handles no RSVPs. */
  external: boolean;
  externalSource?: string;
  externalLink?: string;

  type: EventType;
  title: string;
  /** Optional; auto-hidden when empty. */
  description?: string;
  /** Single mono #tag; optional. */
  tag?: string;

  // when
  startsAt: string; // ISO datetime
  endsAt?: string; // ISO datetime
  tz: string; // e.g. "CET (UTC+1)"
  recurrence: 'none' | 'weekly' | 'monthly';

  // where (privacy-native — DATA-MODEL §2)
  location: EventLocation;

  // capacity (aggregate only — never a guest list on the read side)
  capacityMode: CapacityMode;
  capacity?: number; // when capacityMode === 'limit'
  waitlistEnabled: boolean;
  interestedCount: number; // aggregate
  attendingCount: number; // aggregate ("going")

  // access
  autoAdd?: AutoAddPolicy; // where approved guests are brought (shown publicly)

  // cover
  cover: EventCover;

  status: EventStatus;
}

export interface EventCover {
  mode: CoverMode;
  /** Gradient cover. A string value is the encodeGradient() wire form, never CSS. */
  gradient?: GradientSpec | string;
  /** Cover image reference — NOT fetched until the viewer taps "Load image" (privacy invariant 3).
   * Carries the app's inline-media picture token (`[[pic:…]]`), rendered via the existing
   * tap-to-load picture mechanic. */
  image?: string;
}

export interface AutoAddPolicy {
  target: 'group' | 'channel';
  groupName?: string; // when target='group'
  channel?: string; // when target='channel', e.g. "#relay-ops"
  /** Display label, e.g. "#backups-crew" — shown on the card. */
  label: string;
  /** Runtime extensions (host-side): the created private group's id / the chosen channel's id —
   * set on publish so approvals know where to add guests. Never shown; carried in the doc so a
   * reinstalling host can still approve. */
  groupId?: string;
  channelId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Privacy-native location (DATA-MODEL.md §2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Approximate area is public; exact detail is revealed only after the host approves you. */
export interface EventLocation {
  kind: 'physical' | 'link' | 'channel'; // by event type
  /** PUBLIC approximate area, e.g. "Neukölln, Berlin". */
  area?: string;
  approxRadiusKm?: number; // e.g. 1 ("~1 km radius")
  /** PRIVATE — only sent to approved guests (encrypted DM), NEVER in the public doc/embed. */
  exactAddress?: string;
  /** PRIVATE — "Rear courtyard, ring Stiq…". */
  entryNotes?: string;
  /** PRIVATE (online/hybrid) — revealed after approval. */
  streamLink?: string;
  /** (ama) — "#relay-ops". */
  channel?: string;
}

/** The post-approval private payload, delivered over the encrypted DM rail. */
export interface EventReveal {
  exactAddress?: string;
  entryNotes?: string;
  streamLink?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Application, attendee, draft (DATA-MODEL.md §3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A request to attend, reviewed by the host. Applying also marks the applicant interested. */
export interface Application {
  id: string;
  applicant: Identity;
  note?: string; // optional message to the host
  submittedAt: string; // ISO; shown relative ("2h")
  decision: null | 'approved' | 'declined'; // null = pending
}

/** An approved attendee — ORGANIZER-ONLY visibility (never rendered to guests). */
export interface Attendee {
  who: Identity;
  joinedAt: string;
}

export interface Waitlister {
  who: Identity;
  position: number;
}

/** The organizer's in-progress event (Create/Edit). Saved as a draft when incomplete.
 * `rawDate`/`rawTime` are editor round-trip extensions (beyond DATA-MODEL) so an incomplete
 * "2025-11-0" date survives a draft save/load without being coerced into a bogus ISO. */
export interface EventDraft extends Partial<StiqEvent> {
  isDraft: boolean; // true → lives in the Draft group of Your events (README #2)
  hidden: {
    // per-field hide flags (STATES §5 three-state: shown / hidden / empty·auto-hidden)
    desc?: boolean;
    loc?: boolean;
    tag?: boolean;
    cap?: boolean;
  };
  rawDate?: string; // editor text field, "YYYY-MM-DD" (possibly partial)
  rawTime?: string; // editor text field, "HH:MM" (possibly partial)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Addressing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Address of the kind-31923 event doc: host pubkey (hex) + `d` identifier. */
export interface EventAddr {
  pubkey: string;
  d: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// EventCard — the fixed DS component API (COMPONENTS §1 + reference JSX; visuals from DC/REDLINES)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EventCardProps {
  title: string; // '' → 'Untitled event'
  variant: 'Feed' | 'Compact';
  type: EventType;
  month: string; // '—' → TBD tile
  day: string; // '·'/'' → TBD tile
  dateLabel: string; // when-line date ("Sat, Nov 8" | "Add a date")
  timeLabel: string; // when-line time ("19:00 CET" | "Add a time")
  locationLabel?: string; // Feed only, hidden when empty
  hostName: string;
  hostGrad: GradientSpec | string; // string = encodeGradient wire form
  interestedCount: number;
  attendingCount: number | null; // null = not tracked/hidden
  capacity: number | null; // null = no cap
  countOnly: boolean; // emphasise running "N going", no cap
  tag?: string; // mono #tag, shown when non-empty
  recurring?: string; // 'Weekly'/'Monthly' → 🔁 chip; '' → none
  rsvp: RsvpState; // viewer's own RSVP → footer pill
  status: EventStatus; // full → waitlist pill; cancelled/past → dim
  external: boolean; // top banner; host line → "Shared by"
  coverMode: CoverMode; // Feed only
  coverGradient?: GradientSpec | string; // string = encodeGradient wire form
  coverImage?: string; // pic token; hidden behind "Load image" until tapped
  onPress?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ReminderUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export interface ReminderState {
  set: boolean;
  n: number; // digits-only, min 1; default 2
  unit: ReminderUnit; // default 'hours'
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Screen VMs + callbacks (screens are pure: render the VM, call the callbacks — no runtime)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Viewer's event detail screen (A3). Sheets (Apply/Share) are rendered by the screen but built
 * in EventSheets.tsx (A4) against the sheet props below. */
export interface EventDetailVM {
  event: StiqEvent; // public view — location carries only public fields here
  rsvp: RsvpState;
  /** Present only when rsvp==='waitlist' — "You're #4…". */
  waitlistPosition?: number;
  /** Present ONLY when rsvp==='approved' (privacy invariant 2). */
  reveal: EventReveal | null;
  reminder: ReminderState;
  /** ".ics added" display state (✓ Added — check your downloads). */
  calAdded: boolean;
  viewer: Identity;
  /** False when the organizer hid the attendee count — the Spots row is omitted entirely. */
  showSpots?: boolean;
}

export interface EventDetailCallbacks {
  onToggleInterested: () => void;
  /** Open the Apply sheet — the HOST renders the sheets (EventSheets.tsx) as siblings of the
   * screen, so the screen and the sheets build independently. */
  onApplyPress: () => void;
  /** Open the Share sheet (any viewer — README #3). */
  onSharePress: () => void;
  onApply: (note: string) => void; // ApplySheet send (also marks interested)
  onWithdraw: () => void;
  onJoinWaitlist: () => void;
  onLeaveWaitlist: () => void;
  onSetReminder: (n: number, unit: ReminderUnit) => void;
  /** Build + save the .ics; resolve true on success (flips calAdded upstream). */
  onAddToCalendar: () => Promise<boolean> | boolean;
  /** Bookmark this card into the saved-embeds list (insertable from every composer's 🔖 picker). */
  onAddToEmbeds: () => void;
  onForward: () => void; // host opens the forward picker
  onOpenSource?: () => void; // external events
  onOpenMap?: () => void; // approved, physical
  onCopyAddress?: () => void; // approved, physical
  onMessageHost?: () => void;
  onBack: () => void;
}

/** Apply-to-attend bottom sheet (A4). Note state is internal; handed up on send. */
export interface ApplySheetProps {
  visible: boolean;
  onClose: () => void;
  onSend: (note: string) => void;
  /** Host display name for the "…reviews each request" line (generic copy when absent). */
  hostName?: string;
  /** Auto-add target label ("#backups-crew") for the reveal hint (generic copy when absent). */
  autoAddLabel?: string;
}

/** Share bottom sheet (A4) — any viewer (README #3). Added-state is internal (inline ✓). */
export interface ShareSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Bookmark the card into the saved-embeds list (insertable from every composer's 🔖 picker). */
  onAddToEmbeds: () => void;
  onForward: () => void;
}

/** Create/Edit builder (A5). The editor owns ALL field state internally (DC state machine);
 * terminal actions hand the assembled draft up. */
export interface EventEditorProps {
  mode: 'create' | 'edit';
  initial: EventDraft;
  /** Channels the host runs — for the ama "hosted in" select + auto-add channel select. */
  channels: Array<{id: string; label: string}>;
  hostName: string;
  hostGrad: GradientSpec | string;
  /** Organizer picture limits — gates the cover-image "Choose an image" flow (PictureComposer). */
  pictureRules?: import('../feed/pictureRules').PictureRules;
  /** Picture bytes already spent this period (PictureComposer's allowance gate). */
  picturesSpentBytes?: number;
  /** Community voice toggle — gates the 🎙️ insert in the description editor. */
  allowVoice?: boolean;
  /** Organizer per-post-type size rules — the description meter reads the article ceiling. */
  postRules?: import('../feed/postRules').PostRules;
  /** Bookmarked posts offered by the description editor's 🔖 Embed picker. */
  savedPosts?: {id: string; title: string; snippet: string; name?: string; gradient?: GradientSpec | null}[];
  /** Saved self-contained embed tokens (event cards) offered by the same picker. */
  savedEmbedTokens?: {id: string; label: string; title: string; uri: string}[];
  onPublish: (draft: EventDraft) => void;
  onSaveDraft: (draft: EventDraft) => void;
  /** Bookmark the assembled card into the saved-embeds list (every composer's 🔖 picker). */
  onAddToEmbeds: (draft: EventDraft) => void;
  onBack: () => void;
}

/** Your events list (A6). */
export interface UpcomingRowVM {
  id: string;
  title: string;
  whenLine: string;
  newCount?: number; // "N new" badge
  cancelled?: boolean;
  /** Date tile fields (org-06 rows carry a real month/day tile; absent → 🗓️ fallback). */
  month?: string;
  day?: string;
  interestedCount?: number;
  attendingCount?: number | null;
  locationLabel?: string;
}
export interface DraftRowVM {
  id: string;
  title: string;
  subLine: string; // e.g. "Draft · no date set"
}
export interface PastRowVM {
  id: string;
  title: string;
  whenLine: string;
  month?: string;
  day?: string;
}
export interface YourEventsProps {
  upcoming: UpcomingRowVM[];
  drafts: DraftRowVM[];
  past: PastRowVM[];
  onNew: () => void;
  onOpenManage: (id: string) => void;
  onEditDraft: (id: string) => void;
  onBack: () => void;
}

/** Manage dashboard (A7). Application decisions are folded into `decision` upstream; Undo is
 * available on decided cards. */
export type ManagedApplication = Application & {timeLabel: string}; // "2h"
export type ManagedGuest = Attendee & {sinceLabel?: string};

export interface ManageVM {
  event: StiqEvent;
  whenLine: string; // "Sat, Nov 8 · 19:00 CET"
  stats: {interested: number; pending: number; going: number; waitlist: number};
  applications: ManagedApplication[];
  guests: ManagedGuest[]; // organizer-only (privacy invariant 1)
  guestsMore: number; // "and N more"
  waitlist: Waitlister[];
  cancelled: boolean;
  /** Recipient count for the message-everyone sheet ("Sent to N"). */
  messageRecipients: number;
}

export interface ManageCallbacks {
  onApprove: (appId: string) => void;
  onDecline: (appId: string) => void;
  onUndo: (appId: string) => void;
  onOfferSpot: (npub: string) => void;
  onEdit: () => void;
  /** Open the event's detail screen as a guest would see it ("Preview ↗"). */
  onPreview?: () => void;
  onMessageAll: (message: string) => void;
  /** Build + save the guest .csv; resolve true on success (inline ✓ in the row). */
  onExportCsv: () => Promise<boolean> | boolean;
  onCancelEvent: (message?: string) => void;
  onBack: () => void;
}
