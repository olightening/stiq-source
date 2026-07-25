/**
 * KeyRing — the multi-identity store (multi-identity key ring).
 *
 * STIQ binds exactly one on-device npub per community membership, so being enrolled in several
 * communities at once means holding several distinct secret keys. The key ring is the index over
 * those keys: a list of {@link KeySlot}s (one per enrolled identity) plus a pointer to the active
 * one. Each slot owns a UUID that namespaces its secret key in secure storage
 * (`stiq_privkey_<slot.id>`, see {@link namespacedSkItem}); the slot metadata itself carries NO
 * secret material, only what the switcher UI needs to display.
 *
 * Storage layout (all via the SecureStorage abstraction — never AsyncStorage directly):
 *   - `stiq_keyslots`        → JSON array of KeySlot (metadata only)
 *   - `stiq_active_slot`     → the active slot's id (string)
 *   - `stiq_privkey_<id>`    → that slot's 32-byte secret key (written by KeyStore(storage, id))
 *
 * The legacy single-identity key (`stiq.identity.sk`) is untouched — a fresh-install user with one
 * identity keeps working with no slots at all; the ring is additive.
 */
import {randomBytes} from '../util/random';
import {bytesToHex} from '../util/hex';
import {KeyStore, type SecureStorage} from './keystore';
import {credTokenKey, credSigKey, identityRelayKey} from '../app/workspaceKeys';

export interface KeySlot {
  /** UUID, used as the namespace for this identity's SecureStorage keys. */
  id: string;
  communityName: string;
  relayUrl: string;
  /** Unix timestamp (seconds) when this identity was enrolled. */
  enrolledAt: number;
  /** Encoded npub, for display in the switcher (gradient seed + label). */
  npub: string;
}

const SLOTS_KEY = 'stiq_keyslots';
const ACTIVE_KEY = 'stiq_active_slot';

/**
 * RFC 4122 v4 UUID from CSPRNG bytes. We don't rely on `crypto.randomUUID`, which isn't guaranteed
 * on React Native even with the get-random-values polyfill in place; `randomBytes` is.
 */
export function newSlotId(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = bytesToHex(b);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

export class KeyRing {
  constructor(private readonly storage: SecureStorage) {}

  /** All identity slots (metadata only — never includes the private key). */
  async listSlots(): Promise<KeySlot[]> {
    const raw = await this.storage.getItem(SLOTS_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as KeySlot[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** The active slot's id, or null when no slot has been selected. */
  async getActiveSlotId(): Promise<string | null> {
    return this.storage.getItem(ACTIVE_KEY);
  }

  /**
   * Register a slot whose private key has already been written under `slot.id`
   * (via `new KeyStore(storage, slot.id).enroll(sk)`), and make it active. Adding the same id again
   * updates the existing entry rather than duplicating it.
   */
  async addSlot(slot: KeySlot): Promise<void> {
    const slots = await this.listSlots();
    const idx = slots.findIndex(s => s.id === slot.id);
    if (idx === -1) {
      slots.push(slot);
    } else {
      slots[idx] = slot;
    }
    await this.storage.setItem(SLOTS_KEY, JSON.stringify(slots));
    await this.setActiveSlot(slot.id);
  }

  /** Mark a slot active. (No-op guarding the caller: just persists the id.) */
  async setActiveSlot(id: string): Promise<void> {
    await this.storage.setItem(ACTIVE_KEY, id);
  }

  /**
   * Forget a slot AND wipe its identity secrets — private key (`stiq_privkey_<id>`), membership
   * credential (`stiq_cred_token_<id>` / `stiq_cred_sig_<id>`), and bound relay. If the removed slot
   * was active, the active pointer falls back to the first remaining slot, or is cleared when none
   * remain. (Per-community CONTENT — the event DB, outbox, groups, phonebooks — is wiped separately
   * by AppRuntime.removeCommunity, which knows the community id.)
   */
  async removeSlot(id: string): Promise<void> {
    const slots = (await this.listSlots()).filter(s => s.id !== id);
    await this.storage.setItem(SLOTS_KEY, JSON.stringify(slots));
    // Wipe the secret key + credential + relay held under this slot's namespace.
    await new KeyStore(this.storage, id).reset();
    await this.storage.removeItem(credTokenKey(id));
    await this.storage.removeItem(credSigKey(id));
    await this.storage.removeItem(identityRelayKey(id));
    if ((await this.getActiveSlotId()) === id) {
      const next = slots[0]?.id;
      if (next) {
        await this.setActiveSlot(next);
      } else {
        await this.storage.removeItem(ACTIVE_KEY);
      }
    }
  }

  /** Wipe the whole ring (slots + active pointer). Part of the duress/logout reset. */
  async clear(): Promise<void> {
    await this.storage.removeItem(SLOTS_KEY);
    await this.storage.removeItem(ACTIVE_KEY);
  }
}
