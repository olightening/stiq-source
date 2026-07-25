// AUTHOR_NOTE_ENABLED (config.ts) — ship-dark for bug 7 (author's note). jest.mock hoists above
// the imports, same pattern as MainScreen.backhandler.test.tsx's TIMING_JITTER override. Forcing
// the flag ON here (it currently ships default OFF) pins that flipping it back on restores
// today's full author's-note UI byte-identical. The OFF side lives in
// MainScreen.authorNote.off.test.tsx — see that file for why this needs a separate test file
// rather than jest.resetModules() within one (it desyncs the React module instance
// react-test-renderer holds, producing a null-hook crash).
jest.mock('../../config', () => ({...jest.requireActual('../../config'), AUTHOR_NOTE_ENABLED: true}));

/**
 * MainScreen → Author's-note (pinned comment) ship-dark gate, ON side.
 *
 * Pins the restoration contract for bug 7: with AUTHOR_NOTE_ENABLED forced on, the "AUTHOR'S
 * NOTE" block renders exactly as it does today — the pinned comment's text, the author's "Edit"
 * affordance + "only you can edit this note" byline, and the "view prior edits" entry point that
 * opens a history dialog listing every earlier version.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../../nostr/events';
import {buildPost} from '../../feed/compose';
import {toFeedItem, type FeedItem} from '../../feed/feed';
import type {PinnedCommentHistory} from '../../feed/pinned';
import {FeedList} from '../../feed/components/FeedList';
import {MainScreen, type MainScreenProps} from './MainScreen';

const OWNER = 'a'.repeat(64);
const POST_ID = 'p'.repeat(64);
const NOTE_ID = 'n'.repeat(64);
const OLD_NOTE_ID = 'o'.repeat(64);
const emptyFeed = {items: [], log: []};
const noop = (): void => undefined;

function pinEvent(id: string, content: string, createdAt: number): Event {
  return {
    id,
    pubkey: OWNER,
    created_at: createdAt,
    kind: Kind.Comment,
    tags: [
      ['E', POST_ID, '', OWNER],
      ['K', '1'],
      ['P', OWNER],
      ['e', POST_ID, '', OWNER],
      ['k', '1'],
      ['p', OWNER],
      ['stiq-pin', POST_ID],
    ],
    content,
    sig: 's'.repeat(128),
  };
}

const HISTORY: PinnedCommentHistory = {
  latest: pinEvent(NOTE_ID, 'Correction: the meetup moved to Thursday.', 200),
  history: [pinEvent(OLD_NOTE_ID, 'The meetup is Wednesday.', 100)],
};

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function pressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function');
}

/** True when any node's flattened text contains `substr`. */
function hasText(tree: renderer.ReactTestRenderer, substr: string): boolean {
  return tree.root.findAll(() => true).some(n => textOf(n).includes(substr));
}

function makeOpenPostItem(): FeedItem {
  const unsigned = buildPost('Short note about the community meetup.', []);
  const event = {...unsigned, id: POST_ID, pubkey: OWNER, sig: 's'.repeat(128)} as unknown as Event;
  return toFeedItem(event);
}

// P1-1 (UI-freeze A2) defers threadNodes via InteractionManager.runAfterInteractions — flush it
// inside act() after each test so it never fires after the module has torn down (see the same
// afterEach in MainScreen.spaceEmbed.test.tsx).
afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

function renderOpenPostDetail(
  onSetPinnedComment: MainScreenProps['onSetPinnedComment'] = jest.fn(),
): renderer.ReactTestRenderer {
  const onGetPinnedHistory = jest.fn((): PinnedCommentHistory => HISTORY);
  const props: MainScreenProps = {
    currentUserPubkey: OWNER,
    isModerator: false,
    sendStatus: new Map(),
    onVote: noop,
    onCreateChannel: noop,
    onPostToChannel: noop,
    onGetThread: () => [],
    onSubmit: noop,
    onSendDm: noop,
    feed: emptyFeed,
    inbox: [],
    channels: [],
    onGetChannelMessages: () => [],
    onGetPinnedHistory,
    onSetPinnedComment,
  } as unknown as MainScreenProps;

  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<MainScreen {...props} />);
  });

  const item = makeOpenPostItem();
  const feedList = tree.root.findByType(FeedList);
  act(() => {
    (feedList.props.onItemPress as (i: FeedItem) => void)(item);
  });

  return tree;
}

describe("MainScreen — author's-note ship-dark, AUTHOR_NOTE_ENABLED=true", () => {
  it("shows the note text, the author's edit affordance, and the history entry point", () => {
    const tree = renderOpenPostDetail();

    expect(hasText(tree, "AUTHOR'S NOTE")).toBe(true);
    expect(hasText(tree, 'Correction: the meetup moved to Thursday.')).toBe(true);
    expect(pressables(tree).some(n => textOf(n).trim() === 'Edit')).toBe(true);
    expect(hasText(tree, 'only you can edit this note')).toBe(true);
    expect(hasText(tree, 'View prior edits (1)')).toBe(true);
    expect(hasText(tree, 'COMMENTS')).toBe(true);
  });

  it('opening "view prior edits" shows the earlier version in the history dialog', () => {
    const tree = renderOpenPostDetail();
    const toggle = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && (n.children[0] as string).includes('View prior edits'),
    )[0]!;
    let btn: renderer.ReactTestInstance | null = toggle;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => {
      (btn!.props.onPress as () => void)();
    });

    expect(hasText(tree, 'PRIOR EDITS')).toBe(true);
    expect(hasText(tree, 'The meetup is Wednesday.')).toBe(true);
  });

  it('tapping Edit → Save note calls onSetPinnedComment with the drafted text', () => {
    const onSetPinnedComment = jest.fn();
    const tree = renderOpenPostDetail(onSetPinnedComment);

    const editBtn = pressables(tree).find(n => textOf(n).trim() === 'Edit')!;
    act(() => {
      (editBtn.props.onPress as () => void)();
    });

    expect(hasText(tree, 'EDITING AUTHOR\'S NOTE')).toBe(true);

    const saveBtn = pressables(tree).find(n => textOf(n).trim() === 'Save note')!;
    act(() => {
      (saveBtn.props.onPress as () => void)();
    });

    expect(onSetPinnedComment).toHaveBeenCalledTimes(1);
    expect(onSetPinnedComment).toHaveBeenCalledWith(
      POST_ID,
      OWNER,
      Kind.Post,
      'Correction: the meetup moved to Thursday.',
    );
  });
});
