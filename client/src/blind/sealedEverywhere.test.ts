/**
 * T5.2 "decrypt everywhere" — the enforcement suite for the sealed-content invariant:
 *
 *   Every read of `event.content` where the kind can be a blind post MUST go through
 *   resolveContent (or provably operate on already-resolved text). A locked body renders as the
 *   locked state — NEVER as ciphertext, and never miscounted (NIP-25's "empty means like" must
 *   not swallow ciphertext-that-resolved-to-''). Every cached render of a sealable kind keys on
 *   contentLockState so an unlock (L→u) rebuilds it. Private-space NIP-44 content is a different
 *   scheme; only isSealedContent (isBlindPost-gated) may classify.
 *
 * ── WI-1 classification manifest (audit of every `.content` consumer, 2026-07-29) ─────────────
 *
 * SEALABLE KINDS (everything routed through AppRuntime.feedSigner → BlindSigner, which seals
 * kind-agnostically): 1 posts, 30023 articles, 1111 comments + hybrid kind-1 'stiq-comment' +
 * pinned author's notes, 7 reactions in 'feed'/'channel' scope, 30351 media blobs, 31925 RSVPs,
 * (1068 polls in principle — no composer exists). NOT sealable: 1311 channel broadcasts, NIP-29
 * group 9/11/12, group-scope kind 7, 1984 reports, 30078 org config, DMs (1059), key-delivery
 * 30079, draft access/delivery — all npub-signed or under their own crypto, never feedSigner.
 *
 * Surfaces verified already-resolved (class c), resolver site in parens:
 *   feed build            feed.ts toFeedItem (resolveContent :185; cache key carries
 *                         contentLockState + score + myVote, feed.ts:387-391)
 *   search                search.ts (operates on FeedItem post-resolution)
 *   comments/threads      CommentItem.tsx:118, CommentThread.tsx:47-51 (resolve BEFORE
 *                         decodeNameHeader — ordering is load-bearing)
 *   ref embeds / saved    RefEmbed/SavedEmbedSheet via NostrEventSummary — sole producer is
 *                         AppRuntime.getEvent() (resolveContent :7144, root :7157)
 *   events surface        eventsStore.interestedTallies :342
 *   notifications         AppRuntime :6430 (locked → '' preview)
 *   moderation            autoModeration.ts:97, modlog.ts bodyOf, queue.ts snippetOf
 *   profile ideas         AppRuntime.ideasFor :7462
 *
 * Gaps CLOSED by T5.2 (class d → fixed, pinned below):
 *   voting                feed/voting.ts reactionValue — was raw; scores would flatline to 0
 *                         permanently once sealing flipped on
 *   channel emoji chips   channels/reactions.ts foldReactionEvents (+ tallyAllReactions as
 *                         permanent insurance)
 *   media blobs           feed/mediaBlob.ts readMediaBlobPayload — NIP-44 ciphertext is itself
 *                         base64 and passed the well-formedness check
 *   author's notes        MainScreen note + edit history (dark, AUTHOR_NOTE_ENABLED=false) —
 *                         the one literal ciphertext-on-screen case
 *
 * Known-inert (documented, no fix needed): feed.ts prepareFeedItems' name/gradient learning pass
 * reads raw content pre-resolve — decodeNameHeader on ciphertext just fails to match and no-ops
 * (a locked post can't seed a phonebook name until unlocked; nothing renders).
 *
 * Related suites (extend, don't duplicate): contentKey.test.ts pins BlindSigner's fail-closed
 * sealing + the 2026-07-22 regression (un-advertising stops sealing even with a cached epoch
 * key); AppRuntime.capsSticky.test.ts pins content_encryption's sticky advertisement semantics
 * under a dead/degraded primary; MirrorSet.test.ts pins the N>1 federation path (identical
 * ciphertext fan-out, secondary-delivered sealed events).
 */
import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {TAG_TOKEN, TAG_SIG, TAG_ENC, ENC_NIP44, TAG_KE} from './protocol';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from './contentKey';
import {resolveContent, contentLockState} from './blindPost';
import {mintGroupKey, encryptForSpace} from '../channels/groupCrypto';
import {bytesToBase64} from '../util/base64';
import {toFeedItem, clearItemCache} from '../feed/feed';
import {searchFeed} from '../feed/search';
import {scoreReactions, myVote, reactionValue, RETRACT_MARKER} from '../feed/voting';
import {tallyEmojiReactions, tallyAllReactions} from '../channels/reactions';
import {readMediaBlobPayload} from '../feed/mediaBlob';
import {interestedTallies} from '../events/eventsStore';
import {KIND_MEDIA_BLOB} from '../contracts';

const EPOCH = 7;

/** A wire-accurate sealed blind event: token pair (isBlindPost) + NIP-44 marker + epoch tag. */
function sealedBlindEvent(
  kind: number,
  body: string,
  key: Uint8Array,
  extraTags: string[][] = [],
  createdAt = 1000,
): Event {
  return finalizeEvent(
    {
      kind,
      created_at: createdAt,
      tags: [
        [TAG_TOKEN, bytesToBase64(Uint8Array.of(1, 2, 3))],
        [TAG_SIG, bytesToBase64(Uint8Array.of(4, 5, 6))],
        [TAG_ENC, ENC_NIP44],
        [TAG_KE, String(EPOCH)],
        ...extraTags,
      ],
      content: encryptForSpace(body, key),
    },
    generateSecretKey(),
  );
}

/** Every string in a surface's output — the "ciphertext never appears anywhere" net. */
function outputText(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

describe('sealedEverywhere — locked never leaks, unlocked always resolves', () => {
  const key = mintContentKey();

  afterEach(() => {
    clearActiveContentKeys();
    clearItemCache();
  });

  describe('feed item build (toFeedItem)', () => {
    const body = 'the secret feed body';

    it('locked: empty content + locked flag + epoch, media withheld, ciphertext nowhere', () => {
      const post = sealedBlindEvent(1, body, key);
      const item = toFeedItem(post);
      expect(item.locked).toBe(true);
      expect(item.lockedEpoch).toBe(EPOCH);
      expect(item.content).toBe('');
      expect(item.imageUrl).toBeUndefined();
      expect(item.voice).toBeUndefined();
      expect(outputText(item)).not.toContain(post.content);
      expect(contentLockState(post)).toBe('L');
    });

    it('unlocked: plaintext resolves into content; lock state flips L→u (the cache-key rebuild)', () => {
      const post = sealedBlindEvent(1, body, key);
      setContentEpochKey(EPOCH, key);
      const item = toFeedItem(post);
      expect(item.locked).toBeUndefined();
      expect(item.content).toBe(body);
      expect(outputText(item)).not.toContain(post.content);
      expect(contentLockState(post)).toBe('u');
    });

    it('articles (30023) seal identically — the signer is kind-agnostic', () => {
      const article = sealedBlindEvent(30023, body, key, [['title', 'Public title']]);
      const lockedItem = toFeedItem(article);
      expect(lockedItem.locked).toBe(true);
      expect(lockedItem.content).toBe('');
      expect(lockedItem.title).toBe('Public title'); // titles ride tags, deliberately unsealed
      setContentEpochKey(EPOCH, key);
      expect(toFeedItem(article).content).toBe(body);
    });
  });

  describe('search (documents the accepted limitation)', () => {
    it('a locked post is findable by title/tags only — never by body, never via ciphertext', () => {
      const post = sealedBlindEvent(1, 'needle in the body', key, [['title', 'haystack title']]);
      const lockedItem = toFeedItem(post);
      expect(searchFeed([lockedItem], 'needle')).toHaveLength(0);
      expect(searchFeed([lockedItem], 'haystack')).toHaveLength(1);
      // Ciphertext must not be a search surface either.
      expect(searchFeed([lockedItem], post.content.slice(0, 12))).toHaveLength(0);
      clearItemCache();
      setContentEpochKey(EPOCH, key);
      expect(searchFeed([toFeedItem(post)], 'needle')).toHaveLength(1);
    });
  });

  describe('voting (kind 7 rides the blind signer)', () => {
    it('locked votes are UNCOUNTED — never +1 via the "empty means like" rule, never -1', () => {
      const up = sealedBlindEvent(7, '+', key, [['e', 'post1']]);
      const down = sealedBlindEvent(7, '-', key, [['e', 'post1']], 1001);
      expect(reactionValue(up)).toBe(0);
      expect(reactionValue(down)).toBe(0);
      const score = scoreReactions([up, down]);
      expect(score).toEqual({up: 0, down: 0, score: 0, voteTimestamps: []});
      expect(myVote([up], up.pubkey)).toBeNull();
    });

    it('unlocked votes count normally, and a sealed retraction retracts', () => {
      setContentEpochKey(EPOCH, key);
      const up = sealedBlindEvent(7, '+', key, [['e', 'post1']]);
      const down = sealedBlindEvent(7, '-', key, [['e', 'post1']], 1001);
      expect(reactionValue(up)).toBe(1);
      expect(reactionValue(down)).toBe(-1);
      const score = scoreReactions([up, down]);
      expect(score.up).toBe(1);
      expect(score.down).toBe(1);
      expect(myVote([up], up.pubkey)).toBe('up');
      const retract = sealedBlindEvent(7, RETRACT_MARKER, key, [['e', 'post1']], 1002);
      expect(reactionValue(retract)).toBe(0);
    });

    it('plaintext votes pass through unchanged (dark-ship behavior byte-identical)', () => {
      const plain = finalizeEvent(
        {kind: 7, created_at: 1000, tags: [['e', 'post1']], content: '+'},
        generateSecretKey(),
      );
      expect(reactionValue(plain)).toBe(1);
    });
  });

  describe('channel emoji reactions', () => {
    it('locked: uncounted and the ciphertext NEVER becomes a chip label', () => {
      const r = sealedBlindEvent(7, '🔥', key, [['e', 'msg1']]);
      const tallies = tallyEmojiReactions([r], ['🔥'], null);
      expect(tallies).toEqual([{emoji: '🔥', count: 0, mine: false, pubkeys: []}]);
      expect(outputText(tallyEmojiReactions([r], [], null))).not.toContain(r.content);
      expect(outputText(tallyAllReactions([r], null))).not.toContain(r.content);
    });

    it('unlocked: the emoji counts, attributed to its voter', () => {
      setContentEpochKey(EPOCH, key);
      const r = sealedBlindEvent(7, '🔥', key, [['e', 'msg1']]);
      const tallies = tallyEmojiReactions([r], ['🔥'], r.pubkey);
      expect(tallies).toEqual([{emoji: '🔥', count: 1, mine: true, pubkeys: [r.pubkey]}]);
    });
  });

  describe('media blobs (30351 — ciphertext is itself base64, the regex trap)', () => {
    const payload = bytesToBase64(Uint8Array.from({length: 48}, (_, i) => i));

    it('locked: "not found" (soft-fail) — ciphertext never reaches a decoder', () => {
      const blob = sealedBlindEvent(KIND_MEDIA_BLOB, payload, key);
      // The trap this guards: NIP-44 ciphertext passes a bare base64 well-formedness check.
      expect(/^[A-Za-z0-9+/=]+$/.test(blob.content)).toBe(true);
      expect(readMediaBlobPayload(blob)).toBeNull();
    });

    it('unlocked: the original payload round-trips byte-identically', () => {
      setContentEpochKey(EPOCH, key);
      const blob = sealedBlindEvent(KIND_MEDIA_BLOB, payload, key);
      expect(readMediaBlobPayload(blob)).toBe(payload);
    });

    it('plaintext blobs pass through unchanged', () => {
      const plain = finalizeEvent(
        {kind: KIND_MEDIA_BLOB, created_at: 1000, tags: [], content: payload},
        generateSecretKey(),
      );
      expect(readMediaBlobPayload(plain)).toBe(payload);
    });
  });

  describe('event RSVPs (31925 — the reference implementation the voting fix mirrors)', () => {
    const coord = `31923:${'a'.repeat(64)}:evt-1`;

    it('locked RSVPs are uncounted; unlocked count', () => {
      const rsvp = sealedBlindEvent(31925, '+', key, [['a', coord]]);
      const lockedTally = interestedTallies([rsvp], ev => ev.pubkey, rsvp.pubkey);
      expect(lockedTally.get(coord)).toEqual({count: 0, mine: false});
      setContentEpochKey(EPOCH, key);
      const openTally = interestedTallies([rsvp], ev => ev.pubkey, rsvp.pubkey);
      expect(openTally.get(coord)).toEqual({count: 1, mine: true});
    });
  });

  describe('pinned author notes (1111 + stiq-pin — MainScreen renders via resolveContent)', () => {
    it('a sealed note resolves locked (placeholder, never ciphertext) then to plaintext', () => {
      const note = sealedBlindEvent(1111, 'author commentary', key, [['stiq-pin', 'post1']]);
      expect(resolveContent(note)).toEqual({text: '', locked: true});
      setContentEpochKey(EPOCH, key);
      expect(resolveContent(note)).toEqual({text: 'author commentary', locked: false});
    });
  });

  describe('comments — BOTH wire shapes resolve identically', () => {
    it.each([
      ['kind 1111', 1111, [] as string[][]],
      ['hybrid kind-1 stiq-comment', 1, [['stiq-comment', 'root1']]],
    ])('%s: locked withholds, unlocked resolves, ciphertext never returned', (_label, kind, tags) => {
      const c = sealedBlindEvent(kind, 'a reply body', key, tags);
      const locked = resolveContent(c);
      expect(locked).toEqual({text: '', locked: true});
      setContentEpochKey(EPOCH, key);
      const open = resolveContent(c);
      expect(open).toEqual({text: 'a reply body', locked: false});
      expect(open.text).not.toBe(c.content);
    });
  });

  describe('the separator: private-space NIP-44 content is NOT the blind seal', () => {
    it('a space message carrying the nip44 marker but NO token is never classified sealed', () => {
      const spaceKey = mintGroupKey();
      const spaceMsg = finalizeEvent(
        {
          kind: 9,
          created_at: 1000,
          tags: [
            [TAG_ENC, ENC_NIP44],
            ['h', 'group1'],
          ],
          content: encryptForSpace('a private group message', spaceKey),
        },
        generateSecretKey(),
      );
      // No stiq_token ⇒ isBlindPost false ⇒ resolveContent must pass it through UNTOUCHED for the
      // private-space pipeline (decryptSpaceMessages) — never intercept, never report locked.
      expect(contentLockState(spaceMsg)).toBe('');
      expect(resolveContent(spaceMsg)).toEqual({text: spaceMsg.content, locked: false});
    });
  });

  describe('tampered/undecryptable seals degrade to locked, never ciphertext', () => {
    it('wrong-key ciphertext reports locked even with an unlocked epoch', () => {
      const otherKey = mintContentKey();
      const post = sealedBlindEvent(1, 'sealed under a key we do not have', otherKey);
      setContentEpochKey(EPOCH, key); // epoch "unlocked", but with a DIFFERENT key
      expect(resolveContent(post)).toEqual({text: '', locked: true});
      const item = toFeedItem(post);
      expect(item.content).toBe('');
      expect(outputText(item)).not.toContain(post.content);
    });
  });

  describe('resolution memo (score-pass hot path) never outlives the keys', () => {
    it('repeated resolves are stable, and a key wipe re-locks the SAME event object', () => {
      const post = sealedBlindEvent(1, 'memoized body', key);
      setContentEpochKey(EPOCH, key);
      expect(resolveContent(post)).toEqual({text: 'memoized body', locked: false});
      expect(resolveContent(post)).toEqual({text: 'memoized body', locked: false});
      // Duress wipe / account switch: the cached plaintext must NOT survive the key clear.
      clearActiveContentKeys();
      expect(resolveContent(post)).toEqual({text: '', locked: true});
      // Re-delivering the key restores resolution (memo or not — behavior is identical).
      setContentEpochKey(EPOCH, key);
      expect(resolveContent(post)).toEqual({text: 'memoized body', locked: false});
    });
  });
});
