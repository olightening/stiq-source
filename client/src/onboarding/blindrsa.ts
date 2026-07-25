/**
 * Blind-RSA client (RFC 9474, PLAN.md §3.3). This is the member's half of the blind
 * signature: blind a token before showing it to the organizer, then unblind the result.
 *
 * Production wires `@cloudflare/blindrsa-ts` (RFC 9474, SHA384 PSS Deterministic — matching
 * the relay's circl verifier) behind this interface. That lib uses WebCrypto, which on RN
 * needs a SubtleCrypto polyfill; it is therefore a native/integration seam, validated
 * on-device against the Go relay (whose verification is already real-tested). Tests here
 * inject MockBlindRsa to exercise the enrollment orchestration and payload formats.
 */
export interface BlindResult {
  /** The prepared message that the issuer's signature will cover (verified by the relay). */
  prepared: Uint8Array;
  /** The blinded message shown to the issuer (it learns nothing about the token). */
  blinded: Uint8Array;
  /** Opaque state needed to finalize. May embed a non-serializable handle (e.g. an imported
   *  WebCrypto CryptoKey) — see {@link BlindRsaClient.rebuildState} for surviving a process restart. */
  state: unknown;
  /**
   * The SERIALIZABLE secret half of `state` (the blind-RSA inverse/blinding factor — RFC 9474's
   * `inv`): plain bytes, safe to persist. F10 (durable draw staging): `state` itself cannot always be
   * persisted verbatim (the real implementation's state embeds a live CryptoKey), so a durable
   * "draw-in-flight" marker stores THIS field per token instead, and {@link BlindRsaClient.rebuildState}
   * reconstructs an equivalent `state` from it after a restart. Without this exact value, a resumed
   * draw can receive the organizer's blind signature back but can never unblind it into a valid token
   * — the batch would be paid-for and permanently stuck. Distinct from `secret` (the token's own
   * BIP-340 holder-bound key `q`, kept alongside in `BlindItem`) — this is the UNBLINDING secret, not
   * the token's OWNERSHIP secret; a marker needs both.
   */
  blindingSecret: Uint8Array;
}

export interface BlindRsaClient {
  blind(issuerPublicKey: string, token: Uint8Array): Promise<BlindResult>;
  /** Unblind the issuer's blind signature into a normal signature over `prepared`. */
  finalize(state: unknown, blindSignature: Uint8Array): Promise<Uint8Array>;
  /**
   * Rebuild an opaque `state` (suitable for {@link finalize}) from its serializable parts, for
   * resuming a draw after a process restart (F10) — a durable marker persists `prepared` +
   * `blindingSecret` (never the full opaque `state`, which may not survive serialization) and calls
   * this to reconstitute it. `issuerPublicKey` re-derives any public, non-secret handle (e.g.
   * re-importing the issuer's public key); nothing here is a NEW secret — `blindingSecret` is the same
   * value {@link blind} returned, just round-tripped through storage.
   *
   * Optional: only draw-resume (drawExchange.ts's resumeTokenDraw) calls this, so the enrollment/
   * credential-exchange call sites that construct their own minimal `BlindRsaClient` test doubles
   * (never exercising resume) don't need to implement it. `RealBlindRsa` and `MockBlindRsa` — the two
   * implementations an actual draw ever uses — both provide it.
   */
  rebuildState?(issuerPublicKey: string, prepared: Uint8Array, blindingSecret: Uint8Array): Promise<unknown>;
}

/**
 * Deterministic test double. NOT cryptographic — it only lets the enrollment flow and
 * payload formats be tested without WebCrypto. Never use in production.
 */
export class MockBlindRsa implements BlindRsaClient {
  async blind(_issuerPublicKey: string, token: Uint8Array): Promise<BlindResult> {
    // Deterministic "blinding": prepared = token (deterministic variant); blinded marks it.
    const blinded = new Uint8Array(token.length + 1);
    blinded.set(token, 0);
    blinded[token.length] = 0xbb; // marker so a test can assert it differs from the token
    // Mock has no real blinding factor; finalize() below ignores state entirely, so any stable,
    // serializable stand-in works. Copying `token` keeps rebuildState()'s output byte-identical to
    // blind()'s own `state` shape without inventing a second meaning for the same bytes.
    return {prepared: token, blinded, state: {token}, blindingSecret: token.slice()};
  }

  async finalize(_state: unknown, blindSignature: Uint8Array): Promise<Uint8Array> {
    return blindSignature; // pass-through stand-in for the unblinded signature
  }

  async rebuildState(_issuerPublicKey: string, prepared: Uint8Array, _blindingSecret: Uint8Array): Promise<unknown> {
    return {token: prepared}; // finalize() ignores state, so any shape mirroring blind()'s is fine
  }
}
