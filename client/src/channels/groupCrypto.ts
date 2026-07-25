/**
 * groupCrypto — E2E encryption core for PRIVATE groups & PRIVATE channels (#8).
 *
 * Model (locked decision): ONE shared 32-byte symmetric key per private space, used DIRECTLY as
 * the NIP-44 v2 conversation key for message content (`nip44.encrypt(plaintext, key32)`). The key
 * is minted with `generateSecretKey()` (32 cryptographically-random bytes), travels to joiners in
 * the invite URL FRAGMENT (never sent to a server), and is ROTATED on member removal: a new
 * epoch key is minted and re-wrapped per remaining member with a NIP-44 conversation key derived
 * from `getConversationKey(orgSK, memberPK)`.
 *
 * Why a random 32-byte key works as a NIP-44 conversation key: NIP-44 v2 treats the conversation
 * key as an opaque 32-byte HKDF input; it never requires it to be an ECDH output. A uniformly
 * random 32-byte value is a perfectly valid (and higher-entropy) conversation key.
 *
 * SECURITY INVARIANTS
 *  - The plaintext (including the author's display-name header) is encrypted BEFORE it ever leaves
 *    the device, so the relay only ever sees ciphertext for a private space.
 *  - Keys are SECRETS: stored only in the hardware-backed SecureStorage (never AsyncStorage, never
 *    logged). The fragment carrying the key is the membership credential by design.
 *  - Decrypt failures degrade gracefully — callers wrap in try/catch and HIDE the message rather
 *    than crash or render ciphertext.
 *
 * This module is PURE (no React). Persistence uses an injected SecureStorage (set once at app init
 * via {@link setSpaceKeyStorage}; tests inject an InMemorySecureStorage) and is namespaced PER
 * ACCOUNT (identity slot) via {@link setSpaceKeyNamespace} — set in lock-step with the active slot so
 * an account that never joined a space can never decrypt it, and re-pointed on every account switch.
 */
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import type {Event} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {bytesToHex, hexToBytes} from '../util/hex';
import type {SecureStorage, UnsignedEvent} from '../keys/keystore';
import {Kind} from '../nostr/events';

/** A space key is exactly 32 bytes — the NIP-44 v2 conversation-key width. */
export const SPACE_KEY_BYTES = 32;

/**
 * E2E key for a PRIVATE space: the shared 32-byte symmetric key + its epoch. Passed to a message
 * builder to NIP-44-encrypt the body under `key` and tag it `['encrypted','nip44']` + `['ke',n]`.
 */
export interface SpaceKey {
  key: Uint8Array;
  epoch: number;
}

// ── key mint ────────────────────────────────────────────────────────────────────────────────

/** Mint a fresh 32-byte symmetric space key (cryptographically random). */
export function mintGroupKey(): Uint8Array {
  // generateSecretKey() returns 32 random bytes from a CSPRNG — exactly what we need for a key32.
  return generateSecretKey();
}

// ── message content encrypt / decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt a private-space message body with the shared space key. The returned string is the
 * NIP-44 v2 ciphertext that goes on the wire as the event content.
 */
export function encryptForSpace(plaintext: string, key: Uint8Array): string {
  return nip44.encrypt(plaintext, key);
}

/**
 * Decrypt a private-space message body with the shared space key. Throws on a wrong key or
 * tampered ciphertext (NIP-44 auth tag mismatch) — callers MUST try/catch and hide on failure.
 */
export function decryptForSpace(ciphertext: string, key: Uint8Array): string {
  return nip44.decrypt(ciphertext, key);
}

// ── per-member key wrap / unwrap (delivery + rotation) ─────────────────────────────────────────

/** Base64 of the raw key bytes — the plaintext we wrap to a member (compact, round-trippable). */
function keyToBase64(key: Uint8Array): string {
  // btoa over a binary string. RN/Hermes provides global btoa/atob (polyfilled); fall back to a
  // manual encoder so this stays pure and test-safe under Node too.
  return base64FromBytes(key);
}

function keyFromBase64(b64: string): Uint8Array {
  const bytes = bytesFromBase64(b64);
  return bytes;
}

/**
 * Wrap the space key FOR a specific member: NIP-44-encrypt the base64 key under the conversation
 * key derived from the sender's secret key and the member's pubkey. Only that member's secret key
 * can unwrap it. Used for invite-less delivery and for rotation re-distribution.
 */
export function wrapKeyForMember(
  key: Uint8Array,
  senderSk: Uint8Array,
  memberPubkey: string,
): string {
  const convo = nip44.utils.getConversationKey(senderSk, memberPubkey);
  return nip44.encrypt(keyToBase64(key), convo);
}

/**
 * Unwrap a space key a sender wrapped for us. Derives the same conversation key from OUR secret
 * key and the SENDER's pubkey (ECDH is symmetric), then decrypts. Throws if not addressed to us
 * or tampered — callers try/catch and skip.
 */
export function unwrapKeyFromSender(
  blob: string,
  recipientSk: Uint8Array,
  senderPubkey: string,
): Uint8Array {
  const convo = nip44.utils.getConversationKey(recipientSk, senderPubkey);
  const b64 = nip44.decrypt(blob, convo);
  const key = keyFromBase64(b64);
  if (key.length !== SPACE_KEY_BYTES) {
    throw new Error('unwrapped space key has the wrong length');
  }
  return key;
}

// ── key-delivery event (kind 30079) build / parse ──────────────────────────────────────────────

/**
 * Build an UNSIGNED key-delivery event (kind 30079) delivering `key` (epoch `epoch`) of space
 * `spaceId` to one member. The body is wrapped to that member (only their sk unwraps it). The
 * organizer signs and publishes one of these per remaining member on rotation.
 *
 * Addressable (`d = <spaceId>:<epoch>:<member>`) so re-sending replaces rather than piles up, and
 * `['p', member]` lets the member subscribe with `#p == me`.
 */
export function buildKeyDelivery(
  spaceId: string,
  epoch: number,
  key: Uint8Array,
  senderSk: Uint8Array,
  memberPubkey: string,
): UnsignedEvent {
  const blob = wrapKeyForMember(key, senderSk, memberPubkey);
  return {
    kind: Kind.SpaceKeyDelivery,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `${spaceId}:${epoch}:${memberPubkey}`],
      ['p', memberPubkey],
      ['h', spaceId],
      ['ke', String(epoch)],
    ],
    content: blob,
  };
}

export interface KeyDelivery {
  spaceId: string;
  epoch: number;
  /** The member this delivery is addressed to (its `p` tag). */
  recipient: string;
  /** The wrapped key blob (content). */
  blob: string;
  /** The organizer/sender pubkey (needed to derive the unwrap conversation key). */
  sender: string;
}

/** Parse a kind-30079 delivery event into its routing fields. Returns null if malformed. */
export function parseKeyDelivery(event: Event): KeyDelivery | null {
  if (event.kind !== Kind.SpaceKeyDelivery) return null;
  const spaceId = event.tags.find(t => t[0] === 'h' && t[1])?.[1];
  const recipient = event.tags.find(t => t[0] === 'p' && t[1])?.[1];
  const keRaw = event.tags.find(t => t[0] === 'ke' && t[1] !== undefined)?.[1];
  if (!spaceId || !recipient || keRaw === undefined || !event.content) return null;
  const epoch = Number(keRaw);
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  return {spaceId, epoch, recipient, blob: event.content, sender: event.pubkey};
}

// ── invite fragment encode / parse ─────────────────────────────────────────────────────────────

/**
 * Encode `{key, epoch}` as a URL-fragment payload: `k=<base64url(key)>&e=<epoch>`. This is appended
 * after `#` in an invite link and is NEVER transmitted to a server (fragments stay client-side).
 */
export function encodeKeyFragment(key: Uint8Array, epoch: number): string {
  const k = base64UrlFromBytes(key);
  return `k=${k}&e=${Math.max(0, Math.floor(epoch))}`;
}

/**
 * Parse an invite key fragment back into `{key, epoch}`. ROBUST to malformed input: returns null
 * (never throws) on a missing/garbled key, wrong key length, or a non-numeric epoch. Accepts a
 * fragment with or without a leading `#`, and ignores unrelated params.
 */
export function parseKeyFragment(fragment: string): {key: Uint8Array; epoch: number} | null {
  try {
    if (typeof fragment !== 'string') return null;
    const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment;
    const params = new Map<string, string>();
    for (const part of frag.split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      params.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const kRaw = params.get('k');
    if (!kRaw) return null;
    const key = bytesFromBase64Url(kRaw);
    if (key.length !== SPACE_KEY_BYTES) return null;
    // Epoch defaults to 0 when absent; must parse to a finite non-negative integer otherwise.
    const eRaw = params.get('e');
    let epoch = 0;
    if (eRaw !== undefined) {
      const n = Number(eRaw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
      epoch = n;
    }
    return {key, epoch};
  } catch {
    return null;
  }
}

// ── keystore persistence (SECRETS — SecureStorage only) ────────────────────────────────────────

/**
 * Injected secure storage backing space-key persistence. Set ONCE at app init with the native
 * hardware store (see App.tsx); tests inject an InMemorySecureStorage. Functions below no-op /
 * return null when storage is absent (e.g. a build without the native keystore) rather than throw,
 * so the app still runs (private spaces just can't decrypt without a real store).
 */
let _storage: SecureStorage | null = null;

// The active ACCOUNT (identity slot) whose space keys these functions read/write. Empty string ⇒ the
// legacy un-namespaced layout (pre-silo / un-enrolled), preserved for backward-compat + the migration
// source. Set via setSpaceKeyNamespace in lock-step with the active slot (AppRuntime.rebuildIdentity).
let _namespace = '';

/** Wire the secure storage used for space keys (app init). Idempotent. */
export function setSpaceKeyStorage(storage: SecureStorage | null): void {
  _storage = storage;
}

/**
 * Bind the account (identity slot) whose space keys are read/written. Pass the active slot id on init
 * and on every community/account switch; `undefined` (un-enrolled) falls back to the legacy global
 * layout. Space keys are secrets bound to one membership, so namespacing them per slot stops one
 * account from decrypting a private space another account joined.
 */
export function setSpaceKeyNamespace(slotId: string | undefined): void {
  _namespace = slotId ?? '';
}

/** Storage-key prefix for the active account namespace (`<slotId>:`), or '' for the legacy layout. */
function nsPrefix(): string {
  return _namespace ? `${_namespace}:` : '';
}

/** The storage-key namespace for a single space's epoch key (per active account). */
function spaceKeyItem(spaceId: string, epoch: number): string {
  return `spacekey:${nsPrefix()}${spaceId}:${epoch}`;
}

/** The storage-key under which the highest-known epoch for a space is tracked (per active account). */
function spaceEpochItem(spaceId: string): string {
  return `spacekey:${nsPrefix()}${spaceId}:epoch`;
}

/**
 * Persist `key` for `(spaceId, epoch)` in secure storage and advance the space's tracked current
 * epoch if this is the newest. No-op when no storage is wired.
 */
export async function storeSpaceKey(spaceId: string, epoch: number, key: Uint8Array): Promise<void> {
  if (!_storage) return;
  if (key.length !== SPACE_KEY_BYTES) {
    throw new Error('refusing to store a malformed space key');
  }
  await _storage.setItem(spaceKeyItem(spaceId, epoch), bytesToHex(key));
  // Track the highest epoch so currentEpoch() is O(1) and outgoing messages pick the latest key.
  const prev = await readEpoch(spaceId);
  if (epoch > prev) {
    await _storage.setItem(spaceEpochItem(spaceId), String(epoch));
  }
}

/** Load the key for `(spaceId, epoch)`, or null when absent / no storage / corrupt. */
export async function loadSpaceKey(spaceId: string, epoch: number): Promise<Uint8Array | null> {
  if (!_storage) return null;
  try {
    const hex = await _storage.getItem(spaceKeyItem(spaceId, epoch));
    if (!hex) return null;
    const key = hexToBytes(hex);
    return key.length === SPACE_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** The highest stored epoch for a space (-1 when none is known). */
export async function currentEpoch(spaceId: string): Promise<number> {
  return readEpoch(spaceId);
}

/** Internal: read the tracked highest epoch, or -1. */
async function readEpoch(spaceId: string): Promise<number> {
  if (!_storage) return -1;
  try {
    const raw = await _storage.getItem(spaceEpochItem(spaceId));
    if (raw === null) return -1;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
}

/** Whether ANY key is known for a space (i.e. the viewer can decrypt at least one epoch). */
export async function hasSpaceKey(spaceId: string): Promise<boolean> {
  return (await readEpoch(spaceId)) >= 0;
}

// ── namespace migration / wipe (raw-key, storage-injected — used off the hot path) ──────────────
//
// These build the storage keys directly (not via the module `_namespace`) so the migration and the
// leave/duress wipe can target a specific account namespace without disturbing the active one.

/** The legacy (un-namespaced) or per-slot storage keys for one space's epoch, computed directly. */
function rawSpaceKeyItem(namespace: string, spaceId: string, epoch: number): string {
  return `spacekey:${namespace ? `${namespace}:` : ''}${spaceId}:${epoch}`;
}
function rawSpaceEpochItem(namespace: string, spaceId: string): string {
  return `spacekey:${namespace ? `${namespace}:` : ''}${spaceId}:epoch`;
}

/**
 * Copy the legacy GLOBAL (un-namespaced) space keys for `spaceIds` into account `slotId`'s namespace,
 * skip-if-present so it's idempotent and never clobbers a newer per-slot key. Best-effort: a single
 * unreadable entry is skipped. Used by the per-slot migration so an existing member keeps decrypting
 * every private space after the keys move from global → per-account storage. No-op without storage.
 */
export async function migrateSpaceKeysToSlot(
  storage: SecureStorage,
  slotId: string,
  spaceIds: Iterable<string>,
): Promise<void> {
  for (const spaceId of new Set(spaceIds)) {
    try {
      const topRaw = await storage.getItem(rawSpaceEpochItem('', spaceId));
      const top = topRaw === null ? -1 : Number(topRaw);
      if (!Number.isInteger(top) || top < 0) continue;
      for (let e = 0; e <= top; e++) {
        const from = rawSpaceKeyItem('', spaceId, e);
        const to = rawSpaceKeyItem(slotId, spaceId, e);
        if ((await storage.getItem(to)) !== null) continue;
        const hex = await storage.getItem(from);
        if (hex !== null) await storage.setItem(to, hex);
      }
      const epochTo = rawSpaceEpochItem(slotId, spaceId);
      if ((await storage.getItem(epochTo)) === null) await storage.setItem(epochTo, String(top));
    } catch {
      // best effort — a space that fails to migrate is simply re-keyed on the next invite/delivery
    }
  }
}

/**
 * Wipe account `slotId`'s stored keys for `spaceIds` (leave / duress). Best-effort per key. Callers
 * pass the account's known space ids (its joined-groups ∪ encrypted-spaces sets) since SecureStorage
 * cannot be enumerated. No-op without storage.
 */
export async function clearSpaceKeysForSlot(
  storage: SecureStorage,
  slotId: string,
  spaceIds: Iterable<string>,
): Promise<void> {
  for (const spaceId of new Set(spaceIds)) {
    try {
      const topRaw = await storage.getItem(rawSpaceEpochItem(slotId, spaceId));
      const top = topRaw === null ? -1 : Number(topRaw);
      if (Number.isInteger(top) && top >= 0) {
        for (let e = 0; e <= top; e++) await storage.removeItem(rawSpaceKeyItem(slotId, spaceId, e));
      }
      await storage.removeItem(rawSpaceEpochItem(slotId, spaceId));
    } catch {
      // best effort — keep wiping the rest
    }
  }
}

// ── base64 / base64url codecs (pure, no Buffer) ────────────────────────────────────────────────
//
// Kept local so this module has no Buffer/global dependency and round-trips identically under
// Hermes (RN) and Node (jest). Standard base64 for the wrapped-key blob, base64url (no padding)
// for URL fragments.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64FromBytes(bytes: Uint8Array): string {
  return encodeWithAlphabet(bytes, B64, true);
}
function base64UrlFromBytes(bytes: Uint8Array): string {
  return encodeWithAlphabet(bytes, B64URL, false);
}

function encodeWithAlphabet(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : pad ? '=' : '';
    out += i + 2 < bytes.length ? alphabet[b2 & 0x3f] : pad ? '=' : '';
  }
  return out;
}

function bytesFromBase64(b64: string): Uint8Array {
  return decodeWithAlphabet(b64.replace(/=+$/, ''), B64);
}
function bytesFromBase64Url(b64url: string): Uint8Array {
  return decodeWithAlphabet(b64url.replace(/=+$/, ''), B64URL);
}

function decodeWithAlphabet(s: string, alphabet: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) lookup.set(alphabet[i]!, i);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const v = lookup.get(ch);
    if (v === undefined) throw new Error('invalid base64 character');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Re-export to let callers derive a pubkey from a wrap sender sk in tests without re-importing. */
export {getPublicKey};
