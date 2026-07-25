/**
 * Community bootstrap payload (PLAN.md §3.3). A NON-secret QR a new member scans to learn
 * which relay to use, which issuer to trust, and (v2) which organizer key roots moderation.
 * It contains no secret key material.
 *
 *   v1: stiq:community:1;<relay-onion-ws-url>;<issuer-rsa-public-key-base64-DER>
 *   v2: stiq:community:2;<relay-onion-ws-url>;<issuer-rsa-public-key-base64-DER>;<organizer-npub>
 *   v3: stiq:community:3;<relay-onion-ws-url>;<issuer-rsa-public-key-base64-DER>;<organizer-npub>;<community-key-base64>
 *   v4: stiq:community:4;<relay>;<issuer>;<organizer-npub>;<community-key-base64>;<onion-auth-key-base32>
 *
 * The organizer npub is the moderation root of trust: clients honor a dynamic moderator
 * roster and rate-limit policy only when signed by this key (see moderation/organizerConfig).
 * v3 additionally carries the shared community key — the membership secret every member holds to
 * attribute blind posts locally while the relay/host stays blind (see blind-posting, branch
 * claude/unruffled-ritchie-32f612). It is NOT a signing key; it decrypts attribution only.
 * v4 additionally carries the community's shared Tor v3 onion client-auth PRIVATE key (lever 2):
 * the credential a member's device needs to REACH the relay onion at all, so an outsider who only
 * learns the `.onion` address cannot connect (see ../tor/onionAuth, deploy/stiq-up.sh). Like the
 * community key it is a shared membership secret, not a per-member/signing key.
 *
 * NOTE: from v3 on the community code carries secret key material — it is a membership credential,
 * not a public QR. Treat it as a secret (deliver it over the enrollment mailbox / a private channel).
 */
import {isOnionWsUrl} from '../util/onion';
import {isValidAuthKeyBase32} from '../tor/onionAuth';
import type {TagPolicy} from '../feed/tagPolicy';
import {isPlausibleIssuerKey} from './join';
import {decodeCommunityKey} from '../blind/communityKey';
import {log} from '../util/log';

export const COMMUNITY_PREFIX = 'stiq:community:';
/** Version emitted by encodeCommunity. v1–v4 codes are all accepted on parse. */
export const COMMUNITY_VERSION = '4';
/**
 * Oldest community-code version this client still accepts. There is no version below v1 today;
 * the constant exists so a future retirement of an old version has somewhere to live.
 */
const MIN_SUPPORTED_VERSION = 1;
/**
 * Newest version whose fields this client fully understands — the 6 known positional slots
 * (version;relay;issuer;organizer-npub;community-key;onion-auth-key). This is a RANGE check, not
 * an exact-set membership check: a code with a version ABOVE this, or with EXTRA positional fields
 * past onion-auth-key, still parses — the known leading positions are read and everything past
 * them is ignored — rather than being rejected, so the organizer can bump the format without
 * bricking clients that haven't upgraded. Below MIN_SUPPORTED_VERSION (or a non-numeric version)
 * is still rejected as unsupported/malformed.
 *
 * future: converge the community code onto the join-code base64url-JSON envelope (./join), which
 * is already field-forward-compatible by construction — that needs a coordinated organizer change
 * so it's out of scope for this client-only widening.
 */
const MAX_KNOWN_VERSION = 4;

/**
 * Hard cap on the whole `stiq:community:…` string. Like a join code (see ./join), a community
 * code is attacker-reachable wherever it is offered on a scan/deep-link surface, so the parser
 * bounds it before touching the crypto/UI layers. Mirrors MAX_JOIN_CODE_LEN.
 */
const MAX_COMMUNITY_CODE_LEN = 4096;

/**
 * One relay mirror + its onion-auth reach credential (join-code v2 `rs` entry). `onionAuthKey` is
 * `null` for a public onion (no client-auth required), a base32 key for an auth-gated one, or
 * absent entirely on a mirror the client never resolved an auth key for.
 */
export interface RelayEntry {
  url: string;
  onionAuthKey?: string | null;
}

/**
 * Signed in-app update repo (T9), carried by a join code's `up`/`uf`/`af`/`ua` fields. Structurally
 * identical to (and assignable to) the updater's `UpdateRepoConfig` — kept defined here at the
 * onboarding layer so parseJoinCode can populate it with no dependency on the update module. Absent
 * when the organizer ships no repo; the whole object is only ever set when `up` is present AND both
 * cert pins are valid 64-hex (see parseJoinCode).
 */
export interface UpdateRepo {
  /** Repo `repo` dir as an http onion URL (join `up`). */
  baseUrl: string;
  /** PINNED SHA-256 (lower-hex) of the repo INDEX signing cert (join `uf`). */
  certSha256: string;
  /** PINNED SHA-256 (lower-hex) of the APP signing cert (join `af`). */
  appCertSha256: string;
  /** applicationId this build is (and the only package it will install) — join `ua`. */
  applicationId: string;
}

export interface Community {
  /** Primary relay (join-code v2: `relays[0].url`; v1: the single carried relay). */
  relayUrl: string;
  /**
   * Issuer RSA public key, base64 DER (SPKI), of the *single organizer who issued the
   * invite*. Opaque here; imported by the blind-RSA lib. A community may trust multiple
   * organizers, but a given member blinds their token against exactly one — the relay holds
   * the full trusted issuer set (relay `IssuerPublicKeys`), so the client never needs a list.
   *
   * SENTINEL: `''` means the key is DEFERRED — a join-code v2 that carried `cid` but no inline
   * `ik`. The enrollment flow resolves the real key post-connect from the relay's NIP-11
   * (`issuer_keys.enroll`), verifies it against `cid` (see ./join `enrollKeyMatchesCid`), and
   * only then may this field be treated as usable. Never blind/enroll against `''`.
   */
  issuerPublicKey: string;
  /**
   * Relay-independent community id (join-code v2 `cid`): 16-hex `walletKeyFingerprint` of the
   * enrollment issuer key. Stable across mirrors/relay changes — used for identity display/dedup
   * and as the verification target for a deferred `issuerPublicKey`. Absent for a v1 code that
   * predates it (though parseJoinCode derives one for display even there — see ./join).
   */
  cid?: string;
  /**
   * Full relay mirror list carried by a join-code v2 `rs` (capped at MAX_MIRRORS). `relayUrl`
   * mirrors `relays[0].url` for back-compat with single-relay code paths; this is the ADDITIVE
   * discovery source future write-fanout (P2) will read. Absent for a v1 code (single relay only).
   */
  relays?: RelayEntry[];
  /**
   * OPTIONAL advisory expiry (join-code v2 `x`, unix seconds) — UX only ("this invite may have
   * expired"), NEVER enforced client-side. Absent when the organizer set no expiry (default).
   */
  advisoryExpiry?: number;
  /** Human-readable community name, shown so a new member recognizes the community. */
  name?: string;
  /** Human-readable organizer label, shown so a new member recognizes the organizer. */
  organizerLabel?: string;
  /**
   * The organizer's Nostr public key (hex), used to address the credential-exchange mailbox
   * (Part B) and to verify live kind-30078 config (tag policy). Absent for legacy
   * `stiq:community:1;…` bootstraps that predate the mailbox.
   */
  organizerPubkey?: string;
  /** Tag policy set by the organizer (embedded in the join code; updated live via kind-30078). */
  tagPolicy?: TagPolicy;
  /** Organizer npub (community-code v2 only). Moderation/limits trust root; absent for v1 codes. */
  organizerNpub?: string;
  /**
   * Shared community key (base64, 32 bytes), community-code v3 only. Every member holds it and
   * uses it to decrypt blind-post attribution — so members attribute posts while the relay/host
   * stays blind. It is the community's membership secret; absent for v1/v2 codes (no blind posts).
   */
  communityKey?: string;
  /**
   * Shared Tor v3 onion client-auth PRIVATE key (unpadded uppercase base32, 52 chars),
   * community-code v4 only. The credential every member's device uses to REACH the relay onion;
   * without it the onion descriptor won't even resolve, so a non-member who only knows the address
   * cannot connect (see ../tor/onionAuth). A shared, npub-blind reach credential — absent for
   * v1–v3 codes (public onion).
   */
  onionAuthKey?: string;
  /**
   * Posting-token issuer RSA public key (K_post), base64 SPKI — token domain separation (#3/#4/#29).
   * When the organizer runs distinct purpose keys (STIQ_TOKEN_DOMAIN_SEP), per-post tokens are
   * blind-signed under K_post (NOT the enrollment key K_enroll = `issuerPublicKey`), so a drawn
   * posting token can never be replayed as a membership-binding credential. Same format/bound as
   * `issuerPublicKey` (validated with `isPlausibleIssuerKey`). Surfaced by the organizer as the join
   * code's `pk` field (see ./join); the positional community code does not carry it, mirroring how
   * `organizerPubkey`/`tagPolicy` are join-code-only. ABSENT ⇒ the draw falls back to `issuerPublicKey`
   * (single-key deployment), byte-identical to the pre-domain-separation behaviour.
   */
  postIssuerPublicKey?: string;
  /**
   * Read-token issuer RSA public key (K_read), base64 SPKI — the read half of token domain
   * separation (#29). Read-unlock tokens (spent at kind 9026, see ../blind/readUnlock) are
   * blind-signed under K_read so a posting token or membership credential can't satisfy the read
   * meter. Surfaced as the join code's `rk` field. ABSENT ⇒ read draws fall back to `issuerPublicKey`.
   */
  readIssuerPublicKey?: string;
  /**
   * Per-media token issuer RSA public keys (K_picwrite / K_picread / K_audwrite / K_audread), base64
   * SPKI — the media half of token domain separation (asks #3/#4). Pictures and audio each get an
   * independent WRITE budget (pays to attach the media) and READ budget (pays to unlock a sealed
   * picture / play a sealed clip); each is blind-signed under its own key so a token from one media
   * domain can never be spent in another (nor as a post/enroll token). Surfaced as the join code's
   * `pwk`/`prk`/`awk`/`ark` fields. ABSENT ⇒ that domain's draw falls back to `issuerPublicKey`,
   * byte-identical to a single-issuer-key community.
   */
  picWriteIssuerPublicKey?: string;
  picReadIssuerPublicKey?: string;
  audWriteIssuerPublicKey?: string;
  audReadIssuerPublicKey?: string;
  /**
   * Space-write token issuer RSA public key (K_spacewrite), base64 SPKI — the tokens-everywhere
   * extension. Space-write tokens meter writes into the bound-npub kinds the blind path deliberately
   * excludes (channel messages, group chat/replies, DM gift-wraps): the event stays signed by the
   * member's npub (role gating + attribution intact) but must ALSO spend blind tokens, so every form
   * of content shares the same anti-spam economics. A WRITE domain — draws carry no reader-auth, so
   * they stay anonymous/uncensorable exactly like posting-token draws. Surfaced as the join code's
   * `swk` field. ABSENT ⇒ space-write draws fall back to `issuerPublicKey`.
   */
  spaceWriteIssuerPublicKey?: string;
  /**
   * Organizer-seeded obfs4/webtunnel bridge lines (join-code `br`, T14), no leading 'Bridge '. A
   * zero-network fallback for the webtunnel tier, which ships no bundled bridges
   * (DEFAULT_WEBTUNNEL_BRIDGES=[]) and otherwise silently skips its ladder rung when the moat is
   * blocked. Validated (obfs4/webtunnel only), deduped, and capped by parseJoinCode. Absent ⇒ the
   * cascade behaves exactly as today. Consumed (behind COMMUNITY_SEEDED_BRIDGES) by App.tsx
   * resolveBridges — a separate subtask; parsing/storing it here is harmless with the flag off.
   */
  seededBridges?: string[];
  /**
   * Signed in-app update repo (T9, join-code `up`/`uf`/`af`/`ua`). The trust anchor App.tsx feeds to
   * the updater (checkForUpdate/downloadAndInstall) for the Settings "App updates" section. Parsed +
   * validated by parseJoinCode (only set when `up` is present and both cert pins are 64-hex); absent
   * when the organizer ships no repo. Inert unless APK_UPDATES is on — an old client ignores the
   * unknown join keys entirely (forward-compat), so storing it is harmless with the flag off.
   */
  updateRepo?: UpdateRepo;
}

export type CommunityResult =
  | {ok: true; community: Community}
  | {ok: false; error: string};

export function encodeCommunity(c: Community): string {
  // v4 additionally carries the onion client-auth key (6th field); emit it only when the organizer
  // npub, community key AND auth key are all present so the positional format stays unambiguous.
  if (c.organizerNpub && c.communityKey && c.onionAuthKey) {
    return `${COMMUNITY_PREFIX}4;${c.relayUrl};${c.issuerPublicKey};${c.organizerNpub};${c.communityKey};${c.onionAuthKey}`;
  }
  // v3 carries the community key (5th field); emit it only when both the organizer npub and the
  // key are present, so the positional format stays unambiguous. Otherwise emit a v2 code.
  if (c.organizerNpub && c.communityKey) {
    return `${COMMUNITY_PREFIX}3;${c.relayUrl};${c.issuerPublicKey};${c.organizerNpub};${c.communityKey}`;
  }
  const base = `${COMMUNITY_PREFIX}2;${c.relayUrl};${c.issuerPublicKey}`;
  return c.organizerNpub ? `${base};${c.organizerNpub}` : base;
}

export function parseCommunity(text: string): CommunityResult {
  const trimmed = text.trim();
  if (trimmed.length > MAX_COMMUNITY_CODE_LEN) {
    return {ok: false, error: 'community code is too large'};
  }
  if (!trimmed.startsWith(COMMUNITY_PREFIX)) {
    return {ok: false, error: 'not a stiq community code'};
  }
  // Known leading positions only (v1's relay/issuer through v4's onion-auth-key). Destructuring a
  // longer `parts` array simply leaves anything past onionAuthKey unread, so a newer code with
  // extra trailing positional fields is tolerated (forward-compat) rather than rejected.
  const parts = trimmed.slice(COMMUNITY_PREFIX.length).split(';');
  const [versionStr, relayUrl, issuerPublicKey, organizerNpub, communityKey, onionAuthKey] = parts;
  if (!versionStr || !/^\d+$/.test(versionStr)) {
    return {ok: false, error: `malformed community version: ${versionStr ?? ''}`};
  }
  const version = Number(versionStr);
  if (version < MIN_SUPPORTED_VERSION) {
    return {ok: false, error: `unsupported community version: ${versionStr}`};
  }
  if (version > MAX_KNOWN_VERSION) {
    log.warn('community', `community code is v${version}, newer than known v${MAX_KNOWN_VERSION}; parsing known fields only`);
  }
  if (relayUrl === undefined || issuerPublicKey === undefined) {
    return {ok: false, error: 'malformed community code'};
  }
  if (!isOnionWsUrl(relayUrl)) {
    return {ok: false, error: 'community relay is not an onion address'};
  }
  if (!issuerPublicKey) {
    return {ok: false, error: 'community code missing issuer key'};
  }
  if (!isPlausibleIssuerKey(issuerPublicKey)) {
    return {ok: false, error: 'community code issuer key is malformed'};
  }
  if (organizerNpub !== undefined && organizerNpub !== '' && !organizerNpub.startsWith('npub1')) {
    return {ok: false, error: 'community organizer key is not an npub'};
  }
  if (communityKey !== undefined && communityKey !== '' && !decodeCommunityKey(communityKey)) {
    return {ok: false, error: 'community code community key is malformed'};
  }
  if (onionAuthKey !== undefined && onionAuthKey !== '' && !isValidAuthKeyBase32(onionAuthKey)) {
    return {ok: false, error: 'community onion auth key is malformed'};
  }
  const community: Community = {relayUrl, issuerPublicKey};
  if (organizerNpub) {
    community.organizerNpub = organizerNpub;
  }
  if (communityKey) {
    community.communityKey = communityKey;
  }
  if (onionAuthKey) {
    community.onionAuthKey = onionAuthKey;
  }
  return {ok: true, community};
}
