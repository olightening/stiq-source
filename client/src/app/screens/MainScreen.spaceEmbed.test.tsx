/**
 * Chunk 3 (MainScreen wiring for `stiq:space:…` tokens) — openEmbedTarget's space-ref branch, the
 * compact request-to-join dialog, and the ChannelDetail "Save to embed" wiring.
 *
 * See stiq-13-bug-megafix handoff (chunk 3 / space embed nav) for the pinned contracts this
 * exercises: client/src/channels/spaceEmbed.ts (encode/parse) and savedEmbeds.ts (save*Embed).
 */
import 'react-native';
import React from 'react';
import {Modal} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {FeedList} from '../../feed/components/FeedList';
import {GroupView} from '../../channels/components/GroupView';
import {ChannelView} from '../../channels/components/ChannelView';
import {ChannelPostView} from '../../channels/components/ChannelPostView';
import {ChannelDetail} from '../../channels/components/ChannelDetail';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';
import type {Channel} from '../../channels/channels';
import {setDockPrefsSlot} from '../dockPrefs';

// MainScreen persists whatever tab it lands on as the launch default (dockPrefs module mirror), and
// these tests navigate cross-tab on purpose — so without a fresh slot per test, an earlier test's
// jump to Spaces makes the NEXT MainScreen mount on the channels tab and the FeedList never mounts.
// Same isolation idiom as MainScreen.storeVersions.test.tsx.
let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`space-embed-${dockSlotSeq++}`));

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
  onSubmit: noop,
  onSendDm: noop,
};

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

// NOTE on RN's jest Modal mock (node_modules/react-native/jest/mockModal.js): a <Modal visible={x}>
// renders `null` (children NOT in the tree at all) whenever `visible` is exactly `false` — matching
// real Modal/Android behavior. So "always-mounted" means the <Modal> ELEMENT stays in the JSX (never
// conditionally `{x && <Modal visible>}`), not that its content is queryable while closed. Content
// assertions below only run once the dialog has been opened (visible === true).

/** Every currently-VISIBLE Modal in the tree (there may be several — GroupView/ChannelView/
 *  ChannelDetail each mount their own internal sheets unconditionally too). */
function visibleModals(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAllByType(Modal).filter(m => m.props.visible === true);
}

/** The one visible Modal whose subtree contains `text` (the join dialog, once opened). */
function visibleModalContaining(tree: renderer.ReactTestRenderer, text: string): renderer.ReactTestInstance {
  const candidates = visibleModals(tree).filter(m => {
    const texts = m.findAll(n => typeof n.children?.[0] === 'string').map(n => n.children![0] as string);
    return texts.some(t => t === text);
  });
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}

/** Post-Phase 4.1, "navigation left the feed" no longer unmounts FeedList — the feed's TabLayer
 * stays mounted, hidden (opacity 0) and untouchable (pointerEvents none). Assert THAT instead. */
function expectFeedLayerHidden(tree: renderer.ReactTestRenderer): void {
  const layer = tree.root.findAll(
    n => n.props?.testID === 'tab-layer-feed' && typeof n.props?.pointerEvents === 'string',
  )[0]!;
  expect(layer.props.pointerEvents).toBe('none');
}

// P1-1 (UI-freeze A2) made the thread view's `threadNodes` fill via a deferred
// InteractionManager.runAfterInteractions(setThreadNodes) instead of a synchronous useMemo. Any test
// that opens a feed post leaves that task pending; if it fires AFTER the test/module has torn down it
// re-renders MainScreen into useScrollChrome with react-native's Animated already gone and crashes
// the jest worker. Flush pending interactions inside act() after each test so the deferred update
// runs while the module is still alive (a harmless no-op when nothing is pending).
afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

describe('openEmbedTarget — stiq:space: public channel token', () => {
  it('opens the channel when its coordinate is already followed', () => {
    const owner = OWNER;
    const channels: Channel[] = [{id: `30311:${owner}:d1`, owner, name: 'General'}];
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd1', name: 'General', private: false});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={() => []}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expectFeedLayerHidden(tree);
    expect(tree.root.findByType(ChannelView).props.channel.id).toBe(`30311:${owner}:d1`);
  });

  it('never silently auto-follows an unknown public channel coordinate on tap (finding 6b)', () => {
    // A tap must never mutate the user's subscriptions without explicit intent — the old
    // best-effort embedSubscribeChannelRef auto-follow-on-tap is gone.
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd9', name: 'Unknown', private: false});
    const onSubscribeChannel = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          onGetChannelMessages={() => []}
          onSubscribeChannel={onSubscribeChannel}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expect(onSubscribeChannel).not.toHaveBeenCalled();
  });

  it('resolves an unknown public channel coordinate by naddr via onGetEvent instead of auto-following (finding 1/6b)', () => {
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd9', name: 'Unknown', private: false});
    const onGetEvent = jest.fn((_id: string) => null);

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          onGetChannelMessages={() => []}
          onGetEvent={onGetEvent}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    // getEvent is called with a bech32 naddr encoding the same {kind,owner,identifier} coordinate —
    // reusing AppRuntime's existing fetch-by-coordinate (fetchNaddr) plumbing rather than a new prop.
    expect(onGetEvent).toHaveBeenCalledTimes(1);
    const calledWith = onGetEvent.mock.calls[0]![0] as string;
    expect(calledWith.startsWith('naddr1')).toBe(true);
  });

  it('shows a loading placeholder (never a blank tab) while an unknown channel is unresolved', () => {
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd9', name: 'Unknown', private: false});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          onGetChannelMessages={() => []}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expect(tree.root.findAllByType(ChannelView)).toHaveLength(0);
    expectFeedLayerHidden(tree);
    expect(safeStringify(tree)).toContain('Opening channel');
  });
});

describe('openEmbedTarget — stiq:space: private group token', () => {
  it('opens the group directly when the viewer is already a member/tracked', () => {
    const owner = OWNER;
    const groups = [{id: 'g1', name: 'Builders', memberCount: 2, isAdmin: false}];
    const token = encodeSpaceEmbed({kind: 39000, owner, identifier: 'g1', name: 'Builders', private: true});

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
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expectFeedLayerHidden(tree);
    expect(tree.root.findByType(GroupView).props.groupId).toBe('g1');
  });

  it('opens the compact request-to-join dialog (carrying the token name) for a non-member', () => {
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 39000, owner, identifier: 'g2', name: 'Secret Society', private: true});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          groups={[]}
          onGetChannelMessages={() => []}
        />,
      );
    });

    // Not opened yet — no Modal in the tree is currently visible.
    expect(visibleModals(tree)).toHaveLength(0);

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expect(tree.root.findAllByType(GroupView)).toHaveLength(0);
    const modal = visibleModalContaining(tree, 'Request to join');
    expect(modal.props.visible).toBe(true);
    expect(safeStringify(tree)).toContain('Secret Society');
    expect(safeStringify(tree)).toContain('Request to join');
  });

  // CONFIRMED root cause (Olene's field incident): the invite DM carries an admin-signed grant, but
  // it also contains a plain `stiq:space:` embed card in the message body with no grant attached —
  // tapping THAT card must not silently discard the grant and fall to a bare request-to-join.
  it('a non-member with an outstanding invite sees "Accept invite", never "Request to join"', () => {
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 39000, owner, identifier: 'g4', name: 'Invited Room', private: true});
    const onAcceptSpaceInvite = jest.fn();
    const onRequestToJoin = jest.fn();
    const inviter = 'b'.repeat(64);

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          groups={[]}
          onGetChannelMessages={() => []}
          onAcceptSpaceInvite={onAcceptSpaceInvite}
          onRequestToJoin={onRequestToJoin}
          spaceInvites={[
            {groupId: 'g4', name: 'Invited Room', kindWord: 'Group chat', memberCount: 1, inviter, at: 100},
          ]}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    expect(
      tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === 'Request to join'),
    ).toHaveLength(0);
    const acceptButton = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && n.children[0] === 'Accept invite',
    )[0]!;
    let btn: renderer.ReactTestInstance | null = acceptButton;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => {
      (btn!.props.onPress as () => void)();
    });

    expect(onAcceptSpaceInvite).toHaveBeenCalledWith('g4');
    expect(onRequestToJoin).not.toHaveBeenCalled();
  });

  it('the dialog\'s button fires the join path and flips to a Requested confirmation', () => {
    const owner = OWNER;
    const token = encodeSpaceEmbed({kind: 39000, owner, identifier: 'g3', name: 'Locked Room', private: true});
    const onJoinGroup = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={[]}
          groups={[]}
          onGetChannelMessages={() => []}
          onJoinGroup={onJoinGroup}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)(token);
    });

    const requestButton = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && n.children[0] === 'Request to join',
    )[0]!;
    let btn: renderer.ReactTestInstance | null = requestButton;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => {
      (btn!.props.onPress as () => void)();
    });

    expect(onJoinGroup).toHaveBeenCalledWith('g3');
    // Query the live instance tree directly (rather than a stringified snapshot) — the request
    // form is gone and the withdrawable "Request sent" pending card has replaced it, in the SAME
    // always-mounted Modal (membership handoff locked preview).
    const textOf = (s: string): renderer.ReactTestInstance[] =>
      tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === s);
    expect(textOf('Request to join')).toHaveLength(0);
    expect(textOf('Withdraw request')).toHaveLength(1);
    expect(
      tree.root.findAll(
        n => typeof n.children?.[0] === 'string' && (n.children![0] as string).includes('Request sent'),
      ),
    ).not.toHaveLength(0);
  });
});

describe('openEmbedTarget — a null space-embed parse falls through to existing behavior', () => {
  it('a plain feed post id (not a stiq:space: token) still opens the feed post directly', () => {
    const {toFeedItem} = jest.requireActual('../../feed/feed') as typeof import('../../feed/feed');
    const {buildPost} = jest.requireActual('../../feed/compose') as typeof import('../../feed/compose');
    const item = toFeedItem({
      ...buildPost('hello feed body', []),
      id: 'p1',
      pubkey: OWNER,
      created_at: 42,
      sig: 's',
    } as unknown as import('nostr-tools/pure').Event);

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [item], log: []}}
          inbox={[]}
          channels={[]}
          onGetChannelMessages={() => []}
        />,
      );
    });

    const feedList = tree.root.findByType(FeedList);
    act(() => {
      (feedList.props.onOpenNostrPost as (id: string) => void)('p1');
    });

    expect(safeStringify(tree)).toContain('hello feed body');
  });
});

describe('ChannelPostView onOpenRef wiring from MainScreen (finding 2)', () => {
  it('a card embedded in the open post routes an in-channel target to the single-post overlay, and an out-of-channel target through openEmbedTarget', () => {
    const owner = OWNER;
    const coord = `30311:${owner}:d1`;
    const channels: Channel[] = [{id: coord, owner, name: 'General'}];
    const m1: Event = {id: '1'.repeat(64), pubkey: owner, created_at: 100, kind: 1311, tags: [], content: 'first message', sig: 's'};
    const m1Ref = nip19.neventEncode({id: m1.id});
    const m2: Event = {
      id: '2'.repeat(64), pubkey: owner, created_at: 200, kind: 1311, tags: [],
      content: `see also nostr:${m1Ref}`, sig: 's',
    };
    const messages = [m1, m2];

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={() => messages}
        />,
      );
    });

    // Channels tab → open the channel → open m2 as the single-post overlay.
    const channelsTab = tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === 'Spaces')[0]!;
    let tabBtn: renderer.ReactTestInstance | null = channelsTab;
    while (tabBtn && typeof tabBtn.props.onPress !== 'function') tabBtn = tabBtn.parent;
    act(() => { (tabBtn!.props.onPress as () => void)(); });

    const generalRow = tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === 'General')[0]!;
    let rowBtn: renderer.ReactTestInstance | null = generalRow;
    while (rowBtn && typeof rowBtn.props.onPress !== 'function') rowBtn = rowBtn.parent;
    act(() => { (rowBtn!.props.onPress as () => void)(); });

    act(() => { (tree.root.findByType(ChannelView).props.onOpenMessage as (id: string) => void)(m2.id); });
    expect(tree.root.findByType(ChannelPostView).props.message.id).toBe(m2.id);

    // Tap the embedded card (m1's ref) inside m2's ChannelPostView → an IN-CHANNEL hit re-targets
    // the same single-post overlay onto m1, rather than falling through to openEmbedTarget.
    act(() => { (tree.root.findByType(ChannelPostView).props.onOpenRef as (id: string) => void)(m1.id); });
    expect(tree.root.findByType(ChannelPostView).props.message.id).toBe(m1.id);

    // A target NOT in this channel's messages falls through to the shared resolver (openEmbedTarget)
    // instead of re-targeting the overlay onto a message that doesn't exist here.
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd9', name: 'Other', private: false});
    act(() => { (tree.root.findByType(ChannelPostView).props.onOpenRef as (id: string) => void)(token); });
    // openEmbedTarget resolves the space token to a DIFFERENT (unknown) channel coordinate — the
    // single-post overlay for the original channel is gone (we navigated away from it).
    expect(tree.root.findAllByType(ChannelPostView)).toHaveLength(0);
  });
});

describe('ChannelDetail onSaveToEmbed — saves the currently-open channel as a space embed', () => {
  it('is wired to the ChannelDetail mount and is a function', () => {
    const owner = OWNER;
    const channels: Channel[] = [{id: `30311:${owner}:d1`, owner, name: 'General'}];

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={() => []}
        />,
      );
    });

    // Navigate: Channels tab → open channel → open detail sheet.
    const channelsTab = tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === 'Spaces')[0]!;
    let tabBtn: renderer.ReactTestInstance | null = channelsTab;
    while (tabBtn && typeof tabBtn.props.onPress !== 'function') tabBtn = tabBtn.parent;
    act(() => { (tabBtn!.props.onPress as () => void)(); });

    const generalRow = tree.root.findAll(n => typeof n.children?.[0] === 'string' && n.children[0] === 'General')[0]!;
    let rowBtn: renderer.ReactTestInstance | null = generalRow;
    while (rowBtn && typeof rowBtn.props.onPress !== 'function') rowBtn = rowBtn.parent;
    act(() => { (rowBtn!.props.onPress as () => void)(); });

    act(() => { (tree.root.findByType(ChannelView).props.onOpenDetail as () => void)(); });

    expect(typeof tree.root.findByType(ChannelDetail).props.onSaveToEmbed).toBe('function');
  });
});
