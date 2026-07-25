/**
 * Secure key storage (PLAN.md §3.3 / Step 7).
 *
 * The secret key is held by a SecureKeyStore and never leaves it: callers can sign and
 * read the public key, but there is intentionally NO method to retrieve the private key.
 *
 * Real-world nuance: secp256k1 schnorr (Nostr's signature) is not a hardware primitive —
 * iOS Secure Enclave / Android Keystore cannot perform it. So the key is hardware-WRAPPED
 * at rest (encrypted by a Keystore/Secure-Enclave key, biometric-gated) via SecureStorage,
 * and decrypted into memory only for the moment of signing, then scrubbed. See README.
 */
import {finalizeEvent, getPublicKey, type Event} from 'nostr-tools/pure';
import {bytesToHex, hexToBytes} from '../util/hex';

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Hardware-backed key/value storage. The native implementation encrypts values with a
 * non-exportable Keystore/Secure-Enclave key. Values never reach SQLite or logs.
 */
export interface SecureStorage {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

export interface SecureKeyStore {
  enroll(secretKey: Uint8Array): Promise<void>;
  isEnrolled(): Promise<boolean>;
  publicKey(): Promise<string>;
  sign(unsigned: UnsignedEvent): Promise<Event>;
  reset(): Promise<void>;
  /**
   * Run a function with transient access to the secret key (scrubbed afterwards). Used for
   * NIP-44/NIP-17 DM encryption/decryption, which — like signing — needs the key in memory
   * for the operation. There is still no PERSISTENT export: the key never leaves the secure
   * store except transiently in RAM, exactly as for sign().
   */
  useSecretKey<T>(fn: (secretKey: Uint8Array) => T | Promise<T>): Promise<T>;
}

const SK_ITEM = 'stiq.identity.sk';

/** Per-slot secret-key storage key for the multi-identity key ring (see keyRing.ts). */
export function namespacedSkItem(namespace: string): string {
  return `stiq_privkey_${namespace}`;
}

export class KeyStore implements SecureKeyStore {
  /** Storage key under which the secret key lives — namespaced when a slot id is given. */
  private readonly skItem: string;

  /**
   * @param storage   hardware-backed secure storage.
   * @param namespace optional key-ring slot id. When set, the secret key is stored under
   *                  `stiq_privkey_<namespace>` instead of the legacy single-identity
   *                  `stiq.identity.sk`, so several identities can coexist. Omitting it keeps the
   *                  original single-identity behaviour (backward compatible).
   */
  constructor(private readonly storage: SecureStorage, namespace?: string) {
    this.skItem = namespace ? namespacedSkItem(namespace) : SK_ITEM;
  }

  async enroll(secretKey: Uint8Array): Promise<void> {
    await this.storage.setItem(this.skItem, bytesToHex(secretKey));
  }

  async isEnrolled(): Promise<boolean> {
    return (await this.storage.getItem(this.skItem)) !== null;
  }

  async publicKey(): Promise<string> {
    const sk = await this.read();
    try {
      return getPublicKey(sk);
    } finally {
      sk.fill(0);
    }
  }

  async sign(unsigned: UnsignedEvent): Promise<Event> {
    const sk = await this.read();
    try {
      return finalizeEvent(unsigned, sk);
    } finally {
      sk.fill(0); // scrub the in-memory copy immediately after signing
    }
  }

  async reset(): Promise<void> {
    await this.storage.removeItem(this.skItem);
  }

  async useSecretKey<T>(fn: (secretKey: Uint8Array) => T | Promise<T>): Promise<T> {
    const sk = await this.read();
    try {
      return await fn(sk);
    } finally {
      sk.fill(0);
    }
  }

  private async read(): Promise<Uint8Array> {
    const hex = await this.storage.getItem(this.skItem);
    if (!hex) {
      throw new Error('no key enrolled');
    }
    return hexToBytes(hex);
  }
}

/**
 * In-memory secure storage — TEST/DEV ONLY. Not hardware-backed; never ship this as the
 * production store (see nativeKeystore.createSecureStorage, which fails closed instead).
 */
export class InMemorySecureStorage implements SecureStorage {
  private readonly map = new Map<string, string>();

  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}
