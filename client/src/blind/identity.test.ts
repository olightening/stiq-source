import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {
  resolveAuthor,
  resolveAuthorPubkey,
  clearAuthorCache,
  isUnattributedBlindPost,
  warmAuthorResolution,
  warmAuthorResolutionCold,
} from './identity';
import {setActiveCommunityKey} from './communityKey';
import {toBlindEvent, assembleBlindEvent} from './blindPost';
import {newTokenKeypair} from './holderProof';
import {mintGroupKey} from '../channels/groupCrypto';
import {advisoryOverlay, buildLogUser} from '../moderation/advisory';
import {filterFeed} from '../moderation/filter';
import {finalizeEvent, type Event} from 'nostr-tools/pure';
import {Kind} from '../contracts';
import type {Token} from './wallet';

const communityKey = mintGroupKey();
/** A fresh P3 holder-bound token: `token` (Q) and `secret` (q) are a real matching keypair, so the
 *  assembled event's pubkey (== hex(Q)) is valid and its attribution binds/decrypts correctly. */
function freshToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: Uint8Array.of(2), secret: q};
}
const token: Token = freshToken();

const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);

const modSk = generateSecretKey();
const modNpub = nip19.npubEncode(getPublicKey(modSk));

function blindPostBy(sk: Uint8Array, content: string): Event {
  // Fresh token per post so each blind post carries its own signer pubkey (== hex(Q0)), matching the
  // pre-P3 "each post signed by a different throwaway key" behaviour the distinct-pubkey test relies on.
  return toBlindEvent({kind: 1, created_at: 1000, tags: [], content}, [freshToken()], sk, communityKey, {
    name: 'alice',
  });
}

describe('blind-post identity resolution + moderation', () => {
  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  it('resolves a blind post to its real author, not the throwaway signer', () => {
    const ev = blindPostBy(authorSk, 'hi');
    expect(ev.pubkey).not.toBe(authorPk);
    const got = resolveAuthor(ev);
    expect(got.blind).toBe(true);
    expect(got.pubkey).toBe(authorPk);
    expect(got.name).toBe('alice');
  });

  it('without the community key, a blind post resolves to its throwaway signer', () => {
    const ev = blindPostBy(authorSk, 'hi');
    clearAuthorCache();
    setActiveCommunityKey(null);
    expect(resolveAuthorPubkey(ev)).toBe(ev.pubkey);
    expect(resolveAuthorPubkey(ev)).not.toBe(authorPk);
  });

  it('a standing ban routes every blind post by that npub to the mod log', () => {
    // Two blind posts by the same author, each signed by a DIFFERENT throwaway key.
    const p1 = blindPostBy(authorSk, 'first');
    const p2 = blindPostBy(authorSk, 'second');
    expect(p1.pubkey).not.toBe(p2.pubkey); // fresh throwaway keys

    const logUser = finalizeEvent({...buildLogUser(authorPk), created_at: 2000}, modSk);
    const overlay = advisoryOverlay([logUser], pk => pk === getPublicKey(modSk));

    const {visible, moderationLog} = filterFeed([p1, p2], [logUser], [modNpub], undefined, overlay);
    expect(visible).toHaveLength(0);
    expect(moderationLog).toHaveLength(2); // BOTH posts, despite different signers
  });

  it('a moderated npub can still post (content stays; it just renders in the log)', () => {
    const p1 = blindPostBy(authorSk, 'still here');
    const logUser = finalizeEvent({...buildLogUser(authorPk), created_at: 2000}, modSk);
    const overlay = advisoryOverlay([logUser], pk => pk === getPublicKey(modSk));
    const {moderationLog} = filterFeed([p1], [logUser], [modNpub], undefined, overlay);
    // The post is not dropped — it is present, just in the log rather than the feed.
    expect(moderationLog.map(e => e.post.id)).toContain(p1.id);
  });
});

describe('isUnattributedBlindPost — patched-client anonymization enforcement', () => {
  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  /** A blind post spending a token but carrying a garbage (undecryptable) attribution. */
  function garbageAttrPost(content: string): Event {
    return assembleBlindEvent({kind: 1, created_at: 1000, tags: [], content}, [token], 'garbage');
  }

  it('a valid member-signed attestation is NOT flagged', () => {
    const ev = blindPostBy(authorSk, 'legit');
    expect(isUnattributedBlindPost(ev)).toBe(false);
  });

  it('a garbage stiq_attr IS flagged', () => {
    expect(isUnattributedBlindPost(garbageAttrPost('spoof'))).toBe(true);
  });

  it('a stripped stiq_attr (no attribution tag at all) IS flagged', () => {
    const ev = assembleBlindEvent({kind: 1, created_at: 1000, tags: [], content: 'no attr'}, [token], '');
    expect(isUnattributedBlindPost(ev)).toBe(true);
  });

  it('a non-token (non-blind) post is NOT flagged', () => {
    const plain = finalizeEvent({kind: 1, created_at: 1000, tags: [], content: 'plain'}, authorSk);
    expect(isUnattributedBlindPost(plain)).toBe(false);
  });

  it('defers (returns false) when the community key is not loaded', () => {
    const ev = garbageAttrPost('spoof');
    clearAuthorCache();
    setActiveCommunityKey(null);
    expect(isUnattributedBlindPost(ev)).toBe(false);
  });
});

describe('warmAuthorResolution / warmAuthorResolutionCold — ingest/cold-start cache warmup', () => {
  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  /**
   * Kind-filtering is verified through the cache's real effect rather than a call-count spy (the
   * warmup helpers call the module's own `resolveAuthor` directly, so mocking it wouldn't observe
   * the internal call site): warm two otherwise-identical blind posts differing only in `kind`,
   * THEN swap to a WRONG community key before the real read. A warmed post already has its correct
   * resolution cached and survives the key swap; an un-warmed one re-decrypts under the wrong key
   * and falls back to its throwaway signer.
   */
  it('only warms feed-content kinds — a GiftWrap-shaped event is never pre-resolved', () => {
    const eligible: Event = {...blindPostBy(authorSk, 'warmed'), kind: Kind.Post};
    const ineligible: Event = {...blindPostBy(authorSk, 'not warmed'), kind: Kind.GiftWrap};

    warmAuthorResolution(eligible);
    warmAuthorResolution(ineligible);

    setActiveCommunityKey(mintGroupKey()); // wrong key from here on
    expect(resolveAuthor(eligible).pubkey).toBe(authorPk); // cached under the CORRECT key already
    expect(resolveAuthor(ineligible).pubkey).toBe(ineligible.pubkey); // never warmed → wrong-key miss
  });

  it('is a no-op (never throws) for a non-content kind, even with garbage tags', () => {
    const giftWrapLike: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1000,
      kind: Kind.GiftWrap,
      tags: [['stiq_token', 'garbage']],
      content: 'ciphertext',
      sig: '0'.repeat(128),
    };
    expect(() => warmAuthorResolution(giftWrapLike)).not.toThrow();
  });

  it('warms every eligible event across a chunked, yielding cold-start pass', async () => {
    // Plain (non-blind) filler events need no crypto, so this test is not timing-sensitive.
    const fillers: Event[] = Array.from({length: 70}, (_, i) => ({
      id: `filler-${i}`.padEnd(64, '0'),
      pubkey: 'c'.repeat(64),
      created_at: 1000 + i,
      kind: Kind.Post,
      tags: [],
      content: '',
      sig: '0'.repeat(128),
    }));
    const warmedBlind = blindPostBy(authorSk, 'in the cold batch');
    const skippedGiftWrap: Event = {...blindPostBy(authorSk, 'never in a cold batch'), kind: Kind.GiftWrap};

    const done = warmAuthorResolutionCold([...fillers, warmedBlind, skippedGiftWrap]);
    await done; // real timers — chunking just yields via setTimeout(0), no crypto-timing assumption

    setActiveCommunityKey(mintGroupKey()); // wrong key from here on
    expect(resolveAuthor(warmedBlind).pubkey).toBe(authorPk); // warmed under the correct key
    expect(resolveAuthor(skippedGiftWrap).pubkey).toBe(skippedGiftWrap.pubkey); // kind-filtered out
  });
});

describe('isOffRollBlindPost — member-roll enforcement (ban-evasion fix)', () => {
  const {setActiveMemberRoll} = require('./memberRoll') as typeof import('./memberRoll');
  const {isOffRollBlindPost, isUnverifiedBlindPost} = require('./identity') as typeof import('./identity');

  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
    setActiveMemberRoll(null);
  });
  afterAll(() => {
    setActiveCommunityKey(null);
    setActiveMemberRoll(null);
  });

  it('defers (false) while no roll is loaded — legacy communities unchanged', () => {
    const ev = blindPostBy(authorSk, 'no roll yet');
    expect(isOffRollBlindPost(ev)).toBe(false);
    expect(isUnverifiedBlindPost(ev)).toBe(false);
  });

  it('a post whose attribution is ON the roll stays visible', () => {
    setActiveMemberRoll(new Set([authorPk]));
    const ev = blindPostBy(authorSk, 'enrolled author');
    expect(isOffRollBlindPost(ev)).toBe(false);
    expect(isUnverifiedBlindPost(ev)).toBe(false);
  });

  it('a post attributed to a fresh, never-bound npub is off-roll', () => {
    setActiveMemberRoll(new Set([authorPk]));
    const rogueSk = generateSecretKey();
    const ev = blindPostBy(rogueSk, 'sock puppet');
    expect(isOffRollBlindPost(ev)).toBe(true);
    expect(isUnverifiedBlindPost(ev)).toBe(true);
  });

  it('an UNATTRIBUTED post is not off-roll (distinct bucket), but is unverified', () => {
    setActiveMemberRoll(new Set([authorPk]));
    const base = blindPostBy(authorSk, 'stripped');
    const noAttr = {...base, tags: base.tags.filter(t => t[0] !== 'stiq_attr')};
    expect(isOffRollBlindPost(noAttr)).toBe(false);
    expect(isUnattributedBlindPost(noAttr)).toBe(true);
    expect(isUnverifiedBlindPost(noAttr)).toBe(true);
  });

  it('defers without the community key even when a roll is loaded', () => {
    setActiveMemberRoll(new Set([authorPk]));
    const ev = blindPostBy(generateSecretKey(), 'cannot judge yet');
    clearAuthorCache();
    setActiveCommunityKey(null);
    expect(isOffRollBlindPost(ev)).toBe(false);
  });

  it('a roll update flips the verdict without clearing the author cache', () => {
    const rogueSk = generateSecretKey();
    const roguePk = getPublicKey(rogueSk);
    setActiveMemberRoll(new Set([authorPk]));
    const ev = blindPostBy(rogueSk, 'late bind');
    expect(isOffRollBlindPost(ev)).toBe(true);
    // The member's binding lands and the organizer republishes the roll:
    setActiveMemberRoll(new Set([authorPk, roguePk]));
    expect(isOffRollBlindPost(ev)).toBe(false);
  });

  it('never flags a plain npub-signed event', () => {
    setActiveMemberRoll(new Set([authorPk]));
    const plain = finalizeEvent({kind: 1, created_at: 1000, tags: [], content: 'plain'}, generateSecretKey());
    expect(isOffRollBlindPost(plain)).toBe(false);
    expect(isUnverifiedBlindPost(plain)).toBe(false);
  });
});
