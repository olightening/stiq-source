/**
 * DraftsScreen — Phase 5§F coverage: the per-draft ⋯ menu's "Manage access (N pending)" item, shown
 * only once a draft has actually been shared (`shareId` set).
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {DraftsScreen} from './DraftsScreen';
import type {Draft} from '../drafts';

const noop = (): void => undefined;

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'd1',
    title: 'A quiet Tuesday',
    content: 'the whole body of the piece',
    tags: [],
    savedAt: Date.now(),
    ...overrides,
  };
}

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

function openSheet(tree: renderer.ReactTestRenderer): void {
  act(() => {
    tree.root.findAll(n => n.props.accessibilityLabel === 'Draft actions')[0]!.props.onPress();
  });
}

describe('DraftsScreen — Manage access menu item', () => {
  it('is absent for a draft with no shareId', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftsScreen
          visible
          drafts={[draft()]}
          onClose={noop}
          onNew={noop}
          onOpen={noop}
          onDelete={noop}
          onManageAccess={jest.fn()}
          onGetPendingAccessCount={() => 3}
        />,
      );
    });
    openSheet(tree);
    expect(textOf(tree)).not.toContain('Manage access');
  });

  it('shows "Manage access (N pending)" for a draft WITH a shareId, with the right count', () => {
    const onGetPendingAccessCount = jest.fn().mockReturnValue(2);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftsScreen
          visible
          drafts={[draft({shareId: 'share-xyz'})]}
          onClose={noop}
          onNew={noop}
          onOpen={noop}
          onDelete={noop}
          onManageAccess={jest.fn()}
          onGetPendingAccessCount={onGetPendingAccessCount}
        />,
      );
    });
    openSheet(tree);
    expect(onGetPendingAccessCount).toHaveBeenCalledWith('share-xyz');
    // The label interpolates the count, so JSX splits it into ['Manage access (', 2, ' pending)']
    // as separate children on one Text node — join them to assert the rendered sentence exactly.
    const label = tree.root.findAll(
      n => Array.isArray(n.children) && n.children[0] === 'Manage access (',
    )[0]!;
    expect((label.children as string[]).join('')).toBe('Manage access (2 pending)');
  });

  it('is absent when onManageAccess is not supplied, even with a shareId', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftsScreen
          visible
          drafts={[draft({shareId: 'share-xyz'})]}
          onClose={noop}
          onNew={noop}
          onOpen={noop}
          onDelete={noop}
        />,
      );
    });
    openSheet(tree);
    expect(textOf(tree)).not.toContain('Manage access');
  });

  it('tapping it calls onManageAccess with the draft and closes the sheet', () => {
    const onManageAccess = jest.fn();
    const d = draft({shareId: 'share-xyz'});
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DraftsScreen
          visible
          drafts={[d]}
          onClose={noop}
          onNew={noop}
          onOpen={noop}
          onDelete={noop}
          onManageAccess={onManageAccess}
          onGetPendingAccessCount={() => 0}
        />,
      );
    });
    openSheet(tree);
    const label = tree.root.findAll(
      n => typeof n.children?.[0] === 'string' && (n.children[0] as string).startsWith('Manage access'),
    )[0]!;
    let btn: renderer.ReactTestInstance | null = label;
    while (btn && typeof btn.props.onPress !== 'function') btn = btn.parent;
    act(() => { (btn!.props.onPress as () => void)(); });
    expect(onManageAccess).toHaveBeenCalledWith(d);
    // The sheet closes — its "Continue editing" item (always present while open) is gone.
    expect(textOf(tree)).not.toContain('Continue editing');
  });
});
