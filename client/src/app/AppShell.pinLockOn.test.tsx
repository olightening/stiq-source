/**
 * AppShell — lock-screen routing with the PIN UI RESTORED (PIN_LOCK_UI true).
 *
 * The mirror of AppShell.test.tsx's "does NOT render the lock screen" case. Together they pin the
 * ship-dark contract for bugs 5+6 from the shell's side: LockScreen is unreachable while the flag is
 * off and returns — unchanged, in its original slot in renderScreen's switch — when it is on. The
 * assertion below is the pre-flag AppShell test verbatim.
 *
 * Module-level jest.mock (not resetModules + dynamic require) per the house pattern: MainScreen
 * .backhandler.test.tsx documents why the dynamic-require approach desyncs React's module instance
 * from the test renderer's. `requireActual` is spread first so only PIN_LOCK_UI differs.
 */
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  PIN_LOCK_UI: true,
}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AppShell} from './AppShell';

const noop = (): void => undefined;

describe('AppShell (PIN lock UI restored)', () => {
  it('renders the lock screen when enrolled and locked', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppShell
          channels={[]}
          currentUserPubkey={null}
          isModerator={false}
          sendStatus={new Map()}
          onVote={noop}
          onCreateChannel={noop}
          onPostToChannel={noop}
          onGetThread={() => []}
          onGetChannelMessages={() => []}
          enrolled
          lock="locked"
          connection="connected"
          feed={{items: [], log: []}}
          inbox={[]}
          onSubmit={noop}
          onSendDm={noop}
        />,
      );
    });
    // LockScreen renders the shared PinKeypad (stiq-onboarding-pin-lock-unification) — same
    // component/copy as OnboardingScreen's PIN step, not the old standalone PinPad's "Enter PIN".
    expect(JSON.stringify(tree!.toJSON())).toContain('Enter your PIN');
    act(() => {
      tree!.unmount();
    });
  });
});
