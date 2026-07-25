import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text} from 'react-native';
import {ErrorBoundary} from './ErrorBoundary';
import {clearRecentLogs, getRecentLogs} from '../util/log';

/** Always throws during render — the standard way to exercise an error boundary in RTL/RTR. */
function Bomb(): React.JSX.Element {
  throw new Error('boom');
}

function renderTree(ui: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(ui);
  });
  return tree!;
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    clearRecentLogs();
    // React logs the caught render error to console.error (dev-mode double-invoke included) —
    // silence it so test output stays readable. Assertions below check the ring log, not stdout.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders the fallback UI when a child throws', () => {
    const tree = renderTree(
      <ErrorBoundary scope="test-scope">
        <Bomb />
      </ErrorBoundary>,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('Something went wrong');
    expect(text).toContain('boom');
  });

  it('records the crash to the local ring log (memory-only) via componentDidCatch', () => {
    renderTree(
      <ErrorBoundary scope="test-scope">
        <Bomb />
      </ErrorBoundary>,
    );
    const entries = getRecentLogs();
    const entry = entries.find(e => e.scope === 'boundary');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe('error');
    expect(entry?.msg).toContain('"scope":"test-scope"');
    expect(entry?.msg).toContain('"message":"boom"');
    expect(entry?.msg).toMatch(/"ts":\d+/);
  });

  it('defaults the recorded scope to "root" when the boundary is unlabeled', () => {
    renderTree(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const entry = getRecentLogs().find(e => e.scope === 'boundary');
    expect(entry?.msg).toContain('"scope":"root"');
  });

  it('sibling surfaces outside the boundary still render when it catches', () => {
    const tree = renderTree(
      <>
        <ErrorBoundary scope="test-scope">
          <Bomb />
        </ErrorBoundary>
        <Text>sibling content</Text>
      </>,
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('Something went wrong');
    expect(text).toContain('sibling content');
  });

  it('resets local state and calls onReset when "Try again" is pressed', () => {
    const onReset = jest.fn();
    let shouldThrow = true;
    function MaybeBomb(): React.JSX.Element {
      if (shouldThrow) throw new Error('boom');
      return <Text>recovered</Text>;
    }
    const tree = renderTree(
      <ErrorBoundary scope="test-scope" onReset={onReset}>
        <MaybeBomb />
      </ErrorBoundary>,
    );
    expect(JSON.stringify(tree.toJSON())).toContain('Something went wrong');

    shouldThrow = false;
    const tryAgain = tree.root.findByType(Pressable);
    act(() => {
      tryAgain.props.onPress();
    });

    expect(onReset).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('recovered');
    expect(text).not.toContain('Something went wrong');
  });
});
