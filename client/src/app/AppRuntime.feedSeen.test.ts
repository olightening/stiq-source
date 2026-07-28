/**
 * "New content since mark" — the feed UI's Twitter-style "N new posts" pill. See
 * AppRuntime.markFeedSeen / AppRuntime.newFeedItemCountSince / AppSnapshot.newFeedItemCount's doc
 * comments (AppRuntime.ts) for the full contract; this file pins the observable behaviour:
 *
 *   • 0 before the first markFeedSeen() call — no baseline yet, so no bogus pill on first paint.
 *   • markFeedSeen() takes the newest wire createdAt across the CURRENTLY-DISPLAYED feed (the last
 *     built/emitted snapshot), not "now" and not "the last item inserted" — out-of-order arrival
 *     (backfill/replay) must not move the mark backward.
 *   • Only items with createdAt STRICTLY GREATER than the mark count.
 *   • createdAt-only, never FeedItem.sortAt (ms, local-only, own-posts-only) — the viewer's own post
 *     can never skew the mark or the count via a unit mismatch.
 *   • Reset to 0 on a community switch — a mark from one community's timeline is meaningless in
 *     another's (clearSwitchCaches).
 *   • Flows through the same throttled deferred-emit pipeline as every other relay-driven update —
 *     no special-cased bypass.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
// TIMING_JITTER ships default-ON but only delays the wire send; the own-post test awaits a 0ms
// flush() (mirrors optimistic.test.ts) to let the placeholder land, which the jitter would outrun.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import type {Session} from '../onboarding/enrollment';
import {Kind} from '../nostr/events';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSessionFor(relayUrl: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin({relayUrl, issuerPublicKey: 'aXNz'}, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** A fresh, enrolled + unlocked runtime with a real (empty) feed, plus a handle on its store for
 *  injecting "relay-delivered" posts from other authors. */
async function newEnrolledRuntime(): Promise<{runtime: AppRuntime; store: InMemoryEventStore}> {
  const store = new InMemoryEventStore();
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: identityHash,
    autoLockMs: 600_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store};
}

/** Post from a throwaway OTHER author straight into the store, then feed it through the SAME
 *  ingestion path a real relay EVENT drives (mirrors AppRuntime.rosterOverlay.test.ts's helper). */
function deliverFromOther(runtime: AppRuntime, store: EventStore, createdAt: number, content: string): void {
  const ev = finalizeEvent({kind: Kind.Post, created_at: createdAt, tags: [], content}, generateSecretKey());
  store.save(ev);
  runtime.handleIncomingEvent(ev);
}

describe('AppRuntime "new content since mark" (feed pill)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads 0 before the first markFeedSeen() call, even with a populated feed', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    deliverFromOther(runtime, store, 1_000, 'other-post');
    expect(runtime.getSnapshot().feed.items.map(i => i.content)).toContain('other-post');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);
    runtime.dispose();
  });

  it('stays 0 immediately after markFeedSeen() — the current feed is its own baseline', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    deliverFromOther(runtime, store, 1_000, 'seen-already');
    runtime.markFeedSeen();
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);
    runtime.dispose();
  });

  it('counts items strictly newer than the mark, and NOT ones at or before it', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    deliverFromOther(runtime, store, 1_000, 'baseline');
    runtime.markFeedSeen();

    deliverFromOther(runtime, store, 1_000, 'same-instant'); // equal to the mark — not STRICTLY newer
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);

    deliverFromOther(runtime, store, 1_001, 'one-second-later');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(1);

    deliverFromOther(runtime, store, 1_500, 'later-still');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(2);
    runtime.dispose();
  });

  it('marks the MAX createdAt across the feed, not the last-inserted item — out-of-order arrival cannot move the mark backward', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    // Arrives out of chronological order (backfill/replay-like): 1_000, then 3_000, then 2_000.
    deliverFromOther(runtime, store, 1_000, 'a');
    deliverFromOther(runtime, store, 3_000, 'b');
    deliverFromOther(runtime, store, 2_000, 'c'); // last INSERTED, but not the newest by createdAt
    runtime.markFeedSeen(); // must land on 3_000 (the true max), not 2_000 (the last arrival)

    // Newer than the last-inserted item (2_000) but NOT newer than the true max (3_000) — if the
    // mark had incorrectly latched onto "last inserted" this would wrongly count as new.
    deliverFromOther(runtime, store, 2_500, 'not-new');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);

    deliverFromOther(runtime, store, 3_001, 'genuinely-new');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(1);
    runtime.dispose();
  });

  it('never mixes in FeedItem.sortAt (ms, own-posts-only) — the viewer\'s own post cannot skew the mark or the count', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    // The viewer's OWN post carries a millisecond-scale sortAt (AppRuntime._ownPostOrder) alongside
    // its second-scale wire createdAt. If the mark/count ever read sortAt instead of createdAt for
    // an own post, mixing ms into a seconds comparison would read it (and any mark taken from it) as
    // absurdly far in the future — see sort.ts's risingScore doc for the identical unit trap.
    await runtime.post('mine', []);
    await flush();
    const mine = runtime.getSnapshot().feed.items.find(i => i.content === 'mine')!;
    expect(mine).toBeDefined();
    expect(mine.sortAt).toBeDefined(); // precondition: this IS the own-post sortAt path

    runtime.markFeedSeen(); // must land on mine.createdAt (seconds), not mine.sortAt (ms)

    // A real relay post from someone else, a few seconds after the viewer's own post by createdAt.
    deliverFromOther(runtime, store, mine.createdAt + 5, 'other-after-mine');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(1);
    runtime.dispose();
  });

  it('resets to 0 on a community switch — a mark from one timeline is meaningless in another', async () => {
    // Mirrors multicommunity.test.ts's newSiloRuntime(): a SwappableEventStore + per-community
    // factory, so community B genuinely gets its own store rather than sharing A's.
    const stores = new Map<string, EventStore>();
    const makeStore = async (cid: string | null): Promise<EventStore> => {
      const key = cid ?? '__none__';
      let store = stores.get(key);
      if (!store) {
        store = new InMemoryEventStore();
        stores.set(key, store);
      }
      return store;
    };
    const swappable = new SwappableEventStore(new InMemoryEventStore());
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: swappable,
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 600_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');

    // .current always resolves whichever per-community inner store is ACTIVE right now (re-read
    // fresh, not cached, in case a switch happened since the last call — see SwappableEventStore).
    deliverFromOther(runtime, swappable.current, 1_000, 'in-a');
    runtime.markFeedSeen();
    deliverFromOther(runtime, swappable.current, 2_000, 'new-in-a');
    expect(runtime.getSnapshot().newFeedItemCount).toBe(1);

    // Join + switch to a second community (its own slot + its own store).
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    await runtime.submitPin('1234');
    // Fresh community, no mark taken yet → 0, not a stale/nonsense count from A's timeline.
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);

    await runtime.switchCommunity(communityId(RELAY_A));
    // Back in A: the switch AWAY also reset the mark, so A's pill is 0 again too — not still "1"
    // from before we left (a switch always starts the pill fresh, in either direction).
    expect(runtime.getSnapshot().newFeedItemCount).toBe(0);
    runtime.dispose();
  });

  /**
   * REGRESSION (release APK vc9, 100% CPU on mqt_js forever): the UI host re-renders on the strength
   * of this return value, so "did anything actually change?" has to be answerable WITHOUT building a
   * snapshot — getSnapshot() mints a new object every call, so a host that setState()s it
   * unconditionally can never bail out on Object.is and re-renders the whole tree on every mark. See
   * App.tsx's handleMarkFeedSeen and MainScreen.newPostsPill.test.tsx's regression describe.
   */
  it('reports whether the mark actually MOVED, so a repeat mark on an unchanged feed is a no-op', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    deliverFromOther(runtime, store, 1_000, 'first');

    expect(runtime.markFeedSeen()).toBe(true); // no baseline → 1_000: a real change
    expect(runtime.markFeedSeen()).toBe(false); // nothing new since → idempotent
    expect(runtime.markFeedSeen()).toBe(false); // …and stays that way however often it's called

    deliverFromOther(runtime, store, 2_000, 'newer');
    expect(runtime.markFeedSeen()).toBe(true); // genuine new content advanced the mark
    expect(runtime.markFeedSeen()).toBe(false);

    // Older-than-the-mark backfill must NOT re-report a change: the mark is the MAX createdAt, so it
    // does not move, and a host that re-rendered here would do so for nothing.
    deliverFromOther(runtime, store, 1_500, 'backfill');
    expect(runtime.markFeedSeen()).toBe(false);
    runtime.dispose();
  });

  /**
   * The invariant that makes MainScreen's mark-seen effect safe to key on `feed.items`. That effect
   * CALLS markFeedSeen and DEPENDS on feed.items, so if marking changed the feed's identity the
   * effect would re-trigger itself — the same unterminated loop the callback-identity bug caused,
   * just via a different dependency. markFeedSeen touches only the private _feedSeenMark; it makes
   * no store write and bumps no version counter, so _cachedBuildFeed's key (store version ×
   * moderators × pubkey × automod × identity version) is untouched and returns the very same object.
   */
  it('does not change the feed reference — marking is not a store mutation', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    deliverFromOther(runtime, store, 1_000, 'a');
    deliverFromOther(runtime, store, 2_000, 'b');

    const before = runtime.getSnapshot();
    runtime.markFeedSeen();
    const after = runtime.getSnapshot();

    expect(after.feed).toBe(before.feed); // same object, so React/`feed.items` deps do not re-fire
    expect(after.feed.items).toBe(before.feed.items);
    // The snapshot OBJECT is new every call (that is why App.tsx gates its setSnapshot on the
    // markFeedSeen() return value) — pinned here so the distinction stays explicit.
    expect(after).not.toBe(before);
    runtime.dispose();
  });

  it('reports no change while not enrolled — there is nothing to mark', async () => {
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: identityHash,
      autoLockMs: 600_000,
      publish: async () => ({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    expect(runtime.markFeedSeen()).toBe(false);
    runtime.dispose();
  });

  it('flows through the normal throttled deferred emit — a subscriber sees the updated count after the coalescing window', async () => {
    const {runtime, store} = await newEnrolledRuntime();
    // Drain init()'s own off-critical-path REAL timers (the deferred-heavy lift + attribution
    // warmup emit — see emitThrottle.test.ts's makeRuntime, which pins the identical drain) BEFORE
    // switching to fake timers. Skipping this was the actual bug behind this test's failure: with
    // jest.useFakeTimers() installed only AFTER the 'baseline' deliverFromOther below, THAT call's
    // handleIncomingEvent → notifyStoreChanged → emitDeferred armed a REAL setTimeout (fake timers
    // don't retroactively adopt timers already scheduled before they're installed). The 'fresh'
    // delivery's own emitDeferred call then saw AppRuntime's `_deferredTimer !== undefined` guard
    // still pointing at that stale REAL handle and silently no-op'd — so jest.advanceTimersByTime
    // never had a fake timer to advance, and `latest` stayed stuck at its pre-'fresh' value forever.
    // Installing fake timers BEFORE any deliverFromOther call (matching emitThrottle.test.ts's
    // convention throughout) keeps the whole test on one consistent timer regime.
    await runtime.whenAttributionWarmupReady();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    jest.useFakeTimers();
    deliverFromOther(runtime, store, 1_000, 'baseline');
    runtime.markFeedSeen();

    let latest: number | undefined;
    const unsub = runtime.subscribe(s => {
      latest = s.newFeedItemCount;
    });
    expect(latest).toBe(0); // subscribe() delivers the current snapshot synchronously

    deliverFromOther(runtime, store, 2_000, 'fresh');
    // 80ms mirrors the private RELAY_EMIT_THROTTLE_MS (same hardcoded-literal idiom emitThrottle.
    // test.ts uses, since a private static can't be referenced from outside the class).
    jest.advanceTimersByTime(79);
    expect(latest).toBe(0); // deferred emit hasn't fired yet — still the pre-event snapshot
    jest.advanceTimersByTime(1);
    expect(latest).toBe(1);
    unsub();
    runtime.dispose();
  });
});
