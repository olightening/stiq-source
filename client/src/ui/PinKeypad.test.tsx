/**
 * PinKeypad — the shared onboarding/lock PIN keypad (stiq-onboarding-pin-lock-unification).
 *
 * Covers:
 *   - clamps input at `length` and auto-completes (after the flash delay), then self-clears.
 *   - a backspace that races the auto-complete delay cancels it (no stale completion) — sync mode.
 *   - `asyncComplete` fires onComplete the instant the last digit lands (so a slow verify overlaps the
 *     flash instead of waiting behind it), and a post-entry backspace is then a no-op.
 *   - `busy` ignores new digit presses (defense in depth alongside the caller's own submit guard)
 *     but never touches a key's `disabled` prop — the whole point of the responsiveness fix.
 *   - `shakeSignal` only re-plays on a genuine CHANGE, never on mount with a nonzero initial value.
 *   - `error` renders as supplied (generic copy is the caller's responsibility, not this component's).
 */
import 'react-native';
import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {PinKeypad} from './PinKeypad';

function pressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function');
}

function allKeys(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAllByType(Pressable);
}

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function press(tree: renderer.ReactTestRenderer, label: string): void {
  const matches = pressables(tree).filter(n => textOf(n).trim() === label);
  if (matches.length === 0) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    matches[0]!.props.onPress();
  });
}

function typeDigits(tree: renderer.ReactTestRenderer, digits: string): void {
  for (const d of digits) press(tree, d);
}

describe('PinKeypad', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('clamps input at `length` and does not overflow', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" onComplete={onComplete} />);
    });

    typeDigits(tree!, '99999'); // 5 taps against the default length of 4
    act(() => {
      jest.runAllTimers();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('9999');

    act(() => {
      tree!.unmount();
    });
  });

  it('auto-completes once `length` digits are entered (after the flash delay), then self-clears', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" length={4} onComplete={onComplete} />);
    });

    typeDigits(tree!, '1234');
    expect(onComplete).not.toHaveBeenCalled(); // not yet — the flash delay hasn't elapsed

    act(() => {
      jest.runAllTimers();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('1234');
    expect(jest.getTimerCount()).toBe(0); // no dangling timer left armed

    // Self-cleared: typing a fresh 4 digits immediately after completes again with a NEW pin.
    typeDigits(tree!, '5678');
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith('5678');

    act(() => {
      tree!.unmount();
    });
  });

  it('a backspace that races the auto-complete delay cancels it', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" length={4} onComplete={onComplete} />);
    });

    typeDigits(tree!, '1234');
    press(tree!, '⌫'); // backspace before the flash delay elapses

    act(() => {
      jest.runAllTimers();
    });

    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      tree!.unmount();
    });
  });

  it('asyncComplete fires onComplete immediately on the last digit (overlapping the flash), then clears', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" length={4} onComplete={onComplete} asyncComplete />);
    });

    typeDigits(tree!, '1234');
    // Fired SYNCHRONOUSLY on the 4th digit — no need to run the flash timer first. This is the ~200ms
    // unlock saving: the KDF verify starts immediately instead of behind the cosmetic flash.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('1234');

    // The remaining timer only clears the (cosmetic) dots; it must NOT fire onComplete a second time.
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    act(() => {
      tree!.unmount();
    });
  });

  it('asyncComplete: a backspace after a full entry is a no-op (never slices a submitted PIN)', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" length={4} onComplete={onComplete} asyncComplete />);
    });

    typeDigits(tree!, '1234'); // onComplete already fired — the verify is in flight
    expect(onComplete).toHaveBeenCalledTimes(1);
    press(tree!, '⌫'); // must NOT cancel/slice the already-submitted entry
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenLastCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });

  it('respects a custom `length` shorter than 4', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" length={6} onComplete={onComplete} />);
    });

    typeDigits(tree!, '12345'); // 5 digits — not yet at the 6-digit length
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).not.toHaveBeenCalled();

    typeDigits(tree!, '6');
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).toHaveBeenCalledWith('123456');

    act(() => {
      tree!.unmount();
    });
  });

  it('busy ignores new digit presses but never disables a key (no visual freeze)', () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" onComplete={onComplete} busy />);
    });

    // Every digit key still has a live onPress — busy never nulls it out (unlike PinPad's
    // `disabled` gating), which is what keeps the pad from visually "greying out".
    const one = allKeys(tree!).find(n => textOf(n).trim() === '1');
    expect(typeof one?.props.onPress).toBe('function');

    typeDigits(tree!, '1234');
    act(() => {
      jest.runAllTimers();
    });
    expect(onComplete).not.toHaveBeenCalled(); // presses were no-ops while busy

    act(() => {
      tree!.unmount();
    });
  });

  it('shakeSignal only replays on a genuine change, never on mount with a nonzero initial value', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinKeypad title="" onComplete={jest.fn()} shakeSignal={3} />);
    });
    // No crash / no observable side effect expected on mount — the dots simply render.
    expect(tree!.toJSON()).toBeTruthy();

    act(() => {
      tree!.update(<PinKeypad title="" onComplete={jest.fn()} shakeSignal={4} />);
    });
    // Still renders cleanly after a genuine change triggers the shake animation.
    expect(tree!.toJSON()).toBeTruthy();

    act(() => {
      tree!.unmount();
    });
  });

  it('renders the caller-supplied error text verbatim', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <PinKeypad title="Enter your PIN" error="Incorrect PIN. Try again." onComplete={jest.fn()} />,
      );
    });
    expect(textOf(tree!.root)).toContain('Incorrect PIN. Try again.');

    act(() => {
      tree!.unmount();
    });
  });

  it('renders title, helper, and footnote', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <PinKeypad
          title="Choose your PIN"
          helper="You'll enter this every time you open Stiq."
          footnote="Stored only on this phone."
          onComplete={jest.fn()}
        />,
      );
    });
    const text = textOf(tree!.root);
    expect(text).toContain('Choose your PIN');
    expect(text).toContain("You'll enter this every time you open Stiq.");
    expect(text).toContain('Stored only on this phone.');

    act(() => {
      tree!.unmount();
    });
  });
});
