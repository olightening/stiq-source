jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {NotificationsScreen} from '../../notifications/NotificationsScreen';
import type {NotifItem} from '../../notifications/notifications';
import type {Conversation} from '../../dm/conversations';
import type {Channel} from '../../channels/channels';

/**
 * The notification center used to snapshot onGetNotifications() ONCE at open time
 * (openNotifications, MainScreen.tsx) and never again — the one surface in the app that wasn't
 * live: a reply/DM/channel post/join-request arriving while the bell was already open stayed
 * invisible until the user closed and reopened it. This exercises the fix: the
 * `notifLiveRecompute` effect (see MainScreen.tsx, right before threadNodes) that re-derives on the
 * same storeVersions/feed/inbox signals the rest of MainScreen already recomputes on, for as long as
 * the center stays open — while staying gated on notifOpen and memoized on those exact keys so it
 * doesn't pay for a re-scan on every unrelated render or while the center is closed.
 *
 * EVERYTHING below runs against ONE mounted MainScreen tree, walking through the scenarios via
 * sequential tree.update() calls rather than one-mount-per-`it()`. That is deliberate, not just
 * economy: MainScreen has a pre-existing, already-known hazard where an unrelated effect
 * (useScrollChrome's Animated-driven task, independent of anything touched here) can leave a
 * stray InteractionManager task behind a torn-down tree, which then fires during a LATER tree's
 * render and crashes the whole jest worker (TypeError: Cannot read properties of undefined
 * (reading 'Value')) — see MainScreen.navOriginStack.test.tsx's afterEach comment for the same
 * failure mode. Mounting MainScreen more than once per file reliably reproduces it (confirmed
 * while writing this test). One mount, unmounted only once at the very end, sidesteps it entirely.
 */

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

// Stable references reused across tree.update() calls whenever a prop is NOT meant to change —
// notifLiveRecompute keys on `feed`/`inbox` BY REFERENCE (exactly like the rest of MainScreen's
// storeVersions-driven memos), so a fresh `{items: [], log: []}` / `[]` LITERAL on every render
// would itself look like a real change and spuriously re-fire the effect under test.
const emptyFeed = {items: [], log: []};
const emptyChannels: Channel[] = [];

/** A minimal channel-source row (the notification kind least tangled up with other props). */
function mkChannelItem(id: string, ts: number): NotifItem {
  return {
    id,
    ts,
    kind: 'channel',
    target: {kind: 'channel', channelId: 'ch1', channelType: 'public'},
    read: false,
    actor: '#general',
    action: 'has a new post',
    avatar: {shape: 'square', seed: 'ch1'},
  };
}

/** A minimal DM-source row. */
function mkDmItem(id: string, ts: number, peer: string): NotifItem {
  return {
    id,
    ts,
    kind: 'dm',
    target: {kind: 'dm', peer},
    read: false,
    actor: 'Someone',
    action: 'sent you a message',
    avatar: {shape: 'circle', seed: 'npub1seed'},
  };
}

function dmConversation(peer: string, preview: string): Conversation {
  return {peer, peerNpub: `npub1${'x'.repeat(58)}`, messages: [], lastAt: 1, preview};
}

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

/** Flush a pending InteractionManager.runAfterInteractions task (same idiom as
 *  MainScreen.spaceEmbed.test.tsx / MainScreen.navOriginStack.test.tsx for the threadNodes effect —
 *  notifLiveRecompute defers through the identical API). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

/** Post-unmount teardown flush. A handful of pre-existing, unrelated MainScreen effects (e.g.
 *  useScrollChrome's classic-Animated interaction handle) can take more than one setImmediate hop
 *  to fully settle after unmount — and a straggler that escapes THIS file fires during whichever
 *  test file jest runs next, crashing the worker (see MainScreen.navOriginStack.test.tsx's afterEach
 *  comment for the identical failure mode, TypeError: Cannot read properties of undefined (reading
 *  'Value') from useScrollChrome). Looping the flush here is cheap insurance against being that
 *  file, independent of anything notifLiveRecompute itself does. */
async function flushHard(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush();
  }
}

function itemsOf(tree: renderer.ReactTestRenderer): NotifItem[] {
  return tree.root.findByType(NotificationsScreen).props.items as NotifItem[];
}

it('notification center recomputes live while open, stays gated while closed, and never re-derives on an unrelated render', async () => {
  const emptyInbox: Conversation[] = [];
  let items: NotifItem[] = [mkChannelItem('a', 100)];
  const onGetNotifications = jest.fn(() => items);
  const onMarkNotificationRead = jest.fn();
  const onMarkAllNotificationsRead = jest.fn();

  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={emptyInbox}
        channels={emptyChannels}
        storeVersions={{channels: 0, groups: 0, identity: 0}}
        onGetNotifications={onGetNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
      />,
    );
  });

  // --- Gated while closed -----------------------------------------------------------------
  // A channel broadcast lands (storeVersions.channels bumps) while the bell has never been
  // opened — must not pay for the derivation at all.
  await act(async () => {
    tree.update(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={emptyInbox}
        channels={emptyChannels}
        storeVersions={{channels: 1, groups: 0, identity: 0}}
        onGetNotifications={onGetNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
      />,
    );
  });
  await flush();
  expect(onGetNotifications).not.toHaveBeenCalled();

  // --- Open: derives exactly once on the open transition -----------------------------------
  const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
  act(() => {
    (bell.props.onPress as () => void)();
  });
  await flush();
  expect(onGetNotifications).toHaveBeenCalledTimes(1);
  expect(itemsOf(tree).map(i => i.id)).toEqual(['a']);

  // --- Live update while OPEN, via storeVersions.groups (e.g. an admin join-request queue
  // change) — the center is never closed/reopened between this and the previous step. ---------
  items = [mkChannelItem('b', 200), mkChannelItem('a', 100)];
  await act(async () => {
    tree.update(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={emptyInbox}
        channels={emptyChannels}
        storeVersions={{channels: 1, groups: 1, identity: 0}}
        onGetNotifications={onGetNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
      />,
    );
  });
  await flush();
  expect(itemsOf(tree).map(i => i.id).sort()).toEqual(['a', 'b']);
  const callsAfterGroupsBump = onGetNotifications.mock.calls.length;
  expect(callsAfterGroupsBump).toBeGreaterThan(1);
  // A live recompute is a pure read (onGetNotifications never advances any HWM or read state on
  // its own) — it must never itself mark anything read, no matter how many times it re-derives.
  expect(onMarkNotificationRead).not.toHaveBeenCalled();
  expect(onMarkAllNotificationsRead).not.toHaveBeenCalled();

  // --- Live update while OPEN, via the `inbox` array identity — the "a notification arrives a
  // second after the user opens the screen" scenario from the bug report, for a DM specifically.
  // AppRuntime rebuilds `inbox` as a fresh array with NO store-version bump when a gift-wrap
  // decrypts (see AppRuntime's _notifCache doc); feed/storeVersions stay exactly as they were, so
  // the array's changed REFERENCE has to be the signal — and it already is one. --------------
  const dmItem = mkDmItem('dm1', 300, PEER);
  items = [dmItem, mkChannelItem('b', 200), mkChannelItem('a', 100)];
  const inboxWithDm: Conversation[] = [dmConversation(PEER, 'new message')];
  await act(async () => {
    tree.update(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={inboxWithDm}
        channels={emptyChannels}
        storeVersions={{channels: 1, groups: 1, identity: 0}}
        onGetNotifications={onGetNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
      />,
    );
  });
  await flush();
  expect(itemsOf(tree).map(i => i.id).sort()).toEqual(['a', 'b', 'dm1']);
  const callsAfterInboxChange = onGetNotifications.mock.calls.length;
  expect(callsAfterInboxChange).toBeGreaterThan(callsAfterGroupsBump);

  // --- No re-derive on an UNRELATED render: isModerator flips (gates the moderator console;
  // deriveNotifications' cache key never reads it) while every prop notifLiveRecompute actually
  // depends on keeps the exact same reference/value. Proves it isn't running on every tick. -----
  await act(async () => {
    tree.update(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={inboxWithDm}
        channels={emptyChannels}
        storeVersions={{channels: 1, groups: 1, identity: 0}}
        isModerator={true}
        onGetNotifications={onGetNotifications}
        onMarkNotificationRead={onMarkNotificationRead}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
      />,
    );
  });
  await flush();
  expect(onGetNotifications.mock.calls.length).toBe(callsAfterInboxChange);
  expect(itemsOf(tree).map(i => i.id).sort()).toEqual(['a', 'b', 'dm1']);

  act(() => tree.unmount());
  await flushHard();
});
