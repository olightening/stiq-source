/**
 * onionAuthArti — the Arti-specific restricted-discovery client-auth mapper (T17).
 *
 * WHY THIS EXISTS SEPARATELY FROM onionAuth.ts:
 * The now-removed C-tor backend read Tor's `<host>:descriptor:x25519:<b32>` ClientOnionAuthDir
 * file line (built directly in Kotlin, not via TS). Arti does NOT read that file format at all —
 * it wants the raw x25519 SECRET installed into its KeyMgr / onion-service-client authorization
 * store, keyed by the .onion address (see client/arti-ffi/src/onion_auth.rs). So the Arti path
 * needs a DIFFERENT shape from the same 52-char base32 key STIQ already ships.
 *
 * This pure mapper normalizes a credential for the StiqArti startTor config; StiqArtiModule passes
 * the raw base32 through and lets Rust decode it, so this mapper is VALIDATION-ONLY: it reuses the
 * exact same validators onionAuth.ts always has (isValidAuthKeyBase32 + onionHostOf) and returns
 * null for anything malformed, so a bad credential never reaches the daemon.
 *
 * Pure: no native, no fs, no crypto.
 */
import {isValidAuthKeyBase32, onionHostOf} from './onionAuth';

/**
 * One restricted-discovery credential, in the shape the Arti FFI actually reads.
 *
 * The field is `privKeyBase32` because that is what `OnionAuthJson` in
 * `client/arti-ffi/src/ffi.rs` deserializes and what `StiqArtiModule.authToJson` writes. It was
 * previously declared here as `secretKeyBase32`, on the theory that Arti's KeyMgr wording differed
 * from C-tor's descriptor-file wording. It does not, and the mismatch would have been silent in
 * both directions: nothing in production called this mapper, and anything that started to would have
 * produced JSON whose key Rust does not recognize — surfacing much later as a members-only community
 * that simply cannot be reached.
 */
export interface ArtiClientAuthEntry {
  /** Bare v3 onion host (56 base32 chars, no `.onion`) — the keystore lookup key. */
  onionHost: string;
  /** Community shared x25519 client-auth SECRET, unpadded uppercase base32 (52 chars). */
  privKeyBase32: string;
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
  return {onionHost: host, privKeyBase32};
}
