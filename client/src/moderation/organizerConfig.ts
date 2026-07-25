/**
 * Organizer-signed moderation config (Phase A trust root).
 *
 * The organizer holds one Nostr key, baked into the community code as `organizerNpub`
 * (onboarding/community.ts). It publishes two NIP-78 app-data events (kind 30078),
 * addressable/replaceable by `d` tag:
 *   - d="stiq:moderators" → current moderator roster, one `p` tag per moderator pubkey.
 *   - d="stiq:limits"     → rate-limit policy (JSON content), mirrored by the relay.
 *
 * Clients honor these ONLY when signed by the organizer key, so granting/withdrawing a
 * moderator is just the organizer republishing the roster — no app rebuild. When no
 * organizer is configured (legacy v1 community), callers fall back to the build-time
 * MODERATOR_NPUBS list.
 */
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {REACTION_RETENTION, TIMELINE_RETENTION, type RetentionPolicy} from '../nostr/sqliteStore';
import {validateBridgeLine} from '../tor/torSettings';
import {MAX_SEEDED_BRIDGES} from '../onboarding/join';
import {parseSpaceEmbed, SPACE_EMBED_PREFIX} from '../channels/spaceEmbed';
import {decodeGradient, type GradientSpec} from '../media/gradient';

export const ORGANIZER_D_MODERATORS = 'stiq:moderators';
export const ORGANIZER_D_LIMITS = 'stiq:limits';

/** Per-window caps. 0 / undefined = unlimited. */
export interface WindowLimits {
  daily?: number;
  weekly?: number;
  monthly?: number;
}

/** Rate-limit policy (mirrors the relay's ratelimit config). */
export interface Limits {
  posts?: WindowLimits;
  comments?: WindowLimits;
  channel?: WindowLimits;
  /** Global (community-wide) cap on DM gift wraps per minute. Per-user DM caps are infeasible
   * because gift wraps are ephemeral-signed (sender hidden by design). */
  dmGlobalPerMin?: number;
  /** When true, moderators are exempt from the per-user caps. */
  exemptModerators?: boolean;
  /** When true, the community permits NIP-A0 voice messages (organizer-gated). Default false. */
  allowVoice?: boolean;
}

/** Decode an organizer npub to its hex pubkey, or undefined when absent/malformed. */
export function organizerHex(organizerNpub: string | undefined): string | undefined {
  if (!organizerNpub) return undefined;
  try {
    const decoded = nip19.decode(organizerNpub);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** The latest kind-30078 event with the given `d` tag signed by the organizer, or undefined. */
function latestConfig(store: EventStore, organizerHexPubkey: string, d: string): Event | undefined {
  let latest: Event | undefined;
  for (const ev of store.query({kinds: [Kind.AppData], authors: [organizerHexPubkey]})) {
    if (ev.tags.some(t => t[0] === 'd' && t[1] === d)) {
      if (!latest || ev.created_at > latest.created_at) latest = ev;
    }
  }
  return latest;
}

/**
 * Current moderator roster as npubs, from the organizer's latest stiq:moderators event.
 * Returns undefined when no organizer is configured or no roster has been published yet, so
 * the caller can fall back to the build-time list.
 */
export function currentModerators(
  store: EventStore,
  organizerNpub: string | undefined,
): readonly string[] | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_MODERATORS);
  if (!ev) return undefined;
  const npubs: string[] = [];
  for (const t of ev.tags) {
    if (t[0] === 'p' && t[1]) {
      try {
        npubs.push(nip19.npubEncode(t[1]));
      } catch {
        // skip malformed pubkey
      }
    }
  }
  return npubs;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? v : undefined;
}

function parseWindow(v: unknown): WindowLimits | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const w: WindowLimits = {daily: num(o.daily), weekly: num(o.weekly), monthly: num(o.monthly)};
  return w.daily || w.weekly || w.monthly ? w : undefined;
}

/**
 * Current rate-limit policy from the organizer's latest stiq:limits event, or undefined when
 * none is configured. Tolerant of partial / malformed JSON (returns what it can parse).
 */
export function currentLimits(
  store: EventStore,
  organizerNpub: string | undefined,
): Limits | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_LIMITS);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return {
    posts: parseWindow(raw.posts),
    comments: parseWindow(raw.comments),
    channel: parseWindow(raw.channel),
    dmGlobalPerMin: num(raw.dm_global_per_min),
    exemptModerators: raw.exempt_moderators === true,
    allowVoice: raw.allow_voice === true,
  };
}

// ── Client retention/compaction policy (T16 stiq:storage) ──────────────────────────────────────
// A low-storage phone's cache caps are governed from the dashboard, not baked in: the organizer
// publishes a kind-30078 doc (d="stiq:storage") with COMPACT wire keys, parsed here (structurally
// like currentLimits) and mapped onto the RetentionPolicy the per-community SqliteEventStore consumes.
// Every field is optional and forward-only: an absent field leaves the store's DEFAULT_RETENTION_POLICY
// value in force, and the whole doc is inert when the client's COMPACTION_V2 flag is off.

export const ORGANIZER_D_STORAGE = 'stiq:storage';

/**
 * Dashboard-facing retention policy (kind-30078 d="stiq:storage"). Wire keys are compact — the
 * organizer publishes `{rc:reactionCap, tc:timelineCap, ma:maxAgeDays, cr:collapseReplaceable}` — and
 * every field is optional: an absent field leaves the corresponding {@link RetentionPolicy} default in
 * place. `maxAgeDays` is in DAYS (converted to seconds by {@link toRetentionPolicy}).
 */
export interface StoragePolicy {
  /** Count cap for kind-7 reactions (wire `rc`). */
  reactionCap?: number;
  /** Count cap for every other prunable timeline kind (wire `tc`). */
  timelineCap?: number;
  /** Max age in DAYS beyond which non-exempt rows are age-expired (wire `ma`). */
  maxAgeDays?: number;
  /** Whether superseded replaceable/addressable versions may be collapsed (wire `cr`). */
  collapseReplaceable?: boolean;
}

/**
 * Current storage/retention policy from the organizer's latest stiq:storage doc, or undefined when no
 * organizer is configured or none is published. Structurally mirrors {@link currentLimits}: reads the
 * latest organizer-signed doc, parses its JSON content, and maps the compact wire keys through the
 * shared {@link num} guard (so a negative / NaN cap silently drops to undefined). Tolerant of malformed
 * JSON (returns undefined).
 */
export function currentStoragePolicy(
  store: EventStore,
  organizerNpub: string | undefined,
): StoragePolicy | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_STORAGE);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return {
    reactionCap: num(raw.rc),
    timelineCap: num(raw.tc),
    maxAgeDays: num(raw.ma),
    collapseReplaceable: raw.cr === true,
  };
}

/** Low-storage floor for either count cap — a policy can shrink caps but never below this. */
const MIN_RETENTION_CAP = 200;

/** Clamp `v` into [lo, hi]. */
function clampCap(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Map a {@link StoragePolicy} (dashboard-facing: days + compact optionals) onto the
 * {@link RetentionPolicy} shape the SqliteEventStore consumes (seconds + defaulted fields):
 *   - `maxAgeDays` → `maxAgeSeconds` (×86400), only for a POSITIVE bound (0/absent ⇒ no age bound);
 *   - `reactionCap`/`timelineCap` clamped to a low-storage floor ({@link MIN_RETENTION_CAP}) and capped
 *     at the DEFAULT ({@link REACTION_RETENTION}/{@link TIMELINE_RETENTION}), so a policy can only shrink
 *     — never grow — the historical caps;
 *   - `collapseReplaceable` passed through.
 * Returns a PARTIAL: only fields the policy actually specifies are present, so the store's constructor
 * / setRetentionPolicy merge leaves every unspecified cap at its DEFAULT_RETENTION_POLICY value. An
 * absent (undefined) policy yields `{}` — i.e. pure defaults. Importable by App.tsx (cold-boot caps)
 * and AppRuntime (live setRetentionPolicy update) and unit-tested in isolation.
 */
export function toRetentionPolicy(p: StoragePolicy | undefined): Partial<RetentionPolicy> {
  const out: Partial<RetentionPolicy> = {};
  if (!p) return out;
  if (p.reactionCap != null) {
    out.reactionCap = clampCap(p.reactionCap, MIN_RETENTION_CAP, REACTION_RETENTION);
  }
  if (p.timelineCap != null) {
    out.timelineCap = clampCap(p.timelineCap, MIN_RETENTION_CAP, TIMELINE_RETENTION);
  }
  if (p.maxAgeDays != null && p.maxAgeDays > 0) {
    out.maxAgeSeconds = Math.floor(p.maxAgeDays * 86400);
  }
  if (p.collapseReplaceable != null) {
    out.collapseReplaceable = p.collapseReplaceable;
  }
  return out;
}

// ── Community-seeded transport bridges (T14 stiq:bridges) ───────────────────────────────────────
// The organizer can OPTIONALLY seed obfs4/webtunnel bridge lines onto the community so the WebTunnel
// tier — which ships zero bundled bridges — can still bootstrap on a network where the Tor moat is
// blocked. Delivered over the same organizer-signed kind-30078 rail as the other stiq: configs (new
// d="stiq:bridges", compact wire `{b:[lines]}`) and parsed here structurally like currentStoragePolicy.
// Whole doc is inert when the client's COMMUNITY_SEEDED_BRIDGES flag is off.

export const ORGANIZER_D_BRIDGES = 'stiq:bridges';

/**
 * Current community-seeded bridge lines from the organizer's latest stiq:bridges doc, or undefined when
 * no organizer is configured / none is published. Structurally mirrors {@link currentStoragePolicy}:
 * reads the latest organizer-signed doc and JSON-parses its `{b:[lines]}` content, then runs the SAME
 * per-line guard the join-code parser and community store use ({@link validateBridgeLine} → obfs4 /
 * webtunnel ONLY), dedupes, and caps at {@link MAX_SEEDED_BRIDGES}. Returns undefined (never `[]`) when
 * nothing survives, so the field stays absent-stays-absent through communityStore.upsert's merge.
 * Tolerant of malformed JSON (returns undefined).
 */
export function currentSeededBridges(
  store: EventStore,
  organizerNpub: string | undefined,
): string[] | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_BRIDGES);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw.b)) return undefined;
  const out: string[] = [];
  for (const line of raw.b) {
    if (typeof line !== 'string') continue;
    const trimmed = line.trim();
    const kind = validateBridgeLine(trimmed);
    if ((kind === 'obfs4' || kind === 'webtunnel') && !out.includes(trimmed)) {
      out.push(trimmed);
    }
    if (out.length >= MAX_SEEDED_BRIDGES) break;
  }
  return out.length > 0 ? out : undefined;
}

// ── Per-mod permissions, mod-action limits, governance, community config ────────
// Additional organizer kind-30078 docs, read on-demand (like limits). The dashboard publishes
// them; the relay hard-enforces gov + mod-limits; the client uses them for UX (gating mod
// buttons, pre-empting "limit reached", the announcement banner, etc.).

export const ORGANIZER_D_PERMISSIONS = 'stiq:permissions';
export const ORGANIZER_D_MOD_LIMITS = 'stiq:mod-limits';
export const ORGANIZER_D_GOV = 'stiq:gov';
export const ORGANIZER_D_COMMUNITY = 'stiq:community';

/** Granular per-moderator action scopes. */
export type ModScope =
  | 'hide-post'
  | 'hide-comment'
  | 'ban'
  | 'retag'
  | 'pin'
  | 'lock'
  | 'restore';
export const ALL_MOD_SCOPES: readonly ModScope[] = [
  'hide-post', 'hide-comment', 'ban', 'retag', 'pin', 'lock', 'restore',
];
export interface Permissions {
  /** Scopes granted to any moderator not explicitly listed. */
  default: ModScope[];
  /** Per-moderator (hex pubkey) scope overrides. */
  mods: Record<string, ModScope[]>;
}

function parseScopes(v: unknown): ModScope[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is ModScope => (ALL_MOD_SCOPES as readonly string[]).includes(s));
}

/** The organizer's per-mod permission doc, or undefined when none is published. */
export function currentPermissions(
  store: EventStore,
  organizerNpub: string | undefined,
): Permissions | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_PERMISSIONS);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const modsRaw = (raw.mods && typeof raw.mods === 'object' ? raw.mods : {}) as Record<string, unknown>;
  const mods: Record<string, ModScope[]> = {};
  for (const [k, v] of Object.entries(modsRaw)) mods[k] = parseScopes(v);
  return {default: parseScopes(raw.def), mods};
}

/**
 * Scopes a moderator currently holds. When no permission doc is published, a moderator holds ALL
 * scopes (backward-compatible with the flat roster). The organizer always holds everything.
 */
export function scopesFor(pubkeyHex: string, perms: Permissions | undefined): readonly ModScope[] {
  if (!perms) return ALL_MOD_SCOPES;
  return perms.mods[pubkeyHex] ?? perms.default;
}

/** Per-action moderator rate caps (daily/weekly). 0 / absent = unlimited. */
export type ModActionLimits = Record<string, {daily?: number; weekly?: number}>;

export function currentModLimits(
  store: EventStore,
  organizerNpub: string | undefined,
): ModActionLimits | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_MOD_LIMITS);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const out: ModActionLimits = {};
  for (const [action, w] of Object.entries(raw)) {
    if (w && typeof w === 'object') {
      const o = w as Record<string, unknown>;
      out[action] = {daily: num(o.d), weekly: num(o.w)};
    }
  }
  return out;
}

/** Governance knobs the relay also enforces (newcomer window + channel-create rule). */
export interface Governance {
  newcomerDays: number;
  newcomerNoLinks: boolean;
  newcomerNoChannels: boolean;
  channelCreate: 'any' | 'mods' | 'org';
}

export function currentGovernance(
  store: EventStore,
  organizerNpub: string | undefined,
): Governance | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_GOV);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const cc = raw.cc === 'mods' || raw.cc === 'org' ? raw.cc : 'any';
  return {
    newcomerDays: num(raw.ncd) ?? 0,
    newcomerNoLinks: raw.nl === true,
    newcomerNoChannels: raw.nc === true,
    channelCreate: cc,
  };
}

/**
 * Floor for a REAL announcement-expiry timestamp (≈ 2001-09-09 in unix seconds). Any `ann.u` below
 * this is not a deadline the organizer meant — it is a mis-entry (0 = "never", or a value like "3"
 * typed into the dashboard's raw-seconds field) — so it is ignored rather than hiding the banner as
 * though it expired in 1970. A genuine expiry an organizer sets is always far above this.
 */
export const MIN_ANNOUNCEMENT_EPOCH = 1_000_000_000;

/** Community identity + app defaults + the mod-log announcement banner. */
export interface CommunityConfig {
  name?: string;
  description?: string;
  icon?: string;
  accent?: string;
  defaultView?: 'list' | 'topics' | 'conversation';
  editWindowSec?: number;
  allowEdit?: boolean;
  allowDelete?: boolean;
  announcement?: {text: string; until?: number};
}

export function currentCommunityConfig(
  store: EventStore,
  organizerNpub: string | undefined,
): CommunityConfig | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_COMMUNITY);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const dv = raw.dv === 'topics' || raw.dv === 'conversation' || raw.dv === 'list' ? raw.dv : undefined;
  const annRaw = raw.ann && typeof raw.ann === 'object' ? (raw.ann as Record<string, unknown>) : undefined;
  const annText = annRaw ? str(annRaw.t) : undefined;
  // `until` is an OPTIONAL auto-expiry in unix SECONDS. Only a plausible real timestamp counts as a
  // deadline: 0 means "never", and a tiny value — an organizer typing "3" into the dashboard's raw
  // seconds field — is a mis-entry, a 1970 date that would silently bury the banner forever. Anything
  // below MIN_ANNOUNCEMENT_EPOCH is treated as "no expiry", so the banner shows until it is cleared.
  const annUntil = annRaw ? num(annRaw.u) : undefined;
  const until = annUntil !== undefined && annUntil >= MIN_ANNOUNCEMENT_EPOCH ? annUntil : undefined;
  return {
    name: str(raw.nm),
    description: str(raw.desc),
    icon: str(raw.icn),
    accent: str(raw.acc),
    defaultView: dv,
    editWindowSec: num(raw.ew),
    allowEdit: raw.ae === true,
    allowDelete: raw.ad === true,
    announcement: annText ? {text: annText, until} : undefined,
  };
}

// ── Community guide (d="stiq:guide") ─────────────────────────────────────────

/**
 * The welcome / rules page shown at the top of the Log tab.
 *
 * It is ORGANIZER config (kind-30078), NOT a member long-form article. It used to be a kind-30023,
 * but a blind community (blind_required) rejects any tokenless content kind — including kind-30023 —
 * from every author, organizers included, so an organizer-signed guide could never be published.
 * Riding the same privileged config path as the announcement banner fixes that, and has two happy
 * side effects: the guide is organizer-signed (a moderator can no longer overwrite the rules by
 * publishing a newer article), and it never leaks onto the feed as a stray article.
 */
export const ORGANIZER_D_GUIDE = 'stiq:guide';

/** Longest guide title the client will surface (a heading, not a paragraph). */
export const MAX_GUIDE_TITLE = 120;

export interface GuideDoc {
  title: string;
  content: string;
  /** When the organizer last republished it (the signing event's created_at). */
  updatedAt?: number;
}

/**
 * The organizer's current community guide, or undefined when none is published. An empty body is
 * treated as absent (the organizer's "cleared" state) so the screen hides the section rather than
 * rendering an empty card.
 */
export function currentGuide(
  store: EventStore,
  organizerNpub: string | undefined,
): GuideDoc | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_GUIDE);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!content) return undefined;
  const title =
    typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, MAX_GUIDE_TITLE)
      : 'Community Guide';
  return {title, content, updatedAt: ev.created_at};
}

// ── Featured spaces (d="stiq:featured") ──────────────────────────────────────

export const ORGANIZER_D_FEATURED = 'stiq:featured';

/** Hard cap on how many spaces the organizer may feature — the rail is a shortcut, not a directory. */
export const MAX_FEATURED_SPACES = 12;
/** Hard cap on the organizer's label text (a chip, not a sentence). */
export const MAX_FEATURED_LABEL = 24;

/**
 * One organizer-curated entry in the Log tab's featured rail.
 *
 * `ref` identifies the entry and `type` says how to read it, because the three families are
 * addressed differently and are NOT interchangeable:
 *   - channel: a NIP-53 addressable coordinate `30311:<owner>:<d>` (channels.ts `Channel.id`).
 *   - group:   a NIP-29 group id (the `h` tag / `GroupState.id`).
 *   - user:    a member's hex pubkey — a featured person, opened as their profile.
 *
 * A channel/group entry may be curated as a `stiq:space:…` SHARE LINK (spaceEmbed.ts) rather than a
 * bare coordinate — that link is the only channel reference a member can actually COPY inside the
 * app, so it is what an organizer naturally pastes. We decode it here to the native coordinate (which
 * equals `Channel.id`) and adopt the name + gradient it carries, exactly as a space-embed card does.
 * That is what lets a featured channel render + open natively even before its 30311 has synced.
 *
 * `name`/`gradient` are FALLBACKS only. The rail renders the live, self-published identity whenever it
 * is known — a channel's owner-set title/gradient, a group's metadata, or a user's learned name — so
 * the organizer curates WHO/WHAT appears and what label rides along, never what a space calls itself.
 * The fallback carries the offline identity for a space whose live metadata hasn't arrived: NIP-29
 * groups are off-firehose (a non-member has no 39000), a channel's 30311 may not be in the newest-N
 * firehose window yet, and a user's display name may not have been learned — all would otherwise
 * render a nameless, gradient-less row.
 */
export interface FeaturedSpace {
  ref: string;
  type: 'channel' | 'group' | 'user';
  /** Organizer-controlled chip shown beside the name ("Start here", "Read only"). Empty = none. */
  label?: string;
  /** Snapshot of the name at curation time (or carried by a share link) — used when live metadata is absent. */
  name?: string;
  /** Snapshot gradient carried by a `stiq:space:` share link — used when live metadata is absent. */
  gradient?: GradientSpec | null;
}

// ── Log page (d="stiq:log-page") ─────────────────────────────────────────────
//
// The hearth — the organizer-authored front room of the Log tab (design_handoff_log). ONE doc
// carries everything the organizer controls on that surface: the owner's note (with an explicit
// VERSION that keys the member's tuck-away dismissal), the standing rules, the picked channels
// (with per-pick blurbs), the featured people (with roles), and every piece of hearth copy
// (section headers, doorway text, motto, control labels). The moderation log itself — the
// append-only record behind the doorway — is deliberately NOT here: its entries come from the
// live moderation-event stream and are never organizer-editable.
//
// Wire format (compact keys, organizer-signed kind-30078):
//   {
//     "note":  {"ver","t","s","b","sig","g"},      // version, title, subline, body, signature, gradient
//     "rules": {"b","e","m","at","x"},             // body, eyebrow, meta override, updated-at, startExpanded
//     "picks": [{"a","t","bl","c","n","g"}],       // ref, type, blurb, chip override, name/gradient snapshot
//     "people":[{"p","r","n"}],                    // hex pubkey, role, name snapshot
//     "copy":  {"ph","pph","dt","ds","mo","rs","rh","tk","ro"},
//     "sp": true, "au": true                       // showPeople, aurora
//   }

export const ORGANIZER_D_LOG_PAGE = 'stiq:log-page';

/** Hard caps — the hearth is a curated front room, not a directory or a long-form surface. */
export const MAX_LOG_PICKS = 8;
export const MAX_LOG_PEOPLE = 12;
export const MAX_LOG_NOTE_BODY = 2000;
export const MAX_LOG_WELCOME_BODY = 2000;
export const MAX_LOG_RULES_BODY = 8000;
export const MAX_LOG_BLURB = 140;
export const MAX_LOG_ROLE = 40;
/** Short single-line strings: titles, sublines, headers, chips, motto, control labels. */
export const MAX_LOG_TEXT = 160;

/** The owner's note. `version` is the collapse key (STATES §2): a member's "Tuck away" stores it,
 * and ONLY a different version auto-reopens the card — so the dashboard bumps it when the note
 * text changes, never on unrelated log-page edits. */
export interface LogPageNote {
  version: string;
  /** Card title ("A note from Mara"). Absent → derived from the organizer's display name. */
  title?: string;
  /** Sub-line under the title. Absent → derived ("started this community · npub…"). */
  subline?: string;
  body: string;
  /** Serif sign-off ("— Mara ✦"). Absent → no signature line. */
  signature?: string;
  /** The organizer's HAND-PICKED avatar gradient for the note card. Absent → their live
   *  profile-identity gradient (a cosmetic slot: changing it never bumps the version). */
  gradient?: GradientSpec | null;
}

/** The organizer's welcome message — shown to a member for `durSecs` from THEIR first entry, then
 * replaced by the latest note (Point 6). Same shape as the note; its own `version` (a `w`-prefixed
 * hash, distinct from any note version) keys the tuck-away contract so the welcome→letter hand-off
 * auto-reopens a tucked card (Point 3). */
export interface LogPageWelcome {
  version: string;
  title?: string;
  subline?: string;
  body: string;
  signature?: string;
  gradient?: GradientSpec | null;
  /** How long the welcome lasts from the member's first entry, in seconds. */
  durSecs: number;
}

/** The standing rules tucked inside the note card. */
export interface LogPageRules {
  body: string;
  /** Uppercase eyebrow. Absent → "Standing rules". */
  eyebrow?: string;
  /** Full meta-line override. Absent → derived "Set by the organizers · updated Xd ago". */
  meta?: string;
  /** When the RULES text last changed (unix seconds) — drives the derived meta line. */
  updatedAt?: number;
  startExpanded: boolean;
}

/** One organizer-picked channel/group card. Ref semantics match {@link FeaturedSpace}. */
export interface LogPagePick {
  ref: string;
  type: 'channel' | 'group';
  /** The organizer's one-line quoted blurb (italic, in their voice). */
  blurb?: string;
  /** Kind-chip override ("Broadcast"/"Open"/…). Absent → derived from the space's live kind. */
  chip?: string;
  /** Snapshot name / gradient for a space whose live metadata hasn't arrived (same as featured). */
  name?: string;
  gradient?: GradientSpec | null;
}

/** One person on the "people worth knowing" rail. */
export interface LogPagePerson {
  pubkey: string;
  /** The organizer's two-or-three-word role line ("keeps the peace"). */
  role?: string;
  /** Snapshot display name for a member whose identity hasn't been learned yet. */
  name?: string;
}

/** Every organizer-editable hearth copy slot. All optional — absent falls back to the design
 * defaults (channels/logPage.ts LOG_PAGE_COPY_DEFAULTS). */
export interface LogPageCopyOverrides {
  picksHeader?: string;
  peopleHeader?: string;
  doorwayTitle?: string;
  /** Doorway sub-line template — `{n}` = action count, `{m}` = distinct moderators. */
  doorwaySub?: string;
  motto?: string;
  rulesShowLabel?: string;
  rulesHideLabel?: string;
  tuckLabel?: string;
  reopenLabel?: string;
}

export interface LogPageDoc {
  note?: LogPageNote;
  welcome?: LogPageWelcome;
  rules?: LogPageRules;
  picks: LogPagePick[];
  people: LogPagePerson[];
  copy: LogPageCopyOverrides;
  showPeople: boolean;
  aurora: boolean;
  /** The signing event's created_at — fallback for the rules meta line. */
  updatedAt: number;
}

/** Trimmed single-line string capped at `max`, or undefined when absent/empty. */
function shortText(v: unknown, max: number = MAX_LOG_TEXT): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Stable fallback note version — a tiny content hash, so the tuck-away contract still works for
 * a hand-published doc that omitted `ver` (djb2, hex). */
function noteVersionOf(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) >>> 0;
  return `n${h.toString(16)}`;
}

/** Welcome collapse-key hash — `w`-prefixed so it can never collide with a note version (`n`),
 * which is what makes the welcome→letter hand-off auto-reopen a tucked card (Point 3). */
function welcomeVersionOf(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) >>> 0;
  return `w${h.toString(16)}`;
}

/**
 * The organizer's current log-page doc, or undefined when none is published (callers then fall
 * back to the legacy guide + featured docs — see channels/logPage.ts legacyLogPageDoc). Tolerant
 * of malformed JSON and partial content: every section is optional, unparseable entries are
 * dropped, and order (picks/people) is the organizer's wire order.
 */
export function currentLogPage(
  store: EventStore,
  organizerNpub: string | undefined,
): LogPageDoc | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_LOG_PAGE);
  if (!ev) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  // Note — hidden entirely (card AND strip) when there's no body.
  let note: LogPageNote | undefined;
  const noteRaw = raw.note && typeof raw.note === 'object' ? (raw.note as Record<string, unknown>) : undefined;
  const noteBody = typeof noteRaw?.b === 'string' ? noteRaw.b.trim().slice(0, MAX_LOG_NOTE_BODY) : '';
  if (noteBody) {
    const signature = shortText(noteRaw?.sig, 80);
    // The dashboard bumps `ver` only when the note text changes — but that guarantee lives in ONE
    // dashboard's local state. Fold a content hash into the effective version so a changed note can
    // NEVER carry a stale version (a hand-published doc, a second dashboard instance with its own
    // saved state), while an unchanged note keeps a stable version across unrelated republishes.
    // `ver` still lets an organizer deliberately re-surface an identical note.
    const wireVer = shortText(noteRaw?.ver, 64);
    const contentVer = noteVersionOf(`${noteBody}\u0000${signature ?? ''}`);
    note = {
      version: wireVer ? `${wireVer}~${contentVer}` : contentVer,
      title: shortText(noteRaw?.t),
      subline: shortText(noteRaw?.s),
      body: noteBody,
      signature,
      gradient: typeof noteRaw?.g === 'string' && noteRaw.g ? decodeGradient(noteRaw.g) : undefined,
    };
  }

  // Welcome — same shape as the note plus a duration; hidden entirely when there's no body. Its
  // effective version folds a `w`-prefixed content hash (as the note does with `n`), so it can never
  // collide with a note version and the welcome→letter hand-off always auto-reopens a tucked card.
  let welcome: LogPageWelcome | undefined;
  const welRaw = raw.welcome && typeof raw.welcome === 'object' ? (raw.welcome as Record<string, unknown>) : undefined;
  const welBody = typeof welRaw?.b === 'string' ? welRaw.b.trim().slice(0, MAX_LOG_WELCOME_BODY) : '';
  if (welBody) {
    const welSig = shortText(welRaw?.sig, 80);
    const welWireVer = shortText(welRaw?.ver, 64);
    const welContentVer = welcomeVersionOf(`${welBody} ${welSig ?? ''}`);
    const durRaw = num(welRaw?.dur);
    welcome = {
      version: welWireVer ? `${welWireVer}~${welContentVer}` : welContentVer,
      title: shortText(welRaw?.t),
      subline: shortText(welRaw?.s),
      body: welBody,
      signature: welSig,
      gradient: typeof welRaw?.g === 'string' && welRaw.g ? decodeGradient(welRaw.g) : undefined,
      durSecs: durRaw && durRaw > 0 ? durRaw : 0,
    };
  }

  // Rules — omitted when there's no body (the toggle row hides with it).
  let rules: LogPageRules | undefined;
  const rulesRaw = raw.rules && typeof raw.rules === 'object' ? (raw.rules as Record<string, unknown>) : undefined;
  const rulesBody = typeof rulesRaw?.b === 'string' ? rulesRaw.b.trim().slice(0, MAX_LOG_RULES_BODY) : '';
  if (rulesBody) {
    rules = {
      body: rulesBody,
      eyebrow: shortText(rulesRaw?.e),
      meta: shortText(rulesRaw?.m),
      updatedAt: num(rulesRaw?.at),
      startExpanded: rulesRaw?.x === true,
    };
  }

  // Picks — channel/group refs, validated exactly like the featured rail (stiq:space: links
  // decode to native coordinates; unroutable entries drop; dedup on the resolved ref).
  const picks: LogPagePick[] = [];
  const seenPicks = new Set<string>();
  if (Array.isArray(raw.picks)) {
    for (const it of raw.picks) {
      if (!it || typeof it !== 'object') continue;
      const {a, t, bl, c, n, g} = it as Record<string, unknown>;
      if (typeof a !== 'string' || !a) continue;
      let ref = a;
      let type: LogPagePick['type'];
      let name = shortText(n);
      let gradient: GradientSpec | null | undefined = typeof g === 'string' && g ? decodeGradient(g) : undefined;
      if (a.startsWith(SPACE_EMBED_PREFIX)) {
        const sp = parseSpaceEmbed(a);
        if (!sp) continue;
        ref = sp.coordinate;
        type = sp.kind === 30311 ? 'channel' : 'group';
        if (sp.name) name = sp.name;
        if (sp.gradient) gradient = sp.gradient;
      } else if (t === 'channel' || t === 'group') {
        type = t;
      } else {
        continue;
      }
      if (seenPicks.has(ref)) continue;
      seenPicks.add(ref);
      picks.push({
        ref,
        type,
        blurb: shortText(bl, MAX_LOG_BLURB),
        chip: shortText(c, 24),
        name,
        gradient: gradient ?? undefined,
      });
      if (picks.length >= MAX_LOG_PICKS) break;
    }
  }

  // People — hex pubkeys only (a malformed ref would dead-end the profile route).
  const people: LogPagePerson[] = [];
  const seenPeople = new Set<string>();
  if (Array.isArray(raw.people)) {
    for (const it of raw.people) {
      if (!it || typeof it !== 'object') continue;
      const {p, r, n} = it as Record<string, unknown>;
      if (typeof p !== 'string' || !/^[0-9a-f]{64}$/.test(p) || seenPeople.has(p)) continue;
      seenPeople.add(p);
      people.push({pubkey: p, role: shortText(r, MAX_LOG_ROLE), name: shortText(n)});
      if (people.length >= MAX_LOG_PEOPLE) break;
    }
  }

  const copyRaw = raw.copy && typeof raw.copy === 'object' ? (raw.copy as Record<string, unknown>) : {};
  const copy: LogPageCopyOverrides = {
    picksHeader: shortText(copyRaw.ph),
    peopleHeader: shortText(copyRaw.pph),
    doorwayTitle: shortText(copyRaw.dt),
    doorwaySub: shortText(copyRaw.ds),
    motto: shortText(copyRaw.mo),
    rulesShowLabel: shortText(copyRaw.rs),
    rulesHideLabel: shortText(copyRaw.rh),
    tuckLabel: shortText(copyRaw.tk),
    reopenLabel: shortText(copyRaw.ro),
  };

  return {
    note,
    welcome,
    rules,
    picks,
    people,
    copy,
    showPeople: raw.sp !== false,
    aurora: raw.au !== false,
    updatedAt: ev.created_at,
  };
}

/**
 * The organizer's ordered featured-space list. ORDER IS THE ORGANIZER'S — it is the wire order,
 * never re-sorted here, because the whole point of the feature is that the organizer ranks them.
 *
 * Returns undefined when no organizer is configured or nothing has been published; an empty array
 * is a real, meaningful value (the organizer cleared the rail) and is preserved as such.
 */
export function currentFeaturedSpaces(
  store: EventStore,
  organizerNpub: string | undefined,
): readonly FeaturedSpace[] | undefined {
  const hex = organizerHex(organizerNpub);
  if (!hex) return undefined;
  const ev = latestConfig(store, hex, ORGANIZER_D_FEATURED);
  if (!ev) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(ev.content);
  } catch {
    return undefined;
  }
  const items = (raw as {items?: unknown})?.items;
  if (!Array.isArray(items)) return undefined;
  const seen = new Set<string>();
  const out: FeaturedSpace[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const {a, t, l, n, g} = it as Record<string, unknown>;
    // A ref must be a non-empty string; below we resolve it (a `stiq:space:` link decodes to a
    // coordinate) and settle its type. An entry we can't route is dropped rather than rendered as a
    // dead row.
    if (typeof a !== 'string' || !a) continue;

    let ref = a;
    let type: FeaturedSpace['type'];
    // Fallback identity: the snapshot name and (optionally) a gradient the wire carried directly.
    let name = typeof n === 'string' && n ? n : undefined;
    let gradient: GradientSpec | null | undefined =
      typeof g === 'string' && g ? decodeGradient(g) : undefined;

    if (a.startsWith(SPACE_EMBED_PREFIX)) {
      // Curated as the app's own share link — decode it to the native coordinate (== Channel.id) and
      // adopt the name/gradient it carries, so it matches a real channel/group and still renders
      // offline. The link's kind is authoritative for the type; a malformed link is unroutable → drop.
      const sp = parseSpaceEmbed(a);
      if (!sp) continue;
      ref = sp.coordinate;
      type = sp.kind === 30311 ? 'channel' : 'group';
      if (sp.name) name = sp.name;
      if (sp.gradient) gradient = sp.gradient;
    } else if (t === 'channel' || t === 'group' || t === 'user') {
      // Bare coordinate / group id / hex pubkey. A user ref must be a 64-char hex pubkey (the profile
      // route decodes it); a malformed one would dead-end, so it is dropped.
      if (t === 'user' && !/^[0-9a-f]{64}$/.test(a)) continue;
      type = t;
    } else {
      continue;
    }

    // Dedup on the RESOLVED ref (the coordinate), so the same channel curated once as a link and once
    // as a coordinate can't appear twice.
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      ref,
      type,
      label: typeof l === 'string' && l ? l.slice(0, MAX_FEATURED_LABEL) : undefined,
      name,
      gradient: gradient ?? undefined,
    });
    if (out.length >= MAX_FEATURED_SPACES) break;
  }
  return out;
}
