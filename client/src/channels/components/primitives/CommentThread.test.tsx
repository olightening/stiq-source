import 'react-native';
import React from 'react';
import {Alert, Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {CommentThread} from './CommentThread';
import type {CommentNode} from '../../../feed/thread';
import {toBlindEvent, assembleBlindEvent} from '../../../blind/blindPost';
import {setActiveCommunityKey} from '../../../blind/communityKey';
import {clearAuthorCache} from '../../../blind/identity';
import {newTokenKeypair} from '../../../blind/holderProof';
import {mintGroupKey, encryptForSpace} from '../../groupCrypto';
import type {Token} from '../../../blind/wallet';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../../../blind/protocol';
import {mintContentKey, clearActiveContentKeys} from '../../../blind/contentKey';

const communityKey = mintGroupKey();
// P3 holder-bound: `token` must be the real BIP-340 pubkey of `secret` (see holderProof.ts) — a
// mismatched pair fails the holder-binding check and author resolution falls back to the signer.
const {q, Q} = newTokenKeypair();
const token: Token = {token: Q, sig: Uint8Array.of(2), secret: q};

function nodeFor(event: CommentNode['event']): CommentNode {
  return {event, depth: 0, children: []};
}

function renderTree(nodes: CommentNode[], extra: Partial<React.ComponentProps<typeof CommentThread>> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<CommentThread nodes={nodes} {...extra} />);
  });
  return tree;
}

describe('CommentThread — blind-post author resolution (bug #7)', () => {
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
    const tree = renderTree([nodeFor(ev)], {getAuthorName});

    const text = tree.toJSON();
    const json = JSON.stringify(text);
    expect(json).toContain('alice');
    // The fallback name lookup (keyed by pubkey) must never be consulted once the blind attribution
    // resolves — otherwise a real name could be shadowed by a stale phonebook entry.
    expect(getAuthorName).not.toHaveBeenCalledWith(ev.pubkey);
  });

  it('falls back to the name/gradient callbacks (keyed by the RESOLVED author) for a non-blind comment', () => {
    const ev = {
      id: 'c1',
      pubkey: 'b'.repeat(64),
      created_at: 1000,
      kind: 1111,
      tags: [],
      content: 'plain comment',
      sig: 's',
    };
    const getAuthorName = jest.fn((pk: string) => (pk === ev.pubkey ? 'bob' : undefined));
    const tree = renderTree([nodeFor(ev)], {getAuthorName});
    expect(JSON.stringify(tree.toJSON())).toContain('bob');
    expect(getAuthorName).toHaveBeenCalledWith(ev.pubkey);
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
        b => b.text === 'Hide',
      );
      hide?.onPress?.();
    });
    const onModerate = jest.fn();
    const tree = renderTree([nodeFor(ev)], {canModerate: true, onModerate});
    act(() => {
      tree.root.findByType(Pressable).props.onPress();
    });
    expect(onModerate).toHaveBeenCalledWith(ev.id, authorPk, 'hide');
    alertSpy.mockRestore();
  });
});

// 2026-07-21 members-only invisible-unlock incident: channel comments cannot be sealed TODAY (they
// never ride the blind feedSigner) — this only by an out-of-band fact this render can't itself
// verify. Routed through resolveContent as cheap, permanent insurance: a body that somehow arrived
// carrying the seal markers must render '' rather than raw ciphertext.
describe('CommentThread — hardened against a (never-should-happen) sealed body', () => {
  afterEach(() => clearActiveContentKeys());

  it('renders \'\' instead of ciphertext for a body carrying the content-seal markers', () => {
    const {q: sealedQ, Q: sealedPub} = newTokenKeypair();
    const sealedToken: Token = {token: sealedPub, sig: Uint8Array.of(9), secret: sealedQ};
    const key = mintContentKey();
    const ct = encryptForSpace('should never be seen in a channel', key);
    // No setContentEpochKey — this device never unlocks it, so resolveContent reports locked/''.
    const sealed = assembleBlindEvent(
      {kind: 1111, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '1']], content: ct},
      [sealedToken],
      'attr',
    );
    const tree = renderTree([nodeFor(sealed)]);
    const json = JSON.stringify(tree.toJSON());
    expect(json).not.toContain(sealed.content);
    expect(json).not.toContain('should never be seen in a channel');
  });
});
