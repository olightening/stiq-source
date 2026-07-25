import 'react-native';
import React from 'react';
import {Alert, Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {ChannelPostView} from './ChannelPostView';
import type {CommentNode} from '../../feed/thread';
import {toBlindEvent} from '../../blind/blindPost';
import {setActiveCommunityKey} from '../../blind/communityKey';
import {clearAuthorCache} from '../../blind/identity';
import {newTokenKeypair} from '../../blind/holderProof';
import {mintGroupKey} from '../groupCrypto';
import type {Token} from '../../blind/wallet';
import {encodeSpaceEmbed} from '../spaceEmbed';

const communityKey = mintGroupKey();
// P3 holder-bound: `token` must be the real BIP-340 pubkey of `secret` (see holderProof.ts) — a
// mismatched pair fails the holder-binding check and author resolution falls back to the signer.
const {q, Q} = newTokenKeypair();
const token: Token = {token: Q, sig: Uint8Array.of(2), secret: q};

function nodeFor(event: CommentNode['event']): CommentNode {
  return {event, depth: 0, children: []};
}

const post: Event = {
  id: 'post1',
  pubkey: 'a'.repeat(64),
  created_at: 900,
  kind: 1,
  tags: [],
  content: 'the post',
  sig: 's',
};

function renderView(thread: CommentNode[], extra: Partial<React.ComponentProps<typeof ChannelPostView>> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ChannelPostView
        channelName="general"
        message={post}
        isOwner={false}
        repliesEnabled
        onBack={() => {}}
        reactionEmojis={[]}
        reactionEvents={[]}
        thread={thread}
        {...extra}
      />,
    );
  });
  return tree;
}

describe('ChannelPostView inline Comment renderer — blind-post author resolution (bug #7)', () => {
  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  it('resolves a blind comment to its real author name/gradient, not the throwaway signer', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(
      {kind: 1111, created_at: 1000, tags: [], content: 'hi there'},
      [token],
      authorSk,
      communityKey,
      {name: 'alice', gradient: 'L135:7ec8ff,8a5bd0'},
    );
    expect(ev.pubkey).not.toBe(authorPk); // signed by a throwaway key

    const getAuthorName = jest.fn(() => 'fallback-name');
    const tree = renderView([nodeFor(ev)], {getAuthorName});

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('alice');
    // The fallback name lookup (keyed by pubkey) must never be consulted once the blind attribution
    // resolves — otherwise a real name could be shadowed by a stale phonebook entry.
    expect(getAuthorName).not.toHaveBeenCalledWith(ev.pubkey);
  });

  it('falls back to the name callback (keyed by the RESOLVED author) for a non-blind comment', () => {
    const ev: Event = {
      id: 'c1',
      pubkey: 'b'.repeat(64),
      created_at: 1000,
      kind: 1111,
      tags: [],
      content: 'plain comment',
      sig: 's',
    };
    const getAuthorName = jest.fn((pk: string) => (pk === ev.pubkey ? 'bob' : undefined));
    const tree = renderView([nodeFor(ev)], {getAuthorName});
    expect(JSON.stringify(tree.toJSON())).toContain('bob');
    expect(getAuthorName).toHaveBeenCalledWith(ev.pubkey);
  });

  it('the "Author" badge matches the RESOLVED author against the post author, not the throwaway signer', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(
      {kind: 1111, created_at: 1000, tags: [], content: 'op comment'},
      [token],
      authorSk,
      communityKey,
      {name: 'dave'},
    );
    const opPost: Event = {...post, pubkey: authorPk};
    const tree = renderView([nodeFor(ev)], {message: opPost});
    expect(JSON.stringify(tree.toJSON())).toContain('Author');
  });

  it('moderation acts on the RESOLVED author, not the throwaway signer', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(
      {kind: 1111, created_at: 1000, tags: [], content: 'hide me'},
      [token],
      authorSk,
      communityKey,
      {name: 'carol'},
    );
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const hide = (buttons as {text?: string; onPress?: () => void}[] | undefined)?.find(
        b => b.text === 'Hide comment',
      );
      hide?.onPress?.();
    });
    const onModerate = jest.fn();
    const tree = renderView([nodeFor(ev)], {canModerate: true, onModerate});
    const more = tree.root.findByProps({accessibilityLabel: 'comment-more'});
    act(() => {
      more.props.onPress();
    });
    expect(onModerate).toHaveBeenCalledWith(ev.id, authorPk, 'hide');
    alertSpy.mockRestore();
  });
});

describe('ChannelPostView — onOpenRef threading (finding 2: embedded cards must be tappable)', () => {
  const spaceToken = encodeSpaceEmbed({kind: 30311, owner: 'c'.repeat(64), identifier: 'general', name: 'General', private: false});

  it('wires onOpenRef into the POST body MessageBody so an embedded card is tappable', () => {
    const onOpenRef = jest.fn();
    const postWithEmbed: Event = {...post, content: `check this out ${spaceToken}`};
    const tree = renderView([], {message: postWithEmbed, onOpenRef});
    // BackButton also renders a Pressable (with an accessibilityLabel, no `disabled` prop) — isolate
    // the ReferencedCard's Pressable, which always sets `disabled` explicitly.
    const pressable = tree.root.findAllByType(Pressable).find(p => p.props.disabled !== undefined)!;
    expect(pressable.props.disabled).toBe(false);
    act(() => pressable.props.onPress());
    expect(onOpenRef).toHaveBeenCalledWith(spaceToken);
  });

  it('renders the embedded card as non-interactive when no onOpenRef is provided (unchanged default)', () => {
    const postWithEmbed: Event = {...post, content: `check this out ${spaceToken}`};
    const tree = renderView([], {message: postWithEmbed});
    // BackButton also renders a Pressable (with an accessibilityLabel, no `disabled` prop) — isolate
    // the ReferencedCard's Pressable, which always sets `disabled` explicitly.
    const pressable = tree.root.findAllByType(Pressable).find(p => p.props.disabled !== undefined)!;
    expect(pressable.props.disabled).toBe(true);
  });

  it('wires onOpenRef into a COMMENT MessageBody so an embedded card inside a reply is tappable', () => {
    const onOpenRef = jest.fn();
    const commentEvent: Event = {
      id: 'c2',
      pubkey: 'b'.repeat(64),
      created_at: 1000,
      kind: 1111,
      tags: [],
      content: `join here ${spaceToken}`,
      sig: 's',
    };
    const tree = renderView([nodeFor(commentEvent)], {onOpenRef});
    // BackButton also renders a Pressable (with an accessibilityLabel, no `disabled` prop) — isolate
    // the ReferencedCard's Pressable, which always sets `disabled` explicitly.
    const pressable = tree.root.findAllByType(Pressable).find(p => p.props.disabled !== undefined)!;
    expect(pressable.props.disabled).toBe(false);
    act(() => pressable.props.onPress());
    expect(onOpenRef).toHaveBeenCalledWith(spaceToken);
  });
});

// Surface audit (T4.4): the single-post overlay was the one place "Enable replies" was missing
// entirely (isOwner arrived as `_isOwner`, unused) — this pins the fix and its promoted-tap-through.
describe('ChannelPostView — "Enable replies" surface (T4.4 surface audit)', () => {
  it('offers "Turn on replies" via the ⋯ menu for the OWNER of an un-promoted post', () => {
    const onEnableReplies = jest.fn();
    const tree = renderView([], {isOwner: true, onEnableReplies});
    const menuBtn = tree.root.findByProps({accessibilityLabel: 'post-more'});
    act(() => menuBtn.props.onPress());
    const row = tree.root.findByProps({accessibilityLabel: 'enable-replies'});
    act(() => row.props.onPress());
    expect(onEnableReplies).toHaveBeenCalledWith(post);
  });

  it('hides the ⋯ menu for a NON-owner (author-only affordance)', () => {
    const onEnableReplies = jest.fn();
    const tree = renderView([], {isOwner: false, onEnableReplies});
    expect(tree.root.findAllByProps({accessibilityLabel: 'post-more'})).toHaveLength(0);
  });

  it('hides the ⋯ menu once the post is already promoted (nothing left to enable)', () => {
    const onEnableReplies = jest.fn();
    const promoted: Event = {...post, tags: [['promoted', 'f'.repeat(64)]]};
    const tree = renderView([], {message: promoted, isOwner: true, onEnableReplies});
    expect(tree.root.findAllByProps({accessibilityLabel: 'post-more'})).toHaveLength(0);
  });

  it('a PROMOTED post renders a tap-through "view discussion" row wired to onOpenPromoted', () => {
    const feedId = 'f'.repeat(64);
    const onOpenPromoted = jest.fn();
    const promoted: Event = {...post, tags: [['promoted', feedId]]};
    const tree = renderView([], {message: promoted, onOpenPromoted, promotedReplyCount: 3});
    const row = tree.root.findByProps({accessibilityLabel: 'open-promoted'});
    expect(JSON.stringify(tree.toJSON())).toContain('view discussion');
    act(() => row.props.onPress());
    expect(onOpenPromoted).toHaveBeenCalledWith(feedId);
  });
});
