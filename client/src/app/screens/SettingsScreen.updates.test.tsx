/**
 * SettingsScreen → "App updates" section (T9, APK_UPDATES).
 *
 * Pins the ship-dark + wiring contract: the section is ABSENT unless `apkUpdatesEnabled` is on AND an
 * `onCheckForUpdate` callback is supplied; a check that returns an offer renders "Update available", the
 * what-changed note, and an Install button; a check that returns null shows "up to date"; and tapping
 * Install calls `onInstallUpdate` exactly once with the offered UpdateInfo. Mirrors the react-test-renderer
 * approach of SettingsScreen.managedata.test.tsx.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SettingsScreen} from './SettingsScreen';
import type {UpdateInfo} from '../../update/updater';

// The first RN + react-test-renderer transform can exceed Jest's 5s default on a cold cache.
jest.setTimeout(20000);

const INFO: UpdateInfo = {
  versionName: '1.1',
  versionCode: 2,
  apkUrl: 'http://relay.onion/fdroid/repo/stiq_2.apk',
  apkSha256: 'bb22',
  whatChanged: 'Fixes the sync bug and adds dark mode.',
};

/** Concatenated text under a node (react-test-renderer). */
function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function pressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function');
}

function press(tree: renderer.ReactTestRenderer, label: string): void {
  const match = pressables(tree).filter(n => textOf(n).trim() === label);
  if (match.length === 0) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    match[0]!.props.onPress();
  });
}

/** Press the first pressable whose flattened text CONTAINS `substr` (rows carry a › chevron). */
function pressContaining(tree: renderer.ReactTestRenderer, substr: string): void {
  const match = pressables(tree).find(n => textOf(n).includes(substr));
  if (!match) throw new Error(`no pressable containing "${substr}"`);
  act(() => {
    match.props.onPress();
  });
}

/** True when any node's flattened text contains `substr`. */
function hasText(tree: renderer.ReactTestRenderer, substr: string): boolean {
  return tree.root.findAll(() => true).some(n => textOf(n).includes(substr));
}

/** Flush the async check/install promise chains (then/catch/finally) + the re-render they trigger. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve));
  });
}

function render(props: Partial<React.ComponentProps<typeof SettingsScreen>>): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<SettingsScreen visible onClose={jest.fn()} version="1.0" {...props} />);
  });
  return tree!;
}

describe('SettingsScreen — App updates', () => {
  it('hides the whole section when apkUpdatesEnabled is false', () => {
    const tree = render({apkUpdatesEnabled: false, onCheckForUpdate: jest.fn()});
    expect(hasText(tree, 'APP UPDATES')).toBe(false);
    expect(hasText(tree, 'Current version')).toBe(false);
    expect(pressables(tree).some(n => textOf(n).trim() === 'Check for updates')).toBe(false);
  });

  it('hides the section when no onCheckForUpdate is wired (community has no repo)', () => {
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate: undefined});
    expect(hasText(tree, 'APP UPDATES')).toBe(false);
  });

  it('shows the real current version sourced from the version prop', () => {
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate: jest.fn(), version: '1.0'});
    expect(hasText(tree, 'Current version')).toBe(true);
    expect(hasText(tree, 'v1.0')).toBe(true);
  });

  it('shows "Update available" + the what-changed note + Install when a check returns an offer', async () => {
    const onCheckForUpdate = jest.fn().mockResolvedValue(INFO);
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate, onInstallUpdate: jest.fn()});
    pressContaining(tree, 'Check for updates');
    await flush();
    expect(onCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(hasText(tree, 'Update available · v1.1')).toBe(true);
    expect(hasText(tree, 'Fixes the sync bug and adds dark mode.')).toBe(true);
    expect(pressables(tree).some(n => textOf(n).trim() === 'Install')).toBe(true);
  });

  it('shows "up to date" when a check returns null', async () => {
    const onCheckForUpdate = jest.fn().mockResolvedValue(null);
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate});
    pressContaining(tree, 'Check for updates');
    await flush();
    expect(hasText(tree, 'up to date')).toBe(true);
    expect(hasText(tree, 'Update available')).toBe(false);
  });

  it('surfaces an inline error (no crash) when the check rejects', async () => {
    const onCheckForUpdate = jest.fn().mockRejectedValue(new Error('offline'));
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate});
    pressContaining(tree, 'Check for updates');
    await flush();
    expect(hasText(tree, 'Update check failed')).toBe(true);
  });

  it('calls onInstallUpdate exactly once with the offered UpdateInfo when Install is tapped', async () => {
    const onCheckForUpdate = jest.fn().mockResolvedValue(INFO);
    const onInstallUpdate = jest.fn().mockResolvedValue(undefined);
    const tree = render({apkUpdatesEnabled: true, onCheckForUpdate, onInstallUpdate});
    pressContaining(tree, 'Check for updates');
    await flush();
    press(tree, 'Install');
    await flush();
    expect(onInstallUpdate).toHaveBeenCalledTimes(1);
    expect(onInstallUpdate).toHaveBeenCalledWith(INFO);
  });
});
