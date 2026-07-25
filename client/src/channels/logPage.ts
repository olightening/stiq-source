/**
 * Log-page hearth resolution — turns the organizer's stiq:log-page doc into render-ready data.
 *
 * Mirrors featured.ts's philosophy: the organizer curates WHO/WHAT appears and every word of THEIR
 * copy (blurbs, roles, headers, the note), while each space's/person's NAME and gradient stay the
 * live, self-published identity — an organizer can't rewrite what someone else's space calls
 * itself. Pure functions (caches in, rows out) so everything here is trivially testable.
 *
 * Every default string below is transcribed verbatim from the design handoff's COPY.md — the
 * organizer's overrides replace them one-for-one from the dashboard.
 */
import type {Channel} from './channels';
import type {GroupState} from './groups';
import {
  type LogPageDoc,
  type LogPageWelcome,
  type LogPageCopyOverrides,
  type FeaturedSpace,
  type GuideDoc,
} from '../moderation/organizerConfig';
import {resolveFeatured, type FeaturedRow, type FeaturedKind} from './featured';
import type {GradientSpec} from '../media/gradient';
import {shortenNpub, safeNpubEncode} from '../util/npub';
import {relTime} from '../ui/relTime';
import {MAX_LOG_TEXT} from '../moderation/organizerConfig';

// ── Copy defaults (COPY.md, verbatim) ─────────────────────────────────────────

export interface LogPageCopy {
  picksHeader: string;
  peopleHeader: string;
  doorwayTitle: string;
  /** Template — `{n}` = action count, `{m}` = distinct moderator count. */
  doorwaySub: string;
  motto: string;
  rulesShowLabel: string;
  rulesHideLabel: string;
  tuckLabel: string;
  reopenLabel: string;
}

export const LOG_PAGE_COPY_DEFAULTS: LogPageCopy = {
  picksHeader: 'Picked by the organizers',
  peopleHeader: 'People worth knowing',
  doorwayTitle: 'Open the community log',
  doorwaySub: '{n} actions · {m} moderators · every one explained',
  motto: '✦ nothing here ever disappears quietly ✦',
  rulesShowLabel: 'Read the standing rules',
  rulesHideLabel: 'Hide the standing rules',
  tuckLabel: 'Tuck away',
  reopenLabel: 'reopen',
};

/** Overrides merged over the defaults — empty/absent fields keep the design copy. */
export function mergeLogPageCopy(overrides: LogPageCopyOverrides | undefined): LogPageCopy {
  const out = {...LOG_PAGE_COPY_DEFAULTS};
  if (!overrides) return out;
  for (const k of Object.keys(out) as (keyof LogPageCopy)[]) {
    const v = overrides[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/** Fill the doorway sub-line template with live counts. */
export function fillDoorwaySub(template: string, actions: number, mods: number): string {
  return template.replace(/\{n\}/g, String(actions)).replace(/\{m\}/g, String(mods));
}

// ── Resolved view model ───────────────────────────────────────────────────────

/** The owner-note card, fully resolved (identity from the organizer's live profile). */
export interface LogNoteData {
  /** The collapse key — see STATES §2. */
  version: string;
  title: string;
  subline: string;
  body: string;
  signature?: string;
  /** The organizer's crafted identity gradient, when known. */
  gradient?: GradientSpec | null;
  /** Gradient seed fallback (the organizer's pubkey). */
  seed: string;
}

export interface LogRulesData {
  body: string;
  eyebrow: string;
  /** Fully-resolved meta line ("Set by the organizers · updated 2d ago"). */
  meta: string;
  startExpanded: boolean;
}

/** One pick card: the featured-row identity plus the organizer's blurb + kind chip. */
export interface LogPickRow extends FeaturedRow {
  blurb?: string;
  chip: string;
  /** "48 members" when the count is known (groups); absent for blind channels. */
  membersLabel?: string;
  /** Live unread bubble (Point 2) — already floor-clamped + first-entry-nudged by the caller
   *  (AppRuntime.getLogPage → readState.spaceBadge). Absent/0 → no bubble. */
  unread?: number;
}

export interface LogPersonRow {
  pubkey: string;
  name: string;
  role?: string;
  gradient?: GradientSpec | null;
  seed: string;
}

export interface LogHearthData {
  note?: LogNoteData;
  rules?: LogRulesData;
  picks: LogPickRow[];
  people: LogPersonRow[];
  copy: LogPageCopy;
  showPeople: boolean;
  aurora: boolean;
}

// ── Chip derivation ───────────────────────────────────────────────────────────

/** Default kind-chip text per resolved space kind (the organizer may override per pick). */
const KIND_CHIP: Record<FeaturedKind, string> = {
  channel: 'Broadcast',
  open: 'Open',
  group: 'Group',
  'group-closed': 'Closed',
  'group-private': 'Private',
  'group-broadcast': 'Broadcast',
  user: 'Member',
};

// ── Legacy fallback ───────────────────────────────────────────────────────────

/**
 * Synthesize a log-page doc from the LEGACY organizer docs (stiq:guide + stiq:featured) so a
 * community whose organizer hasn't touched the new Log-page panel yet still renders a meaningful
 * hearth: the guide becomes the standing rules, featured channels/groups become picks (their
 * organizer labels become blurbs), featured users become people. No note — the card (and strip)
 * simply don't render until the organizer writes one.
 */
export function legacyLogPageDoc(
  guide: GuideDoc | undefined,
  featured: readonly FeaturedSpace[] | undefined,
): LogPageDoc {
  return {
    note: undefined,
    rules: guide?.content
      ? {body: guide.content, updatedAt: guide.updatedAt, startExpanded: false}
      : undefined,
    picks: (featured ?? [])
      .filter(f => f.type !== 'user')
      .map(f => ({
        ref: f.ref,
        type: f.type as 'channel' | 'group',
        blurb: f.label,
        name: f.name,
        gradient: f.gradient,
      })),
    people: (featured ?? [])
      .filter(f => f.type === 'user')
      .map(f => ({pubkey: f.ref, role: f.label, name: f.name})),
    copy: {},
    showPeople: true,
    aurora: true,
    updatedAt: guide?.updatedAt ?? 0,
  };
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface ResolveLogPageOpts {
  channels: readonly Channel[];
  groups: readonly GroupState[];
  /** Learned identity (display name + gradient) for a member pubkey. */
  userInfo?: (pubkey: string) => {name?: string; gradient?: GradientSpec | null} | undefined;
  /** The organizer's own identity — paints the note card's avatar + derived title/subline. */
  organizer?: {pubkey?: string; name?: string; gradient?: GradientSpec | null};
  /** Live member count for a space ref, when known (groups); undefined hides the members line. */
  memberCountOf?: (ref: string, type: 'channel' | 'group') => number | undefined;
  /** Live unread badge for a picked space (Point 2), already floor-clamped + first-entry-nudged. */
  unreadOf?: (ref: string, type: 'channel' | 'group') => number;
  /** The member's first-entry timestamp for THIS community (unix secs), 0 if untracked. Gates the
   *  welcome window (Point 6): the welcome shows while `now < firstEnteredAt + welcome.durSecs`. */
  firstEnteredAt?: number;
  nowMs: number;
}

/**
 * Resolve the organizer's doc against live metadata into the render-ready hearth. Preserves the
 * organizer's order; never throws on unknown refs (a pick degrades exactly as a featured row does).
 */
export function resolveLogPage(doc: LogPageDoc, opts: ResolveLogPageOpts): LogHearthData {
  const copy = mergeLogPageCopy(doc.copy);

  // The card shows the WELCOME inside its per-member window (Point 6), else the latest note. The
  // welcome is a fallback (no note yet) ONLY for a TRACKED entrant (firstEnteredAt > 0) — an
  // untracked/established member (a member who joined before this feature, or has no record) never
  // sees it. Because the welcome and note carry distinct versions, the welcome→letter hand-off
  // auto-reopens a tucked card (Point 3). Identity always comes from the organizer's live profile.
  const enteredAt = opts.firstEnteredAt ?? 0;
  const tracked = enteredAt > 0;
  const nowSec = Math.floor(opts.nowMs / 1000);
  const welcomeActive = tracked && !!doc.welcome && nowSec < enteredAt + doc.welcome.durSecs;
  const noteSource: LogPageWelcome | LogPageDoc['note'] = welcomeActive
    ? doc.welcome
    : doc.note ?? (tracked ? doc.welcome : undefined);

  let note: LogNoteData | undefined;
  if (noteSource) {
    const orgName = opts.organizer?.name?.trim();
    const orgNpub = opts.organizer?.pubkey ? safeNpubEncode(opts.organizer.pubkey) : '';
    // The derived strings interpolate a member-controlled display name — cap them like every
    // organizer-authored slot, so a hostile/overlong kind-0 name can't blow up the card layout.
    const derivedTitle = (
      welcomeActive
        ? orgName ? `A welcome from ${orgName}` : 'A welcome from the organizer'
        : orgName ? `A note from ${orgName}` : 'A note from the organizer'
    ).slice(0, MAX_LOG_TEXT);
    note = {
      version: noteSource.version,
      title: noteSource.title ?? derivedTitle,
      subline:
        noteSource.subline ??
        `started this community${orgNpub ? ` · ${shortenNpub(orgNpub, {lead: 12, tail: 4})}` : ''}`,
      body: noteSource.body,
      signature: noteSource.signature,
      // The dashboard's hand-picked gradient wins; the organizer's live profile identity is the
      // fallback — so the card is never gradient-less for an organizer who skipped the picker.
      gradient: noteSource.gradient ?? opts.organizer?.gradient ?? null,
      seed: opts.organizer?.pubkey ?? 'organizer',
    };
  }

  let rules: LogRulesData | undefined;
  if (doc.rules) {
    const at = doc.rules.updatedAt ?? doc.updatedAt;
    const rel = at ? relTime(at, 'log', opts.nowMs) : '';
    rules = {
      body: doc.rules.body,
      eyebrow: doc.rules.eyebrow ?? 'Standing rules',
      meta:
        doc.rules.meta ??
        `Set by the organizers${rel ? (rel === 'now' ? ' · updated just now' : ` · updated ${rel} ago`) : ''}`,
      startExpanded: doc.rules.startExpanded,
    };
  }

  // Picks ride the featured resolver so identity/shape/reachability rules stay in ONE place.
  const asFeatured: FeaturedSpace[] = doc.picks.map(p => ({
    ref: p.ref,
    type: p.type,
    name: p.name,
    gradient: p.gradient,
  }));
  const rows = resolveFeatured(asFeatured, opts.channels, opts.groups, opts.userInfo);
  // Join back by REF, not by index — refs are unique after the parser's dedup, and a ref join
  // can never misattribute one pick's blurb onto another space if resolveFeatured ever filters
  // or reorders internally.
  const cfgByRef = new Map(doc.picks.map(p => [p.ref, p]));
  const picks: LogPickRow[] = rows.map(row => {
    const cfg = cfgByRef.get(row.ref);
    const count = cfg ? opts.memberCountOf?.(row.ref, cfg.type) : undefined;
    const unread = cfg ? opts.unreadOf?.(row.ref, cfg.type) : undefined;
    return {
      ...row,
      blurb: cfg?.blurb,
      chip: cfg?.chip ?? KIND_CHIP[row.kind],
      membersLabel: count != null ? `${count} member${count === 1 ? '' : 's'}` : undefined,
      unread: unread && unread > 0 ? unread : undefined,
    };
  });

  const people: LogPersonRow[] = doc.people.map(p => {
    const info = opts.userInfo?.(p.pubkey);
    return {
      pubkey: p.pubkey,
      name: info?.name?.trim() || p.name || shortenNpub(safeNpubEncode(p.pubkey), {lead: 12, tail: 4}),
      role: p.role,
      gradient: info?.gradient ?? null,
      seed: p.pubkey,
    };
  });

  return {note, rules, picks, people, copy, showPeople: doc.showPeople, aurora: doc.aurora};
}
