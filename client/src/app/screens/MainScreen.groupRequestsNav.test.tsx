jest.mock('../../config', () => ({...jest.requireActual('../../config'), TIMING_JITTER: false}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {NotificationsScreen} from '../../notifications/NotificationsScreen';
import {GroupView} from '../../channels/components/GroupView';
import type {GroupState, GroupSummary} from '../../channels/groups';

/**
 * A pending-join-request notification (NavTarget {kind:'group_requests'}) opens the group straight
 * on its Manage page. Driven the same way MainScreen.navOriginStack.test.tsx drives a notification
 * tap: open the bell, then invoke NotificationsScreen.onSelect (which pushes the nav origin +
 * navigateToNotification). The Manage page renders a `manage-back` control, so its presence proves
 * GroupView's internal screen state seeded to 'manage' (the prop is reset to 'chat' one-shot right
 * after mount, so we assert on the rendered Manage UI, not the prop).
 */

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const GID = 'g1';

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

const closedGroupState: GroupState = {
  id: GID,
  name: 'Whisper network',
  closed: true,
  private: false,
  owner: OWNER,
};

const groups: GroupSummary[] = [{id: GID, name: 'Whisper network', memberCount: 1, isAdmin: true}];

afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  jest.restoreAllMocks();
});

describe('MainScreen — group_requests notification opens the Manage page', () => {
  it('navigating a group_requests target opens the group on its Manage screen', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={{items: [], log: []}}
          inbox={[]}
          channels={[]}
          groups={groups}
          onGetNotifications={() => []}
          onGetGroupState={id => (id === GID ? closedGroupState : null)}
          onGetGroupAdmins={id => (id === GID ? [OWNER] : [])}
          onGetGroupMembers={id => (id === GID ? [OWNER] : [])}
          onGetJoinRequestQueue={() => []}
        />,
      );
    });

    // Open the notification center (mounts NotificationsScreen), then select the join-request row.
    const bell = tree.root.findAll(n => n.props.accessibilityLabel === 'Notifications')[0]!;
    act(() => { (bell.props.onPress as () => void)(); });
    act(() => {
      (tree.root.findByType(NotificationsScreen).props.onSelect as (t: unknown) => void)({
        kind: 'group_requests',
        groupId: GID,
      });
    });

    // The group is open…
    const gv = tree.root.findByType(GroupView);
    expect(gv.props.groupId).toBe(GID);
    // …and it is showing the Manage page (seeded from initialScreen='manage'): the manage-back
    // control is unique to that screen.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'manage-back').length).toBeGreaterThan(0);
    // The notification center closed on select.
    expect(tree.root.findByType(NotificationsScreen).props.visible).toBe(false);
  });
});
