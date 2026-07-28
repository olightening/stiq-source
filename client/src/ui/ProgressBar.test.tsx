/**
 * ProgressBar — the Tor-connect fill animation must never register as an "interaction" with RN's
 * InteractionManager. Any Animated.timing that doesn't opt out chains an InteractionManager handle
 * for its whole duration; this bar ticks roughly once a second for a 30-80s Tor connect, so an
 * un-opted-out fill would starve AppRuntime's deferred snapshot flush
 * (InteractionManager.runAfterInteractions) for most of the connect — exactly when the user is
 * staring at the screen waiting for content to appear.
 */
import 'react-native';
import React from 'react';
import {Animated, InteractionManager} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {ProgressBar} from './ProgressBar';

// The fill is a real (300ms) Animated.timing — fake timers + an explicit unmount keep it from
// leaking a live animation past the test (the Toast.test.tsx pattern).
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

it('renders nothing while percent is null/0 — nothing to animate, nothing to hold an interaction handle', () => {
  const createHandle = jest.spyOn(InteractionManager, 'createInteractionHandle');
  const tree = render(<ProgressBar percent={null} />);
  expect(tree.toJSON()).toBeNull();
  expect(createHandle).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

it('never creates an InteractionManager handle for its fill animation, on mount or on a later percent tick', () => {
  // Against the old code (useNativeDriver: false, no isInteraction override) this fails: RN's
  // TimingAnimation defaults isInteraction to `!useNativeDriver`, so a JS-driven timing with no
  // override IS an interaction and calls InteractionManager.createInteractionHandle() the moment
  // .start() runs (AnimatedValue.animate() does this synchronously, before any frame ticks).
  const createHandle = jest.spyOn(InteractionManager, 'createInteractionHandle');
  const tree = render(<ProgressBar percent={10} />);
  act(() => {
    tree.update(<ProgressBar percent={45} />); // a coarse ~1Hz bootstrap-percent tick
  });
  act(() => {
    tree.update(<ProgressBar percent={90} />); // another tick
  });
  expect(createHandle).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

it('marks the fill animation isInteraction: false explicitly, not merely via the native-driver default', () => {
  const timingSpy = jest.spyOn(Animated, 'timing');
  const tree = render(<ProgressBar percent={30} />);
  expect(timingSpy).toHaveBeenCalled();
  const config = timingSpy.mock.calls[0]?.[1] as {isInteraction?: boolean; useNativeDriver?: boolean} | undefined;
  expect(config?.isInteraction).toBe(false);
  act(() => tree.unmount());
});
