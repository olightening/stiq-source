// AUTHOR_NOTE_ENABLED (config.ts) — ship-dark for bug 7 (author's note). jest.mock hoists above
// the imports, same pattern as MainScreen.backhandler.test.tsx's TIMING_JITTER override. Every
// other config value keeps its real value via requireActual. The ON counterpart lives in
// MainScreen.authorNote.on.test.tsx — a single test file can't flip a direct config import both
// ways without desyncing the React module instance react-test-renderer holds (see that split).
jest.mock('../../config', () => ({...jest.requireActual('../../config'), AUTHOR_NOTE_ENABLED: false}));

/**
 * MainScreen → Author's-note (pinned comment) ship-dark gate, OFF side.
 *
 * Pins the ship-dark contract for bug 7: with AUTHOR_NOTE_ENABLED off, the entire "AUTHOR'S NOTE"
 * block in the post-detail view — an existing note's text, the author's "Edit"/"Add note"
 * affordance, the live length counter, and the "view prior edits" entry point (+ its history
 * dialog) — is completely absent, even when the open post carries a real pinned comment and the
 * viewer IS the author. The ON side (MainScreen.authorNote.on.test.tsx) pins the mirror-image
 * contract: today's full UI, unchanged.
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

/** Render MainScreen, open the post-detail overlay for a post the current user (OWNER) authored,
 *  carrying a pinned-comment history — the maximally-favorable case for the note UI to appear. */
function renderOpenPostDetail(): renderer.ReactTestRenderer {
  const onGetPinnedHistory = jest.fn((): PinnedCommentHistory => HISTORY);
  const onSetPinnedComment = jest.fn();
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

describe("MainScreen — author's-note ship-dark, AUTHOR_NOTE_ENABLED=false", () => {
  it('hides the whole block, even though the open post has a pinned comment and the viewer is the author', () => {
    const tree = renderOpenPostDetail();

    // No note label, no note body, no edit affordance, no counter, no history entry point.
    expect(hasText(tree, "AUTHOR'S NOTE")).toBe(false);
    expect(hasText(tree, 'Correction: the meetup moved to Thursday.')).toBe(false);
    expect(pressables(tree).some(n => textOf(n).includes('Edit'))).toBe(false);
    expect(pressables(tree).some(n => textOf(n).includes('Add note'))).toBe(false);
    expect(hasText(tree, 'View prior edits')).toBe(false);
    expect(hasText(tree, 'only you can edit this note')).toBe(false);
    // Prior-edits history dialog (and its "The meetup is Wednesday." content) has no trace either.
    expect(hasText(tree, 'PRIOR EDITS')).toBe(false);
    expect(hasText(tree, 'The meetup is Wednesday.')).toBe(false);

    // The rest of the detail view (comments head) still renders untouched — no gap left behind.
    expect(hasText(tree, 'COMMENTS')).toBe(true);
  });

  it('never calls onSetPinnedComment (there is no affordance left to trigger it)', () => {
    const onGetPinnedHistory = jest.fn((): PinnedCommentHistory => HISTORY);
    const onSetPinnedComment = jest.fn();
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

    expect(onSetPinnedComment).not.toHaveBeenCalled();
  });
});
