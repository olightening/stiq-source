// Re-mock with jest.fn so copy-link assertions can inspect the call (see GroupView.test.tsx for
// the same pattern — the default moduleNameMapper stub's setString is a plain no-op function).
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn()}), {virtual: true});

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import {PostCard, isTweetLike} from './PostCard';
import {toFeedItem, type FeedItem} from '../feed';
import {buildPost} from '../compose';

it('renders a composed tagged post as a feed card', async () => {
  // Compose a tagged post, then render it the way the feed would.
  const unsigned = buildPost('hello world', ['news', 'local']);
  const item = toFeedItem({
    ...unsigned,
    id: 'post1',
    pubkey: 'a'.repeat(64),
    sig: 's',
  });

  let tree: renderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(<PostCard item={item} />);
  });

  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('hello world');
  // Feed cards render tags as quiet, dot-separated topics (no leading '#').
  expect(text).toContain('news');
  expect(text).toContain('local');
});

it('surfaces the relay rejection reason on a rejected post, with Cancel only (no Retry)', async () => {
  const unsigned = buildPost('rejected body', []);
  const item = toFeedItem({...unsigned, id: 'post2', pubkey: 'a'.repeat(64), sig: 's'});

  let tree: renderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <PostCard
        item={item}
        status="rejected"
        statusReason="blocked: rejected"
        onRetry={() => {}}
        onCancel={() => {}}
      />,
    );
  });

  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('failed'); // shown like a failure…
  expect(text).toContain('blocked: rejected'); // …but no longer opaque — the reason is visible
  // A permanent 'rejected' is terminal: re-sending the same signed event is futile (C3), so no Retry.
  expect(text).not.toContain('Retry');
  expect(text).toContain('Cancel'); // dismiss / stop showing it stays available
});

it('keeps Retry (and Cancel) on a retryable failed post', async () => {
  const unsigned = buildPost('failed body', []);
  const item = toFeedItem({...unsigned, id: 'post3', pubkey: 'a'.repeat(64), sig: 's'});

  let tree: renderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <PostCard item={item} status="failed" onRetry={() => {}} onCancel={() => {}} />,
    );
  });

  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('failed');
  expect(text).toContain('Retry'); // an ambiguous/transient failure may still land on a fresh attempt
  expect(text).toContain('Cancel');
});

describe('a picture note keeps ONE shape from placeholder to confirmed', () => {
  // The same picture has two wire forms, and a note carrying it must not re-shape between them: the
  // optimistic placeholder holds the pixel bytes INLINE (multi-KB base64), while the event that lands
  // holds a ~72-char STIQBLOB reference to the blob minted during signing. Measuring the RAW body made
  // the first article-like and the second tweet-like, so the card re-laid itself out mid-send.
  const PROSE = 'look at this';
  const INLINE = `[[pic:16;4;l=cat;U${'A'.repeat(4000)}]]`;
  const BLOB = `[[pic:16;4;l=cat;w=3001;STIQBLOB${'b'.repeat(64)}]]`;
  const itemFor = (body: string, id: string): FeedItem =>
    toFeedItem({...buildPost(body, []), id, pubkey: 'a'.repeat(64), sig: ''});

  it('measures the prose, not the payload — so both forms agree on tweet-like', () => {
    expect(INLINE.length).toBeGreaterThan(140); // the raw body that used to force the article shape
    expect(isTweetLike(itemFor(`${PROSE} ${INLINE}`, 'local-1'))).toBe(true);
    expect(isTweetLike(itemFor(`${PROSE} ${BLOB}`, 'post-1'))).toBe(true);
  });

  it('still shapes LONG prose as an article — stripping media is not a bypass', () => {
    expect(isTweetLike(itemFor(`${'x'.repeat(141)} ${INLINE}`, 'post-2'))).toBe(false);
    expect(isTweetLike(itemFor(`${'x'.repeat(141)} ${BLOB}`, 'post-3'))).toBe(false);
  });

  it('renders the in-flight placeholder in the tweet shape, with the footer delivery indicator', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<PostCard item={itemFor(`${PROSE} ${INLINE}`, 'local-2')} status="sending" />);
    });
    const text = JSON.stringify(tree!.toJSON());
    // "N ideas" is spelled out only by the article footer; the tweet footer shows a bare count.
    expect(text).not.toContain('ideas');
    // Delivery lives in the footer, below the body — i.e. after the prose in the tree.
    expect(text.indexOf('Sending…')).toBeGreaterThan(-1);
    expect(text.indexOf('Sending…')).toBeGreaterThan(text.indexOf(PROSE));
    act(() => { tree!.unmount(); });
  });
});

it('copies a nostr:-prefixed link from the ⋯ menu (B12)', async () => {
  const unsigned = buildPost('copy me', []);
  const item = toFeedItem({...unsigned, id: 'post4', pubkey: 'a'.repeat(64), sig: 's'});

  let tree: renderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(<PostCard item={item} />);
  });
  act(() => {
    tree!.root.findAll(n => n.props.accessibilityLabel === 'more')[0]!.props.onPress();
  });
  act(() => {
    // Walk up from the "Copy link" text to the nearest ancestor with a function onPress — that's
    // its row Pressable, not the sheet's own outer dismiss-on-backdrop Pressables further up.
    let node: renderer.ReactTestInstance | null = tree!.root.findAll(n => n.props.children === 'Copy link')[0]!;
    while (node && typeof node.props.onPress !== 'function') node = node.parent;
    node!.props.onPress();
  });
  expect(Clipboard.setString).toHaveBeenCalledWith(expect.stringMatching(/^nostr:/));
  // The identifier itself (item.identifier) is never bare in the clipboard payload.
  expect(Clipboard.setString).toHaveBeenCalledWith(`nostr:${item.identifier.replace(/^nostr:/, '')}`);
  // copyLink schedules a 2s "Copied ✓" reset timer; unmount so it can't fire against a torn-down
  // module registry once this test file is done (a leaked real timer otherwise crashes the runner).
  act(() => { tree!.unmount(); });
});
