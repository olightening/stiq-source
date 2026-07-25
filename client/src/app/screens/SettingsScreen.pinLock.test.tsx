/**
 * SettingsScreen → the SECURITY section (PIN_LOCK_UI, bugs 5+6).
 *
 * Pins the ship-dark contract both ways: with the flag off the section is ABSENT — and so is its
 * header, because the PIN switch is its only row and a bare "SECURITY" heading over nothing is
 * exactly the visual residue bug 6 is about. The mirror file (SettingsScreen.pinLockOn.test.tsx)
 * asserts the row + its disable-confirmation dialog come back, unchanged, when the flag is flipped.
 *
 * Mirrors the react-test-renderer approach of SettingsScreen.updates.test.tsx (the ship-dark
 * precedent this section follows).
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Switch} from 'react-native';
import {SettingsScreen} from './SettingsScreen';

// The first RN + react-test-renderer transform can exceed Jest's 5s default on a cold cache.
jest.setTimeout(20000);

/** Concatenated text under a node (react-test-renderer). */
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

describe('SettingsScreen — SECURITY / PIN lock (shipped dark)', () => {
  // Every callback the section needs is wired: the ONLY thing keeping it off screen is the flag.
  const wired = {
    pinEnabled: true,
    onSetPinEnabled: jest.fn(),
    onVerifyPin: jest.fn().mockResolvedValue(true),
  };

  it('renders no SECURITY section header — not even an empty one', () => {
    expect(hasText(render(wired), 'SECURITY')).toBe(false);
  });

  it('renders no PIN lock row, label or sub-label', () => {
    const tree = render(wired);
    expect(hasText(tree, 'PIN lock')).toBe(false);
    expect(hasText(tree, 'App locks when idle')).toBe(false);
    expect(hasText(tree, 'Lock screen disabled')).toBe(false);
  });

  it('mounts no Switch at all (the PIN toggle was Settings’ only one)', () => {
    // Guards against the row's control surviving a text-only removal.
    expect(render(wired).root.findAllByType(Switch)).toHaveLength(0);
  });

  it('does not mount the "Confirm your PIN" disable dialog', () => {
    const tree = render(wired);
    expect(hasText(tree, 'Confirm your PIN')).toBe(false);
    expect(hasText(tree, 'Enter your current PIN to disable the lock screen.')).toBe(false);
    expect(hasText(tree, 'Disable PIN')).toBe(false);
  });

  it('never calls onSetPinEnabled/onVerifyPin — there is no surface left to call them', () => {
    render(wired);
    expect(wired.onSetPinEnabled).not.toHaveBeenCalled();
    expect(wired.onVerifyPin).not.toHaveBeenCalled();
  });

  it('leaves the rest of Settings intact — the section vanishes, nothing else moves (bug 6)', () => {
    // The neighbours the SECURITY block sat between. If hiding it had disturbed the surrounding
    // layout — an orphaned divider, a dropped sibling — these would be the casualties.
    const tree = render({...wired, onSignOut: jest.fn()});
    expect(hasText(tree, 'Sign out')).toBe(true); // the danger footer that followed it
    expect(hasText(tree, 'Stiq.')).toBe(true); // the version footer below that
  });
});
