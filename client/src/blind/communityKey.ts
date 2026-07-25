/**
 * communityKey — the one shared 32-byte key that makes a post relay-blind but member-readable.
 *
 * Every blind post's author identity is encrypted (via ./attribution) under a single symmetric
 * key held by all members of a community. Members decrypt it to attribute posts (profiles,
 * threads, moderation); a relay/host, lacking the key, sees only ciphertext and cannot tell who
 * authored what. The key is the community's "membership secret" — it travels in the community /
 * join code the organizer hands out and is stored ONLY in hardware-backed SecureStorage.
 *
 * This mirrors channels/groupCrypto's shared-space-key model (a random 32-byte value used
 * directly as a NIP-44 conversation key) but scoped to the whole community rather than one space.
 *
 * STORAGE MODEL: the key at rest lives ONLY in the per-community list record (`EnrolledCommunity.
 * communityKey`, base64, hardware-encrypted) — there is NO separate global `stiq.community.key`
 * mirror, which used to survive a community switch as a cross-account leak of the "who" secret. This
 * module holds just the IN-MEMORY active key for the synchronous hot path; AppRuntime sets it per
 * active community (loadActiveCommunityPolicy) from that record and clears it on duress/switch. PURE
 * module (no persistence, no React).
 */
import {generateSecretKey} from 'nostr-tools/pure';
import {bytesToBase64, base64ToBytes} from '../util/base64';

/** Community key width — the NIP-44 v2 conversation-key size. */
export const COMMUNITY_KEY_BYTES = 32;

// In-memory active key so the hot feed/moderation path can resolve blind-post authors
// synchronously (mirrors the way space keys are cached in memory). Set per active community after
// loadActiveCommunityPolicy resolves, and on (re-)enrollment. null until loaded → posts resolve to
// their throwaway signer, exactly as a non-member/host sees them.
let _activeKey: Uint8Array | null = null;

/** Publish the loaded community key for synchronous readers. Pass null to clear (duress/logout/switch). */
export function setActiveCommunityKey(key: Uint8Array | null): void {
  _activeKey = key;
}

/** The in-memory active community key, or null if none is loaded yet. */
export function getActiveCommunityKey(): Uint8Array | null {
  return _activeKey;
}

/** Mint a fresh community key (organizer, once per community). */
export function mintCommunityKey(): Uint8Array {
  return generateSecretKey();
}

/** Encode a community key for transport inside a community / join code (base64). */
export function encodeCommunityKey(key: Uint8Array): string {
  return bytesToBase64(key);
}

/** Decode a community key from a community / join code. Returns null if malformed. */
export function decodeCommunityKey(b64: string): Uint8Array | null {
  try {
    const key = base64ToBytes(b64);
    return key.length === COMMUNITY_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}
