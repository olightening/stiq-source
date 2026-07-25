/**
 * OnboardingScreen — PIN step (via the shared PinKeypad) + Done step's enrollment-guard contract.
 *
 * `PinStep` and `DoneStep` are exported (see OnboardingScreen.tsx) purely so these two pieces can be
 * exercised directly, without re-driving the whole welcome→code→connecting→identity chain (which
 * needs a live Tor-exchange mock and isn't what either fix below touches).
 *
 * Covers:
 *   - PinStep's choose → confirm-mismatch (error + retry, no phase reset) → confirm-match → onDone
 *     flow now runs entirely through the shared PinKeypad (bugs #2/#3's unification) and still lands
 *     on the exact chosen PIN.
 *   - DoneStep's presentational half of bug #1's double-tap guard: `entering` relabels the button to
 *     "Entering…" and disables it (nulls onPress), so once the parent (OnboardingScreen) sets that
 *     state a second tap physically cannot fire. The synchronous same-tick race guard itself
 *     (`useSubmitGuard`) is the identical primitive already covered by useSubmitGuard.test.tsx and
 *     exercised end-to-end for this exact pattern by LockScreen.test.tsx's double-tap test.
 */
import 'react-native';
import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {PinStep, DoneStep} from './OnboardingScreen';
import type {GradientSpec} from '../../media/gradient';

function pressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function');
}

function allPressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
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
  const match = pressables(tree).find(n => textOf(n).trim() === label);
  if (!match) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    match.props.onPress();
  });
}

function typeDigits(tree: renderer.ReactTestRenderer, digits: string): void {
  for (const d of digits) press(tree, d);
}

const GRADIENT: GradientSpec = {type: 'linear', angle: 120, stops: ['#7cb2ff', '#b89aff']};

describe('OnboardingScreen PinStep (shared PinKeypad)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('choose → confirm (matching) → onDone with the chosen PIN', () => {
    jest.useFakeTimers();
    const onDone = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinStep onDone={onDone} />);
    });

    expect(textOf(tree!.root)).toContain('Choose your PIN');
    typeDigits(tree!, '1234');
    act(() => {
      jest.runAllTimers();
    });

    // Phase flipped to confirm — no onDone yet.
    expect(onDone).not.toHaveBeenCalled();
    expect(textOf(tree!.root)).toContain('Confirm your PIN');

    typeDigits(tree!, '1234');
    act(() => {
      jest.runAllTimers();
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });

  it('a confirm mismatch shows an error and retries the SAME confirm phase (chosen PIN unchanged)', () => {
    jest.useFakeTimers();
    const onDone = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PinStep onDone={onDone} />);
    });

    typeDigits(tree!, '1234'); // choose
    act(() => {
      jest.runAllTimers();
    });

    typeDigits(tree!, '0000'); // wrong confirm
    act(() => {
      jest.runAllTimers();
    });

    expect(onDone).not.toHaveBeenCalled();
    expect(textOf(tree!.root)).toContain('That didn’t match — try again.');
    expect(textOf(tree!.root)).toContain('Confirm your PIN'); // stayed on confirm, not reset to choose

    // Retrying with the ORIGINALLY chosen PIN (not the failed attempt) now matches.
    typeDigits(tree!, '1234');
    act(() => {
      jest.runAllTimers();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('1234');

    act(() => {
      tree!.unmount();
    });
  });
});

describe('OnboardingScreen DoneStep (bug #1 presentational guard)', () => {
  it('shows "Enter the community →" and a live onPress when not entering', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    const onEnter = jest.fn();
    act(() => {
      tree = renderer.create(
        <DoneStep
          gradient={GRADIENT}
          handle="Tester"
          community="Acme"
          error=""
          entering={false}
          onEnter={onEnter}
        />,
      );
    });

    expect(textOf(tree!.root)).toContain('Enter the community →');
    const btn = allPressables(tree!).find(n => textOf(n).includes('Enter the community'));
    expect(typeof btn?.props.onPress).toBe('function');
    act(() => {
      btn!.props.onPress();
    });
    expect(onEnter).toHaveBeenCalledTimes(1);

    act(() => {
      tree!.unmount();
    });
  });

  it('relabels to "Entering…" and nulls onPress while entering — a tap is physically a no-op', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    const onEnter = jest.fn();
    act(() => {
      tree = renderer.create(
        <DoneStep
          gradient={GRADIENT}
          handle="Tester"
          community="Acme"
          error=""
          entering
          onEnter={onEnter}
        />,
      );
    });

    expect(textOf(tree!.root)).toContain('Entering…');
    expect(textOf(tree!.root)).not.toContain('Enter the community →');
    const btn = allPressables(tree!).find(n => textOf(n).includes('Entering'));
    // Disabled keys are nulled out (never a live no-op function) — mirrors PrimaryButton's existing
    // disabled contract used everywhere else in onboarding.
    expect(btn?.props.onPress).toBeUndefined();

    act(() => {
      tree!.unmount();
    });
  });
});
