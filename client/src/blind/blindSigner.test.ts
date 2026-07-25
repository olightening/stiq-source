import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {BlindSigner, BlindTokensExhausted, type BlindSignerDeps} from './blindSigner';
import {setActiveCommunityKey} from './communityKey';
import {setBytesPerToken} from './tokenCost';
import {readBlindAuthor, isBlindPost} from './blindPost';
import {resolveAuthor, clearAuthorCache} from './identity';
import {mintGroupKey} from '../channels/groupCrypto';
import {newTokenKeypair} from './holderProof';
import {encodeIdentityHeader} from '../profile/displayName';
import {EpochWallet, type MintToken, type Token} from './wallet';
import type {SecureStorage} from '../keys/keystore';
import type {UnsignedEvent} from '../keys/keystore';

class Mem implements SecureStorage {
  private m = new Map<string, string>();
  async setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  async getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  async removeItem(k: string) {
    this.m.delete(k);
  }
}

const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);
const communityKey = mintGroupKey();

const deps: BlindSignerDeps = {
  // Fallback marks the event so we can tell a normal sign from a blind one.
  sign: (u: UnsignedEvent) => Promise.resolve(finalizeEvent({...u, created_at: 1}, authorSk)),
  useSecretKey: async <T>(fn: (sk: Uint8Array) => T) => fn(authorSk),
};

async function walletWith(n: number): Promise<EpochWallet> {
  const w = new EpochWallet(new Mem());
  // Real holder-bound keypairs: each spent token signs the event / a stiq_spend proof, so the secret
  // must be a valid 32-byte key and `token` its matching x-only pubkey (P3).
  const mint: MintToken = async (): Promise<Token> => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: Uint8Array.of(9), secret: q};
  };
  if (n > 0) await w.draw(1, n, mint);
  return w;
}

describe('BlindSigner', () => {
  afterEach(() => {
    setActiveCommunityKey(null);
    setBytesPerToken(0);
    clearAuthorCache();
  });

  it('falls back to a normal npub event when the community is not blind', async () => {
    const signer = new BlindSigner(deps, await walletWith(5));
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'hi'});
    expect(ev.pubkey).toBe(authorPk); // signed by the real npub
    expect(isBlindPost(ev)).toBe(false);
  });

  it('produces a blind post spending a token when the community is blind', async () => {
    setActiveCommunityKey(communityKey);
    const wallet = await walletWith(2);
    const signer = new BlindSigner(deps, wallet);

    const content = encodeIdentityHeader('hello', 'alice', 'gradwire');
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content});

    expect(ev.pubkey).not.toBe(authorPk); // throwaway signer
    expect(isBlindPost(ev)).toBe(true);
    expect(ev.content).toBe('hello'); // SOH header stripped from the plaintext body

    // A member recovers the real author + name + gradient from the attestation.
    const attr = readBlindAuthor(ev, communityKey);
    expect(attr?.pubkey).toBe(authorPk);
    expect(attr?.name).toBe('alice');
    expect(attr?.gradient).toBe('gradwire');

    expect(await wallet.count()).toBe(1); // one token spent
  });

  it('throws (never silently de-anonymizes) when blind but out of tokens', async () => {
    setActiveCommunityKey(communityKey);
    const signer = new BlindSigner(deps, await walletWith(0));
    await expect(signer.sign({kind: 1, created_at: 0, tags: [], content: 'x'})).rejects.toBeInstanceOf(
      BlindTokensExhausted,
    );
  });

  it('spends MORE tokens for a heavier event and attaches one pair per token (weight-priced)', async () => {
    setActiveCommunityKey(communityKey);
    setBytesPerToken(16); // 16 bytes per token
    const wallet = await walletWith(100);
    const signer = new BlindSigner(deps, wallet);

    const before = await wallet.count();
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'x'.repeat(200)});
    const spent = before - (await wallet.count());

    expect(isBlindPost(ev)).toBe(true);
    expect(spent).toBeGreaterThan(1); // a 200-byte event costs several tokens, not the flat 1
    // The event carries exactly `spent` token pairs (relay requires that many distinct tokens).
    expect(ev.tags.filter(t => t[0] === 'stiq_token')).toHaveLength(spent);
    expect(ev.tags.filter(t => t[0] === 'stiq_sig')).toHaveLength(spent);
    // Still recovers the real author from the (single) attribution.
    expect(readBlindAuthor(ev, communityKey)?.pubkey).toBe(authorPk);
  });

  it('the resulting event resolves back to the real author via the identity resolver', async () => {
    setActiveCommunityKey(communityKey);
    const signer = new BlindSigner(deps, await walletWith(1));
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'hey'});
    expect(resolveAuthor(ev).pubkey).toBe(authorPk);
  });
});
