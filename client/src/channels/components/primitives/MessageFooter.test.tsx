import 'react-native';
import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {MessageFooter} from './MessageFooter';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import type {GradientSpec} from '../../../media/gradient';

// GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
// "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
// wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
// function instead (same pattern as ChatBubble.test.tsx).
const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
function findAvatars(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.type === gradientAvatarInner);
}

function render(props: React.ComponentProps<typeof MessageFooter>): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<MessageFooter {...props} />);
  });
  return tree!;
}

describe('MessageFooter — public footer (no `author`) is unchanged', () => {
  it('renders no avatar and no "Author" pressable when `author` is omitted', () => {
    const tree = render({time: '2m'});
    expect(findAvatars(tree)).toHaveLength(0);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Author')).toHaveLength(0);
    expect(tree.root.findAll(() => true).some(n => n.props.children === '2m')).toBe(true);
  });
});

// THE ONE ADDITION: private-channel cards pass `author` to grow a clickable gradient-circle avatar
// immediately left of the time text.
describe('MessageFooter — private-channel author circle', () => {
  const gradient: GradientSpec = {type: 'linear', angle: 90, stops: ['#abcdef', '#123456']};

  it('renders a circle GradientAvatar seeded/gradiented from `author`', () => {
    const tree = render({time: '2m', author: {seed: 'npub1author', gradient}});
    const avatars = findAvatars(tree);
    expect(avatars).toHaveLength(1);
    expect(avatars[0]!.props.seed).toBe('npub1author');
    expect(avatars[0]!.props.gradient).toBe(gradient);
    expect(avatars[0]!.props.shape).toBe('circle');
    expect(avatars[0]!.props.size).toBe(18);
  });

  it('renders a plain (non-pressable) avatar when `author.onPress` is omitted', () => {
    const tree = render({time: '2m', author: {seed: 'npub1author', gradient}});
    expect(findAvatars(tree)).toHaveLength(1);
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Author')).toHaveLength(0);
  });

  it('wraps the avatar in a Press (button variant: hitSlop 8, role button, label "Author") and fires onPress when set', () => {
    const onPress = jest.fn();
    const tree = render({time: '2m', author: {seed: 'npub1author', gradient, onPress}});
    // Press (the shared primitive) wraps a resolved Pressable/AnimatedPressable host node that
    // carries the button-variant defaults (accessibilityRole/hitSlop) — assert on that resolved
    // node rather than the outer <Press> element, whose own props are only what the call site
    // passed (Press applies its defaults internally, not visible on its own JSX props).
    const pressables = tree.root.findAllByType(Pressable).filter(
      n => n.props.accessibilityLabel === 'Author' && typeof n.props.onPress === 'function',
    );
    expect(pressables.length).toBeGreaterThan(0);
    expect(pressables[0]!.props.accessibilityRole).toBe('button');
    expect(pressables[0]!.props.hitSlop).toBe(8);
    act(() => { pressables[0]!.props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('orders the right-hand cluster …avatar… [time] […⋯]: avatar before time, time before ⋯', () => {
    const onMenu = jest.fn();
    const tree = render({time: '2m ago', author: {seed: 'npub1author', gradient}, onMenu});
    const all = tree.root.findAll(() => true);
    const avatarIdx = all.findIndex(n => n.type === gradientAvatarInner);
    const timeIdx = all.findIndex(n => n.props.children === '2m ago');
    const menuIdx = all.findIndex(n => n.props.accessibilityLabel === 'message actions');
    expect(avatarIdx).toBeGreaterThan(-1);
    expect(timeIdx).toBeGreaterThan(-1);
    expect(menuIdx).toBeGreaterThan(-1);
    expect(avatarIdx).toBeLessThan(timeIdx);
    expect(timeIdx).toBeLessThan(menuIdx);
  });
});
