import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {filterFeed, buildModeratedFeed} from './filter';
import * as moderatorsModule from './moderators';
import {InMemoryEventStore} from '../nostr/store';
import {toBlindEvent, assembleBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {mintGroupKey} from '../channels/groupCrypto';
import {setActiveCommunityKey} from '../blind/communityKey';
import {clearAuthorCache} from '../blind/identity';
import type {Token} from '../blind/wallet';

function post(id: string, createdAt: number): Event {
  return {id, pubkey: 'author', created_at: createdAt, kind: 1, tags: [], content: id, sig: 's'};
}

function report(pubkey: string, postId: string, createdAt = 100): Event {
  return {
    id: `r-${postId}`,
    pubkey,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', postId, 'other']],
    content: '',
    sig: 's',
  };
}

const modPub = getPublicKey(generateSecretKey());
const modNpub = nip19.npubEncode(modPub);
const mods = [modNpub];

describe('filterFeed', () => {
  it('hides a post reported by a moderator and logs it with attribution', () => {
    const posts = [post('A', 300), post('B', 200), post('C', 100)];
    const reports = [report(modPub, 'B')];

    const {visible, moderationLog} = filterFeed(posts, reports, mods);

    expect(visible.map(p => p.id)).toEqual(['A', 'C']); // newest first, B removed
    expect(moderationLog).toHaveLength(1);
    expect(moderationLog[0]!.post.id).toBe('B');
    expect(moderationLog[0]!.moderatorNpub).toBe(modNpub);
  });

  it('ignores reports from non-moderators', () => {
    const stranger = getPublicKey(generateSecretKey());
    const {visible, moderationLog} = filterFeed([post('A', 1)], [report(stranger, 'A')], mods);
    expect(visible.map(p => p.id)).toEqual(['A']);
    expect(moderationLog).toHaveLength(0);
  });

  it('ignores reports that reference an unknown post', () => {
    const {visible} = filterFeed([post('A', 1)], [report(modPub, 'ghost')], mods);
    expect(visible.map(p => p.id)).toEqual(['A']);
  });

  it('attributes a post to the earliest moderator report', () => {
    const mod2 = getPublicKey(generateSecretKey());
    const mods2 = [modNpub, nip19.npubEncode(mod2)];
    const reports = [report(mod2, 'A', 500), report(modPub, 'A', 200)];
    const {moderationLog} = filterFeed([post('A', 1)], reports, mods2);
    expect(moderationLog[0]!.moderatorPubkey).toBe(modPub); // earliest (created_at 200)
  });
});

function restore(pubkey: string, postId: string, createdAt: number): Event {
  return {
    id: `restore-${postId}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', postId], ['stiq-action', 'restore']],
    content: '',
    sig: 's',
  };
}

function muteList(pubkey: string, muted: string[], createdAt: number): Event {
  return {
    id: `mute-${pubkey}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 10000,
    tags: muted.map(p => ['p', p]),
    content: '',
    sig: 's',
  };
}

describe('restore (un-hide)', () => {
  it('a later restore makes a hidden post visible again', () => {
    const reports = [report(modPub, 'A', 100), restore(modPub, 'A', 200)];
    const {visible, moderationLog} = filterFeed([post('A', 1)], reports, mods);
    expect(visible.map(p => p.id)).toEqual(['A']);
    expect(moderationLog).toHaveLength(0);
  });

  it('a hide after a restore hides it again (latest action wins)', () => {
    const reports = [report(modPub, 'A', 100), restore(modPub, 'A', 200), report(modPub, 'A', 300)];
    const {visible, moderationLog} = filterFeed([post('A', 1)], reports, mods);
    expect(visible).toHaveLength(0);
    expect(moderationLog).toHaveLength(1);
  });
});

describe('global user-hide', () => {
  it('hides posts authored by a moderator-muted user', () => {
    const store = new InMemoryEventStore();
    const spam = {...post('S', 50), pubkey: 'spammer'};
    store.save(spam);
    store.save(muteList(modPub, ['spammer'], 100));
    const {visible, moderationLog} = buildModeratedFeed(store, mods);
    expect(visible.map(p => p.id)).toEqual([]);
    expect(moderationLog.map(e => e.post.id)).toEqual(['S']);
    expect(moderationLog[0]!.moderatorPubkey).toBe(modPub);
  });

  it('ignores mute lists from non-moderators', () => {
    const store = new InMemoryEventStore();
    store.save({...post('S', 50), pubkey: 'spammer'});
    store.save(muteList('random-user', ['spammer'], 100));
    const {visible} = buildModeratedFeed(store, mods);
    expect(visible.map(p => p.id)).toEqual(['S']);
  });
});

describe('buildModeratedFeed', () => {
  it('derives the feed from the cache', () => {
    const store = new InMemoryEventStore();
    store.save(post('A', 300));
    store.save(post('B', 200));
    store.save(report(modPub, 'B'));

    const {visible, moderationLog} = buildModeratedFeed(store, mods);
    expect(visible.map(p => p.id)).toEqual(['A']);
    expect(moderationLog.map(e => e.post.id)).toEqual(['B']);
  });

  it('splits hybrid kind-1 stiq-comment notes into `stiqComments`, out of `visible`/`moderationLog` (C3 refactor — one combined query instead of a separate Post-kind re-query in feed.ts)', () => {
    const store = new InMemoryEventStore();
    store.save(post('A', 300));
    const comment: Event = {
      id: 'C1',
      pubkey: 'author2',
      created_at: 250,
      kind: 1,
      tags: [['e', 'A', '', 'root'], ['t', 'stiq-comment']],
      content: 'reply',
      sig: 's',
    };
    store.save(comment);

    const feed = buildModeratedFeed(store, mods);
    expect(feed.visible.map(p => p.id)).toEqual(['A']);
    expect(feed.moderationLog).toHaveLength(0);
    expect(feed.stiqComments.map(c => c.id)).toEqual(['C1']);
  });
});

describe('buildModeratedFeed — unattributable blind posts (anonymization enforcement)', () => {
  const communityKey = mintGroupKey();
  // Real holder-bound keypair so the attributed post's signer pubkey (== hex(Q)) matches its
  // attribution binding and decrypts back to the author (P3).
  const {q: tokenSecret, Q: tokenPub} = newTokenKeypair();
  const token: Token = {token: tokenPub, sig: Uint8Array.of(2), secret: tokenSecret};
  const authorSk = generateSecretKey();

  afterEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(null);
  });

  it('drops an unattributable blind post, keeps attributed + plain ones', () => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
    const store = new InMemoryEventStore();
    const plain = post('P', 300);
    const attributed = toBlindEvent(
      {kind: 1, created_at: 200, tags: [], content: 'legit'},
      [token],
      authorSk,
      communityKey,
      {name: 'alice'},
    );
    // A DISTINCT token — real blind posts each spend their own fresh token; reusing one Q across two
    // posts is itself a P4 double-spend (now hidden by the detector), which would confound this test's
    // subject (the unattributable-attribution filter). This post is unattributable because its
    // attribution is 'garbage', not because of any token collision.
    const kp2 = newTokenKeypair();
    const unattr = assembleBlindEvent(
      {kind: 1, created_at: 100, tags: [], content: 'spoof'},
      [{token: kp2.Q, sig: Uint8Array.of(2), secret: kp2.q}],
      'garbage',
    );
    store.save(plain);
    store.save(attributed);
    store.save(unattr);
    const {visible} = buildModeratedFeed(store, mods);
    const ids = visible.map(p => p.id);
    expect(ids).toContain('P');
    expect(ids).toContain(attributed.id);
    expect(ids).not.toContain(unattr.id);
  });

  it('keeps the unattributable post when the community key is unloaded (defer)', () => {
    clearAuthorCache();
    setActiveCommunityKey(null);
    const store = new InMemoryEventStore();
    const unattr = assembleBlindEvent({kind: 1, created_at: 100, tags: [], content: 'spoof'}, [token], 'garbage');
    store.save(unattr);
    const {visible} = buildModeratedFeed(store, mods);
    expect(visible.map(p => p.id)).toContain(unattr.id);
  });
});

describe('buildModeratedFeed — P4 holder double-spend', () => {
  // A tiny helper for a blind post spending `tokens` (tokens[0] becomes the signer, so its pubkey ==
  // hex(Q0)). The community key is deliberately UNLOADED for these tests so isUnattributedBlindPost
  // defers (returns false) and the ONLY thing that can drop a post is the double-spend detector —
  // isolating the P4 filter from the anonymization-enforcement filter that runs just before it.
  function blindNote(tokens: Token[], createdAt: number, content: string): Event {
    return assembleBlindEvent({kind: 1, created_at: createdAt, tags: [], content}, tokens, 'attr');
  }
  const mkToken = (): Token => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: Uint8Array.of(1), secret: q};
  };

  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(null); // defer attribution judging so only the double-spend filter acts
  });
  afterEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(null);
  });

  it('drops the double-spend loser and keeps the winner (reused signing token 0)', () => {
    // Both notes are signed by the SAME token 0 (q0), so both carry event.pubkey == hex(Q0) and both
    // VALIDLY spend token 0 — a holder reusing one token across two distinct posts. The blind-post
    // timestamp fuzz quantizes to 180s buckets, so created_at 100 (→ ≤100) is deterministically
    // earlier than 100000 (→ ≥99900): the earlier note wins, the later one is the dropped loser.
    const token = mkToken();
    const winner = blindNote([token], 100, 'first');
    const loser = blindNote([token], 100000, 'second');
    const store = new InMemoryEventStore();
    store.save(winner);
    store.save(loser);
    const ids = buildModeratedFeed(store, mods).visible.map(p => p.id);
    expect(ids).toContain(winner.id);
    expect(ids).not.toContain(loser.id);
  });

  it('detects a double-spend of a SECONDARY (holder-proof) token across distinct-key posts', () => {
    // The realistic reuse: two posts signed by DIFFERENT throwaway keys (distinct token 0) that each
    // also spend the SAME token at index 1, carrying a fresh holder proof bound to their own pubkey.
    // Only the shared secondary token collides — this exercises the cryptographic spend-proof path
    // (safeVerifySpend), not just the pubkey==Q0 check — and the later post is dropped.
    const shared = mkToken();
    const winner = blindNote([mkToken(), shared], 100, 'a');
    const loser = blindNote([mkToken(), shared], 100000, 'b');
    const store = new InMemoryEventStore();
    store.save(winner);
    store.save(loser);
    const ids = buildModeratedFeed(store, mods).visible.map(p => p.id);
    expect(ids).toContain(winner.id);
    expect(ids).not.toContain(loser.id);
  });

  it('keeps two posts that each spend a DISTINCT token (no collision)', () => {
    // Control: no token is reused, so detectDoubleSpends finds no conflict and BOTH posts stay — the
    // detector never hides an honest single spend.
    const p1 = blindNote([mkToken()], 100, 'one');
    const p2 = blindNote([mkToken()], 100000, 'two');
    const store = new InMemoryEventStore();
    store.save(p1);
    store.save(p2);
    const ids = buildModeratedFeed(store, mods).visible.map(p => p.id);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
  });
});

describe('moderatorReportsByPost roster-decode memoization (finding #42)', () => {
  it('builds the decoded moderator set at most once per rebuild, not once per report', () => {
    // A UNIQUE roster (never decoded before) so the module-level memo starts cold for this identity.
    const uniqueMod = getPublicKey(generateSecretKey());
    const uniqueRoster = [nip19.npubEncode(uniqueMod)];
    // Many reports from that same moderator — the pre-fix code rebuilt the decoded set once PER report
    // (isModerator(pubkey, npubs) re-decodes the entire roster on every call).
    const reports = Array.from({length: 25}, (_, i) => report(uniqueMod, `P${i}`, 100 + i));

    const spy = jest.spyOn(moderatorsModule, 'moderatorPubkeySet');
    filterFeed([], reports, uniqueRoster);
    // Hoisted + memoized: the decoded set is built at most once for this rebuild — NOT 25 times.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    // Correctness is preserved: all 25 reports are still recognised as moderator hides.
    const {moderationLog} = filterFeed(
      reports.map((_, i) => post(`P${i}`, 100 + i)),
      reports,
      uniqueRoster,
    );
    expect(moderationLog).toHaveLength(25);
    spy.mockRestore();
  });
});
