/**
 * ReliabilitySheet — pins the resolvable "Action needed" contract (reliability.ts's
 * `reliabilityActionNeeded`): on an aggressive OEM that's already exempt, the sheet shows a
 * "steps pending" warning with an acknowledge control, and pressing it flips the status card to
 * the green "granted" state (mirroring the Settings row badge, which derives from the same
 * predicate). AsyncStorage is mocked with the same shared in-memory mockStore pattern as
 * power/reliability.test.ts; NativeModules.StiqPower is mutated directly per test.
 */

// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  },
  removeItem: (k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  },
}));

import 'react-native';
import React from 'react';
import {NativeModules} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {ReliabilitySheet} from './ReliabilitySheet';
import {colors} from '../../ui/theme';

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

/** True when any node's flattened text contains `substr`. */
function hasText(tree: renderer.ReactTestRenderer, substr: string): boolean {
  return tree.root.findAll(() => true).some(n => textOf(n).includes(substr));
}

/** Flush the recheck() promise chain (Promise.all/then/finally) + the re-render it triggers. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve));
  });
}

describe('ReliabilitySheet — resolvable Action-needed badge (aggressive OEM)', () => {
  beforeEach(() => {
    mockStore = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => true), // already exempt
      requestIgnoreBatteryOptimizations: jest.fn(),
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Xiaomi', brand: 'Redmi', model: 'X'})),
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (NativeModules as any).StiqPower;
  });

  it('shows the steps-pending warning (not the green state) when exempt but not yet acknowledged', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReliabilitySheet visible onClose={jest.fn()} c={colors} />);
    });
    await flush();

    expect(hasText(tree!, 'One more step for your device')).toBe(true);
    expect(hasText(tree!, 'Background connection allowed')).toBe(false);
    expect(hasText(tree!, "I've done these steps")).toBe(true);
  });

  it('acknowledging the OEM steps flips the status card to green and persists the flag', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReliabilitySheet visible onClose={jest.fn()} c={colors} />);
    });
    await flush();

    press(tree!, "I've done these steps");
    await flush();

    expect(hasText(tree!, 'Background connection allowed')).toBe(true);
    expect(hasText(tree!, 'One more step for your device')).toBe(false);
    expect(hasText(tree!, '✓ Steps marked done')).toBe(true);
    expect(mockStore['stiq.power.oemStepsAcknowledged']).toBe('true');
  });

  it('Undo clears the acknowledgement and restores the steps-pending warning', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReliabilitySheet visible onClose={jest.fn()} c={colors} />);
    });
    await flush();

    press(tree!, "I've done these steps");
    await flush();
    press(tree!, 'Undo');
    await flush();

    expect(hasText(tree!, 'One more step for your device')).toBe(true);
    expect(hasText(tree!, 'Background connection allowed')).toBe(false);
    expect(mockStore['stiq.power.oemStepsAcknowledged']).toBe('false');
  });
});
