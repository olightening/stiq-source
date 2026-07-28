jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import {Animated, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, holdFeedComposition, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {BottomDock} from '../../ui/BottomDock';
import {Press} from '../../ui/Press';
import {setDockPrefsSlot} from '../dockPrefs';
import {setFeedSortPrefsSlot} from '../feedSortPrefs';
import type {FeedItem} from '../../feed/feed';

/**
 * The feed HOLD (instant-refresh audit Gap 1) — buffer arrivals, don't inject them.
 *
 * Before this, `pagedItems` recomputed from live `feed.items` with NO gate on scroll position.
 * `onScrollBeginDrag`/`onScrollSettle` park deferred emits only for the duration of an ACTIVE
 * drag/fling, so a post arriving while the reader sat STILL three screens down was spliced straight
 * into the array they were looking at: under `sort: 'new'` it prepends at index 0 and shifts every
 * card below it down by a card's height, and under Hot/Rising it can reorder arbitrarily. RN's
 * ScrollView does not compensate the offset, and `maintainVisibleContentPosition` is deliberately
 * unusable on a continuously re-scored list (see ChannelView.tsx, where it IS used, for the
 * reasoning). The "N new posts" pill counted those arrivals but never held them — by the time it
 * said "3 new posts", all three were already on screen and the page had already moved.
 *
 * What this file pins is the buffer:
 *  1. resting outside the top band + a background arrival ⇒ the rendered array is untouched (same
 *     IDENTITY, so FlatList does not even see an update) while the pill's count still climbs;
 *  2. returning to the top band releases the held arrivals;
 *  3. at the top, arrivals still land instantly — no regression;
 *  4. the reader's OWN action is never held (their own post, their own vote);
 *  5. sort / search / tag / community changes always recompose, held or not;
 *  6. the hold neither leaks nor loses the reader's place across a tab switch;
 *  7. "Load more" / older-history backfill still lands while held (appending below the last held
 *     row cannot move anything above it).
 *
 * Every assertion below is on the `items` prop MainScreen hands FeedList, which is the array whose
 * mutation IS the defect — the same convention as MainScreen.newPostsPill.test.tsx asserting on the
 * jump props rather than on pixels.
 */

const noop = (): void => undefined;

// Fresh dockPrefs slot per test (same idiom as the sibling MainScreen suites) — the launch-default
// tab is persisted to a shared module-level mirror, so a stale slot could start a test on the wrong tab.
// Likewise a fresh feedSortPrefs slot: that mirror is module-level too, so a test that taps the
// Rising chip would otherwise leave every LATER test mounting on 'hot' — which silently turns the
// "a sort change recomposes" test below into a no-op tap. (Found the hard way: it failed exactly
// that way on the first run of this file.)
let dockSlotSeq = 0;
beforeEach(() => {
  setDockPrefsSlot(`feed-hold-${dockSlotSeq}`);
  setFeedSortPrefsSlot(`feed-hold-${dockSlotSeq}`);
  dockSlotSeq++;
});

// See MainScreen.newPostsPill.test.tsx's long note: BottomDock's jump bubble animates for real, and a
// straggling frame can crash the whole jest worker at module teardown. Resolve both factories
// synchronously so no timer is ever created.
type AnimEndCallback = (result: {finished: boolean}) => void;
function instantAnimation(): Animated.CompositeAnimation {
  return {start: (cb?: AnimEndCallback) => cb?.({finished: true}), stop: () => undefined, reset: () => undefined};
}
beforeEach(() => {
  jest.spyOn(Animated, 'timing').mockImplementation(instantAnimation);
  jest.spyOn(Animated, 'spring').mockImplementation(instantAnimation);
});
afterEach(async () => {
  await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
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

/**
 * A real FeedItem through the genuine toFeedItem/buildPost pipeline (same idiom as the sibling
 * suites). `score`/`myVote`/`sortAt` are exposed because they are exactly the fields the hold has to
 * distinguish: a score change is the reader's own vote flowing through a held row, and `sortAt` is
 * the ONLY marker of the reader's own post (AppRuntime._ownPostOrder — see feedItemKey).
 *
 * Each call returns a NEW object, which matters: production's buildFeed reuses one identity-stable
 * object per post (feed.ts's _itemCache) until a post's rendered inputs change, so a test modelling a
 * background arrival must REUSE the item objects it already made and mint a new one only for the post
 * that actually changed. Every test below does exactly that.
 */
function makeFeedItem(
  id: string,
  createdAt: number,
  opts: {score?: number; myVote?: 'up' | 'down' | null; sortAt?: number} = {},
): FeedItem {
  const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
  const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
  return toFeedItem(
    {
      ...buildPost(`body-${id}`, []),
      id,
      pubkey: 'a'.repeat(64),
      created_at: createdAt,
      sig: 's',
    } as unknown as import('nostr-tools/pure').Event,
    opts.score ?? 0,
    undefined,
    opts.myVote,
    undefined,
    undefined,
    undefined,
    opts.sortAt,
  );
}

function feedItems(tree: renderer.ReactTestRenderer): FeedItem[] {
  return tree.root.findByType(FeedList).props.items as FeedItem[];
}
const ids = (tree: renderer.ReactTestRenderer): string[] => feedItems(tree).map(i => i.id);

function scrollFeedTo(tree: renderer.ReactTestRenderer, y: number): void {
  const list = tree.root.findByType(FeedList);
  act(() => {
    (list.props.onScroll as (e: unknown) => void)({nativeEvent: {contentOffset: {y}}});
  });
}

/** The sort/tag rail rides as the feed list header; its chips are plain Press+Text with no testID. */
function tapChip(tree: renderer.ReactTestRenderer, label: string): void {
  const press = tree.root.findAllByType(Press).find(p => {
    try {
      return p.findAllByType(Text).some(t => t.props.children === label);
    } catch {
      return false;
    }
  });
  if (!press) throw new Error(`no chip labelled "${label}"`);
  act(() => (press.props.onPress as () => void)());
}

function tapDockTab(tree: renderer.ReactTestRenderer, key: string): void {
  const dock = tree.root.findByType(BottomDock);
  const item = (dock.props.items as {key: string; onPress: () => void}[]).find(i => i.key === key);
  if (!item) throw new Error(`no dock tab "${key}"`);
  act(() => item.onPress());
}

type Screen = {tree: renderer.ReactTestRenderer; update: (props: Partial<MainScreenProps>) => void};

function renderScreen(props: Partial<MainScreenProps>): Screen {
  let tree!: renderer.ReactTestRenderer;
  let current = props;
  const element = (p: Partial<MainScreenProps>): React.JSX.Element => (
    <MainScreen {...(baseProps as MainScreenProps)} inbox={[]} channels={[]} {...p} />
  );
  act(() => { tree = renderer.create(element(props)); });
  return {
    tree,
    update: next => {
      current = {...current, ...next};
      act(() => { tree.update(element(current)); });
    },
  };
}

// ── The fixture ────────────────────────────────────────────────────────────────────────────────────
// Three cached posts, newest first under the default 'new' sort, plus one background arrival that is
// NEWER than all of them (so under 'new' it prepends at index 0 — the worst case for reflow).
// Built once per test so identities are reused exactly the way _itemCache reuses them.
function fixture(): {p1: FeedItem; p2: FeedItem; p3: FeedItem; arrival: FeedItem} {
  return {
    p1: makeFeedItem('p1', 1000),
    p2: makeFeedItem('p2', 2000),
    p3: makeFeedItem('p3', 3000),
    arrival: makeFeedItem('arrival', 9000),
  };
}

describe('feed hold — a background arrival never moves a resting reader (requirement 1)', () => {
  it('leaves the rendered array UNTOUCHED (same identity) while the reader rests scrolled away', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}, newFeedItemCount: 0});
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    scrollFeedTo(tree, 800); // three screens down, and then STILL — no drag is in flight
    const before = feedItems(tree);

    update({feed: {items: [arrival, p3, p2, p1], log: []}, newFeedItemCount: 1});

    // Identity, not merely content: FlatList must not even see a changed `data` prop.
    expect(feedItems(tree)).toBe(before);
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);
  });

  it('keeps counting the arrivals on the pill while holding them out of the list', () => {
    const {p1, p2, p3, arrival} = fixture();
    const extra = makeFeedItem('extra', 9500);
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}, newFeedItemCount: 0});
    scrollFeedTo(tree, 800);

    update({feed: {items: [arrival, p3, p2, p1], log: []}, newFeedItemCount: 1});
    expect(tree.root.findByType(BottomDock).props.jump?.count).toBe(1);

    update({feed: {items: [extra, arrival, p3, p2, p1], log: []}, newFeedItemCount: 2});
    expect(tree.root.findByType(BottomDock).props.jump?.count).toBe(2);
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']); // still nothing spliced in
  });

  it('holds a re-scored Hot/Rising REORDER too, not just a prepend', () => {
    const {p1, p2, p3} = fixture();
    // p1 gains a pile of votes from other readers — under Rising this is exactly the input that
    // reorders the array in place, with no new item involved at all.
    const votedP1 = makeFeedItem('p1', 1000, {score: 500});

    const held = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    tapChip(held.tree, 'Rising'); // the reader's own action: switch to the re-scored sort
    expect(ids(held.tree)).toEqual(['p3', 'p2', 'p1']);
    held.update({feed: {items: [p3, p2, votedP1], log: []}});
    expect(ids(held.tree)).toEqual(['p1', 'p3', 'p2']); // control: at the top, Rising DOES reorder

    // A fresh feedSortPrefs slot has nothing persisted, so this mounts on the 'new' DEFAULT — and
    // under 'new' a re-score reorders nothing at all, which would make the assertion below pass for
    // the wrong reason. Put this tree on Rising too, so the hold is what stops the reorder.
    const away = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    tapChip(away.tree, 'Rising');
    expect(ids(away.tree)).toEqual(['p3', 'p2', 'p1']);
    scrollFeedTo(away.tree, 800);
    away.update({feed: {items: [p3, p2, votedP1], log: []}});
    expect(ids(away.tree)).toEqual(['p3', 'p2', 'p1']); // …and scrolled away it does not
  });
});

describe('feed hold — release (requirements 2 and 3)', () => {
  it('releases the held arrivals when the reader scrolls back into the top band', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 800);
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    scrollFeedTo(tree, 0); // back to the top — the same edge the pill's auto-clear uses
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });

  it('releases on a pill tap, which is what the pill has always promised', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}, newFeedItemCount: 1});
    scrollFeedTo(tree, 800);
    update({feed: {items: [arrival, p3, p2, p1], log: []}, newFeedItemCount: 1});
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    act(() => { tree.root.findByType(BottomDock).props.jump!.onPress(); });
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });

  it('a reader AT the top still sees arrivals instantly (no regression)', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });

  it('a reader still inside the band (scrolled, but not past JUMP_AFTER) is not held either', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 100); // < JUMP_AFTER (240) — the same band the jump bubble uses
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });
});

describe("feed hold — the reader's own action is never held (requirement 4)", () => {
  it("shows the reader's OWN new post at once while scrolled away, and still holds everyone else's", () => {
    const {p1, p2, p3, arrival} = fixture();
    // Only the viewer's own posts carry sortAt (AppRuntime._ownPostOrder).
    const mine = makeFeedItem('mine', 8000, {sortAt: Date.now()});
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 800);

    update({feed: {items: [mine, arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['mine', 'p3', 'p2', 'p1']);
  });

  it("shows the reader's OWN vote on a held row at once, while still holding the arrival", () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 800);

    // One snapshot carrying BOTH: the reader's upvote on p2 (a rebuilt item — _itemCache's key
    // includes score/myVote) and someone else's brand-new post.
    const votedP2 = makeFeedItem('p2', 2000, {score: 7, myVote: 'up'});
    update({feed: {items: [arrival, p3, votedP2, p1], log: []}});

    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']); // the arrival is still buffered
    const rendered = feedItems(tree).find(i => i.id === 'p2');
    expect(rendered?.score).toBe(7); // …but their own vote landed on the card they voted on
    expect(rendered?.myVote).toBe('up');
  });
});

describe('feed hold — the reader\'s own view controls always recompose (requirement 5)', () => {
  it('a sort change recomposes immediately even while scrolled away', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 800);
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    tapChip(tree, 'Rising');
    expect(ids(tree).sort()).toEqual(['arrival', 'p1', 'p2', 'p3']);
  });

  it('a tag-filter change recomposes immediately even while scrolled away', () => {
    const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
    const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
    const tagged = (id: string, createdAt: number, tag: string): FeedItem =>
      toFeedItem({
        ...buildPost(`body-${id}`, [tag]),
        id,
        pubkey: 'a'.repeat(64),
        created_at: createdAt,
        sig: 's',
      } as unknown as import('nostr-tools/pure').Event);

    const a = tagged('a', 1000, 'news');
    const b = tagged('b', 2000, 'news');
    const late = tagged('late', 9000, 'news');
    const {tree, update} = renderScreen({feed: {items: [b, a], log: []}});
    scrollFeedTo(tree, 800);
    update({feed: {items: [late, b, a], log: []}});
    expect(ids(tree)).toEqual(['b', 'a']);

    tapChip(tree, 'news'); // selecting a tag chip is the reader's own action
    expect(ids(tree)).toEqual(['late', 'b', 'a']);
  });

  it('a community switch drops the hold instead of rendering the previous community\'s posts', () => {
    const {p1, p2, p3} = fixture();
    const other = makeFeedItem('other-community-post', 5000);
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}, communityCid: 'cid-a'});
    scrollFeedTo(tree, 800);

    update({feed: {items: [other], log: []}, communityCid: 'cid-b'});
    expect(ids(tree)).toEqual(['other-community-post']);
  });
});

describe('feed hold — tab switches (requirement 6)', () => {
  it('keeps the reader\'s place across a tab switch and does not leak the hold once they return to the top', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    scrollFeedTo(tree, 800);
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    tapDockTab(tree, 'channels'); // background the feed tab while items are held
    tapDockTab(tree, 'feed');     // …and come back, still scrolled away

    // Same page they left — the hold resumed rather than recomposing under them on return.
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);

    // And it is a HOLD, not a freeze: returning to the top still releases.
    scrollFeedTo(tree, 0);
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });

  it('does not hold anything for a reader who left the feed tab from the TOP', () => {
    const {p1, p2, p3, arrival} = fixture();
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}});
    tapDockTab(tree, 'channels');
    update({feed: {items: [arrival, p3, p2, p1], log: []}});
    tapDockTab(tree, 'feed');
    expect(ids(tree)).toEqual(['arrival', 'p3', 'p2', 'p1']);
  });
});

describe('feed hold — the composition rule itself (requirement 7 and the invariants)', () => {
  const item = (id: string, createdAt: number, opts?: {score?: number; sortAt?: number}): FeedItem =>
    makeFeedItem(id, createdAt, opts);

  it('appends older backfill past the held tail, so "Load more" still lands while held', () => {
    const a = item('a', 3000), b = item('b', 2000), c = item('c', 1000);
    const older = item('older', 500);
    // onLoadOlderFeed streams history in BELOW the held tail; appending there moves nothing above it.
    expect(holdFeedComposition([a, b, c], [a, b, c, older]).map(i => i.id)).toEqual(['a', 'b', 'c', 'older']);
  });

  /**
   * REGRESSION: backfill that a NON-CHRONOLOGICAL sort ranks above the held tail.
   *
   * The tail test used to be purely positional (`live index > tailIndex`), which quietly assumes the
   * live order is chronological — true only under `sort: 'new'`. The persisted default is 'hot', and
   * Hot/Rising rank on vote+comment velocity and all-time score, so a backfilled OLD post can
   * out-rank a decaying held row and land in the MIDDLE of the live order. That matched neither the
   * ownNew branch (no sortAt) nor the tail branch, so it was dropped from the composition entirely —
   * not deferred, gone. The user-visible damage was not a missing card (the reader is scrolled away)
   * but a dead "Load more": displayArranged never grew, so hasMoreFeed stayed false and every
   * further scroll to the bottom fired another onLoadOlderFeed for history the list could not show.
   */
  it('appends backfill that a HOT re-score ranks ABOVE the held tail (not just past it)', () => {
    const top = item('top', 3000, {score: 100});
    const mid = item('mid', 2000, {score: 50});
    const weak = item('weak', 1000, {score: 1});
    // Month-old, but a big all-time score — Hot puts it between mid and weak, above the held tail.
    const oldButHot = item('old-but-hot', 500, {score: 80});
    expect(holdFeedComposition([top, mid, weak], [top, mid, oldButHot, weak]).map(i => i.id))
      .toEqual(['top', 'mid', 'weak', 'old-but-hot']);
  });

  it('appends backfill ranked above EVERY held row, and keeps several in live order', () => {
    const a = item('a', 3000), b = item('b', 2000);
    const hot1 = item('hot-old-1', 900), hot2 = item('hot-old-2', 800);
    // Both older than the whole held page, both re-scored to the very top by Hot.
    expect(holdFeedComposition([a, b], [hot1, hot2, a, b]).map(i => i.id))
      .toEqual(['a', 'b', 'hot-old-1', 'hot-old-2']);
  });

  it('still BUFFERS a genuinely new arrival that a re-score drops into the middle', () => {
    const a = item('a', 3000), b = item('b', 2000), c = item('c', 1000);
    // Newer than the whole held page, so it is an arrival and not backfill, wherever Hot ranks it.
    const arrival = item('fresh', 9000);
    const held = [a, b, c];
    const out = holdFeedComposition(held, [a, arrival, b, c]);
    expect(out.map(i => i.id)).toEqual(['a', 'b', 'c']);
    // …and with nothing to append it is still the SAME array, so FlatList sees no update at all.
    expect(out).toBe(held);
  });

  it('grows the rendered list under HOT when older history streams in mid-order', () => {
    // End to end: the symptom is the list not growing, which is what kills the "Load more" footer.
    const top = makeFeedItem('top', 3000, {score: 100});
    const mid = makeFeedItem('mid', 2000, {score: 50});
    const weak = makeFeedItem('weak', 1000, {score: 1});
    const oldButHot = makeFeedItem('old-but-hot', 500, {score: 80});
    const {tree, update} = renderScreen({feed: {items: [top, mid, weak], log: []}});
    // Rising ⇒ sort 'hot', the app's persisted default in the field. Without this the tree mounts on
    // the fresh-slot 'new' default, where the backfill sorts to the bottom on its own and the bug
    // cannot appear at all. Tapped BEFORE the scroll, since a sort change legitimately drops the hold.
    tapChip(tree, 'Rising');
    scrollFeedTo(tree, 800); // resting scrolled away — exactly the state the hold targets
    const before = feedItems(tree).length;

    update({feed: {items: [top, mid, oldButHot, weak], log: []}}); // onLoadOlderFeed's page lands

    expect(feedItems(tree).length).toBe(before + 1);
    expect(ids(tree)).toContain('old-but-hot');
    expect(ids(tree).slice(0, 3)).toEqual(['top', 'mid', 'weak']); // nothing above it moved
  });

  it('returns the SAME array when a background arrival changes nothing the reader can see', () => {
    const a = item('a', 3000), b = item('b', 2000);
    const held = [a, b];
    expect(holdFeedComposition(held, [item('new', 9000), a, b])).toBe(held);
  });

  it('keeps a held row that has vanished from the live snapshot rather than splicing it out', () => {
    const a = item('a', 3000), b = item('b', 2000), c = item('c', 1000);
    // b muted/hidden mid-read: dropping it reflows just as visibly as inserting one would.
    expect(holdFeedComposition([a, b, c], [a, c]).map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('holds nothing at all once the live feed is empty (a replacement, not an arrival)', () => {
    const a = item('a', 3000);
    expect(holdFeedComposition([a], [])).toEqual([]);
  });

  it('never buffers an own post, wherever the live order puts it', () => {
    const a = item('a', 3000), b = item('b', 2000);
    const mine = item('mine', 1500, {sortAt: Date.now()});
    expect(holdFeedComposition([a, b], [a, b, mine]).map(i => i.id)).toEqual(['mine', 'a', 'b']);
  });
});

/**
 * REGRESSION GUARD for the hold's own new state. `feedHeld` is written from a per-scroll-frame
 * callback AND from an effect keyed on `feed.items` — the exact boundary that already shipped a
 * silent infinite render loop through `onMarkFeedSeen` (see MainScreen.newPostsPill.test.tsx's
 * regression describe for why React's update-depth guard never fires on this app's legacy root). The
 * setter self-guards on a ref mirror; these pin that it stays that way.
 */
describe('feed hold — no render feedback loop from the hold itself', () => {
  const RUNAWAY = 25;

  it('a reader resting scrolled away costs no mark and no unbounded update cycle as content streams in', () => {
    const {p1, p2, p3} = fixture();
    let marks = 0;
    const onMarkFeedSeen = (): void => { marks++; };
    const {tree, update} = renderScreen({feed: {items: [p3, p2, p1], log: []}, onMarkFeedSeen});
    expect(marks).toBe(1); // mount baseline, at the top

    scrollFeedTo(tree, 800);
    scrollFeedTo(tree, 805); // still away — neither the mark nor the hold re-dispatches
    for (let i = 0; i < 6; i++) {
      update({feed: {items: [makeFeedItem(`n${i}`, 9000 + i), p3, p2, p1], log: []}});
    }
    expect(marks).toBe(1);
    expect(marks).toBeLessThan(RUNAWAY);
    expect(ids(tree)).toEqual(['p3', 'p2', 'p1']);
  });
});
