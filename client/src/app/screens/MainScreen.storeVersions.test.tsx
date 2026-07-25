/**
 * Bugs #6 / #10 / #11 / #12 — regression tests exercised directly against MainScreen (not just
 * the plumbing). See stiq-client-fixes-architecture-rollout handoff for the root-cause writeups.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {GroupView} from '../../channels/components/GroupView';
import {ChannelView} from '../../channels/components/ChannelView';
import {ChannelPostView} from '../../channels/components/ChannelPostView';
import type {Channel} from '../../channels/channels';
import type {Conversation} from '../../dm/conversations';
import type {Event} from 'nostr-tools/pure';
import type {Profile} from '../../profile/profile';
import {setDockPrefsSlot} from '../dockPrefs';

// Dock presses persist the chosen tab as the launch default (dockPrefs module mirror) — without a
// fresh slot per test, an earlier test's `pressByText('Spaces')` makes the NEXT MainScreen mount
// on the channels tab instead of the feed. Same isolation idiom as LogScreen.hearth.test.tsx.
let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`store-versions-${dockSlotSeq++}`));

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const emptyFeed = {items: [], log: []};

const baseProps: Partial<MainScreenProps> = {
  currentUserPubkey: OWNER,
  isModerator: false,
  sendStatus: new Map(),
  onVote: noop,
  onCreateChannel: noop,
  onPostToChannel: noop,
  onGetThread: () => [],
  onSubmit: noop,
  onSendDm: noop,
};

/** Deep-find every node whose props satisfy `pred`. */
function findAllByProp(
  tree: renderer.ReactTestRenderer,
  pred: (props: Record<string, unknown>) => boolean,
): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => !!n.props && pred(n.props as Record<string, unknown>), {deep: true});
}

/** Press the nearest Pressable ancestor of a Text node whose sole child is exactly `text`. */
function pressByText(tree: renderer.ReactTestRenderer, text: string): void {
  const textNode = findAllByProp(tree, p => p.children === text)[0];
  expect(textNode).toBeDefined();
  let n: renderer.ReactTestInstance | null = textNode ?? null;
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  expect(n).toBeDefined();
  act(() => {
    (n!.props.onPress as () => void)();
  });
}

function safeStringify(tree: renderer.ReactTestRenderer): string {
  return JSON.stringify(
    tree.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

function channelMessage(id: string, content: string): Event {
  return {id, pubkey: OWNER, created_at: 1, kind: 1311, tags: [['a', 'ch1']], content, sig: 's'};
}

describe('bug #6 — channel/group memos key on storeVersions, not `feed` identity', () => {
  const channels: Channel[] = [{id: 'ch1', owner: OWNER, name: 'General'}];

  it('channelMsgs recomputes when storeVersions.channels bumps, even with the SAME feed reference', () => {
    let messages: Event[] = [channelMessage('m1', 'msg1-body')];
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch1' ? messages : []));

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          storeVersions={{channels: 0, groups: 0, identity: 0}}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
        />,
      );
    });

    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');
    expect(safeStringify(tree)).toContain('msg1-body');

    // A new message lands, but storeVersions.channels is UNCHANGED and `feed` keeps the SAME
    // reference (exactly what happens for a real LiveChat write — bug #6's root cause). The
    // memoized channelMsgs must NOT pick it up yet.
    messages = [...messages, channelMessage('m2', 'msg2-body')];
    act(() => {
      tree.update(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          storeVersions={{channels: 0, groups: 0, identity: 0}}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
        />,
      );
    });
    expect(safeStringify(tree)).not.toContain('msg2-body');

    // Now storeVersions.channels bumps (what the runtime does the moment the new LiveChat lands) —
    // `feed` is STILL the same reference, proving the memo keys on storeVersions, not feed identity.
    act(() => {
      tree.update(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          storeVersions={{channels: 1, groups: 0, identity: 0}}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
        />,
      );
    });
    expect(safeStringify(tree)).toContain('msg2-body');
  });
});

describe('bugs #10/#11 — DM header/list name via onGetProfile (onGetDisplayName removed)', () => {
  it('the unified channel/group/DM list shows a DM row name from onGetProfile', () => {
    const conversation: Conversation = {
      peer: PEER,
      peerNpub: 'npub1' + 'x'.repeat(58),
      messages: [],
      lastAt: 5,
      preview: 'hey there',
    };
    const onGetProfile = jest.fn(
      (pk: string) => (pk === PEER ? ({name: 'Alice', gradient: undefined} as Profile) : ({} as Profile)),
    );

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[conversation]}
          channels={[]}
          onGetChannelMessages={() => []}
          onGetProfile={onGetProfile}
        />,
      );
    });
    pressByText(tree, 'Spaces');
    expect(safeStringify(tree)).toContain('Alice');
  });
});

describe('bug #12 — openEmbedTarget resolves a channel-message embed and navigates there', () => {
  it('a tapped embed pointing at a cached channel (kind-1311) message opens that channel + leaves the feed', () => {
    const channels: Channel[] = [{id: 'ch1', owner: OWNER, name: 'General'}];
    const msg = channelMessage('embedded-id', 'the-embedded-broadcast');
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch1' ? [msg] : []));

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
          onGetEvent={() => null} // unresolved via the generic lookup — forces the channel-scan fallback
        />,
      );
    });

    // Confirm we start on the feed tab (FeedList mounted).
    expect(tree.root.findAllByType(FeedList)).toHaveLength(1);

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)('embedded-id');
    });

    // Navigation left the feed for the channel. Post-Phase 4.1 the FeedList STAYS mounted inside
    // its (now hidden + untouchable) tab layer — assert the layer is hidden rather than unmounted.
    const feedLayer = tree.root.findAll(
      n => n.props?.testID === 'tab-layer-feed' && typeof n.props?.pointerEvents === 'string',
    )[0]!;
    expect(feedLayer.props.pointerEvents).toBe('none');
    expect(safeStringify(tree)).toContain('the-embedded-broadcast');
  });
});

describe('finding #1 — GroupView/ChannelView embed-reference taps route through the unified resolver', () => {
  it('a group message embed pointing at a cached channel (kind-1311) message opens that channel + leaves the group', () => {
    const channels: Channel[] = [{id: 'ch1', owner: OWNER, name: 'General'}];
    const groups = [{id: 'g1', name: 'Builders', memberCount: 2, isAdmin: false}];
    const msg = channelMessage('embedded-id', 'the-embedded-broadcast');
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch1' ? [msg] : []));
    const groupMsgs: Event[] = [
      {id: 'gm1', pubkey: OWNER, created_at: 1, kind: 9, tags: [['h', 'g1']], content: 'hello group', sig: 's'},
    ];
    const onGetGroupMessages = jest.fn((id: string) => (id === 'g1' ? groupMsgs : []));

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          groups={groups}
          onGetChannelMessages={onGetChannelMessages}
          onGetGroupMessages={onGetGroupMessages}
          onGetEvent={() => null} // unresolved via the generic lookup — forces the channel-scan fallback
        />,
      );
    });

    pressByText(tree, 'Spaces');
    pressByText(tree, 'Builders');
    expect(tree.root.findAllByType(GroupView)).toHaveLength(1);

    // Before the fix, GroupView's onOpenRef set openChannelPostId directly — dead while a GROUP
    // (not a channel) is open, since nothing reads that state without openChannelId also being set.
    const groupView = tree.root.findByType(GroupView);
    act(() => {
      (groupView.props.onOpenRef as (id: string) => void)('embedded-id');
    });

    // Navigation left the group for the channel + landed on the single-post overlay.
    expect(tree.root.findAllByType(GroupView)).toHaveLength(0);
    expect(tree.root.findAllByType(ChannelPostView)).toHaveLength(1);
    expect(tree.root.findByType(ChannelPostView).props.message.id).toBe('embedded-id');
    expect(safeStringify(tree)).toContain('the-embedded-broadcast');
  });

  it('a reference tap for a message OUTSIDE the currently open channel opens the OTHER channel instead of silently doing nothing', () => {
    const ch1Msg = channelMessage('m1', 'ch1-post');
    const ch2Msg: Event = {id: 'other-id', pubkey: OWNER, created_at: 2, kind: 1311, tags: [['a', 'ch2']], content: 'ch2-post', sig: 's'};
    const channels: Channel[] = [
      {id: 'ch1', owner: OWNER, name: 'General'},
      {id: 'ch2', owner: OWNER, name: 'Announcements'},
    ];
    const onGetChannelMessages = jest.fn((id: string) => {
      if (id === 'ch1') return [ch1Msg];
      if (id === 'ch2') return [ch2Msg];
      return [];
    });

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
          onGetEvent={() => null}
        />,
      );
    });

    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');
    expect(tree.root.findByType(ChannelView).props.channel.id).toBe('ch1');

    // Before the fix this set openChannelPostId directly; channelMsgs.find('other-id') misses
    // (it's ch2's message, not ch1's), so the single-post overlay silently rendered nothing.
    act(() => {
      (tree.root.findByType(ChannelView).props.onOpenRef as (id: string) => void)('other-id');
    });

    expect(tree.root.findByType(ChannelView).props.channel.id).toBe('ch2');
    expect(safeStringify(tree)).toContain('ch2-post');
  });
});

describe('bug #3 — scroll-back pagination wrappers wired with the right ids/timestamps', () => {
  /** The first FlatList-shaped node exposing onEndReached over an array `data` prop, scoped to the
   * open sub-screen — post-Phase 4.1 the (hidden) feed layer keeps its own FlatList mounted, so an
   * unscoped tree-wide search would grab the feed's list instead of the channel/group one. */
  function findEndReachable(within: renderer.ReactTestInstance): renderer.ReactTestInstance {
    return within.findAll(
      n => typeof n.props.onEndReached === 'function' && Array.isArray(n.props.data),
    )[0]!;
  }

  it('ChannelView.onLoadOlder calls onLoadOlderChannelPage with the channel id + oldest cached created_at', () => {
    const channels: Channel[] = [{id: 'ch1', owner: OWNER, name: 'General'}];
    const messages = [channelMessage('m1', 'older'), channelMessage('m2', 'newer')];
    messages[0]!.created_at = 100;
    messages[1]!.created_at = 200;
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch1' ? messages : []));
    const onLoadOlderChannelPage = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={onGetChannelMessages}
          onLoadOlderChannelPage={onLoadOlderChannelPage}
        />,
      );
    });
    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');

    act(() => {
      (findEndReachable(tree.root.findByType(ChannelView)).props.onEndReached as () => void)();
    });
    expect(onLoadOlderChannelPage).toHaveBeenCalledWith('ch1', 100);
  });

  it('GroupView.onLoadOlder calls onLoadOlderGroupPage with the group id + oldest cached created_at', () => {
    const groups = [{id: 'g1', name: 'Builders', memberCount: 2, isAdmin: false}];
    const messages: Event[] = [
      {id: 'm1', pubkey: OWNER, created_at: 50, kind: 9, tags: [['h', 'g1']], content: 'older', sig: 's'},
      {id: 'm2', pubkey: OWNER, created_at: 150, kind: 9, tags: [['h', 'g1']], content: 'newer', sig: 's'},
    ];
    const onGetGroupMessages = jest.fn((id: string) => (id === 'g1' ? messages : []));
    const onLoadOlderGroupPage = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          groups={groups}
          onGetChannelMessages={() => []}
          onGetGroupMessages={onGetGroupMessages}
          onLoadOlderGroupPage={onLoadOlderGroupPage}
        />,
      );
    });
    pressByText(tree, 'Spaces');
    pressByText(tree, 'Builders');

    act(() => {
      (findEndReachable(tree.root.findByType(GroupView)).props.onEndReached as () => void)();
    });
    expect(onLoadOlderGroupPage).toHaveBeenCalledWith('g1', 50);
  });

  it('the feed calls onLoadOlderFeed once the cached slice is exhausted (hasMoreFeed false)', () => {
    const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
    const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
    const item = toFeedItem({
      ...buildPost('hello feed body', []),
      id: 'p1',
      pubkey: OWNER,
      created_at: 42,
      sig: 's',
    } as Event);
    const onLoadOlderFeed = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [item], log: []}}
          inbox={[]}
          channels={[]}
          onGetChannelMessages={() => []}
          onLoadOlderFeed={onLoadOlderFeed}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    // Only one cached item and the default page size (25) already covers it — hasMoreFeed is false,
    // so onEndReached must fall through to streaming older relay history instead of a no-op.
    act(() => {
      (feedList.props.onEndReached as () => void)();
    });
    expect(onLoadOlderFeed).toHaveBeenCalledWith(42);
  });
});
