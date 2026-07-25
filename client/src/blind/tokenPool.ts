/**
 * TokenPool — ONE purpose-indexed layer over the shared {@link EpochWallet} for every AUXILIARY blind
 * token domain (T4.2 unification).
 *
 * Before this module, each auxiliary domain had its own hand-rolled shim over EpochWallet: a
 * `SpaceWallet` subclass (space-write), a `ReadWallet` subclass (content-encryption read meter), and a
 * `makeMediaWallets()` factory returning a `Map<MediaPurpose, EpochWallet>` (the four picture/audio
 * write/read domains) — three near-identical files (`spaceWallet.ts`, `readWallet.ts`,
 * `mediaWallets.ts`) each declaring their own `WalletItemBase` + storage-keys-for-wipe helper. That
 * divergence is what this module replaces: ONE canonical per-purpose item-base table and ONE pool
 * class, so adding/enabling a purpose is a config row (one `POOL_WALLET_ITEMS` entry) rather than a
 * new file. See token-analysis/TOKEN_FIXING_PLAN.md T4.2 and 03-kind-inventory-domain-sep.md §3.7.
 *
 * SCOPE — six of the seven spendable purposes, deliberately NOT seven:
 *   • `post` stays OUTSIDE the pool. AppRuntime's posting wallet is not a divergent copy — it is the
 *     ONE wallet with genuinely unique behavior (the proactive low-water top-up fired after every
 *     spend, plus the on-demand draw-and-retry safety net wired into `feedSigner`/`drawTokens`/
 *     `maybeRefillWallet`). Folding it into this pool would blur that real asymmetry, not remove one.
 *   • `enroll` was never wallet-pooled at all (see wallet.ts header) — it's a presented credential,
 *     not a spent-FIFO budget — so it has no place here either.
 * Everything else genuinely IS structurally identical — same in-memory source-of-truth, single-flight
 * hydration, serialized write chain, per-slot namespacing, and issuer-key fingerprint self-heal
 * (EpochWallet, untouched by this module) — only the SecureStorage item base differs per purpose, so a
 * flat per-purpose map is the whole abstraction needed.
 *
 * Every storage key below is copied byte-identical from the (now-removed) per-domain files, so an
 * existing on-disk wallet is found under the exact same keys after this refactor — no migration, no
 * re-draw, no lost tokens.
 */
import {EpochWallet, walletStorageKeys, type WalletItemBase} from './wallet';
import type {SecureStorage} from '../keys/keystore';
import {Purpose} from '../contracts';

/**
 * The four media token domains (asks #3/#4). The string values are the WIRE `purpose` carried on a
 * draw request and understood by the organizer's `signKeyByPurpose` map — they MUST match verbatim
 * (`picture-write` / `picture-read` / `audio-write` / `audio-read`). Sourced from the shared
 * {@link Purpose} registry (contracts/index.ts, T4.1) so this union can never drift from it.
 */
export type MediaPurpose =
  | typeof Purpose.PictureWrite
  | typeof Purpose.PictureRead
  | typeof Purpose.AudioWrite
  | typeof Purpose.AudioRead;

/** All four media purposes, in a stable order (used to build/iterate the media-only subset). */
export const MEDIA_PURPOSES: readonly MediaPurpose[] = [
  Purpose.PictureWrite,
  Purpose.PictureRead,
  Purpose.AudioWrite,
  Purpose.AudioRead,
];

/**
 * The six AUXILIARY blind-token purposes pooled here (see module header for why `post`/`enroll` are
 * excluded).
 */
export type PoolPurpose = typeof Purpose.Read | MediaPurpose | typeof Purpose.SpaceWrite;

/** All six pooled purposes, in a stable order — matches the historical field/construction/clear order
 *  (read, then the four media domains, then space-write) so log/iteration order is unchanged. */
export const POOL_PURPOSES: readonly PoolPurpose[] = [
  Purpose.Read,
  ...MEDIA_PURPOSES,
  Purpose.SpaceWrite,
];

/**
 * SecureStorage item bases for the four media domains — byte-identical to the pre-T4.2
 * `MEDIA_WALLET_ITEMS` constant in the now-removed `mediaWallets.ts`.
 */
export const MEDIA_WALLET_ITEMS: Readonly<Record<MediaPurpose, WalletItemBase>> = {
  [Purpose.PictureWrite]: {
    tokens: 'stiq.picwritewallet.tokens',
    epoch: 'stiq.picwritewallet.epoch',
    keyfp: 'stiq.picwritewallet.keyfp',
  },
  [Purpose.PictureRead]: {
    tokens: 'stiq.picreadwallet.tokens',
    epoch: 'stiq.picreadwallet.epoch',
    keyfp: 'stiq.picreadwallet.keyfp',
  },
  [Purpose.AudioWrite]: {
    tokens: 'stiq.audwritewallet.tokens',
    epoch: 'stiq.audwritewallet.epoch',
    keyfp: 'stiq.audwritewallet.keyfp',
  },
  [Purpose.AudioRead]: {
    tokens: 'stiq.audreadwallet.tokens',
    epoch: 'stiq.audreadwallet.epoch',
    keyfp: 'stiq.audreadwallet.keyfp',
  },
};

/**
 * Canonical SecureStorage item base per pooled purpose — byte-identical to the three pre-T4.2
 * constants this table replaces (`READ_WALLET_ITEMS`, `MEDIA_WALLET_ITEMS`, `SPACE_WALLET_ITEMS`), so
 * every existing on-disk wallet is found under the exact same keys. This is the one "config row per
 * purpose" the module header refers to: enabling an eighth pooled purpose is adding one entry here (+
 * to {@link POOL_PURPOSES}), not a new file.
 */
export const POOL_WALLET_ITEMS: Readonly<Record<PoolPurpose, WalletItemBase>> = {
  [Purpose.Read]: {
    tokens: 'stiq.readwallet.tokens',
    epoch: 'stiq.readwallet.epoch',
    keyfp: 'stiq.readwallet.keyfp',
  },
  ...MEDIA_WALLET_ITEMS,
  [Purpose.SpaceWrite]: {
    tokens: 'stiq.spacewallet.tokens',
    epoch: 'stiq.spacewallet.epoch',
    keyfp: 'stiq.spacewallet.keyfp',
  },
};

/**
 * Construct ONE pooled wallet directly, without building the whole six-purpose pool — the direct
 * replacement for the old `new ReadWallet(...)` / `new SpaceWallet(...)` call sites (tests that seed a
 * single purpose's tokens into SecureStorage under the same keys a live {@link TokenPool} instance
 * reads from). Byte-identical to `new TokenPool(storage, namespace).get(purpose)`, just without
 * constructing the other five.
 */
export function makePoolWallet(
  purpose: PoolPurpose,
  storage: SecureStorage,
  namespace = '',
  keyFingerprint?: string,
): EpochWallet {
  return new EpochWallet(storage, namespace, keyFingerprint, POOL_WALLET_ITEMS[purpose]);
}

/**
 * The member's six auxiliary blind-token budgets, one {@link EpochWallet} per {@link PoolPurpose},
 * each bound to its own SecureStorage item base so none of the six (nor the separate posting wallet)
 * ever collide. Construct once per identity slot (mirrors `new EpochWallet(storage, namespace)`);
 * AppRuntime rebuilds it in lock-step with the posting wallet on every slot switch
 * (`rebuildIdentity`).
 *
 * Every wallet is constructed unconditionally regardless of which relay capabilities are currently
 * live — exactly like the pre-T4.2 shims did — so `get()` never needs to handle a missing purpose.
 * Nothing draws or spends a given purpose until its own gate opens (space_tokens_required,
 * media_write_domains, content_encryption); until then the pool is just six empty, untouched wallets,
 * ships dark like before.
 */
export class TokenPool {
  private readonly wallets: ReadonlyMap<PoolPurpose, EpochWallet>;

  constructor(storage: SecureStorage, namespace = '') {
    this.wallets = new Map(
      POOL_PURPOSES.map(purpose => [purpose, makePoolWallet(purpose, storage, namespace)] as const),
    );
  }

  /** The purpose's dedicated wallet. Always defined — every {@link POOL_PURPOSES} entry is constructed
   *  up front (see class doc) — so this never returns undefined for a valid PoolPurpose. */
  get(purpose: PoolPurpose): EpochWallet {
    const wallet = this.wallets.get(purpose);
    if (!wallet) {
      // Defensive only: every PoolPurpose is constructed in the constructor above, so this can only
      // fire if POOL_PURPOSES and the PoolPurpose type were ever allowed to drift apart.
      throw new Error(`TokenPool: no wallet constructed for purpose "${purpose}"`);
    }
    return wallet;
  }

  /** Bind (or clear) one purpose's issuer-key fingerprint — see EpochWallet.setKeyFingerprint. */
  setKeyFingerprint(purpose: PoolPurpose, fingerprint: string | undefined): void {
    this.get(purpose).setKeyFingerprint(fingerprint);
  }

  /** Wipe every pooled wallet (duress reset / re-enroll) — a new account/slot must never inherit a
   *  sibling's stash in any of the six domains. */
  async clearAll(): Promise<void> {
    for (const wallet of this.wallets.values()) await wallet.clear();
  }
}

/**
 * The eighteen SecureStorage keys (3 per pooled purpose) under `namespace` — for the per-slot wipe
 * (duress / leave / re-enroll). Generalizes the three separate `*WalletStorageKeys` helpers the old
 * shims each exported into one function over every pooled purpose.
 */
export function tokenPoolStorageKeys(namespace: string): {tokens: string; epoch: string; keyfp: string}[] {
  return POOL_PURPOSES.map(purpose => walletStorageKeys(namespace, POOL_WALLET_ITEMS[purpose]));
}
