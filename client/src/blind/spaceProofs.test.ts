import {getPublicKey} from 'nostr-tools/pure';
import {buildSpaceTokenTags} from './spaceProofs';
import {newTokenKeypair, verifySpendProof} from './holderProof';
import {TAG_TOKEN, TAG_SIG, TAG_SPEND} from './protocol';
import {base64ToBytes, bytesToBase64} from '../util/base64';
import type {Token} from './wallet';

// A drawn token whose 32 bytes are a real BIP-340 pubkey Q with held secret q (P3 shape). The
// issuer signature is opaque to the proof chain, so junk bytes suffice here.
function mintToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: new Uint8Array([1, 2, 3]), secret: q};
}

// The member's real npub — the space chain binds proofs to the EVENT SIGNER's pubkey, which for
// space content is the npub (and for a DM wrap the ephemeral wrap key), never a token.
function memberPubkeyHex(): string {
  const {q} = newTokenKeypair();
  return getPublicKey(q);
}

describe('buildSpaceTokenTags (tokens-everywhere all-proofs chain)', () => {
  it('emits N token/sig pairs then N spend proofs, in token order', () => {
    const tokens = [mintToken(), mintToken(), mintToken()];
    const pubkey = memberPubkeyHex();
    const tags = buildSpaceTokenTags(tokens, pubkey);

    const tokenTags = tags.filter(t => t[0] === TAG_TOKEN);
    const sigTags = tags.filter(t => t[0] === TAG_SIG);
    const spendTags = tags.filter(t => t[0] === TAG_SPEND);
    expect(tokenTags).toHaveLength(3);
    expect(sigTags).toHaveLength(3);
    // ALL-proofs: one stiq_spend per token — including the first (no free token 0 on this chain).
    expect(spendTags).toHaveLength(3);

    // Positional integrity: the i-th token tag carries the i-th token's bytes and the i-th proof
    // verifies under the i-th token's Q — the relay pairs strictly by position.
    tokens.forEach((tok, i) => {
      expect(tokenTags[i]![1]).toBe(bytesToBase64(tok.token));
      const proof = base64ToBytes(spendTags[i]![1]!);
      expect(verifySpendProof(proof, pubkey, tok.token)).toBe(true);
    });
  });

  it('binds every proof to the signer pubkey — a different pubkey fails verification', () => {
    const tokens = [mintToken()];
    const tags = buildSpaceTokenTags(tokens, memberPubkeyHex());
    const proof = base64ToBytes(tags.find(t => t[0] === TAG_SPEND)![1]!);
    expect(verifySpendProof(proof, memberPubkeyHex(), tokens[0]!.token)).toBe(false);
  });

  it('a proof from one token never verifies under another (no any-proof-matches-any-token)', () => {
    const tokens = [mintToken(), mintToken()];
    const pubkey = memberPubkeyHex();
    const spendTags = buildSpaceTokenTags(tokens, pubkey).filter(t => t[0] === TAG_SPEND);
    const proof0 = base64ToBytes(spendTags[0]![1]!);
    expect(verifySpendProof(proof0, pubkey, tokens[1]!.token)).toBe(false);
  });

  it('zero tokens emit zero tags (a cost-0 caller adds nothing)', () => {
    expect(buildSpaceTokenTags([], memberPubkeyHex())).toHaveLength(0);
  });
});
