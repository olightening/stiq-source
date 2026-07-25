/**
 * Epoch wallet — the member's stash of blind anti-spam tokens.
 *
 * Each blind post spends one token. The organizer blind-signs N tokens per epoch (enforcing the
 * per-member rate cap at issuance); because they are blind-signed the organizer cannot link a
 * token to an npub, so tokens are publish-only and un-revocable. The wallet holds the unspent
 * tokens, spends them FIFO, and knows which epoch it last drew for so the app can top up.
 *
 * Tokens are bearer secrets: persisted ONLY in hardware-backed SecureStorage (never AsyncStorage,
 * never logged). This module is PURE (no React) — storage and the token-mint are injected.
 *
 * **Concurrency (bearer-value correctness).** Token value is real: a lost update either resurrects
 * a spent token (the relay later rejects a double-spend) or drops a drawn one. wallet.add() fires on
 * every relay connect (plus a ~30s retry loop) while spendMany() fires on every post/reaction, so
 * these methods overlap constantly. A naive load→mutate→save races: two overlapping reads see the
 * same snapshot and the second save clobbers the first. So the wallet keeps the held tokens in
 * memory as the single source of truth — hydrated from storage exactly once (lazy, single-flight) —
 * mutates that in-memory state SYNCHRONOUSLY (no await between read and write of `held`, so no two
 * mutations can interleave), and persists a snapshot after each change through a serialized write
 * chain so the on-disk order matches the mutation order.
 *
 * P3 clean cutover: the persisted record gained a `k` field (the holder-bound secret `q`; see
 * ./holderProof). It is REQUIRED — a pre-P3 record without it is filtered out on hydrate (see
 * isStoredToken), not "migrated": the wallet simply reads as if that token were never held, and the
 * normal top-up/redraw path refills it with holder-bound tokens. No separate migration code path.
 */
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {sha256Hex} from '../util/hash';
import {utf8ToBytes} from '@noble/hashes/utils.js';
import type {SecureStorage} from '../keys/keystore';

/**
 * A drawn credential ready to spend: the (prepared) token `Q`, the issuer's signature over it, and
 * `secret` — the holder-bound secret key `q` such that `Q = schnorr.getPublicKey(q)` (P3; see
 * ./holderProof). `token` is BOTH the blind-signed value and a 32-byte BIP-340 x-only pubkey.
 */
export interface Token {
  token: Uint8Array;
  sig: Uint8Array;
  secret: Uint8Array;
}

/** Serialized form kept in secure storage (base64 so it survives a string store). */
interface StoredToken {
  t: string; // base64 token (Q)
  s: string; // base64 issuer signature
  e: number; // epoch drawn for
  k: string; // base64 holder-bound secret (q) — REQUIRED; its absence is the clean-cutover discard
  // signal for pre-P3 bearer tokens (see isStoredToken).
}

/** Mints one fresh blind token (blind → issuer sign → unblind). Injected; see ./blindTokenSource. */
export type MintToken = () => Promise<Token>;

const WALLET_ITEM = 'stiq.wallet.tokens';
const EPOCH_ITEM = 'stiq.wallet.epoch';
const KEYFP_ITEM = 'stiq.wallet.keyfp';

/**
 * The three SecureStorage item BASES a wallet persists under (before the per-slot namespace suffix):
 * the held tokens, the last-drawn epoch, and the issuer-key fingerprint stamp. Parameterizing these
 * lets a SECOND wallet of the identical shape live in the same store without colliding — specifically
 * the C7 read-token wallet (see ./readWallet), whose blind READ tokens are a separate metered budget
 * from the posting tokens and MUST NOT share a token pool. The default is the posting-token base, so
 * every existing `new EpochWallet(...)` call is byte-identical (same keys, same on-disk format).
 */
export interface WalletItemBase {
  tokens: string;
  epoch: string;
  keyfp: string;
}

/** The posting-token wallet's item base — the historical default (kept byte-identical). */
export const POST_WALLET_ITEMS: WalletItemBase = {
  tokens: WALLET_ITEM,
  epoch: EPOCH_ITEM,
  keyfp: KEYFP_ITEM,
};

/**
 * Short, stable fingerprint of the posting-token ISSUER KEY a wallet drew under: a 64-bit
 * (16 hex char) sha256 prefix of the issuer public key. Every held token is blind-signed by exactly
 * one issuer key — K_post (`postIssuerPublicKey`), or K_enroll (`issuerPublicKey`) before token
 * domain separation — and the relay rejects a token signed by any OTHER key. The wallet records this
 * fingerprint next to its tokens so it can detect an issuer-key rotation / domain-sep cutover (or any
 * re-enrollment) and discard the now-unspendable batch rather than spend it FIFO into relay
 * rejections. Computed identically to how drawExchange picks the blinding key:
 * `postIssuerPublicKey ?? issuerPublicKey`.
 *
 * WIRE-FORMAT CONTRACT (do NOT change this function — it is ALSO the local wallet-siloing key and
 * must stay stable): `issuerPublicKey` is the base64-standard DER-SPKI string carried by the
 * join/community code (standard base64, with padding, no newlines). C5's cross-process check
 * (AppRuntime.verifyCommunityProvisioning) compares THIS value against the relay's advertised
 * `purpose_key_fingerprints`, so the relay MUST produce the SAME fingerprint from the SAME string:
 *   fingerprint = sha256_hex( utf8( base64_standard_DER_SPKI_string ) )[:16]
 * The relay must base64-encode its DER-SPKI issuer key EXACTLY as the code carries it and hash THAT
 * string — NOT the PEM text and NOT the raw DER bytes. See CLIENT_C5_FINGERPRINT_CONTRACT.md for a
 * concrete test vector the relay must reproduce.
 */
export function walletKeyFingerprint(issuerPublicKey: string): string {
  return sha256Hex(utf8ToBytes(issuerPublicKey)).slice(0, 16);
}

/**
 * The three SecureStorage keys an {@link EpochWallet} uses under a given namespace (its tokens, the
 * last-drawn epoch, and the issuer-key fingerprint stamp). Exposed so the one-time per-slot migration
 * can copy a wallet from its former per-community namespace into the account's per-slot namespace
 * without instantiating a wallet or moving token secrets through app code. Must stay byte-identical to
 * the constructor's key derivation below.
 */
export function walletStorageKeys(
  namespace: string,
  base: WalletItemBase = POST_WALLET_ITEMS,
): {tokens: string; epoch: string; keyfp: string} {
  const suffix = namespace ? `.${namespace}` : '';
  return {tokens: base.tokens + suffix, epoch: base.epoch + suffix, keyfp: base.keyfp + suffix};
}

/**
 * The member's blind-token wallet. Construct once with the app's SecureStorage; an optional
 * namespace isolates wallets across enrolled communities (mirrors KeyStore's per-slot namespace).
 *
 * The wallet is also SILOED TO ONE ISSUER KEY: pass the current community's posting-key
 * `keyFingerprint` (or bind it later via {@link setKeyFingerprint}) and the wallet self-heals across
 * issuer-key rotations. Held tokens are stamped with the fingerprint of the key they were drawn
 * under; when the current fingerprint differs — a domain-sep cutover, an operator key rotation, or a
 * legacy wallet that carries NO stamp (unknown provenance) — the stale tokens are discarded on the
 * next load so the normal top-up redraws a fresh, spendable batch under the current key. Unspent
 * tokens are cheap to reissue, so discarding on mismatch is safe. With no fingerprint bound
 * (the transient un-enrolled wallet / storage-only tests) reconciliation is disabled and the wallet
 * behaves as a plain token store.
 */
export class EpochWallet {
  private readonly walletKey: string;
  private readonly epochKey: string;
  private readonly fpKey: string;
  private keyFp: string | undefined;

  // In-memory source of truth. `held` is the ordered (FIFO) list of unspent tokens; `epoch` is the
  // last epoch we drew for (-1 = never). Both are hydrated from storage exactly once, then every
  // mutation happens here first and is persisted as a snapshot afterwards.
  private held: StoredToken[] = [];
  private epoch = -1;

  // Single-flight hydration: `hydrated` flips true once the first load completes; `hydrating` holds
  // the in-flight load so concurrent first callers share one storage read instead of racing.
  private hydrated = false;
  private hydrating: Promise<void> | null = null;

  // Serialized persistence: every write is chained onto the previous one so snapshots reach storage
  // in mutation order and can never interleave. A failed write does not wedge the chain.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: SecureStorage,
    namespace = '',
    keyFingerprint?: string,
    // The item base defaults to the posting-token keys, so every existing caller is byte-identical.
    // The C7 read wallet (./readWallet) passes a distinct base so its blind READ tokens live in the
    // same store as a SEPARATE metered budget — never sharing the posting-token pool.
    itemBase: WalletItemBase = POST_WALLET_ITEMS,
  ) {
    const suffix = namespace ? `.${namespace}` : '';
    this.walletKey = itemBase.tokens + suffix;
    this.epochKey = itemBase.epoch + suffix;
    this.fpKey = itemBase.keyfp + suffix;
    this.keyFp = keyFingerprint;
  }

  /**
   * Bind (or update) the posting-token issuer-key fingerprint this wallet's tokens must match. The
   * runtime calls this once the active community's posting key is resolved (see AppRuntime), so a
   * later issuer-key rotation / domain-sep cutover is caught on the next load and the stale batch is
   * discarded. Passing `undefined` disables reconciliation (the transient un-enrolled wallet).
   */
  setKeyFingerprint(keyFingerprint: string | undefined): void {
    const changed = this.keyFp !== keyFingerprint;
    this.keyFp = keyFingerprint;
    // If the wallet has already hydrated and the bound issuer key actually changed — an in-session key
    // rotation, or (the common case) the runtime binding the key AFTER the first wallet use, since it
    // is constructed unbound and the fingerprint is set once the community's posting key resolves —
    // reconcile the held batch against the new key NOW rather than waiting for the next launch. This
    // matches the pre-refactor load-per-call behaviour where every op re-checked the stamp. Serialized
    // on the write chain so it can't interleave with a concurrent spend/persist, and so a following
    // resync/count observes the post-reconcile storage.
    if (changed && this.hydrated && keyFingerprint !== undefined) {
      void this.enqueue(async () => {
        const hadTokens = this.held.length > 0;
        this.held = await this.reconcileKey(this.held);
        if (hadTokens && this.held.length === 0) this.epoch = -1;
      });
    }
  }

  /**
   * Number of unspent tokens currently held. Reconciles the in-memory list with storage first: this
   * is a UI/status read (never a hot path — only walletBalance() calls it), and tokens can land in
   * the shared store through a SIBLING EpochWallet instance (the on-demand draw tops up the active
   * community's wallet through its own instance), so an in-memory-only count would under-report a
   * fresh deposit. Reconciling restores the pre-refactor read-through balance without touching the
   * in-memory write hot path (add/spend stay purely in memory).
   */
  async count(): Promise<number> {
    await this.hydrate();
    await this.resyncFromStorage();
    return this.held.length;
  }

  /** The epoch the wallet last drew tokens for, or -1 if it has never drawn. */
  async lastEpoch(): Promise<number> {
    await this.hydrate();
    return this.epoch;
  }

  /**
   * Draw `count` fresh tokens for `epoch` and add them to the wallet. Returns the new total held.
   * Partial success is preserved: if the issuer stops responding after k tokens, those k are kept
   * and the error is rethrown so the caller can retry the remainder.
   */
  async draw(epoch: number, count: number, mint: MintToken): Promise<number> {
    await this.hydrate();
    try {
      for (let i = 0; i < count; i++) {
        const {token, sig, secret} = await mint();
        // Push straight onto the shared in-memory list. mint() awaits, so a concurrent spend may run
        // between iterations; because both operate on `this.held` the draw simply sees the smaller
        // list on the next push — no snapshot to go stale.
        this.held.push({t: bytesToBase64(token), s: bytesToBase64(sig), e: epoch, k: bytesToBase64(secret)});
      }
    } finally {
      // Persist whatever was minted (even on a mid-batch failure) plus the epoch marker.
      this.epoch = epoch;
      await this.persist(true);
    }
    return this.held.length;
  }

  /**
   * Deposit already-drawn tokens (e.g. from the Tor batch draw, which unblinds a whole batch at
   * once) into the wallet for `epoch`. Returns the new total held.
   *
   * IDEMPOTENT by token value (F10): each `t.token` (`Q`) comes from a fresh CSPRNG BIP-340 keypair
   * minted once per token (see holderProof.newTokenKeypair) — the ONLY way this method ever sees the
   * same `Q` twice is a caller re-depositing a batch it already added (the durable draw-marker
   * recovery path replays the organizer's stored response and re-finalizes it deterministically if a
   * kill lands between a prior `add()` and the marker being cleared — see AppRuntime.resumeStagedDraw
   * / drawStaging.ts). Skipping an already-held token makes `add()` safe to call more than once with
   * the same batch, which recovery depends on to never double-credit the wallet.
   */
  async add(epoch: number, tokens: Token[]): Promise<number> {
    await this.hydrate();
    const existing = new Set(this.held.map(h => h.t));
    for (const t of tokens) {
      const tb64 = bytesToBase64(t.token);
      if (existing.has(tb64)) continue; // already held — a recovery replay, not a fresh token
      existing.add(tb64);
      this.held.push({t: tb64, s: bytesToBase64(t.sig), e: epoch, k: bytesToBase64(t.secret)});
    }
    this.epoch = epoch;
    await this.persist(true);
    return this.held.length;
  }

  /**
   * Remove and return one token to spend on a post, or null if the wallet is empty. FIFO so the
   * oldest tokens (which the relay may prune first under epoch rotation) are used up first.
   */
  async spend(): Promise<Token | null> {
    await this.hydrate();
    // Empty in memory doesn't mean empty on disk: the on-demand top-up deposits through a separate
    // wallet instance bound to the same storage (see resyncFromStorage). Re-read before giving up.
    if (this.held.length === 0) await this.resyncFromStorage();
    const next = this.held.shift();
    if (!next) return null;
    await this.persist(false);
    return {token: base64ToBytes(next.t), sig: base64ToBytes(next.s), secret: base64ToBytes(next.k)};
  }

  /**
   * Remove and return `n` tokens (FIFO) for a weight-priced post, or null if the wallet holds fewer
   * than `n` — spending NONE in that case. All-or-nothing mirrors the relay's SpendAll: a
   * weight-priced event must pay its full cost or not at all, so a partial spend can never strand
   * tokens on an event the relay will reject.
   */
  async spendMany(n: number): Promise<Token[] | null> {
    if (n <= 0) return [];
    await this.hydrate();
    // The in-memory list is normally the whole truth, but the on-demand top-up path deposits tokens
    // through a SEPARATE EpochWallet instance bound to the same storage: AppRuntime finds the wallet
    // empty, its host draws over Tor, then this signer retries the spend. Those deposits are invisible
    // to our cached list, so rather than report "exhausted" we re-read the persisted snapshot once —
    // cheap, only on the miss — and try again before giving up. This restores the pre-refactor
    // read-through coherence for the exhaustion path without touching the in-memory hot path.
    if (this.held.length < n) {
      await this.resyncFromStorage();
      if (this.held.length < n) return null;
    }
    const taken = this.held.splice(0, n);
    await this.persist(false);
    return taken.map(t => ({token: base64ToBytes(t.t), sig: base64ToBytes(t.s), secret: base64ToBytes(t.k)}));
  }

  /** Wipe the wallet (duress reset / re-enroll). */
  async clear(): Promise<void> {
    // Let any in-flight hydration settle first so it can't repopulate `held` after we empty it, then
    // reset the in-memory state (marking it hydrated so nothing re-reads the removed storage).
    await this.hydrate();
    this.held = [];
    this.epoch = -1;
    await this.enqueue(async () => {
      await this.storage.removeItem(this.walletKey);
      await this.storage.removeItem(this.epochKey);
      await this.storage.removeItem(this.fpKey);
    });
    // Force the next operation to re-hydrate from the now-empty storage so reconcileKey re-stamps the
    // current issuer-key fingerprint: a fresh batch drawn under the SAME key after a clear stays
    // recognised as ours instead of being discarded as unstamped.
    this.hydrated = false;
    this.hydrating = null;
  }

  /**
   * Hydrate the in-memory token list + epoch from storage exactly once. Safe to await repeatedly and
   * safe to call concurrently: the in-flight load is shared so overlapping first callers read storage
   * once and then all mutate the same list. A missing/corrupt store yields an empty wallet. The held
   * batch is reconciled against the bound issuer-key fingerprint here (see reconcileKey) so tokens
   * drawn under a rotated / domain-separated posting key are discarded rather than spent into relay
   * rejections.
   */
  private hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydrating) return this.hydrating;
    this.hydrating = (async () => {
      try {
        const raw = await this.storage.getItem(this.walletKey);
        if (raw) {
          const parsed = JSON.parse(raw) as StoredToken[];
          this.held = Array.isArray(parsed) ? parsed.filter(isStoredToken) : [];
        }
        const rawEpoch = await this.storage.getItem(this.epochKey);
        if (rawEpoch !== null) {
          const n = Number(rawEpoch);
          this.epoch = Number.isInteger(n) ? n : -1;
        }
        // Issuer-key reconciliation (token domain-sep self-heal): discard a held batch drawn under a
        // DIFFERENT posting key than the one bound now — it is unspendable and would otherwise mask
        // the top-up. reconcileKey clears storage + stamps the current key on a mismatch, so the
        // discard survives a restart; it is a no-op when no fingerprint is bound.
        const hadTokens = this.held.length > 0;
        this.held = await this.reconcileKey(this.held);
        if (hadTokens && this.held.length === 0) this.epoch = -1;
      } catch {
        // start empty on corrupt/absent storage
      } finally {
        this.hydrated = true;
        this.hydrating = null;
      }
    })();
    return this.hydrating;
  }

  /**
   * Discard tokens that were drawn under a DIFFERENT posting issuer key than the one now bound.
   *
   * This is the wallet's self-heal on an issuer-key rotation / domain-sep cutover: the held tokens
   * are blind-signed by a specific key, so once the community's posting key changes they are dead
   * weight the relay will reject ("invalid blind-post token"). Left in place they would be spent FIFO
   * into silent rejections AND — because the wallet still looks non-empty — suppress both the
   * low-watermark top-up and the on-exhaustion redraw, permanently bricking posting. Dropping them
   * makes the wallet read empty so the normal draw refills under the current key with no re-enroll.
   *
   * A wallet holding tokens but carrying NO stamp (a batch drawn by a build that predates this
   * mechanism — unknown provenance) is treated as stale too: it is discarded on first load rather
   * than trusted. No-op when no fingerprint is bound (reconciliation disabled).
   */
  private async reconcileKey(tokens: StoredToken[]): Promise<StoredToken[]> {
    const current = this.keyFp;
    if (!current) return tokens; // no key context bound → reconciliation disabled
    let stored: string | null;
    try {
      stored = await this.storage.getItem(this.fpKey);
    } catch {
      stored = null;
    }
    if (stored === current) return tokens; // held tokens are under the current key → keep
    // Rotated/unknown key: the held tokens can't be spent under the current key. Drop them (only the
    // tokens+epoch; keep going below to adopt the current-key stamp) so the top-up redraws afresh.
    if (tokens.length > 0) {
      await this.storage.removeItem(this.walletKey);
      await this.storage.removeItem(this.epochKey);
    }
    await this.storage.setItem(this.fpKey, current); // stamp so the fresh batch is recognised as ours
    return [];
  }

  /**
   * Persist a snapshot of the in-memory state. The snapshot (token JSON, and the epoch string when
   * `includeEpoch`) is captured SYNCHRONOUSLY here — at the moment the mutation completed — then the
   * actual storage write is chained after any pending write so the on-disk order matches the
   * mutation order and two writes can never interleave.
   */
  private persist(includeEpoch: boolean): Promise<void> {
    const tokensJson = JSON.stringify(this.held);
    const epochStr = includeEpoch ? String(this.epoch) : null;
    return this.enqueue(async () => {
      await this.storage.setItem(this.walletKey, tokensJson);
      if (epochStr !== null) await this.storage.setItem(this.epochKey, epochStr);
    });
  }

  /**
   * Re-read the persisted token snapshot into the in-memory list. Called only on a spend miss (empty
   * / short), never on the hot path. Tokens can reach the shared storage through a DIFFERENT
   * EpochWallet instance — the on-demand draw tops up the active community's wallet over Tor through
   * its own instance — and those deposits are invisible to this instance's cached list. Reconciling
   * runs THROUGH the write chain so any of our own pending persists have already landed: the snapshot
   * we adopt is therefore never behind our own writes, only ever ahead by another instance's deposit.
   * This is exactly the pre-refactor read-through behaviour, but paid only when a spend would fail.
   */
  private resyncFromStorage(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const raw = await this.storage.getItem(this.walletKey);
        const parsed = raw ? (JSON.parse(raw) as StoredToken[]) : [];
        this.held = Array.isArray(parsed) ? parsed.filter(isStoredToken) : [];
      } catch {
        // keep the current in-memory list on a corrupt/failed read
      }
    });
  }

  /**
   * Serialize a storage task after all previously-enqueued ones. The returned promise reflects THIS
   * task's outcome (so callers still see write errors), while the chain itself swallows rejections so
   * a single transient storage failure doesn't wedge every future persist.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.writeChain.then(task);
    this.writeChain = result.then(undefined, () => undefined);
    return result;
  }
}

/**
 * Guards a persisted record as a spendable {@link StoredToken}. REQUIRES `k` (the holder-bound
 * secret): this is the P3 clean-cutover discard mechanism — a pre-P3 bearer token has no `k` field
 * and is unspendable under holder-proof enforcement anyway, so it is filtered out here (never
 * "repaired") and the wallet reads as if it were never held. This runs inside `hydrate()` BEFORE
 * `hadTokens` is computed (see below), so a wallet whose entire batch is legacy bearer tokens reads
 * as freshly empty and the normal low-watermark top-up redraws holder-bound tokens — no stall, no
 * separate migration path.
 */
function isStoredToken(v: unknown): v is StoredToken {
  const t = v as StoredToken;
  return (
    !!t &&
    typeof t.t === 'string' &&
    typeof t.s === 'string' &&
    typeof t.e === 'number' &&
    typeof t.k === 'string'
  );
}
