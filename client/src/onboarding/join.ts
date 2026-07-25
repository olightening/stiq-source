/**
 * Join code — the single, self-contained code an organizer hands a new member (PLAN.md
 * §3.3, smoother-onboarding). It bundles everything a *blank* app needs to recognize the
 * community + organizer and start enrolling, so nothing is typed and no community is baked
 * into the build:
 *
 *   stiq:join:2:<base64url-json>
 *
 * where the JSON is (v2):
 *   { v, rs, cid, i, x?, ck?, cn?, on?, op?, tp?, pk?, rk?, r?, ik?, oa? }
 *     rs = relay mirror list — `[wsOnionUrl, onionAuthKeyOrNull][]`, each relay + its onion-auth
 *          key (null = public onion). Capped at MAX_MIRRORS on parse. Absent ⇒ falls back to the
 *          legacy `r`+`oa` pair as a one-element list.
 *     cid = relay-independent community id: 16-hex `walletKeyFingerprint(enrollIssuerKey)`
 *           (../blind/wallet.ts, FROZEN). The identity pin AND the value a deferred `ik` is
 *           verified against once fetched from the relay's NIP-11 post-connect.
 *     i  = the member's single-use invite code (the "12-digit code")
 *     x  = OPTIONAL advisory expiry (unix seconds) — UX hint only, never enforced by the client.
 *     ck = shared community-key secret (base64) — STAYS INLINE this increment (see
 *          FEATURE_3_4_BUILD_CONTRACT.md; moving it to the enroll mailbox is a deferred follow-on).
 *     cn = community name        (shown so the member recognizes the community)
 *     on = organizer label       (shown so the member recognizes the organizer)
 *     op = organizer Nostr pubkey (hex) — mailbox recipient for the automated exchange
 *     pk/rk = posting/read issuer public keys (token domain separation) — still inlined.
 *     ik = issuer RSA public key (base64 DER SPKI), OPTIONAL in v2: when present it is verified
 *          against `cid`; when ABSENT the client defers resolution to a post-connect NIP-11 fetch
 *          (`issuer_keys.enroll`) and requires `cid` to verify it against. `encodeJoinCode` never
 *          emits `ik` (always produces the deferred form) — an organizer MAY still inline it.
 *     r/oa = legacy v1 relay + onion-auth key, read only when `rs` is absent (back-compat).
 *
 * v1 codes (`stiq:join:1:…`) still parse unchanged: `{ v, r, ik, i, cn?, on?, op?, tp?, ck?, oa?,
 * pk?, rk? }` with `r`+`ik` required inline (no deferral, no mirrors).
 *
 * JSON (base64url-wrapped) rather than `;`-delimited so the free-text name/label fields can
 * never break parsing. The whole code is copy-pasted or scanned as a QR — never hand-typed.
 */
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {isOnionWsUrl} from '../util/onion';
import type {Community, RelayEntry} from './community';
import {isValidAuthKeyBase32} from '../tor/onionAuth';
import {encodeTagPolicy, parseTagPolicy} from '../feed/tagPolicy';
import {decodeCommunityKey} from '../blind/communityKey';
import {walletKeyFingerprint} from '../blind/wallet';
import {validateBridgeLine} from '../tor/torSettings';
import {log} from '../util/log';

export const JOIN_PREFIX = 'stiq:join:';
/**
 * Current join-code envelope version this client EMITS. Bumped 1→2 for the unified short-link:
 * relay mirrors (`rs`), a relay-independent community id (`cid`), and a deferred (fetched
 * post-connect) enrollment issuer key. v1 stays fully PARSEABLE — only the emitted version moved.
 */
export const JOIN_VERSION = 2;
/**
 * Oldest join-code version this client still accepts. The base64url-JSON envelope started at v1
 * and stays parseable indefinitely (old QRs/mailboxes may still hand out v1 codes); the constant
 * exists so a future retirement of v1 has somewhere to live instead of a magic number.
 */
export const MIN_JOIN_VERSION = 1;

/**
 * Hard cap on the number of relay mirrors a join code's `rs` list may carry, enforced at parse
 * (extra entries are simply dropped, not rejected — see parseJoinCode). Mirrors the product decision
 * in FEATURE_3_4_BUILD_CONTRACT.md ("N (mirrors) capped at 5").
 */
export const MAX_MIRRORS = 5;

/**
 * Hard cap on the number of organizer-seeded bridge lines a join code's `br` list may carry (T14).
 * Extra lines are dropped at parse (see parseJoinCode), like `rs` at MAX_MIRRORS. Matches the user
 * custom-bridge cap in ../tor/torSettings — Tor stalls past ~32 circuits, so cap well under that.
 * Exported (like MAX_MIRRORS) so the store's normalize can re-validate against the same bound.
 */
export const MAX_SEEDED_BRIDGES = 12;

/**
 * Hard caps on inbound join-code material. A join code reaches us from attacker-controllable
 * channels — a `stiq://join` deep link any web page can fire, or a scanned QR — so the parser
 * must bound and structurally validate every field before it touches the crypto or UI layers.
 * The relay stays the final trust boundary for credential issuance; these checks stop a crafted
 * code from stressing the parser, smuggling a malformed issuer key into the blind-RSA import, or
 * injecting an oversize string into the onboarding screen.
 */
export const MAX_JOIN_CODE_LEN = 4096; // whole `stiq:join:2:<b64url>` string (fits 5 mirrors)
const MAX_ISSUER_KEY_BYTES = 2048; // decoded SPKI DER (RSA-4096 ≈ 550B; generous ceiling)
const MAX_LABEL_LEN = 200; // community name / organizer label shown in the UI
const HEX64_RE = /^[0-9a-f]{64}$/i; // Nostr pubkey: 32 bytes, lower/upper hex
const CID_RE = /^[0-9a-f]{16}$/i; // walletKeyFingerprint output: 8 bytes, lower/upper hex

/**
 * A plausibly-shaped issuer key: decodes as base64 and is within the SPKI size ceiling.
 * Exported so the sibling community-code parser (./community) can mirror the same bound.
 */
export function isPlausibleIssuerKey(b64: string): boolean {
  try {
    const bytes = base64ToBytes(b64);
    return bytes.length > 0 && bytes.length <= MAX_ISSUER_KEY_BYTES;
  } catch {
    return false;
  }
}

/**
 * Fail-closed verifier for a post-connect-fetched enrollment issuer key against the join code's
 * pinned `cid`. `cid` is `walletKeyFingerprint(issuerKeyB64)` computed by whoever mints the invite
 * (organizer); this client recomputes the SAME hash over the key it just fetched from the relay's
 * NIP-11 `issuer_keys.enroll` and requires an EXACT match before ever blinding a token against it.
 * Any falsy input (empty key, empty/undefined cid) fails closed to `false`.
 */
export function enrollKeyMatchesCid(issuerKeyB64: string, cid: string): boolean {
  return !!issuerKeyB64 && !!cid && walletKeyFingerprint(issuerKeyB64) === cid.toLowerCase();
}

/**
 * Member invite code: `STIQ-XXXX-XXXX-XXXX` — three groups of four from a no-ambiguity
 * alphabet (no I/O/0/1, matching the organizer's generator). Twelve significant characters.
 */
export const INVITE_RE = /^STIQ-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export function isInviteCode(s: string): boolean {
  return INVITE_RE.test(s.trim().toUpperCase());
}

export interface JoinCode {
  community: Community;
  inviteCode: string;
}

export type JoinResult = {ok: true; join: JoinCode} | {ok: false; error: string};

/** On-wire JSON shape (compact keys keep the QR small). */
interface JoinJson {
  v: number;
  /** v1 relay onion ws URL. Optional in v2 (superseded by `rs`; read only as its fallback). */
  r?: string;
  /** v1 issuer key, inline. Optional in v2 — absent means "resolve post-connect via `cid`". */
  ik?: string;
  i: string;
  cn?: string;
  on?: string;
  op?: string;
  /** Tag policy (compact: {ct, pin, mem}). Absent = use community defaults. */
  tp?: {ct?: string[]; pin?: boolean; mem?: boolean};
  /** Shared community key (base64) — lets the member attribute blind posts. Absent for legacy. */
  ck?: string;
  /** Shared Tor v3 onion client-auth key (base32) — reach credential for an auth-gated relay onion
   *  (lever 2). v1 only (v2 carries the per-mirror auth key inside `rs`); absent for a public onion. */
  oa?: string;
  /** Posting-token issuer public key (K_post, base64 SPKI) — token domain separation (#3/#4/#29).
   *  Absent when the organizer runs a single issuer key. */
  pk?: string;
  /** Read-token issuer public key (K_read, base64 SPKI) — read half of token domain separation.
   *  Absent when the organizer runs a single issuer key. */
  rk?: string;
  /** Per-media issuer public keys (base64 SPKI) — media token domain separation (asks #3/#4):
   *  picture-write / picture-read / audio-write / audio-read. Absent for a non-media-metered code. */
  pwk?: string;
  prk?: string;
  awk?: string;
  ark?: string;
  /** Space-write token issuer public key (base64 SPKI) — meters bound-npub space content
   *  (channels/groups/DMs). Absent when the organizer runs a single issuer key. */
  swk?: string;
  /**
   * v2: relay mirror list — `[wsOnionUrl, onionAuthKeyOrNull][]`. Falls back to `r`+`oa` as a
   * one-element list when absent (a v2 code with no mirrors of its own). Capped at MAX_MIRRORS.
   */
  rs?: Array<[string, string | null]>;
  /**
   * v2: relay-independent community id — 16-hex `walletKeyFingerprint(enrollIssuerKey)`. Pins
   * community identity across mirrors and is the verification target for a deferred `ik`.
   */
  cid?: string;
  /** v2: OPTIONAL advisory expiry, unix seconds. UX only — the client never enforces it. */
  x?: number;
  /**
   * OPTIONAL organizer-seeded obfs4/webtunnel bridge lines (no leading 'Bridge '); a zero-network
   * fallback for the webtunnel tier, which ships no bundled bridges (DEFAULT_WEBTUNNEL_BRIDGES=[]).
   * Parsed+stored even with COMMUNITY_SEEDED_BRIDGES off (harmless — ignored until App.tsx consumes
   * it in a later subtask); an OLD client just skips this unknown key, like the other optional fields.
   */
  br?: string[];
  /**
   * OPTIONAL signed in-app update repo (T9). `up` = repo `repo` dir as an http onion URL (baseUrl);
   * `uf` = repo INDEX signing cert SHA-256 (64-hex); `af` = APP signing cert SHA-256 (64-hex, a
   * DISTINCT fingerprint from `uf`); `ua` = applicationId (defaults to com.stiq.client). Only read
   * into `community.updateRepo` when `up` is present AND both pins are valid hex — a malformed pin
   * DROPS the whole repo (never fatal), like a bad seeded bridge. Parsed/stored even with APK_UPDATES
   * off (harmless — unused until App.tsx feeds it to the updater); an OLD client ignores these keys.
   */
  up?: string;
  uf?: string;
  af?: string;
  ua?: string;
}

interface TextCodec {
  encode?(input: string): Uint8Array;
  decode?(input: Uint8Array): string;
}

function utf8Encode(s: string): Uint8Array {
  const ctor = (globalThis as unknown as {TextEncoder: new () => TextCodec}).TextEncoder;
  return new ctor().encode!(s);
}

function utf8Decode(b: Uint8Array): string {
  const ctor = (globalThis as unknown as {TextDecoder: new () => TextCodec}).TextDecoder;
  return new ctor().decode!(b);
}

function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function fromBase64Url(u: string): string {
  return u.replace(/-/g, '+').replace(/_/g, '/');
}

export function encodeJoinCode(j: JoinCode): string {
  const c = j.community;
  // Mirror list: prefer the full `relays` set (v2), else fall back to the single relayUrl/
  // onionAuthKey pair — byte-identical to the pre-mirror shape for a single-relay community.
  const relayEntries: Array<[string, string | null]> =
    c.relays && c.relays.length > 0
      ? c.relays.slice(0, MAX_MIRRORS).map((r): [string, string | null] => [r.url, r.onionAuthKey ?? null])
      : [[c.relayUrl, c.onionAuthKey ?? null]];
  const json: JoinJson = {
    v: JOIN_VERSION,
    i: j.inviteCode,
    rs: relayEntries,
  };
  // Relay-independent identity id: prefer an already-pinned `cid`, else derive it from the
  // (resolved) issuer key. Intentionally does NOT emit `ik` — v2 always defers the enrollment key
  // to a post-connect NIP-11 fetch, verified against this cid (see enrollKeyMatchesCid above).
  const cid = c.cid ?? (c.issuerPublicKey ? walletKeyFingerprint(c.issuerPublicKey) : undefined);
  if (cid) {
    json.cid = cid;
  }
  if (c.name) {
    json.cn = c.name;
  }
  if (c.organizerLabel) {
    json.on = c.organizerLabel;
  }
  if (c.organizerPubkey) {
    json.op = c.organizerPubkey;
  }
  if (c.tagPolicy) {
    json.tp = encodeTagPolicy(c.tagPolicy);
  }
  if (c.communityKey) {
    json.ck = c.communityKey;
  }
  // Purpose-specific issuer keys (token domain separation, #3/#4/#29). Emitted only when present so
  // a single-issuer-key community's code is byte-identical to before. Still inlined this increment —
  // only the enrollment key (`ik`) defers to post-connect fetch.
  if (c.postIssuerPublicKey) {
    json.pk = c.postIssuerPublicKey;
  }
  if (c.readIssuerPublicKey) {
    json.rk = c.readIssuerPublicKey;
  }
  // Per-media issuer keys (asks #3/#4). Emitted only when present so a community without media domain
  // separation stays byte-identical. Same format/bound as `ik`/`pk`/`rk`.
  if (c.picWriteIssuerPublicKey) {
    json.pwk = c.picWriteIssuerPublicKey;
  }
  if (c.picReadIssuerPublicKey) {
    json.prk = c.picReadIssuerPublicKey;
  }
  if (c.audWriteIssuerPublicKey) {
    json.awk = c.audWriteIssuerPublicKey;
  }
  if (c.audReadIssuerPublicKey) {
    json.ark = c.audReadIssuerPublicKey;
  }
  if (c.spaceWriteIssuerPublicKey) {
    json.swk = c.spaceWriteIssuerPublicKey;
  }
  if (typeof c.advisoryExpiry === 'number' && Number.isFinite(c.advisoryExpiry)) {
    json.x = c.advisoryExpiry;
  }
  const b64 = bytesToBase64(utf8Encode(JSON.stringify(json)));
  return `${JOIN_PREFIX}${JOIN_VERSION}:${toBase64Url(b64)}`;
}

function err(error: string): JoinResult {
  return {ok: false, error};
}

/**
 * Resolve one raw `rs` entry into a validated {@link RelayEntry}, or `undefined` to drop it.
 * Malformed entries are DROPPED rather than failing the whole code — one bad mirror in an
 * otherwise-good list shouldn't brick the invite (mirrors the anti-censorship "never let one
 * relay sink the community" spirit). The whole-code parse only fails if EVERY mirror is dropped
 * (see parseJoinCode), so there is no reachable relay at all.
 */
function parseMirrorEntry(entry: unknown): RelayEntry | undefined {
  if (!Array.isArray(entry) || entry.length === 0) return undefined;
  const url = String(entry[0] ?? '');
  if (!isOnionWsUrl(url)) return undefined;
  const authRaw: unknown = entry.length > 1 ? entry[1] : null;
  if (authRaw === null || authRaw === undefined) {
    return {url, onionAuthKey: null};
  }
  if (typeof authRaw === 'string' && isValidAuthKeyBase32(authRaw)) {
    return {url, onionAuthKey: authRaw};
  }
  // A non-null auth key that fails validation is worse than none (a bad reach credential can
  // never connect) — fail closed on this entry rather than admit it as if public.
  return undefined;
}

/** Parse+validate the `rs` array, capping at MAX_MIRRORS BEFORE per-entry validation (bounds the
 *  work a crafted oversize array can force before any of it is checked). */
function parseMirrorList(raw: unknown): RelayEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RelayEntry[] = [];
  for (const entry of raw.slice(0, MAX_MIRRORS)) {
    const parsed = parseMirrorEntry(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** v2 relay resolution: `rs` when present, else the legacy `r`+`oa` pair as a one-element list. */
function resolveV2Relays(json: JoinJson): RelayEntry[] {
  if (Array.isArray(json.rs)) {
    return parseMirrorList(json.rs);
  }
  const r = String(json.r ?? '');
  if (!isOnionWsUrl(r)) return [];
  const oa = typeof json.oa === 'string' && isValidAuthKeyBase32(json.oa) ? json.oa : null;
  return [{url: r, onionAuthKey: oa}];
}

export function parseJoinCode(text: string): JoinResult {
  const trimmed = text.trim();
  if (trimmed.length > MAX_JOIN_CODE_LEN) {
    return err('join code is too large');
  }
  if (!trimmed.startsWith(JOIN_PREFIX)) {
    return err('not a stiq join code');
  }
  const body = trimmed.slice(JOIN_PREFIX.length);
  const sep = body.indexOf(':');
  if (sep === -1) {
    return err('malformed join code');
  }
  const version = body.slice(0, sep);
  if (!/^\d+$/.test(version)) {
    return err(`malformed join code version: ${version}`);
  }
  const versionNum = Number(version);
  if (versionNum < MIN_JOIN_VERSION) {
    return err(`unsupported join code version: ${version}`);
  }
  // Forward-compat: a code from a newer organizer/client may carry a version we don't fully know
  // yet. The envelope is JSON (see file header), so unknown keys are already harmless to parse —
  // just warn and continue reading the fields this client does know, rather than bricking on
  // every version bump the organizer makes.
  if (versionNum > JOIN_VERSION) {
    log.warn('join', `join code is v${versionNum}, newer than this client's v${JOIN_VERSION}; parsing known fields only`);
  }

  let json: JoinJson;
  try {
    json = JSON.parse(utf8Decode(base64ToBytes(fromBase64Url(body.slice(sep + 1))))) as JoinJson;
  } catch {
    return err('malformed join code');
  }
  if (!json || typeof json !== 'object') {
    return err('malformed join code');
  }

  let community: Community;
  if (versionNum >= 2) {
    // v2 (and any newer version — read via the same known-field parser, see the warn above): relay
    // mirrors + relay-independent identity, with the enrollment key resolved either inline or later
    // via a post-connect NIP-11 fetch verified against `cid`.
    const relays = resolveV2Relays(json);
    if (relays.length === 0) {
      return err('join code relay is not an onion address');
    }

    let cid: string | undefined;
    if (typeof json.cid === 'string' && json.cid) {
      if (!CID_RE.test(json.cid)) {
        return err('join code community id is malformed');
      }
      cid = json.cid.toLowerCase();
    }

    let issuerPublicKey: string;
    if (typeof json.ik === 'string' && json.ik) {
      if (!isPlausibleIssuerKey(json.ik)) {
        return err('join code issuer key is malformed');
      }
      if (cid && !enrollKeyMatchesCid(json.ik, cid)) {
        return err('join code issuer key does not match community id');
      }
      issuerPublicKey = json.ik;
    } else {
      // No inline key: this client resolves it post-connect from the relay's NIP-11
      // (issuer_keys.enroll) and verifies it against `cid` — so `cid` is the one thing that
      // MUST be present when `ik` is deferred, or there is nothing to verify the fetch against.
      if (!cid) {
        return err('join code missing issuer key');
      }
      issuerPublicKey = ''; // sentinel: deferred, resolved by the enrollment flow before blinding
    }

    community = {relayUrl: relays[0]!.url, issuerPublicKey, relays};
    if (relays[0]!.onionAuthKey) {
      community.onionAuthKey = relays[0]!.onionAuthKey;
    }
    if (cid) {
      community.cid = cid;
    }
    if (typeof json.x === 'number' && Number.isFinite(json.x)) {
      community.advisoryExpiry = json.x;
    }
  } else {
    // v1: unchanged — relay + issuer key both required inline, no mirrors, no deferral.
    const relayUrl = String(json.r ?? '');
    const issuerPublicKey = String(json.ik ?? '');
    if (!isOnionWsUrl(relayUrl)) {
      return err('join code relay is not an onion address');
    }
    if (!issuerPublicKey) {
      return err('join code missing issuer key');
    }
    if (!isPlausibleIssuerKey(issuerPublicKey)) {
      return err('join code issuer key is malformed');
    }
    community = {relayUrl, issuerPublicKey};
    // Nice-to-have: derive the same relay-independent identity id a v2 code would carry, purely
    // for display/dedup — a v1 code is never rejected for lacking it.
    community.cid = walletKeyFingerprint(issuerPublicKey);
    if (typeof json.oa === 'string' && isValidAuthKeyBase32(json.oa)) {
      community.onionAuthKey = json.oa;
    }
  }

  const inviteCode = String(json.i ?? '').toUpperCase();
  if (!isInviteCode(inviteCode)) {
    return err('join code has an invalid invite');
  }

  if (typeof json.cn === 'string' && json.cn) {
    if (json.cn.length > MAX_LABEL_LEN) {
      return err('join code community name is too long');
    }
    community.name = json.cn;
  }
  if (typeof json.on === 'string' && json.on) {
    if (json.on.length > MAX_LABEL_LEN) {
      return err('join code organizer label is too long');
    }
    community.organizerLabel = json.on;
  }
  if (typeof json.op === 'string' && json.op) {
    if (!HEX64_RE.test(json.op)) {
      return err('join code organizer key is malformed');
    }
    community.organizerPubkey = json.op;
  }
  if (json.tp) {
    const policy = parseTagPolicy(json.tp);
    if (policy) community.tagPolicy = policy;
  }
  // Shared community key (base64) — lets the member attribute blind posts (relay stays blind).
  // Mirrors the oa check below: must decode to exactly the expected 32-byte key width.
  if (typeof json.ck === 'string' && json.ck) {
    if (!decodeCommunityKey(json.ck)) {
      return err('join code community key is malformed');
    }
    community.communityKey = json.ck;
  }
  // Purpose-specific issuer keys (token domain separation, #3/#4/#29). Validated with the SAME bound
  // as `ik` (isPlausibleIssuerKey) and rejected when malformed, so a crafted code can't smuggle a bad
  // key into the blind-RSA import. Absent ⇒ the token draws fall back to `issuerPublicKey`, so an
  // older code (or a single-issuer-key community) behaves exactly as today.
  if (typeof json.pk === 'string' && json.pk) {
    if (!isPlausibleIssuerKey(json.pk)) {
      return err('join code posting issuer key is malformed');
    }
    community.postIssuerPublicKey = json.pk;
  }
  if (typeof json.rk === 'string' && json.rk) {
    if (!isPlausibleIssuerKey(json.rk)) {
      return err('join code read issuer key is malformed');
    }
    community.readIssuerPublicKey = json.rk;
  }
  // Per-media issuer keys (asks #3/#4). Validated with the SAME bound as `ik`/`pk`/`rk` and rejected
  // when malformed, so a crafted code can't smuggle a bad key into the blind-RSA import. Absent ⇒ that
  // media domain's draw falls back to `issuerPublicKey`, so an older code behaves exactly as today.
  for (const [field, prop] of [
    ['pwk', 'picWriteIssuerPublicKey'],
    ['prk', 'picReadIssuerPublicKey'],
    ['awk', 'audWriteIssuerPublicKey'],
    ['ark', 'audReadIssuerPublicKey'],
    ['swk', 'spaceWriteIssuerPublicKey'],
  ] as const) {
    const v = json[field];
    if (typeof v === 'string' && v) {
      if (!isPlausibleIssuerKey(v)) {
        return err('join code media issuer key is malformed');
      }
      community[prop] = v;
    }
  }
  // Organizer-seeded bridge lines (`br`, T14) — a zero-network fallback for the webtunnel tier,
  // which ships no bundled bridges. Each line is validated through the SAME per-line guard as a
  // user-pasted custom bridge (validateBridgeLine: obfs4/webtunnel only, control-char/length
  // rejected); snowflake/vanilla/invalid lines are dropped, the rest deduped and capped at
  // MAX_SEEDED_BRIDGES. Only assigned when at least one line survives, so an absent/all-invalid
  // `br` leaves community.seededBridges undefined (never an empty array). Unlike the crypto fields
  // above, a malformed line is DROPPED rather than failing the whole code — a bad seeded bridge is
  // an unusable reach hint, never a reason to brick an otherwise-good invite.
  if (Array.isArray(json.br)) {
    const seeded = [
      ...new Set(
        json.br
          .map(line => String(line ?? '').trim())
          .filter(line => {
            const kind = validateBridgeLine(line);
            return kind === 'obfs4' || kind === 'webtunnel';
          }),
      ),
    ].slice(0, MAX_SEEDED_BRIDGES);
    if (seeded.length > 0) {
      community.seededBridges = seeded;
    }
  }
  // Signed in-app update repo (`up`/`uf`/`af`/`ua`, T9). Only assembled when `up` (the repo baseUrl)
  // is present. The two cert pins (`uf` = index-signing, `af` = app-signing) are each normalized to
  // lowercase and must be 64-char hex — a malformed pin DROPS the whole repo (never fatal), exactly
  // like a bad seeded bridge above: an update repo is an optional convenience, never a reason to
  // brick an otherwise-good invite. `ua` (applicationId) defaults to the standard package id. Absent
  // `up` ⇒ community.updateRepo stays undefined; an OLD client just skips these unknown keys.
  if (typeof json.up === 'string' && json.up) {
    const uf = typeof json.uf === 'string' ? json.uf.trim().toLowerCase() : '';
    const af = typeof json.af === 'string' ? json.af.trim().toLowerCase() : '';
    if (HEX64_RE.test(uf) && HEX64_RE.test(af)) {
      community.updateRepo = {
        baseUrl: json.up,
        certSha256: uf,
        appCertSha256: af,
        applicationId: typeof json.ua === 'string' && json.ua ? json.ua : 'com.stiq.client',
      };
    }
  }
  return {ok: true, join: {community, inviteCode}};
}
