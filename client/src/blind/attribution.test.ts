import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {buildAttribution, parseAttribution} from './attribution';
import {mintGroupKey} from '../channels/groupCrypto';

describe('blind post attribution', () => {
  const communityKey = mintGroupKey();

  it('round-trips: a member recovers the real author + name + gradient', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const throwaway = getPublicKey(generateSecretKey());

    const tag = buildAttribution(authorSk, throwaway, communityKey, {
      name: 'alice',
      gradient: 'abc123',
    });
    const got = parseAttribution(tag, throwaway, communityKey);

    expect(got).not.toBeNull();
    expect(got!.pubkey).toBe(authorPk);
    expect(got!.name).toBe('alice');
    expect(got!.gradient).toBe('abc123');
  });

  it('is opaque without the community key (relay/host stays blind)', () => {
    const authorSk = generateSecretKey();
    const throwaway = getPublicKey(generateSecretKey());
    const tag = buildAttribution(authorSk, throwaway, communityKey);

    // A host who lacks the community key cannot recover the author.
    expect(parseAttribution(tag, throwaway, mintGroupKey())).toBeNull();
  });

  it('rejects a replayed attribution pasted onto a different post', () => {
    const authorSk = generateSecretKey();
    const throwawayA = getPublicKey(generateSecretKey());
    const throwawayB = getPublicKey(generateSecretKey());

    // Attribution built for post A...
    const tag = buildAttribution(authorSk, throwawayA, communityKey);
    // ...must not validate when attached to post B (a different throwaway signer).
    expect(parseAttribution(tag, throwawayB, communityKey)).toBeNull();
    // ...but is still valid for its own post.
    expect(parseAttribution(tag, throwawayA, communityKey)).not.toBeNull();
  });

  it('returns null on a missing tag', () => {
    const throwaway = getPublicKey(generateSecretKey());
    expect(parseAttribution(undefined, throwaway, communityKey)).toBeNull();
    expect(parseAttribution('', throwaway, communityKey)).toBeNull();
  });

  it('returns null on a tampered ciphertext', () => {
    const authorSk = generateSecretKey();
    const throwaway = getPublicKey(generateSecretKey());
    const tag = buildAttribution(authorSk, throwaway, communityKey);
    const tampered = tag.slice(0, -3) + (tag.endsWith('A') ? 'BBB' : 'AAA');
    expect(parseAttribution(tampered, throwaway, communityKey)).toBeNull();
  });
});
