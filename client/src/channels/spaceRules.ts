/**
 * Unified per-space settings — the standardized admin/owner controls shared by NIP-53 channels and
 * NIP-29 groups. Standardization happens HERE, at the client model, without merging the two protocol
 * architectures (channels stay 30311/1311, groups stay 9/11/12/39xxx).
 *
 * WHY a separate admin-signed doc. The two space types have different native carriers:
 *   - CHANNEL (NIP-53): the owner-signed 30311 already carries name/about/picture/gradient/reactions/
 *     pinned/admins and rides the firehose — self-describing.
 *   - GROUP  (NIP-29): the relay regenerates 39000 from a 9002 edit but `applyMetadataTags` echoes
 *     ONLY name/about/picture/gradient/access flags (relay/internal/groups/groups.go). It DROPS
 *     `reactions`/`pinned` and knows nothing about content rules — the relay is content-blind by design.
 * So the standardized *extended* settings — the content RULE SET (both types) plus, for groups, the
 * reaction set and pinned message — ride an admin-signed addressable kind-30078 doc:
 *
 *     d = "space-settings:<spaceId>"
 *
 * The `stiq:` prefix is deliberately AVOIDED: the relay reserves `stiq:`-prefixed kind-30078 to the
 * organizer key (relay/internal/policy/organizer.go — `stiqConfigPrefix`), which is exactly why the
 * old per-post interaction doc (`d="stiq:interactions:…"`) is rejected for non-organizers. A space
 * admin is an ordinary bound member and may publish freely under a non-reserved `d`.
 *
 * Enforcement of these rules is CLIENT-SIDE (see moderation/spaceAutoModeration.ts): a message that
 * breaks a rule is auto-removed on every device and logged to the space's mod log; a space admin may
 * restore it. The relay is never asked to enforce content rules — it stays blind.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';
import type {TypeRule} from '../feed/postRules';

/** The kind-30078 doc that carries a space's settings, keyed by a non-reserved `d`. */
export const KIND_SPACE_SETTINGS = Kind.AppData; // 30078
export const SPACE_SETTINGS_D_PREFIX = 'space-settings:';

/** Addressable `d` for a space's settings doc. Never `stiq:`-prefixed (organizer-reserved). */
export function spaceSettingsDTag(spaceId: string): string {
  return `${SPACE_SETTINGS_D_PREFIX}${spaceId}`;
}

/**
 * SUGGESTION-ONLY emoji palette: the seed list offered by the reaction-CONFIGURATION UI — the
 * groups/DMs ⋯ any-emoji picker (`ReactionBar`), where it's a shortcut row a member picks FROM, not a
 * set anyone imposed on the space.
 *
 * It is deliberately NOT a live default for a space's one-tap chips. A space that never configured a
 * reaction set briefly (2026-07-22) fell back to this list, so every fresh channel shipped seven
 * emojis its owner never chose; owner directive is that an unconfigured space shows NO reaction chips
 * at all. See {@link resolveReactionPalette} — do not reintroduce a fallback here.
 */
export const DEFAULT_SPACE_REACTIONS: readonly string[] = ['👍', '❤️', '🔥', '😂', '🙏', '🎉', '👀'];

/** The SAME array reference every time {@link resolveReactionPalette} resolves "nothing configured" —
 *  a fresh `[]` per call would defeat ChannelView's/GroupView's reaction-tally `useMemo`, which keys
 *  on this value staying referentially stable across renders while "no configured set" hasn't changed. */
const NO_REACTIONS: string[] = [];

/**
 * The live one-tap reaction palette for a broadcast-type space (public channel, group broadcast/
 * private channel): `configured` (the owner's set, passed through AS-IS — same reference in, same
 * reference out) when non-empty, else EMPTY — a space whose owner never set emojis shows no chips.
 * Reactions are an owner-configured affordance; nothing is invented on their behalf.
 *
 * Real reactions people actually sent still render via the off-palette union (tallyEmojiReactions'
 * second pass) regardless of what this returns — clearing a palette hides the zero-count chip row, it
 * never erases votes already cast. Shared by ChannelView (via MainScreen) and GroupView so the two
 * broadcast surfaces can never drift on what "no configured set" renders as.
 */
export function resolveReactionPalette(configured: string[] | undefined): string[] {
  return configured && configured.length > 0 ? configured : NO_REACTIONS;
}

/** Who may post top-level messages in a space. Informational (relay enforces the real permission). */
export type PostAudience = 'owner' | 'admins' | 'members';

/** How a rule violation is handled. */
export type ViolationMode = 'block' | 'autohide';

/**
 * The admin-configurable content rules for a space — identical shape for channels and groups.
 * A rule that is unset (0 bound / undefined) constrains nothing, so an un-configured space behaves
 * exactly as today.
 */
export interface SpaceRuleSet {
  /** Message body length bounds, in CHARACTERS. min/max of 0 = unbounded. */
  message: TypeRule;
  /** Whether a message may contain a URL. false ⇒ messages with links are removed. */
  allowLinks: boolean;
  /** Event kinds allowed as top-level messages. undefined/empty ⇒ no restriction. */
  allowedKinds?: number[];
  /** Who may post top-level (owner=channel, admins=broadcast, members=group). Informational. */
  postAudience?: PostAudience;
  /** Per-space voice permission. May only TIGHTEN the community `allowVoice` ceiling, never widen it. */
  allowVoice?: boolean;
  /** Default comment state for NEW posts (per-post overrides still apply). */
  defaultComments: boolean;
  /** Default reaction state for NEW posts. */
  defaultReactions: boolean;
  /** block = composer soft-block; autohide = client-side auto-remove + space mod-log entry. */
  onViolation: ViolationMode;
}

export const DEFAULT_SPACE_RULE_SET: SpaceRuleSet = {
  // Spaces (channels/groups) do not cap inline-media count — mediaMax 0 (unbounded). The per-type
  // media cap is a FEED-post concept (note/article); space messages keep their prior behaviour.
  message: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
  allowLinks: true,
  allowedKinds: undefined,
  postAudience: undefined,
  allowVoice: undefined,
  defaultComments: false,
  defaultReactions: false,
  onViolation: 'autohide',
};

/**
 * The full per-space settings payload. `rules` is carried for both types; `reactions`/`pinnedMessageId`
 * are the parity carrier for GROUPS (channels keep those on their 30311 and leave these undefined).
 */
export interface SpaceSettings {
  rules: SpaceRuleSet;
  reactions?: string[];
  pinnedMessageId?: string;
}

// ── wire (compact, mirrors postRules/tagPolicy abbreviations) ────────────────────────────────

interface TypeRuleWire {
  mn?: number;
  mx?: number;
  lr?: boolean;
}
interface SpaceRuleSetWire {
  m?: TypeRuleWire;
  al?: boolean;
  ak?: number[];
  pa?: PostAudience;
  av?: boolean;
  dc?: boolean;
  dr?: boolean;
  ov?: ViolationMode;
}
interface SpaceSettingsWire {
  r?: SpaceRuleSetWire;
  ar?: string[];
  pin?: string;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseTypeRule(raw: TypeRuleWire | undefined, fallback: TypeRule): TypeRule {
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    min: nonNegInt(raw.mn, fallback.min),
    max: nonNegInt(raw.mx, fallback.max),
    mediaMax: fallback.mediaMax, // spaces don't carry a media cap on the wire → keep the default (0)
    labelRequired: boolOr(raw.lr, fallback.labelRequired),
  };
}

/**
 * Coerce arbitrary JSON into a full SpaceRuleSet, filling every field from {@link DEFAULT_SPACE_RULE_SET}.
 * Tolerant of partial/legacy/absent input (write-new / accept-old back-compat), so a space with no
 * settings doc — or an older/partial one — resolves to sane defaults and keeps working.
 */
export function normalizeSpaceRules(raw: unknown): SpaceRuleSet {
  const w = (raw && typeof raw === 'object' ? raw : {}) as SpaceRuleSetWire;
  const kinds = Array.isArray(w.ak)
    ? w.ak.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
    : undefined;
  const audience: PostAudience | undefined =
    w.pa === 'owner' || w.pa === 'admins' || w.pa === 'members' ? w.pa : undefined;
  return {
    message: parseTypeRule(w.m, DEFAULT_SPACE_RULE_SET.message),
    allowLinks: boolOr(w.al, DEFAULT_SPACE_RULE_SET.allowLinks),
    allowedKinds: kinds && kinds.length > 0 ? kinds : undefined,
    postAudience: audience,
    allowVoice: typeof w.av === 'boolean' ? w.av : undefined,
    defaultComments: boolOr(w.dc, DEFAULT_SPACE_RULE_SET.defaultComments),
    defaultReactions: boolOr(w.dr, DEFAULT_SPACE_RULE_SET.defaultReactions),
    onViolation: w.ov === 'block' || w.ov === 'autohide' ? w.ov : DEFAULT_SPACE_RULE_SET.onViolation,
  };
}

function encodeSpaceRules(r: SpaceRuleSet): SpaceRuleSetWire {
  return {
    m: {mn: r.message.min, mx: r.message.max, lr: r.message.labelRequired},
    al: r.allowLinks,
    ak: r.allowedKinds && r.allowedKinds.length > 0 ? r.allowedKinds : undefined,
    pa: r.postAudience,
    av: r.allowVoice,
    dc: r.defaultComments,
    dr: r.defaultReactions,
    ov: r.onViolation,
  };
}

function encodeSpaceSettings(s: SpaceSettings): SpaceSettingsWire {
  const reactions = (s.reactions ?? []).map(e => e.trim()).filter(Boolean);
  return {
    r: encodeSpaceRules(s.rules),
    ar: reactions.length > 0 ? reactions : undefined,
    pin: s.pinnedMessageId || undefined,
  };
}

/** Parse a settings-doc content string into a full {@link SpaceSettings} (defaults on malformed). */
export function parseSpaceSettings(content: string): SpaceSettings {
  let raw: SpaceSettingsWire = {};
  try {
    const j = JSON.parse(content);
    if (j && typeof j === 'object') raw = j as SpaceSettingsWire;
  } catch {
    // fall through to defaults
  }
  const reactions = Array.isArray(raw.ar)
    ? raw.ar.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map(e => e.trim())
    : undefined;
  return {
    rules: normalizeSpaceRules(raw.r),
    reactions: reactions && reactions.length > 0 ? reactions : undefined,
    pinnedMessageId: typeof raw.pin === 'string' && raw.pin ? raw.pin : undefined,
  };
}

/** Build the addressable kind-30078 settings doc for a space (signed by a space admin/owner). */
export function buildSpaceSettings(spaceId: string, settings: SpaceSettings): UnsignedEvent {
  return {
    kind: Kind.AppData,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', spaceSettingsDTag(spaceId)]],
    content: JSON.stringify(encodeSpaceSettings(settings)),
  };
}

/** The `d`-tag value on an event, or undefined. */
function dTag(event: Event): string | undefined {
  return event.tags.find(t => t[0] === 'd' && t[1])?.[1];
}

/**
 * The authoritative settings for a space: the latest (greatest `created_at`) kind-30078 with the
 * space's `d`, signed by an AUTHORIZED admin/owner (`authorized`) so an impostor's doc can never win.
 * Returns null when no valid doc exists (caller falls back to synthesized defaults).
 */
export function getSpaceSettings(
  store: EventStore,
  spaceId: string,
  authorized: ReadonlySet<string>,
): {settings: SpaceSettings; at: number} | null {
  const d = spaceSettingsDTag(spaceId);
  const latest = store
    .query({kinds: [Kind.AppData]})
    .filter(ev => authorized.has(ev.pubkey) && dTag(ev) === d)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  return {settings: parseSpaceSettings(latest.content), at: latest.created_at};
}
