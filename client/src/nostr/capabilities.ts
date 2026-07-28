/**
 * Relay capability negotiation — one runtime-held view of what the relay actually enforces.
 *
 * The client used to hardcode cross-process invariants (PoW difficulty, NIP-29 support, kind
 * lists) as build constants that had to be flipped in lock-step with the relay. Instead the relay
 * advertises them in its NIP-11 information document — the standard `supported_nips` + `limitation`
 * fields plus a stiq-specific `stiq-capabilities` block — and the client negotiates a single
 * {@link RelayCapabilities} view once per (re)connect (see AppRuntime.onRelayConnected).
 *
 * Everything here PARSES DEFENSIVELY: every field degrades to a build-constant fallback and NOTHING
 * ever throws on a malformed/absent document. That is what makes this safe to ship AHEAD of any
 * relay that advertises the block — an older relay (or a failed fetch) yields the constant fallback,
 * byte-for-byte today's behaviour, with no coordinated flip.
 *
 * This module is a LEAF: it imports only build constants and the contract kind lists, never a Tor
 * transport or app state, so it stays trivially unit-testable. The host supplies the HTTP-over-Tor
 * getter (see `fetchRelayCapabilities`); the anonymity-critical fetch lives at that call site.
 */
import {DM_POW_DIFFICULTY, ENROLL_POW_DIFFICULTY, RELAY_SUPPORTS_NIP29} from '../config';
import {FETCH_ONLY_KINDS, GROUP_KINDS, SUBSCRIBED_KINDS, FingerprintKey, StiqDom} from '../contracts';

export interface RelayCapabilities {
  /** stiq-capabilities schema version (0 when the block is absent). */
  schemaVersion: number;
  /**
   * Version of the relay's machine-readable OK-frame reject-code vocabulary (`reject_codes_version`;
   * 0 when the block is absent). At/above {@link CAPS_REJECT_CODES_MACHINE_MIN} every rejection is
   * guaranteed to carry a stable bracketed `[code]` the client can trust for its retry decision (see
   * {@link import('./rejection').isRetryable}); below it the client falls back to the legacy prose
   * heuristic. Distinct from {@link schemaVersion} — the two version independently.
   */
  rejectCodesVersion: number;
  /** NIP-13 PoW bits the relay requires on an enroll (kind 9020) mailbox request. */
  enrollPow: number;
  /** NIP-13 PoW bits the relay requires on a DM gift wrap (kind 1059). */
  dmPow: number;
  /** Hard-enforced protocol switches the relay applies. */
  enforcedFlags: {
    /** Content kinds must carry a valid blind token (relay is author-blind). */
    blindRequired: boolean;
    /** Private-group reads require a read-auth token. */
    privateGroupReadAuth: boolean;
    /** Token weight pricing: bytes charged per token (0 = pricing off). */
    bytesPerToken: number;
    /**
     * Content-encryption read meter (C7) is live: the relay advertises that community posts may be
     * sealed under a rotating content epoch key and read via the blind read-token meter. This is the
     * SINGLE MASTER SWITCH for the whole read-meter subsystem in the client: every C7 activation
     * (read-token draws, {@link AppRuntime.unlockContentEpoch}, the locked-body tap affordance) is
     * gated on this flag being true. DEFAULT false — with today's fallback caps the entire subsystem
     * is inert and behaviour is byte-identical (posts publish PLAINTEXT, no read draws, no locked
     * items). It can only turn on once a relay advertises `enforced.content_encryption: true`.
     */
    contentEncryption: boolean;
    /**
     * Censorable reads (#4): the organizer requires a READ-purpose token draw to prove the member's
     * npub (a reader-auth), so it can refuse a read-revoked member. When true, {@link
     * AppRuntime.unlockContentEpoch} attaches a member-signed reader-auth to its read-token draw. The
     * WRITE path is never affected — posting stays blind + uncensorable. DEFAULT false → read draws
     * stay anonymous, byte-identical to before. Meaningful only alongside `contentEncryption`.
     */
    readAuthRequired: boolean;
    /**
     * Tokens-everywhere: member space content (channel messages 1311, group chat/replies 9/12,
     * h-tagged group reactions, DM gift wraps 1059) must spend blind SPACE-WRITE tokens. This is the
     * client's ONLY attach signal — a relay without this flag REJECTS token-tagged space kinds, so
     * attaching early would kill every space write. When true, the space signer attaches an
     * all-proofs stiq_spend chain and the WalletHub stocks the space wallet proactively. DEFAULT
     * false → space publishes stay byte-identical to today.
     */
    spaceTokensRequired: boolean;
  };
  /**
   * Media WRITE domains the relay actually verifies against dedicated issuer keys (`stiq_dom`
   * routing, Phase 4d activation): a client must NOT spend media-write-key tokens (with a stiq_dom
   * claim) until that domain appears here — against an unconfigured relay those tokens fall back to
   * the posting-key check and FAIL, killing the post. DEFAULT both false (relay omitted the field
   * or predates it) → media blobs keep paying from the post wallet, byte-identical to today.
   */
  mediaWriteDomains: {picture: boolean; audio: boolean};
  /**
   * Fingerprints of the relay's purpose keys, when advertised — ONE ARRAY PER DOMAIN (T1.4/F6,
   * rotation-safe per Fable B3). The relay advertises each domain as a live-valid SET of
   * `"sha256:"+hex(SPKI)` fingerprints — a key rotation runs the OLD and NEW key in parallel for an
   * overlap window, so every array entry is a currently-valid issuer key for that domain. A client
   * wallet key is stale iff it prefix-matches NONE of the entries — never "differs from entry[0]"
   * (a first-entry-only check would hard-block every client mid-rotation, recreating the swk incident
   * from inside its own fix). Covers the relay-enforced WRITE domains this phase: `posting` (K_post),
   * `spaceWrite` (K_spacewrite), `picture`/`audio` (the two media WRITE-issuer domains, T1.3).
   * `enroll`/`binding` are advertised too but stay OBSERVED ONLY (never draw-gated — NB-7): a mismatch
   * there is descriptive, not blocking. `read` is UNCHANGED (single string, NOT yet widened to a set)
   * — its provenance leg is deferred to Phase 5 (T5.2); see TOKEN_FIXING_PLAN.md's T1.3 EXECUTION
   * SEQUENCING note. Every array is normalized to bare lowercase hex (the `sha256:` prefix stripped);
   * absent/malformed → undefined, never `[]`, so a caller's truthiness check (`fps.posting &&`) still
   * works exactly like the pre-widening single-string shape.
   */
  purposeKeyFingerprints: {
    enroll?: string[];
    posting?: string[];
    binding?: string[];
    spaceWrite?: string[];
    picture?: string[];
    audio?: string[];
    read?: string;
  };
  /**
   * FULL purpose public keys (base64 SPKI) the relay advertises under `issuer_keys` — the
   * post-connect fetch substrate for join-code v2's deferred enrollment key (see
   * ../onboarding/join `enrollKeyMatchesCid`). `enroll` is the key a deferred `Community.
   * issuerPublicKey === ''` resolves to; `posting`/`read` are carried for future consumers.
   * Absent (undefined) fields mean the relay didn't advertise that purpose key (or runs a single
   * issuer key with no domain separation) — never an empty string, {@link parseRelayCapabilities}
   * maps `''` to `undefined` on read.
   */
  issuerKeys: {
    enroll?: string;
    posting?: string;
    read?: string;
  };
  /** Kinds the relay accepts (advertised allow-list, else the client's own kind union). */
  allowedKinds: number[];
  /** Standard NIP-11 `limitation` sub-fields the client cares about. */
  limitation: {
    maxContentLength?: number;
    maxEventTags?: number;
    maxLimit?: number;
  };
  /** NIP-11 `supported_nips` (negotiated; drives the NIP-29 managed-group gate). */
  supportedNips: number[];
  /**
   * Real-push (T1) discovery block the relay advertises under `stiq-capabilities.push` when a keyless
   * pushwatcher + self-hosted ntfy are deployed beside it: `watcher` is the watcher's onion register
   * endpoint, `ntfy` the ntfy onion host the client validates a UnifiedPush endpoint against. DEFAULT
   * undefined — an older relay (or one without the watcher deployed) omits the block, and UnifiedPush
   * registration is gated on `push?.watcher` being present, so the whole feature stays dark until a
   * relay advertises it (clients ship the flag first). Purely descriptive: it changes no admission.
   */
  push?: {watcher?: string; ntfy?: string};
}

/**
 * The `caps.schemaVersion` at/above which the relay GUARANTEES it advertises its issuer-key
 * fingerprints in a FROZEN wire-format (see CLIENT_C5_FINGERPRINT_CONTRACT.md). The live relay
 * advertises them under `issuer_key_fingerprints` as `["sha256:<hex>"]` arrays, where `<hex>` is the
 * FULL `sha256_hex(utf8(base64_standard_DER_SPKI_string))` of the issuer key — i.e. the relay hashes
 * the SAME base64-DER-SPKI string the join/community code carries, so the client's truncated
 * {@link walletKeyFingerprint} (`…[:16]`) is a PREFIX of the relay's full hash. verifyCommunityProvisioning
 * therefore compares by prefix, not by exact equality.
 *
 * The C5 domain-separation check (AppRuntime.verifyCommunityProvisioning) only HARD-BLOCKS posting on
 * a fingerprint mismatch at/above this schema; below it a mismatch is advisory-only (`log.warn`),
 * because the format isn't yet CONTRACTUALLY frozen and a mismatch is more likely a harmless skew than
 * a real mis-provisioning.
 *
 * CRITICAL SHIP-AHEAD INVARIANT — this threshold MUST stay strictly ABOVE the schema the live relay
 * advertises. The production relay is already at `schema_version: 1`; if this threshold were 1 the
 * hard block would be ARMED against every current member, and a community-wide posting outage would be
 * one parser bug away. It is pinned at 2 (> the live 1) so enforcement is provably dormant against
 * today's relay — the fallback caps (schemaVersion 0) and the live relay (1) are both below it. Only
 * raise it in lock-step with a relay that has FROZEN and bumped its advertised schema, and keep a
 * regression test asserting `parseRelayCapabilities(<live NIP-11>).schemaVersion < this`.
 */
export const CAPS_SCHEMA_PURPOSE_FINGERPRINTS = 2;

/**
 * The `caps.schemaVersion` at/above which the relay (and its organizer) GUARANTEE machine-readable
 * error codes in a frozen wire format — i.e. an OK-frame rejection carries a stable machine prefix
 * (`blocked:`/`invalid:`/`rate-limited:`/…) and an over-quota draw response carries the structured
 * integer `cap` field rather than only prose. Two consumers gate on it:
 *   • {@link classifyRejection} (RelayClient) — below this the prose-prefix heuristic is best-effort;
 *     at/above it the prefix IS the machine code and is authoritative.
 *   • drawExchange's `capFromResponse` — at/above this a cap-less error is taken at face value (a
 *     genuine fatal error, NOT a low quota) instead of being prose-scraped for "at most N".
 *
 * A FUTURE threshold, deliberately set ABOVE {@link CAPS_SCHEMA_PURPOSE_FINGERPRINTS} so that no
 * relay advertising today's schemas can activate it: today's fallback caps report schemaVersion 0
 * (and the fingerprint contract pins schema 1), both below this, so the legacy prose heuristic /
 * regex self-heal stay active — byte-identical to before. Bump in lock-step with the relay only once
 * its machine-code/`cap` wire format is frozen.
 */
export const CAPS_SCHEMA_ERROR_CODES = 2;

/**
 * The `caps.rejectCodesVersion` at/above which the relay GUARANTEES every OK-frame rejection carries a
 * stable, machine-readable bracketed `[code]` (T12) — the code the client may TRUST for its retry
 * decision rather than the legacy prose heuristic. Consumed by AppRuntime.deliver via
 * {@link import('./rejection').isRetryable}'s `trustCodes` gate (AND-ed with the
 * `TRUST_RELAY_REJECT_CODES` kill-switch). Pinned at 3: the production relay currently advertises
 * `reject_codes_version: 1`, so the trust path stays dormant — byte-identical to today's prose
 * heuristic — until a relay that has FROZEN the v3 vocabulary ships. Calm-message RENDERING does NOT
 * gate on this (an unknown code always falls back to raw prose); only the retry DECISION does.
 */
export const CAPS_REJECT_CODES_MACHINE_MIN = 3;

/**
 * Every kind the client publishes or ingests, de-duplicated — the fallback allow-list.
 *
 * Includes the off-firehose allow-lists, because this set is about what the client will ACCEPT or
 * PUBLISH, not about what it puts in a REQ: NIP-29 group kinds arrive on a group-scoped sub, and
 * FETCH_ONLY_KINDS (media blobs) arrive on an id-scoped fetch. Omitting the latter would make this
 * const's own claim false and would have `warnKindDrift` report a spurious drift for every blob
 * ingested against a caps-fallback relay.
 */
const CLIENT_KINDS: number[] = Array.from(new Set([...SUBSCRIBED_KINDS, ...GROUP_KINDS, ...FETCH_ONLY_KINDS]));

/**
 * RelayCapabilities built purely from this build's constants — the fallback returned when the relay
 * advertises no `stiq-capabilities` block (older relay) or the NIP-11 fetch fails. Ships safely
 * ahead of the relay: byte-for-byte today's behaviour (NIP-29 gate = RELAY_SUPPORTS_NIP29, PoW =
 * the config constants, token pricing off, allow-list = the client's own kind union).
 */
export function defaultRelayCapabilities(): RelayCapabilities {
  return {
    schemaVersion: 0,
    rejectCodesVersion: 0,
    enrollPow: ENROLL_POW_DIFFICULTY,
    dmPow: DM_POW_DIFFICULTY,
    enforcedFlags: {
      blindRequired: false,
      privateGroupReadAuth: false,
      bytesPerToken: 0,
      // Content-encryption read meter OFF by default: the C7 subsystem ships dark until a relay
      // advertises the capability. See the field doc — this is the master gate that keeps posts
      // plaintext and the read meter dormant with today's fallback caps.
      contentEncryption: false,
      readAuthRequired: false,
      // Space-write tokens OFF by default (tokens-everywhere ships dark): a relay must explicitly
      // advertise enforcement before the client ever attaches tokens to space content.
      spaceTokensRequired: false,
    },
    // No media write domains until the relay advertises them (Phase 4d activation signal).
    mediaWriteDomains: {picture: false, audio: false},
    purposeKeyFingerprints: {},
    issuerKeys: {},
    allowedKinds: [...CLIENT_KINDS],
    limitation: {},
    supportedNips: RELAY_SUPPORTS_NIP29 ? [29] : [],
  };
}

// ── Defensive readers (missing/malformed → fallback, never throw) ──────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number, else the fallback. Rejects NaN, strings, booleans, objects. */
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Filter to finite numbers, or undefined when the value is not an array. */
function numArrayOrUndef(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Normalize ONE advertised fingerprint entry — an algorithm-prefixed string (`"sha256:<hex>"`) or a
 * bare hex string — to bare lowercase hex. Strips a leading `algo:` prefix if present. Returns
 * undefined for anything that isn't a non-empty string.
 */
function normFingerprintEntry(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const colon = v.indexOf(':');
  return (colon >= 0 ? v.slice(colon + 1) : v).toLowerCase();
}

/**
 * Normalize a SINGLE advertised issuer/purpose-key fingerprint field — today only `read` uses this
 * shape (its rotation-safe SET widening is deferred to Phase 5; see {@link normFingerprintSet} for the
 * T1.4 array version every other domain now uses).
 *
 * The live relay advertises each fingerprint as a NON-EMPTY ARRAY of algorithm-prefixed strings —
 * `["sha256:<64-hex>"]` — where `<hex>` is the FULL sha256 of the same base64-DER-SPKI string the
 * community/join code carries. Older/synthetic docs use a bare string. Accept either: take the first
 * string of an array. The client's {@link walletKeyFingerprint} is a 16-hex TRUNCATION of that same
 * hash, so verifyCommunityProvisioning compares by PREFIX — a full-length relay hash still matches.
 */
function normFingerprint(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v.find(x => typeof x === 'string' && x.length > 0) : v;
  return normFingerprintEntry(s);
}

/**
 * Normalize an advertised fingerprint field to the FULL SET of currently-valid entries for that
 * domain (T1.4/F6 — rotation-safe drift detection, Fable B3). The relay advertises each domain as a
 * NON-EMPTY ARRAY of algorithm-prefixed strings; a rotation runs the OLD and NEW key in parallel for
 * an overlap window, so EVERY entry — not just entry[0] — is a currently-valid issuer key and must be
 * normalized, or set-membership (the whole point of T1.4) silently degrades back to an entry[0]-only
 * compare and a mid-rotation client gets hard-blocked (the swk incident, recreated from inside its own
 * fix). A bare string (an older/synthetic doc) normalizes to a single-entry array so callers never
 * special-case the shape. Returns undefined (never `[]`) when nothing survives, so a truthiness check
 * (`fps.posting &&`) still suffices.
 */
function normFingerprintSet(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : v !== undefined ? [v] : [];
  const out = raw.map(normFingerprintEntry).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}

/** A non-empty string, else undefined. Maps `''` (relay's "no such purpose key") to undefined so
 *  callers can `?? `/truthiness-check a single field instead of distinguishing '' from absent. */
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Extract supported_nips from a parsed NIP-11 relay information document. */
export function parseSupportedNips(doc: unknown): number[] {
  if (!isObject(doc)) return [];
  const nips = doc.supported_nips;
  if (!Array.isArray(nips)) return [];
  return nips.filter((n): n is number => typeof n === 'number');
}

/** Whether a NIP-11 document advertises NIP-29. */
export function supportsNip29(doc: unknown): boolean {
  return parseSupportedNips(doc).includes(29);
}

/** Parse the standard NIP-11 `limitation` object (only the fields the client uses). */
function parseLimitation(v: unknown): RelayCapabilities['limitation'] {
  if (!isObject(v)) return {};
  const out: RelayCapabilities['limitation'] = {};
  if (typeof v.max_content_length === 'number' && Number.isFinite(v.max_content_length)) {
    out.maxContentLength = v.max_content_length;
  }
  if (typeof v.max_event_tags === 'number' && Number.isFinite(v.max_event_tags)) {
    out.maxEventTags = v.max_event_tags;
  }
  if (typeof v.max_limit === 'number' && Number.isFinite(v.max_limit)) {
    out.maxLimit = v.max_limit;
  }
  return out;
}

/**
 * Parse a fetched NIP-11 information document into a {@link RelayCapabilities}. Starts from the
 * constant fallback and overlays whatever the document actually advertises; every field degrades
 * gracefully so a malformed or partial document can never throw and never regresses below today's
 * behaviour. Accepts either the hyphen (`stiq-capabilities`) or underscore (`stiq_capabilities`)
 * spelling of the stiq block.
 */
export function parseRelayCapabilities(doc: unknown): RelayCapabilities {
  const caps = defaultRelayCapabilities();
  if (!isObject(doc)) return caps;

  // Standard NIP-11: supported_nips (drives the NIP-29 gate). Keep the constant fallback when the
  // relay advertises nothing, so the gate is unchanged until a relay actually lists its NIPs.
  const nips = parseSupportedNips(doc);
  if (nips.length > 0) caps.supportedNips = nips;

  // Standard NIP-11: limitation object.
  caps.limitation = parseLimitation(doc.limitation);

  // stiq-capabilities block (either spelling). Absent/malformed → the constant fallback stands.
  const stiq = doc['stiq-capabilities'] ?? doc['stiq_capabilities'];
  if (isObject(stiq)) {
    caps.schemaVersion = numOr(stiq.schema_version, caps.schemaVersion);
    caps.rejectCodesVersion = numOr(stiq.reject_codes_version, caps.rejectCodesVersion);
    // PoW: the live relay advertises a nested `pow: {enroll, dm}` object; older/synthetic docs use the
    // flat `enroll_pow`/`dm_pow` spelling. Prefer nested, fall back to flat, then the build constant.
    const pow = isObject(stiq.pow) ? stiq.pow : undefined;
    caps.enrollPow = numOr(pow?.enroll, numOr(stiq.enroll_pow, caps.enrollPow));
    caps.dmPow = numOr(pow?.dm, numOr(stiq.dm_pow, caps.dmPow));

    if (isObject(stiq.enforced)) {
      const enforced = stiq.enforced;
      caps.enforcedFlags = {
        blindRequired: boolOr(enforced.blind_required, caps.enforcedFlags.blindRequired),
        privateGroupReadAuth: boolOr(
          enforced.private_group_read_auth,
          caps.enforcedFlags.privateGroupReadAuth,
        ),
        bytesPerToken: numOr(enforced.bytes_per_token, caps.enforcedFlags.bytesPerToken),
        // Absent/malformed → the constant fallback (false) stands, so the read meter stays dark until
        // a relay explicitly advertises `enforced.content_encryption: true`.
        contentEncryption: boolOr(enforced.content_encryption, caps.enforcedFlags.contentEncryption),
        readAuthRequired: boolOr(enforced.read_auth_required, caps.enforcedFlags.readAuthRequired),
        // Absent/malformed → false: space publishes stay tokenless until a relay explicitly
        // advertises `enforced.space_tokens_required: true` (tokens-everywhere).
        spaceTokensRequired: boolOr(
          enforced.space_tokens_required,
          caps.enforcedFlags.spaceTokensRequired,
        ),
      };
    }

    // Media write domains (Phase 4d activation): `media_write_domains: ["picture","audio"]` lists
    // each domain whose write-issuer keys the relay verifies. Absent/malformed → both false, so
    // media blobs keep paying from the post wallet against an older/unconfigured relay.
    if (Array.isArray(stiq.media_write_domains)) {
      const domains = stiq.media_write_domains.filter((d): d is string => typeof d === 'string');
      caps.mediaWriteDomains = {
        picture: domains.includes(StiqDom.Picture),
        audio: domains.includes(StiqDom.Audio),
      };
    }

    // Issuer-key fingerprints: the live relay advertises them under `issuer_key_fingerprints` (keys
    // enroll/posting/binding/space_write today, + picture/audio once T1.3 lands; values
    // `["sha256:<hex>"]` arrays); older/synthetic docs use `purpose_key_fingerprints` with bare
    // strings. Accept either container. T1.4/F6: every domain except `read` is now normalized to the
    // FULL SET of advertised entries (normFingerprintSet) so a rotation-overlap key is never mistaken
    // for stale; `read` stays the single-entry shape (its provenance leg is deferred to Phase 5 — see
    // the field doc on purposeKeyFingerprints).
    const fpBlock = stiq.issuer_key_fingerprints ?? stiq.purpose_key_fingerprints;
    if (isObject(fpBlock)) {
      caps.purposeKeyFingerprints = {
        enroll: normFingerprintSet(fpBlock[FingerprintKey.Enroll]),
        posting: normFingerprintSet(fpBlock[FingerprintKey.Posting]),
        binding: normFingerprintSet(fpBlock[FingerprintKey.Binding]),
        spaceWrite: normFingerprintSet(fpBlock[FingerprintKey.SpaceWrite]),
        picture: normFingerprintSet(fpBlock[FingerprintKey.Picture]),
        audio: normFingerprintSet(fpBlock[FingerprintKey.Audio]),
        read: normFingerprint(fpBlock[FingerprintKey.Read]),
      };
    }

    const allowed = numArrayOrUndef(stiq.allowed_kinds);
    if (allowed) caps.allowedKinds = allowed;

    // Full issuer public keys (base64 SPKI), the post-connect fetch substrate for join-code v2's
    // deferred enrollment key. The relay advertises '' for a purpose it runs no distinct key for;
    // strOrUndef normalizes that to undefined so a caller's truthiness check is enough.
    if (isObject(stiq.issuer_keys)) {
      const keys = stiq.issuer_keys;
      caps.issuerKeys = {
        enroll: strOrUndef(keys[FingerprintKey.Enroll]),
        posting: strOrUndef(keys[FingerprintKey.Posting]),
        read: strOrUndef(keys[FingerprintKey.Read]),
      };
    }

    // Real-push (T1) discovery block. Only materialized when the relay actually advertises a watcher
    // and/or ntfy onion — an absent or empty block leaves `caps.push` undefined (its default), so
    // pushEnabled()/registration stay dark on older relays. strOrUndef maps the relay's '' to
    // undefined, so a present-but-empty field never masquerades as a real endpoint.
    if (isObject(stiq.push)) {
      const push = stiq.push;
      const watcher = strOrUndef(push.watcher);
      const ntfy = strOrUndef(push.ntfy);
      if (watcher || ntfy) {
        caps.push = {watcher, ntfy};
      }
    }
  }

  return caps;
}

/** The relay's hard-enforced protocol switches — the block sticky negotiation is about. */
export type EnforcedFlags = RelayCapabilities['enforcedFlags'];

/**
 * The enforcement fields a NIP-11 document EXPLICITLY advertises — present in the stiq block's
 * `enforced` object with the right type — as a PARTIAL overlay. This is the input to the sticky
 * per-community enforcement contract (AppRuntime._stickyEnforced):
 *
 *   ONLY an explicit advertisement may change what the client believes a community enforces.
 *   Absence — a failed NIP-11 fetch, a doc with no stiq block, or a block missing a field — is
 *   NEVER a downgrade signal.
 *
 * Why this exists (2026-07-28 field bug, CONFIRMED): the constant fallback sets
 * `spaceTokensRequired: false`, and both a community switch and a cold start reset to it. In any
 * window where the relay WS is up but the NIP-11 fetch is failing (its own Tor circuit — the
 * outage's exact split-brain), a token-enforcing community received token-less space writes BY
 * DESIGN and rejected every one as "out of tokens". Distinguishing "the doc said false" from "we
 * couldn't read the doc" is exactly the information {@link parseRelayCapabilities} discards, so
 * this companion reader recovers it. The inverse hazard (attaching tokens against a non-enforcing
 * relay, which rejects token-tagged kinds) stays covered because a sticky flag only ever SETS from
 * an explicit advertisement — never from a guess.
 */
export function explicitEnforcedFlags(doc: unknown): Partial<EnforcedFlags> {
  if (!isObject(doc)) return {};
  const stiq = doc['stiq-capabilities'] ?? doc['stiq_capabilities'];
  if (!isObject(stiq) || !isObject(stiq.enforced)) return {};
  const e = stiq.enforced;
  const out: Partial<EnforcedFlags> = {};
  if (typeof e.blind_required === 'boolean') out.blindRequired = e.blind_required;
  if (typeof e.private_group_read_auth === 'boolean') {
    out.privateGroupReadAuth = e.private_group_read_auth;
  }
  if (typeof e.bytes_per_token === 'number' && Number.isFinite(e.bytes_per_token)) {
    out.bytesPerToken = e.bytes_per_token;
  }
  if (typeof e.content_encryption === 'boolean') out.contentEncryption = e.content_encryption;
  if (typeof e.read_auth_required === 'boolean') out.readAuthRequired = e.read_auth_required;
  if (typeof e.space_tokens_required === 'boolean') {
    out.spaceTokensRequired = e.space_tokens_required;
  }
  return out;
}

/**
 * Fetch + parse the relay's capabilities via an injected NIP-11 getter (the host supplies the
 * HTTP-over-Tor transport — see AppRuntimeDeps.fetchRelayInfo). Any error — offline, non-JSON,
 * malformed — resolves to the constant fallback, so a capability fetch can never break connect.
 */
export async function fetchRelayCapabilities(
  getNip11: () => Promise<unknown>,
): Promise<RelayCapabilities> {
  try {
    return parseRelayCapabilities(await getNip11());
  } catch {
    return defaultRelayCapabilities();
  }
}

/**
 * Fetch the relay's NIP-11 document via an injected getter and report NIP-29 support. The getter
 * is injected because reaching the onion relay requires an HTTP-over-Tor transport supplied by the
 * host; returns false (capability absent) on any error. Kept for back-compat with the original
 * `channels/groups` API (which now re-exports it).
 */
export async function fetchRelaySupportsNip29(
  getNip11: () => Promise<unknown>,
): Promise<boolean> {
  try {
    return supportsNip29(await getNip11());
  } catch {
    return false;
  }
}
