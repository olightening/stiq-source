/**
 * Press primitive (Phase 1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — structural contract:
 * variant wiring, baked-in defaults (hitSlop, a11y role, disabled treatment), pressedStyle
 * behaviour, and the row-variant highlight layer. Animated *values* are not asserted here —
 * under jest reanimated resolves to its official mock (see jest.config.js), so these tests
 * pin the structure and the JS-side contract, which is what call sites depend on.
 */
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {Press, PressDelayContext, SCROLL_PRESS_DELAY_MS} from './Press';

function flatStyle(node: {props: {style?: unknown}}): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) || {};
}

function findPressRoot(tree: ReactTestRenderer, testID: string) {
  // The inner Pressable is the node that carries both our testID and the press handlers
  // Press wires up (the outermost match is the <Press> element itself).
  const node = tree.root.findAll(
    n => n.props?.testID === testID && typeof n.props?.onPressIn === 'function',
  )[0];
  if (!node) throw new Error(`no Press root found for testID=${testID}`);
  return node;
}

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

describe('Press', () => {
  it('row/bare variants get no default hitSlop (flush rows must not fight neighbours)', () => {
    const tree = render(
      <Press testID="r" variant="row" onPress={() => {}}>
        <Text>Row</Text>
      </Press>,
    );
    expect(findPressRoot(tree, 'r').props.hitSlop).toBeUndefined();
  });

  it('defaults: hitSlop 8 and accessibilityRole button; caller overrides win', () => {
    const tree = render(
      <Press testID="p" onPress={() => {}}>
        <Text>Tap</Text>
      </Press>,
    );
    const node = findPressRoot(tree, 'p');
    expect(node.props.hitSlop).toBe(8);
    expect(node.props.accessibilityRole).toBe('button');

    const tree2 = render(
      <Press testID="q" hitSlop={20} accessibilityRole="tab" onPress={() => {}}>
        <Text>Tap</Text>
      </Press>,
    );
    const node2 = findPressRoot(tree2, 'q');
    expect(node2.props.hitSlop).toBe(20);
    expect(node2.props.accessibilityRole).toBe('tab');
  });

  it('disabled: 0.45 opacity treatment, disabled a11y state, press suppressed', () => {
    const onPress = jest.fn();
    const tree = render(
      <Press testID="p" disabled onPress={onPress}>
        <Text>Tap</Text>
      </Press>,
    );
    const node = findPressRoot(tree, 'p');
    expect(flatStyle(node).opacity).toBe(0.45);
    expect(node.props.accessibilityState).toMatchObject({disabled: true});
    expect(node.props.disabled).toBe(true);
  });

  it('pressedStyle: applied on pressIn, removed on pressOut', () => {
    const tree = render(
      <Press testID="p" onPress={() => {}} pressedStyle={{backgroundColor: 'red'}}>
        <Text>Tap</Text>
      </Press>,
    );
    let node = findPressRoot(tree, 'p');
    expect(flatStyle(node).backgroundColor).toBeUndefined();

    act(() => {
      node.props.onPressIn({nativeEvent: {}});
    });
    node = findPressRoot(tree, 'p');
    expect(flatStyle(node).backgroundColor).toBe('red');

    act(() => {
      node.props.onPressOut({nativeEvent: {}});
    });
    node = findPressRoot(tree, 'p');
    expect(flatStyle(node).backgroundColor).toBeUndefined();
  });

  it('forwards onPressIn/onPressOut to the caller on top of its own feedback', () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    const tree = render(
      <Press testID="p" onPress={() => {}} onPressIn={onPressIn} onPressOut={onPressOut}>
        <Text>Tap</Text>
      </Press>,
    );
    const node = findPressRoot(tree, 'p');
    act(() => {
      node.props.onPressIn({nativeEvent: {}});
      node.props.onPressOut({nativeEvent: {}});
    });
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
  });

  it('press-in delay: instant by default, held inside a PressDelayContext, caller override wins', () => {
    // Default — no provider — stays instant so standalone buttons feel immediate.
    const plain = render(
      <Press testID="p" onPress={() => {}}>
        <Text>Tap</Text>
      </Press>,
    );
    expect(findPressRoot(plain, 'p').props.unstable_pressDelay).toBe(0);

    // Inside a scroll/swipe region the highlight is held for the region's delay, so a starting
    // scroll or tab-swipe cancels it before it shows (the tap-flash fix).
    const scoped = render(
      <PressDelayContext.Provider value={SCROLL_PRESS_DELAY_MS}>
        <Press testID="p" onPress={() => {}}>
          <Text>Tap</Text>
        </Press>
      </PressDelayContext.Provider>,
    );
    expect(findPressRoot(scoped, 'p').props.unstable_pressDelay).toBe(SCROLL_PRESS_DELAY_MS);

    // Row variant carries it too — full-width list rows are the main flash offenders.
    const scopedRow = render(
      <PressDelayContext.Provider value={SCROLL_PRESS_DELAY_MS}>
        <Press testID="r" variant="row" onPress={() => {}}>
          <Text>Row</Text>
        </Press>
      </PressDelayContext.Provider>,
    );
    expect(findPressRoot(scopedRow, 'r').props.unstable_pressDelay).toBe(SCROLL_PRESS_DELAY_MS);

    // A caller that explicitly wants instant feedback overrides the region.
    const override = render(
      <PressDelayContext.Provider value={SCROLL_PRESS_DELAY_MS}>
        <Press testID="p" unstable_pressDelay={0} onPress={() => {}}>
          <Text>Tap</Text>
        </Press>
      </PressDelayContext.Provider>,
    );
    expect(findPressRoot(override, 'p').props.unstable_pressDelay).toBe(0);
  });

  it('row variant: paints a highlight layer under the content that adopts the row radius', () => {
    const tree = render(
      <Press testID="p" variant="row" style={{borderRadius: 12}} onPress={() => {}}>
        <Text>Row</Text>
      </Press>,
    );
    const node = findPressRoot(tree, 'p');
    // Highlight layer: absolute-fill, non-interactive, radius matched to the row.
    const highlight = node.findAll(n => {
      const st = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown> | undefined;
      return !!st && st.position === 'absolute' && typeof st.backgroundColor === 'string';
    })[0];
    if (!highlight) throw new Error('row highlight layer not rendered');
    expect(highlight.props.pointerEvents).toBe('none');
    const hs = StyleSheet.flatten(highlight.props.style as never) as Record<string, unknown>;
    expect(hs.position).toBe('absolute');
    expect(hs.borderRadius).toBe(12);
    expect(typeof hs.backgroundColor).toBe('string');
  });

  it('bare variant: no highlight layer, no feedback plumbing beyond passthrough', () => {
    const tree = render(
      <Press testID="p" variant="bare" onPress={() => {}}>
        <Text>Bare</Text>
      </Press>,
    );
    const node = findPressRoot(tree, 'p');
    const kids = node.children as Array<{type?: unknown; props?: Record<string, unknown>}>;
    // Only the Text child — no injected overlay sibling.
    expect(kids).toHaveLength(1);
  });

  it('render-prop children receive live pressed state', () => {
    const tree = render(
      <Press testID="p" onPress={() => {}}>
        {({pressed}) => <Text testID="label">{pressed ? 'down' : 'up'}</Text>}
      </Press>,
    );
    let node = findPressRoot(tree, 'p');
    expect(tree.root.findByProps({testID: 'label'}).props.children).toBe('up');
    act(() => {
      node.props.onPressIn({nativeEvent: {}});
    });
    expect(tree.root.findByProps({testID: 'label'}).props.children).toBe('down');
  });
});
