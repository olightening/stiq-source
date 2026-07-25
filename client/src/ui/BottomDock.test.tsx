/**
 * BottomDock — the always-on, centred Current/Spaces/Updates nav pill (no toggle, no ≡ bubble).
 *
 * What these pin:
 *  - it renders the items as pressable text labels in the FIXED order given, whichever one is
 *    active (tests elsewhere press nav by that text — string children only);
 *  - exactly the active item reports `accessibilityState.selected` — the single-active invariant;
 *  - tapping an item fires its onPress (persisting the launch default is MainScreen's job — this
 *    component is presentational);
 *  - the pill is always visible when the dock is mounted (there is nothing to expand/collapse).
 */
import 'react-native';
import React from 'react';
import {Pressable, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {BottomDock, type DockItem} from './BottomDock';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

const items = (active: string, onPress: Record<string, () => void> = {}): DockItem[] =>
  (['feed', 'channels', 'log'] as const).map(key => ({
    key,
    label: key === 'feed' ? 'Current' : key === 'channels' ? 'Spaces' : 'Updates',
    active: key === active,
    onPress: onPress[key] ?? (() => {}),
  }));

const textLabels = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .filter((c): c is string => typeof c === 'string');

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

test('renders each item as a text label in the given order — the row NEVER reshuffles', async () => {
  // The order is whatever the caller passed, regardless of which item is active…
  const tree = render(<BottomDock items={items('feed')} />);
  await flush();
  expect(textLabels(tree)).toEqual(['Current', 'Spaces', 'Updates']);
  // …so selecting a different tab leaves every label exactly where the thumb last found it.
  const tree2 = render(<BottomDock items={items('log')} />);
  await flush();
  expect(textLabels(tree2)).toEqual(['Current', 'Spaces', 'Updates']);
  const tree3 = render(<BottomDock items={items('channels')} />);
  await flush();
  expect(textLabels(tree3)).toEqual(['Current', 'Spaces', 'Updates']);
});

test('exactly the active item is selected', async () => {
  const tree = render(<BottomDock items={items('channels')} />);
  await flush();
  const selected = tree.root
    .findAllByType(Pressable)
    .filter(p => p.props.accessibilityState?.selected)
    .map(p => p.props.accessibilityLabel);
  expect(selected).toEqual(['Spaces']);
});

test('pressing an item fires its onPress', async () => {
  const log = jest.fn();
  const tree = render(<BottomDock items={items('feed', {log})} />);
  await flush();
  const logBtn = tree.root
    .findAllByType(Pressable)
    .find(p => p.props.accessibilityLabel === 'Updates')!;
  await act(async () => logBtn.props.onPress());
  await flush();
  expect(log).toHaveBeenCalledTimes(1);
});

test('the pill is always visible — there is no collapse toggle or ≡ bubble', async () => {
  const tree = render(<BottomDock items={items('feed')} />);
  await flush();
  // All tab labels render immediately and stay put (nothing to expand/collapse)...
  expect(textLabels(tree)).toEqual(['Current', 'Spaces', 'Updates']);
  // ...and there is no navigation-menu / toggle bubble to press.
  const toggle = tree.root
    .findAllByType(Pressable)
    .find(p => p.props.accessibilityLabel === 'Navigation menu');
  expect(toggle).toBeUndefined();
});

const jumpOf = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(Pressable).find(p => p.props.accessibilityLabel === 'scroll to top');

test('the jump slot renders a ↑ bubble when visible and fires its onPress', async () => {
  const onPress = jest.fn();
  const tree = render(<BottomDock items={items('feed')} jump={{visible: true, onPress}} />);
  await flush();
  const jump = jumpOf(tree)!;
  expect(jump).toBeTruthy();
  await act(async () => jump.props.onPress());
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('no jump prop → no ↑ bubble (channels/log tabs)', async () => {
  const tree = render(<BottomDock items={items('channels')} />);
  await flush();
  expect(jumpOf(tree)).toBeUndefined();
});

test('jump visible:false never mounts, and visible→false unmounts after the fade', async () => {
  const noop = () => {};
  const tree = render(<BottomDock items={items('feed')} jump={{visible: false, onPress: noop}} />);
  await flush();
  expect(jumpOf(tree)).toBeUndefined();

  // Cross the show threshold: mounts immediately (mount-before-show).
  await act(async () => {
    tree.update(<BottomDock items={items('feed')} jump={{visible: true, onPress: noop}} />);
  });
  await flush();
  expect(jumpOf(tree)).toBeTruthy();

  // Back above the threshold: unmounts once the fade-out completes.
  await act(async () => {
    tree.update(<BottomDock items={items('feed')} jump={{visible: false, onPress: noop}} />);
  });
  act(() => {
    jest.advanceTimersByTime(400);
  });
  await flush();
  expect(jumpOf(tree)).toBeUndefined();
});
