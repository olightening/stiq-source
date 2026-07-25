import 'react-native';
import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {SyncDebugScreen} from './SyncDebugScreen';
// TODO(T10-S3): syncStats.ts is authored by T10-S3 in this same wave; this test can only run once it
// lands. It is coded against the planned API (recordSyncStat / clearSyncStats / ReconcileStats).
import {clearSyncStats, recordSyncStat} from '../../nostr/syncStats';
import {colors} from '../../ui/theme';

/**
 * SyncDebugScreen renders a read-only view over the sync-stats ring buffer: an empty state with no
 * stats, a live-updating list after recordSyncStat, a FALLBACK badge for fell-back rounds, and a
 * working Clear action. The ring buffer is module-global, so isolate each test with clearSyncStats.
 */

function stat(over: Partial<Parameters<typeof recordSyncStat>[0]> = {}) {
  return {
    subId: 'sub-1',
    rounds: 3,
    wallMs: 120,
    need: 7,
    have: 42,
    frameBytesOut: 2048,
    fellBack: false,
    at: Date.now(),
    ...over,
  };
}

/** Flatten a Text node's children (strings / numbers / nested arrays) into one string. */
function flatten(children: unknown): string {
  if (children == null || children === false || children === true) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flatten).join('');
  return '';
}

/** Concatenated text rendered under an instance (join of every descendant <Text>). */
function textUnder(inst: renderer.ReactTestInstance): string {
  return inst.findAllByType(Text).map(t => flatten(t.props.children)).join(' ');
}

let tree: renderer.ReactTestRenderer | undefined;

function mount(): void {
  act(() => {
    tree = renderer.create(<SyncDebugScreen visible onClose={() => undefined} c={colors} />);
  });
}

beforeEach(() => clearSyncStats());
afterEach(() => {
  // Unmount first (cleans up the subscription) so the buffer clear can't notify a mounted tree.
  act(() => tree?.unmount());
  tree = undefined;
  clearSyncStats();
});

it('shows an empty state with no stats', () => {
  mount();
  expect(textUnder(tree!.root)).toContain('No reconciliations yet');
});

it('renders a row (rounds, wall time, FALLBACK badge) live after recordSyncStat', () => {
  mount();
  act(() => {
    recordSyncStat(stat({rounds: 3, wallMs: 120, fellBack: true}));
  });

  const all = textUnder(tree!.root);
  expect(all).toContain('3 rounds');
  expect(all).toContain('120 ms');
  expect(all).toContain('FALLBACK');
  expect(all).not.toContain('No reconciliations yet');
});

it('Clear empties the list', () => {
  mount();
  act(() => {
    recordSyncStat(stat());
  });
  expect(textUnder(tree!.root)).toContain('3 rounds');

  // Tap the "Clear" header action (the pressable whose text is exactly "Clear").
  const clearBtn = tree!.root
    .findAll(n => typeof n.props?.onPress === 'function' && textUnder(n).trim() === 'Clear')[0]!;
  act(() => {
    clearBtn.props.onPress();
  });

  expect(textUnder(tree!.root)).toContain('No reconciliations yet');
});
