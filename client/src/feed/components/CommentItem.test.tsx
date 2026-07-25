// Re-mock with jest.fn so copy-link assertions can inspect the call (same pattern as
// PostCard.test.tsx / GroupView.test.tsx — the default moduleNameMapper stub's setString is a
// plain no-op function).
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn()}), {virtual: true});

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import * as nip19 from 'nostr-tools/nip19';
import Clipboard from '@react-native-clipboard/clipboard';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {CommentItem} from './CommentItem';
import type {CommentNode} from '../thread';
import type {Event} from 'nostr-tools/pure';
import {toBlindEvent, assembleBlindEvent} from '../../blind/blindPost';
import {setActiveCommunityKey} from '../../blind/communityKey';
import {clearAuthorCache} from '../../blind/identity';
import {newTokenKeypair} from '../../blind/holderProof';
import {mintGroupKey, encryptForSpace} from '../../channels/groupCrypto';
import type {Token} from '../../blind/wallet';
import {safeNpubEncode} from '../../util/npub';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../../blind/protocol';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../../blind/contentKey';
import {setEpochUnlockUnavailable, clearEpochUnlockDisplay} from '../../blind/unlockState';

const ID = 'e'.repeat(64);
const AUTHOR = 'a'.repeat(64);

function makeNode(): CommentNode {
  const event: Event = {id: ID, pubkey: AUTHOR, created_at: 1, kind: 1111, tags: [], content: 'hi', sig: 's'};
  return {event, depth: 0, children: []};
}

it('copies a nostr:note… link from the ⋯ menu (B12)', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <CommentItem node={makeNode()} collapsed={false} onToggle={() => {}} onReply={() => {}} />,
    );
  });
  act(() => {
    tree!.root.findAll(n => n.props.accessibilityLabel === 'comment-more')[0]!.props.onPress();
  });
  act(() => {
    // Walk up from the "Copy link" text to the nearest ancestor with a function onPress — that's
    // its row Pressable, not the sheet's own outer dismiss-on-backdrop Pressables further up.
    let node: renderer.ReactTestInstance | null = tree!.root.findAll(n => n.props.children === 'Copy link')[0]!;
    while (node && typeof node.props.onPress !== 'function') node = node.parent;
    node!.props.onPress();
  });
  expect(Clipboard.setString).toHaveBeenCalledWith(`nostr:${nip19.noteEncode(ID)}`);
});

describe('CommentItem — blind-comment author resolution (finding #2 last-#7-stray)', () => {
  const communityKey = mintGroupKey();
  // P3 holder-bound: `token` must be the real BIP-340 pubkey of `secret` (see holderProof.ts) — a
  // mismatched pair fails the holder-binding check and author resolution falls back to the signer.
  const {q, Q} = newTokenKeypair();
  const token: Token = {token: Q, sig: Uint8Array.of(2), secret: q};

  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  it('derives the avatar seed + name fallback from the RESOLVED author, not the throwaway signer', () => {
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const ev = toBlindEvent(
      {kind: 1111, created_at: 1000, tags: [], content: 'blind comment body'},
      [token],
      authorSk,
      communityKey,
      // No attested name — forces CommentItem's own shortenNpub fallback (the local derivation
      // this fix targets), so the assertion below can't accidentally pass via author.name instead.
    );
    expect(ev.pubkey).not.toBe(authorPk); // signed by a throwaway key

    const node: CommentNode = {event: ev, depth: 0, children: []};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CommentItem node={node} collapsed={false} onToggle={() => {}} onReply={() => {}} />,
      );
    });

    const realNpub = safeNpubEncode(authorPk);
    const throwawayNpub = safeNpubEncode(ev.pubkey);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(realNpub.slice(0, 10));
    expect(json).not.toContain(throwawayNpub.slice(0, 10));

    // GradientAvatar's seed prop must key on the resolved author too.
    const avatar = tree.root.findAll(n => n.props.seed !== undefined)[0];
    expect(avatar!.props.seed).toBe(realNpub);
  });
});

describe('CommentItem — members-only sealed body (2026-07-21 invisible auto-unlock)', () => {
  const PLAINTEXT = 'this comment is for members only';
  const EPOCH = 5;

  /** A blind (throwaway-signed) comment whose body is sealed under `epoch`'s content key. */
  function sealedCommentNode(epoch = EPOCH): {node: CommentNode; key: Uint8Array} {
    const {q, Q} = newTokenKeypair();
    const token: Token = {token: Q, sig: Uint8Array.of(3), secret: q};
    const key = mintContentKey();
    const ct = encryptForSpace(PLAINTEXT, key);
    const ev = assembleBlindEvent(
      {kind: 1111, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, String(epoch)]], content: ct},
      [token],
      'attr',
    );
    return {node: {event: ev, depth: 0, children: []}, key};
  }

  afterEach(() => {
    clearActiveContentKeys();
    clearEpochUnlockDisplay();
  });

  it('never renders ciphertext while the epoch is pending — a neutral placeholder instead', () => {
    const {node} = sealedCommentNode();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CommentItem node={node} collapsed={false} onToggle={() => {}} onReply={() => {}} />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    // The ciphertext itself, the plaintext, and the members-only refusal copy must all be absent —
    // a pending unlock is neutral (no lock iconography, no visible text at all).
    expect(json).not.toContain(node.event.content);
    expect(json).not.toContain(PLAINTEXT);
    expect(json).not.toContain('Members-only');
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'loading').length).toBeGreaterThan(0);
  });

  it('shows the quiet members-only card when the organizer refused this epoch\'s unlock', () => {
    const {node} = sealedCommentNode();
    setEpochUnlockUnavailable(EPOCH, true);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CommentItem node={node} collapsed={false} onToggle={() => {}} onReply={() => {}} />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Members-only content');
    expect(json).not.toContain(node.event.content);
    expect(json).not.toContain(PLAINTEXT);
  });

  it('renders the decrypted body once this device holds the epoch key', () => {
    const {node, key} = sealedCommentNode();
    setContentEpochKey(EPOCH, key);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CommentItem node={node} collapsed={false} onToggle={() => {}} onReply={() => {}} />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(PLAINTEXT);
    expect(json).not.toContain(node.event.content);
  });
});
