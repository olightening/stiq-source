/**
 * SettingsScreen → "Manage cached data" sub-sheet — the fine-grained deletion UI.
 *
 * These tests pin the mapping the owner asked for: the chosen TYPE (rendered media / cached events)
 * and DATE RANGE preset must translate into exactly the right {media, events, olderThanSeconds} call,
 * a live count preview must be requested, and an empty selection must be a no-op. They also pin that
 * a successful delete confirms itself: the real counts returned by onDeleteCachedData surface in a
 * second "Cache cleared" Alert, instead of the delete completing silently.
 */
import 'react-native';
import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {SettingsScreen} from './SettingsScreen';

// The first RN + react-test-renderer transform can exceed Jest's 5s default on a cold cache.
jest.setTimeout(20000);

// Deterministic "now" so an "older than N days" cutoff is exact.
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

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

/** Press the pressable whose flattened text EXACTLY equals `label`. */
function press(tree: renderer.ReactTestRenderer, label: string): void {
  const match = pressables(tree).filter(n => textOf(n).trim() === label);
  if (match.length === 0) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    match[0]!.props.onPress();
  });
}

/** Press the first pressable whose flattened text CONTAINS `substr` (for rows with extra chrome). */
function pressContaining(tree: renderer.ReactTestRenderer, substr: string): void {
  const match = pressables(tree).find(n => textOf(n).includes(substr));
  if (!match) throw new Error(`no pressable containing "${substr}"`);
  act(() => {
    match.props.onPress();
  });
}

/** All Switch-like nodes (they expose onValueChange), in render order: [media, events]. */
function switches(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onValueChange === 'function');
}

function setSwitch(tree: renderer.ReactTestRenderer, index: number, value: boolean): void {
  act(() => {
    switches(tree)[index]!.props.onValueChange(value);
  });
}

function render(props: Partial<React.ComponentProps<typeof SettingsScreen>>): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SettingsScreen visible onClose={jest.fn()} {...props} />,
    );
  });
  // Open the "Manage data…" sub-sheet (runs its reset + count effects).
  pressContaining(tree!, 'Manage data');
  return tree!;
}

describe('SettingsScreen — Manage cached data', () => {
  let dateSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    // Auto-confirm the destructive Alert by invoking its "Delete" button.
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const del = (buttons as {text?: string; onPress?: () => void}[] | undefined)?.find(
        b => b.text === 'Delete',
      );
      del?.onPress?.();
    });
  });
  afterEach(() => {
    dateSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('requests a live count for the default selection (events, "older than 30 days")', () => {
    const onCountCachedEvents = jest.fn(() => 7);
    render({onCountCachedEvents, onDeleteCachedData: jest.fn(() => ({events: 0, media: 0}))});
    // Opening the sheet defaults to events + the 30-day preset, so the preview asks for that cutoff.
    expect(onCountCachedEvents).toHaveBeenCalledWith(NOW_SEC - 30 * DAY);
  });

  it('deletes cached events for the default 30-day preset', () => {
    const onDeleteCachedData = jest.fn(() => ({events: 3, media: 0}));
    const tree = render({onCountCachedEvents: jest.fn(() => 3), onDeleteCachedData});
    press(tree, 'Delete selected data');
    expect(onDeleteCachedData).toHaveBeenCalledWith({
      media: false,
      events: true,
      olderThanSeconds: NOW_SEC - 30 * DAY,
    });
  });

  it('maps "Everything cached" + rendered media toggle to a full, undated delete of both types', () => {
    const onDeleteCachedData = jest.fn(() => ({events: 0, media: 1}));
    const tree = render({onCountCachedEvents: jest.fn(() => 0), onDeleteCachedData});
    setSwitch(tree, 0, true); // turn ON rendered media
    press(tree, 'Everything cached'); // no date cutoff
    press(tree, 'Delete selected data');
    expect(onDeleteCachedData).toHaveBeenCalledWith({
      media: true,
      events: true,
      olderThanSeconds: undefined,
    });
  });

  it('maps the 7-day preset to the right cutoff', () => {
    const onDeleteCachedData = jest.fn(() => ({events: 1, media: 0}));
    const tree = render({onCountCachedEvents: jest.fn(() => 1), onDeleteCachedData});
    press(tree, 'Older than 7 days');
    press(tree, 'Delete selected data');
    expect(onDeleteCachedData).toHaveBeenCalledWith({
      media: false,
      events: true,
      olderThanSeconds: NOW_SEC - 7 * DAY,
    });
  });

  it('is a no-op when neither type is selected (delete disabled, no confirm)', () => {
    const onDeleteCachedData = jest.fn(() => ({events: 0, media: 0}));
    const tree = render({onCountCachedEvents: jest.fn(() => 5), onDeleteCachedData});
    setSwitch(tree, 1, false); // turn OFF cached events → nothing selected (media already off)
    press(tree, 'Delete selected data');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(onDeleteCachedData).not.toHaveBeenCalled();
  });

  it('confirms the delete with a "Cache cleared" alert reporting the real removed count', () => {
    const onDeleteCachedData = jest.fn(() => ({events: 3, media: 0}));
    const tree = render({onCountCachedEvents: jest.fn(() => 3), onDeleteCachedData});
    press(tree, 'Delete selected data'); // default selection: events, 30-day preset

    // Two Alert.alert calls: the destructive confirm (auto-answered "Delete" by the spy above) and
    // the completion alert reporting what was actually removed.
    expect(alertSpy).toHaveBeenCalledTimes(2);
    const completionCall = alertSpy.mock.calls.find(([title]) => title === 'Cache cleared');
    expect(completionCall).toBeDefined();
    const [, message] = completionCall!;
    expect(message).toContain('Removed 3 cached events');
  });
});
