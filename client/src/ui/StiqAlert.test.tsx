import 'react-native';
import React from 'react';
import {Modal} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {StiqAlertHost, stiqAlert} from './StiqAlert';

/**
 * Regression guard for the Android Modal-presentation bug: the alert host must keep its `<Modal>`
 * MOUNTED at all times and drive it with `visible` (false→true), NOT return null when idle and
 * mount a hardcoded `<Modal visible>` when an alert fires. On Android a `<Modal>` that mounts
 * already-visible frequently fails to present, so alerts would silently never appear. Keeping the
 * Modal mounted + toggling `visible` is the app-wide rule every sheet follows.
 *
 * react-test-renderer renders Modal children inline regardless of `visible`, so this asserts the
 * `visible` PROP toggles — content presence alone would pass even against the broken code.
 */

function collectText(root: renderer.ReactTestInstance): string {
  const out: string[] = [];
  root.findAll(() => true).forEach(n => {
    const kids = Array.isArray(n.children) ? n.children : [n.children];
    kids.forEach(c => {
      if (typeof c === 'string') out.push(c);
    });
  });
  return out.join(' | ');
}

it('keeps one Modal mounted and toggles visible false→true→false across an alert lifecycle', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<StiqAlertHost />);
  });
  const modals = (): renderer.ReactTestInstance[] => tree!.root.findAllByType(Modal);

  // Idle: the Modal is present but not visible.
  expect(modals()).toHaveLength(1);
  expect(modals()[0]!.props.visible).toBe(false);

  // Enqueue an alert → same single Modal, now visible (the false→true transition Android needs).
  const onPress = jest.fn();
  act(() => {
    stiqAlert('Delete this?', 'This cannot be undone.', [{text: 'OK', onPress}]);
  });
  expect(modals()).toHaveLength(1);
  expect(modals()[0]!.props.visible).toBe(true);
  expect(collectText(tree!.root)).toContain('Delete this?');

  // Tap OK → queue drains → fires the button, Modal stays mounted, visible flips back to false.
  const buttons = tree!.root.findAll(n => n.props?.accessibilityRole === 'button');
  act(() => {
    buttons[0]!.props.onPress();
  });
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(modals()).toHaveLength(1);
  expect(modals()[0]!.props.visible).toBe(false);
});
