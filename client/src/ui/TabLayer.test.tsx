/**
 * TabLayer (Phase 4.1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md) — the contracts that kill the
 * tab-switch flicker: lazy until first visit, mounted forever after, hidden via opacity (never
 * display:none — Android resets FlatList offsets), and FROZEN (no child re-renders) while hidden.
 */
import React from 'react';
import {Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {TabLayer} from './TabLayer';

let renders = 0;
function Probe({label}: {label: string}): React.JSX.Element {
  renders += 1;
  return <Text>{label}</Text>;
}

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

const layer = (tree: ReactTestRenderer) =>
  tree.root.findAll(n => n.props?.testID === 'layer' && typeof n.props?.pointerEvents === 'string')[0];

beforeEach(() => {
  renders = 0;
});

describe('TabLayer', () => {
  it('renders nothing until first activated (lazy — startup pays for one tab only)', () => {
    const tree = render(
      <TabLayer active={false} testID="layer">
        <Probe label="feed" />
      </TabLayer>,
    );
    expect(tree.root.findAllByType(Probe)).toHaveLength(0);
    expect(renders).toBe(0);
  });

  it('mounts on first activation and STAYS mounted when hidden again', () => {
    const tree = render(
      <TabLayer active={false} testID="layer">
        <Probe label="feed" />
      </TabLayer>,
    );
    act(() => {
      tree.update(
        <TabLayer active testID="layer">
          <Probe label="feed" />
        </TabLayer>,
      );
    });
    expect(tree.root.findAllByType(Probe)).toHaveLength(1);

    act(() => {
      tree.update(
        <TabLayer active={false} testID="layer">
          <Probe label="feed" />
        </TabLayer>,
      );
    });
    // The whole point: no unmount on tab-away.
    expect(tree.root.findAllByType(Probe)).toHaveLength(1);
  });

  it('hides via opacity + pointerEvents none (never display:none) and untouchable while hidden', () => {
    const tree = render(
      <TabLayer active testID="layer">
        <Probe label="feed" />
      </TabLayer>,
    );
    let host = layer(tree);
    if (!host) throw new Error('layer host not found');
    expect(host.props.pointerEvents).toBe('box-none');

    act(() => {
      tree.update(
        <TabLayer active={false} testID="layer">
          <Probe label="feed" />
        </TabLayer>,
      );
    });
    host = layer(tree);
    if (!host) throw new Error('layer host not found');
    expect(host.props.pointerEvents).toBe('none');
    const flat = Object.assign({}, ...[host.props.style].flat(Infinity).filter(Boolean));
    expect(flat.opacity).toBe(0);
    expect(flat.display).toBeUndefined();
    expect(host.props.accessibilityElementsHidden).toBe(true);
  });

  it('freezes children while hidden: prop changes cost zero renders, and re-activation renders the LATEST props', () => {
    const tree = render(
      <TabLayer active testID="layer">
        <Probe label="one" />
      </TabLayer>,
    );
    const after = renders;

    act(() => {
      tree.update(
        <TabLayer active={false} testID="layer">
          <Probe label="two" />
        </TabLayer>,
      );
    });
    act(() => {
      tree.update(
        <TabLayer active={false} testID="layer">
          <Probe label="three" />
        </TabLayer>,
      );
    });
    // Hidden = frozen: the two prop-changing renders above never reached the child…
    expect(renders).toBe(after);
    expect(tree.root.findByType(Probe).props.label).toBe('one');

    act(() => {
      tree.update(
        <TabLayer active testID="layer">
          <Probe label="four" />
        </TabLayer>,
      );
    });
    // …and unfreezing shows the CURRENT world, not the stale one.
    expect(tree.root.findByType(Probe).props.label).toBe('four');
    expect(renders).toBeGreaterThan(after);
  });

  it('freezes children in the very commit that covers the layer — the tap-latency fix', () => {
    const tree = render(
      <TabLayer active testID="layer">
        <Probe label="one" />
      </TabLayer>,
    );
    const after = renders;

    // The commit that OPENS an overlay flips `covered` and re-renders children in ONE update —
    // the freeze must prune the child from that same commit, or the tap pays for it.
    act(() => {
      tree.update(
        <TabLayer active covered testID="layer">
          <Probe label="two" />
        </TabLayer>,
      );
    });
    expect(renders).toBe(after);
    expect(tree.root.findByType(Probe).props.label).toBe('one');

    // Covered stays VISIBLE (no opacity:0 — it peeks through the entrance slide and must be
    // painted the instant the cover unmounts) but untouchable and hidden from accessibility.
    const host = layer(tree);
    if (!host) throw new Error('layer host not found');
    expect(host.props.pointerEvents).toBe('none');
    const flat = Object.assign({}, ...[host.props.style].flat(Infinity).filter(Boolean));
    expect(flat.opacity).toBeUndefined();
    expect(host.props.accessibilityElementsHidden).toBe(true);

    // Uncovering re-renders with the CURRENT props in the same commit the cover comes down.
    act(() => {
      tree.update(
        <TabLayer active testID="layer">
          <Probe label="three" />
        </TabLayer>,
      );
    });
    expect(tree.root.findByType(Probe).props.label).toBe('three');
    expect(layer(tree)!.props.pointerEvents).toBe('box-none');
  });
});
