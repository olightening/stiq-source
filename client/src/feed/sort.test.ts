import {
  sortFeed,
  arrangeFeed,
  feedTags,
  parseRanking,
  encodeRanking,
  parseRankingEvent,
  rankingPostKind,
  DEFAULT_RANKING,
  type RankingConfig,
} from './sort';
import type {FeedItem} from './feed';
import {Kind} from '../nostr/events';

function item(
  id: string,
  createdAt: number,
  score: number,
  tags: string[] = [],
  voteTimestamps?: number[],
): FeedItem {
  return {id, authorPubkey: 'p', author: 'npub', kind: 1, identifier: id, content: id, tags, createdAt, score, voteTimestamps};
}

describe('feed sorting', () => {
  const now = 1_000_000;

  it('New orders by recency', () => {
    const items = [item('a', 100, 0), item('b', 300, 0), item('c', 200, 0)];
    expect(sortFeed(items, 'new', now).map(i => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('Top orders by score', () => {
    const items = [item('a', 1, 5), item('b', 1, 20), item('c', 1, 10)];
    expect(sortFeed(items, 'top', now).map(i => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('Hot lets a post with recent votes outrank an old high-score one (velocity model)', () => {
    // "old" earned 100 votes long ago; "fresh" is getting a couple of votes right now.
    const old = item('old', now - 1_000_000, 100, [], Array(100).fill(now - 1_000_000));
    const fresh = item('fresh', now, 2, [], [now, now]);
    expect(sortFeed([old, fresh], 'hot', now).map(i => i.id)).toEqual(['fresh', 'old']);
  });

  it('arrangeFeed filters by tag then sorts', () => {
    const items = [
      item('a', 100, 1, ['news']),
      item('b', 300, 1, ['local']),
      item('c', 200, 1, ['news']),
    ];
    expect(arrangeFeed(items, {tags: ['news'], sort: 'new'}, now).map(i => i.id)).toEqual(['c', 'a']);
  });

  it('arrangeFeed unions multiple selected tags (OR, not AND)', () => {
    const items = [
      item('both', 100, 1, ['news', 'local']),            // carries both → kept
      item('newsOnly', 200, 1, ['news']),                 // has 'news' → kept
      item('localOnly', 300, 1, ['local']),               // has 'local' → kept
      item('neither', 350, 1, ['sports']),                // has neither → dropped
      item('extra', 400, 1, ['news', 'local', 'sports']), // superset → kept
    ];
    // OR keeps every post carrying at least one selected tag; only 'neither' is dropped.
    expect(arrangeFeed(items, {tags: ['news', 'local'], sort: 'new'}, now).map(i => i.id)).toEqual([
      'extra',
      'localOnly',
      'newsOnly',
      'both',
    ]);
  });

  it('feedTags counts tags, most common first', () => {
    const items = [item('a', 1, 0, ['news', 'local']), item('b', 1, 0, ['news'])];
    expect(feedTags(items)).toEqual([
      {tag: 'news', count: 2},
      {tag: 'local', count: 1},
    ]);
  });
});

describe('own-post local order (sortAt) — audit #48 fuzz workaround', () => {
  const now = 1_000_000;

  it('New: an own post sorts by sortAt even when its wire createdAt is inverted', () => {
    // Two of MY posts made seconds apart. The wire createdAt is bucket-fuzzed and inverted here: the
    // LATER post ('second') drew a SMALLER created_at than the earlier one. sortAt records the true
    // local publish order, so 'second' still sorts on top.
    const first = {...item('first', 500, 0), sortAt: 1000};
    const second = {...item('second', 400, 0), sortAt: 2000}; // later, yet smaller createdAt
    expect(sortFeed([first, second], 'new', now).map(i => i.id)).toEqual(['second', 'first']);
    // Sanity: WITHOUT sortAt (i.e. another author), the inverted createdAt would put 'first' on top.
    expect(sortFeed([item('first', 500, 0), item('second', 400, 0)], 'new', now).map(i => i.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('New: sortAt (own just-made post) outranks a non-own post with a larger createdAt', () => {
    const mine = {...item('mine', 100, 0), sortAt: now}; // fuzzed OLD createdAt, but published NOW
    const theirs = item('theirs', 900, 0); // larger createdAt, no sortAt
    expect(sortFeed([mine, theirs], 'new', now).map(i => i.id)).toEqual(['mine', 'theirs']);
  });

  it('New: equal effective timestamps get a deterministic, input-order-independent id tie-break', () => {
    const x = item('aaa', 100, 0);
    const y = item('zzz', 100, 0);
    expect(sortFeed([x, y], 'new', now).map(i => i.id)).toEqual(['zzz', 'aaa']);
    expect(sortFeed([y, x], 'new', now).map(i => i.id)).toEqual(['zzz', 'aaa']); // input order irrelevant
  });

  it('Top: among equal scores, sortAt (then id) breaks the tie', () => {
    const p = {...item('p', 400, 5), sortAt: 2000};
    const q = {...item('q', 500, 5), sortAt: 1000}; // larger createdAt but earlier local order
    expect(sortFeed([p, q], 'top', now).map(i => i.id)).toEqual(['p', 'q']);
  });
});

describe('Rising ranking config', () => {
  const now = 1_000_000;

  it('round-trips through the compact wire and tolerates malformed input', () => {
    const cfg: RankingConfig = {
      halfLifeHours: 6,
      scoreWeight: 0.5,
      timeWeight: 2,
      timeHalfLifeHours: 12,
      voteWeight: 1.5,
      commentWeight: 1.5,
      commentHalfLifeHours: 9,
      lengthWeight: 0.25,
      typeWeights: {note: 1, article: 1.5},
    };
    expect(parseRanking(encodeRanking(cfg))).toEqual(cfg);
    expect(parseRanking({})).toEqual(DEFAULT_RANKING); // missing fields → defaults
    expect(parseRanking(null)).toBeNull();
    expect(parseRankingEvent('not json')).toBeNull();
  });

  it('parses the exact wire the organizer dashboard publishes (cross-layer contract)', () => {
    // Byte-for-byte the `content` of a kind-30078 event captured from a running dashboard
    // (issuer/organizer-server.mjs `sanitizeRanking` → `signConfig('stiq:ranking', …)`). The two
    // sides share no module, so this pin is what catches a key rename on either end.
    const published =
      '{"hl":2.5,"sw":0.1,"tw":1,"thl":6,"vw":1,"cw":1.5,"chl":6,"lw":0.5,"ty":{"n":1,"a":1.5}}';
    expect(parseRankingEvent(published)).toEqual({
      halfLifeHours: 2.5,
      scoreWeight: 0.1,
      timeWeight: 1,
      timeHalfLifeHours: 6,
      voteWeight: 1,
      commentWeight: 1.5,
      commentHalfLifeHours: 6,
      lengthWeight: 0.5,
      typeWeights: {note: 1, article: 1.5},
    });
  });

  it('a doc predating the new fields keeps its own values and defaults the rest (ship-dark)', () => {
    // Exactly what an organizer published before comments/length/type/time existed: {hl, sw} only.
    expect(parseRanking({hl: 6, sw: 0.5})).toEqual({
      ...DEFAULT_RANKING,
      halfLifeHours: 6,
      scoreWeight: 0.5,
    });
  });

  it('rejects malformed/negative fields per-field without dragging the others to defaults', () => {
    const parsed = parseRanking({hl: 6, cw: -1, lw: 'x', thl: 0, ty: {a: 2}});
    expect(parsed).toEqual({
      ...DEFAULT_RANKING,
      halfLifeHours: 6, // the one good field survives
      typeWeights: {note: 1, article: 2}, // partial ty → `n` defaults, `a` honoured
    });
    // A zero half-life would make λ infinite — must fall back, never divide by zero.
    expect(parsed?.timeHalfLifeHours).toBe(DEFAULT_RANKING.timeHalfLifeHours);
  });

  it('a high scoreWeight lets an old high-score post outrank a freshly-voted one', () => {
    const old = item('old', now - 1_000_000, 100, [], Array(100).fill(now - 1_000_000));
    const fresh = item('fresh', now, 2, [], [now, now]);
    // Default ranking → recent-vote velocity wins.
    expect(sortFeed([old, fresh], 'hot', now).map(i => i.id)).toEqual(['fresh', 'old']);
    // Crank up the score weight → the old high-score post wins instead.
    const scoreHeavy = {...DEFAULT_RANKING, scoreWeight: 1.0};
    expect(sortFeed([old, fresh], 'hot', now, scoreHeavy).map(i => i.id)).toEqual(['old', 'fresh']);
  });
});

describe('Rising: time is independent of votes', () => {
  const now = 1_000_000;

  it('a fresh post outranks an ancient one when NEITHER has a single vote', () => {
    // The whole point of divorcing time from likes. Before the freshness term, both of these
    // scored log(1+0)·sw = 0 and tied — nothing new could surface until someone voted on it.
    const stale = item('stale', now - 2_000_000, 0);
    const brandNew = item('brandNew', now, 0);
    expect(sortFeed([stale, brandNew], 'hot', now).map(i => i.id)).toEqual(['brandNew', 'stale']);
  });

  it('timeWeight 0 restores the old shape: no votes, no signal, no ordering', () => {
    const noTime = {...DEFAULT_RANKING, timeWeight: 0};
    const stale = item('stale', now - 2_000_000, 0);
    const brandNew = item('brandNew', now, 0);
    const scores = sortFeed([stale, brandNew], 'hot', now, noTime);
    expect(scores).toHaveLength(2); // both score exactly 0 — the pre-divorce tie
  });

  it('freshness decays on its OWN half-life, not the vote half-life', () => {
    // Vote half-life is irrelevant here: neither post has votes. Only timeHalfLifeHours moves them.
    const cfg = {...DEFAULT_RANKING, timeHalfLifeHours: 1, halfLifeHours: 999};
    const oneHourOld = item('oneHourOld', now - 3600, 0);
    const justNow = item('justNow', now, 0);
    expect(sortFeed([oneHourOld, justNow], 'hot', now, cfg).map(i => i.id)).toEqual([
      'justNow',
      'oneHourOld',
    ]);
  });

  it('a vote still lifts a post above an equally-fresh one (time and votes both count)', () => {
    const voted = item('voted', now, 1, [], [now]);
    const unvoted = item('unvoted', now, 0);
    expect(sortFeed([voted, unvoted], 'hot', now).map(i => i.id)).toEqual(['voted', 'unvoted']);
  });
});

describe('Rising: comments', () => {
  const now = 1_000_000;
  /** A post with `n` distinct commenters, all of whom commented at `at`. */
  const discussed = (id: string, n: number, at = now) => ({
    ...item(id, now, 0),
    commentCount: n,
    commentTimestamps: Array(n).fill(at),
  });
  const busy = discussed('busy', 50);
  const quiet = item('quiet', now, 0);

  it('are a no-op by default (commentWeight 0)', () => {
    // Equal freshness, no votes → 50 commenters must not move it under the default config.
    expect(sortFeed([quiet, busy], 'hot', now).map(i => i.id)).toEqual(['quiet', 'busy']);
  });

  it('lift a post once the organizer weights them', () => {
    const cfg = {...DEFAULT_RANKING, commentWeight: 1};
    expect(sortFeed([quiet, busy], 'hot', now, cfg).map(i => i.id)).toEqual(['busy', 'quiet']);
  });

  it('decay: a thread commented on RIGHT NOW beats a bigger, stale one', () => {
    // The reason comment velocity beats a flat count: a dead thread stops rising, however long it is.
    const cfg = {...DEFAULT_RANKING, commentWeight: 1};
    const deadBigThread = discussed('deadBigThread', 40, now - 1_000_000);
    const liveSmallThread = discussed('liveSmallThread', 3, now);
    expect(sortFeed([deadBigThread, liveSmallThread], 'hot', now, cfg).map(i => i.id)).toEqual([
      'liveSmallThread',
      'deadBigThread',
    ]);
  });

  it('decay on the COMMENT half-life, not the vote half-life', () => {
    // Neither post has a vote, so only commentHalfLifeHours can move them.
    const cfg = {...DEFAULT_RANKING, commentWeight: 1, commentHalfLifeHours: 1, halfLifeHours: 999};
    const hourOld = discussed('hourOld', 5, now - 3600);
    const justNow = discussed('justNow', 5, now);
    expect(sortFeed([hourOld, justNow], 'hot', now, cfg).map(i => i.id)).toEqual([
      'justNow',
      'hourOld',
    ]);
  });

  it('one person commenting 50 times cannot out-rank 5 real people', () => {
    // The dedup contract, from the ranking side: feed.ts hands us ONE timestamp per distinct
    // commenter, so a comment spree is one signal. `commentCount` stays the raw total for the card.
    const spree = {...item('spree', now, 0), commentCount: 50, commentTimestamps: [now]};
    const crowd = discussed('crowd', 5);
    const cfg = {...DEFAULT_RANKING, commentWeight: 1};
    expect(sortFeed([spree, crowd], 'hot', now, cfg).map(i => i.id)).toEqual(['crowd', 'spree']);
  });
});

describe('Rising: signals are commensurable (log-damped onto one scale)', () => {
  const now = 1_000_000;

  it('a landslide of votes cannot drown the other signals', () => {
    // The old model summed a RAW decayed vote count, so 200 recent votes = 200 points and every
    // other weight was rounding error. Log-damped, a 200-vote post is worth ~5.3 vote-units, so a
    // freshness/type/length edge can still matter.
    const landslide = item('landslide', now, 200, [], Array(200).fill(now));
    expect(Math.log(1 + 200)).toBeLessThan(6); // the whole point: 200 votes ≈ 5.3, not 200
    // An article with a 1.5x type weight and a decent length still loses to it — the multiplier is
    // proportional, not a licence to beat a genuinely popular post.
    const article = {...item('article', now, 0), kind: Kind.Article, content: 'word '.repeat(400)};
    const cfg = {...DEFAULT_RANKING, lengthWeight: 0.5, typeWeights: {note: 1, article: 1.5}};
    expect(sortFeed([article, landslide], 'hot', now, cfg).map(i => i.id)).toEqual([
      'landslide',
      'article',
    ]);
  });

  it('votes and comments contribute equally at equal weight', () => {
    const cfg = {...DEFAULT_RANKING, voteWeight: 1, commentWeight: 1};
    const tenVotes = item('tenVotes', now, 10, [], Array(10).fill(now));
    const tenCommenters = {
      ...item('tenCommenters', now, 0),
      commentCount: 10,
      commentTimestamps: Array(10).fill(now),
    };
    // Same velocity, same weight, same scale → only the score term (10 vs 0) separates them.
    const ranked = sortFeed([tenCommenters, tenVotes], 'hot', now, cfg).map(i => i.id);
    expect(ranked).toEqual(['tenVotes', 'tenCommenters']);
    // …and with scoreWeight 0 they tie exactly, proving the two terms are on one scale.
    const noScore = {...cfg, scoreWeight: 0};
    const a = sortFeed([tenCommenters, tenVotes], 'hot', now, noScore);
    const b = sortFeed([tenVotes, tenCommenters], 'hot', now, noScore);
    expect(a.map(i => i.id)).toEqual(['tenCommenters', 'tenVotes']); // stable: equal scores
    expect(b.map(i => i.id)).toEqual(['tenVotes', 'tenCommenters']);
  });

  it('voteWeight 0 takes votes out of the algorithm entirely', () => {
    const cfg = {...DEFAULT_RANKING, voteWeight: 0, scoreWeight: 0};
    const popular = item('popular', now - 100, 50, [], Array(50).fill(now));
    const fresher = item('fresher', now, 0);
    expect(sortFeed([popular, fresher], 'hot', now, cfg).map(i => i.id)).toEqual([
      'fresher',
      'popular',
    ]);
  });
});

describe('Rising: hostile input', () => {
  const now = 1_000_000;

  it('a future-dated post does NOT pin itself to the top forever', () => {
    // Nothing in the stack validates created_at (no relay hook, no client check), so a patched
    // client can date a post a year ahead. Under a max(0, age) clamp it would sit at freshness 1.0
    // — unbeatable — for that whole year. Decaying on DISTANCE makes the lie cost what it claims.
    const yearAhead = item('yearAhead', now + 31_536_000, 0);
    const honestNow = item('honestNow', now, 0);
    expect(sortFeed([yearAhead, honestNow], 'hot', now).map(i => i.id)).toEqual([
      'honestNow',
      'yearAhead',
    ]);
    // It is punished exactly as hard as an equally-distant past post — no better, no worse.
    const yearOld = item('yearOld', now - 31_536_000, 0);
    const ranked = sortFeed([yearAhead, yearOld, honestNow], 'hot', now).map(i => i.id);
    expect(ranked[0]).toBe('honestNow');
  });

  it('a negative score (only reachable by a hostile client) cannot produce NaN or a boost', () => {
    // There are no downvotes in Stiq, but a patched client can still emit '-' reactions. log(1+s)
    // is NaN for s <= -1, and ONE NaN in the comparator scrambles the entire feed order.
    const hated = item('hated', now, -50);
    const neutral = item('neutral', now, 0);
    const cfg = {...DEFAULT_RANKING, scoreWeight: 1};
    const ranked = sortFeed([hated, neutral], 'hot', now, cfg);
    expect(ranked.map(i => i.id)).toEqual(['hated', 'neutral']); // stable order, no NaN scramble
    // -50 must not read as +50: it contributes nothing, exactly like a score of 0.
    expect(sortFeed([item('a', now, -50), item('b', now, 0)], 'hot', now, cfg).map(i => i.id)).toEqual(
      ['a', 'b'],
    );
  });
});

describe('Rising: length', () => {
  const now = 1_000_000;
  const long = {...item('long', now, 0), content: 'word '.repeat(500)};
  const short = {...item('short', now, 0), content: 'hi'};

  it('is a no-op by default (lengthWeight 0)', () => {
    // Untouched order — length had no effect.
    expect(sortFeed([short, long], 'hot', now).map(i => i.id)).toEqual(['short', 'long']);
  });

  it('promotes longer prose once weighted', () => {
    const cfg = {...DEFAULT_RANKING, lengthWeight: 0.5};
    expect(sortFeed([short, long], 'hot', now, cfg).map(i => i.id)).toEqual(['long', 'short']);
  });

  it('measures PROSE only — a base64 picture blob is not a long post', () => {
    const cfg = {...DEFAULT_RANKING, lengthWeight: 0.5};
    // A two-word note carrying a huge inline picture must not out-length real writing.
    const picture = {...item('picture', now, 0), content: `look [[pic:${'A'.repeat(50_000)}]]`};
    const prose = {...item('prose', now, 0), content: 'word '.repeat(100)};
    expect(sortFeed([picture, prose], 'hot', now, cfg).map(i => i.id)).toEqual(['prose', 'picture']);
  });
});

describe('Rising: post type', () => {
  const now = 1_000_000;
  const article = {...item('article', now, 0), kind: Kind.Article};
  const note = item('note', now, 0);

  it('is a no-op by default (both weights 1.0)', () => {
    // Equal score → input order intact.
    expect(sortFeed([note, article], 'hot', now).map(i => i.id)).toEqual(['note', 'article']);
  });

  it('promotes articles over notes when the organizer weights them up', () => {
    const cfg = {...DEFAULT_RANKING, typeWeights: {note: 1, article: 1.5}};
    expect(sortFeed([note, article], 'hot', now, cfg).map(i => i.id)).toEqual(['article', 'note']);
  });

  it('scales the whole engagement sum, so a dead article does not beat a live note', () => {
    // The multiplier is proportional, not a flat bonus: 1.5x of nearly-nothing is still nothing.
    const cfg = {...DEFAULT_RANKING, typeWeights: {note: 1, article: 1.5}};
    const deadArticle = {...item('deadArticle', now - 2_000_000, 0), kind: Kind.Article};
    const liveNote = item('liveNote', now, 3, [], [now, now, now]);
    expect(sortFeed([deadArticle, liveNote], 'hot', now, cfg).map(i => i.id)).toEqual([
      'liveNote',
      'deadArticle',
    ]);
  });

  it('classifies by kind: only kind-30023 is an article', () => {
    expect(rankingPostKind(article)).toBe('article');
    expect(rankingPostKind(note)).toBe('note');
    expect(rankingPostKind({...item('voice', now, 0), kind: 1222})).toBe('note');
  });
});
