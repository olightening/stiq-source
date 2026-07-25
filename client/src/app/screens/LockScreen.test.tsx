/**
 * LockScreen — PIN entry integration (bug #1) + PinKeypad unification (bugs #2/#3):
 *   - renders the SAME PinKeypad as OnboardingScreen's PIN step (no separate lock-only design);
 *   - the pad auto-submits once the enrolled 4-digit PIN length is reached (no checkmark — there
 *     isn't one anymore, matching onboarding's keypad exactly);
 *   - a rejected PIN shows the generic error (never distinguishing duress);
 *   - a double-tap/ghost-press on the last digit (the closest analogue to PinPad's old checkmark
 *     race, now that there's no checkmark) calls onSubmitPin only ONCE, via useSubmitGuard — the
 *     stale-closure `if (busy) return; setBusy(true)` race this replaces could double-submit one
 *     wrong PIN, burning two lockout attempts for a single typo.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable} from 'react-native';
import {LockScreen} from './LockScreen';
import type {UnlockOutcome} from '../../lock/controller';

function allKeys(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAllByType(Pressable);
}

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: any): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function keyLabelled(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance {
  const match = allKeys(tree).find(n => textOf(n).trim() === label);
  if (!match) throw new Error(`no key labelled "${label}"`);
  return match;
}

function press(tree: renderer.ReactTestRenderer, label: string): void {
  act(() => {
    keyLabelled(tree, label).props.onPress();
  });
}

async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('LockScreen', () => {
  it('auto-submits once 4 digits are entered, without tapping the checkmark', async () => {
    const onSubmitPin = jest.fn(async (): Promise<UnlockOutcome> => 'unlocked');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<LockScreen onSubmitPin={onSubmitPin} />);
    });

    jest.useFakeTimers();
    for (const d of '1234') press(tree!, d);
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
    await flush();

    expect(onSubmitPin).toHaveBeenCalledTimes(1);
    expect(onSubmitPin).toHaveBeenCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });

  it('a rejected PIN shows a generic error (never distinguishes duress)', async () => {
    const onSubmitPin = jest.fn(async (): Promise<UnlockOutcome> => 'rejected');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<LockScreen onSubmitPin={onSubmitPin} />);
    });

    jest.useFakeTimers();
    for (const d of '0000') press(tree!, d);
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
    await flush();

    expect(textOf(tree!.root)).toContain('Incorrect PIN. Try again.');

    act(() => {
      tree!.unmount();
    });
  });

  it('a double-tap on the 4th digit (racing before `busy` re-renders) calls onSubmitPin only once', async () => {
    jest.useFakeTimers();
    let resolveOutcome: (o: UnlockOutcome) => void = () => {};
    const onSubmitPin = jest.fn(
      () =>
        new Promise<UnlockOutcome>(resolve => {
          resolveOutcome = resolve;
        }),
    );
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<LockScreen onSubmitPin={onSubmitPin} />);
    });

    for (const d of '123') press(tree!, d);
    const four = keyLabelled(tree!, '4');
    // Fire the 4th digit's onPress TWICE in the same synchronous tick — the same stale-`entry`-
    // closure race a double-tap/ghost-press produces (PinKeypad has no checkmark to race anymore;
    // this is the closest analogue). Both calls arm PinKeypad's own auto-complete timer against the
    // same '1234' — fake timers hold both off so they can't interfere with the race below.
    act(() => {
      four.props.onPress();
      four.props.onPress();
    });
    act(() => {
      jest.runAllTimers(); // fires both of PinKeypad's armed timers, if any
    });

    resolveOutcome('unlocked');
    await flush();
    jest.useRealTimers();

    expect(onSubmitPin).toHaveBeenCalledTimes(1);
    expect(onSubmitPin).toHaveBeenCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });

  it('bug #3: the pad is immediately usable again after a rejection — no busy-driven freeze', async () => {
    // First attempt wrong (rejected + shake), second attempt right — proves the pad never gets
    // stuck/disabled after a rejection the way PinPad's `busy`-greyed-out keys used to feel.
    const onSubmitPin = jest.fn(async (pin: string): Promise<UnlockOutcome> =>
      pin === '1234' ? 'unlocked' : 'rejected',
    );
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<LockScreen onSubmitPin={onSubmitPin} />);
    });

    jest.useFakeTimers();
    for (const d of '0000') press(tree!, d);
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
    await flush();
    expect(textOf(tree!.root)).toContain('Incorrect PIN. Try again.');

    // Every key still has a live onPress right after the rejection settles (no `disabled` prop was
    // ever set on them — see PinKeypad's `busy` contract).
    for (const label of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      expect(typeof keyLabelled(tree!, label).props.onPress).toBe('function');
    }

    // A fresh, correct entry right after still works end-to-end.
    jest.useFakeTimers();
    for (const d of '1234') press(tree!, d);
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
    await flush();

    expect(onSubmitPin).toHaveBeenCalledTimes(2);
    expect(onSubmitPin).toHaveBeenLastCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });
});
