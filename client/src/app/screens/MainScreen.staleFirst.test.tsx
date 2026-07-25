/**
 * Phase 5 (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — stale-content-first wiring at the
 * MainScreen level: an OPENED channel/group whose scoped history fetch hasn't settled
 * (onIsSpaceSynced false for its sub key) must not flash a "No broadcasts/messages yet." empty
 * state; once the sub settles (EOSE/CLOSED → onIsSpaceSynced true) the genuine empty state shows.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {MainScreen, type MainScreenProps} from './MainScreen';
import type {Channel} from '../../channels/channels';
import {setDockPrefsSlot} from '../dockPrefs';

let dockSlotSeq = 0;
beforeEach(() => setDockPrefsSlot(`stale-first-${dockSlotSeq++}`));

const noop = (): void => undefined;
const OWNER = 'a'.repeat(64);
const emptyFeed = {items: [], log: []};

const baseProps: Partial<MainScreenProps> = {
  currentUserPubkey: OWNER,
  isModerator: false,
  sendStatus: new Map(),
  onVote: noop,
  onCreateChannel: noop,
  onPostToChannel: noop,
  onGetThread: () => [],
  onSubmit: noop,
  onSendDm: noop,
};

function findAllByProp(
  tree: renderer.ReactTestRenderer,
  pred: (props: Record<string, unknown>) => boolean,
): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => !!n.props && pred(n.props as Record<string, unknown>), {deep: true});
}

function pressByText(tree: renderer.ReactTestRenderer, text: string): void {
  const textNode = findAllByProp(tree, p => p.children === text)[0];
  expect(textNode).toBeDefined();
  let n: renderer.ReactTestInstance | null = textNode ?? null;
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  expect(n).toBeDefined();
  act(() => {
    (n!.props.onPress as () => void)();
  });
}

/** All string children rendered anywhere in the tree, concatenated. */
function allText(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

describe('MainScreen stale-first (Phase 5): opened-space empty states wait for history to settle', () => {
  const channels: Channel[] = [{id: 'ch1', owner: OWNER, name: 'General'}];

  function mount(synced: boolean): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          groups={[{id: 'g1', name: 'Builders', memberCount: 2, isAdmin: false}]}
          onGetChannelMessages={() => []}
          onGetGroupMessages={() => []}
          onIsSpaceSynced={() => synced}
        />,
      );
    });
    return tree;
  }

  it('an opened channel with no local messages shows NO empty claim while its sub is unsettled', () => {
    const tree = mount(false);
    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');
    expect(allText(tree)).not.toContain('No broadcasts yet');
  });

  it('…and shows the genuine "No broadcasts yet." once the sub has settled', () => {
    const tree = mount(true);
    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');
    expect(allText(tree)).toContain('No broadcasts yet');
  });

  it('an opened group with no local messages shows NO empty claim while its sub is unsettled', () => {
    const tree = mount(false);
    pressByText(tree, 'Spaces');
    pressByText(tree, 'Builders');
    expect(allText(tree)).not.toContain('No messages yet.');
  });

  it('…and shows the genuine "No messages yet." once the sub has settled', () => {
    const tree = mount(true);
    pressByText(tree, 'Spaces');
    pressByText(tree, 'Builders');
    expect(allText(tree)).toContain('No messages yet.');
  });

  it('legacy callers (no onIsSpaceSynced prop) keep the old always-shown empty states', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MainScreen
          {...(baseProps as MainScreenProps)}
          feed={emptyFeed}
          inbox={[]}
          channels={channels}
          onGetChannelMessages={() => []}
        />,
      );
    });
    pressByText(tree, 'Spaces');
    pressByText(tree, 'General');
    expect(allText(tree)).toContain('No broadcasts yet');
  });
});
