/**
 * SendProgress Retry-gating (C3): Retry is offered for a retryable 'failed' send but NOT for a
 * permanent 'rejected' one (re-sending the same signed event is futile). Both surface the relay
 * reason as subtext and both keep Cancel.
 */
import 'react-native';
import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {SendProgress} from './SendProgress';

// The in-flight/confirmed states start Animated loops; fake timers + unmount keep them from leaking
// past the test (a live loop crashes on env teardown).
beforeEach(() => jest.useFakeTimers());

const trees: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const t of trees) {
      t.unmount();
    }
  });
  trees.length = 0;
  jest.clearAllTimers();
  jest.useRealTimers();
});

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  trees.push(tree!);
  return tree!;
}

/** All rendered Text nodes whose content exactly equals `label`. */
function textsLabelled(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance[] {
  return tree.root.findAllByType(Text).filter(t => t.props.children === label);
}

/** Press the nearest onPress-bearing ancestor of the labelled Text (the Pressable). */
function pressLabel(tree: renderer.ReactTestRenderer, label: string): void {
  let node: renderer.ReactTestInstance | null = textsLabelled(tree, label)[0] ?? null;
  while (node && typeof node.props.onPress !== 'function') {
    node = node.parent;
  }
  if (!node) {
    throw new Error(`no pressable for label "${label}"`);
  }
  act(() => node!.props.onPress());
}

describe('SendProgress Retry gating (C3)', () => {
  it('a retryable "failed" send shows Retry + Cancel + reason, and Retry fires', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(
      <SendProgress status="failed" reason="rate-limited: slow down" onRetry={onRetry} onCancel={onCancel} />,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('failed');
    expect(text).toContain('rate-limited: slow down'); // reason subtext kept
    expect(textsLabelled(tree, 'Retry')).toHaveLength(1); // Retry offered
    expect(textsLabelled(tree, 'Cancel')).toHaveLength(1);

    pressLabel(tree, 'Retry');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a permanent "rejected" send shows the reason + Cancel only — NO Retry', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const tree = render(
      <SendProgress status="rejected" reason="blocked: banned author" onRetry={onRetry} onCancel={onCancel} />,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('failed'); // still rendered like a failure…
    expect(text).toContain('blocked: banned author'); // …reason surfaced so it isn't opaque
    expect(textsLabelled(tree, 'Retry')).toHaveLength(0); // retry is futile — not offered
    expect(textsLabelled(tree, 'Cancel')).toHaveLength(1); // Cancel (dismiss) stays

    pressLabel(tree, 'Cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('in-flight renders no failure controls', () => {
    const tree = render(<SendProgress status="sending" onRetry={() => {}} onCancel={() => {}} />);
    expect(textsLabelled(tree, 'Retry')).toHaveLength(0);
    expect(textsLabelled(tree, 'Cancel')).toHaveLength(0);
  });
});

describe('SendProgress calm rejection copy (T12-S5)', () => {
  it('maps a known [code] reason to a calm sentence + one next-step, never the raw code', () => {
    const tree = render(
      <SendProgress
        status="rejected"
        reason="[content_too_long] blocked: post is 500 characters; this community allows at most 280"
        onCancel={() => {}}
      />,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('280'); // the real cap surfaces in the calm sentence
    expect(text).toContain('Shorten it and resend.'); // exactly one calm next-step
    expect(text).not.toContain('[content_too_long]'); // machine code never shown
    expect(text).not.toContain('blocked:'); // nor the raw "blocked:" prefix
  });

  it('falls back to raw prose (no next-step) for an unknown/legacy reason — byte-identical to today', () => {
    const tree = render(
      <SendProgress status="rejected" reason="blocked: banned author" onCancel={() => {}} />,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('blocked: banned author'); // unchanged legacy prose
  });
});
