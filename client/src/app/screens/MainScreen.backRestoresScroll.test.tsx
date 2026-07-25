jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import {FlatList} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {AppShell} from '../AppShell';
import {toFeedItem} from '../../feed/feed';
import {buildPost} from '../../feed/compose';
import type {Event} from 'nostr-tools/pure';

/**
 * THE REGRESSION THIS LOCKS: leaving a post used to move the reader.
 *
 * The feed is never unmounted while a post is open — FeedList stays mounted and laid out under the
 * thread overlay specifically so the native scroll offset survives. But an effect on Back looked up
 * the post you had just read and called scrollToIndex({viewPosition: 0.5}), re-centring it and
 * discarding the offset you were actually at. Deleting that effect IS the fix: the FlatList already
 * holds the right position, so the correct amount of scrolling to perform on Back is none.
 *
 * So this test asserts an ABSENCE, which is the only thing that can fail if someone re-adds the
 * effect. scrollToOffset is watched too — the same mistake wearing a different hat.
 */
const noop = (): void => undefined;

const baseProps = {
  channels: [] as import('../../channels/channels').Channel[],
  currentUserPubkey: 'a'.repeat(64),
  isModerator: false,
  sendStatus: new Map<string, import('../../nostr/outbox').SendStatus>(),
  onVote: noop,
  onCreateChannel: noop,
  onPostToChannel: noop,
  onGetThread: () => [] as import('../../feed/thread').CommentNode[],
  onGetChannelMessages: () => [] as import('nostr-tools/pure').Event[],
};

function feedWithPost() {
  const item = toFeedItem({
    ...buildPost('hello feed body', ['news']),
    id: 'p1',
    pubkey: 'b'.repeat(64),
    sig: 's',
  } as Event);
  return {items: [item], log: []};
}

function findByProp(
  tree: renderer.ReactTestRenderer,
  pred: (props: Record<string, unknown>) => boolean,
): renderer.ReactTestInstance | undefined {
  return tree.root.findAll(n => !!n.props && pred(n.props as Record<string, unknown>), {deep: true})[0];
}

describe('Back from a post does not move the feed', () => {
  it('THE REGRESSION: no programmatic scroll fires when a post closes', async () => {
    // Spy on the prototype: the list is reached through FeedList's forwarded ref, so this catches the
    // call wherever it is made from, without needing to hold the ref itself.
    const toIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(noop);
    const toOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(noop);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppShell
          {...baseProps}
          enrolled
          lock="unlocked"
          connection="connected"
          feed={feedWithPost()}
          inbox={[]}
          onSubmit={noop}
          onSendDm={noop}
        />,
      );
    });

    // Open the post through the real path: FeedList's onItemPress is what MainScreen wires to
    // openPostFromFeed, which is exactly where the deleted bookkeeping used to record the post id.
    const list = findByProp(tree, p => typeof p.onItemPress === 'function' && Array.isArray(p.items));
    if (!list) {
      // Fail loudly rather than pass vacuously — a test that silently exercises nothing is worse
      // than no test at all.
      throw new Error('could not find FeedList to open a post — update this test, do not delete it');
    }
    const items = list.props.items as Array<{id: string}>;
    expect(items.length).toBeGreaterThan(0);
    await act(async () => {
      (list.props.onItemPress as (i: unknown) => void)(items[0]);
    });

    // The thread must actually be open, or "no scroll happened" would be trivially true.
    const back = findByProp(tree, p => p.accessibilityLabel === 'Back to Back');
    if (!back) throw new Error('thread did not open — update this test, do not delete it');

    toIndex.mockClear();
    toOffset.mockClear();

    // Close it — the moment the old effect used to re-centre.
    await act(async () => {
      (back.props.onPress as () => void)();
    });
    // Let the rAF + 150ms + 400ms retry ladder the old effect used fire, if it still exists.
    await act(async () => {
      await new Promise(r => setTimeout(r, 500));
    });

    expect(toIndex).not.toHaveBeenCalled();
    expect(toOffset).not.toHaveBeenCalled();

    toIndex.mockRestore();
    toOffset.mockRestore();
  });
});
