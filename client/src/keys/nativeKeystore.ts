/**
 * Native hardware-backed secure storage (PLAN.md §3.3 / Step 7).
 *
 * The `StiqKeystore` native module stores values encrypted by a non-exportable, hardware-bound key:
 *   iOS:     Keychain generic-password item, protected at rest by the Secure-Enclave-backed class
 *            key, kSecAttrAccessibleWhenUnlockedThisDeviceOnly (device-only, no iCloud sync, readable
 *            only while the device is unlocked). See ios/stiq/StiqKeystore.swift.
 *   Android: value encrypted with an Android Keystore AES-256-GCM key, StrongBox-backed (dedicated
 *            secure element) when available, falling back to the TEE otherwise. See
 *            android/.../StiqKeystoreModule.kt.
 *
 * SCOPE OF PROTECTION (audit #7 follow-up): the key is bound to the HARDWARE, NOT to user
 * authentication — there is no biometric/user-auth gate on this key. Android deliberately omits
 * setUserAuthenticationRequired/setUnlockedDeviceRequired and iOS omits a biometry access-control
 * ACL, so the headless background-sync task (src/background/syncTask.ts) can decrypt the cache and
 * identity secrets while the screen is locked. The user-facing gate is therefore the app-level
 * PIN/biometric lock + duress wipe (src/lock, src/vault), not a prompt bound to this key. Splitting
 * out an auth-bound signing key is tracked as a follow-up in the native modules' own docstrings.
 *
 * Because secp256k1 schnorr is not a hardware primitive, the signing key is stored hardware-WRAPPED
 * at rest and decrypted into memory only to sign (KeyStore.sign scrubs it afterwards). The module
 * exposes no export path.
 */
import {NativeModules} from 'react-native';
import type {SecureStorage} from './keystore';

interface StiqKeystoreNative {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  /**
   * Optional batched read — decrypts every key in ONE task on the native single-thread executor
   * (one bridge round-trip). Optional because a device may be running a native binary built before
   * this method existed; callers must feature-detect (see multiGet below).
   */
  multiGet?(keys: string[]): Promise<Record<string, string | null>>;
}

export function getNativeKeystore(): StiqKeystoreNative | undefined {
  return (NativeModules as {StiqKeystore?: StiqKeystoreNative}).StiqKeystore;
}

/**
 * Batched secure-storage read. App init issues ~25-30 reads; each plain getItem is one serialized
 * async bridge round-trip through the native single-thread executor, so doing them one-by-one
 * dominates cold start. multiGet collapses them into a single native task.
 *
 * FEATURE DETECTION: if the native module lacks multiGet (stale native binary that predates it, or
 * a jest mock), transparently fall back to Promise.all of individual getItem calls. Both paths
 * return the SAME shape: a record of key -> decrypted-value, with null for any absent/unreadable
 * key (mirroring getItem, which resolves null rather than throwing when a key is missing).
 */
export async function multiGet(
  keys: string[],
  storage?: Pick<StiqKeystoreNative, 'getItem' | 'multiGet'>,
): Promise<Record<string, string | null>> {
  // Default to the native keystore, but accept an explicit storage instance so a caller that already
  // holds one (e.g. AppRuntime's injected secureStorage — the SAME native keystore on device, an
  // in-memory mock under test) gets the identical batch-with-per-item-fallback against THAT instance
  // instead of this module re-resolving NativeModules (which a test harness may not have installed).
  const native = storage ?? getNativeKeystore();
  if (!native) {
    throw new Error('hardware-backed secure storage unavailable (StiqKeystore not installed)');
  }
  if (typeof native.multiGet === 'function') {
    return native.multiGet(keys);
  }
  // Fallback: same getItem, one bridge hop per key, assembled into the identical shape.
  const out: Record<string, string | null> = {};
  await Promise.all(
    keys.map(async (key) => {
      out[key] = await native.getItem(key);
    }),
  );
  return out;
}

/**
 * Returns the hardware-backed secure storage, or throws. Fail closed: never silently fall
 * back to insecure storage for the private key.
 */
export function createSecureStorage(): SecureStorage {
  const native = getNativeKeystore();
  if (!native) {
    throw new Error('hardware-backed secure storage unavailable (StiqKeystore not installed)');
  }
  return native;
}
