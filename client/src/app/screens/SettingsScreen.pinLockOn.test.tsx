/**
 * SettingsScreen → the SECURITY section with the PIN UI RESTORED (PIN_LOCK_UI true).
 *
 * The mirror of SettingsScreen.pinLock.test.tsx. Proves the ship-dark promise for bugs 5+6 from the
 * Settings side: flipping ONE flag brings back the section header, the PIN lock row and its toggle,
 * and the disable flow's PIN-confirmation dialog — none of it was deleted or rewritten, only gated.
 *
 * Module-level jest.mock per the house pattern (MainScreen.authorNote.on.test.tsx); requireActual is
 * spread first so only PIN_LOCK_UI differs from the shipped config.
 */
jest.mock('../../config', () => ({
  ...jest.requireActual('../../config'),
  PIN_LOCK_UI: true,
}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Switch} from 'react-native';
import {SettingsScreen} from './SettingsScreen';

jest.setTimeout(20000);

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function hasText(tree: renderer.ReactTestRenderer, substr: string): boolean {
  return tree.root.findAll(() => true).some(n => textOf(n).includes(substr));
}

function render(props: Partial<React.ComponentProps<typeof SettingsScreen>>): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<SettingsScreen visible onClose={jest.fn()} version="1.0" {...props} />);
  });
  return tree!;
}

describe('SettingsScreen — SECURITY / PIN lock (restored)', () => {
  it('renders the SECURITY section, the PIN lock row and its Switch', () => {
    const tree = render({pinEnabled: true, onSetPinEnabled: jest.fn()});
    expect(hasText(tree, 'SECURITY')).toBe(true);
    expect(hasText(tree, 'PIN lock')).toBe(true);
    expect(hasText(tree, 'App locks when idle')).toBe(true);
    expect(tree.root.findAllByType(Switch)).toHaveLength(1);
  });

  it('reflects a disabled PIN in the row’s sub-label', () => {
    expect(hasText(render({pinEnabled: false, onSetPinEnabled: jest.fn()}), 'Lock screen disabled')).toBe(true);
  });

  it('still hides the section when no onSetPinEnabled is wired (pre-existing data gate)', () => {
    // The flag ADDS a gate; it must not have replaced the wiring gate that was already there.
    expect(hasText(render({pinEnabled: true, onSetPinEnabled: undefined}), 'SECURITY')).toBe(false);
  });

  it('enables the PIN straight away — no verification needed to turn protection ON', () => {
    const onSetPinEnabled = jest.fn();
    const tree = render({pinEnabled: false, onSetPinEnabled, onVerifyPin: jest.fn()});
    act(() => {
      tree.root.findByType(Switch).props.onValueChange(true);
    });
    expect(onSetPinEnabled).toHaveBeenCalledWith(true);
    expect(hasText(tree, 'Confirm your PIN')).toBe(false);
  });

  it('opens the PIN-confirm dialog when disabling, and only disables on a verified PIN', async () => {
    const onSetPinEnabled = jest.fn();
    const onVerifyPin = jest.fn().mockResolvedValue(true);
    const tree = render({pinEnabled: true, onSetPinEnabled, onVerifyPin});

    act(() => {
      tree.root.findByType(Switch).props.onValueChange(false);
    });
    // Disabling is gated behind the dialog — not applied on the toggle itself.
    expect(hasText(tree, 'Confirm your PIN')).toBe(true);
    expect(onSetPinEnabled).not.toHaveBeenCalled();

    const confirm = tree.root
      .findAll(n => typeof n.props?.onPress === 'function')
      .find(n => textOf(n).trim() === 'Disable PIN');
    await act(async () => {
      confirm!.props.onPress();
      await new Promise(resolve => setImmediate(resolve));
    });
    expect(onVerifyPin).toHaveBeenCalledTimes(1);
    expect(onSetPinEnabled).toHaveBeenCalledWith(false);
  });

  it('keeps the PIN on and shows an error when the confirmation PIN is wrong', async () => {
    const onSetPinEnabled = jest.fn();
    const onVerifyPin = jest.fn().mockResolvedValue(false);
    const tree = render({pinEnabled: true, onSetPinEnabled, onVerifyPin});

    act(() => {
      tree.root.findByType(Switch).props.onValueChange(false);
    });
    const confirm = tree.root
      .findAll(n => typeof n.props?.onPress === 'function')
      .find(n => textOf(n).trim() === 'Disable PIN');
    await act(async () => {
      confirm!.props.onPress();
      await new Promise(resolve => setImmediate(resolve));
    });
    expect(hasText(tree, 'Incorrect PIN. Try again.')).toBe(true);
    expect(onSetPinEnabled).not.toHaveBeenCalled();
  });
});
