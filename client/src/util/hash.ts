/**
 * SHA-256 over raw bytes, returning lowercase hex.
 *
 * Used to verify that media fetched over Tor matches the `x` hash the poster signed into the
 * NIP-94 `imeta` tag (Tier 2 hash-pin) — a swapped or tampered payload is rejected before it
 * ever reaches an image decoder.
 */
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
