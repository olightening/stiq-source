/**
 * Multi-community store (PLAN.md §3.3, smoother-onboarding).
 *
 * Holds the set of communities the member has joined plus which one is active. A community is
 * identified by its relay onion — two organizers who share a relay are the *same* community
 * (the relay trusts both their issuer keys), so joining via a second organizer updates the
 * existing entry rather than creating a duplicate.
 *
 * This is the forward-compatible data model for "multiple communities, each with multiple
 * organizers." The active community's relay is the single source of truth for which relay the
 * app talks to, replacing the build-time `RELAY_ONION_WS` constant.
 *
 * NOTE: each membership binds exactly one on-device npub, so being *simultaneously* enrolled
 * in several communities (distinct keys per community) additionally requires namespacing the
 * keystore — tracked as a follow-up. Today the store holds the list + descriptors and drives
 * the active relay; the active community's on-device key lives in `Identity`.
 */
import type {SecureStorage} from '../keys/keystore';
import type {Community, RelayEntry, UpdateRepo} from '../onboarding/community';
import {walletKeyFingerprint} from '../blind/wallet';
import {normalizeTagPolicy, type TagPolicy} from '../feed/tagPolicy';
import {normalizeLabels, type LabelConfig} from '../feed/labels';
import type {PostRules} from '../feed/postRules';
import type {PostingGuidelines} from '../feed/postingGuidelines';
import {normalizePictureRules, type PictureRules} from '../feed/pictureRules';
import {normalizeAudioRules, type AudioRules} from '../feed/audioRules';
import type {ReasonsConfig} from '../moderation/reasons';
import type {StoragePolicy} from '../moderation/organizerConfig';
import type {RankingConfig} from '../feed/sort';
import {MAX_MIRRORS, MAX_SEEDED_BRIDGES} from '../onboarding/join';
import {onionHostOf} from '../tor/onionAuth';
import {validateBridgeLine} from '../tor/torSettings';

export interface EnrolledCommunity {
  /** Stable id = the relay onion host (same relay ⇒ same community). KeyStore slot + per-cid DB
   *  namespace both key off this — kept as the onion host (never `identityKey`) so an existing
   *  member's siloed data is never orphaned by the v2 rollout. */
  id: string;
  relayUrl: string;
  /**
   * OPTIONAL — omitted (not `undefined`) while a join-code v2 enrollment key is still deferred to
   * a post-connect NIP-11 fetch (see ../onboarding/community `issuerPublicKey` sentinel doc and
   * ../onboarding/join `enrollKeyMatchesCid`). Always present once enrollment resolves it.
   */
  issuerPublicKey?: string;
  /**
   * Relay-independent community id (join-code v2 `cid` = `walletKeyFingerprint(issuerPublicKey)`).
   * Used for mirror grouping/dedup and relay-independent identity display — NOT the storage `id`
   * (that stays the onion host, see above). Absent on a record that predates v2 until
   * {@link normalizeEnrolledCommunity} backfills it from a resolved `issuerPublicKey`.
   */
  identityKey?: string;
  /**
   * Full relay mirror list (join-code v2 `rs`), tolerated here for forward-compat with the future
   * write-fanout (P2); `relayUrl` stays the single source of truth for which relay this build
   * actually talks to. Absent for a v1/pre-mirror community.
   */
  relays?: RelayEntry[];
  /** OPTIONAL advisory expiry (join-code v2 `x`, unix seconds) — UX only, never enforced. */
  advisoryExpiry?: number;
  organizerPubkey?: string;
  name?: string;
  organizerLabel?: string;
  /**
   * Shared community key (base64), community-code v3 only. The membership secret every member holds
   * to attribute blind posts locally while the relay stays blind. Persisted per community (in the
   * hardware-encrypted secure store, like the rest of this record) so it survives a switch; absent
   * for v1/v2 communities. Consumed by the blind-posting layer (branch claude/unruffled-ritchie).
   */
  communityKey?: string;
  /**
   * Shared Tor v3 onion client-auth key (base32), community-code v4 only. The reach credential every
   * member's device uses to resolve/connect the auth-gated relay onion (lever 2). Persisted per
   * community (secure store) so it survives a switch; absent for a public onion. Consumed by the
   * Tor manager wiring (see ../tor/onionAuth deriveOnionAuth / getActiveOnionAuth).
   */
  onionAuthKey?: string;
  /**
   * Organizer-seeded obfs4/webtunnel bridge lines (join-code `br`, T14), no leading 'Bridge '. A
   * zero-network reach fallback for the webtunnel tier (which ships no bundled bridges). Validated +
   * capped at {@link MAX_SEEDED_BRIDGES} by parseJoinCode and again by {@link normalizeEnrolledCommunity};
   * consumed (behind COMMUNITY_SEEDED_BRIDGES) by App.tsx resolveBridges in a later subtask. Persisted
   * per community and, like the credentials above, protected by an absent-stays-absent guard in
   * {@link CommunityStore.upsert} so a later join code lacking `br` never erases it. Absent for a
   * community whose organizer seeded no bridges.
   */
  seededBridges?: string[];
  /**
   * Signed in-app update repo (T9, join-code `up`/`uf`/`af`/`ua`). The per-community trust anchor
   * App.tsx assembles into an updater `UpdateRepoConfig` for the Settings "App updates" section
   * (checkForUpdate / downloadAndInstall). Validated + capped by parseJoinCode and re-validated at the
   * single persisted-record read boundary by {@link normalizeEnrolledCommunity} (a partial/tampered
   * record is dropped). Persisted per community and, like the credentials above, protected by an
   * absent-stays-absent guard in {@link CommunityStore.upsert} so a later join code lacking the repo
   * fields never erases it. Absent for a community whose organizer published no repo; inert unless the
   * client's APK_UPDATES flag is on.
   */
  updateRepo?: UpdateRepo;
  /**
   * Purpose-specific issuer public keys (base64 SPKI) for token domain separation (#3/#4/#29),
   * carried by the join code's `pk`/`rk` when the organizer runs distinct keys. `postIssuerPublicKey`
   * (K_post) signs per-post tokens; `readIssuerPublicKey` (K_read) signs read-unlock tokens; the
   * enrollment credential stays under `issuerPublicKey` (K_enroll). Persisted per community so the
   * token draw (see AppRuntime.drawTokens → drawExchange) blinds under the right key after a switch.
   * Absent ⇒ the draw falls back to `issuerPublicKey`, byte-identical to the single-key deployment.
   */
  postIssuerPublicKey?: string;
  readIssuerPublicKey?: string;
  /**
   * Per-media issuer public keys (base64 SPKI) — media half of token domain separation (asks #3/#4),
   * carried by the join code's `pwk`/`prk`/`awk`/`ark`. Pictures and audio each get an independent
   * WRITE and READ budget, so a media post pays a media-write token and unlocking sealed media pays a
   * media-read token. Persisted per community so the draw blinds under the right key after a switch.
   * Absent ⇒ that domain falls back to `issuerPublicKey`, byte-identical to a single-key deployment.
   */
  picWriteIssuerPublicKey?: string;
  picReadIssuerPublicKey?: string;
  audWriteIssuerPublicKey?: string;
  audReadIssuerPublicKey?: string;
  /**
   * Space-write token issuer public key (base64 SPKI, join-code `swk`) — tokens-everywhere. Meters
   * writes into the bound-npub space kinds (channel messages, group chat/replies, DM wraps): the
   * event stays npub-signed but spends blind space-write tokens once the relay advertises
   * `space_tokens_required`. Absent ⇒ space draws fall back to `issuerPublicKey`.
   */
  spaceWriteIssuerPublicKey?: string;
  /**
   * The organizer's announced CURRENT content epoch (kind-30078 d=stiq:content-epoch) — the window
   * new posts seal under (censorable reads, #4). Live-updated; persisted so a returning member knows
   * which epoch to provision before composing. Absent until the organizer runs content sealing.
   */
  contentEpoch?: number;
  /** Tag policy set by the organizer (embedded in the join code; updated live via kind-30078). */
  tagPolicy?: TagPolicy;
  /** Organizer-defined post labels (updated live via kind-30078 d=stiq:labels). */
  labels?: LabelConfig;
  /** Organizer-defined per-post-type rules (updated live via kind-30078 d=stiq:post-rules). */
  postRules?: PostRules;
  /** created_at of the active post-rules doc (auto-moderation retroactivity boundary). */
  postRulesAt?: number;
  /** Organizer posting guidelines — the composer's rules banner + covenant sheet (updated live via
   *  kind-30078 d=stiq:posting-guidelines). null = organizer cleared them; absent = never set. */
  postingGuidelines?: PostingGuidelines | null;
  /** Organizer picture limits (updated live via kind-30078 d=stiq:picture-limits). */
  pictureRules?: PictureRules;
  /** Organizer voice/audio limits (updated live via kind-30078 d=stiq:audio-limits). */
  audioRules?: AudioRules;
  /** Organizer-defined moderation reason buckets (updated live via kind-30078 d=stiq:reasons). */
  reasons?: ReasonsConfig;
  /** Organizer-tuned Rising ranking (updated live via kind-30078 d=stiq:ranking). */
  ranking?: RankingConfig;
  /**
   * Organizer-tunable client retention/compaction caps (T16, kind-30078 d=stiq:storage). Persisted so
   * cold boot can size the per-community SqliteEventStore's RetentionPolicy before the first prune, and
   * updated live when a newer stiq:storage doc arrives. Absent ⇒ the store keeps DEFAULT_RETENTION_POLICY.
   * Guarded absent-stays-absent in {@link CommunityStore.upsert} (mirroring the mirror/credential guards)
   * so an unrelated partial upsert — or an organizer that stops publishing the doc — never erases the
   * last-known policy. Inert unless the client's COMPACTION_V2 flag is on.
   */
  storagePolicy?: StoragePolicy;
  /**
   * Multi-relay transport mirrors (P2 MirrorSet, synthesis §1.2). ALL three lists are additive and
   * ordered by trust: a member's own manually-added mirrors, mirrors this device has observed as
   * good, and the organizer-published mirror list (kind-30078 `d=stiq:mirrors`) — in that order, with
   * `mirrorsOrg` deliberately LAST so an organizer publishing a shorter/different list can only ADD
   * to or fill leftover cap slots in {@link effectiveMirrors}, never evict a user/known-good/seed
   * mirror a member already trusts. See `upsert`'s absent-stays-absent guards below — the anti-erasure
   * half of the invariant; the anti-rollback half (only a NEWER `stiq:mirrors` doc may replace
   * `mirrorsOrg`) is enforced by the caller before upsert, gated on `mirrorsOrgAt`.
   */
  mirrorsUser?: RelayEntry[];
  /** Mirrors this device has observed as reachable/good — structurally un-evictable, like mirrorsUser. */
  mirrorsKnownGood?: RelayEntry[];
  /** Organizer-published mirror list (kind-30078 `d=stiq:mirrors`) — LAST, cap-truncatable. */
  mirrorsOrg?: RelayEntry[];
  /** `created_at` of the applied `stiq:mirrors` doc — the anti-rollback gate for replacing mirrorsOrg. */
  mirrorsOrgAt?: number;
  /**
   * Relays the MEMBER has explicitly muted ("close from certain relays"). A device-only list — never
   * derived from a relay-delivered doc, so a relay/organizer can never inject or clear it. Subtracted
   * from {@link effectiveMirrors} by onion host AFTER the additive union is built, so a mute always
   * wins over any tier that would otherwise include the relay (user/known-good/seed/org). The one
   * exception is the PRIMARY relay (`relayUrl`): it is never removed — the app must always keep at
   * least one relay — so the Relays UI does not offer a mute on the primary (mute a secondary, or
   * switch communities, instead). Like the mirror tiers this is guarded absent-stays-absent in
   * {@link CommunityStore.upsert} so an org-config apply or re-join (neither carries it) can't erase it.
   */
  mirrorsBlocked?: RelayEntry[];
}

const LIST_KEY = 'stiq.communities.list';
const ACTIVE_KEY = 'stiq.communities.active';

/** Derive the stable community id (onion host) from a relay ws URL. */
export function communityId(relayUrl: string): string {
  const host = /^wss?:\/\/([a-z2-7]{56}\.onion)/i.exec(relayUrl.trim())?.[1];
  return host ? host.toLowerCase() : relayUrl.trim().toLowerCase();
}

/**
 * De-dup a mirror list by HOST identity (not literal URL string) — `ws://<host>`, `wss://<host>`,
 * and `ws://<host>/` all name the SAME relay, so treating them as distinct would let one physical
 * mirror silently occupy several of the {@link MAX_MIRRORS} slots. First occurrence wins, which is
 * what makes {@link effectiveMirrors}'s ordering (primary, then user, then known-good, then seed,
 * then org LAST) into the anti-flooding guarantee described there. Falls back to the trimmed
 * lower-cased URL for a non-onion entry (dev/test relays) so those still dedup sanely.
 */
export function dedupByOnionHost(entries: RelayEntry[]): RelayEntry[] {
  const seen = new Set<string>();
  const out: RelayEntry[] = [];
  for (const entry of entries) {
    const key = onionHostOf(entry.url) ?? entry.url.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The relay set this device should open MirrorSet children against (P2 synthesis §1.2), in trust
 * order and capped at {@link MAX_MIRRORS}. ORDER IS THE ANTI-FLOODING GUARANTEE: `mirrorsOrg` is
 * placed LAST, so an organizer who publishes a shorter/different `stiq:mirrors` list — whether by
 * accident, policy change, or an attempt to quietly de-list a mirror a member relies on — can only
 * ADD to or fill leftover cap slots. It can never push a user-added, known-good, or join-code seed
 * mirror out of the effective set; those three groups are only ever removed by the member's own
 * device (never inferred from a relay-delivered doc).
 *
 * The member's own {@link EnrolledCommunity.mirrorsBlocked} mutes are subtracted LAST (after the
 * additive union), so a mute always wins over every tier — user sovereignty over what this device
 * receives from. The PRIMARY relay is exempt: it is always kept so the app is never left with zero
 * relays (the Relays UI never offers a mute on the primary).
 */
export function effectiveMirrors(c: EnrolledCommunity): RelayEntry[] {
  const primary: RelayEntry = {url: c.relayUrl, onionAuthKey: c.onionAuthKey ?? null};
  const primaryHost = onionHostOf(c.relayUrl) ?? c.relayUrl;
  const seedRest = (c.relays ?? []).filter(r => (onionHostOf(r.url) ?? r.url) !== primaryHost);
  const blocked = new Set(
    (c.mirrorsBlocked ?? []).map(m => onionHostOf(m.url) ?? m.url.trim().toLowerCase()),
  );
  return dedupByOnionHost([
    primary,
    ...(c.mirrorsUser ?? []),
    ...(c.mirrorsKnownGood ?? []),
    ...seedRest,
    ...(c.mirrorsOrg ?? []),
  ])
    .filter(m => {
      const host = onionHostOf(m.url) ?? m.url.trim().toLowerCase();
      return host === primaryHost || !blocked.has(host); // primary is never muted
    })
    .slice(0, MAX_MIRRORS);
}

/** The additive tier a relay belongs to, in effectiveMirrors trust order. */
export type RelaySource = 'primary' | 'user' | 'known-good' | 'seed' | 'organizer';

/** One relay row for the Relays management UI. */
export interface RelayView {
  url: string;
  onionAuthKey?: string | null;
  /** Short v3 onion host (or the lowercased url for a non-onion dev relay) — the display + action key. */
  host: string;
  source: RelaySource;
  /** True only for rows in {@link RelaysSnapshot.muted}. */
  muted: boolean;
}

/** Everything the Relays UI needs to render, derived from one EnrolledCommunity. */
export interface RelaysSnapshot {
  primaryHost: string;
  /** Relays this device currently receives from, in effective (trust) order. */
  active: RelayView[];
  /** Relays the member has muted (currently NOT received from). */
  muted: RelayView[];
  /** Active set already fills {@link cap} — adding more relays has no effect until one is freed/muted. */
  atCap: boolean;
  cap: number;
}

/** Onion-host identity key for a relay url (ws://host vs wss://host vs trailing slash are one relay). */
function hostOf(url: string): string {
  return onionHostOf(url) ?? url.trim().toLowerCase();
}

/**
 * Which tier a host belongs to, checked in the SAME order {@link effectiveMirrors} unions them
 * (primary → user → known-good → seed → organizer); first match wins. `undefined` when the host is in
 * no tier (e.g. a relay the organizer has since dropped that the member had muted) — callers default
 * such a row to 'user' since only the member's own device could be holding it.
 */
function relaySourceOf(c: EnrolledCommunity, host: string): RelaySource | undefined {
  const primaryHost = hostOf(c.relayUrl);
  if (host === primaryHost) return 'primary';
  const inList = (list?: RelayEntry[]): boolean => (list ?? []).some(m => hostOf(m.url) === host);
  if (inList(c.mirrorsUser)) return 'user';
  if (inList(c.mirrorsKnownGood)) return 'known-good';
  if ((c.relays ?? []).some(m => hostOf(m.url) === host && hostOf(m.url) !== primaryHost)) return 'seed';
  if (inList(c.mirrorsOrg)) return 'organizer';
  return undefined;
}

/**
 * Derive the Relays-screen snapshot from a community: the active (received-from) relays with their
 * trust-tier source, plus the member's muted relays. Pure — the UI re-derives after each mutation.
 */
export function describeRelays(c: EnrolledCommunity): RelaysSnapshot {
  const primaryHost = hostOf(c.relayUrl);
  const toView = (m: RelayEntry, muted: boolean): RelayView => {
    const host = hostOf(m.url);
    return {url: m.url, onionAuthKey: m.onionAuthKey ?? null, host, source: relaySourceOf(c, host) ?? 'user', muted};
  };
  const active = effectiveMirrors(c).map(m => toView(m, false));
  const muted = (c.mirrorsBlocked ?? []).map(m => toView(m, true));
  return {primaryHost, active, muted, atCap: active.length >= MAX_MIRRORS, cap: MAX_MIRRORS};
}

/**
 * Repair a persisted community whose organizer-config sub-objects may predate newer fields.
 *
 * A record written by an older app version can carry a `tagPolicy` without `tagScopes` or `labels`
 * without `appliesTo` (both added with per-post-type scoping). Normalizing here — the single read
 * boundary for all persisted communities — means every downstream consumer receives a well-formed
 * object, and `upsert` writes the repaired shape back, so storage self-heals over time. Absent
 * sub-objects stay absent so the runtime keeps its own defaults.
 */
export function normalizeEnrolledCommunity(c: EnrolledCommunity): EnrolledCommunity {
  return {
    ...c,
    tagPolicy: c.tagPolicy ? normalizeTagPolicy(c.tagPolicy) : undefined,
    labels: c.labels ? normalizeLabels(c.labels) : undefined,
    pictureRules: c.pictureRules ? normalizePictureRules(c.pictureRules) : undefined,
    audioRules: c.audioRules ? normalizeAudioRules(c.audioRules) : undefined,
    // D1 migrator: a pre-v2 record has no `identityKey` — backfill it from the (already-resolved)
    // issuer key it does carry, so mirror grouping/dedup and identity display work for members who
    // joined before the v2 rollout without touching their storage `id` (still the onion host).
    identityKey: c.identityKey ?? (c.issuerPublicKey ? walletKeyFingerprint(c.issuerPublicKey) : undefined),
    // Re-validate seeded bridges at the single persisted-record read boundary (T14): a record could
    // predate `br` or (defence in depth) have been tampered, so drop anything that isn't a valid
    // obfs4/webtunnel line, dedupe, and cap — omitting the field entirely when nothing survives.
    seededBridges: normalizeSeededBridges(c.seededBridges),
    // Re-validate the signed-update repo at the same read boundary (T9): a record could predate the
    // field or (defence in depth) have been tampered, so drop it unless it is a complete, structurally
    // valid repo (baseUrl + two 64-hex cert pins) — omitting the field entirely otherwise.
    updateRepo: normalizeUpdateRepo(c.updateRepo),
  };
}

const HEX64_LOWER = /^[0-9a-f]{64}$/;

/**
 * Validate a persisted community's signed-update repo (join-code `up`/`uf`/`af`/`ua`, T9). Mirrors
 * the join-code parser's gate: a complete repo needs a non-empty baseUrl and two 64-hex cert pins
 * (index-signing `uf`, app-signing `af`); the applicationId defaults to the standard package id.
 * Returns `undefined` (not a partial object) when the input is absent/malformed, so the field stays
 * absent-stays-absent through {@link CommunityStore.upsert}'s merge — never resurrected half-formed.
 */
function normalizeUpdateRepo(raw: unknown): UpdateRepo | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Partial<UpdateRepo>;
  if (typeof r.baseUrl !== 'string' || !r.baseUrl) {
    return undefined;
  }
  const certSha256 = typeof r.certSha256 === 'string' ? r.certSha256.toLowerCase() : '';
  const appCertSha256 = typeof r.appCertSha256 === 'string' ? r.appCertSha256.toLowerCase() : '';
  if (!HEX64_LOWER.test(certSha256) || !HEX64_LOWER.test(appCertSha256)) {
    return undefined;
  }
  return {
    baseUrl: r.baseUrl,
    certSha256,
    appCertSha256,
    applicationId: typeof r.applicationId === 'string' && r.applicationId ? r.applicationId : 'com.stiq.client',
  };
}

/**
 * Validate a persisted community's seeded bridge lines (join-code `br`, T14). Runs the SAME per-line
 * guard as the join-code parser and the user custom-bridge paste (validateBridgeLine: obfs4/webtunnel
 * only), dedupes, and caps at {@link MAX_SEEDED_BRIDGES}. Returns `undefined` (not `[]`) when the input
 * is absent/not-an-array or every line is dropped, so the field stays absent-stays-absent through
 * {@link CommunityStore.upsert}'s merge — never resurrected as an empty array.
 */
function normalizeSeededBridges(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: string[] = [];
  for (const line of raw) {
    if (typeof line !== 'string') {
      continue;
    }
    const trimmed = line.trim();
    const kind = validateBridgeLine(trimmed);
    if ((kind === 'obfs4' || kind === 'webtunnel') && !out.includes(trimmed)) {
      out.push(trimmed);
    }
    if (out.length >= MAX_SEEDED_BRIDGES) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build an EnrolledCommunity descriptor from a parsed Community.
 *
 * Optional fields are OMITTED when the source lacks them rather than emitted as `undefined`. This
 * matters on a re-join: {@link CommunityStore.upsert} merges `{...old, ...new}`, so an explicit
 * `undefined` would ERASE a value already stored/learned for this community — e.g. a v2/dashboard
 * join code lacking `ck` would wipe the blind-posting shared key (silently downgrading every future
 * post to non-blind), and a code lacking `tagPolicy`/organizer would drop a live-learned policy.
 * Absent-stays-absent keeps the merge additive.
 */
export function toEnrolledCommunity(c: Community): EnrolledCommunity {
  const out: EnrolledCommunity = {
    id: communityId(c.relayUrl),
    relayUrl: c.relayUrl,
  };
  // OMIT issuerPublicKey when it's the '' deferred sentinel (join-code v2 pre-fetch) rather than
  // emit the empty string — so upsert's absent-stays-absent merge never wipes an already-resolved
  // key on a re-join whose code still carries the deferred form.
  if (c.issuerPublicKey) out.issuerPublicKey = c.issuerPublicKey;
  if (c.organizerPubkey !== undefined) out.organizerPubkey = c.organizerPubkey;
  if (c.name !== undefined) out.name = c.name;
  if (c.organizerLabel !== undefined) out.organizerLabel = c.organizerLabel;
  if (c.communityKey !== undefined) out.communityKey = c.communityKey;
  if (c.onionAuthKey !== undefined) out.onionAuthKey = c.onionAuthKey;
  if (c.postIssuerPublicKey !== undefined) out.postIssuerPublicKey = c.postIssuerPublicKey;
  if (c.readIssuerPublicKey !== undefined) out.readIssuerPublicKey = c.readIssuerPublicKey;
  if (c.picWriteIssuerPublicKey !== undefined) out.picWriteIssuerPublicKey = c.picWriteIssuerPublicKey;
  if (c.picReadIssuerPublicKey !== undefined) out.picReadIssuerPublicKey = c.picReadIssuerPublicKey;
  if (c.audWriteIssuerPublicKey !== undefined) out.audWriteIssuerPublicKey = c.audWriteIssuerPublicKey;
  if (c.audReadIssuerPublicKey !== undefined) out.audReadIssuerPublicKey = c.audReadIssuerPublicKey;
  if (c.spaceWriteIssuerPublicKey !== undefined) out.spaceWriteIssuerPublicKey = c.spaceWriteIssuerPublicKey;
  // OMIT when absent (never emit `undefined`) so upsert's absent-stays-absent merge can't wipe a
  // seeded-bridge list already held for this community on a re-join whose code carries no `br` (T14).
  if (c.seededBridges !== undefined) out.seededBridges = c.seededBridges;
  // OMIT when absent (never emit `undefined`) so upsert's absent-stays-absent merge can't wipe a
  // signed-update repo already held for this community on a re-join whose code carries no repo (T9).
  if (c.updateRepo !== undefined) out.updateRepo = c.updateRepo;
  if (c.tagPolicy !== undefined) out.tagPolicy = c.tagPolicy;
  if (c.cid !== undefined) out.identityKey = c.cid;
  if (c.relays !== undefined) out.relays = c.relays;
  if (c.advisoryExpiry !== undefined) out.advisoryExpiry = c.advisoryExpiry;
  return out;
}

export class CommunityStore {
  constructor(private readonly storage: SecureStorage) {}

  /**
   * Session-level memo of the parsed community list + active id.
   *
   * `list()` / `activeId()` / `active()` are each called several times per boot (loadActiveCommunityPolicy,
   * resolveActiveNamespace, listChannels-adjacent reads, …) with nothing mutating storage in between —
   * every one of those calls used to re-read the raw string, `JSON.parse` it, and re-normalize the WHOLE
   * list from scratch. The memo makes repeat reads free; every mutating method below (upsert/remove/
   * setActive/clear — the only ones that write LIST_KEY/ACTIVE_KEY) invalidates it so a write is always
   * visible on the very next read. Storage stays the single source of truth across restarts: a fresh
   * instance (the next app launch, or the separate short-lived CommunityStore the headless background
   * sync task constructs) starts with an empty memo and reads storage exactly as before.
   *
   * `undefined` is the "not cached this session" sentinel for both fields (a real active id can itself
   * be `null`, so `_activeIdCache` distinguishes "unread" from "read and absent").
   */
  private _listCache: EnrolledCommunity[] | undefined;
  private _activeIdCache: string | null | undefined;

  async list(): Promise<EnrolledCommunity[]> {
    if (this._listCache !== undefined) {
      return this._listCache;
    }
    const raw = await this.storage.getItem(LIST_KEY);
    let list: EnrolledCommunity[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as EnrolledCommunity[];
        list = Array.isArray(parsed) ? parsed.map(normalizeEnrolledCommunity) : [];
      } catch {
        list = [];
      }
    }
    this._listCache = list;
    return list;
  }

  async activeId(): Promise<string | null> {
    if (this._activeIdCache !== undefined) {
      return this._activeIdCache;
    }
    const id = await this.storage.getItem(ACTIVE_KEY);
    this._activeIdCache = id;
    return id;
  }

  async active(): Promise<EnrolledCommunity | null> {
    const id = await this.activeId();
    if (!id) {
      return null;
    }
    const list = await this.list();
    return list.find(c => c.id === id) ?? null;
  }

  /** The active community's relay, or `fallback` when nothing is enrolled yet. */
  async activeRelayUrl(fallback: string): Promise<string> {
    const active = await this.active();
    return active?.relayUrl ?? fallback;
  }

  async setActive(id: string): Promise<void> {
    await this.storage.setItem(ACTIVE_KEY, id);
    this._activeIdCache = undefined; // invalidate: next activeId() re-reads storage
  }

  /** Add or update a community (matched by id) and make it active. */
  async upsert(community: EnrolledCommunity): Promise<void> {
    // Copy rather than mutate the (possibly memoized/shared) array returned by list() — a concurrent
    // caller holding that same reference across an await must never observe this in-progress write.
    const list = [...(await this.list())];
    const idx = list.findIndex(c => c.id === community.id);
    if (idx === -1) {
      list.push(community);
    } else {
      const existing = list[idx]!;
      const merged = {...existing, ...community};
      // Defence in depth: never let an incoming record ERASE the shared community key we already
      // hold. `ck` is an irrecoverable membership secret — losing it silently downgrades this
      // community's blind posts to non-blind for every identity in it. toEnrolledCommunity already
      // omits an absent key so the spread preserves it; this also guards a caller that passes an
      // explicit `communityKey: undefined`.
      if (community.communityKey === undefined && existing.communityKey !== undefined) {
        merged.communityKey = existing.communityKey;
      }
      // Same defence for the onion-auth reach credential — never let an incoming record erase it.
      if (community.onionAuthKey === undefined && existing.onionAuthKey !== undefined) {
        merged.onionAuthKey = existing.onionAuthKey;
      }
      // Same defence for organizer-seeded bridge lines (join-code `br`, T14): a later upsert whose
      // code carries no `br` (an organizer who seeded none, or a pre-T14 code) must never erase the
      // seeded bridges a member already holds — they are a zero-network reach fallback for webtunnel.
      // toEnrolledCommunity already omits an absent list so the spread preserves it; this also guards
      // a caller passing an explicit `seededBridges: undefined`.
      if (community.seededBridges === undefined && existing.seededBridges !== undefined) {
        merged.seededBridges = existing.seededBridges;
      }
      // Same defence for the signed-update repo (join-code `up`/`uf`/`af`/`ua`, T9): a later upsert
      // whose code carries no repo fields (an organizer who published none, or a pre-T9 code) must
      // never erase the update trust anchor a member already holds. toEnrolledCommunity already omits
      // an absent repo so the spread preserves it; this also guards an explicit `updateRepo: undefined`.
      if (community.updateRepo === undefined && existing.updateRepo !== undefined) {
        merged.updateRepo = existing.updateRepo;
      }
      // Same defence for a resolved enrollment key and its identity id: a v2 re-join whose code
      // still carries the deferred form (toEnrolledCommunity omits issuerPublicKey/identityKey in
      // that case) must never regress an already-resolved key/id back to unresolved.
      if (community.issuerPublicKey === undefined && existing.issuerPublicKey !== undefined) {
        merged.issuerPublicKey = existing.issuerPublicKey;
      }
      if (community.identityKey === undefined && existing.identityKey !== undefined) {
        merged.identityKey = existing.identityKey;
      }
      // Same defence for the three mirror lists (P2 synthesis §1.2): an incoming record that simply
      // doesn't carry a given list (e.g. a re-join code with no `mirrorsUser`, or an org-config apply
      // that only ever sets `mirrorsOrg`) must never erase mirrors already held in the other lists —
      // erasure would silently shrink `effectiveMirrors` and undo the anti-flooding ordering. The
      // created_at anti-rollback gate for REPLACING mirrorsOrg with a newer doc lives in the caller
      // (AppRuntime), before upsert; this guard only prevents outright erasure.
      if (community.mirrorsUser === undefined && existing.mirrorsUser !== undefined) {
        merged.mirrorsUser = existing.mirrorsUser;
      }
      if (community.mirrorsKnownGood === undefined && existing.mirrorsKnownGood !== undefined) {
        merged.mirrorsKnownGood = existing.mirrorsKnownGood;
      }
      if (community.mirrorsOrg === undefined && existing.mirrorsOrg !== undefined) {
        merged.mirrorsOrg = existing.mirrorsOrg;
        merged.mirrorsOrgAt = existing.mirrorsOrgAt;
      }
      // Same defence for the member's mute list: neither the join code nor any org-config apply
      // carries `mirrorsBlocked`, so an incoming record that omits it must never erase the relays a
      // member chose to close — that would silently re-open a muted relay for receiving.
      if (community.mirrorsBlocked === undefined && existing.mirrorsBlocked !== undefined) {
        merged.mirrorsBlocked = existing.mirrorsBlocked;
      }
      // Same defence for the organizer storage/retention policy (T16 stiq:storage): an incoming record
      // that doesn't carry it — any unrelated partial upsert, or an org that stopped publishing the doc
      // — must never erase the last-known caps, which would silently revert a low-storage phone to the
      // generous defaults. toEnrolledCommunity never emits it (it arrives via org-config ingest, not the
      // join code), so the spread already preserves it; this also guards an explicit `undefined`.
      if (community.storagePolicy === undefined && existing.storagePolicy !== undefined) {
        merged.storagePolicy = existing.storagePolicy;
      }
      list[idx] = merged;
    }
    await this.storage.setItem(LIST_KEY, JSON.stringify(list));
    // Invalidate rather than adopt `list` directly: the next read re-parses + re-normalizes from
    // storage, exactly matching the un-memoized behaviour this replaces (byte-identical result).
    this._listCache = undefined;
    await this.setActive(community.id);
  }

  async remove(id: string): Promise<void> {
    const list = (await this.list()).filter(c => c.id !== id);
    await this.storage.setItem(LIST_KEY, JSON.stringify(list));
    this._listCache = undefined;
    if ((await this.activeId()) === id) {
      const next = list[0]?.id;
      if (next) {
        await this.setActive(next);
      } else {
        await this.storage.removeItem(ACTIVE_KEY);
        this._activeIdCache = undefined;
      }
    }
  }

  /** Wipe all communities — part of the duress/logout reset. */
  async clear(): Promise<void> {
    await this.storage.removeItem(LIST_KEY);
    await this.storage.removeItem(ACTIVE_KEY);
    this._listCache = undefined;
    this._activeIdCache = undefined;
  }
}
