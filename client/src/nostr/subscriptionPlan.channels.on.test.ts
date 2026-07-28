// SCOPED_CHANNEL_SYNC (config.ts) — bug 8 (membership-scoped channel sync), ON.
//
// ⚠️ THIS FILE DELIBERATELY DOES NOT MOCK THE CONFIG. The flag shipped dark and was flipped ON on
// 2026-07-15 once the relay precondition was verified, so ON is now the COMMITTED default and this
// file reads it straight from config.ts. That is the point: every assertion below runs against the
// kind sets and subscriptions a real build actually emits, not against a mock's idea of them. The
// tripwire in the first describe block is what makes that explicit and catches an accidental flip.
// The OFF path (the supported rollback) is still covered — it moved to a mock in
// subscriptionPlan.channels.off.test.ts, the exact mirror image of the arrangement that held while
// the flag was dark.
//
// Separate files rather than jest.resetModules() inside one: subscriptionPlan derives module-level
// constants (FIREHOSE_FEED_KINDS, TEXT_ONLY_FEED_KINDS) from the flag at import time, so the flag
// must be settled before the module is first evaluated. (resetModules + dynamic require also
// desyncs module instances — see BUGROUND_STATE, Slot E.)

/**
 * Bug 8 — kind 1311 (NIP-53 channel messages) off the unscoped firehose and onto a membership-scoped
 * `channels` subscription with a decoy cover set.
 *
 * What these pin, and why each matters:
 *   • 1311 leaves the firehose kind set (that IS the bandwidth fix) while 30311 STAYS (that is
 *     channel discovery — a member must be able to find channels they have not joined).
 *   • The cover set hides the member's real channels among decoys, is stable across reconnects, and
 *     is drawn from the FROZEN candidate pool — the same three invariants the DM sub already has.
 *   • Below the decoy floor it degrades to an UNSCOPED firehose, NEVER to a bare `#a: [my channels]`.
 *     This is the requirement that must never regress: the fallback may cost bandwidth, but it must
 *     not hand the relay exact membership.
 *   • The standing sub is LIMIT-ONLY. A `since` on a standing REQ silently drops live events under
 *     khatru (see buildLiveFeedFilter) — scoping WHO we ask about must not change WHETHER we're told.
 */
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {
  createFeedAndDmPlan,
  buildLiveFeedFilter,
  buildFeedFilter,
  buildReconcileFilter,
  buildChannelChatFilter,
  buildCoverSetFor,
  buildOpenChatFilters,
  channelChatSince,
  FIREHOSE_FEED_KINDS,
  TEXT_ONLY_FEED_KINDS,
  FEED_KINDS,
} from './subscriptionPlan';
import {SCOPED_CHANNEL_SYNC} from '../config';
import {InMemoryEventStore} from './store';
import {Kind} from './events';

const takeFirst = <T,>(arr: readonly T[], n: number): T[] => arr.slice(0, n);

function postBy(sk: Uint8Array, createdAt: number): Event {
  return finalizeEvent({kind: Kind.Post, created_at: createdAt, tags: [], content: 'x'}, sk);
}

/**
 * A deterministic, well-spread hex string from a seed — a stand-in for a real owner pubkey / `d`.
 * Not cryptographic; it only has to be distinct and evenly distributed, like the real values are.
 */
function hex(seed: string, chars: number): string {
  let h = 0x811c9dc5 >>> 0;
  let out = '';
  while (out.length < chars) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + out.length;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, chars);
}

/**
 * A REALISTIC channel coordinate — `30311:<distinct 64-hex owner>:<fixed-length d>` — deterministic
 * in `n` so these tests can never flake.
 *
 * Both properties are load-bearing, and a naive fixture gets this wrong in a way that silently
 * weakens the S6 test. An earlier version used one shared owner and `d` values of `c2`…`c6` vs
 * `c100`…`c129`. buildCoverSetFor ranks candidates on fnv1a(me + ':' + coordinate), and fnv1a
 * disperses poorly when its inputs share a long prefix and diverge only in a short suffix of
 * DIFFERENT LENGTHS: each extra character is another multiply, so 1-char and 3-char suffixes land in
 * separate regions of the 32-bit space. The two groups then sort as blocks rather than interleaving,
 * and ~25% of the time (measured) the whole short group sorted below the long group — making the
 * frozen-pool test pass even against a pool-not-frozen mutant.
 *
 * Real coordinates do not behave that way: every channel has its own 64-hex owner (so candidates
 * diverge early, with high entropy) and channels.ts's newChannelD() emits a fixed-length base36 `d`.
 * This fixture reproduces that. See the S6 test below.
 */
const CH = (n: number): string => `30311:${hex(`owner${n}`, 64)}:${hex(`d${n}`, 12)}`;

/** A fixed identity: these tests assert DETERMINISM, so the ranking key must not be random. */
const ME_SK = new Uint8Array(32).fill(7);
const ME = getPublicKey(ME_SK);

function chatIn(coord: string, createdAt: number): Event {
  return finalizeEvent(
    {kind: Kind.LiveChat, created_at: createdAt, tags: [['a', coord, '', 'root']], content: 'hi'},
    generateSecretKey(),
  );
}

/** A store warm enough (>= MIN_DECOY_POOL feed authors) that the identity-scoped subs emit cover. */
function warmStore(): {store: InMemoryEventStore; me: string} {
  const store = new InMemoryEventStore();
  Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
  return {store, me: ME};
}

function freshFrozenStore(): {load: (k: string) => readonly string[] | undefined; save: (k: string, d: readonly string[]) => void} {
  const frozen = new Map<string, readonly string[]>();
  return {load: k => frozen.get(k), save: (k, d) => { frozen.set(k, d); }};
}

describe('SCOPED_CHANNEL_SYNC — the committed flag value', () => {
  /**
   * THE TRIPWIRE ON AN ACCIDENTAL FLIP — now pointing the other way.
   *
   * This flag shipped `false` (dark) and was flipped `true` on 2026-07-15, after the relay was
   * redeployed and verified. Everything below this test asserts the ON behaviour against the REAL
   * config, so this one line is what stops the whole file from quietly becoming a no-op: flip the
   * const back and this fails first and by name, instead of the suite silently re-testing the
   * firehose it was written to prove we had left.
   *
   * Turning it OFF again is a LEGITIMATE ROLLBACK — the OFF path is fully supported, still covered
   * (subscriptionPlan.channels.off.test.ts), and costs only bandwidth. It must simply be a
   * CONSCIOUS act: flipping the const means owning that every channel's messages go back to
   * streaming to every member, whether or not they joined. This test is the acknowledgement, not a
   * veto — a real rollback re-points this line and its twin in the .off. suite, and that edit is
   * exactly the visible record the change deserves.
   */
  it('is committed ON (this is the tripwire on an accidental flip back to the firehose)', () => {
    expect(SCOPED_CHANNEL_SYNC).toBe(true);
  });
});

describe('SCOPED_CHANNEL_SYNC — the firehose kind set', () => {
  it('drops the channel-MESSAGE kind (1311) — the actual weight', () => {
    expect(FIREHOSE_FEED_KINDS).not.toContain(Kind.LiveChat);
    // The contract array itself is untouched: it is the unscoped baseline, and SUBSCRIBED_KINDS (the
    // connection's ingest gate) derives from it — so the scoped subs' events are still accepted.
    expect(FEED_KINDS).toContain(Kind.LiveChat);
  });

  it('KEEPS the channel-DEFINITION kind (30311) — killing it would break discovery', () => {
    // 30311 is one small addressable event per channel and is what the directory, a member's owned
    // channels on their profile, and the per-channel notification toggles read from the cache — for
    // channels the member has NOT joined. It must stay unscoped.
    expect(FIREHOSE_FEED_KINDS).toContain(Kind.LiveActivity);
  });

  it('is FEED_KINDS minus exactly 1311 — nothing else silently left the feed', () => {
    expect(FIREHOSE_FEED_KINDS).toEqual(FEED_KINDS.filter(k => k !== Kind.LiveChat));
  });

  it('every firehose REQ filter inherits the scoped set — no path re-pulls channels unscoped', () => {
    const store = new InMemoryEventStore();
    expect(buildLiveFeedFilter().kinds).not.toContain(Kind.LiveChat);
    expect(buildFeedFilter(store).kinds).not.toContain(Kind.LiveChat);
    expect(buildReconcileFilter(store, {}).kinds).not.toContain(Kind.LiveChat);
    // The low-bandwidth reconcile derives from the SAME base, so the two flags compose rather than
    // one quietly undoing the other.
    expect(TEXT_ONLY_FEED_KINDS).not.toContain(Kind.LiveChat);
    expect(TEXT_ONLY_FEED_KINDS).toContain(Kind.LiveActivity);
  });
});

describe('SCOPED_CHANNEL_SYNC — the standing `channels` sub', () => {
  it('scopes #a to the member\'s channels mixed with decoys, and never names them alone', () => {
    const {store, me} = warmStore();
    const joined = [CH(1), CH(2)];
    const known = [...joined, CH(3), CH(4), CH(5), CH(6), CH(7)];
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      decoyCount: 4,
      getJoinedChannelIds: () => joined,
      getKnownChannelIds: () => known,
      frozenDecoyStore: freshFrozenStore(),
    });
    const sub = plan().find(s => s.subId === 'channels')!;
    expect(sub).toBeDefined();
    expect(sub.filter.kinds).toEqual([Kind.LiveChat]);
    const a = sub.filter['#a']!;
    // Both real channels are in there (we must actually receive our own channels' messages)...
    for (const j of joined) expect(a).toContain(j);
    // ...and so are 4 decoys, so `joined` is 2 of 6 rather than exposed.
    expect(a).toHaveLength(joined.length + 4);
    // Every entry is a real known coordinate — a decoy the relay knows doesn't exist is a tell.
    for (const id of a) expect(known).toContain(id);
    // No duplicates: a coordinate appearing twice would mark it as real.
    expect(new Set(a).size).toBe(a.length);
  });

  it('is LIMIT-ONLY and never `since`-bounded (a standing REQ must not drop live events)', () => {
    const {store, me} = warmStore();
    // Warm the channel cache hard: a `since`-deriving implementation would happily bound off this.
    store.save(chatIn(CH(1), Math.floor(Date.now() / 1000)));
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4), CH(5)],
      frozenDecoyStore: freshFrozenStore(),
    });
    const sub = plan().find(s => s.subId === 'channels')!;
    expect(sub.filter.since).toBeUndefined();
    expect(sub.filter.limit).toBe(50); // COLD_FEED_LIMIT
  });

  it('BELOW THE DECOY FLOOR: falls back to the unscoped firehose — never a bare #a of my channels', () => {
    const {store, me} = warmStore();
    // Only 2 other channels known (< MIN_DECOY_POOL = 3) — nowhere to hide.
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3)],
      frozenDecoyStore: freshFrozenStore(),
    });
    const sub = plan().find(s => s.subId === 'channels')!;
    expect(sub).toBeDefined();
    // THE requirement: unscoped, exactly like the DM sub's cold path. Bandwidth is the price; the
    // member's channel membership is not.
    expect(sub.filter['#a']).toBeUndefined();
    expect(sub.filter.kinds).toEqual([Kind.LiveChat]);
    expect(sub.filter.limit).toBe(50);
  });

  it('keeps the cover set STABLE across reconnects (defeats the intersection attack)', () => {
    const {store, me} = warmStore();
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      decoyCount: 4,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4), CH(5), CH(6), CH(7)],
      frozenDecoyStore: freshFrozenStore(),
    });
    const first = plan().find(s => s.subId === 'channels')!.filter['#a']!;
    const second = plan().find(s => s.subId === 'channels')!.filter['#a']!;
    const third = plan().find(s => s.subId === 'channels')!.filter['#a']!;
    // Same set AND same order — a relay intersecting the arrays across reconnects recovers the whole
    // set, never the real subset.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it('freezes the channel decoy pool so the cover set survives the community gaining channels (S6)', () => {
    const {store, me} = warmStore();
    let known = [CH(1), CH(2), CH(3), CH(4), CH(5), CH(6)];
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      decoyCount: 4,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => known,
      frozenDecoyStore: freshFrozenStore(),
    });
    const before = plan().find(s => s.subId === 'channels')!.filter['#a']!;
    const original = new Set(known);
    // The community grows by 30 channels. Without a frozen pool a newly-arrived coordinate with a
    // smaller keyed hash would displace a selected decoy, drifting the array while our real channel
    // stays invariant — exactly the subtraction attack the DM pool was frozen to stop.
    known = [...known, ...Array.from({length: 30}, (_, i) => CH(100 + i))];
    const after = plan().find(s => s.subId === 'channels')!.filter['#a']!;
    expect(after).toEqual(before);
    after.forEach(id => expect(original.has(id)).toBe(true));
  });

  it('does not share a frozen pool with the npub decoys (namespaced keys)', () => {
    // One frozen store backs both universes. If they shared a key, whichever sub ran first would
    // hand its snapshot to the other — pubkeys offered as channel coordinates, or vice versa.
    const {store, me} = warmStore();
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      decoyCount: 4,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4), CH(5), CH(6)],
      frozenDecoyStore: freshFrozenStore(),
    });
    const subs = plan();
    const dmP = subs.find(s => s.subId === 'dm')!.filter['#p']!;
    const chA = subs.find(s => s.subId === 'channels')!.filter['#a']!;
    // The DM cover is npubs; the channel cover is coordinates. No leakage in either direction.
    for (const p of dmP) expect(p).not.toContain('30311:');
    for (const a of chA) expect(a.startsWith('30311:')).toBe(true);
  });

  it('omits the sub entirely when the member is in no channels (nothing to fetch)', () => {
    const {store, me} = warmStore();
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      getJoinedChannelIds: () => [],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4)],
      frozenDecoyStore: freshFrozenStore(),
    });
    expect(plan().find(s => s.subId === 'channels')).toBeUndefined();
  });

  it('omits the sub when the host wires no channel getters (background sync)', () => {
    // background/syncTask.ts builds the plan with store + getMyPubkey only, exactly as it wires no
    // subscribeGroup for NIP-29. It must not start pulling channel traffic on a headless wake.
    const {store, me} = warmStore();
    const plan = createFeedAndDmPlan({store, getMyPubkey: () => me});
    expect(plan().find(s => s.subId === 'channels')).toBeUndefined();
  });

  it('emits no channels sub when not enrolled (no identity to key the cover set to)', () => {
    const {store} = warmStore();
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => undefined,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4)],
    });
    expect(plan().find(s => s.subId === 'channels')).toBeUndefined();
  });

  it('still emits the feed sub, and the feed sub still never carries a since', () => {
    // No-feed-event-loss: scoping channels must not disturb the delivery tail every other kind rides.
    const {store, me} = warmStore();
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      getJoinedChannelIds: () => [CH(1)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4)],
      frozenDecoyStore: freshFrozenStore(),
    });
    const feed = plan().find(s => s.subId === 'feed')!;
    expect(feed).toBeDefined();
    expect(feed.filter.since).toBeUndefined();
    expect(feed.filter.limit).toBe(50);
    expect(feed.filter.kinds).toContain(Kind.Post);
    expect(feed.filter.kinds).toContain(Kind.LiveActivity);
  });
});

describe('buildChannelChatFilter', () => {
  it('carries the cover set when given one, and copies it (no aliasing the caller\'s array)', () => {
    const cover = [CH(1), CH(2)];
    const f = buildChannelChatFilter(cover, 25);
    expect(f['#a']).toEqual(cover);
    expect(f['#a']).not.toBe(cover);
    expect(f.limit).toBe(25);
  });

  it('is unscoped when the cover is null, and never sets a since either way', () => {
    const unscoped = buildChannelChatFilter(null);
    expect('#a' in unscoped).toBe(false); // absent, not merely undefined — this goes on the wire
    expect(unscoped.since).toBeUndefined();
    expect(buildChannelChatFilter([CH(1)]).since).toBeUndefined();
  });
});

describe('buildCoverSetFor', () => {
  it('hides MULTIPLE real values (the channel case) — buildCoverSet is its mine=[me] case', () => {
    const mine = ['m1', 'm2'];
    const pool = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const out = buildCoverSetFor('key', mine, pool, 3);
    expect(out).toHaveLength(5);
    for (const m of mine) expect(out).toContain(m);
    expect(out.filter(x => pool.includes(x))).toHaveLength(3);
  });

  it('never offers a real value as its own decoy (a duplicate marks it real)', () => {
    // Pool deliberately contains one of `mine` — a caller could hand us the unfiltered known-channel
    // list. The emitted array must still name it exactly once.
    const out = buildCoverSetFor('key', ['m1'], ['m1', 'd1', 'd2', 'd3'], 3);
    expect(out.filter(x => x === 'm1')).toHaveLength(1);
    expect(new Set(out).size).toBe(out.length);
  });

  it('is deterministic for a given key — no Math.random, nothing to replay', () => {
    const pool = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    expect(buildCoverSetFor('k', ['m'], pool, 3)).toEqual(buildCoverSetFor('k', ['m'], pool, 3));
  });

  it('keys the decoy choice on `key`, not on the real values', () => {
    // Two members in the SAME channel must not draw the same decoys — that would let a relay
    // intersect their REQs and subtract the shared decoys to reveal the shared real channel.
    const pool = Array.from({length: 20}, (_, i) => `d${i}`);
    const a = buildCoverSetFor('alice', ['m'], pool, 4).filter(x => x !== 'm');
    const b = buildCoverSetFor('bob', ['m'], pool, 4).filter(x => x !== 'm');
    expect(a).not.toEqual(b);
  });

  it('honours the `sample` test seam over both selection and ordering', () => {
    const out = buildCoverSetFor('k', ['m'], ['d1', 'd2', 'd3'], 2, takeFirst);
    expect(out).toEqual(['m', 'd1', 'd2']);
  });

  it('degrades safely when the pool is smaller than the requested decoy count', () => {
    const out = buildCoverSetFor('k', ['m'], ['d1'], 4);
    expect(out).toHaveLength(2);
    expect(out).toContain('m');
  });
});

describe('channelChatSince (the per-channel on-open sub)', () => {
  it('is undefined for a channel we hold nothing for (an unjoined channel gets full history)', () => {
    const store = new InMemoryEventStore();
    expect(channelChatSince(store, CH(1), 300)).toBeUndefined();
  });

  it('is the channel-scoped high-water minus the overlap when warm', () => {
    const store = new InMemoryEventStore();
    store.save(chatIn(CH(1), 5_000));
    store.save(chatIn(CH(1), 9_000));
    expect(channelChatSince(store, CH(1), 300)).toBe(8_700);
  });

  it('is PER CHANNEL — a busy channel must not suppress a quiet one\'s backlog', () => {
    // The exact hazard groupChatSince documents: a global 1311 high-water would hand CH(2) CH(1)'s
    // newer mark and silently skip everything CH(2) ever said.
    const store = new InMemoryEventStore();
    store.save(chatIn(CH(1), 9_000));
    store.save(chatIn(CH(2), 1_000));
    expect(channelChatSince(store, CH(2), 300)).toBe(700);
  });

  it('never goes negative on a very old message', () => {
    const store = new InMemoryEventStore();
    store.save(chatIn(CH(1), 100));
    expect(channelChatSince(store, CH(1), 300)).toBe(0);
  });
});

describe('buildOpenChatFilters (the on-open scoped sub — since tail + newest-page backfill)', () => {
  // The 2026-07-28 field bug these pin: "posts inside channels are not loading for some channels
  // while loading for others." A channel's on-open sub derived its `since` from "newest cached
  // message for this channel" — but a newest message does NOT imply the history below it is
  // contiguous. Three producers cache newest-only strays: the standing `channels` sub's SHARED
  // limit page (newest-N across the whole cover set — after any offline window it hands each busy
  // channel a thin newest slice), the retention prune (1311 is count-capped globally, keeping the
  // newest), and the member's own echoed posts. A since-only resub then never reaches below the
  // stray, and 1311 is OUTSIDE the NIP-77 reconcile universe (FIREHOSE_FEED_KINDS drops it under
  // SCOPED_CHANNEL_SYNC), so the hole below never heals — that channel reads "posts not loading"
  // forever while an untouched channel (since reaches back past the hole, or true-cold limit page)
  // loads fine. The fix: the on-open sub ALWAYS carries a newest-first bounded page alongside the
  // since tail, so an opened space heals its newest `limit` messages regardless of how the
  // watermark got poisoned. Re-delivered events dedupe on store.has(id) BEFORE the schnorr verify
  // (ingest), so the overlap costs bandwidth only.
  it('POISONED WATERMARK: a stray newest message must not suppress the backfill page', () => {
    const store = new InMemoryEventStore();
    // The standing sub's shared page delivered ONE recent message for this channel; the 200
    // messages behind it were never fetched (the device was offline while they were published).
    store.save(chatIn(CH(1), 100_000));
    const since = channelChatSince(store, CH(1), 300);
    const filters = buildOpenChatFilters([Kind.LiveChat], '#a', CH(1), since, 50);
    // The since tail alone would ask only for created_at >= 99_700 — the hole stays invisible.
    // The second, limit-only filter is what heals it.
    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual({kinds: [Kind.LiveChat], '#a': [CH(1)], since: 99_700});
    expect(filters[1]).toEqual({kinds: [Kind.LiveChat], '#a': [CH(1)], limit: 50});
  });

  it('COLD: a channel we hold nothing for gets exactly today\'s single limit-only filter', () => {
    const filters = buildOpenChatFilters([Kind.LiveChat], '#a', CH(2), undefined, 50);
    expect(filters).toEqual([{kinds: [Kind.LiveChat], '#a': [CH(2)], limit: 50}]);
  });

  it('carries the group tag key for a group sub (the #h twin has the identical flaw)', () => {
    const filters = buildOpenChatFilters([9, 11, 12, 7], '#h', 'grp1', 4_700, 50);
    expect(filters[0]).toEqual({kinds: [9, 11, 12, 7], '#h': ['grp1'], since: 4_700});
    expect(filters[1]).toEqual({kinds: [9, 11, 12, 7], '#h': ['grp1'], limit: 50});
  });

  it('never emits since and limit on the SAME filter (khatru treats that as one bounded page)', () => {
    for (const f of buildOpenChatFilters([Kind.LiveChat], '#a', CH(1), 1_000, 50)) {
      expect(f.since !== undefined && f.limit !== undefined).toBe(false);
    }
  });
});
