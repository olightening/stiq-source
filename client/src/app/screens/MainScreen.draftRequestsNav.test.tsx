jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {NotificationsScreen} from '../../notifications/NotificationsScreen';
import {DraftAccessScreen} from '../../feed/components/DraftAccessScreen';

/**
 * A pending draft-access-request notification (NavTarget {kind:'draft_requests'; draftId}) opens the
 * real "Manage access" queue (Phase 5§F) for that draft — replacing the earlier placeholder fallback
 * that just opened the Drafts list. Driven the same way MainScreen.groupRequestsNav.test.tsx drives a
 * notification tap: open the bell, then invoke NotificationsScreen.onSelect.
 */

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const SHARE_ID = 'share-' + 'b'.repeat(58);

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

afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  jest.restoreAllMocks();
});

describe('MainScreen — draft_requests notification opens the Manage access screen', () => {
  it('navigating a draft_requests target opens DraftAccessScreen for that draftId', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
          groups={[]}
          onGetNotifications={() => []}
          onGetDraftAccessQueue={() => []}
          onGetDraftAccessGranted={() => []}
        />,
      );
    });

    // Before any navigation, the screen is mounted-but-closed (lazy-mount latches once opened).
    expect(tree.root.findAllByType(DraftAccessScreen)).toHaveLength(0);

    // Open the notification center, then select the draft-access-request row.
    const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
    act(() => { (bell.props.onPress as () => void)(); });
    act(() => {
      (tree.root.findByType(NotificationsScreen).props.onSelect as (t: unknown) => void)({
        kind: 'draft_requests',
        draftId: SHARE_ID,
      });
    });

    const screen = tree.root.findByType(DraftAccessScreen);
    expect(screen.props.visible).toBe(true);
    expect(screen.props.draftId).toBe(SHARE_ID);
    // The notification center closed on select.
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
  });
});
