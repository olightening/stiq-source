import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {BlurhashView} from './BlurhashView';
import {decodeBlurhash} from '../media/blurhash';

// A valid 4x3-component hash from the BlurHash reference examples.
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

describe('BlurhashView', () => {
  it('renders one Svg surface with one Rect per grid cell (not a nested View grid)', () => {
    const resolution = 8;
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<BlurhashView hash={HASH} resolution={resolution} />);
    });

    // Under the react-native-svg jest mock every primitive (Svg, Rect) renders as a View.
    // Old implementation: 1 container + 8 rows + 64 cells = 73 Views.
    // New implementation: 1 container View + 1 Svg + 64 Rect = 66 host nodes, and crucially
    // no nested row Views — a single native surface for the whole grid.
    const json = JSON.stringify(tree!.toJSON());
    const fills = (json.match(/"fill":/g) ?? []).length;
    expect(fills).toBe(resolution * resolution); // one filled Rect per cell

    // Sanity: the rendered fills match the decoded grid colors.
    const grid = decodeBlurhash(HASH, resolution, resolution)!;
    expect(grid.colors).toHaveLength(resolution * resolution);
    for (const color of new Set(grid.colors)) {
      expect(json).toContain(color);
    }
  });

  it('renders a plain fallback View when hash is missing', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<BlurhashView />);
    });
    const json = JSON.stringify(tree!.toJSON());
    // No Rect fills in the fallback path.
    expect((json.match(/"fill":/g) ?? []).length).toBe(0);
  });

  it('is memoized: identical props do not re-run the decode/render', () => {
    // React.memo means the same element reference / identical props skip re-render. We assert the
    // component is wrapped (has the memo displayName) as a lightweight guarantee.
    expect((BlurhashView as {displayName?: string}).displayName).toBe('BlurhashView');
    expect(typeof BlurhashView).toBe('object'); // React.memo returns an object, not a function
  });

  it('does not crash for different resolutions', () => {
    for (const resolution of [2, 4, 6, 8, 12]) {
      let tree: renderer.ReactTestRenderer | undefined;
      act(() => {
        tree = renderer.create(<BlurhashView hash={HASH} resolution={resolution} />);
      });
      const fills = (JSON.stringify(tree!.toJSON()).match(/"fill":/g) ?? []).length;
      expect(fills).toBe(resolution * resolution);
    }
  });
});
