/**
 * The feed's Rising/New sort is remembered across restarts (feedSortPrefs) and shown on the VERY
 * FIRST paint — no async flash of the default 'new' before the stored choice loads. Exercised
 * directly against MainScreen: with the pref hydrated to 'hot' (as AppRuntime.loadWorkspaceState
 * does before the splash lifts), the initial render must show Rising active; tapping a chip must
 * write the choice through to the pref so it survives the next launch.
 */
import 'react-native';
import React from 'react';
import {StyleSheet} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {MainScreen, type MainScreenProps} from './MainScreen';
import {colors} from '../../ui/theme';
import {setDockPrefsSlot} from '../dockPrefs';
import {
  feedSortPref,
  setFeedSortPref,
  setFeedSortPrefsSlot,
  ensureFeedSortPrefsLoaded,
} from '../feedSortPrefs';

let seq = 0;
beforeEach(async () => {
  await AsyncStorage.clear();
  // A fresh slot per test → the dock lands on the feed tab (its default) and the sort mirror is
  // clean, so an earlier test's choice never leaks into the next mount.
  setDockPrefsSlot(`sortmem-${seq}`);
  setFeedSortPrefsSlot(`sortmem-${seq++}`);
  await ensureFeedSortPrefsLoaded();
});

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

/**
 * The resolved text colour of the sort chip labelled `label` ('Rising' | 'New'). Scoped to the sort
 * chip by its distinctive fontSize (styles.qsortText: 13.5) so an unrelated 'New' text can't match.
 */
function sortColor(tree: renderer.ReactTestRenderer, label: string): string | undefined {
  const nodes = findAllByProp(tree, p => p.children === label && p.style !== undefined);
  for (const node of nodes) {
    const flat = StyleSheet.flatten(node.props.style as object) as {color?: string; fontSize?: number};
    if (flat.fontSize === 13.5) {
      return flat.color;
    }
  }
  return undefined;
}

function pressByText(tree: renderer.ReactTestRenderer, text: string): void {
  const textNode = findAllByProp(tree, p => p.children === text)[0];
  expect(textNode).toBeDefined();
  let n: renderer.ReactTestInstance | null = textNode ?? null;
  while (n && typeof n.props.onPress !== 'function') {
    n = n.parent;
  }
  expect(n).toBeDefined();
  void act(() => {
    (n!.props.onPress as () => void)();
  });
}

function mount(): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  void act(() => {
    tree = renderer.create(
      <MainScreen
        {...(baseProps as MainScreenProps)}
        feed={emptyFeed}
        inbox={[]}
        channels={[]}
        onGetChannelMessages={() => []}
      />,
    );
  });
  return tree;
}

afterEach(async () => {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

describe('MainScreen — the feed sort is remembered and shown on first paint', () => {
  it('shows New active by default when nothing has been stored', () => {
    const tree = mount();
    expect(sortColor(tree, 'New')).toBe(colors.textPrimary);
    expect(sortColor(tree, 'Rising')).toBe(colors.textMuted);
  });

  it('shows Rising active on the FIRST render when the pref was hydrated to hot (no async flash)', () => {
    setFeedSortPref('hot'); // as restored by loadWorkspaceState before the screen mounts
    const tree = mount();
    expect(sortColor(tree, 'Rising')).toBe(colors.textPrimary);
    expect(sortColor(tree, 'New')).toBe(colors.textMuted);
  });

  it('writes the choice through to the pref when the member taps Rising', () => {
    const tree = mount();
    expect(feedSortPref()).toBe('new');
    pressByText(tree, 'Rising');
    expect(feedSortPref()).toBe('hot'); // survives the next launch
    expect(sortColor(tree, 'Rising')).toBe(colors.textPrimary);
  });
});
