/**
 * Phase 3.4 regression (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md): MainScreen's lazy-mounted
 * heavy sub-screens must NEVER mount with `visible` already true. The old
 * `mounted.current ||= open` idiom set mount + visible in the same render on first open — the
 * exact Android RN 0.76 Modal failure mode the app-wide "always-mount + toggle visible" rule
 * (LogScreen.modal.test.tsx, StiqAlert) exists to avoid. useLazyModalMount now sequences first
 * open as mount-hidden → flip-visible-next-commit.
 *
 * ComposerScreen (the heaviest of the 7 gated sub-screens) is stubbed with a recorder so the test
 * can assert the exact `visible` prop sequence it receives across commits — from the outside,
 * act() batches would hide the intermediate commit.
 */
jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

// Records every `visible` prop value ComposerScreen is rendered with, in commit order.
const visibleLog: boolean[] = [];
jest.mock('../../feed/components/ComposerScreen', () => {
  const ReactActual = require('react');
  return {
    ComposerScreen: (props: {visible: boolean}) => {
      visibleLog.push(props.visible);
      return ReactActual.createElement(require('react-native').View, {testID: 'composer-stub'});
    },
  };
});

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AppShell} from '../AppShell';

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

describe('MainScreen lazy modal mount sequencing (Phase 3.4)', () => {
  beforeEach(() => {
    visibleLog.length = 0;
  });

  it('the composer is not mounted at all before its first open', async () => {
    await act(async () => {
      renderer.create(
        <AppShell
          {...baseProps}
          enrolled
          lock="unlocked"
          connection="connected"
          feed={{items: [], log: []}}
          inbox={[]}
          onSubmit={noop}
          onSendDm={noop}
        />,
      );
    });
    expect(visibleLog).toHaveLength(0);
  });

  it('first open mounts the composer HIDDEN, then flips visible in a later commit', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppShell
          {...baseProps}
          enrolled
          lock="unlocked"
          connection="connected"
          feed={{items: [], log: []}}
          inbox={[]}
          onSubmit={noop}
          onSendDm={noop}
        />,
      );
    });

    // Tap the pinned "Share an idea…" compose entry (the row Press wrapping that text).
    const entry = tree.root.findAll(
      n =>
        typeof n.props?.onPress === 'function' &&
        n.findAll(c => c.props?.children === 'Share an idea…').length > 0,
    )[0];
    expect(entry).toBeTruthy();
    await act(async () => {
      entry!.props.onPress();
    });

    // The composer ends up visible…
    expect(visibleLog.length).toBeGreaterThanOrEqual(2);
    expect(visibleLog[visibleLog.length - 1]).toBe(true);
    // …but its FIRST commit after mount was hidden — never mounted-already-visible.
    expect(visibleLog[0]).toBe(false);
  });
});
