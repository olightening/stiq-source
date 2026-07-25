/**
 * useLazyModalMount (Phase 3.4, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — the contract that
 * matters on Android RN 0.76: a Modal must NEVER mount with `visible` already true (it fails to
 * present); it must mount hidden and flip false→true in a later commit. These tests record every
 * committed {mounted, visible} pair and assert the sequencing.
 */
import React from 'react';
import {Modal, Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {useLazyModalMount, type LazyModalMount} from './useLazyModalMount';

const commits: LazyModalMount[] = [];

function Host({open}: {open: boolean}): React.JSX.Element {
  const m = useLazyModalMount(open);
  commits.push({mounted: m.mounted, visible: m.visible});
  return m.mounted ? (
    <Modal visible={m.visible} transparent>
      <Text>sheet</Text>
    </Modal>
  ) : (
    <Text>empty</Text>
  );
}

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

beforeEach(() => {
  commits.length = 0;
});

describe('useLazyModalMount', () => {
  it('never mounted while closed — costs nothing before first open', () => {
    const tree = render(<Host open={false} />);
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
    expect(commits.every(c => !c.mounted && !c.visible)).toBe(true);
  });

  it('first open: mounts hidden first, then flips visible in a LATER commit', () => {
    const tree = render(<Host open={false} />);
    act(() => {
      tree.update(<Host open />);
    });
    // Ends open…
    const modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    // …and no commit ever introduced mounted:true together with visible:true from scratch:
    // there must be at least one committed {mounted:true, visible:false} BEFORE the first
    // {mounted:true, visible:true}.
    const firstMounted = commits.findIndex(c => c.mounted);
    const firstVisible = commits.findIndex(c => c.visible);
    expect(firstMounted).toBeGreaterThanOrEqual(0);
    expect(firstVisible).toBeGreaterThan(firstMounted);
    expect(commits[firstMounted]).toEqual({mounted: true, visible: false});
  });

  it('open on the very first render still sequences mount-hidden → visible', () => {
    const tree = render(<Host open />);
    expect(tree.root.findByType(Modal).props.visible).toBe(true);
    const firstMounted = commits.findIndex(c => c.mounted);
    const firstVisible = commits.findIndex(c => c.visible);
    expect(commits[firstMounted]).toEqual({mounted: true, visible: false});
    expect(firstVisible).toBeGreaterThan(firstMounted);
  });

  it('close hides but keeps the Modal mounted; re-open is a plain false→true toggle', () => {
    const tree = render(<Host open />);
    act(() => {
      tree.update(<Host open={false} />);
    });
    let modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(false); // still mounted, hidden

    commits.length = 0;
    act(() => {
      tree.update(<Host open />);
    });
    modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    // Re-open never un/remounts: every commit in the re-open had mounted:true.
    expect(commits.every(c => c.mounted)).toBe(true);
  });

  it('open flicked on and straight back off before the visible flip stays hidden', () => {
    const tree = render(<Host open={false} />);
    act(() => {
      tree.update(<Host open />);
      tree.update(<Host open={false} />);
    });
    const modal = tree.root.findAllByType(Modal)[0];
    if (modal) expect(modal.props.visible).toBe(false);
  });
});
