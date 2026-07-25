/**
 * onionAuthArti — the Arti-specific restricted-discovery client-auth mapper (T17-S4, spike).
 *
 * WHY THIS EXISTS SEPARATELY FROM onionAuth.ts:
 * The C-tor backend consumes onionAuth.ts:authPrivateFileContent(), which emits Tor's
 * `<host>:descriptor:x25519:<b32>` ClientOnionAuthDir file line. Arti does NOT read that file
 * format at all — it wants the raw x25519 SECRET installed into its KeyMgr / onion-service-client
 * authorization store, keyed by the .onion address (see client/arti-ffi/src/onion_auth.rs). So the
 * Arti path needs a DIFFERENT shape from the same 52-char base32 key STIQ already ships.
 *
 * onionAuth.ts is left UNTOUCHED so the default (shipping) C-tor backend keeps working byte-for-byte;
 * this pure mapper lives beside it and is only used when marshaling the StiqArti startTor config.
 * For the spike, StiqArtiModule passes the raw privKeyBase32 through and lets Rust decode it, so
 * this mapper is VALIDATION-ONLY: it reuses the exact same validators as the C-tor path
 * (isValidAuthKeyBase32 + onionHostOf) and returns the {onionHost, secretKeyBase32} shape the Arti
 * FFI expects, or null for anything malformed (so a bad credential never reaches the daemon).
 *
 * Pure: no native, no fs, no crypto.
 */
import {isValidAuthKeyBase32, onionHostOf} from './onionAuth';

/**
 * The shape the Arti FFI expects for one restricted-discovery credential. Note `secretKeyBase32`
 * (not `privKeyBase32`): Arti installs the raw x25519 SECRET into its KeyMgr, whereas the C-tor
 * field name mirrors the descriptor-file wording. Same 52-char base32 value, different consumer.
 */
export interface ArtiClientAuthEntry {
  /** Bare v3 onion host (56 base32 chars, no `.onion`) — the KeyMgr lookup key. */
  onionHost: string;
  /** Community shared x25519 client-auth SECRET, unpadded uppercase base32 (52 chars). */
  secretKeyBase32: string;
}

/**
 * Map an onion host (or full relay URL) + a base32 x25519 secret into the Arti client-auth entry.
 *
 * Accepts EITHER a bare 56-char v3 host OR a relay URL (`ws://<56b32>.onion[/…][:port]`) for
 * `onionHost` — it normalizes via onionHostOf, so callers can pass whatever they hold. Returns null
 * when the host is not a v3 onion or the key is not a well-formed 52-char uppercase base32 secret
 * (via isValidAuthKeyBase32) — the SAME validity gate the C-tor path uses, so the two backends
 * accept/reject exactly the same credentials.
 */
export function artiClientAuthEntry(
  onionHost: string,
  privKeyBase32: string,
): ArtiClientAuthEntry | null {
  if (!isValidAuthKeyBase32(privKeyBase32)) return null;
  // Accept a bare 56-char host as-is; otherwise treat the input as a URL and extract the host.
  const host = /^[a-z2-7]{56}$/.test(onionHost) ? onionHost : onionHostOf(onionHost);
  if (!host) return null;
  return {onionHost: host, secretKeyBase32: privKeyBase32};
}
