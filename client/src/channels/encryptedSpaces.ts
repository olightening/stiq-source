/**
 * Persists the set of space ids (NIP-29 group ids / private channels) the user treats as
 * E2E-ENCRYPTED — independent of the relay-supplied 39000 metadata.
 *
 * WHY THIS EXISTS (confidentiality-critical): the privacy classification of a space must NOT depend
 * solely on the relay's kind-39000 `private` flag. Relying on the relay alone leaks plaintext in two
 * cases:
 *   (a) the create→send window, before the relay's 39000 has streamed back; and
 *   (b) a MALICIOUS relay stripping the `private` flag to coerce a plaintext send.
 * So we keep a LOCAL, persisted record of "spaces I obtained a key for / treat as encrypted". A
 * groupId is added here at every point a space key is obtained (createGroup mint, acceptInviteLink
 * fragment, and a VALID incoming 30079 delivery). `outgoingSeal` consults this set (OR a cached key)
 * to decide whether a plaintext send is ever allowed — fail-closed.
 *
 * Mirrors groupMembership.ts: an AsyncStorage-backed Set<string> with an in-memory cache hydrated
 * once at startup so `isEncryptedSpace(id)` is SYNCHRONOUS (decrypt-on-read / outgoing-seal both run
 * during render and can't await). Stored in AsyncStorage (not the keystore): the membership of this
 * set is not itself a secret — the KEYS are, and those stay keystore-only. Knowing "space X is
 * encrypted" reveals nothing the relay doesn't already imply.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {LEGACY_SPACES_ENCRYPTED, spacesEncryptedKey} from '../app/workspaceKeys';

// Encrypted-space membership is per ACCOUNT (identity slot): only the account that obtained a space
// key treats that space as encrypted. The key is mutable and repointed by loadEncryptedSpaces(slotId)
// at init and on every community/account switch.
let _key = LEGACY_SPACES_ENCRYPTED;

/** In-memory mirror of the persisted set, hydrated by {@link loadEncryptedSpaces} at startup. */
let _cache = new Set<string>();

/**
 * Load the persisted encrypted-space ids for account `slotId` into the in-memory cache (call at app
 * init AND on every community/account switch, like loadJoinedGroups). Repoints the storage key and
 * replaces the cache, so a switch never carries account A's encrypted-space set into B. Never throws.
 */
export async function loadEncryptedSpaces(slotId?: string): Promise<string[]> {
  _key = slotId ? spacesEncryptedKey(slotId) : LEGACY_SPACES_ENCRYPTED;
  try {
    const raw = await AsyncStorage.getItem(_key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    _cache = new Set(ids);
    return [...ids];
  } catch {
    _cache = new Set();
    return [];
  }
}

/**
 * Mark a space id as E2E-encrypted: update the in-memory cache SYNCHRONOUSLY (so isEncryptedSpace is
 * true immediately, closing the create→send race) and persist best-effort. Idempotent.
 */
export async function addEncryptedSpace(id: string): Promise<void> {
  if (_cache.has(id)) return;
  _cache.add(id);
  try {
    await AsyncStorage.setItem(_key, JSON.stringify([..._cache]));
  } catch {
    // best effort — the in-memory cache already reflects the change for this session
  }
}

/** Synchronously test whether a space is treated as encrypted (reads the in-memory cache). */
export function isEncryptedSpace(id: string): boolean {
  return _cache.has(id);
}

/** Test-only: reset the in-memory cache (jest isolates AsyncStorage but the module cache persists). */
export function _resetEncryptedSpacesCache(): void {
  _cache = new Set();
}
