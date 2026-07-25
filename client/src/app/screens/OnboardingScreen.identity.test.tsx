/**
 * OnboardingScreen — identity step (bug #9: "the random gradient generator isn't actually random,
 * same for the name generator").
 *
 * `IdentityStep` and `makeGradientOptions` are exported from OnboardingScreen.tsx purely so this
 * file can exercise them directly, following the precedent PinStep/DoneStep already set — reaching
 * the identity step for real means driving welcome→code→connecting first, which needs a live
 * Tor-exchange mock and tests none of what's below.
 *
 * The regressions being pinned:
 *   - the gradient grid was 8 frozen constants, identical on every phone, with index 0 pre-selected
 *     (so every member who didn't tap Shuffle wore the byte-identical gradient), and
 *   - the handle suggester drew from a flat list of exactly 10 hardcoded strings.
 */
import 'react-native';
import React from 'react';
import {Pressable, Text, TextInput} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {IdentityStep, makeGradientOptions, selectionAfterShuffle} from './OnboardingScreen';
import {GradientMaker} from '../../ui/GradientMaker';
import {encodeGradient, isValidGradient, type GradientSpec} from '../../media/gradient';

/** A stable identity for a spec, so "are these two the same gradient?" is a string compare. */
function specKey(g: GradientSpec): string {
  return `${g.type}|${encodeGradient(g)}`;
}

function pressableLabelled(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root
    .findAllByType(Pressable)
    .find(p => p.findAll(n => n.type === Text && n.props.children === label).length > 0);
}

describe('makeGradientOptions — the identity grid', () => {
  it('offers a full grid of valid gradients', () => {
    const opts = makeGradientOptions();
    expect(opts).toHaveLength(8); // 4×2 — swatchCell is 25% wide
    for (const g of opts) expect(isValidGradient(g)).toBe(true);
  });

  it('gives two devices different options — the actual bug', () => {
    // PRESET_GRADIENTS made this impossible: every member saw the same 8, so the pre-selected
    // default (index 0) was one shared constant across the entire community.
    const a = makeGradientOptions().map(specKey);
    const b = makeGradientOptions().map(specKey);
    expect(a).not.toEqual(b);
  });

  it('does not repeat within a single grid', () => {
    // Two identical swatches side by side would look like a rendering bug.
    const keys = makeGradientOptions().map(specKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('spreads the pre-selected default across a wide space over many mounts', () => {
    // Index 0 is what a member who never taps a swatch ends up wearing. It used to be ONE value.
    const firsts = new Set<string>();
    for (let i = 0; i < 60; i++) firsts.add(specKey(makeGradientOptions()[0]!));
    expect(firsts.size).toBeGreaterThan(50);
  });

  it('uses angles beyond the picker\'s 8 coarse detents', () => {
    // randomGradient snapped to 8 anchors (0,45,…,315); it now draws from 24 (0,15,…,345).
    const angles = new Set<number>();
    for (let i = 0; i < 120; i++) for (const g of makeGradientOptions()) angles.add(g.angle);
    expect([...angles].some(a => a % 45 !== 0)).toBe(true);
    // Still snapped — every angle is a clean multiple of 15 that round-trips on the wire.
    for (const a of angles) expect(a % 15).toBe(0);
    expect(Math.max(...angles)).toBeLessThan(360);
  });
});

describe('selectionAfterShuffle — what Shuffle is allowed to overwrite', () => {
  it('re-points a grid-picked selection at the new grid', () => {
    const previous = makeGradientOptions();
    const next = makeGradientOptions();
    expect(selectionAfterShuffle(previous[3]!, previous, next)).toBe(next[0]);
  });

  it('leaves a hand-rolled gradient alone', () => {
    // Regression guard for the behaviour Customize makes possible: tapping Shuffle out of curiosity
    // must not silently discard a gradient the member built themselves in the maker.
    const previous = makeGradientOptions();
    const mine: GradientSpec = {type: 'radial', angle: 90, stops: ['#123456', '#abcdef']};
    expect(selectionAfterShuffle(mine, previous, makeGradientOptions())).toBe(mine);
  });

  it('keeps a hand-rolled gradient even when it happens to match a swatch', () => {
    // Structurally identical but not the same object: it is still the member's own work.
    const previous = makeGradientOptions();
    const copy: GradientSpec = {...previous[2]!, stops: [...previous[2]!.stops]};
    expect(selectionAfterShuffle(copy, previous, makeGradientOptions())).toBe(copy);
  });
});

describe('IdentityStep', () => {
  function render(overrides: Partial<React.ComponentProps<typeof IdentityStep>> = {}) {
    const props = {
      gradient: {type: 'linear' as const, angle: 120, stops: ['#7cb2ff', '#b89aff']},
      gradOptions: makeGradientOptions(),
      handle: '',
      onPickGradient: jest.fn(),
      onShuffle: jest.fn(),
      onHandle: jest.fn(),
      onSuggest: jest.fn(),
      onContinue: jest.fn(),
      ...overrides,
    };
    let tree: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<IdentityStep {...props} />); });
    return {tree: tree!, props};
  }

  it('renders one swatch per generated option, each selecting its own spec', () => {
    const onPickGradient = jest.fn<void, [GradientSpec]>();
    const {tree, props} = render({onPickGradient});
    // Fire every Pressable in the step and see what the grid reported. Each swatch must hand back
    // exactly its own option, in order — proving the grid renders the GENERATED set rather than a
    // frozen list, and that no swatch is wired to the wrong spec.
    for (const p of tree.root.findAllByType(Pressable)) {
      if (typeof p.props.onPress === 'function') act(() => { p.props.onPress(); });
    }
    expect(onPickGradient.mock.calls.map(c => c[0])).toEqual(props.gradOptions);
  });

  it('asks the parent to reshuffle on ↻ Shuffle', () => {
    const {tree, props} = render();
    act(() => { pressableLabelled(tree, '↻ Shuffle')!.props.onPress(); });
    expect(props.onShuffle).toHaveBeenCalledTimes(1);
  });

  it('hides the full colour picker behind Customize, so the grid stays the fast path', () => {
    const {tree} = render();
    expect(tree.root.findAllByType(GradientMaker)).toHaveLength(0);
    expect(pressableLabelled(tree, 'Done')).toBeUndefined();

    act(() => { pressableLabelled(tree, 'Customize →')!.props.onPress(); });
    // The SAME maker the profile screen and the channel editors use — one picker in the app, not an
    // onboarding-shaped imitation of one.
    expect(tree.root.findAllByType(GradientMaker)).toHaveLength(1);

    act(() => { pressableLabelled(tree, 'Done')!.props.onPress(); });
    expect(tree.root.findAllByType(GradientMaker)).toHaveLength(0);
  });

  it('seeds the maker with the current selection and feeds its edits back', () => {
    const onPickGradient = jest.fn<void, [GradientSpec]>();
    const gradient: GradientSpec = {type: 'linear', angle: 120, stops: ['#7cb2ff', '#b89aff']};
    const {tree} = render({gradient, onPickGradient});
    act(() => { pressableLabelled(tree, 'Customize →')!.props.onPress(); });

    const maker = tree.root.findByType(GradientMaker);
    expect(maker.props.value).toEqual(gradient); // opens on what you already picked, not a reset
    const hand: GradientSpec = {type: 'radial', angle: 90, stops: ['#123456', '#abcdef']};
    act(() => { maker.props.onChange(hand); });
    // Custom edits travel the same path a swatch tap does, so there is one selection, not two.
    expect(onPickGradient).toHaveBeenCalledWith(hand);
  });

  it('asks the parent for a suggestion on 🎲 Suggest a handle', () => {
    const {tree, props} = render();
    act(() => { pressableLabelled(tree, '🎲  Suggest a handle')!.props.onPress(); });
    expect(props.onSuggest).toHaveBeenCalledTimes(1);
  });

  it('keeps the free-text override, clamped to the 24-char handle budget', () => {
    const {tree, props} = render();
    const input = tree.root.findByType(TextInput);
    expect(input.props.maxLength).toBe(24);
    act(() => { input.props.onChangeText('My Own Handle'); });
    expect(props.onHandle).toHaveBeenCalledWith('My Own Handle');
  });

  it('gates Continue on a non-empty handle', () => {
    const empty = render({handle: '   '});
    act(() => { pressableLabelled(empty.tree, 'Continue →')!.props.onPress?.(); });
    expect(empty.props.onContinue).not.toHaveBeenCalled();

    const filled = render({handle: 'Quiet River'});
    act(() => { pressableLabelled(filled.tree, 'Continue →')!.props.onPress?.(); });
    expect(filled.props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('no longer promises the handle is exclusively yours', () => {
    // The old copy said "…and only you can change it", which is false: an earlier claimant silently
    // wins a name (displayName.ts). Nothing on this step can check that — the phonebook is empty
    // until content syncs — so the step must not imply otherwise.
    const {tree} = render();
    const text = JSON.stringify(tree.toJSON());
    expect(text).not.toContain('only you can change it');
    // ...and it must not have grown a fake availability check in its place.
    expect(text).not.toMatch(/available|taken|unique|not in use/i);
  });
});
