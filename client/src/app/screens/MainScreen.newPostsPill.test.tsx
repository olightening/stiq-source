jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React, {useState} from 'react';
import {Animated} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {BottomDock} from '../../ui/BottomDock';
import {setDockPrefsSlot} from '../dockPrefs';
import type {FeedItem} from '../../feed/feed';

/**
 * "N new posts" pill (instant-refresh overhaul, Task C) — wires AppRuntime's already-existing
 * newFeedItemCount/markFeedSeen (see AppRuntime.feedSeen.test.ts for the runtime-side contract:
 * 0 before the first mark, counts forward from there, resets on community switch) onto the feed's
 * EXISTING return-to-top bubble (BottomDock's jump.count) instead of a new floating element. Pins:
 *
 *  - jump.count only surfaces once the reader has scrolled away from the top — new content arriving
 *    while already at/near the top is already visible live (Task A/emit pipeline), so no affordance
 *    is needed there, and MainScreen must not invent one;
 *  - onMarkFeedSeen fires once real content is on screen at the top (covers mount AND switching
 *    into the feed tab), again whenever a live scroll returns to the top after being away, and on
 *    an explicit pill tap;
 *  - onMarkFeedSeen does NOT fire repeatedly while merely resting near the top or scrolled away
 *    with nothing changing — a naive per-scroll-frame call would turn AppRuntime.markFeedSeen's
 *    O(feed-size) scan into a hot loop (see MainScreen's syncFeedCaughtUp/feedCaughtUpRef comments).
 */

const noop = (): void => undefined;

// Fresh dockPrefs slot per test (same idiom as MainScreen.tabScrollRestore.test.tsx) — MainScreen
// persists the launch-default tab to a shared module-level mirror, so a stale slot from an earlier
// test could start this one on the wrong tab.
let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`new-posts-pill-${dockSlotSeq++}`));

// BottomDock's jump bubble drives its mount/show/hide via REAL Animated.spring/timing, which under
// this jest env (react-native-reanimated's setUpTests() installs a setTimeout(fn,0)-backed
// requestAnimationFrame mock that core RN's Animated also rides) settle over an unpredictable number
// of real macrotask hops rather than instantly. This file toggles jump.visible across most of its
// tests (every "scrolled away" case), and empirically, no fixed number of post-test flush hops proved
// reliable: a leftover animation frame from one test's tree (never unmounted — matching every sibling
// MainScreen test file's convention of not explicitly unmounting between tests) can still be mid-
// flight when jest tears down this file's module registry, crashing the WHOLE WORKER with "Cannot
// read properties of undefined (reading 'Value')" in whichever file jest happens to run next — this
// is the exact "MainScreen teardown leak" MainScreen.notificationsLive.test.tsx's flushHard doc and
// this project's CLAUDE.md both warn is nondeterministic. Rather than betting on a hop count, stub
// BOTH factories to resolve their `finished` callback SYNCHRONOUSLY, so no real timer is ever created
// in the first place — this suite's assertions only ever read the PROPS MainScreen computes for
// BottomDock (mirroring MainScreen.tabScrollRestore.test.tsx's own convention of asserting on
// jump.visible/jump.count directly rather than on rendered pixels), never the animation's own visual
// timing, which is BottomDock.test.tsx's job to cover.
type AnimEndCallback = (result: {finished: boolean}) => void;
function instantAnimation(): Animated.CompositeAnimation {
  return {
    start: (cb?: AnimEndCallback) => cb?.({finished: true}),
    stop: () => undefined,
    reset: () => undefined,
  };
}

beforeEach(() => {
  jest.spyOn(Animated, 'timing').mockImplementation(instantAnimation);
  jest.spyOn(Animated, 'spring').mockImplementation(instantAnimation);
});

afterEach(async () => {
  // Belt-and-braces: the Animated stub above removes the specific pending-timer hazard this file
  // used to hit, but every sibling MainScreen test file still carries this same single-hop drain
  // for its own unrelated microtasks (e.g. ensureReadStateLoaded) — cheap insurance, not a sign
  // this file still needs it for the animation concern.
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  jest.restoreAllMocks();
});

const baseProps: Partial<MainScreenProps> = {
  currentUserPubkey: 'a'.repeat(64),
  isModerator: false,
  sendStatus: new Map(),
  onVote: noop,
  onCreateChannel: noop,
  onPostToChannel: noop,
  onGetThread: () => [],
  onGetChannelMessages: () => [],
  onSubmit: noop,
  onSendDm: noop,
};

/** A minimal, real FeedItem (via the actual toFeedItem/buildPost pipeline — same idiom as
 *  MainScreen.tabScrollRestore.test.tsx's makeFeedItem) so `feed.items` behaves like the genuine
 *  prop shape MainScreen expects, not a hand-rolled partial that happens to typecheck. */
function makeFeedItem(id: string, createdAt: number): FeedItem {
  const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
  const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
  return toFeedItem({
    ...buildPost(`body-${id}`, []),
    id,
    pubkey: 'a'.repeat(64),
    created_at: createdAt,
    sig: 's',
  } as unknown as import('nostr-tools/pure').Event);
}

function scrollFeedTo(tree: renderer.ReactTestRenderer, y: number): void {
  const list = tree.root.findByType(FeedList);
  act(() => {
    (list.props.onScroll as (e: unknown) => void)({nativeEvent: {contentOffset: {y}}});
  });
}

function renderScreen(props: Partial<MainScreenProps>): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<MainScreen {...(baseProps as MainScreenProps)} inbox={[]} channels={[]} {...props} />);
  });
  return tree;
}

describe('MainScreen "N new posts" pill — surfacing the count', () => {
  it('does not surface a count while the reader is at/near the top', () => {
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, newFeedItemCount: 5});
    expect(tree.root.findByType(BottomDock).props.jump?.count).toBeUndefined();
  });

  it('surfaces the count on the jump bubble once the reader has scrolled away from the top', () => {
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, newFeedItemCount: 5});
    scrollFeedTo(tree, 300);
    expect(tree.root.findByType(BottomDock).props.jump?.count).toBe(5);
  });

  it('a count of 0 never renders on the jump bubble even while scrolled away', () => {
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, newFeedItemCount: 0});
    scrollFeedTo(tree, 300);
    expect(tree.root.findByType(BottomDock).props.jump?.count).toBeUndefined();
  });

  it('a jump-bubble tap scrolls to top AND marks the feed seen', () => {
    const onMarkFeedSeen = jest.fn();
    const tree = renderScreen({
      feed: {items: [makeFeedItem('p1', 1)], log: []},
      newFeedItemCount: 3,
      onMarkFeedSeen,
    });
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1); // the mount-time baseline (see below)

    scrollFeedTo(tree, 300);
    act(() => {
      tree.root.findByType(BottomDock).props.jump!.onPress();
    });
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(2);
  });
});

describe('MainScreen "N new posts" pill — when onMarkFeedSeen fires', () => {
  it('establishes the seen baseline once real content is on screen at the top (mount)', () => {
    const onMarkFeedSeen = jest.fn();
    renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, onMarkFeedSeen});
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);
  });

  it('does not mark seen on mount while the feed is still empty (cold start / pre-sync)', () => {
    const onMarkFeedSeen = jest.fn();
    renderScreen({feed: {items: [], log: []}, onMarkFeedSeen});
    expect(onMarkFeedSeen).not.toHaveBeenCalled();

    // The first real content still gets its baseline once it lands.
    // (Left as documentation here — the "keeps marking while content streams in" test below
    // exercises the update path this depends on.)
  });

  it('marks seen again on scrolling back to the top after being away, but not while merely resting near the top', () => {
    const onMarkFeedSeen = jest.fn();
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, onMarkFeedSeen});
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1); // mount baseline

    scrollFeedTo(tree, 300); // away
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);

    scrollFeedTo(tree, 305); // still away — a second scroll event must not spam a re-mark
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);

    scrollFeedTo(tree, 0); // back to the top — the edge crossing marks seen again
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(2);

    scrollFeedTo(tree, 10); // still within the caught-up band — no extra call
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(2);
  });

  it('keeps marking seen while more content streams in AND the reader stays at the top', () => {
    const onMarkFeedSeen = jest.fn();
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, onMarkFeedSeen});
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);

    act(() => {
      tree.update(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          inbox={[]}
          channels={[]}
          feed={{items: [makeFeedItem('p2', 2), makeFeedItem('p1', 1)], log: []}}
          onMarkFeedSeen={onMarkFeedSeen}
        />,
      );
    });
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(2); // content changed while still at the top
  });

  it('does NOT keep marking seen while more content streams in but the reader has scrolled away', () => {
    const onMarkFeedSeen = jest.fn();
    const tree = renderScreen({feed: {items: [makeFeedItem('p1', 1)], log: []}, onMarkFeedSeen});
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);

    scrollFeedTo(tree, 300); // away
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1);

    act(() => {
      tree.update(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          inbox={[]}
          channels={[]}
          feed={{items: [makeFeedItem('p2', 2), makeFeedItem('p1', 1)], log: []}}
          onMarkFeedSeen={onMarkFeedSeen}
        />,
      );
    });
    expect(onMarkFeedSeen).toHaveBeenCalledTimes(1); // still away — must not mark
  });
});

/**
 * REGRESSION (device-proven 2026-07-27, release APK vc9 "1.6-arti-test3"): `mqt_js` pegged at 100%
 * CPU with RES climbing past 1 GB, forever, the moment the app settled on the feed tab with cached
 * content at the top. The JS thread never recovered — native scrolling still moved, but no tap or
 * state change could ever land again.
 *
 * The loop was a three-link cycle across the App.tsx ⇄ MainScreen boundary, and every link was
 * individually reasonable:
 *   1. App.tsx passed `onMarkFeedSeen` as an INLINE JSX arrow, so its identity changed on every
 *      single App render (the ordinary shape of ~90 other props on this same element);
 *   2. that handler calls `runtime.markFeedSeen()` and then `setSnapshot(runtime.getSnapshot())` —
 *      and getSnapshot() builds a BRAND-NEW object literal every call, so setSnapshot can never
 *      bail out on Object.is and ALWAYS re-renders App;
 *   3. MainScreen's mark-seen effect listed `onMarkFeedSeen` in its dependency array, so a fresh
 *      identity alone re-ran it — calling the handler again → (2) → (1) → (3) → …
 *
 * Nothing crashed because React's "Maximum update depth exceeded" throw only counts updates still
 * PENDING at commit time, and on this app's legacy (non-Fabric, newArchEnabled=false) root a
 * passive-effect update is dispatched as its own scheduler task instead — see
 * ReactNativeRenderer-prod.js's `0 !== root.tag && flushPassiveEffects()` guard. The counter resets
 * to 0 on every commit, so the app spins silently at full tilt rather than failing loudly.
 *
 * The suite above could not catch this: every one of its cases passes a STABLE `jest.fn()`. The
 * contract this pins is therefore about identity, not counting — MainScreen must re-mark on what
 * actually changed (the tab, the feed's content, a real scroll edge, a pill tap) and never merely
 * because its host handed it a new function.
 */
describe('MainScreen "N new posts" pill — no render feedback loop (regression)', () => {
  // Well above any legitimate mark count for these scenarios (1–2), far below a hang. Reached ONLY
  // by a genuine loop; the harness then stops feeding the cycle so a regression fails this test in
  // milliseconds with a readable number instead of wedging the jest worker the way it wedged the
  // phone.
  const RUNAWAY = 25;

  /** Stable across Host renders, exactly like the real `snapshot.feed` (AppRuntime.visibleFeed is
   *  memoized on the raw feed + mute version, so its identity only changes on real content change).
   *  Inlining this in the JSX below would hand `feed.items` a fresh array every render and mask
   *  which dependency is actually at fault. */
  const STABLE_FEED = {items: [makeFeedItem('p1', 1)], log: []};

  /**
   * Reproduces App.tsx's exact shape: host state that MainScreen's own callback writes back into,
   * reached through an inline arrow prop whose identity therefore changes on every host render, and
   * a state value that is a fresh object every time (mirroring getSnapshot()) so React can never
   * bail the re-render out.
   */
  function renderHost(): {marks: () => number} {
    let marks = 0;
    function Host(): React.JSX.Element {
      const [, setSnapshot] = useState<object>({});
      return (
        <MainScreen
          {...(baseProps as MainScreenProps)}
          inbox={[]}
          channels={[]}
          feed={STABLE_FEED}
          onMarkFeedSeen={() => {
            marks++;
            if (marks > RUNAWAY) return; // circuit breaker — fail the assertion, never hang
            setSnapshot({}); // App.tsx: setSnapshot(r.getSnapshot()), always a NEW object
          }}
        />
      );
    }
    act(() => {
      renderer.create(<Host />);
    });
    return {marks: () => marks};
  }

  it('marks seen exactly once on mount even though the host re-renders with a new callback identity each time', () => {
    const {marks} = renderHost();
    expect(marks()).toBe(1);
  });

  it('a scroll away and back marks seen exactly once more — the mark cycle stays bounded', () => {
    let marks = 0;
    let tree!: renderer.ReactTestRenderer;
    function Host(): React.JSX.Element {
      const [, setSnapshot] = useState<object>({});
      return (
        <MainScreen
          {...(baseProps as MainScreenProps)}
          inbox={[]}
          channels={[]}
          feed={STABLE_FEED}
          onMarkFeedSeen={() => {
            marks++;
            if (marks > RUNAWAY) return;
            setSnapshot({});
          }}
        />
      );
    }
    act(() => {
      tree = renderer.create(<Host />);
    });
    expect(marks).toBe(1);

    scrollFeedTo(tree, 300); // away — no mark, and no loop from the re-render it causes either
    expect(marks).toBe(1);

    scrollFeedTo(tree, 0); // back to the top — one edge crossing, one mark
    expect(marks).toBe(2);
  });
});
