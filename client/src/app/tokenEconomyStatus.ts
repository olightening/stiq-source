/**
 * Token/economy status — read-only diagnostic view (T5.1/F18).
 *
 * F18: there was no wallet/economy status surface anywhere — AppSnapshot had no wallet field,
 * walletBalance() was dead code (test-only), and the diagnostic ring buffer (util/log.ts) had zero
 * production consumers. So when a user reported "my messages won't send," nothing distinguished
 * draw-side (wallet empty, key drift) from spend-side (relay reject). This module holds the shape of
 * the fix and its pure pieces: given already-computed inputs (the negotiated RelayCapabilities, this
 * device's own per-domain issuer-key fingerprints, the per-purpose wallet counts, and a slice of the
 * log ring buffer), it builds the read-only status view. AppRuntime (buildTokenEconomyStatus) supplies
 * those stateful inputs and wires the result onto AppSnapshot.tokenStatus — see AppRuntime.ts.
 *
 * A LEAF module: imports only the RelayCapabilities/LogEntry TYPES and the FingerprintKey contract
 * constant, so every function here is unit-testable with plain object fixtures — no AppRuntime, no
 * SecureStorage, no Tor transport, no store.
 *
 * READ-ONLY / NO SECRETS (by construction, not just convention): every field this module produces is
 * either a count, a PUBLIC issuer-key fingerprint (already advertised by the relay's NIP-11 document
 * and already carried in the invite — never a token, a blinding secret, or a signing key), a domain
 * name, or a calm log message already written elsewhere. Nothing here can leak a bearer token, a
 * holder-proof secret, or a private key, because none of those ever flow into its inputs.
 */
import type {RelayCapabilities} from '../nostr/capabilities';
import type {LogEntry, LogLevel} from '../util/log';
import {FingerprintKey} from '../contracts';

/**
 * Per-purpose unspent token counts (T4.2 TokenPool + the posting wallet) — the "is the wallet
 * actually empty?" half of F18. `post` is AppRuntime's own posting wallet (kept outside the pool by
 * design — see tokenPool.ts's module header); the rest are the six TokenPool-pooled auxiliary
 * purposes. Field names are the camelCase mirror of the wire `Purpose` vocabulary (contracts/index.ts,
 * T4.1): `spaceWrite` ~ `Purpose.SpaceWrite`, `pictureWrite` ~ `Purpose.PictureWrite`, etc.
 */
export interface TokenWalletCounts {
  post: number;
  read: number;
  pictureWrite: number;
  pictureRead: number;
  audioWrite: number;
  audioRead: number;
  spaceWrite: number;
}

/** Every count is zero and no purpose has been refreshed yet — the pre-first-refresh default (also
 *  the shape of a runtime with no wallets at all, e.g. no secure storage). */
export const EMPTY_TOKEN_WALLET_COUNTS: TokenWalletCounts = {
  post: 0,
  read: 0,
  pictureWrite: 0,
  pictureRead: 0,
  audioWrite: 0,
  audioRead: 0,
  spaceWrite: 0,
};

/** One wallet-count row paired with whether the relay has actually switched this purpose's gate on.
 *  An empty count on an INACTIVE domain (e.g. audio-write before media_write_domains advertises it)
 *  is expected and not a signal of anything; an empty count on an ACTIVE domain is the actionable one
 *  — this is the annotation that lets the debug screen tell the two apart at a glance. */
export interface TokenWalletRow {
  purpose: keyof TokenWalletCounts;
  count: number;
  active: boolean;
}

/** Whether a given purpose's relay-enforced gate is currently on. `post` has no on/off gate of its
 *  own (posting either blind-signs under the community's config or it doesn't — that's independent of
 *  any single relay flag), so it is always reported active — the perpetual baseline domain.
 *  `pictureRead`/`audioRead` have no consumption path anywhere in the app (F12) and are always
 *  reported inactive: nothing will ever spend them regardless of what the relay advertises. */
function purposeActive(purpose: keyof TokenWalletCounts, caps: RelayCapabilities): boolean {
  switch (purpose) {
    case 'post':
      return true;
    case 'read':
      return caps.enforcedFlags.contentEncryption;
    case 'pictureWrite':
      return caps.mediaWriteDomains.picture;
    case 'pictureRead':
      return false;
    case 'audioWrite':
      return caps.mediaWriteDomains.audio;
    case 'audioRead':
      return false;
    case 'spaceWrite':
      return caps.enforcedFlags.spaceTokensRequired;
  }
}

/** Display order for the wallet-count table — posting first (the oldest/baseline domain), then
 *  space-write (tokens-everywhere, the domain most likely to be live in prod today), then the
 *  content-encryption/media domains (still dark in every deployment as of T5.1). */
const WALLET_PURPOSE_ORDER: readonly (keyof TokenWalletCounts)[] = [
  'post',
  'spaceWrite',
  'read',
  'pictureWrite',
  'pictureRead',
  'audioWrite',
  'audioRead',
];

/** Build the per-purpose row view (count + whether its relay gate is on) from raw counts. Pure —
 *  no storage, no network, no mutation. */
export function computeWalletRows(counts: TokenWalletCounts, caps: RelayCapabilities): TokenWalletRow[] {
  return WALLET_PURPOSE_ORDER.map(purpose => ({
    purpose,
    count: counts[purpose],
    active: purposeActive(purpose, caps),
  }));
}

/**
 * C5's per-domain provisioning verdict (T1.4 rotation-safe set compare, mirrors
 * AppRuntime.verifyCommunityProvisioning's compare exactly — see {@link domainVerdict}'s doc for why
 * this is an independent copy rather than a shared call):
 *   - 'ok'      this device's own key for the domain matches (any entry of) what the relay currently
 *               advertises — including a non-first array entry, which just means a rotation is
 *               mid-overlap, not a problem.
 *   - 'stale'   this device's key matches NONE of the relay's advertised entries — the swk failure
 *               mode: a mis-provisioned or stale invite that will fail every spend on this domain.
 *   - 'unknown' nothing to compare: the relay is silent on this domain (older relay / not yet
 *               provisioned) or this community/build carries no key for it. Not a problem, just
 *               nothing to check yet.
 */
export type ProvisioningVerdict = 'ok' | 'stale' | 'unknown';

export interface TokenDomainStatus {
  /** NIP-11 `issuer_key_fingerprints` key (the FingerprintKey vocabulary — snake_case, distinct from
   *  the wire `purpose` string; Appendix A: fingerprint key `posting` vs. purpose `post`). */
  domain: string;
  /** Whether the relay advertised any fingerprint at all for this domain. */
  advertised: boolean;
  /** How many currently-valid keys the relay advertises for this domain (>1 = mid-rotation overlap
   *  window; T1.4/B3). 0 when the relay advertised nothing. */
  relayKeyCount: number;
  /** This device's own active issuer-key fingerprint for the domain, if any. PUBLIC (see module doc)
   *  — a truncated sha256 of the issuer's public key, already carried in the invite. */
  walletFingerprint?: string;
  verdict: ProvisioningVerdict;
}

/** This device's own active per-domain issuer-key fingerprints, named by FingerprintKey so the two
 *  wire vocabularies (purpose vs. fingerprint key) never get crossed in this module. Supplied by
 *  AppRuntime from its activePostKeyFp/activeSpaceWriteKeyFp/activePictureWriteKeyFp/
 *  activeAudioWriteKeyFp/activeReadKeyFp fields (the same fields rebindPurposeKeyFingerprints binds). */
export interface WalletFingerprints {
  posting?: string;
  spaceWrite?: string;
  picture?: string;
  audio?: string;
  read?: string;
}

/**
 * A wallet key is STALE iff it prefix-matches NONE of the relay's advertised entries for that domain
 * — mirrors AppRuntime.verifyCommunityProvisioning's rotation-safe set compare (T1.4/F6, pinned shape
 * per Fable B3) byte-for-byte. Kept as an INDEPENDENT copy (not a shared helper extracted out of
 * verifyCommunityProvisioning) on purpose: that method is the actual enforcement gate for whether
 * posting is blocked, and this module is a purely-descriptive read-only status view with its own,
 * separate test coverage — the two must never be coupled such that a display-only change could ever
 * perturb the enforcement path. If the wire fingerprint compare ever changes, update BOTH copies (see
 * AppRuntime.verifyCommunityProvisioning for the full wire-format contract doc).
 */
function domainVerdict(
  relayEntries: string[] | undefined,
  walletFingerprint: string | undefined,
): ProvisioningVerdict {
  if (!relayEntries || relayEntries.length === 0 || !walletFingerprint) return 'unknown';
  const matchesSome = relayEntries.some(relay => relay.slice(0, walletFingerprint.length) === walletFingerprint);
  return matchesSome ? 'ok' : 'stale';
}

/** Build the per-domain provisioning table (T1.4/C5) — every relay-enforced write domain this build
 *  tracks a fingerprint for, each independently verdicted. Richer than AppRuntime's own
 *  `_communityKeyError` (which only remembers the FIRST mismatch its if/else-if chain finds): this
 *  shows every domain's status side by side, so e.g. a space-write AND a picture-write mismatch are
 *  both visible instead of only the first one found. `read`'s relay fingerprint is still the
 *  single-string legacy shape (its SET-widening provenance leg is deferred to Phase 5/T5.2) — normalized
 *  here to a one-entry array so this table can treat every domain uniformly. Pure — no storage, no
 *  network, no mutation. */
export function computeDomainStatuses(caps: RelayCapabilities, wallet: WalletFingerprints): TokenDomainStatus[] {
  const fps = caps.purposeKeyFingerprints;
  const rows: {domain: string; relayEntries: string[] | undefined; walletFingerprint: string | undefined}[] = [
    {domain: FingerprintKey.Posting, relayEntries: fps.posting, walletFingerprint: wallet.posting},
    {domain: FingerprintKey.SpaceWrite, relayEntries: fps.spaceWrite, walletFingerprint: wallet.spaceWrite},
    {domain: FingerprintKey.Picture, relayEntries: fps.picture, walletFingerprint: wallet.picture},
    {domain: FingerprintKey.Audio, relayEntries: fps.audio, walletFingerprint: wallet.audio},
    {domain: FingerprintKey.Read, relayEntries: fps.read ? [fps.read] : undefined, walletFingerprint: wallet.read},
  ];
  return rows.map(({domain, relayEntries, walletFingerprint}) => ({
    domain,
    advertised: !!relayEntries && relayEntries.length > 0,
    relayKeyCount: relayEntries?.length ?? 0,
    walletFingerprint,
    verdict: domainVerdict(relayEntries, walletFingerprint),
  }));
}

/** One entry from the diagnostic ring buffer (util/log.ts), narrowed to a token-relevant scope. */
export interface RecentTokenFailure {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
}

/** util/log.ts scopes that are meaningfully token/wallet/provisioning-related — deliberately excludes
 *  e.g. 'relay' (subscription/NOTICE plumbing) so this panel stays about "why won't my message send"
 *  rather than drowning in unrelated diagnostic noise. 'wallet' covers draw/spend exhaustion, 'draw'
 *  covers staged-draw resume/abandon, 'caps' covers C5 provisioning, 'media' covers media-token routing
 *  fallbacks. */
const TOKEN_LOG_SCOPES: ReadonlySet<string> = new Set(['wallet', 'draw', 'caps', 'media']);

/** The most recent (up to `limit`) token-relevant, non-info log entries, newest-first (the ring
 *  buffer itself is oldest-first). Pure — a plain array in, a plain array out. */
export function filterTokenFailures(entries: readonly LogEntry[], limit = 20): RecentTokenFailure[] {
  return entries
    .filter(e => e.level !== 'info' && TOKEN_LOG_SCOPES.has(e.scope))
    .slice(-limit)
    .reverse()
    .map(e => ({ts: e.ts, level: e.level, scope: e.scope, message: e.msg}));
}

/** The whole read-only status view — AppSnapshot.tokenStatus (T5.1/F18). */
export interface TokenEconomyStatus {
  wallets: TokenWalletCounts;
  /** Precomputed row view pairing each wallet's count with whether its relay gate is on — see
   *  {@link computeWalletRows}. */
  walletRows: readonly TokenWalletRow[];
  /** Precomputed per-domain C5 provisioning table — see {@link computeDomainStatuses}. */
  domains: readonly TokenDomainStatus[];
  /** Mirrors AppRuntime's own C5 verdict verbatim — the exact reason posting is currently BLOCKED, if
   *  any (undefined = provisioning is fine, or below the enforcement schema threshold). */
  communityKeyError: string | undefined;
  /** Most recent token-relevant diagnostic log entries, newest-first — see {@link filterTokenFailures}. */
  recentFailures: readonly RecentTokenFailure[];
}

/** The pre-first-refresh / no-runtime-yet default — every count zero, no domains/failures known.
 *  Used by App.tsx's pre-init fallback AppSnapshot; the real runtime always supplies a populated
 *  status via AppRuntime.buildTokenEconomyStatus. */
export const EMPTY_TOKEN_STATUS: TokenEconomyStatus = {
  wallets: EMPTY_TOKEN_WALLET_COUNTS,
  walletRows: [],
  domains: [],
  communityKeyError: undefined,
  recentFailures: [],
};
