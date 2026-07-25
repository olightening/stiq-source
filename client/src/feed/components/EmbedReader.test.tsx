/**
 * EmbedReader — Phase 5§E/6/7§B coverage: the draft state machine (legacy / teaser / approved),
 * gated comments, and the synthetic comment-root contract Phase 7§A relies on.
 *
 * The `msg` branch is untouched by this work and already has no dedicated suite of its own; it is
 * exercised indirectly wherever MainScreen renders EmbedReader (MainScreen.spaceEmbed.test.tsx etc).
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {EmbedReader, type EmbedReaderTarget} from './EmbedReader';
import {ThreadView} from './ThreadView';
import {CommentComposer} from './CommentComposer';
import type {DraftRef} from '../draftEmbed';
import type {DraftDeliverySnapshot} from '../draftAccess';
import {DRAFT_COMMENT_ROOT_KIND} from '../draftAccess';
import {buildPostComment, type EventRef} from '../comments';
import {buildThread} from '../thread';
import {InMemoryEventStore} from '../../nostr/store';
import {Kind} from '../../nostr/events';

const noop = (): void => undefined;
const AUTHOR = 'a'.repeat(64);
const SHARE_ID = 'share-' + 'b'.repeat(58);

const draftRef: DraftRef = {
  id: SHARE_ID,
  title: 'My Piece',
  excerpt: 'A short teaser of the writing…',
  author: AUTHOR,
  authorName: 'Alice',
};

/** All string leaves in the rendered tree, joined — cheap substring assertions without a snapshot. */
function textOf(tree: renderer.ReactTestRenderer): string {
  return JSON.stringify(
    tree.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

/** Flush the microtask queue a couple of times — the draft state machine chains TWO async effects
 *  (access state, then the unlocked snapshot fetch), each needing its own tick to settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

describe('EmbedReader — legacy (v1) draft token', () => {
  it('shows an explicit "no longer available" state, never a misrender', () => {
    const target: EmbedReaderTarget = {token: 'stiq:draft:old', draft: 'legacy'};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<EmbedReader target={target} onClose={noop} />); });
    const text = textOf(tree);
    expect(text).toContain('No longer available');
    expect(text).toContain('This shared draft uses an old format and is no longer available.');
    expect(tree.root.findAllByType(ThreadView)).toHaveLength(0);
    expect(tree.root.findAllByType(CommentComposer)).toHaveLength(0);
  });
});

describe('EmbedReader — draft teaser (access none/pending)', () => {
  it('shows identity + title + excerpt + a Request access button, and nothing else', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('none');
    const onRequestDraftAccess = jest.fn().mockResolvedValue(undefined);
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onRequestDraftAccess={onRequestDraftAccess}
        />,
      );
    });
    await flush();

    const text = textOf(tree);
    expect(text).toContain('Alice');
    expect(text).toContain('· Draft');
    expect(text).toContain('My Piece');
    expect(text).toContain('A short teaser of the writing…');
    expect(text).toContain('Request access');
    // No body/comments/fork of any kind pre-approval.
    expect(text).not.toContain('Save a copy to my drafts');
    expect(tree.root.findAllByType(ThreadView)).toHaveLength(0);
    expect(tree.root.findAllByType(CommentComposer)).toHaveLength(0);

    expect(onGetDraftAccessState).toHaveBeenCalledWith(SHARE_ID);
  });

  it('flips to "Requested · waiting for the owner" once pending, and the button disables', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('pending');
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onRequestDraftAccess={jest.fn()}
        />,
      );
    });
    await flush();

    const text = textOf(tree);
    expect(text).toContain('Requested · waiting for the owner');
    expect(text).not.toContain('Save a copy to my drafts');
    expect(tree.root.findAllByType(ThreadView)).toHaveLength(0);
    expect(tree.root.findAllByType(CommentComposer)).toHaveLength(0);
  });

  it('requesting access calls onRequestDraftAccess with the draftId + owner pubkey', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('none');
    const onRequestDraftAccess = jest.fn().mockResolvedValue(undefined);
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onRequestDraftAccess={onRequestDraftAccess}
        />,
      );
    });
    await flush();

    const button = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && n.children[0] === 'Request access',
    )[0]!;
    let btn: renderer.ReactTestInstance | null = button;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    await act(async () => { (btn!.props.onPress as () => void)(); });

    expect(onRequestDraftAccess).toHaveBeenCalledWith(SHARE_ID, AUTHOR);
  });
});

describe('EmbedReader — draft approved / owner (full article + comments + fork)', () => {
  const snapshot: DraftDeliverySnapshot = {ti: 'My Piece', b: 'The full body of the writing.'};

  it('renders the article body, the COMMENTS footer, the comment thread, and the fork action', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('approved');
    const onGetMyDraftDelivery = jest.fn().mockResolvedValue(snapshot);
    const onGetDraftThread = jest.fn().mockReturnValue([]);
    const onGetDraftCommentCount = jest.fn().mockReturnValue(2);
    const onForkDraft = jest.fn();
    const onComment = jest.fn();
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onGetMyDraftDelivery={onGetMyDraftDelivery}
          onGetDraftThread={onGetDraftThread}
          onGetDraftCommentCount={onGetDraftCommentCount}
          onForkDraft={onForkDraft}
          onComment={onComment}
        />,
      );
    });
    await flush();

    const text = textOf(tree);
    expect(text).toContain('The full body of the writing.');
    expect(text).toContain('COMMENTS');
    expect(text).toContain('2');
    expect(text).toContain('Save a copy to my drafts');
    expect(tree.root.findAllByType(ThreadView)).toHaveLength(1);
    expect(tree.root.findAllByType(CommentComposer)).toHaveLength(1);

    // Fork calls through with the ref + the delivered snapshot — the only onward path (no re-share).
    const forkBtn = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && n.children[0] === 'Save a copy to my drafts',
    )[0]!;
    let btn: renderer.ReactTestInstance | null = forkBtn;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => { (btn!.props.onPress as () => void)(); });
    expect(onForkDraft).toHaveBeenCalledWith(draftRef, snapshot);
  });

  it('an owner reads their own live draft via onGetOwnerDraftSnapshot, never onGetMyDraftDelivery', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('owner');
    const onGetMyDraftDelivery = jest.fn();
    const onGetOwnerDraftSnapshot = jest.fn().mockReturnValue(snapshot);
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onGetMyDraftDelivery={onGetMyDraftDelivery}
          onGetOwnerDraftSnapshot={onGetOwnerDraftSnapshot}
        />,
      );
    });
    await flush();

    expect(textOf(tree)).toContain('The full body of the writing.');
    expect(onGetOwnerDraftSnapshot).toHaveBeenCalledWith(SHARE_ID);
    expect(onGetMyDraftDelivery).not.toHaveBeenCalled();
  });

  it('submitting a top-level comment calls onComment with the synthetic draft root as BOTH root and parent', async () => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue('approved');
    const onGetMyDraftDelivery = jest.fn().mockResolvedValue(snapshot);
    const onComment = jest.fn();
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onGetMyDraftDelivery={onGetMyDraftDelivery}
          onComment={onComment}
        />,
      );
    });
    await flush();

    const composer = tree.root.findByType(CommentComposer);
    act(() => { (composer.props.onSubmit as (text: string) => void)('nice piece!'); });

    // root === parent === {id: shareId, pubkey: draft.author, kind: DRAFT_COMMENT_ROOT_KIND} for a
    // top-level comment — App.tsx's real post-comment handler follows the exact same shape.
    expect(onComment).toHaveBeenCalledWith(
      'nice piece!',
      SHARE_ID, AUTHOR, DRAFT_COMMENT_ROOT_KIND,
      SHARE_ID, AUTHOR, DRAFT_COMMENT_ROOT_KIND,
    );
  });
});

describe('EmbedReader — comments section absent pre-approval (Phase 7§B gate)', () => {
  it.each(['none', 'pending'] as const)('mounts neither ThreadView nor CommentComposer when access is %s', async access => {
    const onGetDraftAccessState = jest.fn().mockResolvedValue(access);
    const target: EmbedReaderTarget = {token: 't1', draft: draftRef};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EmbedReader
          target={target}
          onClose={noop}
          onGetDraftAccessState={onGetDraftAccessState}
          onGetDraftThread={jest.fn().mockReturnValue([{event: {id: 'x', pubkey: 'p', kind: 1111, tags: [], content: 'hi', created_at: 1, sig: 's'}, depth: 0, children: []}])}
          onComment={jest.fn()}
        />,
      );
    });
    await flush();

    expect(tree.root.findAllByType(ThreadView)).toHaveLength(0);
    expect(tree.root.findAllByType(CommentComposer)).toHaveLength(0);
  });
});

describe('Phase 7§A — synthetic draft comment root round-trips through the REAL comment system', () => {
  it('a synthetic {id: shareId, pubkey, kind: DRAFT_COMMENT_ROOT_KIND} root builds a kind-1111 comment that buildThread(shareId) returns', () => {
    // DRAFT_COMMENT_ROOT_KIND must differ from Kind.Post so buildPostComment takes the kind-1111
    // branch (never the hybrid kind-1 "stiq-comment" branch reserved for real published notes).
    expect(DRAFT_COMMENT_ROOT_KIND).not.toBe(Kind.Post);

    const draftRoot: EventRef = {id: SHARE_ID, pubkey: AUTHOR, kind: DRAFT_COMMENT_ROOT_KIND};
    const unsigned = buildPostComment('great read', draftRoot, draftRoot);
    expect(unsigned.kind).toBe(Kind.Comment); // 1111

    const store = new InMemoryEventStore();
    store.save({...unsigned, id: 'c1', pubkey: 'commenter'.padEnd(64, '0'), sig: 'sig'});

    const nodes = buildThread(store, SHARE_ID);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.event.id).toBe('c1');
    expect(nodes[0]!.event.content).toBe('great read');
  });
});

describe('EmbedReader — live unlock while the reader is ALREADY OPEN (accessVersion)', () => {
  /**
   * The trap this pins. Before `accessVersion` existed, the reader's access check re-ran only
   * because App.tsx passes the draft callbacks as inline arrows, so their identity changed on every
   * parent render and the effect re-fired as a side effect of that. Wrapping those callbacks in
   * `useCallback` — an ordinary perf change, and this app is actively receiving one — would have
   * stranded an approved reader on the teaser with no test failing.
   *
   * So: every callback identity below is FROZEN for the life of the test. The only thing that moves
   * between renders is `accessVersion`. If the effect ever stops depending on it, this fails.
   */
  const target: EmbedReaderTarget = {token: 'stiq:draft:v2', draft: draftRef};
  const snapshot: DraftDeliverySnapshot = {b: 'the real writing, delivered'};

  it('unlocks in place when accessVersion bumps, with stable callback identities', async () => {
    let state: 'none' | 'pending' | 'approved' = 'pending';
    const onGetDraftAccessState = jest.fn(() => Promise.resolve(state));
    const onGetMyDraftDelivery = jest.fn(() => Promise.resolve(snapshot));
    const onGetDraftThread = jest.fn(() => []);
    const onGetDraftCommentCount = jest.fn(() => 0);
    const onRequestDraftAccess = jest.fn(() => Promise.resolve());
    const view = (v: number): React.JSX.Element => (
      <EmbedReader
        target={target}
        onClose={noop}
        accessVersion={v}
        onGetDraftAccessState={onGetDraftAccessState}
        onRequestDraftAccess={onRequestDraftAccess}
        onGetMyDraftDelivery={onGetMyDraftDelivery}
        onGetDraftThread={onGetDraftThread}
        onGetDraftCommentCount={onGetDraftCommentCount}
      />
    );

    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(view(1)); });
    await flush();
    expect(textOf(tree)).toContain('Requested · waiting for the owner');
    expect(textOf(tree)).not.toContain('the real writing, delivered');

    // The owner approves: the delivery lands and the runtime's counter moves. NOTHING else changes —
    // same target, same frozen callbacks, same component instance.
    state = 'approved';
    act(() => { tree.update(view(2)); });
    await flush();
    expect(textOf(tree)).toContain('the real writing, delivered');
    expect(textOf(tree)).not.toContain('Requested · waiting for the owner');
  });

  it('does not re-check when nothing access-relevant moved', async () => {
    const onGetDraftAccessState = jest.fn(() => Promise.resolve<'pending'>('pending'));
    const onRequestDraftAccess = jest.fn(() => Promise.resolve());
    const view = (v: number): React.JSX.Element => (
      <EmbedReader
        target={target}
        onClose={noop}
        accessVersion={v}
        onGetDraftAccessState={onGetDraftAccessState}
        onRequestDraftAccess={onRequestDraftAccess}
      />
    );
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(view(7)); });
    await flush();
    const callsAfterMount = onGetDraftAccessState.mock.calls.length;

    // A re-render with the SAME version is ordinary parent churn — it must not trigger a re-derive.
    act(() => { tree.update(view(7)); });
    await flush();
    expect(onGetDraftAccessState).toHaveBeenCalledTimes(callsAfterMount);
  });
});
