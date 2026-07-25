jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import {BackHandler} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {RootBackScope} from '../../ui/back';
import {FeedList} from '../../feed/components/FeedList';
import {NotificationsScreen} from '../../notifications/NotificationsScreen';
import {ProfileScreen} from '../../profile/components/ProfileScreen';
import {ConversationView} from '../../dm/components/ConversationView';
import {BottomDock} from '../../ui/BottomDock';
import {GroupView} from '../../channels/components/GroupView';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';
import {setDockPrefsSlot} from '../dockPrefs';
import {toFeedItem} from '../../feed/feed';
import {buildPost} from '../../feed/compose';
import type {Event} from 'nostr-tools/pure';
import type {Profile} from '../../profile/profile';
import type {FeedItem} from '../../feed/feed';

/**
 * FIX 1 — generic nav-origin stack: back always means "back", regardless of WHICH surface pushed
 * the return point (notifications, a profile drill-in, the moderator console, a Log-tab hearth
 * pick, an embedded reference tapped from within an already-open surface, …).
 *
 * These tests drive MainScreen directly (not through AppShell), the same pattern
 * MainScreen.spaceEmbed.test.tsx uses, and simulate hardware back the same way
 * MainScreen.backhandler.test.tsx does (capture the registered BackHandler callback and invoke it).
 *
 * The <RootBackScope> wrapper stands in for the one AppShell mounts in the real tree: it owns the
 * app's single BackHandler subscription, so without it MainScreen's back action has nowhere to
 * register and no callback is ever handed to the spy below (ui/back.tsx).
 */

let slotSeq = 0;
const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);

const baseProps: Partial<MainScreenProps> = {
  currentUserPubkey: OWNER,
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

function mkPost(id: string, pubkey: string): FeedItem {
  return toFeedItem({
    ...buildPost('hello feed body', []),
    id,
    pubkey,
    created_at: 100,
    sig: 's',
  } as Event);
}

function profileFor(pubkey: string): Profile {
  return {pubkey, npub: `npub_${pubkey.slice(0, 8)}`, channels: [], posts: [], ideaCount: 0, ideas: []};
}

/** Registers the hardware-back listener (mirrors MainScreen.backhandler.test.tsx) and returns a
 *  callable that simulates a hardware back press, always driving the MOST RECENTLY registered
 *  handler (MainScreen re-registers its closure via a ref, but only ever adds the ONE listener). */
function captureBackHandler(): () => boolean {
  const handlers: Array<() => boolean> = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_evt: string, cb: () => boolean) => {
    handlers.push(cb);
    return {remove: jest.fn()};
  }) as unknown as typeof BackHandler.addEventListener);
  return () => handlers[handlers.length - 1]!();
}

/** Is the Feed tab the one the reader is actually on? (TabLayer marks the covered/inactive layers
 *  untouchable, so `pointerEvents` is the honest read of "this is the live tab".) */
function feedTabLive(tree: renderer.ReactTestRenderer): boolean {
  const layer = tree.root.findAll(
    n => n.props?.testID === 'tab-layer-feed' && typeof n.props?.pointerEvents === 'string',
  )[0]!;
  return layer.props.pointerEvents !== 'none';
}

/** Generalized twin of feedTabLive: which of the three tab layers is actually live right now. */
function activeTabKey(tree: renderer.ReactTestRenderer): 'feed' | 'channels' | 'log' | undefined {
  for (const key of ['feed', 'channels', 'log'] as const) {
    const layer = tree.root.findAll(
      n => n.props?.testID === `tab-layer-${key}` && typeof n.props?.pointerEvents === 'string',
    )[0];
    if (layer && layer.props.pointerEvents !== 'none') return key;
  }
  return undefined;
}

function dockPress(tree: renderer.ReactTestRenderer, key: 'feed' | 'channels' | 'log'): void {
  const dock = tree.root.findByType(BottomDock);
  const item = (dock.props.items as Array<{key: string; onPress: () => void}>).find(i => i.key === key)!;
  act(() => { item.onPress(); });
}

/** The tree the running test built — unmounted in afterEach (see below). */
let liveTree: renderer.ReactTestRenderer | null = null;
function createTree(el: React.ReactElement): renderer.ReactTestRenderer {
  liveTree = renderer.create(el);
  return liveTree;
}

// P1-1 (UI-freeze A2) defers thread-open work via InteractionManager.runAfterInteractions — flush
// it after each test so a pending task can't fire post-teardown (same afterEach as
// MainScreen.spaceEmbed.test.tsx).
//
// UNMOUNT FIRST, though: flushing alone only runs the queued task, and these tests (unlike
// MainScreen.spaceEmbed.test.tsx's) leave their tree mounted, so that task re-renders a live
// MainScreen and can queue another. One escapes the file, fires after jest has torn the RN module
// registry down, and TaskQueue rethrows out of a bare setImmediate — which kills the worker PROCESS
// rather than failing a test (`Animated` is undefined by then, so it surfaces as a mystified
// "Cannot read properties of undefined (reading 'Value')" inside whichever suite ran next).
afterEach(async () => {
  if (liveTree) {
    const t = liveTree;
    liveTree = null;
    act(() => t.unmount());
  }
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  jest.restoreAllMocks();
});

describe('MainScreen nav-origin stack (FIX 1)', () => {
  it('notifications -> post -> back reopens notifications', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [mkPost('p1', AUTHOR)], log: []}}
          inbox={[]}
          channels={[]}
          onGetNotifications={() => []}
        /></RootBackScope>,
      );
    });

    const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
    act(() => { (bell.props.onPress as () => void)(); });
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(true);

    act(() => {
      (tree.root.findByType(NotificationsScreen).props.onSelect as (t: unknown) => void)({kind: 'post', rootId: 'p1'});
    });
    // Selecting closes the notification center and opens the post.
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
    expect(tree.root.findAll(p => p.props.accessibilityLabel === 'Back to Back').length).toBeGreaterThan(0);

    act(() => { back(); });

    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(true);
    expect(tree.root.findAll(p => p.props.accessibilityLabel === 'Back to Back')).toHaveLength(0);
  });

  it('notifications -> DM -> back reopens notifications', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
          onGetNotifications={() => []}
        /></RootBackScope>,
      );
    });

    const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
    act(() => { (bell.props.onPress as () => void)(); });

    act(() => {
      (tree.root.findByType(NotificationsScreen).props.onSelect as (t: unknown) => void)({kind: 'dm', peer: AUTHOR});
    });
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
    expect(tree.root.findByType(ConversationView).props.conversation.peer).toBe(AUTHOR);

    act(() => { back(); });

    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(true);
    expect(tree.root.findAllByType(ConversationView)).toHaveLength(0);
  });

  it('profile -> DM -> back restores profile', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [mkPost('p1', AUTHOR)], log: []}}
          inbox={[]}
          channels={[]}
          onGetProfile={pk => profileFor(pk)}
        /></RootBackScope>,
      );
    });

    // Open the author's profile the way a real tap does — FeedList's onAuthorPress.
    act(() => {
      (tree.root.findByType(FeedList).props.onAuthorPress as (pk: string) => void)(AUTHOR);
    });
    expect(tree.root.findByType(ProfileScreen).props.profile.pubkey).toBe(AUTHOR);

    // Profile -> DM (ProfileScreen's onOpenDM).
    act(() => {
      (tree.root.findByType(ProfileScreen).props.onOpenDM as (pk: string) => void)(AUTHOR);
    });
    expect(tree.root.findAllByType(ProfileScreen)).toHaveLength(0);
    expect(tree.root.findByType(ConversationView).props.conversation.peer).toBe(AUTHOR);

    act(() => { back(); });

    expect(tree.root.findAllByType(ConversationView)).toHaveLength(0);
    expect(tree.root.findByType(ProfileScreen).props.profile.pubkey).toBe(AUTHOR);
  });

  it('a dock press clears the stack so a later, unrelated close cannot mis-restore', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
          onGetNotifications={() => []}
        /></RootBackScope>,
      );
    });

    // Select a notification whose target post can't be resolved yet (aged out of the cache /
    // arriving later) — the push still fires (it happens BEFORE the lookup), but nothing actually
    // opens, so the reader lands back on a bare list with a dangling stack entry underneath.
    const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
    act(() => { (bell.props.onPress as () => void)(); });
    act(() => {
      (tree.root.findByType(NotificationsScreen).props.onSelect as (t: unknown) => void)({kind: 'post', rootId: 'ghost'});
    });
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
    expect(tree.root.findAll(p => p.props.accessibilityLabel === 'Back to Back')).toHaveLength(0);

    // A fresh top-level navigation via the dock — this is what must clear the dangling entry.
    dockPress(tree, 'feed');

    // Now the SAME post id ('ghost') arrives for real and is opened through a completely unrelated,
    // plain in-tab tap (FeedList's onItemPress) — nothing pushes for this open.
    await act(async () => {
      tree.update(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [mkPost('ghost', AUTHOR)], log: []}}
          inbox={[]}
          channels={[]}
          onGetNotifications={() => []}
        /></RootBackScope>,
      );
    });
    act(() => {
      (tree.root.findByType(FeedList).props.onItemPress as (i: FeedItem) => void)(
        tree.root.findByType(FeedList).props.items[0],
      );
    });
    expect(tree.root.findAll(p => p.props.accessibilityLabel === 'Back to Back').length).toBeGreaterThan(0);

    act(() => { back(); });

    // If the stack had NOT been cleared by the dock press, this close would structurally match the
    // dangling {notifications}->{post:'ghost'} entry and wrongly reopen notifications.
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
  });
});

/**
 * CONTRACT RULE 3 (the user's own words, as it applies to the nav-origin stack specifically): "no
 * matter how many BACKs the user clicks, they can only return to the tab they entered from; if they
 * click back in any tab, they leave the app."
 *
 * The bug this pins: a card tapped on a BARE tab root crosses tabs, and `openEmbedTarget` only ever
 * pushed a return point when some SURFACE was already open — so from a bare root it pushed nothing
 * and closing the destination stranded the reader on a tab they never chose. The `tabRoot` origin
 * fixes that; `restoreNavOrigin`'s hard `navStackRef = []` is what stops it becoming a tab-to-tab
 * chain.
 *
 * NOTE (dock-driven tab back-stack, see the describe block below this one): BACK #2 here still
 * returns false because this scenario never visits a tab via a genuine dock press or swipe — the
 * embed hop uses `setTab` directly, which never touches `tabHistoryRef` — so the tab-visit history is
 * empty and there is nothing left to walk back through. A reader who ALSO used the dock to visit
 * other tabs before tapping the embed would see BACK keep walking back through those real visits
 * first; this test's tab history is simply empty throughout, so the old "one hop, then out" behavior
 * for this specific path is unchanged.
 */
describe('one tab hop, then out (contract rule 3)', () => {
  // MainScreen persists whatever tab it lands on as the launch default, and this test jumps
  // cross-tab on purpose — a fresh slot per test keeps the next mount starting on Current.
  beforeEach(() => setDockPrefsSlot(`nav-origin-taproot-${slotSeq++}`));

  it('a cross-tab embed tapped from a bare tab root returns to that tab, and the NEXT back leaves the app', async () => {
    const backPress = captureBackHandler();
    const token = encodeSpaceEmbed({kind: 39000, owner: OWNER, identifier: 'g1', name: 'Builders', private: true});
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
          groups={[{id: 'g1', name: 'Builders', memberCount: 2, isAdmin: false}]}
          onGetNotifications={() => []}
        /></RootBackScope>,
      );
    });

    // Precondition: on Current, nothing open.
    expect(feedTabLive(tree)).toBe(true);

    // Tap an embedded space card — lands in a Spaces group, a tab the reader never chose.
    act(() => {
      (tree.root.findByType(FeedList).props.onOpenNostrPost as (id: string) => void)(token);
    });
    expect(tree.root.findByType(GroupView).props.groupId).toBe('g1');
    expect(feedTabLive(tree)).toBe(false);

    // BACK #1 — closes the group AND undoes the tab hop (previously: stranded on Spaces).
    let first = false;
    act(() => { first = backPress(); });
    expect(first).toBe(true);
    expect(tree.root.findAllByType(GroupView)).toHaveLength(0);
    expect(feedTabLive(tree)).toBe(true);

    // BACK #2 — on a bare tab root there is nothing left to return to, so the press is UNHANDLED
    // and RN's default backgrounds the app. This is the assertion that stops back from ever
    // becoming a tab-to-tab chain.
    let second = true;
    act(() => { second = backPress(); });
    expect(second).toBe(false);
    expect(feedTabLive(tree)).toBe(true);
  });
});

/**
 * DOCK-DRIVEN TAB BACK-STACK — the user's reversal of the old contract: "When a user is in a tab,
 * and clicks the Android back button, it should return them to the previous tab they were at,
 * instead of leaving the app entirely." A genuine forward tab-visit (dock press or stage swipe, both
 * funneled through `selectTab`) now pushes the tab being LEFT onto `tabHistoryRef`; hardware BACK on
 * a bare tab root (nothing left in the overlay ladder above it — see closeInnermostOverlay) pops that
 * stack and hops back to whichever tab it names, and only leaves the app once the stack is empty.
 *
 * Orthogonal to the nav-origin stack / contract-rule-3 tests above: those govern a SURFACE crossing
 * tabs (an embed hop, which calls `setTab` directly and never touches `tabHistoryRef`); these govern
 * the reader's own dock/swipe visits.
 */
describe('dock-driven tab back-stack', () => {
  // Fresh dockPrefs slot per test: MainScreen persists whatever tab it lands on as the launch
  // default, and every test here jumps across tabs on purpose.
  beforeEach(() => setDockPrefsSlot(`tab-backstack-${slotSeq++}`));

  it('Current -> Spaces -> Updates, then BACK walks back through each visited tab before leaving the app', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
        /></RootBackScope>,
      );
    });

    // Fresh slot lands on Current (feed).
    expect(activeTabKey(tree)).toBe('feed');

    dockPress(tree, 'channels'); // Current -> Spaces
    expect(activeTabKey(tree)).toBe('channels');
    dockPress(tree, 'log'); // Spaces -> Updates
    expect(activeTabKey(tree)).toBe('log');

    // BACK #1: Updates -> Spaces.
    let r1 = false;
    act(() => { r1 = back(); });
    expect(r1).toBe(true);
    expect(activeTabKey(tree)).toBe('channels');

    // BACK #2: Spaces -> Current.
    let r2 = false;
    act(() => { r2 = back(); });
    expect(r2).toBe(true);
    expect(activeTabKey(tree)).toBe('feed');

    // BACK #3: tab-visit history exhausted → unhandled, RN default backgrounds the app.
    let r3 = true;
    act(() => { r3 = back(); });
    expect(r3).toBe(false);
    expect(activeTabKey(tree)).toBe('feed');
  });

  it('re-selecting the already-active tab does not push a history entry', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
        /></RootBackScope>,
      );
    });

    expect(activeTabKey(tree)).toBe('feed');
    // Re-pressing the tab already on screen must be a no-op for the history, however many times.
    dockPress(tree, 'feed');
    dockPress(tree, 'feed');
    // One genuine hop.
    dockPress(tree, 'channels');
    expect(activeTabKey(tree)).toBe('channels');

    let r1 = false;
    act(() => { r1 = back(); });
    expect(r1).toBe(true);
    expect(activeTabKey(tree)).toBe('feed');

    // If either re-press above had wrongly pushed, this second BACK would still find an entry
    // (and stay handled) instead of exhausting the stack after exactly one hop.
    let r2 = true;
    act(() => { r2 = back(); });
    expect(r2).toBe(false);
    expect(activeTabKey(tree)).toBe('feed');
  });

  it('a BACK-driven tab switch does not itself get recorded (no ping-pong)', async () => {
    const back = captureBackHandler();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = createTree(
        <RootBackScope><MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
        /></RootBackScope>,
      );
    });

    dockPress(tree, 'channels'); // Current -> Spaces (genuine hop, pushes 'feed')
    expect(activeTabKey(tree)).toBe('channels');

    let r1 = false;
    act(() => { r1 = back(); }); // BACK-driven: Spaces -> Current
    expect(r1).toBe(true);
    expect(activeTabKey(tree)).toBe('feed');

    // If that BACK-driven switch had re-pushed 'channels' onto the history, this very next BACK
    // (with no dock press in between) would bounce right back to Spaces instead of leaving the app.
    let r2 = true;
    act(() => { r2 = back(); });
    expect(r2).toBe(false);
    expect(activeTabKey(tree)).toBe('feed');
  });
});
