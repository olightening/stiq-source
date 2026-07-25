/**
 * blindTokenSource — wires a real {@link MintToken} from the client blind-RSA and an issuer
 * signing callback. Kept separate from the wallet so the wallet stays pure/testable and the
 * RSA + network wiring lives in one place.
 *
 * The mint runs the RFC 9474 blind flow (identical to enrollment): pick a random token, blind
 * it under the issuer public key, hand the blinded bytes to the issuer to sign (it never sees
 * the token), then unblind into a spendable credential.
 */
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {TOKEN_BYTES} from '../contracts';
import {newTokenKeypair} from './holderProof';
import type {BlindRsaClient} from '../onboarding/blindrsa';
import type {MintToken, Token} from './wallet';

// Random token width — owned by the contract module and shared with enrollment + the relay verifier,
// so a single-source change keeps the mint, the credential, and the verifier byte-compatible.
// Re-exported for existing importers (e.g. drawExchange) that reference it via this module.
export {TOKEN_BYTES};

/** Blind-signs a base64 blinded message and returns the base64 blind signature (the issuer). */
export type BlindSign = (blindedB64: string) => Promise<string>;

/**
 * Build a {@link MintToken} that draws one blind token per call.
 *
 * @param blindRsa the client blind-RSA (blind/finalize)
 * @param issuerPublicKeyB64 the community's published issuer public key (base64 SPKI)
 * @param blindSign hands the blinded bytes to the organizer's issuer and returns its signature
 */
export function makeMint(
  blindRsa: BlindRsaClient,
  issuerPublicKeyB64: string,
  blindSign: BlindSign,
): MintToken {
  return async (): Promise<Token> => {
    // P3 holder-bound: the 32-byte "token" IS a BIP-340 x-only pubkey Q; keep the secret q.
    // Q is drawn/blinded exactly where the old random token bytes were (same TOKEN_BYTES width),
    // so blind-issuance is byte-identical and the organizer still never sees Q.
    const {q, Q} = newTokenKeypair();
    const {prepared, blinded, state} = await blindRsa.blind(issuerPublicKeyB64, Q);
    const blindSigB64 = await blindSign(bytesToBase64(blinded));
    const sig = await blindRsa.finalize(state, base64ToBytes(blindSigB64));
    // Deterministic RFC 9474 variant: `prepared` === Q === the token the relay verifies against.
    return {token: prepared, sig, secret: q};
  };
}
