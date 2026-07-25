/**
 * THE BUG (user, verbatim): "when a lazy-load picture card is clicked, the card dissappears and
 * nothing appears in its place for a moment, I don't want that to happen, not even for this moment,
 * I think the card should expand into the preview card with a loading circle that's loading the
 * picture from tor".
 *
 * "Not even for this moment" is the bar, so these tests are written against FRAMES, not endpoints.
 * The old component had two render branches — an idle chip, and a stage whose animated height started
 * at ZERO — and the tap swapped one for the other. Every assertion here is designed to fail against
 * that shape:
 *
 *   • the frame is sampled at EVERY animation frame from the tap onwards, and must never be empty,
 *     never be shorter than the chip it grew from, and never move backwards;
 *   • the chip's face must still be painted at the instant the stage takes over, so there is no frame
 *     where neither is on screen.
 *
 * A "frame" here is one `requestAnimationFrame` tick, which reanimated's jest runtime drives off
 * the fake-timer queue (its rAF is timer-backed; see setUpTests in jest.setup.js) — so advancing
 * the fake clock 16ms at a time genuinely steps the tween, and `getAnimatedStyle` reads the height
 * that would have been committed to the view (the jestAnimatedStyle side-channel the real module
 * maintains under jest for exactly this purpose).
 */
import 'react-native';
import React from 'react';
import {getAnimatedStyle} from 'react-native-reanimated';
import renderer, {act} from 'react-test-renderer';
import {PictureChip} from './PictureChip';
import {encodeInlinePicture, extractInlinePictures, type InlinePicture} from '../picture';
import {setMediaBlobService} from '../../media/mediaBlobService';
import {clearRenderedMedia} from '../../media/renderedMediaCache';

const PIXELS = {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])};
/** A DIFFERENT picture. The pixels must differ, not just the label: an inline source's identity IS
 *  its payload (`mediaSourceKey`), and the label rides in the token metadata, not the bytes. */
const OTHER_PIXELS = {...PIXELS, indices: new Uint8Array([1, 0, 0, 1])};

/** The chip's measured box, as reported to `onLayout`. A real chip is ~54pt tall in a ~300pt row. */
const CHIP_W = 300;
const CHIP_H = 54;

function inlinePicture(): InlinePicture {
  return extractInlinePictures(encodeInlinePicture(PIXELS, 'none', 'cat'))[0]!;
}

function mount(picture: InlinePicture): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<PictureChip picture={picture} />);
  });
  act(() => {
    tree!.root
      .findByProps({accessibilityLabel: 'picture-chip'})
      .props.onLayout({nativeEvent: {layout: {width: CHIP_W, height: CHIP_H, x: 0, y: 0}}});
  });
  return tree!;
}

/**
 * Tap, and let the load settle as far as it can WITHOUT advancing the clock. For an inline picture
 * that means it is already decoded before a single animation frame has run — which is the real
 * device behaviour, and the hardest case for this component: the bytes land while the frame is still
 * mid-expansion, so the transition has to absorb them without a hitch.
 */
async function tap(tree: renderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.root.findByProps({accessibilityLabel: 'picture-chip'}).props.onPress();
  });
}

/**
 * The one frame that must never go away. Found structurally — by the node carrying the animated
 * height — rather than by a test-only label, so a refactor that re-splits the tree cannot quietly
 * satisfy this by relabelling something else.
 */
function frame(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  // `typeof n.type === 'string'` keeps this to HOST nodes — the composite Animated.View forwards the
  // same prop, and matching both would make the "exactly one frame" check meaningless.
  const hits = tree.root.findAll(n => typeof n.type === 'string' && n.props.renderToHardwareTextureAndroid !== undefined);
  expect(hits).toHaveLength(1); // exactly one frame, always
  return hits[0]!;
}

/** The height the frame is actually painted at this instant: the live animated value (via
 * reanimated's jest side-channel), or — while resting at height:auto — the chip's own. */
function frameHeight(tree: renderer.ReactTestRenderer): number {
  const h = (getAnimatedStyle(frame(tree)) as {height?: unknown}).height;
  if (h === undefined || h === null) return CHIP_H; // resting: height is auto, i.e. the chip's
  return Number(h);
}

/** Is anything at all painted inside the frame? The chip's face and/or the stage. */
function facesOn(tree: renderer.ReactTestRenderer): {chip: number; stage: boolean} {
  // The chip face's HOST node — the nearest ancestor of the chip Press that carries a style. With
  // reanimated, that host holds the jestAnimatedStyle side-channel getAnimatedStyle reads.
  let chipLayer = tree.root.findAllByProps({accessibilityLabel: 'picture-chip'})[0]!.parent!;
  while (chipLayer.props.style === undefined && chipLayer.parent) chipLayer = chipLayer.parent;
  const opacity = (getAnimatedStyle(chipLayer) as {opacity?: unknown}).opacity;
  return {
    chip: Number(opacity ?? 1),
    stage: tree.root.findAllByProps({accessibilityLabel: 'picture-stage'}).length > 0,
  };
}

/** Step one 16ms animation frame. */
function step(): void {
  act(() => {
    jest.advanceTimersByTime(16);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  setMediaBlobService(null);
});
afterEach(() => {
  jest.useRealTimers();
  setMediaBlobService(null);
});

describe('the card expands into the preview — with no blank frame, not even for a moment', () => {
  it('never renders the frame empty, shorter than the chip, or shrinking, at any frame of the tap', async () => {
    const tree = mount(inlinePicture());
    expect(frameHeight(tree)).toBe(CHIP_H);

    await tap(tree);

    // THE ASSERTION THE BUG FAILS. The old code mounted the stage at height 0 and grew from there:
    // the very first sample below would read 0 (< CHIP_H) with the chip already unmounted. Sample
    // every frame across the whole .38s expansion plus slack.
    let previous = 0;
    for (let elapsed = 0; elapsed <= 480; elapsed += 16) {
      const h = frameHeight(tree);
      expect(h).toBeGreaterThanOrEqual(CHIP_H); // the footprint never collapses…
      expect(h).toBeGreaterThanOrEqual(previous); // …and never goes backwards
      expect(h).toBeLessThanOrEqual(CHIP_W);

      // …and something is always painted in it: the chip's face, the stage, or both mid-cross-fade.
      const {chip, stage} = facesOn(tree);
      expect(chip > 0 || stage).toBe(true);

      previous = h;
      step();
    }

    // It arrives at the square the design asks for.
    expect(frameHeight(tree)).toBe(CHIP_W);
  });

  it('holds the chip’s face on screen while the stage takes over, so the hand-off is a cross-fade', async () => {
    const tree = mount(inlinePicture());
    await tap(tree);

    // The instant the stage appears, the chip it grew out of is still painted over it — there is no
    // commit in which the chip has gone and the stage has not yet arrived. That commit was the bug.
    const {chip, stage} = facesOn(tree);
    expect(stage).toBe(true);
    expect(chip).toBe(1);

    // And by the end of the expansion the hand-off is complete.
    act(() => {
      jest.advanceTimersByTime(480);
    });
    expect(facesOn(tree).chip).toBe(0);
    expect(facesOn(tree).stage).toBe(true);
  });

  it('starts the expansion from the chip’s MEASURED height, not from zero', async () => {
    // The mechanism, pinned directly: whatever the chip measured is where the tween begins. A stage
    // that starts anywhere else is a jump, and starting at 0 is the original blank.
    const tree = mount(inlinePicture());
    await tap(tree);
    expect(frameHeight(tree)).toBe(CHIP_H);
  });

  it('does nothing at all on a tap before the chip has been measured — rather than blanking it', async () => {
    // No measurement means no honest height to grow from. The card must simply stay a chip; it must
    // never expand from an assumed (or zero) height.
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<PictureChip picture={inlinePicture()} />);
    });
    await tap(tree!);
    expect(tree!.root.findAllByProps({accessibilityLabel: 'picture-stage'})).toHaveLength(0);
    expect(frameHeight(tree!)).toBe(CHIP_H);
  });
});

describe('a reset that is not a gesture on this card', () => {
  it('collapses back to the chip when Settings clears the rendered-media cache', async () => {
    // This used to be wired to a `subscribeRenderedMedia` subscription of the chip's own, alongside
    // the hook's. It is now driven off the hook's `idle` state — the ONE place that decides a card
    // has no artifact — so the animation cannot disagree with the load about what is on screen.
    const tree = mount(inlinePicture());
    await tap(tree);
    act(() => {
      jest.advanceTimersByTime(480);
    });
    expect(facesOn(tree).stage).toBe(true);

    act(() => {
      clearRenderedMedia();
    });

    // Snapped, not narrated — and back to exactly the chip, at exactly its height.
    expect(facesOn(tree).stage).toBe(false);
    expect(facesOn(tree).chip).toBe(1);
    expect(frameHeight(tree)).toBe(CHIP_H);
  });

  it('collapses when the row is recycled onto a different picture — which the old wiring missed', async () => {
    // A FlatList row re-used for another picture resets the shared hook to `idle`, but the chip's own
    // cache subscription never fired for it: the frame kept a stale expanded height, so the NEXT tap
    // "expanded" from the square to the square — i.e. snapped open with no transition at all.
    const tree = mount(inlinePicture());
    await tap(tree);
    act(() => {
      jest.advanceTimersByTime(480);
    });
    expect(frameHeight(tree)).toBe(CHIP_W);

    act(() => {
      tree.update(<PictureChip picture={extractInlinePictures(encodeInlinePicture(OTHER_PIXELS, 'none', 'dog'))[0]!} />);
    });

    expect(facesOn(tree).stage).toBe(false);
    expect(frameHeight(tree)).toBe(CHIP_H); // ready to grow again, from the chip
  });
});

describe('the retreat from a failure is continuous too', () => {
  it('never leaves the frame empty or below the chip while collapsing, and lands back on the chip', async () => {
    // No blob service bound ⇒ a blob-backed picture fails 'offline' the instant it is tapped: the
    // expansion and the retreat overlap, which is the nastiest ordering there is.
    const [picture] = extractInlinePictures('[[pic:2;2;l=cat;w=64;STIQBLOB' + 'a'.repeat(64) + ']]');
    const tree = mount(picture!);
    await tap(tree);

    for (let elapsed = 0; elapsed <= 400; elapsed += 16) {
      expect(frameHeight(tree)).toBeGreaterThanOrEqual(CHIP_H);
      const {chip, stage} = facesOn(tree);
      expect(chip > 0 || stage).toBe(true);
      step();
    }

    // Back to a chip that says what happened, at exactly the height it started from.
    expect(frameHeight(tree)).toBe(CHIP_H);
    expect(tree.root.findAllByProps({accessibilityLabel: 'picture-stage'})).toHaveLength(0);
    expect(facesOn(tree).chip).toBe(1);
  });
});
