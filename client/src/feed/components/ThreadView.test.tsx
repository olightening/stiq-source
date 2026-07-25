import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {ThreadView} from './ThreadView';
import {buildThread} from '../thread';
import {InMemoryEventStore} from '../../nostr/store';
import type {Event} from 'nostr-tools/pure';
import {toBlindEvent} from '../../blind/blindPost';
import {setActiveCommunityKey} from '../../blind/communityKey';
import {clearAuthorCache} from '../../blind/identity';
import {newTokenKeypair} from '../../blind/holderProof';
import {mintGroupKey} from '../../channels/groupCrypto';
import type {Token} from '../../blind/wallet';

function comment(id: string, parentId: string, createdAt: number): Event {
  return {
    id,
    pubkey: 'u',
    created_at: createdAt,
    kind: 1111,
    tags: [['E', 'p1', '', 'a'], ['e', parentId, '', 'a']],
    content: `body-${id}`,
    sig: 's',
  };
}

/** react-test-renderer's toJSON() output has cross-linked parent/child refs — JSON.stringify chokes
 * on the cycle, so every assertion on rendered text goes through this cycle-safe serializer. */
function safeStringify(tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null): string {
  return JSON.stringify(
    tree,
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

it('renders a nested thread', () => {
  const store = new InMemoryEventStore();
  store.save(comment('c1', 'p1', 1));
  store.save(comment('c2', 'c1', 2));
  const nodes = buildThread(store, 'p1');

  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<ThreadView nodes={nodes} />);
  });

  const text = safeStringify(tree!.toJSON());
  expect(text).toContain('body-c1');
  expect(text).toContain('body-c2');
  // Root comments with replies start collapsed → the toggle reads "N replies hidden".
  expect(text).toContain('reply hidden');
});

describe('ThreadView isOp (bug #7 — resolved author, not the throwaway signer)', () => {
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

  it('flags a blind comment as the op when its RESOLVED author matches, even though the raw signer differs', () => {
    const opSk = generateSecretKey();
    const opPk = getPublicKey(opSk);
    const blindComment = toBlindEvent(
      {kind: 1111, created_at: 1, tags: [['E', 'p1', '', 'a']], content: 'body-op'},
      [token],
      opSk,
      communityKey,
      {name: 'op-name'},
    );
    expect(blindComment.pubkey).not.toBe(opPk); // signed by a throwaway key

    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ThreadView
          nodes={[{event: blindComment, depth: 0, children: []}]}
          opPubkey={opPk}
        />,
      );
    });
    expect(safeStringify(tree!.toJSON())).toContain('Author');
  });

  it('does NOT flag a blind comment as the op when opPubkey matches only the raw throwaway signer', () => {
    const opSk = generateSecretKey();
    const other = generateSecretKey();
    const blindComment = toBlindEvent(
      {kind: 1111, created_at: 1, tags: [['E', 'p1', '', 'a']], content: 'body-notop'},
      [token],
      other,
      communityKey,
      {name: 'other-name'},
    );
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ThreadView
          nodes={[{event: blindComment, depth: 0, children: []}]}
          opPubkey={blindComment.pubkey} // the raw throwaway signer, not the real author
        />,
      );
    });
    expect(safeStringify(tree!.toJSON())).not.toContain('Author');
    // sanity: opSk is unused except to document intent (a real op key, not the throwaway signer)
    expect(getPublicKey(opSk)).not.toBe(blindComment.pubkey);
  });
});
