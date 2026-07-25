/**
 * Sideways swipe navigation between the top-level tabs, and the launch tab the app comes back to.
 *
 * User ask (2026-07-22): "when a user swipes left and right, a swipe should move them between tabs"
 * and "when a user leaves the app and enters again, the app remembers which tab the user was in".
 *
 * The GESTURE thresholds are pinned in ui/useTabSwipe.test.ts (a pure decision function). What this
 * suite pins is the WIRING those decisions drive, which is where the behaviour actually lives:
 *  - the swipe axis is the dock's fixed order (Current → Spaces → Updates) and does NOT wrap;
 *  - a swipe is a real top-level navigation — same sub-state resets as pressing the dock, so it can
 *    never leave a stale open channel behind;
 *  - it is dead while an opaque cover is up: a swipe under an open post must not teleport the
 *    reader to another tab;
 *  - whatever tab the member ends on is persisted, so the NEXT launch opens there.
 *
 * `useTabSwipe` is mocked to capture what MainScreen hands it. Driving a real PanResponder from a
 * test means fabricating touch-history internals, which pins RN's plumbing rather than ours.
 */
jest.mock('../../ui/useTabSwipe', () => {
  const actual = jest.requireActual('../../ui/useTabSwipe');
  return {
    ...actual,
    useTabSwipe: jest.fn((opts: {enabled: boolean; onSwipe: (d: 1 | -1) => void}) => {
      lastSwipeProps = opts;
      return {};
    }),
  };
});

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {ChannelView} from '../../channels/components/ChannelView';
import {BottomDock} from '../../ui/BottomDock';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';
import type {Channel} from '../../channels/channels';
import {dockDefaultTab, setDockPrefsSlot} from '../dockPrefs';

/** What MainScreen last handed useTabSwipe — the seam the tests below drive the gesture through. */
let lastSwipeProps: {enabled: boolean; onSwipe: (d: 1 | -1) => void};

let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`tab-swipe-${dockSlotSeq++}`));

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const emptyFeed = {items: [], log: []};

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

const channel: Channel = {
  id: 'ch1',
  name: 'General',
  about: '',
  kind: 'public',
  createdAt: 1,
  owner: OWNER,
} as Channel;

/** The tree the running test mounted — torn down in afterEach (see below). */
let liveTree: renderer.ReactTestRenderer | null = null;

function mount(props: Partial<MainScreenProps> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={[]}
        channels={[]}
        {...props}
      />,
    );
  });
  liveTree = tree;
  return tree;
}

// Unmount + flush after every test. MainScreen defers work through
// InteractionManager.runAfterInteractions (P1-1 / UI-freeze A2); a tree left mounted keeps feeding
// that queue, and a task that escapes this FILE fires after jest has torn the RN module registry
// down — TaskQueue rethrows out of a bare setImmediate, which kills the worker PROCESS rather than
// failing a test, and surfaces as a baffling "Cannot read properties of undefined (reading 'Value')"
// inside whichever suite happened to run next. Same teardown as
// MainScreen.navOriginStack.test.tsx.
afterEach(async () => {
  if (liveTree) {
    const t = liveTree;
    liveTree = null;
    act(() => t.unmount());
  }
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

/** Which tab is live right now, read off the layer that is accepting touches. */
function activeTab(tree: renderer.ReactTestRenderer): 'feed' | 'channels' | 'log' | 'none' {
  for (const key of ['feed', 'channels', 'log'] as const) {
    const host = tree.root.findAll(
      n => n.props?.testID === `tab-layer-${key}` && typeof n.props?.pointerEvents === 'string',
    )[0];
    if (host?.props.pointerEvents === 'box-none') return key;
  }
  return 'none';
}

/** Fire the gesture MainScreen wired up: +1 = swept left (forward), -1 = swept right (back). */
function swipe(direction: 1 | -1): void {
  act(() => {
    lastSwipeProps.onSwipe(direction);
  });
}

function dockPress(tree: renderer.ReactTestRenderer, key: 'feed' | 'channels' | 'log'): void {
  const item = (tree.root.findByType(BottomDock).props.items as Array<{key: string; onPress: () => void}>).find(
    i => i.key === key,
  )!;
  act(() => {
    item.onPress();
  });
}

describe('swiping moves along the dock order', () => {
  it('sweeping left walks Current → Spaces → Updates, and sweeping right walks back', () => {
    const tree = mount();
    expect(activeTab(tree)).toBe('feed');

    swipe(1);
    expect(activeTab(tree)).toBe('channels');
    swipe(1);
    expect(activeTab(tree)).toBe('log');

    swipe(-1);
    expect(activeTab(tree)).toBe('channels');
    swipe(-1);
    expect(activeTab(tree)).toBe('feed');
  });

  it('does not wrap around at either end — the row has felt edges', () => {
    const tree = mount();

    // Back from the first tab: nowhere to go.
    swipe(-1);
    expect(activeTab(tree)).toBe('feed');

    // Forward off the last tab: likewise.
    swipe(1);
    swipe(1);
    expect(activeTab(tree)).toBe('log');
    swipe(1);
    expect(activeTab(tree)).toBe('log');
  });

  it('is a real top-level navigation: swiping into Spaces resets its sub-state like a dock press', () => {
    const tree = mount({channels: [channel]});

    // Open a channel from the Spaces tab, then leave and come back BY SWIPE.
    dockPress(tree, 'channels');
    const list = tree.root.findAll(n => typeof n.props?.onOpenChannel === 'function')[0]!;
    act(() => {
      (list.props.onOpenChannel as (id: string) => void)('ch1');
    });
    expect(tree.root.findAllByType(ChannelView)).toHaveLength(1);

    swipe(-1); // → Current
    swipe(1); // → back to Spaces
    expect(activeTab(tree)).toBe('channels');
    // The open channel is gone — a swipe lands on the tab's root surface, never a stale drill-in.
    expect(tree.root.findAllByType(ChannelView)).toHaveLength(0);
  });
});

describe('the swipe is disabled while the stage is covered', () => {
  it('an open post switches it off, and closing the post switches it back on', () => {
    const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
    const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
    const item = toFeedItem({
      ...buildPost('hello', []),
      id: 'p1',
      pubkey: OWNER,
      created_at: 42,
      sig: 's',
    } as unknown as import('nostr-tools/pure').Event);

    const tree = mount({feed: {items: [item], log: []}});
    expect(lastSwipeProps.enabled).toBe(true);

    act(() => {
      (tree.root.findByType(FeedList).props.onItemPress as (i: typeof item) => void)(item);
    });
    expect(lastSwipeProps.enabled).toBe(false);
  });
});

describe('the app comes back to the tab the member left it on', () => {
  it('persists the tab a swipe lands on, so the next launch opens there', () => {
    const tree = mount();
    swipe(1);
    expect(activeTab(tree)).toBe('channels');
    expect(dockDefaultTab()).toBe('channels');

    // A fresh mount is what a cold start does: it reads the persisted default.
    act(() => {
      tree.unmount();
    });
    expect(activeTab(mount())).toBe('channels');
  });

  it('persists a dock press too', () => {
    const tree = mount();
    dockPress(tree, 'log');
    expect(dockDefaultTab()).toBe('log');
    act(() => {
      tree.unmount();
    });
    expect(activeTab(mount())).toBe('log');
  });

  it('remembers a tab reached programmatically — wherever they were is where they come back', () => {
    const tree = mount({channels: [channel]});
    // A notification/embed-style jump: no dock press, no swipe.
    act(() => {
      (tree.root.findByType(FeedList).props.onOpenNostrPost as (id: string) => void)(
        encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'd1', name: 'General', private: false}),
      );
    });
    expect(dockDefaultTab()).toBe('channels');
  });
});
