/**
 * End-to-end token lifecycle: a REAL blind-RSA issuer (crypto.subtle, available under jest) signs
 * a batch of blind tokens, the wallet fills, and the BlindSigner spends them into blind posts.
 * This exercises the exact client path AppRuntime.drawTokens will use, with real crypto — the
 * relay's acceptance of the same tokens is proven separately by the Go relay integration test.
 */
import {RSABSSA} from '@cloudflare/blindrsa-ts';
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {RealBlindRsa} from '../onboarding/blindrsaReal';
import {makeMint} from './blindTokenSource';
import {EpochWallet} from './wallet';
import {BlindSigner, type BlindSignerDeps} from './blindSigner';
import {setActiveCommunityKey} from './communityKey';
import {clearAuthorCache} from './identity';
import {isBlindPost, readBlindAuthor} from './blindPost';
import {mintGroupKey} from '../channels/groupCrypto';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {SecureStorage, UnsignedEvent} from '../keys/keystore';

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

describe('blind token draw → wallet → blind post (real crypto)', () => {
  const communityKey = mintGroupKey();
  const authorSk = generateSecretKey();
  const authorPk = getPublicKey(authorSk);
  const deps: BlindSignerDeps = {
    sign: (u: UnsignedEvent): Promise<Event> => Promise.resolve(finalizeEvent({...u, created_at: 1}, authorSk)),
    useSecretKey: async <T>(fn: (sk: Uint8Array) => T) => fn(authorSk),
  };

  afterEach(() => {
    setActiveCommunityKey(null);
    clearAuthorCache();
  });

  it('draws a batch from a real issuer and spends them into blind posts', async () => {
    // Stand up a real RSA blind-signature issuer (what the organizer holds).
    const suite = RSABSSA.SHA384.PSS.Deterministic();
    const kp = (await crypto.subtle.generateKey(
      {name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384'},
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const issuerPubB64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));

    // The issuer's blind-sign, mirroring organizer /api/sign-tokens.
    const blindSign = async (blindedB64: string): Promise<string> => {
      const sig = await suite.blindSign(kp.privateKey, base64ToBytes(blindedB64));
      return bytesToBase64(sig);
    };

    const mint = makeMint(new RealBlindRsa(), issuerPubB64, blindSign);
    const wallet = new EpochWallet(new Mem());
    await wallet.draw(1, 3, mint);
    expect(await wallet.count()).toBe(3);

    // A drawn token has the right shape: a 32-byte token and a full 2048-bit (256-byte) blind
    // signature. Cryptographic validity against the real verifier is proven by the Go relay
    // integration test (TestRelayAcceptsBlindPost), which runs the identical blind flow.
    const first = await wallet.spend();
    expect(first!.token.length).toBe(32);
    expect(first!.sig.length).toBe(256);

    // The remaining tokens flow through the BlindSigner into real blind posts.
    setActiveCommunityKey(communityKey);
    const signer = new BlindSigner(deps, wallet);
    const post = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'end to end'});
    expect(isBlindPost(post)).toBe(true);
    expect(post.pubkey).not.toBe(authorPk); // relay sees a throwaway signer
    expect(readBlindAuthor(post, communityKey)?.pubkey).toBe(authorPk); // members recover the author
    expect(await wallet.count()).toBe(1); // 3 drawn − 1 verify-spend − 1 post = 1 left
  }, 20000);
});
