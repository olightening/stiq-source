/**
 * Event-signature verifier factory: native BIP-340 schnorr (StiqSchnorr, libsecp256k1 via
 * secp256k1-kmp) when available and enabled, with the pure-JS nostr-tools `verifyEvent` as the
 * automatic and authoritative fallback.
 *
 * WHY: `verifyEvent` (pure-JS schnorr on Hermes) costs several ms per event — the per-tick cost
 * floor of RelayClient's paced inbound drain during a relay burst (see RelayClient's ingest doc).
 * Offloading just the curve math to native (same precedent as StiqPow's SHA-256 miner and StiqKdf's
 * PBKDF2) cuts it to well under a millisecond without touching the ingest pipeline's shape: the
 * verifier stays a synchronous `(event) => boolean`, exactly what RelayClient's `verify` option
 * expects, via a blocking synchronous native method.
 *
 * PARITY CONTRACT (provably identical accept/reject behaviour to `verifyEvent`, covered by
 * nativeVerify.test.ts):
 *   1. `validateEvent(event)` — the same structural check verifyEvent runs first; fails → false.
 *   2. `getEventHash(event) === event.id` — id integrity, computed in JS (sha256 of ~0.5 KB is
 *      cheap; ONLY the curve verify is offloaded); mismatch → false.
 *   3. native `verify(pubkey, id, sig)` — the BIP-340 check itself. The Kotlin side returns false
 *      on ANY exception (bad hex, wrong lengths), matching verifyEvent's own catch-all false.
 * ANY JS-side throw (unexpected shape, a broken bridge) re-runs the full pure-JS `verifyEvent` and
 * returns its answer, so the fallback — not the native path — is always the authority on errors.
 *
 * SECURITY: an event acquires trust ONLY by passing this verifier before RelayClient stores it, so
 * the native path must never be weaker than the JS path. It is strictly the same three checks with
 * the curve math swapped out; when in ANY doubt (throw), the pure-JS path decides.
 */
import {NativeModules} from 'react-native';
import {validateEvent, verifyEvent, getEventHash, type Event} from 'nostr-tools/pure';
import {NATIVE_SCHNORR_VERIFY} from '../config';

/**
 * The native module's surface: a BLOCKING synchronous BIP-340 verify over hex inputs
 * (`isBlockingSynchronousMethod = true` on the Kotlin side — required because RelayClient's
 * `verify` option is synchronous). Returns false (never throws across the bridge) on any
 * malformed input.
 */
export interface SchnorrNativeModule {
  verify(pubkeyHex: string, msgHashHex: string, sigHex: string): boolean;
}

/**
 * Build the ingest verifier. Returns the pure-JS `verifyEvent` unchanged (the exact function
 * RelayClient defaults to — flag-off is byte-identical) unless NATIVE_SCHNORR_VERIFY is on AND the
 * native module is present.
 *
 * `nativeOverride` / `enabledOverride` exist ONLY for tests (inject a fake native module without
 * mocking react-native); production callers pass nothing.
 */
export function createEventVerifier(
  nativeOverride?: SchnorrNativeModule | null,
  enabledOverride?: boolean,
): (event: Event) => boolean {
  const enabled = enabledOverride ?? NATIVE_SCHNORR_VERIFY;
  const native =
    nativeOverride !== undefined
      ? nativeOverride
      : (NativeModules as {StiqSchnorr?: SchnorrNativeModule}).StiqSchnorr;
  if (!enabled || !native || typeof native.verify !== 'function') {
    return verifyEvent; // flag off / module absent → the exact default RelayClient already uses
  }
  return (event: Event): boolean => {
    try {
      // Same order as nostr-tools verifyEvent: structure, then id integrity, then the signature.
      if (!validateEvent(event)) return false;
      const id = getEventHash(event);
      if (id !== event.id) return false;
      return native.verify(event.pubkey, id, event.sig) === true;
    } catch {
      // Any surprise (throwing bridge, un-hashable shape) → the pure-JS path is the authority.
      try {
        return verifyEvent(event);
      } catch {
        return false;
      }
    }
  };
}
