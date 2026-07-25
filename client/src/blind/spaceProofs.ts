/**
 * spaceProofs — the tokens-everywhere spend-proof chain for BOUND-NPUB space content (channel
 * messages, group chat/replies, h-tagged group reactions) and DM gift wraps.
 *
 * The blind path (./blindPost assembleBlindEvent) signs the event WITH token 0's secret, so token 0
 * is proof-free and tokens 1..N-1 carry stiq_spend proofs. Space content is different: the event is
 * signed by the member's real npub (roles + attribution intact) — or, for a DM, by the wrap's
 * ephemeral key — so NO token equals event.pubkey and EVERY token carries an explicit proof:
 *
 *     proofs[i] = schnorr.sign(spendMessage(event.pubkey), q_i)      // len(proofs) == len(tokens)
 *
 * The relay's space gate (policy/membership.go checkAllSpendProofs) verifies exactly this shape and
 * REJECTS the blind path's N-1 shape (and vice-versa), so the two chains can never be confused.
 * {@link spendMessage}/SPEND_DOMAIN are reused VERBATIM — they were always signer-agnostic (bound
 * to event.pubkey, never event.id, so there is no tag-in-preimage circularity: the signer's pubkey
 * is known before any stiq_spend tag exists).
 *
 * Because the signer's pubkey is known UP FRONT (unlike the blind path, where token 0 only emerges
 * from the wallet spend), there is no probe/rebuild dance here: compute the cost, spend, build the
 * tags, sign — one pass. No stiq_attr either: the npub signature IS the attribution (and a DM wrap
 * stays deliberately unattributable). No stiq_dom: the kind itself selects the space domain.
 */
import {bytesToBase64} from '../util/base64';
import {TAG_TOKEN, TAG_SIG, TAG_SPEND} from './protocol';
import {spendProof} from './holderProof';
import type {Token} from './wallet';

/**
 * Build the space-token tag block for an event that `signerPubkeyHex` will sign: all
 * [stiq_token, stiq_sig] pairs positionally, then ALL stiq_spend proofs in the same token order —
 * mirroring assembleBlindEvent's tag layout, with the all-proofs count (N proofs for N tokens).
 * Append these to the event's tags BEFORE signing (the tags are covered by the event id/signature;
 * the proofs themselves bind to the pubkey, which is fixed first).
 */
export function buildSpaceTokenTags(tokens: Token[], signerPubkeyHex: string): string[][] {
  const tags: string[][] = [];
  for (const t of tokens) {
    tags.push([TAG_TOKEN, bytesToBase64(t.token)], [TAG_SIG, bytesToBase64(t.sig)]);
  }
  for (const t of tokens) {
    tags.push([TAG_SPEND, bytesToBase64(spendProof(t.secret, signerPubkeyHex))]);
  }
  return tags;
}
