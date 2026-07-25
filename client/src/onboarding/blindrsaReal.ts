/// <reference lib="dom" />
/**
 * Real blind-RSA client (RFC 9474) using @cloudflare/blindrsa-ts.
 *
 * Replaces MockBlindRsa in production. Requires global.crypto.subtle — provided on Hermes by the
 * pure-JS shim installed in polyfills.js (onboarding/webcryptoShim.ts), and natively under Jest.
 *
 * Algorithm: RSABSSA-SHA384-PSS-Deterministic (matches the Go relay verifier
 * which uses cloudflare/circl with the same suite).
 *
 * The private key stays on the organizer's machine (issuer/issuer.js). This
 * file only ever touches the issuer's PUBLIC key.
 */
import {RSABSSA} from '@cloudflare/blindrsa-ts';
import {base64ToBytes} from '../util/base64';
import type {BlindRsaClient, BlindResult} from './blindrsa';

interface BlindState {
  inv: Uint8Array;
  publicKey: CryptoKey;
  preparedMsg: Uint8Array;
}

export class RealBlindRsa implements BlindRsaClient {
  private readonly suite = RSABSSA.SHA384.PSS.Deterministic();

  // A draw session blinds a whole batch (DRAW_BATCH=100 posting / READ_DRAW_BATCH=25 reading) under
  // the SAME issuer key back-to-back, but importKey() only ever depends on the DER bytes — re-running
  // it per token was pure redundant parsing (and, on the JS thread, real per-token wall-clock; P1-2 /
  // finding B2). Cache the imported CryptoKey per issuer key string so it's parsed once and reused for
  // every token in the batch (and across future batches/draws under the same key). Keyed on the base64
  // DER itself, so distinct issuer keys (K_post/K_read/K_enroll, or different communities) never
  // collide. The blinding math (fresh random `r` per token) is untouched — only the key import is
  // shared, so output is byte-identical to importing fresh every time.
  private readonly importedKeys = new Map<string, Promise<CryptoKey>>();

  private importIssuerKey(issuerPublicKeyB64: string): Promise<CryptoKey> {
    let cached = this.importedKeys.get(issuerPublicKeyB64);
    if (!cached) {
      const keyDer = base64ToBytes(issuerPublicKeyB64);
      // Key must be extractable=true — the library exports it to JWK internally
      // to access the raw modulus for the blinding math.
      cached = crypto.subtle.importKey(
        'spki',
        // WebCrypto accepts a Uint8Array at runtime; cast satisfies the lib's ArrayBuffer generic.
        keyDer as unknown as ArrayBuffer,
        {name: 'RSA-PSS', hash: 'SHA-384'},
        true,
        ['verify'],
      );
      this.importedKeys.set(issuerPublicKeyB64, cached);
      // Don't let a failed import poison the cache — a malformed-once key shouldn't wedge every
      // later call under the same string.
      cached.catch(() => this.importedKeys.delete(issuerPublicKeyB64));
    }
    return cached;
  }

  async blind(issuerPublicKeyB64: string, token: Uint8Array): Promise<BlindResult> {
    const publicKey = await this.importIssuerKey(issuerPublicKeyB64);

    // In Deterministic mode, prepare() is a no-op (prefix length = 0),
    // so preparedMsg === token. We call it anyway to stay spec-compliant.
    const preparedMsg = this.suite.prepare(token);

    const {blindedMsg, inv} = await this.suite.blind(publicKey, preparedMsg);

    const state: BlindState = {inv, publicKey, preparedMsg};
    // `inv` is the ONLY part of `state` that isn't reconstructible from public information: `publicKey`
    // is just the imported issuer key (re-derivable from `issuerPublicKeyB64` — see rebuildState) and
    // `preparedMsg` equals `prepared` below (byte-identical in Deterministic mode). F10 durable draw
    // staging persists `inv` (as `blindingSecret`) so a killed process can still unblind this token's
    // signature after a restart, without which the organizer's already-paid-for reply is unusable.
    return {prepared: preparedMsg, blinded: blindedMsg, state, blindingSecret: inv};
  }

  async finalize(state: unknown, blindSignature: Uint8Array): Promise<Uint8Array> {
    const {inv, publicKey, preparedMsg} = state as BlindState;
    return this.suite.finalize(publicKey, preparedMsg, blindSignature, inv);
  }

  /** Re-import the (public, non-secret) issuer key and pair it back up with the persisted `inv` +
   *  `prepared` bytes — reconstructs exactly the `BlindState` `blind()` built, so `finalize()` behaves
   *  identically whether `state` came from this session or a resumed one (F10). */
  async rebuildState(issuerPublicKeyB64: string, prepared: Uint8Array, blindingSecret: Uint8Array): Promise<unknown> {
    const publicKey = await this.importIssuerKey(issuerPublicKeyB64);
    const state: BlindState = {inv: blindingSecret, publicKey, preparedMsg: prepared};
    return state;
  }
}
