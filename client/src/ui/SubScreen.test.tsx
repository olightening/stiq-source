/**
 * SubScreen entrance contract.
 *
 * FLICKER BUG (user, verbatim, 2026-07-22): "when clicking on a channel or a user profile in the
 * updates tab … the screen for a moment flickers to another screen, then opens the targeted screen".
 * The mechanism was an entrance that started at opacity 0: whatever sat beneath the overlay — the
 * target tab's bare list on a cross-tab deep link, or the underlay reflowing as the header/dock
 * unmount — showed through for the whole fade. The contract: the overlay is OPAQUE from its first
 * frame (never animates opacity); motion is the translateY slide alone.
 *
 * TOUCH-DEAD BUG (2026-07-25 follow-up): that entrance was implemented with reanimated's `entering`
 * layout-animation prop. On iOS an `entering` animation on a position:absolute overlay silently
 * breaks the whole subtree's touch handling — a channel opened from the Updates tab rendered fine
 * but was completely tap-dead (the back button did nothing). The slide now runs through
 * `useSubScreenTransition` (a useAnimatedStyle transform on a normal, fully-interactive Animated.View),
 * which reproduces the exact same opaque-from-frame-one motion while staying touchable. This file
 * pins the geometry contract that keeps the flicker fixed.
 */
import 'react-native';
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {SubScreen} from './SubScreen';

describe('SubScreen — overlay geometry (opaque, full-cover, no opacity fade)', () => {
  it('renders children inside an absolute, full-cover, OPAQUE layer above the tab bodies', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SubScreen>
          <Text>drill-in body</Text>
        </SubScreen>,
      );
    });

    const host = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.style !== undefined,
    )[0]!;
    const flat = StyleSheet.flatten(host.props.style) as Record<string, unknown>;
    expect(flat.position).toBe('absolute');
    expect([flat.top, flat.left, flat.right, flat.bottom]).toEqual([0, 0, 0, 0]);
    // Opaque background is load-bearing: it is what hides the underlay from frame one now that the
    // entrance no longer fades. `opacity` must never appear (an opacity fade is the flicker bug).
    expect(typeof flat.backgroundColor).toBe('string');
    expect(flat.opacity).toBeUndefined();
    expect(flat.zIndex).toBe(10);
  });
});
