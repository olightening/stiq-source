/**
 * Native PIN KDF bridge (scheme `pbk1`).
 *
 * The PIN's key-derivation runs in native code (StiqKdfModule → PBKDF2-HMAC-SHA256 via
 * SecretKeyFactory/Conscrypt, hardware-accelerated). This exists because the previous pure-JS scrypt
 * KDF measured ~11 SECONDS per unlock on a Galaxy S23 Ultra in Hermes (cost is linear in the work
 * factor, so no JS-cheap parameter is both secure and instant). Native PBKDF2 at a high iteration
 * count runs in tens of milliseconds while keeping a salted, iterated, standards-based KDF.
 *
 * {@link nativePinHash} is shaped as a {@link PinVault} HashFn so the vault's seal/verify seam is
 * unchanged: PinVault always calls it with `salt(16) ‖ utf8(pin)`, so we split the fixed-width salt
 * prefix back out and run standard PBKDF2 with (password = PIN, salt = per-PIN salt). The PIN is
 * always ASCII digits (numeric keypad), so the native char→byte encoding equals the JS UTF-8 bytes,
 * keeping the pure-JS fallback byte-identical.
 */
import {NativeModules} from 'react-native';
import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, hexToBytes} from '../util/hex';

/** PBKDF2 params baked into the `pbk1` scheme tag. Raising them later = a new tag + migration,
 *  exactly like the scrypt1→pbk1 upgrade in pin.ts. Native (Conscrypt) runs 100k in tens of ms. */
export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_DKLEN = 32;

/** Salt width PinVault prepends before the PIN in the HashFn input — MUST match pin.ts SALT_BYTES. */
const SALT_BYTES = 16;

interface StiqKdfNative {
  pbkdf2(pin: string, saltHex: string, iterations: number, dkLenBytes: number): Promise<string>;
}
const native = (NativeModules as {StiqKdf?: StiqKdfNative}).StiqKdf ?? null;

/** True in a correctly-built app: the native module is always registered (MainApplication). */
export const hasNativeKdf = native !== null;

/** Decode the ASCII-digit PIN bytes back to the string the native PBEKeySpec char[] needs. */
function asciiToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Current PIN KDF. Called as a HashFn with `salt(16) ‖ utf8(pin)`; splits the salt prefix and runs
 * PBKDF2-HMAC-SHA256. Native when available; a byte-identical pure-JS fallback (slow on Hermes, never
 * reached in a shipped build) keeps a mis-built app working instead of locking the user out.
 */
export const nativePinHash = async (data: Uint8Array): Promise<Uint8Array> => {
  const salt = data.slice(0, SALT_BYTES);
  const pinBytes = data.slice(SALT_BYTES);
  if (native) {
    const hex = await native.pbkdf2(asciiToString(pinBytes), bytesToHex(salt), PBKDF2_ITERATIONS, PBKDF2_DKLEN);
    return hexToBytes(hex);
  }
  return pbkdf2Async(sha256, pinBytes, salt, {c: PBKDF2_ITERATIONS, dkLen: PBKDF2_DKLEN});
};
