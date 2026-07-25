/**
 * Epoch-token draw over Tor (PLAN.md §3.6). Fills the member's wallet with blind posting tokens
 * without ever revealing which npub is drawing.
 *
 *   member ──kind 9024 (credential + N blinded tokens, NIP-44 to organizer)──▶ relay mailbox
 *   organizer ◀──pickup── verify credential + epoch quota ── blind-sign batch ──
 *   organizer ──kind 9025 (N blind sigs, NIP-44 to reply key)──▶ relay mailbox
 *   member ◀──pickup── unblind ──▶ N wallet tokens
 *
 * Unlinkability: the request is signed by a throwaway EPHEMERAL key (never the posting npub) and
 * the reply is addressed to a second throwaway key. The membership proof is the enrollment
 * CREDENTIAL — itself blind-signed, so the organizer can verify "a real member is drawing" and
 * count draws per credential per epoch, WITHOUT learning which member. And because the posting
 * tokens are blind-signed too, the organizer cannot later link a spent token back to this draw.
 *
 * Token domain separation (#3/#4/#29): the tokens this draw MINTS are blinded under a purpose key —
 * `postIssuerPublicKey` (K_post) for posting tokens, `readIssuerPublicKey` (K_read) for read tokens
 * (see `purpose` in DrawOptions) — while the CREDENTIAL that authorizes the draw stays the K_enroll
 * enrollment credential. So a drawn posting token can never be replayed as a membership binding, and
 * a posting token can't satisfy the read meter. When the community carries no purpose key (domain
 * separation off / older join code) both fall back to `issuerPublicKey`, unchanged from before.
 *
 * RELIABILITY over Tor (the whole point of the wallet is that it refills invisibly): the draw runs
 * right after a relay (re)connect — a laggy moment where a fresh onion circuit can be slow to open
 * or drop a frame. A single one-shot round-trip therefore fails often enough that a well-meaning
 * member sees an empty wallet. So we RETRY: one signed request + one reply key are built ONCE and
 * replayed across several fresh sockets. This is safe because kinds 9024/9025 are *stored* relay
 * events —
 *   • a lost RESPONSE is recovered by re-subscribing with the same reply key: the relay replays the
 *     9025 the organizer already stored (no re-draw, so no wasted epoch quota), and
 *   • a lost REQUEST is recovered by resending the same event: the organizer dedupes by event id,
 *     so it processes (and charges the quota for) the draw exactly once no matter how many times we
 *     resend.
 *
 * QUOTA CAP: if the organizer's per-epoch allowance is smaller than the batch we asked for (an
 * operator lowered the community's token quota below the draw batch), it replies with a `cap` — the
 * largest batch this credential may still draw. We re-blind that many and retry, so a low quota
 * shrinks the draw instead of BRICKING the wallet; a cap of 0 (allowance spent) resolves to an empty
 * draw, never an error.
 *
 * Mirrors onboarding/exchange.ts (same dedicated-socket + PoW + NIP-44 mailbox pattern).
 */
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import type {BlindRsaClient} from '../onboarding/blindrsa';
import type {Community} from '../onboarding/community';
import {mineEventPow} from '../dm/nip13';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {sha256Hex} from '../util/hash';
import {utf8ToBytes} from '@noble/hashes/utils.js';
import type {RelaySocket} from '../nostr/socket';
import {reqMessage, eventMessage, closeMessage, parseRelayMessage} from '../nostr/protocol';
import {KIND_DRAW_REQUEST, KIND_DRAW_RESPONSE, MAILBOX_TTL_SECONDS, Purpose, DrawErrorCode} from '../contracts';
import {CAPS_SCHEMA_ERROR_CODES} from '../nostr/capabilities';
import {newTokenKeypair} from './holderProof';
import type {Token} from './wallet';
import type {MediaPurpose} from './tokenPool';

// Draw request/response kinds are owned by the contract module; re-exported for existing importers.
export {KIND_DRAW_REQUEST, KIND_DRAW_RESPONSE};

/**
 * Which purpose a draw MINTS (token domain separation, asks #3/#4/#29). Each maps to its own issuer
 * key so a token from one domain can never be replayed in another. The string values are the WIRE
 * `purpose` the organizer's `signKeyByPurpose` map keys on — they MUST match verbatim. Sourced from
 * the shared {@link Purpose} registry (contracts/index.ts, T4.1) so this union can never drift from it.
 */
export type DrawPurpose = typeof Purpose.Post | typeof Purpose.Read | MediaPurpose | typeof Purpose.SpaceWrite;

/** The READ-family purposes (content-read + media-read). These meter READING, so they carry a
 *  member-signed reader-auth under read-auth enforcement and are subject to the read-fingerprint gate;
 *  the WRITE-family (post / picture-write / audio-write) never does — writing stays blind. */
function isReadPurpose(p: DrawPurpose): boolean {
  return p === Purpose.Read || p === Purpose.PictureRead || p === Purpose.AudioRead;
}

/**
 * The issuer public key a draw of `purpose` blinds under, resolved from the community record. Each
 * purpose has its own key (K_post / K_read / the four media keys); when the community carries no key
 * for that purpose (domain separation off / older join code) it falls back to the enrollment key
 * `issuerPublicKey`, so a single-key deployment blinds byte-identically to before.
 */
function purposeIssuerKey(community: Community, purpose: DrawPurpose): string | undefined {
  const byPurpose: Record<DrawPurpose, string | undefined> = {
    [Purpose.Post]: community.postIssuerPublicKey,
    [Purpose.Read]: community.readIssuerPublicKey,
    [Purpose.PictureWrite]: community.picWriteIssuerPublicKey,
    [Purpose.PictureRead]: community.picReadIssuerPublicKey,
    [Purpose.AudioWrite]: community.audWriteIssuerPublicKey,
    [Purpose.AudioRead]: community.audReadIssuerPublicKey,
    // Space-write (tokens-everywhere): meters bound-npub space content (channels/groups/DM wraps).
    // A WRITE purpose — isReadPurpose stays false, so its draws never carry reader-auth.
    [Purpose.SpaceWrite]: community.spaceWriteIssuerPublicKey,
  };
  return byPurpose[purpose];
}

function issuerKeyForPurpose(community: Community, purpose: DrawPurpose): string {
  return purposeIssuerKey(community, purpose) ?? community.issuerPublicKey;
}

/**
 * True when the community is provisioned for token DOMAIN SEPARATION — it carries at least one
 * purpose-specific issuer key. Those keys are only ever populated under domain sep (via the join code
 * or the live stiq:token-keys org-config doc), so their presence means a MISSING purpose key is a
 * mis-provision, NOT a single-issuer-key community where the enrollment-key fallback in
 * issuerKeyForPurpose is the correct, intended behavior.
 */
function hasDomainSepKeys(community: Community): boolean {
  return !!(
    community.postIssuerPublicKey ||
    community.readIssuerPublicKey ||
    community.picWriteIssuerPublicKey ||
    community.picReadIssuerPublicKey ||
    community.audWriteIssuerPublicKey ||
    community.audReadIssuerPublicKey ||
    community.spaceWriteIssuerPublicKey
  );
}

/** Per-attempt wait for the organizer's response before we open a fresh socket and try again. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;
/** How many socket attempts before giving up. Each reuses the SAME signed request + reply key. */
const DEFAULT_ATTEMPTS = 4;
/** Pause between attempts — long enough for Tor to pick a fresh circuit, short enough to feel live. */
const DEFAULT_BACKOFF_MS = 3_000;

/**
 * How many blinds `prepareSession` runs before yielding a macrotask (P1-2 / finding B2). A wallet
 * refill blinds a whole batch (DRAW_BATCH=100 posting / READ_DRAW_BATCH=25 reading tokens) right
 * after a spend or a relay reconnect — exactly when the member is interacting — and each
 * `blindRsa.blind()` resolves via a microtask, so a plain `await`-in-a-loop never lets a queued touch
 * dispatch. Yielding every few tokens (same idiom as dm.ts's PoW miner / inbox chunking and
 * identity.ts's warm-up chunking: `await new Promise(r => setTimeout(r, 0))`) hands the JS thread back
 * often enough to unblock touch without adding meaningful wall-clock to the draw.
 */
const BLIND_YIELD_EVERY = 6;

/**
 * Mirrors {@link BLIND_YIELD_EVERY} for the `finalize()` side of the round-trip (audit finding #1 /
 * P1-2 B2's other half). `finalize()` runs in `handleResponse` the instant the organizer's 9025
 * lands — for `DRAW_BATCH=100` tokens each does a pure-JS RSA-PSS verify (`emsaPssVerify`/MGF1 +
 * bigint modPow), and the `await` only defers a microtask, so an unyielded loop blocks the JS thread
 * for ~100-300ms right as the feed mounts its first paint — the worst *felt* jank of the whole draw.
 * Same idiom, same cadence: yield a macrotask every N tokens so a queued touch/frame can still get in.
 */
const FINALIZE_YIELD_EVERY = 6;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The enrollment credential a member holds — its anonymous membership proof. */
export interface Credential {
  token: Uint8Array;
  signature: Uint8Array;
}

export interface DrawOptions {
  /** Opens a FRESH (production: Tor-routed) socket to the community relay. Called once per attempt. */
  connect: () => RelaySocket;
  /** Parsed community — MUST carry `organizerPubkey` (mailbox) and `issuerPublicKey`. */
  community: Community;
  /**
   * Which purpose this draw mints (token domain separation, asks #3/#4/#29). Defaults to `Purpose.Post`.
   *   • `post` / `picture-write` / `audio-write` (Purpose.Post / MediaPurpose) → WRITE tokens, blinded
   *     under K_post / K_picwrite / K_audwrite; pay to publish (a post, or to attach a picture / audio
   *     clip). Never carry reader-auth — writing stays blind + uncensorable.
   *   • `read` / `picture-read` / `audio-read` (Purpose.Read / MediaPurpose) → READ tokens, blinded
   *     under K_read / K_picread / K_audread; pay to UNLOCK sealed content (spent at kind 9026, see
   *     ../blind/readUnlock). Under read-auth enforcement they carry a member-signed reader-auth (see
   *     `readerAuth`).
   * When the community lacks the purpose key (domain separation off / older code), the draw falls back
   * to `issuerPublicKey`, so a single-key deployment draws byte-identically to before.
   */
  purpose?: DrawPurpose;
  /**
   * The relay's advertised READ purpose-key fingerprint (`caps.purposeKeyFingerprints.read`), when it
   * advertised one (domain separation is known to be ON). Supplied only for a `purpose:'read'` draw so
   * this leaf never reaches into runtime state. When present AND this community carries no `rk`
   * (readIssuerPublicKey), the read draw would silently fall back to blinding under the enroll/posting
   * key — tokens the relay's read meter rejects — so the draw errors cleanly instead (C5). Absent (caps
   * fallback, or a posting draw) → no gate, byte-identical to before.
   */
  readFingerprint?: string;
  /**
   * Member-signed reader-auth event (censorable reads, #4). Supplied ONLY for a `purpose:'read'` draw
   * when the community enforces read-auth (`caps.enforcedFlags.readAuthRequired`): it proves the
   * drawer's npub so the organizer can refuse a read-revoked member. A posting draw NEVER carries it —
   * writing stays blind + uncensorable. Absent → the read draw stays anonymous, unchanged.
   */
  readerAuth?: Event;
  /** The client blind-RSA (blind/finalize). */
  blindRsa: BlindRsaClient;
  /** The member's enrollment credential (proves membership without revealing the npub). */
  credential: Credential;
  /** The issuance epoch to draw for. */
  epoch: number;
  /** How many tokens to draw. */
  count: number;
  /** NIP-13 difficulty to mine on the request (must meet the relay's enroll PoW). */
  powDifficulty: number;
  /** Per-attempt response timeout (ms). Default 45s. */
  timeoutMs?: number;
  /** Socket attempts before giving up (default 4). The on-demand path passes a smaller budget. */
  attempts?: number;
  /** Backoff between attempts (ms). Default 3s. */
  backoffMs?: number;
  /**
   * The relay's advertised `caps.schemaVersion`. Gates the over-quota recovery in `capFromResponse`:
   * at/above {@link CAPS_SCHEMA_ERROR_CODES} the organizer guarantees the structured `cap` field, so a
   * cap-less error is taken at face value (fatal) instead of prose-scraped; below it (default 0 — caps
   * fallback) the legacy `/at most N/` self-heal stays active. Absent → 0 → byte-identical to before.
   */
  capsSchemaVersion?: number;
  /**
   * Durable draw-staging hook (F10). Called once per session build — right after blinding + signing
   * the request, BEFORE the first socket attempt — with a {@link DrawMarker} carrying everything
   * needed to recover this batch if the process dies before the caller can `wallet.add()` it. The
   * host persists it (see ../blind/drawStaging.ts), keyed per-account/per-purpose; on the next launch
   * it resumes via {@link resumeTokenDraw} instead of losing an already organizer-paid-for batch. A
   * cap-adjustment rebuild calls this again with the smaller re-blinded session — overwriting the
   * prior marker is correct, since a cap response means the oversized request was never charged (see
   * capFromResponse). Best-effort: this module awaits the hook but swallows a rejection — staging is a
   * safety net for THIS run, never a reason to fail an otherwise-working draw. Absent → no staging,
   * byte-identical to before (tests, and any caller that doesn't wire durability).
   */
  onMarker?: (marker: DrawMarker) => Promise<void>;
}

export type DrawResult =
  | {ok: true; tokens: Token[]}
  | {ok: false; error: string; timedOut?: boolean; code?: string};

/**
 * True when a failed draw is the WRONG-KEY family — the client blinded under a key that doesn't
 * match the organizer's signing key for that purpose (stale invite / zero-key short-link enroll /
 * pre-rotation cache). Matches the structured {@link DrawErrorCode} when present, and falls back to
 * scraping the organizer's legacy prose ("signature representative out of range" is the RSASP1
 * m ≥ n check that fires ~half the time a wrong-modulus blind reaches it) so an organizer that
 * predates the `code` field still triggers the same self-heal. The remedy for every arm is identical:
 * re-fetch `stiq:token-keys`, rebuild purpose keys, retry once (AppRuntime.healedTokenDraw).
 */
export function isStaleKeyDrawFailure(res: DrawResult): boolean {
  if (res.ok) return false;
  if (
    res.code === DrawErrorCode.StaleBlindKey ||
    res.code === DrawErrorCode.UnblindFailed ||
    res.code === DrawErrorCode.MisProvisioned
  ) {
    return true;
  }
  return /signature representative out of range/i.test(res.error);
}

interface DrawRequestPayload {
  credToken: string; // base64 — membership credential (K_enroll; UNCHANGED by domain separation)
  credSig: string; // base64
  epoch: number;
  blinded: string[]; // base64 blinded tokens
  replyPubkey: string; // hex — where the organizer addresses the response
  // Which issuer key the organizer signs the batch under (token domain separation, #3/#4/#29). The
  // organizer's signKeyByPurpose maps it to K_post / K_read / the four media keys; an unknown/absent
  // value signs with K_post. Older organizers ignore this field and sign with the single issuer key,
  // matching the client's fallback blinding.
  purpose?: DrawPurpose;
  // Member-signed reader-auth (censorable reads, #4) — present only on a read-purpose draw under
  // read-auth enforcement. The organizer verifies it + checks the read-revocation list. Absent on
  // posting draws (stay blind) and whenever read-auth is off, so the payload is unchanged otherwise.
  readerAuth?: Event;
}

interface DrawResponsePayload {
  sigs?: string[]; // base64 blind signatures, aligned with `blinded`
  error?: string;
  // Set alongside `error` when the request exceeded the per-epoch allowance: the largest batch this
  // credential may still draw right now. The client re-draws `cap` tokens instead of failing, so
  // lowering the community's token quota below the draw batch can never brick the wallet.
  cap?: number;
  // Machine-readable failure class, additive next to `error` (2026-07-21 contract — see
  // DrawErrorCode in ../contracts). `stale-blind-key` marks the wrong-key family so the client can
  // self-heal (re-fetch stiq:token-keys, retry once) instead of surfacing a dead-end network error.
  // Old organizers omit it; isStaleKeyDrawFailure then falls back to prose-matching `error`.
  code?: string;
}

/**
 * One blinded token plus the state needed to unblind the organizer's signature. `secret` is the
 * holder-bound `q` such that `prepared == schnorr.getPublicKey(q)` (P3; see ./holderProof) — kept
 * alongside the blinding state so the finished {@link Token} carries it once the signature returns.
 * `blindingSecret` is the SAME value `state` is built from (RFC 9474's `inv`) but in serializable
 * form — carried alongside `state` (never in place of it) so a durable draw-in-flight marker (F10,
 * see {@link DrawMarker}) can persist enough to rebuild `state` after a process restart, since `state`
 * itself may embed a non-serializable handle (see BlindRsaClient.rebuildState).
 */
interface BlindItem {
  prepared: Uint8Array;
  blinded: Uint8Array;
  state: unknown;
  secret: Uint8Array;
  blindingSecret: Uint8Array;
}

/**
 * Everything that stays FIXED across retries: the blinded tokens, the single signed request event
 * (so the organizer's id-dedupe charges the quota once), and the reply key (so the relay can replay
 * a stored response to a fresh socket). Built once by prepareSession() — or, after a process restart,
 * reconstructed by {@link sessionFromMarker} from a persisted {@link DrawMarker}, which is why every
 * field here must be either public (safe to store) or reconstructible from something that is.
 */
interface DrawSession {
  items: BlindItem[];
  requestEvent: Event;
  replyPubkey: string;
  respConvKey: Uint8Array;
  organizerPubkey: string;
  blindRsa: BlindRsaClient;
  /** The issuer key this batch was blinded under (K_post/K_read/… or the enroll-key fallback) —
   *  needed by {@link buildMarker} so a resume can rebuild each item's blind-RSA `state`. */
  issuerPublicKey: string;
}

type AttemptOutcome =
  | {kind: 'ok'; tokens: Token[]}
  | {kind: 'error'; error: string; code?: string} // fatal (organizer/relay rejected) — stop retrying
  | {kind: 'retry'; error: string} // transient (timeout / socket died) — try a fresh socket
  | {kind: 'cap'; cap: number}; // organizer's per-epoch allowance — re-blind a smaller batch, retry

/**
 * Durable "draw-in-flight" marker (F10 — TOKEN_FIXING_PLAN.md T3.1). A freshly-blinded, freshly-signed
 * batch (up to 100 tokens) otherwise exists ONLY in the JS heap between the organizer's 9025 response
 * and the caller's `wallet.add()` — a process kill in that window (routine: draws run right after a
 * relay (re)connect, exactly when Android is most likely to background/kill the app) loses the whole
 * PAID batch with no recovery, since the throwaway reply key lived only in a closure. This marker is
 * built ONCE per session (before the first socket attempt — see runTokenDraw's `onMarker` call) with
 * EVERYTHING {@link sessionFromMarker}/`finalize()` need to resume: without the reply key material
 * (`replyPubkey`/`respConvKey`) the relay's already-stored response can never be fetched again; without
 * each item's `blindingSecret` the fetched signature can never be unblinded into a spendable token;
 * without `secret` the unblinded token has no holder proof and is worthless. `credId`/`reqHash` are not
 * needed to REPLAY (the signed `requestEvent` is self-contained) but pin exactly which credential/batch
 * this marker belongs to, for diagnostics and as an integrity cross-check against the request.
 */
export interface DrawMarker {
  schemaV: 1;
  /** sha256(credential.token), hex — which membership credential authorized this draw. */
  credId: string;
  epoch: number;
  purpose: DrawPurpose;
  /** sha256(JSON.stringify(blinded-tokens-array)), hex — matches the organizer's own dedup key
   *  (`organizer-server.mjs`'s `reqHash`), so a resumed replay is provably the identical request. */
  reqHash: string;
  /** The issuer key this batch was blinded under — reconstructs each item's blind-RSA `state`. */
  issuerPublicKey: string;
  organizerPubkey: string;
  /** The fully-signed 9024 request event. Resending it is idempotent (the organizer dedupes by
   *  reqHash/event id), so replaying it after a restart never re-charges the epoch quota. */
  requestEvent: Event;
  /** Throwaway reply-mailbox pubkey (public, not sensitive) — re-subscribes to the SAME response. */
  replyPubkey: string;
  /** base64 NIP-44 conversation key for the reply mailbox — decrypts the (already-stored) response.
   *  Deliberately NOT the reply secret key: this derived key can decrypt but can't be used to derive
   *  the secret key back, so the marker carries no more capability than the live session already had. */
  respConvKey: string;
  items: DrawMarkerItem[];
  /** ms since epoch — read back by drawStaging.loadDrawMarker to purge (rather than resume) a marker
   *  older than its staleness cutoff (F-F: a permanently-stuck marker must not keep its secrets on
   *  disk forever with no TTL). */
  savedAt: number;
}

export interface DrawMarkerItem {
  /** base64 — Q, the finished Token.token once signed. */
  prepared: string;
  /** base64 — the blinded value shown to the issuer (kept for the reqHash cross-check + audit). */
  blinded: string;
  /** base64 — RFC 9474 `inv`; REQUIRED to unblind the organizer's signature (see finalize()). */
  blindingSecret: string;
  /** base64 — the holder-bound secret `q`; REQUIRED so the finished Token can prove ownership. */
  secret: string;
}

/** Build a marker from a live session — pure/sync (no I/O), called once per session build. */
function buildMarker(
  session: DrawSession,
  meta: {credId: string; epoch: number; purpose: DrawPurpose},
): DrawMarker {
  const blindedB64 = session.items.map(it => bytesToBase64(it.blinded));
  return {
    schemaV: 1,
    credId: meta.credId,
    epoch: meta.epoch,
    purpose: meta.purpose,
    reqHash: sha256Hex(utf8ToBytes(JSON.stringify(blindedB64))),
    issuerPublicKey: session.issuerPublicKey,
    organizerPubkey: session.organizerPubkey,
    requestEvent: session.requestEvent,
    replyPubkey: session.replyPubkey,
    respConvKey: bytesToBase64(session.respConvKey),
    items: session.items.map(it => ({
      prepared: bytesToBase64(it.prepared),
      blinded: bytesToBase64(it.blinded),
      blindingSecret: bytesToBase64(it.blindingSecret),
      secret: bytesToBase64(it.secret),
    })),
    savedAt: Date.now(),
  };
}

/**
 * Reconstruct a resumable {@link DrawSession} from a persisted marker (F10 cold-start resume). Each
 * item's blind-RSA `state` is rebuilt via {@link BlindRsaClient.rebuildState} from the marker's
 * `prepared`/`blindingSecret` — never re-blinded (a fresh blind would mint a DIFFERENT batch the
 * organizer never signed). The reply key is never reconstructed as a secret key at all: `replyPubkey`
 * + `respConvKey` are carried directly (see DrawMarker's doc comment).
 */
async function sessionFromMarker(marker: DrawMarker, blindRsa: BlindRsaClient): Promise<DrawSession> {
  const rebuild = blindRsa.rebuildState;
  if (!rebuild) {
    throw new Error('this BlindRsaClient cannot resume a staged draw (no rebuildState)');
  }
  const items: BlindItem[] = [];
  for (const it of marker.items) {
    const prepared = base64ToBytes(it.prepared);
    const blindingSecret = base64ToBytes(it.blindingSecret);
    // .call(blindRsa, …): `rebuild` is a plain method reference extracted off `blindRsa` above (for
    // the TS non-null narrowing to hold across this async loop) — invoking it bare would drop its
    // `this` binding, breaking RealBlindRsa's internal `this.importIssuerKey(...)` call.
    const state = await rebuild.call(blindRsa, marker.issuerPublicKey, prepared, blindingSecret);
    items.push({prepared, blinded: base64ToBytes(it.blinded), state, secret: base64ToBytes(it.secret), blindingSecret});
  }
  return {
    items,
    requestEvent: marker.requestEvent,
    replyPubkey: marker.replyPubkey,
    respConvKey: base64ToBytes(marker.respConvKey),
    organizerPubkey: marker.organizerPubkey,
    blindRsa,
    issuerPublicKey: marker.issuerPublicKey,
  };
}

/**
 * When the organizer rejects a draw for exceeding the per-epoch quota, recover the allowance so we
 * can re-draw a smaller batch instead of failing. Always prefer the structured `cap` field.
 *
 * The legacy PROSE SCRAPE (`/at most N/`, `(N/epoch)`) is now SCHEMA-GATED: it only runs below
 * {@link CAPS_SCHEMA_ERROR_CODES}. At/above that schema the organizer GUARANTEES the machine `cap`
 * field, so a cap-less error is authoritative — a genuine fatal error (bad credential, malformed
 * request), NOT a low quota — and must not be prose-scraped. Below it (an older/federated organizer
 * that predates the field, or caps fallback where `schemaVersion` is 0) we still self-heal from the
 * error text so a mixed-version community keeps working. Returns null for any error a smaller re-draw
 * can't fix. Today's relays advertise schema < CAPS_SCHEMA_ERROR_CODES, so the scrape stays active —
 * byte-identical to before.
 */
function capFromResponse(data: DrawResponsePayload, schemaVersion: number): number | null {
  if (typeof data.cap === 'number' && Number.isFinite(data.cap)) return Math.max(0, Math.floor(data.cap));
  if (schemaVersion >= CAPS_SCHEMA_ERROR_CODES) return null; // machine `cap` guaranteed → no prose scrape
  const msg = data.error ?? '';
  // "draw at most N tokens per request" (absolute cap) or "epoch token limit reached (N/epoch)".
  const m = /at most (\d+)/.exec(msg) ?? /\((\d+)\/epoch\)/.exec(msg);
  if (m) {
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return null;
}

/** Blind `count` tokens and mine one signed draw request; reused verbatim by every attempt. */
async function prepareSession(opts: DrawOptions, organizerPubkey: string): Promise<DrawSession> {
  const {community, credential, epoch, count, blindRsa, powDifficulty} = opts;
  const purpose: DrawPurpose = opts.purpose ?? Purpose.Post;

  // Token domain separation (#3/#4/#29): blind each token under the issuer key the organizer will
  // sign it with, so the returned blind signature verifies under that key (K_post / K_read / the four
  // media keys). When the community carries no key for this purpose (domain separation off / older
  // code) it falls back to `issuerPublicKey`, so the blinding is byte-identical to the single-key
  // deployment. The MEMBERSHIP CREDENTIAL below is presented verbatim (K_enroll) regardless.
  const tokenIssuerKey = issuerKeyForPurpose(community, purpose);

  // Blind `count` fresh tokens, keeping each blinding state so we can unblind the responses. P3:
  // the token bytes ARE a BIP-340 x-only pubkey `Q`; blind the pubkey (not raw random bytes) and
  // keep its secret `q` alongside — `item.prepared` still equals the blinded value verbatim
  // (blind-RSA is byte-blind to what it signs), so issuance/unblinding is unaffected.
  const items: BlindItem[] = [];
  for (let i = 0; i < count; i++) {
    const {q, Q} = newTokenKeypair();
    const blinded = await blindRsa.blind(tokenIssuerKey, Q);
    items.push({...blinded, secret: q});
    // Macrotask yield every BLIND_YIELD_EVERY tokens — see the constant's doc comment (P1-2 / B2).
    if ((i + 1) % BLIND_YIELD_EVERY === 0 && i + 1 < count) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  // Throwaway mailbox keys — never the posting npub. The reply key is reused across attempts so a
  // response the organizer already stored under it can be replayed to a later socket.
  const reqSk = generateSecretKey();
  const replySk = generateSecretKey();
  const replyPubkey = getPublicKey(replySk);

  const payload: DrawRequestPayload = {
    credToken: bytesToBase64(credential.token),
    credSig: bytesToBase64(credential.signature),
    epoch,
    blinded: items.map(it => bytesToBase64(it.blinded)),
    replyPubkey,
    purpose,
    // Only a READ-family draw (content-read / picture-read / audio-read) under read-auth enforcement
    // supplies this; WRITE draws (post / picture-write / audio-write) never do — writing stays blind.
    ...(isReadPurpose(purpose) && opts.readerAuth ? {readerAuth: opts.readerAuth} : {}),
  };
  const reqConvKey = nip44.utils.getConversationKey(reqSk, organizerPubkey);
  const now = Math.floor(Date.now() / 1000);
  // Async miner (native StiqPow when present; chunked-yield JS fallback otherwise). The token
  // top-up runs right after relay connect — a laggy moment — so we must NOT busy-loop the JS thread
  // here. Identical nonce-tag/difficulty semantics to the old sync mineEvent (see nip13.ts).
  const mined = await mineEventPow(
    {
      pubkey: getPublicKey(reqSk),
      kind: KIND_DRAW_REQUEST,
      created_at: now,
      tags: [
        ['p', organizerPubkey],
        ['expiration', String(now + MAILBOX_TTL_SECONDS)],
      ],
      content: nip44.encrypt(JSON.stringify(payload), reqConvKey),
    },
    powDifficulty,
  );
  const requestEvent = finalizeEvent(
    {kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content},
    reqSk,
  );
  const respConvKey = nip44.utils.getConversationKey(replySk, organizerPubkey);
  return {items, requestEvent, replyPubkey, respConvKey, organizerPubkey, blindRsa, issuerPublicKey: tokenIssuerKey};
}

/**
 * One attempt over one socket: subscribe for the response, (re)send the request on open, and settle
 * on the first of — a decryptable 9025 (tokens or a fatal organizer error), a relay rejection of the
 * request, the socket closing, or the timeout. A 'retry' outcome means "try a fresh socket"; the
 * relay replays any response the organizer already stored, so a lost response still lands.
 */
function runOneAttempt(
  session: DrawSession,
  socket: RelaySocket,
  timeoutMs: number,
  schemaVersion: number,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>(resolve => {
    let settled = false;
    const subId = `draw:${session.replyPubkey.slice(0, 16)}`;

    const done = (o: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(closeMessage(subId));
      } catch {
        /* socket already gone */
      }
      resolve(o);
    };

    const timer = setTimeout(
      () => done({kind: 'retry', error: 'the organizer did not respond in time'}),
      timeoutMs,
    );

    const handleResponse = async (event: Event): Promise<void> => {
      if (!verifyEvent(event) || event.pubkey !== session.organizerPubkey) return;
      let data: DrawResponsePayload;
      try {
        data = JSON.parse(nip44.decrypt(event.content, session.respConvKey)) as DrawResponsePayload;
      } catch {
        return; // not addressed to us / undecryptable — keep waiting
      }
      // An organizer-signed error won't change on a same-size retry. A per-epoch CAP, though, is
      // recoverable: re-blind a smaller batch (handled by runTokenDraw). Any other error is fatal.
      if (data.error) {
        const cap = capFromResponse(data, schemaVersion);
        return done(
          cap !== null
            ? {kind: 'cap', cap}
            : {
                kind: 'error',
                error: data.error,
                code: typeof data.code === 'string' ? data.code : undefined,
              },
        );
      }
      const sigs = data.sigs;
      if (!sigs || sigs.length !== session.items.length) return; // malformed — keep waiting
      try {
        const tokens: Token[] = [];
        for (let i = 0; i < session.items.length; i++) {
          const sig = await session.blindRsa.finalize(session.items[i]!.state, base64ToBytes(sigs[i]!));
          tokens.push({token: session.items[i]!.prepared, sig, secret: session.items[i]!.secret});
          // Macrotask yield every FINALIZE_YIELD_EVERY tokens — see the constant's doc comment.
          if ((i + 1) % FINALIZE_YIELD_EVERY === 0 && i + 1 < session.items.length) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
        done({kind: 'ok', tokens});
      } catch (e) {
        // Sigs don't match our blinds — not something a retry fixes. This is the SILENT half of the
        // wrong-key incident: an organizer whose signing key differs from our blinding key produces
        // signatures that fail RFC-9474 verification only HERE, client-side (the other half throws
        // "signature representative out of range" at the organizer). Classify it as the stale-key
        // family so the healed-draw path re-syncs token keys instead of dead-ending.
        done({
          kind: 'error',
          error: `could not unblind tokens: ${(e as Error)?.message ?? e}`,
          code: DrawErrorCode.UnblindFailed,
        });
      }
    };

    socket.onMessage(raw => {
      const msg = parseRelayMessage(raw);
      if (msg.type === 'EVENT' && msg.subId === subId && msg.event.kind === KIND_DRAW_RESPONSE) {
        void handleResponse(msg.event);
      } else if (msg.type === 'OK' && msg.id === session.requestEvent.id && !msg.accepted) {
        // Same signed event every attempt, so a relay rejection is permanent — don't spin.
        done({kind: 'error', error: `relay rejected the draw request: ${msg.message}`});
      }
    });

    // A dead onion circuit: fail this attempt fast instead of burning the whole per-attempt timeout.
    socket.onClose(() => done({kind: 'retry', error: 'the relay connection closed before a response'}));

    socket.onOpen(() => {
      socket.send(reqMessage(subId, [{kinds: [KIND_DRAW_RESPONSE], '#p': [session.replyPubkey]}]));
      socket.send(eventMessage(session.requestEvent));
    });
  });
}

/**
 * One session's worth of socket attempts (fresh-connect / retry / backoff), independent of how the
 * session was built — a freshly-blinded one from {@link prepareSession}, or one rebuilt from a
 * persisted marker by {@link sessionFromMarker}. Factored out of {@link runTokenDraw} so
 * {@link resumeTokenDraw} (F10 cold-start resume) can reuse the IDENTICAL attempt/retry semantics
 * rather than re-implementing them.
 */
// Deliberately its OWN union (not `AttemptOutcome | {...}`): 'retry' is an internal per-attempt signal
// this loop always either retries past or (once attempts are exhausted) folds into 'exhausted' — it is
// never a final result, so it must not appear in the return type callers switch on.
type AttemptsResult =
  | {kind: 'ok'; tokens: Token[]}
  | {kind: 'error'; error: string; code?: string}
  | {kind: 'cap'; cap: number}
  | {kind: 'exhausted'; error: string};

async function runAttemptsOverSession(
  session: DrawSession,
  connect: () => RelaySocket,
  attempts: number,
  timeoutMs: number,
  backoffMs: number,
  schemaVersion: number,
): Promise<AttemptsResult> {
  let lastError = 'the organizer did not respond in time';
  for (let i = 0; i < attempts; i++) {
    let socket: RelaySocket;
    try {
      socket = connect();
    } catch (e) {
      // Tor dropped between attempts — treat as transient and give the next attempt a chance.
      lastError = `could not open a relay connection: ${(e as Error)?.message ?? e}`;
      if (i < attempts - 1) await sleep(backoffMs);
      continue;
    }
    let outcome: AttemptOutcome;
    try {
      outcome = await runOneAttempt(session, socket, timeoutMs, schemaVersion);
    } finally {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    if (outcome.kind === 'ok' || outcome.kind === 'error' || outcome.kind === 'cap') return outcome;
    lastError = outcome.error;
    if (i < attempts - 1) await sleep(backoffMs);
  }
  return {kind: 'exhausted', error: lastError};
}

/** Run the full draw round-trip (with retries) and resolve with the drawn wallet tokens, or a typed failure. */
export async function runTokenDraw(opts: DrawOptions): Promise<DrawResult> {
  const organizerPubkey = opts.community.organizerPubkey;
  if (!organizerPubkey) {
    return {ok: false, error: 'this community has no organizer mailbox'};
  }
  // C5 read-gate: the relay advertised a read fingerprint (domain separation known ON) but this
  // community carries no issuer key for this READ purpose, so the draw would silently blind under the
  // enroll/posting key and mint tokens the relay's read meter rejects. Fail cleanly rather than quietly
  // mis-blinding. Only fires for a READ-family purpose with a supplied readFingerprint and no matching
  // key; WRITE draws + caps fallback are untouched.
  const drawPurpose: DrawPurpose = opts.purpose ?? Purpose.Post;
  if (
    isReadPurpose(drawPurpose) &&
    opts.readFingerprint &&
    !purposeIssuerKey(opts.community, drawPurpose)
  ) {
    return {ok: false, error: 'community mis-provisioned — update your invite', code: DrawErrorCode.MisProvisioned};
  }
  // C5 write-gate (token draw pipeline, T1.5/F7 — now covers `post` too): a WRITE-family domain-sep
  // purpose — post, space-write, or media-write — whose dedicated issuer key is missing while the
  // community clearly runs domain separation (it carries at least one other purpose key). Under
  // domain sep the enrollment-key fallback in issuerKeyForPurpose would blind under the WRONG key, so
  // the organizer's unblinded signature fails RFC-9474 verification in finalize() with an opaque
  // "invalid signature" and the wallet silently never fills — the exact failure that broke every
  // space-write once space_tokens_required went on, and (F7) the IDENTICAL failure for `post` once
  // domain sep is on and a member's invite/token-keys sync predates the dedicated post key. `post`
  // used to be EXCLUDED here (fell back to the enroll key and mis-blinded silently, bricking feed
  // posting) — that carve-out is now removed. Fail cleanly and diagnosably instead; the member
  // refreshes the key live from the stiq:token-keys org-config doc. A single-issuer-key community
  // carries NO purpose keys at all, so hasDomainSepKeys is false and this never fires there — the
  // legacy single-key fallback stays byte-identical.
  if (
    !isReadPurpose(drawPurpose) &&
    hasDomainSepKeys(opts.community) &&
    !purposeIssuerKey(opts.community, drawPurpose)
  ) {
    return {ok: false, error: 'community mis-provisioned — update your invite', code: DrawErrorCode.MisProvisioned};
  }
  if (opts.count <= 0) return {ok: true, tokens: []};

  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const schemaVersion = opts.capsSchemaVersion ?? 0; // gates capFromResponse's legacy prose scrape

  // The batch shrinks if the organizer reports a smaller per-epoch allowance (`cap`): we re-blind and
  // retry at the permitted size rather than fail, so lowering the community's token quota below the
  // draw batch can never permanently empty a member's wallet. Bounded (each shrink is strict, capped
  // at MAX_CAP_ADJUSTMENTS) so a legacy or misbehaving organizer can't spin this loop.
  const MAX_CAP_ADJUSTMENTS = 3;
  let count = opts.count;

  // F10: which credential authorized this draw — a stable, non-secret label carried in every marker
  // built below (see DrawMarker's doc comment). Computed once; unaffected by the cap-adjustment loop.
  const credId = opts.onMarker ? sha256Hex(opts.credential.token) : '';

  for (let capAdjustments = 0; ; capAdjustments++) {
    // Build the request + reply key ONCE per batch size; every socket attempt replays them (header).
    const session = await prepareSession({...opts, count}, organizerPubkey);

    // F10 durable draw staging: persist a recovery marker BEFORE the first socket attempt. A
    // cap-adjustment rebuild lands here again with the smaller session and simply overwrites the
    // prior marker — safe, because a 'cap' outcome below means the larger request was never charged.
    if (opts.onMarker) {
      const marker = buildMarker(session, {credId, epoch: opts.epoch, purpose: drawPurpose});
      try {
        await opts.onMarker(marker);
      } catch {
        // Best-effort: a failed stage means a kill in the next few seconds isn't recoverable — no
        // worse than before this fix existed — but must never abort an otherwise-working draw.
      }
    }

    const result = await runAttemptsOverSession(session, opts.connect, attempts, timeoutMs, backoffMs, schemaVersion);
    if (result.kind === 'ok') return {ok: true, tokens: result.tokens};
    if (result.kind === 'error') return {ok: false, error: result.error, code: result.code};
    if (result.kind === 'exhausted') return {ok: false, error: result.error, timedOut: true};

    // result.kind === 'cap': draw only what the epoch allowance permits. Nothing left (quota spent) —
    // or a cap that can't shrink the batch, or too many adjustments — resolves to an empty draw: a
    // valid result, NOT a failure the caller should surface or endlessly retry.
    const newCount = Math.min(count, Math.max(0, result.cap));
    if (newCount <= 0 || newCount >= count || capAdjustments >= MAX_CAP_ADJUSTMENTS) {
      return {ok: true, tokens: []};
    }
    count = newCount; // loop: re-blind `count` tokens and try again at the permitted size
  }
}

/**
 * Resume a draw whose marker survived a process kill (F10 cold-start recovery): rebuild the session
 * from the marker (no re-blind, no re-mine — see {@link sessionFromMarker}) and replay it exactly like
 * a normal attempt would. Because the request event is byte-identical to the one originally sent, the
 * organizer's id/reqHash dedupe means this NEVER re-charges the epoch quota, whether the organizer had
 * already answered (the relay replays its stored 9025) or never saw the request at all (this resend
 * is simply its first delivery).
 *
 * `timedOut: true` on failure means the batch is STILL UNRESOLVED, not lost — the caller must leave the
 * marker in place for a later resume (next connect / next launch). Any other failure is terminal: a
 * `cap` means the organizer's allowance shrank since the original request, which is safe to abandon
 * because a cap response is never charged (see capFromResponse); a plain `error` means the organizer or
 * relay definitively rejected it. Either way there is nothing left to recover, so the caller clears the
 * marker — but per the plan's accounting note, this is the one path where a batch the organizer DID
 * sign-and-charge (client-side finalize failure, e.g. a corrupted/foreign reply) could be lost with no
 * client-side refund mechanism; callers should log this case rather than swallow it silently.
 */
export async function resumeTokenDraw(
  marker: DrawMarker,
  opts: {
    connect: () => RelaySocket;
    blindRsa: BlindRsaClient;
    timeoutMs?: number;
    attempts?: number;
    backoffMs?: number;
    capsSchemaVersion?: number;
  },
): Promise<DrawResult> {
  const session = await sessionFromMarker(marker, opts.blindRsa);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const schemaVersion = opts.capsSchemaVersion ?? 0;
  const result = await runAttemptsOverSession(session, opts.connect, attempts, timeoutMs, backoffMs, schemaVersion);
  if (result.kind === 'ok') return {ok: true, tokens: result.tokens};
  if (result.kind === 'exhausted') return {ok: false, error: result.error, timedOut: true};
  if (result.kind === 'cap') {
    return {
      ok: false,
      error: `organizer allowance changed (cap ${result.cap}) — resumed draw abandoned, not charged`,
    };
  }
  return {ok: false, error: result.error, code: result.code};
}
