/**
 * Re-exports RealBlindRsa from blindrsaReal.ts.
 * The original node-forge implementation has been replaced by the @cloudflare/blindrsa-ts
 * implementation which uses the same RFC 9474 SHA384PSSDeterministic algorithm and is
 * verified against the relay's Go cloudflare/circl verifier.
 */
export {RealBlindRsa} from './blindrsaReal';
