jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import {FlatList} from 'react-native';
import {getAnimatedStyle} from 'react-native-reanimated';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {BottomDock} from '../../ui/BottomDock';
import {BackButton} from '../../ui/BackButton';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';
import {setDockPrefsSlot} from '../dockPrefs';

/**
 * Tab-switch scroll survival — Phase 4.1 (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) upgraded the
 * old FIX 2 save/restore into the STRONGER property this suite now asserts: the tab bodies never
 * unmount on a dock press at all (TabLayer keeps them mounted, hidden via opacity — never
 * display:none, which resets Android FlatList offsets), so the native scroll position survives by
 * construction and NO programmatic re-scroll happens on tab-return. FIX 3 is unchanged: the
 * jump-to-top bubble is re-derived pre-paint from the same offset ref the moment the feed tab
 * becomes current.
 */

const noop = (): void => undefined;

// MainScreen persists whatever tab it lands on as the launch default (dockPrefs module mirror), and
// this suite switches tabs in every test — so each one gets its own slot, or the previous test's
// last tab becomes the next mount's starting tab. Same idiom as MainScreen.storeVersions.test.tsx.
let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`tab-scroll-restore-${dockSlotSeq++}`));

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

const emptyFeed = {items: [], log: []};

function dockPress(tree: renderer.ReactTestRenderer, key: 'feed' | 'channels' | 'log'): void {
  const dock = tree.root.findByType(BottomDock);
  const item = (dock.props.items as Array<{key: string; onPress: () => void}>).find(i => i.key === key)!;
  act(() => { item.onPress(); });
}

function scrollFeedTo(tree: renderer.ReactTestRenderer, y: number): void {
  const list = tree.root.findByType(FeedList);
  act(() => {
    (list.props.onScroll as (e: unknown) => void)({nativeEvent: {contentOffset: {y}}});
  });
}

function tabLayer(tree: renderer.ReactTestRenderer, id: string): renderer.ReactTestInstance {
  const host = tree.root.findAll(
    n => n.props?.testID === id && typeof n.props?.pointerEvents === 'string',
  )[0];
  if (!host) throw new Error(`tab layer ${id} not mounted`);
  return host;
}

/** The stage's painted opacity right now, via reanimated's jest side-channel (host node only —
 * the composite Animated.View forwards the same testID). Undefined = never animated = 1. */
function stageOpacity(tree: renderer.ReactTestRenderer): number {
  const host = tree.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === 'tab-stage',
  )[0];
  if (!host) throw new Error('tab stage not mounted');
  const o = (getAnimatedStyle(host) as {opacity?: unknown}).opacity;
  return Number(o ?? 1);
}

afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  jest.restoreAllMocks();
});

describe('MainScreen tab-switch scroll survival (Phase 4.1) + stale jump bubble (FIX 3)', () => {
  it('keeps the FeedList mounted (hidden, untouchable) across a dock round-trip and never re-scrolls programmatically', async () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(noop);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
      );
    });

    // The list's first content measurement after its ONE real mount consumes the one-shot restore
    // (a no-op at offset 0) — on device this fires right after mount; the test renderer never
    // fires layout events on its own, so replay it here to match reality.
    act(() => {
      tree.root.findByType(FlatList).props.onContentSizeChange();
    });
    expect(scrollToOffset).not.toHaveBeenCalled();

    // Scroll the feed well past the old restore/jump threshold.
    scrollFeedTo(tree, 300);
    expect(scrollToOffset).not.toHaveBeenCalled(); // a LIVE scroll never programmatically re-scrolls

    // Leave the feed tab: the list must STAY mounted — hidden by opacity, never display:none
    // (Android resets a FlatList's offset when display'd away), and untouchable.
    dockPress(tree, 'channels');
    expect(tree.root.findAllByType(FeedList)).toHaveLength(1);
    const hiddenFeed = tabLayer(tree, 'tab-layer-feed');
    expect(hiddenFeed.props.pointerEvents).toBe('none');
    const flat = Object.assign(
      {},
      ...[hiddenFeed.props.style].flat(Infinity).filter(Boolean),
    ) as Record<string, unknown>;
    expect(flat.opacity).toBe(0);
    expect(flat.display).toBeUndefined();

    // Return: same mounted list, native offset intact — so NO programmatic restore may fire, not
    // even via a later content measurement (the one-shot restore only ever ran on a real mount).
    dockPress(tree, 'feed');
    expect(tree.root.findAllByType(FeedList)).toHaveLength(1);
    expect(tabLayer(tree, 'tab-layer-feed').props.pointerEvents).toBe('box-none');
    act(() => {
      tree.root.findByType(FlatList).props.onContentSizeChange();
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('shows the jump-to-top bubble immediately on tab-return when the live offset is past the threshold', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(noop);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
      );
    });

    scrollFeedTo(tree, 300);
    // The feed's return-to-top control is the dock row's ↑ bubble now — assert via the jump prop
    // MainScreen hands the dock (same signal that drives the bubble's mount/animation).
    expect(tree.root.findByType(BottomDock).props.jump?.visible).toBe(true);

    dockPress(tree, 'channels');
    dockPress(tree, 'feed');

    // Re-derived synchronously (pre-paint) from the same offset ref (FIX 3) — the bubble is never
    // left describing a position the list isn't at.
    expect(tree.root.findByType(BottomDock).props.jump?.visible).toBe(true);
  });

  it('hides the jump-to-top bubble on tab-return when the feed sits at the top', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
      );
    });

    // Never scrolled — feedScrollYRef stays at its initial 0.
    expect(tree.root.findByType(BottomDock).props.jump?.visible).toBe(false);

    dockPress(tree, 'channels');
    dockPress(tree, 'feed');

    expect(tree.root.findByType(BottomDock).props.jump?.visible).toBe(false);
  });
});

/**
 * Stage crossfade arming (flicker/latency fix, 2026-07-22 follow-up round).
 *
 * THE BUG (user, verbatim): "the delay between click and action increased … the screen for a
 * moment flickers to another screen, then opens the targeted screen". The stage fade used to fire
 * on EVERY `tab` change — including programmatic jumps like a hearth pick or an embed card — which
 * blanked the app for 260 ms and let the target tab's bare list show through while the destination
 * sub-screen mounted. The rule pinned here: the crossfade is a DOCK-GESTURE affordance. Dock
 * presses fade; programmatic navigation lands instantly, fully opaque.
 */
describe('stage crossfade fires only on dock presses', () => {
  it('a dock press crossfades the stage (dips to transparent, recovers to opaque)', async () => {
    jest.useFakeTimers();
    try {
      let tree!: renderer.ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(
          <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
        );
      });
      expect(stageOpacity(tree)).toBe(1);

      dockPress(tree, 'channels');
      // Reanimated lands style writes on animation frames (timer-backed under jest), so step one
      // 16 ms frame: the fade must now be mid-flight — visibly below opaque…
      act(() => {
        jest.advanceTimersByTime(16);
      });
      expect(stageOpacity(tree)).toBeLessThan(1);
      // …and recovers to opaque once the 260 ms timing completes (frames are fake-timer driven).
      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(stageOpacity(tree)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a programmatic cross-tab jump lands instantly — the stage never dips', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
      );
    });

    // An embed-card tap is the canonical programmatic jump: feed → channels + open the target.
    const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd1', name: 'General', private: false});
    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    // Tab DID switch (the feed layer is now the hidden one) — with no fade-out at any point.
    expect(tabLayer(tree, 'tab-layer-feed').props.pointerEvents).toBe('none');
    expect(stageOpacity(tree)).toBe(1);
  });

  it('re-pressing the ACTIVE dock tab never arms a fade for a later programmatic jump', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={emptyFeed} inbox={[]} channels={[]} />,
      );
    });

    // Re-press the tab we are already on: no tab change, so no fade may arm…
    dockPress(tree, 'feed');
    expect(stageOpacity(tree)).toBe(1);

    // …and the NEXT tab change — a programmatic one — must not consume a stale armed flag.
    const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd2', name: 'Other', private: false});
    act(() => {
      (tree.root.findByType(FeedList).props.onOpenNostrPost as (id: string) => void)(token);
    });
    expect(tabLayer(tree, 'tab-layer-feed').props.pointerEvents).toBe('none');
    expect(stageOpacity(tree)).toBe(1);
  });
});

/**
 * Covered tab bodies (tap-latency fix, 2026-07-22 follow-up round 2).
 *
 * THE BUG (user): "clicking a post seems like is taking a long time between click and open".
 * Opening any opaque cover (thread overlay, notifications center, composer, …) re-rendered the
 * whole active tab body underneath it in the SAME commit — FeedList's per-render inline lambdas
 * defeat PostCard's memo, so ~10 cards paid RichText re-renders for pixels behind an opaque
 * overlay. TabLayer's `covered` freezes the body in the opening commit itself. The wiring pinned
 * here: a covered layer is untouchable but stays MOUNTED and VISIBLE (no opacity:0 — it peeks
 * through the entrance slide and must be painted the instant the cover closes), and closing the
 * cover restores interactivity.
 */
describe('tab bodies freeze under opaque covers', () => {
  function makeFeedItem(): import('../../feed/feed').FeedItem {
    const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
    const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
    return toFeedItem({
      ...buildPost('hello covered body', []),
      id: 'p1',
      pubkey: 'a'.repeat(64),
      created_at: 42,
      sig: 's',
    } as unknown as import('nostr-tools/pure').Event);
  }

  it('opening a post covers the feed layer (untouchable, still mounted + visible); closing uncovers it', () => {
    const item = makeFeedItem();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen {...(baseProps as MainScreenProps)} feed={{items: [item], log: []}} inbox={[]} channels={[]} />,
      );
    });

    act(() => {
      (tree.root.findByType(FeedList).props.onItemPress as (i: typeof item) => void)(item);
    });

    // Covered: untouchable — but NOT hidden (no opacity:0) and never unmounted.
    const host = tabLayer(tree, 'tab-layer-feed');
    expect(host.props.pointerEvents).toBe('none');
    const flat = Object.assign({}, ...[host.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    expect(flat.opacity).toBeUndefined();
    expect(tree.root.findAllByType(FeedList)).toHaveLength(1);

    // Close the thread (its Back button) — the same commit uncovers and re-activates the feed.
    act(() => {
      (tree.root.findByType(BackButton).props.onPress as () => void)();
    });
    expect(tabLayer(tree, 'tab-layer-feed').props.pointerEvents).toBe('box-none');
    expect(tree.root.findAllByType(FeedList)).toHaveLength(1);
  });
});
