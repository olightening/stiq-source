// theme.ts pulls in async-storage, which has no Jest mock in this repo; stub it.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
// RichText → LinkChip imports the clipboard native module, which has no Jest mock; stub it.
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn()}), {virtual: true});
// Belt-and-braces for react-native-webview (ESM, untransformed in tests) reaching this tree via the
// composer's RichEditor; jest.config's moduleNameMapper stub also covers it.
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

// B12: wrap the real ChatBubble so its rendered props can be inspected — verifies GroupView's plain
// chat row maps onLookupEvent/onOpenRef onto ChatBubble's onLookupEvent/onOpenNostrPost, without
// having to re-derive RichText's own embed-rendering (already covered by ChatBubble.test.tsx).
// eslint-disable-next-line no-var
var mockChatBubbleProps: Array<Record<string, unknown>> = [];
jest.mock('./primitives', () => {
  const actual = jest.requireActual('./primitives');
  return {
    ...actual,
    ChatBubble: (props: Record<string, unknown>) => {
      mockChatBubbleProps.push(props);
      return actual.ChatBubble(props);
    },
  };
});

import 'react-native';
import React from 'react';
import {Alert, BackHandler, FlatList} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import {GroupView, type GroupViewProps} from './GroupView';
import {RootBackScope} from '../../ui/back';
import * as displayName from '../../profile/displayName';
import {saveSpaceEmbed, removeEmbed} from '../savedEmbeds';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {DEFAULT_SPACE_REACTIONS} from '../spaceRules';
import type {Event} from 'nostr-tools/pure';
import {TextInput} from 'react-native';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {DraftStore, inProgressDraftId, type DraftLocation} from '../../feed/drafts';
import {InMemorySecureStorage} from '../../keys/keystore';

const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const messages: Event[] = [
  {id: 'm1', pubkey: BOB, created_at: 1, kind: 9, tags: [['h', 'g1']], content: 'hi group', sig: 's'},
];

const CAROL = 'c'.repeat(64);

function base() {
  return {
    groupId: 'g1',
    name: 'Builders',
    about: 'a managed group',
    members: [ME, BOB],
    admins: [ME],
    messages,
    currentUserPubkey: ME,
    isMember: true,
    isAdmin: true,
    onJoin: jest.fn(),
    onLeave: jest.fn(),
    onKick: jest.fn(),
    onAddMember: jest.fn(),
    onEditGroup: jest.fn(),
    onApprove: jest.fn(),
    onDeny: jest.fn(),
    onDelete: jest.fn(),
    onTransfer: jest.fn(),
    onPostChat: jest.fn(),
    onReply: jest.fn(),
    onBack: jest.fn(),
  };
}

function render(props: GroupViewProps): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<GroupView {...props} />);
  });
  return tree!;
}

/** All string children rendered anywhere in the tree, concatenated. */
function allText(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

// GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
// "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
// wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
// function instead (same pattern as ChatBubble.test.tsx / MessageFooter.test.tsx).
const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
function findAvatars(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.type === gradientAvatarInner);
}

it('renders group name, chat, and a member-count header', () => {
  const text = allText(render(base()));
  expect(text).toContain('Builders');
  expect(text).toContain('hi group');
  expect(text).toContain('member'); // "2 member(s)" header
});

it('anchors the chat with maintainVisibleContentPosition so an arriving message cannot yank a reader scrolled into history', () => {
  const tree = render(base());
  const list = tree.root.findByType(FlatList);
  expect(list.props.maintainVisibleContentPosition).toEqual({minIndexForVisible: 0});
});

it('does NOT pair removeClippedSubviews with maintainVisibleContentPosition (they fight over the same native child list)', () => {
  // On Android, removeClippedSubviews detaches off-screen child views from the very ScrollView
  // content ViewGroup that MaintainVisibleScrollPositionHelper walks by index to find/track its
  // anchor — a view clipped away mid-update can vanish out from under the anchor the helper is
  // tracking, defeating the "arriving message cannot yank a scrolled-away reader" guarantee above.
  const tree = render(base());
  const list = tree.root.findByType(FlatList);
  expect(list.props.removeClippedSubviews).not.toBe(true);
});

it('a plain group chat stops auto-following to the newest message once the reader has scrolled away to read history', () => {
  const scrollToEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
  const tree = render(base());
  const list = tree.root.findByType(FlatList);

  // Mount's own initial layout: the reader hasn't scrolled at all yet (jump.showJump starts
  // false), so the pre-existing "open scrolled to the newest message" behaviour must be intact.
  act(() => list.props.onContentSizeChange());
  expect(scrollToEnd).toHaveBeenCalledTimes(1);

  // Scroll far enough from the bottom to cross useReturnToLatest('bottom')'s own SHOW_AFTER
  // threshold (320px) — distance = contentSize.height - (contentOffset.y + layoutMeasurement.height).
  act(() => {
    (list.props.onScrollEndDrag as (e: unknown) => void)({
      nativeEvent: {contentOffset: {y: 0}, contentSize: {height: 2000}, layoutMeasurement: {height: 600}},
    });
  });

  // A new message lands (content size changes again) while the reader is mid-history — must NOT
  // yank them back to the bottom.
  act(() => list.props.onContentSizeChange());
  expect(scrollToEnd).toHaveBeenCalledTimes(1); // still just the one call from the initial mount
});

/** Member management moved to the full MANAGE page (membership handoff): open the quick sheet,
 *  then its ⚙️ Manage row. */
function openManage(tree: renderer.ReactTestRenderer): void {
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-info')[0]!.props.onPress();
  });
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'open-manage')[0]!.props.onPress();
  });
}

/** Member actions moved behind a per-row ⋯ trigger + one shared bottom sheet: open a member's menu
 *  by pressing their `member-menu-${pk}` trigger before asserting on/pressing its rows. */
function openMemberMenu(tree: renderer.ReactTestRenderer, pk: string): void {
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `member-menu-${pk}`)[0]!.props.onPress();
  });
}

it('an admin sees Kick for other members but not for themselves (Manage page)', () => {
  const tree = render(base());
  openManage(tree);
  openMemberMenu(tree, BOB);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `kick-${BOB}`).length).toBeGreaterThan(0);
  // Self gets no ⋯ trigger at all, so its menu (and Kick within it) can never open.
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `member-menu-${ME}`)).toHaveLength(0);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `kick-${ME}`)).toHaveLength(0);
});

it('kicking a member invokes onKick with their pubkey', () => {
  const props = base();
  const tree = render(props);
  openManage(tree);
  openMemberMenu(tree, BOB);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `kick-${BOB}`)[0]!.props.onPress();
  });
  expect(props.onKick).toHaveBeenCalledWith(BOB);
});

it('a non-admin member sees no Kick controls', () => {
  // A group-chat member still reaches "Members & settings" (they may invite) but gets no
  // moderation controls there — assert the ⋯ trigger itself is absent (there is no menu to open).
  const props = {...base(), isAdmin: false, admins: []};
  const tree = render(props);
  openManage(tree);
  expect(tree.root.findAll(n => String(n.props.accessibilityLabel).startsWith('member-menu-'))).toHaveLength(0);
  expect(tree.root.findAll(n => String(n.props.accessibilityLabel).startsWith('kick-'))).toHaveLength(0);
});

it('a non-member sees Join and no composer', () => {
  const props = {...base(), isMember: false, isAdmin: false, admins: []};
  const tree = render(props);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'join-group').length).toBeGreaterThan(0);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'group-composer')).toHaveLength(0);
});

it('a member can send chat via the composer', () => {
  const props = base();
  const tree = render(props);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-composer')[0]!.props.onChangeText('hello');
  });
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-send')[0]!.props.onPress();
  });
  // Second arg is the optional reply target — undefined for a plain (non-reply) send.
  expect(props.onPostChat).toHaveBeenCalledWith('hello', undefined);
});

it('a rejected onPostChat restores the draft instead of losing the message', async () => {
  // sendText clears the composer OPTIMISTICALLY on tap; a rejection (e.g. the space's key hasn't
  // hydrated yet — AppRuntime throws SPACE_KEY_UNAVAILABLE) must put the typed text back rather than
  // silently discarding it.
  const props = {...base(), onPostChat: jest.fn(() => Promise.reject(new Error('SPACE_KEY_UNAVAILABLE')))};
  const tree = render(props);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-composer')[0]!.props.onChangeText('hello');
  });
  await act(async () => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-send')[0]!.props.onPress();
    // Let the optimistic clear render, then the rejection's .catch restore, both flush.
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(props.onPostChat).toHaveBeenCalledWith('hello', undefined);
  const input = tree.root.findAll(n => n.props.accessibilityLabel === 'group-composer')[0]!;
  expect(input.props.value).toBe('hello');
});

it('an admin sees Promote for non-admin members and Demote for admins', () => {
  // ME is admin, BOB is plain member, CAROL is also admin.
  const props = {...base(), members: [ME, BOB, CAROL], admins: [ME, CAROL]};
  const tree = render(props);
  openManage(tree);
  // Promote shown for BOB (non-admin), in BOB's own ⋯ menu.
  openMemberMenu(tree, BOB);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `promote-${BOB}`).length).toBeGreaterThan(0);
  // Demote shown for CAROL (admin, not self), in CAROL's own ⋯ menu (one shared sheet — switching
  // its target just re-presses a different row's trigger).
  openMemberMenu(tree, CAROL);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `demote-${CAROL}`).length).toBeGreaterThan(0);
  // No ⋯ trigger for self (ME) at all, so promote/demote can never target them.
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `member-menu-${ME}`)).toHaveLength(0);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `promote-${ME}`)).toHaveLength(0);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `demote-${ME}`)).toHaveLength(0);
});

it('pressing Promote calls onAddMember(pubkey, true)', () => {
  const props = base(); // BOB is plain member
  const tree = render(props);
  openManage(tree);
  openMemberMenu(tree, BOB);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `promote-${BOB}`)[0]!.props.onPress();
  });
  expect(props.onAddMember).toHaveBeenCalledWith(BOB, true);
});

describe('member ⋯ menu (Manage page)', () => {
  it('an owner sees Transfer ownership on a member\'s menu; a non-owner admin does not', () => {
    const ownerTree = render({...base(), isOwner: true});
    openManage(ownerTree);
    openMemberMenu(ownerTree, BOB);
    expect(ownerTree.root.findAll(n => n.props.accessibilityLabel === `transfer-${BOB}`).length).toBeGreaterThan(0);

    const adminTree = render({...base(), isOwner: false});
    openManage(adminTree);
    openMemberMenu(adminTree, BOB);
    expect(adminTree.root.findAll(n => n.props.accessibilityLabel === `transfer-${BOB}`)).toHaveLength(0);
  });

  it('the self (isMe) row has no ⋯ trigger', () => {
    const tree = render(base());
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `member-menu-${ME}`)).toHaveLength(0);
  });

  it('Cancel closes the sheet without firing onKick/onAddMember/onTransfer', () => {
    const props = {...base(), isOwner: true};
    const tree = render(props);
    openManage(tree);
    openMemberMenu(tree, BOB);
    // Sanity: the sheet is actually open (its rows are present) before Cancel is pressed.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `kick-${BOB}`).length).toBeGreaterThan(0);
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'member-menu-cancel')[0]!.props.onPress();
    });
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `kick-${BOB}`)).toHaveLength(0);
    expect(props.onKick).not.toHaveBeenCalled();
    expect(props.onAddMember).not.toHaveBeenCalled();
    expect(props.onTransfer).not.toHaveBeenCalled();
  });

  it('Transfer ownership is confirmed via Alert — onTransfer fires only from the confirm button', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const props = {...base(), isOwner: true};
    const tree = render(props);
    openManage(tree);
    openMemberMenu(tree, BOB);
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `transfer-${BOB}`)[0]!.props.onPress();
    });
    // Tapping the row only opens the confirm — onTransfer must not have fired yet.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(props.onTransfer).not.toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0]![2] as Array<{text: string; onPress?: () => void}>;
    expect(buttons.some(b => b.text === 'Cancel')).toBe(true);
    const confirmBtn = buttons.find(b => b.text === 'Transfer');
    expect(confirmBtn).toBeDefined();
    act(() => { confirmBtn!.onPress!(); });
    expect(props.onTransfer).toHaveBeenCalledWith(BOB);
    alertSpy.mockRestore();
  });
});

describe('requests-before-members render order (Manage page)', () => {
  it('renders JOIN REQUESTS above the members list when a request is pending', () => {
    const props = {
      ...base(),
      closed: true,
      pending: [CAROL],
      joinQueue: [{pubkey: CAROL, at: 1234, name: 'Mara V.', note: 'note', invited: false}],
    };
    const tree = render(props);
    openManage(tree);
    const text = allText(tree);
    const reqIdx = text.indexOf('JOIN REQUESTS');
    const membersIdx = text.indexOf('MEMBERS ·');
    expect(reqIdx).toBeGreaterThan(-1);
    expect(membersIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeLessThan(membersIdx);
  });
});

it('the Edit button is shown for admins and hidden for non-admins (Manage page)', () => {
  const adminTree = render(base());
  openManage(adminTree);
  expect(adminTree.root.findAll(n => n.props.accessibilityLabel === 'edit-group').length).toBeGreaterThan(0);
  const memberTree = render({...base(), isAdmin: false});
  openManage(memberTree);
  expect(memberTree.root.findAll(n => n.props.accessibilityLabel === 'edit-group')).toHaveLength(0);
});

it('an admin reviews join requests on the Manage page: note + Approve; Decline is silent', () => {
  const props = {
    ...base(),
    closed: true,
    pending: [CAROL],
    joinQueue: [{pubkey: CAROL, at: 1234, name: 'Mara V.', note: 'Robin said the Thursday coordination happens here.', invited: false}],
  };
  const tree = render(props);
  // The quick sheet's Manage row carries the pending-count badge.
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-info')[0]!.props.onPress();
  });
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'pending-requests-badge').length).toBeGreaterThan(0);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'open-manage')[0]!.props.onPress();
  });
  // The request card shows the unsealed intro note.
  expect(allText(tree)).toContain('Robin said the Thursday coordination happens here.');
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`)[0]!.props.onPress();
  });
  expect(props.onApprove).toHaveBeenCalledWith(CAROL);
  // The resolved card replaces the actions and persists for the session.
  expect(allText(tree)).toContain('Approved — added to members');
});

it('declining shows the quiet-resolution card and never a rejection word', () => {
  const props = {...base(), closed: true, pending: [CAROL], joinQueue: [{pubkey: CAROL, invited: false}]};
  const tree = render(props);
  openManage(tree);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `deny-${CAROL}`)[0]!.props.onPress();
  });
  expect(props.onDeny).toHaveBeenCalledWith(CAROL);
  expect(allText(tree)).toContain('Declined quietly');
  expect(allText(tree)).toContain('never shown a rejection');
});

// M32 field fix (Olene's incident): an invited+pending requester used to be unconditionally dropped
// from the review queue on the assumption the background auto-approve sweep always catches it — it
// doesn't always (see AppRuntime.sweepInvitedAfterKeys's doc), so it must render as its own row with
// a WORKING manual Approve, never silently vanish.
it('an invited+pending requester renders as a distinct row with a working manual Approve (never silently hidden)', () => {
  const props = {
    ...base(),
    closed: true,
    pending: [CAROL],
    joinQueue: [{pubkey: CAROL, invited: true}],
    invited: [{p: CAROL, by: ME, at: 1}],
    onInvitePeople: jest.fn(),
  };
  const tree = render(props);
  openManage(tree);
  // Still absent from "No pending requests." — the requester IS visible.
  expect(allText(tree)).not.toContain('No pending requests.');
  expect(allText(tree)).toContain('Invited · waiting to be let in');
  // The invited MEMBERS strip (a different section) still shows its own INVITED tag/caption.
  expect(allText(tree)).toContain('INVITED');
  expect(allText(tree)).toContain('Waiting for them to accept');
  // And the row's Approve action actually works.
  const approveBtn = tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`);
  expect(approveBtn.length).toBeGreaterThan(0);
  act(() => { approveBtn[0]!.props.onPress(); });
  expect(props.onApprove).toHaveBeenCalledWith(CAROL);
});

it('an invited+pending requester can also be declined from the review queue', () => {
  const props = {
    ...base(),
    closed: true,
    pending: [CAROL],
    joinQueue: [{pubkey: CAROL, invited: true}],
    invited: [{p: CAROL, by: ME, at: 1}],
    onInvitePeople: jest.fn(),
  };
  const tree = render(props);
  openManage(tree);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `deny-${CAROL}`)[0]!.props.onPress();
  });
  expect(props.onDeny).toHaveBeenCalledWith(CAROL);
});

// Incidental (in scope): a silently-bounced approve would recreate this whole incident invisibly.
it('a rejected approve un-freezes the resolved card back into a live, retryable row', () => {
  const onGetRosterActionStatus = jest.fn().mockReturnValue(undefined);
  const props = {
    ...base(),
    closed: true,
    pending: [CAROL],
    joinQueue: [{pubkey: CAROL, at: 1234, invited: false}],
    onGetRosterActionStatus,
  };
  const tree = render(props);
  openManage(tree);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`)[0]!.props.onPress();
  });
  // Optimistic: shows resolved immediately, no bounce signal yet.
  expect(allText(tree)).toContain('Approved — added to members');
  expect(tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`)).toHaveLength(0);

  // The relay terminally rejected the publish (AppRuntime.getRosterActionStatus now reports it).
  onGetRosterActionStatus.mockReturnValue({status: 'rejected', reason: 'blocked: not an admin'});
  act(() => { tree.update(<GroupView {...props} />); });

  // The false "✓ Approved" is gone; the row is back, live and actionable, with a visible hint.
  expect(allText(tree)).not.toContain('Approved — added to members');
  expect(allText(tree)).toContain("Didn't go through last time");
  const approveAgain = tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`);
  expect(approveAgain.length).toBeGreaterThan(0);
  act(() => { approveAgain[0]!.props.onPress(); });
  expect(props.onApprove).toHaveBeenCalledTimes(2);
});

it('a non-terminal (failed/retrying) approve keeps showing resolved, no false bounce', () => {
  const onGetRosterActionStatus = jest.fn().mockReturnValue({status: 'failed'});
  const props = {
    ...base(),
    closed: true,
    pending: [CAROL],
    joinQueue: [{pubkey: CAROL, invited: false}],
    onGetRosterActionStatus,
  };
  const tree = render(props);
  openManage(tree);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`)[0]!.props.onPress();
  });
  expect(allText(tree)).toContain('Approved — added to members');
  expect(allText(tree)).not.toContain("Didn't go through last time");
});

it('the invited strip revoke ✕ calls onRevokeInvite', () => {
  const onRevokeInvite = jest.fn();
  const props = {...base(), invited: [{p: CAROL, by: ME, at: 1}], onInvitePeople: jest.fn(), onRevokeInvite};
  const tree = render(props);
  openManage(tree);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === `revoke-invite-${CAROL}`)[0]!.props.onPress();
  });
  expect(onRevokeInvite).toHaveBeenCalledWith(CAROL);
});

it('copies a nostr:-prefixed link from a plain group-chat bubble\'s ⋯ menu (B12)', () => {
  // The fixture message id ('m1') isn't valid 64-hex, so the helper takes its bare-id fallback path
  // — still asserting the bug fix that matters here: EVERY branch is nostr:-prefixed, where the
  // pre-fix code called nip19.neventEncode directly with no scheme at all.
  const tree = render(base());
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'message actions')[0]!.props.onPress();
  });
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'copy-link-m1')[0]!.props.onPress();
  });
  expect(Clipboard.setString).toHaveBeenCalledWith(expect.stringMatching(/^nostr:/));
});

// Surface audit (T4.4): a PLAIN (non-broadcast) group-chat bubble never offered "Enable replies" at
// all — promoteChannelPost accepts any GroupKind.Chat message just as readily as a broadcast card, so
// the affordance was simply missing on this surface. Author-only; hidden once already promoted.
describe('plain group-chat bubble — "Enable replies" surface (T4.4 surface audit)', () => {
  const myMessage: Event = {id: 'mine1', pubkey: ME, created_at: 2, kind: 9, tags: [['h', 'g1']], content: 'my own words', sig: 's'};

  it('offers "Turn on replies" via the ⋯ menu for MY OWN plain chat message', () => {
    const onEnableReplies = jest.fn();
    const tree = render({...base(), messages: [myMessage], onEnableReplies});
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'message actions')[0]!.props.onPress();
    });
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `enable-replies-${myMessage.id}`)[0]!.props.onPress();
    });
    expect(onEnableReplies).toHaveBeenCalledWith(myMessage);
  });

  it('hides "Turn on replies" for someone ELSE\'s plain chat message (author-only)', () => {
    const onEnableReplies = jest.fn();
    // `messages` (module fixture) is authored by BOB, not ME.
    const tree = render({...base(), onEnableReplies});
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'message actions')[0]!.props.onPress();
    });
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'enable-replies-m1')).toHaveLength(0);
  });

  it('hides "Turn on replies" once the message is already promoted', () => {
    const onEnableReplies = jest.fn();
    const promoted: Event = {...myMessage, tags: [...myMessage.tags, ['promoted', 'f'.repeat(64)]]};
    const tree = render({...base(), messages: [promoted], onEnableReplies});
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'message actions')[0]!.props.onPress();
    });
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `enable-replies-${promoted.id}`)).toHaveLength(0);
  });

  it('a PROMOTED plain chat message renders a tap-through "view discussion" row wired to onOpenPromoted', () => {
    const feedId = 'f'.repeat(64);
    const onOpenPromoted = jest.fn();
    const promoted: Event = {...myMessage, tags: [...myMessage.tags, ['promoted', feedId]]};
    const tree = render({...base(), messages: [promoted], onOpenPromoted, getFeedReplyCount: () => 5});
    expect(allText(tree)).toContain('view discussion');
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `open-promoted-${promoted.id}`)[0]!.props.onPress();
    });
    expect(onOpenPromoted).toHaveBeenCalledWith(feedId);
  });
});

it('the quick sheet Share row copies the stiq:space share token', () => {
  const props = {...base(), isPrivate: true, shareToken: 'stiq:space:AbCd123'};
  const tree = render(props);
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'group-info')[0]!.props.onPress();
  });
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'share-space')[0]!.props.onPress();
  });
  expect(Clipboard.setString).toHaveBeenCalledWith('stiq:space:AbCd123');
  // The row schedules a 1.8s "Link copied" reset timer; unmount so it can't fire against a
  // torn-down tree once this test is done (a leaked real timer otherwise crashes the runner).
  act(() => { tree.unmount(); });
});

it('group chats no longer expose an inline reply affordance', () => {
  // The kind-12 inline reply was removed from group chats (private/broadcast channels get the
  // channel comment section instead). A plain group-chat message shows no reply control.
  const tree = render(base());
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'reply-m1')).toHaveLength(0);
});

it('isolates composer keystrokes — typing a message does NOT re-render the memoized rows', () => {
  // decodeNameHeader runs once per chat bubble's body on render. renderRow is stabilized with
  // useCallback (draft is NOT a dep) and MessageItem is React.memo'd, so a keystroke must not churn
  // the rendered rows (parity with ChannelView's equivalent test).
  const spy = jest.spyOn(displayName, 'decodeNameHeader');
  const tree = render(base());
  const baseline = spy.mock.calls.length;
  expect(baseline).toBeGreaterThan(0); // the message decoded its body on mount

  const input = tree.root
    .findAll(n => n.props.accessibilityLabel === 'group-composer')[0];
  expect(input).toBeDefined();
  act(() => { input!.props.onChangeText('h'); });
  act(() => { input!.props.onChangeText('hi'); });

  // No row re-decoded → the visible MessageItems did not re-render on the keystrokes.
  expect(spy.mock.calls.length).toBe(baseline);
  spy.mockRestore();
});

describe('Add people (invite-only multi-select — no direct add exists any more)', () => {
  const DANA = 'd'.repeat(64);
  function openAddPeople(tree: renderer.ReactTestRenderer): void {
    openManage(tree);
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'add-people')[0]!.props.onPress();
    });
  }

  it('there is no direct add-member entry point anywhere', () => {
    const tree = render({...base(), onInvitePeople: jest.fn()});
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'add-member')).toHaveLength(0);
    expect(tree.root.findAll(n => n.props.placeholder === 'Hex pubkey or npub…')).toHaveLength(0);
  });

  it('multi-selects from the phone book (members excluded) and sends invites — never onAddMember', () => {
    // Phone book offers CAROL + DANA (not members) and BOB (already a member → excluded).
    const onGetPhonebook = jest.fn(() => [
      {pubkey: CAROL, npub: 'npub1carol', name: 'Carol', gradient: null},
      {pubkey: DANA, npub: 'npub1dana', name: 'Dana', gradient: null},
      {pubkey: BOB, npub: 'npub1bob', name: 'Bob', gradient: null},
    ]);
    const onInvitePeople = jest.fn();
    const props = {...base(), onGetPhonebook, onInvitePeople}; // members: [ME, BOB]
    const tree = render(props);
    openAddPeople(tree);

    // BOB (already a member) is filtered out entirely.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `invite-pick-${BOB}`)).toHaveLength(0);
    // No selection yet → the footer is the disabled hint, not a send button.
    expect(allText(tree)).toContain('Select people to invite');

    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `invite-pick-${CAROL}`)[0]!.props.onPress();
    });
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `invite-pick-${DANA}`)[0]!.props.onPress();
    });
    expect(allText(tree)).toContain('Send 2 invites');
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'send-invites')[0]!.props.onPress();
    });
    expect(onInvitePeople).toHaveBeenCalledWith(expect.arrayContaining([CAROL, DANA]));
    expect(props.onAddMember).not.toHaveBeenCalled();
  });

  it('an already-invited contact renders dimmed with the INVITED tag and is not selectable', () => {
    const onGetPhonebook = jest.fn(() => [
      {pubkey: CAROL, npub: 'npub1carol', name: 'Carol', gradient: null},
    ]);
    const props = {
      ...base(),
      onGetPhonebook,
      onInvitePeople: jest.fn(),
      invited: [{p: CAROL, by: ME, at: 1}],
    };
    const tree = render(props);
    openAddPeople(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `invite-pick-${CAROL}`)).toHaveLength(0);
    expect(allText(tree)).toContain('INVITED');
    expect(allText(tree)).toContain('Select people to invite');
  });
});

// B6: status-pill parity — a broadcast/private-channel message renders BroadcastCard, which owns
// the SendProgress status pill; GroupView just has to plumb sendStatus/sendReasons/onRetry/onCancel
// through to it, mirroring ChannelView.
describe('send-status pill parity (B6)', () => {
  function broadcastProps(extra: Partial<GroupViewProps> = {}) {
    return {
      ...base(),
      broadcast: true,
      messages: [{id: 'm1', pubkey: ME, created_at: 1, kind: 9, tags: [], content: 'hello', sig: 's'}] as Event[],
      ...extra,
    };
  }

  it('renders the failed pill + relay reason + Retry/Cancel when sendStatus/sendReasons are provided', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(broadcastProps({
      sendStatus: new Map([['m1', 'failed']]),
      sendReasons: new Map([['m1', 'blocked: rejected']]),
      onRetry,
      onCancel,
    }));
    const text = allText(tree);
    expect(text).toContain('failed');
    expect(text).toContain('blocked: rejected');
    expect(text).toContain('Retry');
    expect(text).toContain('Cancel');
  });

  it('renders no status pill at all when sendStatus is omitted', () => {
    const tree = render(broadcastProps());
    expect(allText(tree)).not.toContain('failed');
  });

  it('Retry/Cancel call back with the message id', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(broadcastProps({sendStatus: new Map([['m1', 'failed']]), onRetry, onCancel}));
    // Match the Pressable itself (its `children` prop is the un-rendered <Text>Retry</Text> element)
    // rather than assuming a fixed parent/child shape inside Pressable's own implementation.
    const findByLabel = (label: string) =>
      tree.root.findAll(
        n => typeof n.props.onPress === 'function' && n.props.children?.props?.children === label,
      )[0]!;
    act(() => { findByLabel('Retry').props.onPress(); });
    expect(onRetry).toHaveBeenCalledWith('m1');
    act(() => { findByLabel('Cancel').props.onPress(); });
    expect(onCancel).toHaveBeenCalledWith('m1');
  });
});

// T0.4: the PLAIN (non-broadcast) group-chat bubble now renders the same ✕/reason/Retry/Cancel shape
// as the broadcast card above (copies DmBubble's pattern) instead of a bare, unexplained "✕" glyph
// with no tap target at all — previously a rejected/token-exhausted group message here had a fully-
// capable backend retry (AppRuntime.retry) sitting completely unreachable (F3 part 2).
describe('group-chat bubble failed/Retry (T0.4)', () => {
  function chatProps(extra: Partial<GroupViewProps> = {}) {
    return {
      ...base(),
      broadcast: false, // channelFeed=broadcast, so this keeps the PLAIN bubble path (not BroadcastCard)
      messages: [
        {id: 'm1', pubkey: ME, created_at: 1, kind: 9, tags: [['h', 'g1']], content: 'hello', sig: 's'},
      ] as Event[],
      ...extra,
    };
  }
  // Pressable forwards accessibilityLabel down through its internal View wrapper(s), so a bare label
  // match returns several nodes for the SAME logical control — narrow to the one that is ALSO directly
  // pressable (has a function `onPress`), mirroring the file's other accessibilityLabel lookups.
  const findByLabel = (tree: renderer.ReactTestRenderer, label: string) =>
    tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');

  it('renders the failed row + calm reason on a rejected/exhausted OWN group message', () => {
    const tree = render(chatProps({
      sendStatus: new Map([['m1', 'failed']]),
      sendReasons: new Map([['m1', "You're out of tokens to send here."]]),
    }));
    const text = allText(tree);
    expect(text).toContain('failed');
    expect(text).toContain('tokens to send here');
  });

  it('a pressable Retry invokes onRetry with the message id — the actual T0.4 fix', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(chatProps({sendStatus: new Map([['m1', 'failed']]), onRetry, onCancel}));
    // Pressable forwards accessibilityLabel/onPress through an internal wrapper layer, so more than
    // one fiber can match the same logical control (react-test-renderer implementation detail) —
    // assert PRESENCE, not an exact count, and press via the first match (matches this file's other
    // accessibilityLabel-based lookups, e.g. `findAll(...)[0]!.props.onPress()` above).
    expect(findByLabel(tree, 'retry-message').length).toBeGreaterThan(0);
    expect(findByLabel(tree, 'cancel-message').length).toBeGreaterThan(0);
    act(() => { findByLabel(tree, 'retry-message')[0]!.props.onPress(); });
    expect(onRetry).toHaveBeenCalledWith('m1');
    expect(onCancel).not.toHaveBeenCalled();
    act(() => { findByLabel(tree, 'cancel-message')[0]!.props.onPress(); });
    expect(onCancel).toHaveBeenCalledWith('m1');
  });

  it('a REJECTED (not failed) message offers Cancel but no Retry — same terminal-state rule as SendProgress', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(chatProps({sendStatus: new Map([['m1', 'rejected']]), onRetry, onCancel}));
    expect(findByLabel(tree, 'retry-message')).toHaveLength(0); // re-sending the same event is futile
    expect(findByLabel(tree, 'cancel-message').length).toBeGreaterThan(0);
  });

  it('renders no Retry/Cancel Pressable when GroupView is given no onRetry/onCancel handlers', () => {
    const tree = render(chatProps({sendStatus: new Map([['m1', 'failed']])}));
    // Still shows the failed row itself (the ✕ + whatever reason), just nothing pressable.
    expect(allText(tree)).toContain('failed');
    expect(findByLabel(tree, 'retry-message')).toHaveLength(0);
    expect(findByLabel(tree, 'cancel-message')).toHaveLength(0);
  });

  it('falls back to the bare glyph (unchanged) for sending/confirmed — only failed/rejected get the row', () => {
    const sending = render(chatProps({sendStatus: new Map([['m1', 'sending']])}));
    expect(findByLabel(sending, 'retry-message')).toHaveLength(0);
    expect(findByLabel(sending, 'cancel-message')).toHaveLength(0);
    const confirmed = render(chatProps({sendStatus: new Map([['m1', 'confirmed']])}));
    expect(findByLabel(confirmed, 'retry-message')).toHaveLength(0);
    expect(allText(confirmed)).not.toContain('failed');
  });
});

// 2026-07-22 (owner directive, reverting that day's earlier space-defaults fallback): a space whose
// owner never set reaction emojis renders ZERO chips. The fallback to spaceRules.ts
// DEFAULT_SPACE_REACTIONS shipped seven emojis on every fresh channel that nobody chose; that list is
// now suggestion-only. A space that DOES configure its own set still renders exactly that set.
describe('reaction chips (unconfigured space renders NO chips — no default palette)', () => {
  function broadcastChatProps(extra: Partial<GroupViewProps> = {}) {
    return {
      ...base(),
      broadcast: true,
      messages: [{id: 'm1', pubkey: ME, created_at: 1, kind: 9, tags: [], content: 'hello', sig: 's'}] as Event[],
      ...extra,
    };
  }
  /** ReactionChips labels each chip `react <emoji>` (space-joined) — distinct from the group-chat
   *  ⋯-menu ReactionBar's `react-<emoji>` (dash-joined), so this prefix only matches rendered chips.
   *  A single Pressable surfaces its accessibilityLabel on more than one fiber layer in this renderer
   *  (same convention as this file's other accessibilityLabel checks), so dedupe to unique chips. */
  function reactionChipLabels(tree: renderer.ReactTestRenderer): string[] {
    const labels = tree.root
      .findAll(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('react '))
      .map(n => n.props.accessibilityLabel as string);
    return [...new Set(labels)];
  }

  it('a broadcast/private-channel message in a space with no configured reactions renders NO chips', () => {
    const tree = render(broadcastChatProps());
    expect(reactionChipLabels(tree)).toEqual([]);
  });

  it('renders none of the suggestion-palette emojis when the space configured nothing', () => {
    const tree = render(broadcastChatProps());
    for (const emoji of DEFAULT_SPACE_REACTIONS) {
      expect(reactionChipLabels(tree)).not.toContain(`react ${emoji}`);
    }
  });

  it('reactions={["👍"]} renders exactly the one configured 👍 chip — an owner set still wins outright', () => {
    const tree = render(broadcastChatProps({reactions: ['👍']}));
    expect(reactionChipLabels(tree)).toEqual(['react 👍']);
  });
});

// Private-channel card parity: a private/broadcast channel post must render IDENTICAL to a public
// channel post (no author header, no members-bar banner) with exactly ONE addition — a clickable
// footer author gradient circle. The old members bar ("🔐 … admin(s) … member(s)" + "🔒 Encrypted")
// and the per-message ADMIN trailing badge are both gone; member/admin info now lives only on the
// Manage sheet.
describe('private-channel card parity (no members bar; footer author circle is the one addition)', () => {
  function privateBroadcastProps(extra: Partial<GroupViewProps> = {}) {
    return {
      ...base(),
      broadcast: true,
      isPrivate: true,
      admins: [ME, BOB], // BOB (the author below) is an admin — exercises the removed-badge path.
      messages: [{id: 'm1', pubkey: BOB, created_at: 1, kind: 9, tags: [], content: 'hello', sig: 's'}] as Event[],
      ...extra,
    };
  }

  it('renders no "Members-only"/"Invite-only" banner, no admin/member counts, and no "Encrypted" pill', () => {
    const text = allText(render(privateBroadcastProps()));
    expect(text).not.toContain('Members-only');
    expect(text).not.toContain('Invite-only');
    expect(text).not.toContain('Encrypted');
    expect(text).not.toMatch(/\d+ admins?\b/);
  });

  it('renders no per-message ADMIN trailing badge and no per-message author-header row', () => {
    const tree = render(privateBroadcastProps());
    expect(allText(tree)).not.toContain('ADMIN');
    // AuthorHeader's avatar renders at ctAvatar.cardAuthor (22dp); a private/broadcast post must
    // show none — showAuthor is now false, matching public (non-open) channel cards.
    expect(findAvatars(tree).some(n => n.props.size === 22)).toBe(false);
  });

  it('carries the footer author-avatar circle (18dp, shape="circle"), seeded from the message author', () => {
    const tree = render(privateBroadcastProps());
    const footerAvatar = findAvatars(tree).find(n => n.props.shape === 'circle' && n.props.size === 18);
    expect(footerAvatar).toBeDefined();
  });

  it('the footer author-avatar tap reuses onOpenMember with the message author\'s pubkey', () => {
    const onOpenMember = jest.fn();
    const tree = render(privateBroadcastProps({onOpenMember}));
    const authorPressable = tree.root.findAll(n => n.props.accessibilityLabel === 'Author')[0];
    expect(authorPressable).toBeDefined();
    act(() => { authorPressable!.props.onPress(); });
    expect(onOpenMember).toHaveBeenCalledWith(BOB);
  });

  it('renders no "Author" pressable when onOpenMember is not provided (avatar stays a plain, non-tappable circle)', () => {
    const tree = render(privateBroadcastProps({onOpenMember: undefined}));
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Author')).toHaveLength(0);
    // The avatar itself still renders — just without a Pressable wrapper.
    expect(findAvatars(tree).some(n => n.props.shape === 'circle' && n.props.size === 18)).toBe(true);
  });
});

// B12: the plain-chat bubble path forwards onLookupEvent/onOpenRef into ChatBubble (mapped onto
// its onLookupEvent/onOpenNostrPost props) so REFERENCED embeds inside DM-style group bubbles work.
it('maps onLookupEvent/onOpenRef onto the chat bubble for a plain (non-broadcast) group message', () => {
  mockChatBubbleProps.length = 0;
  const onLookupEvent = jest.fn(() => null);
  const onOpenRef = jest.fn();
  render({...base(), onLookupEvent, onOpenRef});
  expect(mockChatBubbleProps).toHaveLength(1);
  expect(mockChatBubbleProps[0]!.onLookupEvent).toBe(onLookupEvent);
  expect(mockChatBubbleProps[0]!.onOpenNostrPost).toBe(onOpenRef);
});

// B3: scroll-back pagination hook — onEndReached fires onLoadOlder, guarded against refiring for
// an unchanged message set within the debounce window.
describe('onLoadOlder pagination hook (B3)', () => {
  function findChatList(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll(n => typeof n.props.onEndReached === 'function' && Array.isArray(n.props.data))[0]!;
  }

  it('fires onLoadOlder when the list reaches its end', () => {
    const onLoadOlder = jest.fn();
    const tree = render({...base(), onLoadOlder});
    act(() => { findChatList(tree).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not refire for the same message set within the debounce window', () => {
    const onLoadOlder = jest.fn();
    const tree = render({...base(), onLoadOlder});
    act(() => { findChatList(tree).props.onEndReached(); });
    act(() => { findChatList(tree).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('is allowed to refire once the message count has grown (a page landed)', () => {
    const onLoadOlder = jest.fn();
    const props = {...base(), onLoadOlder};
    const tree = render(props);
    act(() => { findChatList(tree).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    const grown = [...messages, {id: 'm2', pubkey: BOB, created_at: 2, kind: 9, tags: [['h', 'g1']], content: 'older', sig: 's'} as Event];
    act(() => {
      tree.update(<GroupView {...props} messages={grown} />);
    });
    act(() => { findChatList(tree).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});

// No.13b (group parity): swipe-to-reply must focus the composer, mirroring ConversationView.
it('focuses the composer input when a group-chat swipe-to-reply begins', () => {
  const {SwipeToReply} = jest.requireActual('./primitives') as typeof import('./primitives');
  const tree = render(base());

  const input = tree.root.findAll(n => n.props.accessibilityLabel === 'group-composer')[0]!;
  expect(typeof (input.instance as {focus?: unknown} | null)?.focus).toBe('function');
  const focusSpy = jest.spyOn(input.instance as {focus: () => void}, 'focus');

  const swipeRows = tree.root.findAllByType(SwipeToReply);
  expect(swipeRows.length).toBeGreaterThan(0);
  act(() => {
    swipeRows[0]!.props.onReply();
  });

  expect(focusSpy).toHaveBeenCalled();
  focusSpy.mockRestore();
});

// CHUNK 5: a saved PRIVATE SPACE embed (kind 39000) must show up in the composer's "SAVED · TAP TO
// EMBED" picker as a channel-card row (label + name, no post snippet) and insert the stiq:space:…
// token verbatim — never an nostr:nevent… link, which would silently drop the carried name.
describe('saved PRIVATE SPACE embed picker (stiq:space token, not nevent)', () => {
  /** Walk UP from a matching title Text node to the nearest onPress ancestor (see FullMessageEditor
   *  savedEmbeds tests for why searching top-down from every onPress node picks the sheet backdrop
   *  instead of the row). */
  function pressRow(tree: renderer.ReactTestRenderer, title: string): void {
    const textNode = tree.root.findAll(n => (n.type as unknown) === 'Text' && n.props.children === title)[0];
    if (!textNode) throw new Error(`no saved row titled "${title}"`);
    let node: typeof textNode | null = textNode.parent;
    while (node && typeof node.props?.onPress !== 'function') node = node.parent;
    if (!node) throw new Error(`no pressable ancestor for "${title}"`);
    act(() => { node!.props.onPress(); });
  }

  const spaceOwner = 'e'.repeat(64);

  afterEach(async () => {
    await removeEmbed(`39000:${spaceOwner}:inner`);
  });

  it('renders a PRIVATE SPACE row and appends the stiq:space token (not nevent) to the draft', async () => {
    await saveSpaceEmbed({id: 'inner', owner: spaceOwner, name: 'Inner Circle'}, 1);

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<GroupView {...base()} />);
    });

    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add')[0]!.props.onPress(); });
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add-Embed a post')[0]!.props.onPress(); });

    const text = allText(tree!);
    expect(text).toContain('PRIVATE SPACE');
    expect(text).toContain('Inner Circle');

    pressRow(tree!, 'Inner Circle');

    const input = tree!.root.findAll(n => n.props.accessibilityLabel === 'group-composer')[0]!;
    const value = input.props.value as string;
    expect(value.startsWith('stiq:space:')).toBe(true);
    expect(value).not.toContain('nevent');
  });
});

// Owner-consent gate for the community log picker (channels/logOffer.ts) — a Manage-page Switch
// gated to owner + private + a wired handler; toggling it publishes/revokes the offer via the props
// MainScreen wires from AppRuntime.{getLogOffer,setLogOffer,revokeLogOffer}.
describe('Offer to community log (Manage page)', () => {
  it('renders for an owner of a private space with the handler wired', () => {
    const props = {...base(), isOwner: true, isPrivate: true, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn()};
    const tree = render(props);
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle').length).toBeGreaterThan(0);
    expect(allText(tree)).toContain('Offer to community log');
  });

  it('is absent for a non-owner, even when private and the handler is wired', () => {
    const props = {...base(), isOwner: false, isPrivate: true, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn()};
    const tree = render(props);
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')).toHaveLength(0);
  });

  it('is absent for a non-private space, even for the owner', () => {
    const props = {...base(), isOwner: true, isPrivate: false, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn()};
    const tree = render(props);
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')).toHaveLength(0);
  });

  it('is absent when no onSetLogOffer handler is wired', () => {
    const props = {...base(), isOwner: true, isPrivate: true};
    const tree = render(props);
    openManage(tree);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')).toHaveLength(0);
  });

  it('the Switch value reflects the current logOffer prop', () => {
    const offer = {v: 1 as const, gid: 'g1', n: 'Builders', g: '', pr: true, cl: false, bc: false, at: 1};
    const on = render({...base(), isOwner: true, isPrivate: true, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn(), logOffer: offer});
    openManage(on);
    expect(on.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')[0]!.props.value).toBe(true);

    const off = render({...base(), isOwner: true, isPrivate: true, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn(), logOffer: null});
    openManage(off);
    expect(off.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')[0]!.props.value).toBe(false);
  });

  it('toggling ON fires onSetLogOffer; toggling OFF fires onRevokeLogOffer', () => {
    const props = {...base(), isOwner: true, isPrivate: true, onSetLogOffer: jest.fn(), onRevokeLogOffer: jest.fn()};
    const tree = render(props);
    openManage(tree);
    const toggle = tree.root.findAll(n => n.props.accessibilityLabel === 'log-offer-toggle')[0]!;
    act(() => { toggle.props.onValueChange(true); });
    expect(props.onSetLogOffer).toHaveBeenCalledTimes(1);
    expect(props.onRevokeLogOffer).not.toHaveBeenCalled();

    act(() => { toggle.props.onValueChange(false); });
    expect(props.onRevokeLogOffer).toHaveBeenCalledTimes(1);
  });

  // Phase 4 (draft-editor-overhaul): the full editor (ComposerScreen, opened by the composer's ⤢
  // expand button) is now a real DraftStore participant for this group/broadcast's location — it
  // self-persists (autosave/long-press/delete-on-send) into the SAME single per-location slot the
  // compact composer's own keystrokes already write to (useInProgressDraft), keyed by the stable
  // inProgressDraftId. These pin the wiring end-to-end: a draft saved under that id hydrates the
  // compact composer on mount (the resume() surface actually shows the resumed text), the editor
  // receives the matching draftStore/draftLocation props, and both are withheld while editing an
  // EXISTING message (the slot is for the next NEW message only).
  describe('Phase 4 — location-tagged in-progress drafts', () => {
    const loc: DraftLocation = {kind: 'channel', channelId: 'g1', channelType: 'private', channelName: 'Builders'};

    it('hydrates the compact composer from a persisted per-group draft on mount (resume() end-to-end)', async () => {
      const store = new DraftStore(new InMemorySecureStorage());
      await store.save({id: inProgressDraftId(loc), title: '', content: 'resumed group message', tags: [], savedAt: Date.now(), location: loc});

      let tree: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        tree = renderer.create(<GroupView {...base()} draftStore={store} />);
      });
      // Let the mount-time slot.load() promise resolve.
      // eslint-disable-next-line @typescript-eslint/require-await
      await act(async () => undefined);

      const input = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Message');
      expect(input!.props.value).toBe('resumed group message');
    });

    it('passes draftStore + draftLocation into the full editor so it can self-persist', () => {
      const store = new DraftStore(new InMemorySecureStorage());
      const tree = render({...base(), draftStore: store});
      const composer = tree.root.findByType(ComposerScreen);
      expect(composer.props.draftStore).toBe(store);
      expect(composer.props.draftLocation).toEqual(loc);
    });

    it('withholds draftStore/draftLocation from the full editor while editing an EXISTING message', () => {
      const store = new DraftStore(new InMemorySecureStorage());
      const tree = render({...base(), draftStore: store, onEditGroupMessage: jest.fn()});
      // MessageItem receives the parent's stable start-edit callback as `onStartEdit` — call it
      // directly to enter edit mode without needing a specific author/permission setup.
      const startEdit = tree.root.findAll(n => typeof n.props?.onStartEdit === 'function')[0]!;
      act(() => { (startEdit.props.onStartEdit as (id: string, content: string) => void)('m1', 'hi group'); });
      const composer = tree.root.findByType(ComposerScreen);
      expect(composer.props.draftStore).toBeUndefined();
      expect(composer.props.draftLocation).toBeUndefined();
    });
  });
});

describe('stale-first empty state (Phase 5)', () => {
  it('suppresses "No messages yet." while the scoped history fetch is still pending', () => {
    const tree = render({...base(), messages: [], historyPending: true});
    expect(allText(tree)).not.toContain('No messages yet.');
  });

  it('shows the genuine empty state once history has settled (and by default, prop omitted)', () => {
    expect(allText(render({...base(), messages: [], historyPending: false}))).toContain('No messages yet.');
    expect(allText(render({...base(), messages: []}))).toContain('No messages yet.');
  });

  it('historyPending never hides REAL messages — it only gates the empty claim', () => {
    const tree = render({...base(), historyPending: true});
    expect(allText(tree)).toContain('hi group');
    expect(allText(tree)).not.toContain('No messages yet.');
  });
});

/**
 * Hardware BACK peels ONE level of the space's own screen stack.
 *
 * THE BUG: `screen` ('chat' | 'manage' | 'addpeople') lived entirely inside this component, so the
 * only thing that could answer the back key was MainScreen's root ladder — whose closeOpenGroupView
 * shut the WHOLE space. One press from Add people threw away two levels and the space with them.
 * The registered action (BACK_PRIORITY.page) now mirrors the ‹ controls exactly; on 'chat' it stands
 * down so the root ladder can do its job and close the space.
 */
describe('hardware BACK peels one screen at a time', () => {
  /** Renders inside the root scope and returns a press-the-back-key callable. */
  function renderWithBack(props: GroupViewProps): {tree: renderer.ReactTestRenderer; back: () => boolean} {
    const handlers: Array<() => boolean> = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, cb: () => boolean) => {
      handlers.push(cb);
      return {remove: jest.fn()};
    }) as unknown as typeof BackHandler.addEventListener);
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <RootBackScope>
          <GroupView {...props} />
        </RootBackScope>,
      );
    });
    return {tree: tree!, back: () => handlers[handlers.length - 1]!()};
  }

  afterEach(() => jest.restoreAllMocks());

  it('Add people → Manage → chat, one press each, never closing the space', () => {
    const onBack = jest.fn();
    const {tree, back} = renderWithBack({...base(), onBack, onGetPhonebook: () => [], onInvitePeople: jest.fn()});
    openManage(tree);
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === 'add-people')[0]!.props.onPress();
    });
    expect(allText(tree)).toContain('Select people to invite'); // on Add people

    act(() => { expect(back()).toBe(true); });
    // Back on Manage, NOT closed — the "add-people" chip is a Manage-page control.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'add-people').length).toBeGreaterThan(0);
    expect(onBack).not.toHaveBeenCalled();

    act(() => { expect(back()).toBe(true); });
    // Back on chat: the Manage page's own back control is gone.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'manage-back')).toHaveLength(0);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('stands down on the chat screen, so the space itself is what closes', () => {
    const {back} = renderWithBack({...base(), onBack: jest.fn()});
    // Nothing registered at this level → unhandled here, and MainScreen's ladder closes the space.
    act(() => { expect(back()).toBe(false); });
  });
});
