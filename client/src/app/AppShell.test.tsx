import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AppShell} from './AppShell';
import {toFeedItem} from '../feed/feed';
import {buildPost} from '../feed/compose';
import type {Event} from 'nostr-tools/pure';

function render(ui: React.ReactElement): string {
  let tree: renderer.ReactTestRenderer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  act(() => {
    tree = renderer.create(ui);
  });
  return JSON.stringify(
    tree!.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

const emptyFeed = {items: [], log: []};
const noop = (): void => undefined;

const baseProps = {
  channels: [] as import('../channels/channels').Channel[],
  currentUserPubkey: null,
  isModerator: false,
  sendStatus: new Map<string, import('../nostr/outbox').SendStatus>(),
  onVote: noop,
  onCreateChannel: noop,
  onPostToChannel: noop,
  onGetThread: () => [] as import('../feed/thread').CommentNode[],
  onGetChannelMessages: () => [] as import('nostr-tools/pure').Event[],
};

describe('AppShell', () => {
  it('renders onboarding on a blank (unenrolled) app', () => {
    const text = render(
      <AppShell
        {...baseProps}
        enrolled={false}
        lock="unlocked"
        connection="connected"
        feed={emptyFeed}
        inbox={[]}
        onSubmit={noop}
        onSendDm={noop}
      />,
    );
    expect(text).toContain('I have a request code');
  });

  // The PIN lock UI ships dark (PIN_LOCK_UI false — config.ts, bugs 5+6), so AppShell can no longer
  // route to LockScreen: resolveScreen never names it. AppShell.pinLockOn.test.tsx is the mirror,
  // asserting the lock screen comes straight back when the flag is flipped.
  it('does NOT render the lock screen when enrolled and locked — the PIN UI is dark', () => {
    const text = render(
      <AppShell
        {...baseProps}
        enrolled
        lock="locked"
        pinEnabled
        connection="connected"
        feed={emptyFeed}
        inbox={[]}
        onSubmit={noop}
        onSendDm={noop}
      />,
    );
    // `pinEnabled` is passed TRUE on purpose: that is what a member who is on a PIN today reads back
    // from the persisted default, and what App.tsx's pre-hydration INITIAL snapshot hardcodes. They
    // must land in the app, not on a lock screen they could never dismiss.
    expect(text).not.toContain('Enter your PIN');
    expect(text).toContain('Updates'); // the feed chrome — MainScreen mounted instead
  });

  it('renders the feed (with the post) when enrolled and unlocked', () => {
    const item = toFeedItem({
      ...buildPost('hello feed', ['news']),
      id: 'p1',
      pubkey: 'a'.repeat(64),
      sig: 's',
    } as Event);

    const text = render(
      <AppShell
        {...baseProps}
        enrolled
        lock="unlocked"
        connection="connected"
        feed={{items: [item], log: []}}
        inbox={[]}
        onSubmit={noop}
        onSendDm={noop}
      />,
    );
    expect(text).toContain('hello feed');
    expect(text).toContain('Updates');
  });
});
