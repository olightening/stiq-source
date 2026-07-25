/**
 * contentKey — the rotating per-epoch key that makes a blind post's CONTENT members-only.
 *
 * STIQ has two independent secrets on a blind post, protecting two different things:
 *
 *   • the COMMUNITY key (see ./communityKey) decrypts the `stiq_attr` attribution — i.e. WHO wrote
 *     a post. Every member holds it (it rides in the join code), so authorship is always
 *     member-readable (needed for profiles, threads, moderation).
 *
 *   • a CONTENT EPOCH key (this module) decrypts the post BODY — i.e. WHAT was written. It is NOT
 *     in the join code. It rotates every N posts (volume-based), and a member obtains an epoch's
 *     key only by spending a blind READ-token (see ./readToken). That makes reading a *metered*
 *     capability: a member has a large-but-finite budget of epoch unlocks, so handing the reading
 *     capability to a malicious actor merely burns the sharer's own budget and exposes only the
 *     already-unlocked epoch windows — not all past/future content.
 *
 * Splitting the two keys is deliberate: authorship stays cheap and always-available to members
 * (moderators can attribute a post without spending a read-token), while the content itself is
 * the thing behind the meter.
 *
 * This mirrors channels/groupCrypto's epoch-keyed space model (a random 32-byte value used
 * directly as a NIP-44 conversation key, addressed by a `ke` epoch tag) but scoped to the whole
 * community feed. PURE module: SecureStorage is injected once at app init; the hot feed path reads
 * the in-memory caches synchronously.
 *
 * SHIPS DARK: with no epoch key loaded, {@link getWriteContentKey} returns null and BlindSigner
 * leaves content as plaintext — exactly today's behaviour. The feature turns on only once a
 * community provisions content keys.
 */
import {generateSecretKey} from 'nostr-tools/pure';
import {bytesToHex, hexToBytes} from '../util/hex';
import type {SecureStorage} from '../keys/keystore';

/** A content epoch key is exactly 32 bytes — the NIP-44 v2 conversation-key width. */
export const CONTENT_KEY_BYTES = 32;

/**
 * kind-30078 `d` tag under which the organizer announces the CURRENT content epoch (the window new
 * posts seal under) so a writing client can provision that epoch's key before composing. Signed by the
 * organizer, ingested client-side in AppRuntime.applyOrgConfig. MUST match the organizer's
 * `signConfig('stiq:content-epoch', …)` (issuer/organizer-server.mjs publishContentEpoch).
 */
export const CONTENT_EPOCH_D_TAG = 'stiq:content-epoch';

/**
 * Parse a `stiq:content-epoch` doc body `{epoch, rotateEvery}`. Returns the announced current epoch
 * (a non-negative integer) or null for a malformed/foreign doc. `rotateEvery` is advisory (the client
 * doesn't rotate — the organizer does) so it is not surfaced.
 */
export function parseContentEpochDoc(content: string): {epoch: number} | null {
  try {
    const raw = JSON.parse(content) as {epoch?: unknown};
    const epoch = raw?.epoch;
    if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) return {epoch};
  } catch {
    // malformed → ignore, leave state untouched
  }
  return null;
}

let _storage: SecureStorage | null = null;

/** Wire the secure storage backing content epoch keys (app init). Idempotent. */
export function setContentKeyStorage(storage: SecureStorage | null): void {
  _storage = storage;
}

// In-memory unlocked epoch keys, so the synchronous feed/decrypt path can resolve content without
// awaiting storage. Populated after loadContentKeys() at start and after each read-token unlock.
const _epochKeys = new Map<number, Uint8Array>();
// The highest unlocked epoch — new posts are written (encrypted) under this one. -1 when none.
let _writeEpoch = -1;

/**
 * Publish an unlocked content epoch key for synchronous readers/writers. Advances the write epoch
 * if this is the newest. Pass this after a read-token unlock resolves, or on hydrate at start.
 */
export function setContentEpochKey(epoch: number, key: Uint8Array): void {
  if (!Number.isInteger(epoch) || epoch < 0 || key.length !== CONTENT_KEY_BYTES) return;
  _epochKeys.set(epoch, key);
  if (epoch > _writeEpoch) _writeEpoch = epoch;
}

/** The unlocked key for a specific epoch, or null if that epoch is still locked. */
export function getContentEpochKey(epoch: number): Uint8Array | null {
  return _epochKeys.get(epoch) ?? null;
}

/**
 * The key new posts should be encrypted under: the newest unlocked epoch, or null when no content
 * key is loaded (→ BlindSigner ships plaintext, unchanged). Returning the newest epoch means a
 * member always writes into the current window they can also read.
 */
export function getWriteContentKey(): {epoch: number; key: Uint8Array} | null {
  if (_writeEpoch < 0) return null;
  const key = _epochKeys.get(_writeEpoch);
  return key ? {epoch: _writeEpoch, key} : null;
}

/** Whether the given epoch is currently unlocked (readable) on this device. */
export function hasContentEpochKey(epoch: number): boolean {
  return _epochKeys.has(epoch);
}

/** Clear all in-memory content keys (duress / logout / community switch). Storage is untouched. */
export function clearActiveContentKeys(): void {
  _epochKeys.clear();
  _writeEpoch = -1;
}

/** Mint a fresh content epoch key (organizer, once per rotation). */
export function mintContentKey(): Uint8Array {
  return generateSecretKey();
}

// ── persistence (SecureStorage) ────────────────────────────────────────────────────────────────
//
// Keys are SECRETS: stored only in the hardware-backed store, one item per (account, epoch), plus a
// small index of unlocked epochs so loadContentKeys() can rehydrate the in-memory caches at start.
// The `ns` namespace is the ACCOUNT (identity slot) — a read-unlock is a per-member metered budget,
// so a sibling account in the same community must unlock (and pay for) content windows independently.

function keyItem(ns: string, epoch: number): string {
  return `stiq.content.key:${ns}:${epoch}`;
}
function indexItem(ns: string): string {
  return `stiq.content.key:${ns}:epochs`;
}

/** Persist an unlocked epoch key and record it in the account's unlocked-epoch index. */
export async function storeContentEpochKey(
  ns: string,
  epoch: number,
  key: Uint8Array,
): Promise<void> {
  if (!_storage) return;
  if (key.length !== CONTENT_KEY_BYTES) {
    throw new Error('refusing to store a malformed content epoch key');
  }
  await _storage.setItem(keyItem(ns, epoch), bytesToHex(key));
  const epochs = await readEpochIndex(ns);
  if (!epochs.includes(epoch)) {
    epochs.push(epoch);
    await _storage.setItem(indexItem(ns), epochs.join(','));
  }
}

/**
 * Rehydrate the in-memory content-key caches for an account from secure storage (app start /
 * account switch). Clears any previously-loaded keys first so switching accounts can't leak a key
 * across the silo boundary. No-op when storage is unwired.
 */
export async function loadContentKeys(ns: string): Promise<void> {
  clearActiveContentKeys();
  if (!_storage) return;
  for (const epoch of await readEpochIndex(ns)) {
    try {
      const hex = await _storage.getItem(keyItem(ns, epoch));
      if (!hex) continue;
      const key = hexToBytes(hex);
      if (key.length === CONTENT_KEY_BYTES) setContentEpochKey(epoch, key);
    } catch {
      // skip a corrupt entry rather than abort the whole hydrate
    }
  }
}

/** Wipe every stored content key for an account (duress reset / leave). */
export async function clearStoredContentKeys(ns: string): Promise<void> {
  if (!_storage) return;
  for (const epoch of await readEpochIndex(ns)) {
    await _storage.removeItem(keyItem(ns, epoch));
  }
  await _storage.removeItem(indexItem(ns));
}

/**
 * Copy every stored content key from the `fromNs` namespace into `toNs`, skip-if-present. Used by the
 * per-slot migration to move an existing member's content keys from the former per-community namespace
 * into their account's per-slot namespace. Best-effort; no-op without storage. (The feature ships dark,
 * so in practice there is usually nothing to copy — this just guarantees no loss if it was provisioned.)
 */
export async function migrateContentKeys(
  storage: SecureStorage,
  fromNs: string,
  toNs: string,
): Promise<void> {
  try {
    const raw = await storage.getItem(indexItem(fromNs));
    if (!raw) return;
    const epochs = raw.split(',').map(s => Number(s)).filter(n => Number.isInteger(n) && n >= 0);
    if (epochs.length === 0) return;
    for (const epoch of epochs) {
      const to = keyItem(toNs, epoch);
      if ((await storage.getItem(to)) !== null) continue;
      const hex = await storage.getItem(keyItem(fromNs, epoch));
      if (hex !== null) await storage.setItem(to, hex);
    }
    if ((await storage.getItem(indexItem(toNs))) === null) {
      await storage.setItem(indexItem(toNs), epochs.join(','));
    }
  } catch {
    // best effort — a content-key that fails to migrate is simply re-unlocked on the next read-token
  }
}

async function readEpochIndex(ns: string): Promise<number[]> {
  if (!_storage) return [];
  try {
    const raw = await _storage.getItem(indexItem(ns));
    if (!raw) return [];
    return raw
      .split(',')
      .map(s => Number(s))
      .filter(n => Number.isInteger(n) && n >= 0);
  } catch {
    return [];
  }
}
