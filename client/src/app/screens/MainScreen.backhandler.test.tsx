// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; this screen-level
// delivery-timing test runs against a synchronous flush(), so disable the jitter here (jest.mock hoists
// above the imports). Every other config value keeps its real value via requireActual.
jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import {BackHandler} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {AppShell} from '../AppShell';
import {toFeedItem} from '../../feed/feed';
import {buildPost} from '../../feed/compose';
import type {Event} from 'nostr-tools/pure';

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

/** Deep-find the first node whose props satisfy `pred`. */
function findByProp(
  tree: renderer.ReactTestRenderer,
  pred: (props: Record<string, unknown>) => boolean,
): renderer.ReactTestInstance | undefined {
  return tree.root.findAll(n => !!n.props && pred(n.props as Record<string, unknown>), {
    deep: true,
  })[0];
}

describe('MainScreen hardware back', () => {
  it('registers a hardwareBackPress listener that closes the innermost overlay', async () => {
    const handlers: Array<() => boolean> = [];
    const spy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation(((_evt: string, cb: () => boolean) => {
        handlers.push(cb);
        return {remove: jest.fn()};
      }) as unknown as typeof BackHandler.addEventListener);

    let tree!: renderer.ReactTestRenderer;
    // Async act flushes the mount-time AsyncStorage effects (sort/tags/read-state) so their deferred
    // setState resolves inside act() rather than warning after the synchronous render.
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

    // The app-level listener must have registered.
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    const back = handlers[handlers.length - 1] as () => boolean;

    // Nothing open → return false so the OS default backgrounds the app.
    let handled = true;
    act(() => {
      handled = back();
    });
    expect(handled).toBe(false);

    // Open the search overlay via the header search button.
    const searchBtn = findByProp(tree, p => p.accessibilityLabel === 'Search');
    expect(searchBtn).toBeDefined();
    act(() => {
      (searchBtn!.props.onPress as () => void)();
    });
    // Search bar is now present (its cancel button carries a distinctive label).
    expect(findByProp(tree, p => p.accessibilityLabel === 'cancel-search')).toBeDefined();

    // Hardware back closes the search overlay and reports the press handled.
    let handled2 = false;
    act(() => {
      handled2 = back();
    });
    expect(handled2).toBe(true);
    expect(findByProp(tree, p => p.accessibilityLabel === 'cancel-search')).toBeUndefined();

    spy.mockRestore();
  });
});
