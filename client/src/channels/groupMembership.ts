/**
 * Persists the set of NIP-29 group ids the user has created or joined.
 *
 * NIP-29 group state (39000-39003) and chat (kind 9) are NEVER on the firehose — the relay
 * requires a group-scoped query (`#h`/`#d`). So unlike NIP-53 channels (whose state rides the
 * feed and is rebuilt from cache), the client cannot discover "which groups am I in" from the
 * cache alone: it must remember each group id and open a scoped subscription to pull its state.
 *
 * This list is what lets a freshly-created/joined group appear in the UI and survive a restart:
 * on every relay (re)connect the runtime re-subscribes to each id, so the relay re-streams the
 * 39002 member list that `myGroupSummaries` reads. Stored in AsyncStorage (not the keystore) —
 * group membership is not a secret the way the signing key is, and it must be readable before
 * unlock to drive the subscription plan.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {LEGACY_GROUPS_JOINED, groupsJoinedKey} from '../app/workspaceKeys';

// The joined-group set is per ACCOUNT (identity slot): NIP-29 membership is bound to one npub, so two
// accounts in the same community keep independent joined-group sets. `slotId` is the active slot id;
// omitting it targets the legacy global key (pre-silo / un-enrolled).
const keyFor = (slotId?: string): string => (slotId ? groupsJoinedKey(slotId) : LEGACY_GROUPS_JOINED);

export async function loadJoinedGroups(slotId?: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(slotId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveJoinedGroups(ids: string[], slotId?: string): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(slotId), JSON.stringify([...new Set(ids)]));
  } catch {
    // best effort
  }
}
