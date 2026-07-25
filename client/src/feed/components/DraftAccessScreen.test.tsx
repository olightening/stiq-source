/**
 * DraftAccessScreen — Phase 5§F coverage: the owner's "Manage access" queue (pending + approved),
 * modeled on GroupView's Join Requests section.
 */
import 'react-native';
import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {DraftAccessScreen} from './DraftAccessScreen';

const DRAFT_ID = 'share-' + 'a'.repeat(58);
const CAROL = 'c'.repeat(64);
const DAVE = 'd'.repeat(64);

/** All string leaves in the rendered tree, joined — cheap substring assertions without a snapshot
 *  (mirrors EmbedReader.test.tsx's `textOf`). */
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

describe('DraftAccessScreen — pending list', () => {
  it('renders requester identity + name, with Approve/Decline actions', () => {
    const onGetPending = jest.fn().mockReturnValue([
      {pubkey: CAROL, reqId: 'r1', at: 1000, name: 'Carol reads a lot'},
    ]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen
          visible
          draftId={DRAFT_ID}
          onClose={jest.fn()}
          onGetPending={onGetPending}
          onGetApproved={jest.fn().mockReturnValue([])}
        />,
      );
    });

    expect(onGetPending).toHaveBeenCalledWith(DRAFT_ID);
    const text = textOf(tree);
    expect(text).toContain('Carol reads a lot');
    expect(text).toContain('PENDING');
    // Pressable can surface the same accessibilityLabel on more than one fiber node (host + composite)
    // — mirrors GroupView.test.tsx's convention of asserting presence, not an exact match count.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`).length).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `deny-${CAROL}`).length).toBeGreaterThan(0);
  });

  it('shows the pending badge count', () => {
    const onGetPending = jest.fn().mockReturnValue([
      {pubkey: CAROL, reqId: 'r1', at: 1000, name: 'Carol'},
      {pubkey: DAVE, reqId: 'r2', at: 900, name: 'Dave'},
    ]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={onGetPending} />,
      );
    });
    expect(textOf(tree)).toContain('2');
  });

  it('Approve calls onApprove with the draftId + requester pubkey', () => {
    const onApprove = jest.fn().mockResolvedValue(undefined);
    const onGetPending = jest.fn().mockReturnValue([{pubkey: CAROL, reqId: 'r1', at: 1000, name: 'Carol'}]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={onGetPending} onApprove={onApprove} />,
      );
    });
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `approve-${CAROL}`)[0]!.props.onPress();
    });
    expect(onApprove).toHaveBeenCalledWith(DRAFT_ID, CAROL);
    // Owner-side feedback only — the resolved card replaces the actions, mirrors GroupView.
    expect(textOf(tree)).toContain('Approved');
  });

  it('Decline calls onDeny — silently: no notify/publish path exists for the requester, and the ' +
    'owner UI shows only its own local confirmation text, never anything framed as visible to them', () => {
    const onDeny = jest.fn().mockResolvedValue(undefined);
    const onApprove = jest.fn();
    const onGetPending = jest.fn().mockReturnValue([{pubkey: CAROL, reqId: 'r1', at: 1000, name: 'Carol'}]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen
          visible
          draftId={DRAFT_ID}
          onClose={jest.fn()}
          onGetPending={onGetPending}
          onApprove={onApprove}
          onDeny={onDeny}
        />,
      );
    });
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `deny-${CAROL}`)[0]!.props.onPress();
    });
    expect(onDeny).toHaveBeenCalledWith(DRAFT_ID, CAROL);
    expect(onApprove).not.toHaveBeenCalled();
    const text = textOf(tree);
    expect(text).toContain('Declined quietly');
    expect(text).toContain('never told');
  });

  it('shows an empty state with no pending requests', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={() => []} onGetApproved={() => []} />,
      );
    });
    expect(textOf(tree)).toContain('No pending requests.');
  });
});

describe('DraftAccessScreen — approved list', () => {
  it('renders granted identities with a revoke ✕', () => {
    const onGetApproved = jest.fn().mockReturnValue([{pubkey: DAVE, at: 500, name: 'Dave'}]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={() => []} onGetApproved={onGetApproved} />,
      );
    });
    expect(onGetApproved).toHaveBeenCalledWith(DRAFT_ID);
    const text = textOf(tree);
    expect(text).toContain('Dave');
    expect(text).toContain('APPROVED');
    expect(tree.root.findAll(n => n.props.accessibilityLabel === `revoke-${DAVE}`).length).toBeGreaterThan(0);
  });

  it('revoking confirms first (honest, forward-only copy), then calls onRevoke only on confirm', () => {
    let capturedButtons: {text?: string; onPress?: () => void}[] | undefined;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      capturedButtons = buttons as typeof capturedButtons;
    });
    const onRevoke = jest.fn().mockResolvedValue(undefined);
    const onGetApproved = jest.fn().mockReturnValue([{pubkey: DAVE, at: 500, name: 'Dave'}]);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={() => []} onGetApproved={onGetApproved} onRevoke={onRevoke} />,
      );
    });
    act(() => {
      tree.root.findAll(n => n.props.accessibilityLabel === `revoke-${DAVE}`)[0]!.props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(onRevoke).not.toHaveBeenCalled();
    // The copy is honest about being forward-only — it must NOT claim the content is recalled.
    const [title, message] = alertSpy.mock.calls[0]!;
    expect(String(title)).toContain('Revoke access');
    expect(String(message)).toContain("lose access to any future updates");
    expect(String(message)).toContain("won't be able to open this draft again");
    expect(String(message)).not.toMatch(/delete|erase|remove.*device|recall/i);

    const confirmBtn = capturedButtons?.find(b => b.text === 'Revoke');
    act(() => { confirmBtn?.onPress?.(); });
    expect(onRevoke).toHaveBeenCalledWith(DRAFT_ID, DAVE);
    alertSpy.mockRestore();
  });

  it('shows an empty state with no one approved yet', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen visible draftId={DRAFT_ID} onClose={jest.fn()} onGetPending={() => []} onGetApproved={() => []} />,
      );
    });
    expect(textOf(tree)).toContain('No one has access yet.');
  });
});

describe('DraftAccessScreen — header', () => {
  it('shows the draft title when known, and closes via the back control', () => {
    const onClose = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftAccessScreen
          visible
          draftId={DRAFT_ID}
          draftTitle="A quiet Tuesday"
          onClose={onClose}
          onGetPending={() => []}
          onGetApproved={() => []}
        />,
      );
    });
    expect(textOf(tree)).toContain('A quiet Tuesday');
    const backLabel = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && n.children[0] === '‹ Back',
    )[0]!;
    let btn: renderer.ReactTestInstance | null = backLabel;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => { (btn!.props.onPress as () => void)(); });
    expect(onClose).toHaveBeenCalled();
  });
});
