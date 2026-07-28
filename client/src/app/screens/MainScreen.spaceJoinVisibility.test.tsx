/**
 * Regression test for "+ Sub does nothing": a channel you just subscribed to has no cached
 * kind-1311 history yet (it streams in over Tor after the subscribe), so `lastMsgPreview` returns
 * `at: 0` and the unified Spaces sort (`b.lastAt - a.lastAt`) buried the row dead last under every
 * DM and older space. `channelRow`/`groupRow` now fall back to `Math.max(joinedAt(id), metaAt)`
 * when there's no cached message, so a freshly-joined space surfaces near the top instead of at
 * the 0 floor. See HANDOFF_SPACE_JOIN_VISIBILITY_2026-07-27.md.
 *
 * Uses the REAL spaceJoinedAt module (same idiom as dockPrefs/feedSortPrefs in sibling MainScreen
 * tests): a fresh slot per test, then `markJoined` to stamp the join moment synchronously before
 * mount — no jest.mock needed since the mirror is a plain synchronous module.
 */
import 'react-native';
import React from 'react';
import {FlatList} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import type {Event} from 'nostr-tools/pure';
import {MainScreen, type MainScreenProps} from './MainScreen';
import type {Channel} from '../../channels/channels';
import {setDockPrefsSlot} from '../dockPrefs';
import {setSpaceJoinedAtSlot, markJoined} from '../spaceJoinedAt';

let slotSeq = 0;
beforeEach(() => {
  setDockPrefsSlot(`space-join-vis-${slotSeq}`);
  setSpaceJoinedAtSlot(`space-join-vis-${slotSeq++}`);
});

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
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

function channelMessage(id: string, chId: string, createdAt: number, content: string): Event {
  return {id, pubkey: OTHER, created_at: createdAt, kind: 1311, tags: [['a', chId]], content, sig: 's'};
}

/** The unified Spaces `<FlatList>`'s `data` prop, in render order — each row carries `rowKey`,
 * which no other FlatList in MainScreen (feed/thread) uses, so this scopes to the right list. */
function channelListRowNames(tree: renderer.ReactTestRenderer): string[] {
  const lists = tree.root.findAll(
    n => n.type === FlatList && Array.isArray(n.props.data) && n.props.data.some((d: unknown) => !!d && typeof d === 'object' && 'rowKey' in (d as object)),
  );
  const list = lists[0]!;
  return (list.props.data as Array<{_kind: string; name?: string}>)
    .filter(item => item._kind === 'row')
    .map(item => item.name!);
}

function pressByText(tree: renderer.ReactTestRenderer, text: string): void {
  const textNode = tree.root.findAll(n => !!n.props && n.props.children === text)[0];
  expect(textNode).toBeDefined();
  let n: renderer.ReactTestInstance | null = textNode ?? null;
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  expect(n).toBeDefined();
  act(() => {
    (n!.props.onPress as () => void)();
  });
}

describe('Spaces list — a just-joined channel with no cached history sorts above older activity', () => {
  const NOW = 1_800_000_000; // fixed epoch seconds, so the test is deterministic

  it('a freshly-subscribed empty channel (joinedAt recent) outranks an older channel with cached messages', () => {
    const channels: Channel[] = [
      {id: 'ch-new', owner: OTHER, name: 'JustJoined'}, // no metaAt, no cached msgs
      {id: 'ch-old', owner: OTHER, name: 'OldChatter'},
    ];
    // Joined 60s ago — well after ch-old's newest cached message.
    markJoined('ch-new', NOW - 60);
    const oldMsg = channelMessage('m-old', 'ch-old', NOW - 200_000, 'ancient chatter');
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch-old' ? [oldMsg] : []));

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          subscribedChannelIds={['ch-new', 'ch-old']}
          onGetChannelMessages={onGetChannelMessages}
        />,
      );
    });
    pressByText(tree, 'Spaces');

    const names = channelListRowNames(tree);
    const newIdx = names.indexOf('JustJoined');
    const oldIdx = names.indexOf('OldChatter');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx); // just-joined row renders ABOVE the older one
  });

  it('genuine activity still wins: a channel with a newer cached message outranks a recently-joined empty one', () => {
    const channels: Channel[] = [
      {id: 'ch-new', owner: OTHER, name: 'JustJoined'},
      {id: 'ch-active', owner: OTHER, name: 'ActiveNow'},
    ];
    markJoined('ch-new', NOW - 60); // joined 60s ago
    // ch-active has a REAL cached message newer than ch-new's join stamp — the fix must not let the
    // join-fallback override genuine, fresher activity.
    const freshMsg = channelMessage('m-fresh', 'ch-active', NOW - 10, 'just posted');
    const onGetChannelMessages = jest.fn((id: string) => (id === 'ch-active' ? [freshMsg] : []));

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          subscribedChannelIds={['ch-new', 'ch-active']}
          onGetChannelMessages={onGetChannelMessages}
        />,
      );
    });
    pressByText(tree, 'Spaces');

    const names = channelListRowNames(tree);
    const activeIdx = names.indexOf('ActiveNow');
    const newIdx = names.indexOf('JustJoined');
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(newIdx); // real newer activity still sorts first
  });
});
