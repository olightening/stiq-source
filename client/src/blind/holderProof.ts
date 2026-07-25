/**
 * holderProof — P3 holder-bound tokens: the 32 random token bytes ARE a BIP-340 x-only secp256k1
 * pubkey `Q`, and the client keeps the matching secret `q`. Organizer blind-issuance / relay
 * RSA-verify stay byte-identical (they still blind-sign 32 opaque bytes; the fact those bytes
 * happen to be a valid x-only pubkey is invisible to that math).
 *
 * A blind post spending N tokens signs the whole event with token 0's secret (`q0`), so
 * `event.pubkey == Q0` and token 0's holder proof IS the event's own BIP-340 signature — already
 * verified by the relay's signature-hook, no extra tag needed. Tokens 1..N-1 each carry one
 * `stiq_spend` tag: a 64-byte BIP-340 signature by that token's own `q_i` over a digest bound to
 * `event.pubkey` (see {@link spendMessage}), proving the poster also holds THAT token's secret.
 *
 * Bound to `event.pubkey`, never `event.id`: `event.pubkey` (== Q0) is fixed before any
 * `stiq_spend` tag exists, so there is no tag-in-preimage circularity. `SPEND_DOMAIN` /
 * `spendMessage` MUST stay byte-identical to the relay's `spendDomain` const + digest
 * (policy/membership.go) — interop between @noble's BIP-340 and decred's is over the identical
 * 32-byte digest, not the raw preimage.
 *
 * ZERO new deps: `schnorr` from `@noble/curves/secp256k1.js` (already a nostr-tools transitive
 * dep), `sha256` from `@noble/hashes/sha2.js`, `hexToBytes`/`utf8ToBytes` from
 * `@noble/hashes/utils.js` (the v2 subpaths — see BUILDING.md's "@noble/hashes trap").
 */
import {schnorr} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js';
import {generateSecretKey} from 'nostr-tools/pure';
import {SPEND_DOMAIN} from './protocol';

/** A token's keypair: `q` is the client-held secret (never leaves the device), `Q` is the 32-byte
 *  x-only pubkey the organizer blind-signs (the wire "token"). */
export interface TokenKeypair {
  q: Uint8Array;
  Q: Uint8Array;
}

/**
 * Mint a fresh token keypair. `q` is drawn via nostr-tools' `generateSecretKey()` — a CSPRNG draw
 * already guaranteed to land in-range for secp256k1 (the same generator used for identity/
 * throwaway keys) — and `Q = schnorr.getPublicKey(q)` is the 32-byte x-only pubkey blinded and
 * shown to the organizer in place of the old random token bytes. Same width (`TOKEN_BYTES` = 32),
 * so blind-issuance is unaffected.
 */
export function newTokenKeypair(): TokenKeypair {
  const q = generateSecretKey();
  const Q = schnorr.getPublicKey(q);
  return {q, Q};
}

/**
 * The 32-byte digest a holder proof signs: `sha256(utf8(SPEND_DOMAIN) || eventPubkeyBytes)` — a
 * 13 + 32 = 45-byte preimage hashed down to a fixed 32-byte digest (required for the @noble ↔
 * decred BIP-340 interop the relay's verifier relies on). `eventPubkeyHex` is the event's own
 * 64-hex-char `pubkey` (== token 0's `Q`), fixed before any `stiq_spend` tag is built.
 */
export function spendMessage(eventPubkeyHex: string): Uint8Array {
  const pk = hexToBytes(eventPubkeyHex); // 32 bytes
  const domain = utf8ToBytes(SPEND_DOMAIN); // 13 ASCII bytes
  const pre = new Uint8Array(domain.length + pk.length);
  pre.set(domain, 0);
  pre.set(pk, domain.length);
  return sha256(pre); // 32-byte digest
}

/**
 * One spent token's holder proof: a 64-byte BIP-340 schnorr signature by that token's secret `q`
 * over {@link spendMessage}. Wire form is base64-standard inside a `['stiq_spend', ...]` tag (see
 * ./blindPost `assembleBlindEvent`), matching `stiq_token`/`stiq_sig`'s encoding.
 */
export function spendProof(q: Uint8Array, eventPubkeyHex: string): Uint8Array {
  return schnorr.sign(spendMessage(eventPubkeyHex), q);
}

/**
 * Verify a holder proof against a token's public `Q` — used only by tests here (the relay is the
 * production verifier; the client never needs to check its own proofs at post time).
 */
export function verifySpendProof(sig: Uint8Array, eventPubkeyHex: string, Q: Uint8Array): boolean {
  return schnorr.verify(sig, spendMessage(eventPubkeyHex), Q);
}
