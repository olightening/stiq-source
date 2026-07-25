import {generateSecretKey, getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {toBlindEvent, isBlindPost, readBlindAuthor, assembleBlindEvent} from './blindPost';
import {mintGroupKey} from '../channels/groupCrypto';
import {newTokenKeypair, verifySpendProof} from './holderProof';
import {TAG_ATTR, TAG_SIG, TAG_TOKEN, TAG_SPEND} from './protocol';
import {bytesToHex} from '../util/hex';
import {base64ToBytes} from '../util/base64';
import type {Token} from './wallet';

/** A fresh holder-bound token: a real BIP-340 keypair (Q = the wire token, q = the secret). */
function makeToken(sigMarker = 9): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: Uint8Array.of(sigMarker, sigMarker, sigMarker), secret: q};
}

describe('toBlindEvent', () => {
  const communityKey = mintGroupKey();
  const token: Token = makeToken();

  const unsigned = {
    kind: 1,
    created_at: 1000,
    tags: [['t', 'general']],
    content: 'hello world',
  };

  it('signs the event with token 0 — event.pubkey IS the token (holder-bound, P3)', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(unsigned, [token], authorSk, communityKey, {name: 'alice'});

    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).not.toBe(authorPk); // relay never sees the real npub
    expect(ev.pubkey).toBe(bytesToHex(token.token)); // event.pubkey === hex(Q0)
    expect(ev.kind).toBe(1);
    expect(ev.content).toBe('hello world');
    expect(ev.tags).toContainEqual(['t', 'general']); // original tags preserved
  });

  it('a single-token post carries NO stiq_spend tag — wire-identical to a pre-P3 post', () => {
    const ev = toBlindEvent(unsigned, [token], generateSecretKey(), communityKey);
    expect(isBlindPost(ev)).toBe(true);
    expect(ev.tags.find(t => t[0] === TAG_TOKEN)?.[1]).toBeTruthy();
    expect(ev.tags.find(t => t[0] === TAG_SIG)?.[1]).toBeTruthy();
    expect(ev.tags.find(t => t[0] === TAG_ATTR)?.[1]).toBeTruthy();
    expect(ev.tags.filter(t => t[0] === TAG_SPEND)).toHaveLength(0);
  });

  it('lets a member recover the real author; a host cannot', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(unsigned, [token], authorSk, communityKey, {
      name: 'alice',
      gradient: 'grad1',
    });

    const asMember = readBlindAuthor(ev, communityKey);
    expect(asMember?.pubkey).toBe(authorPk);
    expect(asMember?.name).toBe('alice');
    expect(asMember?.gradient).toBe('grad1');

    // A host without the community key sees only a throwaway signer.
    expect(readBlindAuthor(ev, mintGroupKey())).toBeNull();
  });

  it('treats a plain (non-blind) event as not a blind post', () => {
    expect(isBlindPost({tags: [['t', 'x']]})).toBe(false);
    expect(readBlindAuthor({pubkey: 'p', tags: [['t', 'x']]}, communityKey)).toBeNull();
  });

  it('fuzzes created_at backward within a coarse bucket, never into the future (audit #48, M4)', () => {
    const BUCKET = 180;
    // A wall-clock second well inside a bucket (150s past the boundary), so backward fuzz has room
    // to move and we can prove it never overshoots `now`.
    const bucketStart = Math.floor(1_700_000_123 / BUCKET) * BUCKET;
    const now = bucketStart + 150;
    const stamps = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const ev = assembleBlindEvent(
        {kind: 1, created_at: now, tags: [], content: 'x'},
        [makeToken()],
        'attr',
      );
      // The event id commits to the fuzzed timestamp, so it stays self-consistent.
      expect(verifyEvent(ev)).toBe(true);
      // Backward-only: never in the future. A future-dated created_at distorts feed ordering, is
      // rejected by relays enforcing created_at ≤ now, and can fall below the feed's incremental
      // `since` (which has no blind-fuzz margin) and be silently dropped on reconnect (M4).
      expect(ev.created_at).toBeLessThanOrEqual(now);
      // Still quantized DOWN to the bucket floor + CSPRNG jitter — decoupled from the true second.
      expect(ev.created_at).toBeGreaterThanOrEqual(bucketStart);
      stamps.add(ev.created_at);
    }
    // Randomized (not a single fixed value) and not pinned to the exact wall-clock second, so it is
    // not a per-second timing fingerprint.
    expect(stamps.size).toBeGreaterThan(1);
    expect([...stamps].some(s => s !== now)).toBe(true);
    // Max backward shift stays under the bucket (< 180s), safely below the feed overlap (300s), so a
    // fresh blind post is never skipped by a reader whose `since` = high-water − overlap.
    expect(now - Math.min(...stamps)).toBeLessThan(BUCKET);
  });
});

describe('assembleBlindEvent — multi-token holder proofs (P3)', () => {
  const unsigned = {kind: 1, created_at: 1000, tags: [['t', 'x']], content: 'y'};

  it('spending N tokens emits exactly N-1 positional stiq_spend proofs, each verifying against its own token', () => {
    const tokens = [makeToken(1), makeToken(2), makeToken(3), makeToken(4)];
    const ev = assembleBlindEvent(unsigned, tokens, 'attr');

    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).toBe(bytesToHex(tokens[0]!.token)); // token 0 signed the event — no proof needed

    const tokenTags = ev.tags.filter(t => t[0] === TAG_TOKEN);
    const spendTags = ev.tags.filter(t => t[0] === TAG_SPEND);
    expect(tokenTags).toHaveLength(4);
    expect(spendTags).toHaveLength(3); // one per token beyond the first

    // Positional: spendTags[i] proves tokens[i+1] over the event's own pubkey.
    for (let i = 0; i < spendTags.length; i++) {
      const sig = base64ToBytes(spendTags[i]![1]!);
      expect(verifySpendProof(sig, ev.pubkey, tokens[i + 1]!.token)).toBe(true);
      // A proof does NOT verify against the wrong token's public key.
      expect(verifySpendProof(sig, ev.pubkey, tokens[0]!.token)).toBe(false);
    }
  });

  it('stiq_token/stiq_sig pairs come before all stiq_spend tags, which come before stiq_attr', () => {
    const tokens = [makeToken(1), makeToken(2), makeToken(3)];
    const ev = assembleBlindEvent(unsigned, tokens, 'attr');
    const order = ev.tags.map(t => t[0]).filter(name => name !== 't');
    expect(order).toEqual([
      TAG_TOKEN,
      TAG_SIG,
      TAG_TOKEN,
      TAG_SIG,
      TAG_TOKEN,
      TAG_SIG,
      TAG_SPEND,
      TAG_SPEND,
      TAG_ATTR,
    ]);
  });

  it('throws when given zero tokens', () => {
    expect(() => assembleBlindEvent(unsigned, [], 'attr')).toThrow();
  });
});
