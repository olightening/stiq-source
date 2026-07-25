import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from './store';
import {Kind} from './events';
import {
  buildFeedFilter,
  buildLiveFeedFilter,
  buildReconcileFilter,
  SYNC_ROUTINE_WINDOW_SECONDS,
  createFeedAndDmPlan,
  decoyPool,
  groupChatSince,
  highWaterSince,
  selfProfileSince,
  FEED_KINDS,
  FIREHOSE_FEED_KINDS,
  TEXT_ONLY_FEED_KINDS,
} from './subscriptionPlan';
import {
  SUBSCRIBED_KINDS,
  KIND_VOICE_MESSAGE,
  KIND_VOICE_COMMENT,
  KIND_MEDIA_BLOB,
} from '../contracts';
import {D_IDENTITY_PROFILE} from '../profile/identityDoc';
import {clearRecentLogs, getRecentLogs} from '../util/log';

function postBy(sk: Uint8Array, createdAt: number): Event {
  return finalizeEvent({kind: Kind.Post, created_at: createdAt, tags: [], content: 'x'}, sk);
}

/** A NIP-29 group chat message (kind 9) tagged with its group id via `#h`. */
function groupChat(groupId: string, createdAt: number, kind = 9): Event {
  const sk = generateSecretKey();
  return finalizeEvent({kind, created_at: createdAt, tags: [['h', groupId]], content: 'gm'}, sk);
}

function giftWrap(createdAt: number): Event {
  const sk = generateSecretKey();
  return finalizeEvent({kind: Kind.GiftWrap, created_at: createdAt, tags: [], content: 'w'}, sk);
}

/** A private-space E2E key delivery (kind 30079) authored by `sk`. */
function spaceKeyDelivery(sk: Uint8Array, createdAt: number): Event {
  return finalizeEvent({kind: Kind.SpaceKeyDelivery, created_at: createdAt, tags: [], content: 'k'}, sk);
}

/** A self identity-enc profile carrier (kind-30078, d="identity-enc") authored by `sk`. */
function selfProfile(sk: Uint8Array, createdAt: number): Event {
  return finalizeEvent(
    {kind: Kind.AppData, created_at: createdAt, tags: [['d', D_IDENTITY_PROFILE]], content: 'ct'},
    sk,
  );
}

/** Deterministic sampler: take the first n elements (preserves order for assertions). */
const takeFirst = <T,>(arr: readonly T[], n: number): T[] => arr.slice(0, n);

/**
 * WHY THE FILTER ASSERTIONS BELOW NAME `FIREHOSE_FEED_KINDS`, NOT `FEED_KINDS`.
 *
 * These are flag-agnostic tests: they pin the SHAPE of the wire filters (limit vs since, cold vs
 * warm, the watermark clamp) and the decoy machinery — never which kinds the firehose happens to
 * want. They named `FEED_KINDS` only because the two were the same array until SCOPED_CHANNEL_SYNC
 * shipped; with the flag ON they diverge (1311 moved to the scoped `channels` sub), and the naming
 * became an accident that failed 12 of these tests for a reason none of them is about.
 *
 * `FIREHOSE_FEED_KINDS` is the module's own name for "what the unscoped firehose asks for", which is
 * what these filters are supposed to carry in EITHER flag state — so this file now passes on both,
 * and keeps testing what it was written to test. It is not a weaker assertion: it is still an exact
 * `toEqual` against a named export, so a filter that carried the wrong universe still fails here.
 * WHAT that export contains per flag state is pinned separately and deliberately, in
 * subscriptionPlan.channels.on.test.ts (committed config) and .channels.off.test.ts (mocked OFF) —
 * one fact, one home, asserted against both states rather than whichever one happens to ship.
 */

describe('highWaterSince', () => {
  it('is undefined for a cold cache and high-water minus overlap when warm', () => {
    const store = new InMemoryEventStore();
    expect(highWaterSince(store, [Kind.Post], 300)).toBeUndefined();
    store.save(postBy(generateSecretKey(), 10_000));
    expect(highWaterSince(store, [Kind.Post], 300)).toBe(9_700);
  });

  it('snapshotHighWater floors `since` when compaction blanked a kind (T16-S3), and never lowers it', () => {
    const store = new InMemoryEventStore();
    // Kind blanked by age-expiry: store has no rows, but the durable snapshot remembers 10_000.
    expect(highWaterSince(store, [Kind.Post], 300, {[Kind.Post]: 10_000})).toBe(9_700);
    // A live high-water NEWER than the snapshot wins (the floor only ever raises, never lowers).
    store.save(postBy(generateSecretKey(), 50_000));
    expect(highWaterSince(store, [Kind.Post], 300, {[Kind.Post]: 10_000})).toBe(49_700);
    // A snapshot floor NEWER than the live high-water raises `since` (defends the blanked-kind case).
    const quiet = new InMemoryEventStore();
    quiet.save(postBy(generateSecretKey(), 10_000));
    expect(highWaterSince(quiet, [Kind.Post], 300, {[Kind.Post]: 40_000})).toBe(39_700);
    // Omitting the snapshot is byte-identical to the default path.
    expect(highWaterSince(quiet, [Kind.Post], 300)).toBe(9_700);
  });

  it('buildFeedFilter honors the snapshotHighWater floor on a cache blanked for the firehose kinds', () => {
    const store = new InMemoryEventStore();
    // Cold store (no rows) → normally a cold `limit` filter; the snapshot floor turns it into a
    // bounded `since` window instead so the blanked kind isn't re-fetched from the cold horizon.
    expect(buildFeedFilter(store, 300, 50)).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 50});
    expect(buildFeedFilter(store, 300, 50, {[Kind.Post]: 100_000})).toEqual({
      kinds: FIREHOSE_FEED_KINDS,
      since: 99_700,
    });
  });
});

describe('decoyPool', () => {
  it('returns distinct feed authors excluding the user', () => {
    const store = new InMemoryEventStore();
    const a = generateSecretKey();
    const b = generateSecretKey();
    const me = generateSecretKey();
    store.save(postBy(a, 1));
    store.save(postBy(a, 2)); // same author twice -> distinct
    store.save(postBy(b, 3));
    store.save(postBy(me, 4));
    const pool = decoyPool(store, getPublicKey(me));
    expect(pool.sort()).toEqual([getPublicKey(a), getPublicKey(b)].sort());
  });
});

describe('groupChatSince', () => {
  it('is undefined for a group we hold no chat for (fresh device gets full history)', () => {
    const store = new InMemoryEventStore();
    expect(groupChatSince(store, 'groupA', 300)).toBeUndefined();
    // Chat for a DIFFERENT group must not seed groupA's since.
    store.save(groupChat('groupB', 10_000));
    expect(groupChatSince(store, 'groupA', 300)).toBeUndefined();
  });

  it('is the group-scoped high-water mark minus overlap when warm', () => {
    const store = new InMemoryEventStore();
    store.save(groupChat('groupA', 9_000, 9));
    store.save(groupChat('groupA', 10_000, 11)); // thread root, newer
    store.save(groupChat('groupA', 9_500, 12)); // reply, older
    expect(groupChatSince(store, 'groupA', 300)).toBe(9_700);
  });

  it('is per-group: a quiet group does not inherit an active group newer HWM', () => {
    const store = new InMemoryEventStore();
    store.save(groupChat('quiet', 5_000));
    store.save(groupChat('active', 50_000));
    // `quiet` must resolve from its own newest message, not `active`'s.
    expect(groupChatSince(store, 'quiet', 300)).toBe(4_700);
    expect(groupChatSince(store, 'active', 300)).toBe(49_700);
  });
});

describe('FEED_KINDS', () => {
  // Guard the multi-user guarantee: every kind a member can publish as visible community content
  // must be on the feed REQ, or other users never receive it (the relay stores it, but no one
  // asks). Regression test for the firehose that only requested [1,7,1111,1984].
  it('requests posts, articles, polls, poll votes, voice, and channels — not just notes', () => {
    expect(FEED_KINDS).toEqual(
      expect.arrayContaining([
        Kind.Post,
        Kind.Reaction,
        Kind.Comment,
        Kind.Report,
        Kind.Article,
        Kind.Poll,
        Kind.PollResponse,
        1222, // voice note
        1244, // voice reply
        Kind.LiveChat,
        Kind.LiveActivity,
      ]),
    );
  });
});

describe('TEXT_ONLY_FEED_KINDS (T10-S6 low-bandwidth degraded reconcile)', () => {
  it('excludes the media-heavy voice/picture kinds', () => {
    expect(TEXT_ONLY_FEED_KINDS).not.toContain(KIND_VOICE_MESSAGE); // 1222
    expect(TEXT_ONLY_FEED_KINDS).not.toContain(KIND_VOICE_COMMENT); // 1244
    expect(TEXT_ONLY_FEED_KINDS).not.toContain(KIND_MEDIA_BLOB); // 30351
  });

  // LiveChat (1311) is deliberately NOT in this list: whether it belongs to the text-only set is a
  // function of SCOPED_CHANNEL_SYNC (ON, it is not on the firehose at all, so it cannot be part of a
  // firehose reconcile's universe), and that fact is pinned per-state in
  // subscriptionPlan.channels.on.test.ts / .channels.off.test.ts. What belongs HERE is the part that
  // holds in both states: the low-bandwidth degradation drops MEDIA, never ordinary text content.
  it('keeps the text feed kinds: post, reaction, comment, report, article, polls, channel defs', () => {
    expect(TEXT_ONLY_FEED_KINDS).toEqual(
      expect.arrayContaining([
        Kind.Post,
        Kind.Reaction,
        Kind.Comment,
        Kind.Report,
        Kind.Article,
        Kind.Poll,
        Kind.PollResponse,
        Kind.LiveActivity,
      ]),
    );
  });

  it('is exactly the firehose kinds minus the excluded media kinds (a strict, derived subset)', () => {
    // Derived from FIREHOSE_FEED_KINDS, not FEED_KINDS: SYNC_LOW_BANDWIDTH and SCOPED_CHANNEL_SYNC
    // are independent, and this is what makes them COMPOSE — a low-bandwidth reconcile must still
    // respect channel scoping instead of quietly re-pulling 1311 unscoped through the back door.
    const excluded = new Set([KIND_VOICE_MESSAGE, KIND_VOICE_COMMENT, KIND_MEDIA_BLOB]);
    expect(TEXT_ONLY_FEED_KINDS).toEqual(FIREHOSE_FEED_KINDS.filter(k => !excluded.has(k)));
    // Every text kind is drawn from the firehose set — nothing new is invented.
    TEXT_ONLY_FEED_KINDS.forEach(k => expect(FIREHOSE_FEED_KINDS).toContain(k));
  });

  it('leaves FEED_KINDS itself UNCHANGED (still carries the voice kinds)', () => {
    expect(FEED_KINDS).toContain(KIND_VOICE_MESSAGE); // 1222
    expect(FEED_KINDS).toContain(KIND_VOICE_COMMENT); // 1244
  });
});

describe('createFeedAndDmPlan — allowed-kinds lockstep (C6)', () => {
  beforeEach(() => clearRecentLogs());
  const capsWarns = () => getRecentLogs().filter(e => e.level === 'warn' && e.scope === 'caps');

  it('WARNS (never drops a sub) when a subscribed kind is missing from the relay allow-list', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    // Advertise every subscribed kind EXCEPT the feed post kind → drift on kind 1.
    const allowed = SUBSCRIBED_KINDS.filter(k => k !== 1);
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, getAllowedKinds: () => allowed});
    const subs = plan();
    expect(subs.find(s => s.subId === 'feed')).toBeDefined(); // subs unchanged — never rejected
    const w = capsWarns();
    expect(w).toHaveLength(1);
    expect(w[0]!.msg).toContain('feed-plan');
    expect(w[0]!.msg).toContain('1');
  });

  it('stays silent at caps fallback (allowedKinds ⊇ SUBSCRIBED_KINDS) and when no getter is wired', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    // Fallback allow-list (client kind union) — superset of SUBSCRIBED_KINDS → no drift.
    createFeedAndDmPlan({store, getMyPubkey: () => me, getAllowedKinds: () => [...SUBSCRIBED_KINDS]})();
    createFeedAndDmPlan({store, getMyPubkey: () => me})(); // no getter at all
    expect(capsWarns()).toHaveLength(0);
  });
});

describe('createFeedAndDmPlan', () => {
  it('org-config sub fetches enough kind-30078 to cover all addressable organizer docs', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const org = getPublicKey(generateSecretKey());
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, getOrganizerPubkey: () => org});
    const cfg = plan().find(s => s.subId === 'org-config')!;
    expect(cfg).toBeDefined();
    expect(cfg.filter.authors).toEqual([org]);
    // Must be >1 so the moderator roster + limits + tag-policy all sync, not just the newest one.
    expect(cfg.filter.limit ?? 1).toBeGreaterThan(1);
  });


  it('cold cache: bounds the feed with limit and emits no DM sub when locked', () => {
    const store = new InMemoryEventStore();
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => undefined, feedLimit: 500});
    const subs = plan();
    expect(subs).toEqual([{subId: 'feed', filter: {kinds: FIREHOSE_FEED_KINDS, limit: 500}}]);
  });

  it('cold cache: the feed sub is ALWAYS present (never omitted) and defaults to COLD_FEED_LIMIT (50)', () => {
    const store = new InMemoryEventStore();
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => undefined});
    const subs = plan();
    // Bug #3/#4: no `omitFeed` escape hatch exists anymore — the standing live REQ always runs.
    expect(subs).toEqual([{subId: 'feed', filter: {kinds: FIREHOSE_FEED_KINDS, limit: 50}}]);
  });

  it('warm cache: feed sub stays limit-only, never `since`-bounded, even with a recent high-water mark', () => {
    const store = new InMemoryEventStore();
    store.save(postBy(generateSecretKey(), 10_000));
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => undefined, overlapSeconds: 300});
    const feed = plan().find(s => s.subId === 'feed')!;
    // The standing live REQ must never carry a `since`: khatru applies it to live-broadcast
    // events too, so a since-bounded live tail would silently drop back-dated blind posts,
    // delayed/resent posts, or clock-skewed events whose created_at falls below it.
    expect(feed.filter).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 50});
  });

  it('feed sub is limit-only regardless of how high the cached high-water mark is', () => {
    const store = new InMemoryEventStore();
    // A much larger high-water mark than any plausible overlap — if the feed sub derived
    // `since` from it, this would produce a `since` far in the future relative to now.
    store.save(postBy(generateSecretKey(), 9_999_999));
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => undefined, overlapSeconds: 1});
    const feed = plan().find(s => s.subId === 'feed')!;
    expect(feed.filter).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 50});
    expect(feed.filter.since).toBeUndefined();
  });

  it('buildFeedFilter (negentropy/backfill only) still applies since on a warm cache', () => {
    // buildFeedFilter is no longer used for the live feed sub, but it remains the
    // one-shot historical window for the NIP-77 reconciliation/fallback and getItems'
    // recent-delta window (App.tsx) — those queries terminate, so a `since` is safe there.
    const store = new InMemoryEventStore();
    store.save(postBy(generateSecretKey(), 10_000));
    expect(buildFeedFilter(store, 300)).toEqual({kinds: FIREHOSE_FEED_KINDS, since: 9_700});
  });

  it('enrolled but too few members: DM history stays private and is delivered in bounded pages', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4});
    const dm = plan().find(s => s.subId === 'dm')!;
    expect(dm.filter.kinds).toEqual([Kind.GiftWrap]);
    expect(dm.filter['#p']).toBeUndefined();
    expect(dm.filter.limit).toBe(25);
    expect(dm.pagination).toEqual({pageSize: 25, delayMs: 50});
  });

  it('enrolled with enough members: DM sub mixes the user with real decoys', () => {
    const store = new InMemoryEventStore();
    const authors = [generateSecretKey(), generateSecretKey(), generateSecretKey(), generateSecretKey()];
    authors.forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());
    const allowed = new Set([me, ...authors.map(getPublicKey)]);

    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      decoyCount: 4,
      sample: takeFirst,
    });
    const dm = plan().find(s => s.subId === 'dm')!;
    const ps = dm.filter['#p']!;
    expect(ps).toContain(me);
    expect(ps.length).toBeGreaterThanOrEqual(2);
    ps.forEach(p => expect(allowed.has(p)).toBe(true));
  });

  it('caches the decoy pool across reconnects, re-scanning only when a new post arrives', () => {
    const store = new InMemoryEventStore();
    const authors = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    authors.forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());

    // Count kind-1 (Post) scans: decoyPool queries {kinds:[Kind.Post]}.
    const realQuery = store.query.bind(store);
    let postScans = 0;
    jest.spyOn(store, 'query').mockImplementation(q => {
      if (q.kinds?.length === 1 && q.kinds[0] === Kind.Post) postScans++;
      return realQuery(q);
    });

    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4, sample: takeFirst});

    plan(); // first connect — scans once, caches keyed on the kind-1 version
    plan(); // reconnect, no new post — must serve from cache (no re-scan)
    expect(postScans).toBe(1);

    store.save(postBy(generateSecretKey(), 100)); // a new post bumps the kind-1 version
    plan(); // reconnect — cache is now stale, re-scans exactly once
    expect(postScans).toBe(2);

    plan(); // and back to cached
    expect(postScans).toBe(2);
  });

  it('cover-mixes the npub-scoped subs (dm #p, self-lists authors, space-keys #p) with one shared decoy set', () => {
    const store = new InMemoryEventStore();
    const authors = Array.from({length: 6}, () => generateSecretKey());
    authors.forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());

    // No `sample` override → the production deterministic keyed selection is exercised.
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4})();
    const dmP = subs.find(s => s.subId === 'dm')!.filter['#p']!;
    const listAuthors = subs.find(s => s.subId === 'self-lists')!.filter.authors!;
    const keyP = subs.find(s => s.subId === 'space-keys')!.filter['#p']!;

    expect(dmP).toContain(me); // the real npub is present…
    expect(dmP.length).toBe(5); // …but as one of me + 4 decoys, not alone
    // The SAME cover set backs all three subs, so intersecting them across each other (or the same
    // sub across reconnects) never isolates `me`.
    expect(new Set(listAuthors)).toEqual(new Set(dmP));
    expect(new Set(keyP)).toEqual(new Set(dmP));
    // Decoys are real, relay-plausible feed authors.
    const allowed = new Set([me, ...authors.map(getPublicKey)]);
    dmP.forEach(p => expect(allowed.has(p)).toBe(true));
  });

  it('keeps the decoy cover set STABLE across reconnects (defeats the intersection attack)', () => {
    const store = new InMemoryEventStore();
    Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4});

    const first = plan().find(s => s.subId === 'dm')!.filter['#p']!;
    const second = plan().find(s => s.subId === 'dm')!.filter['#p']!;
    const third = plan().find(s => s.subId === 'dm')!.filter['#p']!;
    // Identical set AND order across reconnects → the invariant is the whole set, not just `me`.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it('freezes the decoy candidate pool so the cover set stays STABLE as the live pool grows (S6)', () => {
    const store = new InMemoryEventStore();
    const initialAuthors = Array.from({length: 6}, () => generateSecretKey());
    initialAuthors.forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const initialPubkeys = new Set(initialAuthors.map(getPublicKey));
    const me = getPublicKey(generateSecretKey());

    // Isolated per-test frozen store (also exercises the persistence seam that survives restarts).
    const frozen = new Map<string, readonly string[]>();
    const frozenDecoyStore = {
      load: (k: string) => frozen.get(k),
      save: (k: string, d: readonly string[]) => {
        frozen.set(k, d);
      },
    };
    // No `sample` override → the production, drift-prone keyed ranking path is exercised.
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4, frozenDecoyStore});

    const before = plan().find(s => s.subId === 'dm')!.filter['#p']!;
    expect(before).toContain(me);
    expect(before.length).toBe(5); // me + 4 decoys

    // The live feed-author pool grows by many new authors across reconnects — enough that, ranking
    // over the LIVE set, at least one would almost certainly out-rank a current decoy and drift it.
    Array.from({length: 30}, () => generateSecretKey()).forEach((sk, i) =>
      store.save(postBy(sk, 100 + i)),
    );

    const after = plan().find(s => s.subId === 'dm')!.filter['#p']!;
    // Identical set AND order despite the pool growing 6→36 — membership is frozen, not re-ranked.
    expect(after).toEqual(before);
    // Deterministic proof no newly-arrived author leaked into the cover set: every decoy is still one
    // of the ORIGINAL frozen candidates (a new author could only appear if the live pool were re-ranked).
    after.filter(p => p !== me).forEach(p => expect(initialPubkeys.has(p)).toBe(true));
  });

  it('too few members: omits self-lists and leaves dm/space-keys unscoped — never pins `me`', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me})();

    // No decoy pool to hide among: rather than leak `authors:[me]`, self-lists is dropped.
    expect(subs.find(s => s.subId === 'self-lists')).toBeUndefined();
    expect(subs.find(s => s.subId === 'dm')!.filter['#p']).toBeUndefined();
    const keys = subs.find(s => s.subId === 'space-keys')!;
    expect(keys.filter['#p']).toBeUndefined(); // unscoped firehose, never `#p:[me]`
    expect(keys.filter.kinds).toEqual([Kind.SpaceKeyDelivery]);
    // heaviness-audit #6: a true cold cache (no `since`, no cover → no `#p`) used to leave this
    // filter as bare `{kinds:[30079]}` — the one genuinely unbounded cold REQ in the plan. It now
    // gets the SAME cold-fallback `limit` as its sibling cold REQs (feed/self-profile default 50).
    expect(keys.filter.since).toBeUndefined();
    expect(keys.filter.limit).toBe(50);
  });

  it('space-keys: a warm cache (prior delivery already held) since-bounds WITHOUT adding a limit, even absent decoy cover', () => {
    const store = new InMemoryEventStore();
    const meSk = generateSecretKey();
    const me = getPublicKey(meSk);
    store.save(spaceKeyDelivery(meSk, 50_000)); // a previously-received delivery — warm high-water
    const keys = createFeedAndDmPlan({store, getMyPubkey: () => me, overlapSeconds: 300})()
      .find(s => s.subId === 'space-keys')!;
    expect(keys.filter.since).toBe(49_700); // 50_000 - overlap
    expect(keys.filter.limit).toBeUndefined(); // since-bounded already — the cold-fallback never fires
    expect(keys.filter['#p']).toBeUndefined(); // still too few members for decoy cover
  });

  it('space-keys: decoy cover bounds by #p WITHOUT adding a limit, even with no prior delivery cached', () => {
    const store = new InMemoryEventStore();
    Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());
    const keys = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4})()
      .find(s => s.subId === 'space-keys')!;
    expect(keys.filter.since).toBeUndefined(); // no prior delivery cached yet
    expect(keys.filter['#p']).toBeDefined(); // scoped by the shared decoy cover set instead
    expect(keys.filter.limit).toBeUndefined(); // #p already bounds it — the cold-fallback never fires
  });

  it('DM since reaches back past the NIP-17 timestamp-fuzz window', () => {
    const store = new InMemoryEventStore();
    const now = 1_000_000;
    store.save(giftWrap(now));
    const me = getPublicKey(generateSecretKey());
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me, overlapSeconds: 300});
    const dm = plan().find(s => s.subId === 'dm')!;
    // since = now - (overlap 300 + 2 days). Must be well below `now`.
    expect(dm.filter.since).toBe(now - (300 + 2 * 24 * 60 * 60));
  });

  // ── Self identity-enc profile sub (multi-device convergence) ────────────────────────────────────
  // The carrier that lets a second device of the SAME identity RECEIVE (and adopt) our encrypted
  // self-profile. Anonymity: `authors:[me]` ALONE would reveal our npub on the connection blind
  // posts ride, so warm = the shared decoy cover set (me is one of k+1), cold = unscoped-by-author
  // firehose. NEVER `authors:[me]` alone.

  it('warm: self-profile sub is author-scoped to the shared cover set (me + decoys, never me alone) + #d + kind 30078', () => {
    const store = new InMemoryEventStore();
    Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());

    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4})();
    const sp = subs.find(s => s.subId === 'self-profile')!;
    expect(sp).toBeDefined();
    expect(sp.filter.kinds).toEqual([Kind.AppData]); // kind 30078
    expect(sp.filter['#d']).toEqual([D_IDENTITY_PROFILE]); // bounded to identity-enc, not all 30078

    const authors = sp.filter.authors!;
    expect(authors).toContain(me); // the real npub is present…
    expect(authors.length).toBe(5); // …as one of me + 4 decoys, never `authors:[me]` alone
    // SAME shared cover set as the DM sub → intersecting the two (or reconnects) never isolates `me`.
    const dmP = subs.find(s => s.subId === 'dm')!.filter['#p']!;
    expect(new Set(authors)).toEqual(new Set(dmP));
    expect(sp.filter.limit).toBeUndefined(); // no unscoped firehose limit on the warm path
  });

  it('warm: since-bounds off our own last identity-enc profile so a reconnect does not re-stream', () => {
    const store = new InMemoryEventStore();
    Array.from({length: 4}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const meSk = generateSecretKey();
    const me = getPublicKey(meSk);
    store.save(selfProfile(meSk, 50_000)); // our own profile already held
    const sp = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4, overlapSeconds: 300})()
      .find(s => s.subId === 'self-profile')!;
    expect(sp.filter.since).toBe(49_700); // 50_000 - overlap
    expect(sp.filter.authors).toContain(me);
  });

  it('cold (no cover): self-profile sub is an UNSCOPED-by-author firehose bounded by limit — never authors:[me]', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me, selfProfileLimit: 500})();
    const sp = subs.find(s => s.subId === 'self-profile')!;
    expect(sp).toBeDefined();
    expect(sp.filter.kinds).toEqual([Kind.AppData]); // kind 30078
    expect(sp.filter['#d']).toEqual([D_IDENTITY_PROFILE]);
    expect(sp.filter.authors).toBeUndefined(); // NO author scope at all — leaks nothing about `me`
    expect(sp.filter.limit).toBe(500);
    expect(sp.filter.since).toBeUndefined();
  });

  // ── heaviness-audit #4: the self-profile cold sub used to firehose up to 500 events (10x the
  //    feed's own COLD_FEED_LIMIT) as a single unpaced burst. It is now bounded to the feed's own
  //    cold-sync limit by default AND carries the same `pagination` treatment as the `dm` sub, so
  //    discovery of our own doc is still exhaustive (paging keeps going until a short page), just
  //    paced across ticks instead of delivered as one synchronous verify/insert storm. ──────────────

  it('cold (no cover) DEFAULT: page size is lowered to COLD_FEED_LIMIT (50), not the old 500, and the sub is paginated', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me})(); // no override — production default
    const sp = subs.find(s => s.subId === 'self-profile')!;
    expect(sp.filter.limit).toBe(50); // was 500 — no longer the largest burst in the cold plan
    expect(sp.pagination).toEqual({pageSize: 50, delayMs: 50});
  });

  it('warm: self-profile sub ALSO carries the pagination treatment (mirrors the dm sub exactly)', () => {
    const store = new InMemoryEventStore();
    Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => me, decoyCount: 4})();
    const sp = subs.find(s => s.subId === 'self-profile')!;
    expect(sp.pagination).toEqual({pageSize: 50, delayMs: 50});
    expect(sp.filter.limit).toBeUndefined(); // the warm filter itself still carries no bare `limit`
  });

  it('selfProfileLimit and selfProfilePageDelayMs override the pagination page size/delay together', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    const subs = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      selfProfileLimit: 10,
      selfProfilePageDelayMs: 5,
    })();
    const sp = subs.find(s => s.subId === 'self-profile')!;
    expect(sp.filter.limit).toBe(10);
    expect(sp.pagination).toEqual({pageSize: 10, delayMs: 5});
  });

  it('locked (no pubkey): no self-profile sub', () => {
    const store = new InMemoryEventStore();
    const subs = createFeedAndDmPlan({store, getMyPubkey: () => undefined})();
    expect(subs.find(s => s.subId === 'self-profile')).toBeUndefined();
  });
});

describe('buildLiveFeedFilter', () => {
  it('is always limit-only, defaulting to COLD_FEED_LIMIT (50)', () => {
    expect(buildLiveFeedFilter()).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 50});
  });

  it('honors a custom feedLimit and never adds a since', () => {
    const filter = buildLiveFeedFilter(500);
    expect(filter).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 500});
    expect(filter.since).toBeUndefined();
  });
});

describe('selfProfileSince', () => {
  it('is undefined when we hold no OWN identity-enc profile (a fresh device pulls the full profile)', () => {
    const store = new InMemoryEventStore();
    const me = getPublicKey(generateSecretKey());
    expect(selfProfileSince(store, me, 300)).toBeUndefined();
    // A DECOY's identity-enc profile (different author) must NOT seed our since — only our own counts.
    store.save(selfProfile(generateSecretKey(), 40_000));
    expect(selfProfileSince(store, me, 300)).toBeUndefined();
  });

  it('is our own newest identity-enc created_at minus overlap when held', () => {
    const store = new InMemoryEventStore();
    const meSk = generateSecretKey();
    const me = getPublicKey(meSk);
    store.save(selfProfile(meSk, 9_000));
    store.save(selfProfile(meSk, 10_000)); // newer wins
    expect(selfProfileSince(store, me, 300)).toBe(9_700);
  });
});

describe('buildReconcileFilter (T10 watermark reconcile window)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cold empty store, no watermark → bounded by limit (no since), identical to buildFeedFilter cold', () => {
    const store = new InMemoryEventStore();
    const filter = buildReconcileFilter(store, {feedLimit: 500});
    expect(filter).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 500});
    expect(filter.since).toBeUndefined();
    // Regression firewall: buildFeedFilter cold output is byte-unchanged for the same store state.
    expect(buildFeedFilter(store, 300, 500)).toEqual({kinds: FIREHOSE_FEED_KINDS, limit: 500});
  });

  it('warm store, no watermark → since = highWaterSince, identical to buildFeedFilter warm', () => {
    const store = new InMemoryEventStore();
    store.save(postBy(generateSecretKey(), 10_000));
    const filter = buildReconcileFilter(store, {overlapSeconds: 300});
    expect(filter).toEqual({kinds: FIREHOSE_FEED_KINDS, since: 9_700});
    expect(filter.limit).toBeUndefined();
    // buildFeedFilter warm output is byte-unchanged and matches the no-watermark reconcile window.
    expect(buildFeedFilter(store, 300)).toEqual({kinds: FIREHOSE_FEED_KINDS, since: 9_700});
  });

  it('watermark present but OLDER than the window → since clamped up to the rolling window floor', () => {
    const store = new InMemoryEventStore();
    const nowSec = 2_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);
    const windowFloor = nowSec - SYNC_ROUTINE_WINDOW_SECONDS;
    // A watermark far older than the window would reach back the whole backlog without the clamp.
    const filter = buildReconcileFilter(store, {watermarkSince: 1_000_000, overlapSeconds: 300});
    expect(filter.since).toBe(windowFloor);
    expect(filter.limit).toBeUndefined();
  });

  it('watermark present and RECENT (within window) → since = watermarkSince - overlap, not clamped', () => {
    const store = new InMemoryEventStore();
    const nowSec = 2_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);
    const watermarkSince = nowSec - 10_000; // well inside the one-week window
    const filter = buildReconcileFilter(store, {watermarkSince, overlapSeconds: 300});
    expect(filter.since).toBe(watermarkSince - 300);
    expect(filter.limit).toBeUndefined();
  });

  it('never sets both since and limit across cold / warm / watermarked states', () => {
    const cold = new InMemoryEventStore();
    const warm = new InMemoryEventStore();
    warm.save(postBy(generateSecretKey(), 10_000));
    const cases = [
      buildReconcileFilter(cold, {feedLimit: 500}),
      buildReconcileFilter(warm, {overlapSeconds: 300}),
      buildReconcileFilter(warm, {watermarkSince: 9_000_000, overlapSeconds: 300}),
      buildReconcileFilter(cold, {watermarkSince: 9_000_000, overlapSeconds: 300}),
    ];
    for (const f of cases) {
      expect(f.since !== undefined && f.limit !== undefined).toBe(false);
    }
  });

  it('a watermark forces a since even on a cold store (never falls back to limit)', () => {
    const store = new InMemoryEventStore();
    const nowSec = 2_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);
    const watermarkSince = nowSec - 5_000;
    const filter = buildReconcileFilter(store, {watermarkSince, overlapSeconds: 300});
    expect(filter.since).toBe(watermarkSince - 300); // hw is undefined → falls back to 0, watermark wins
    expect(filter.limit).toBeUndefined();
  });

  // ── T10-S6 kinds override: the low-bandwidth path passes TEXT_ONLY_FEED_KINDS so the wire filter
  //    and getItems agree on the identical kind universe. ──
  it('kinds override → the filter carries EXACTLY the passed kind set (default stays the firehose set)', () => {
    const store = new InMemoryEventStore();
    const cold = buildReconcileFilter(store, {feedLimit: 50});
    expect(cold.kinds).toEqual(FIREHOSE_FEED_KINDS); // default is unchanged

    const textOnly = buildReconcileFilter(store, {feedLimit: 50, kinds: TEXT_ONLY_FEED_KINDS});
    expect(textOnly.kinds).toEqual(TEXT_ONLY_FEED_KINDS);
    expect(textOnly.kinds).not.toContain(KIND_VOICE_MESSAGE);
  });

  it('kinds override drives the high-water computation too (since is scoped to the passed kinds)', () => {
    const store = new InMemoryEventStore();
    // A voice event is newer than any text event; scoping to TEXT_ONLY_FEED_KINDS must IGNORE it so
    // the reconcile since reflects only the text high-water — keeping both sides on the same universe.
    store.save(
      finalizeEvent(
        {kind: KIND_VOICE_MESSAGE, created_at: 50_000, tags: [], content: 'v'},
        generateSecretKey(),
      ),
    );
    store.save(postBy(generateSecretKey(), 10_000)); // text high-water

    const full = buildReconcileFilter(store, {overlapSeconds: 300}); // includes voice → since off 50_000
    expect(full.since).toBe(49_700);

    const textOnly = buildReconcileFilter(store, {overlapSeconds: 300, kinds: TEXT_ONLY_FEED_KINDS});
    expect(textOnly.since).toBe(9_700); // 10_000 - 300, the TEXT high-water (voice ignored)
  });
});
