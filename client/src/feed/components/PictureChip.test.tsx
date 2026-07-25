import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {PictureChip} from './PictureChip';
import {packPicture, type InlinePicture} from '../picture';
import {bytesToBase64} from '../../util/base64';

/** A tiny (2x2, 2-colour) inline picture fixture, valid enough for `decodePicture` to succeed. */
function makeInlinePicture(): InlinePicture {
  const raw = packPicture(
    {
      res: 2,
      colours: 2,
      palette: [
        [0, 0, 0],
        [255, 255, 255],
      ],
      indices: new Uint8Array([0, 1, 1, 0]),
    },
    'none',
  );
  const payloadBase64 = bytesToBase64(raw);
  return {res: 2, colours: 2, source: {kind: 'inline', payloadBase64}, weightBytes: payloadBase64.length};
}

/** Find the idle chip's root Pressable (accessibilityLabel="picture-chip") in a rendered tree. */
function findChipPressable(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  return tree.root.findByProps({accessibilityLabel: 'picture-chip'});
}

describe('PictureChip hardware-texture lifecycle (Android stage-expand)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rasterizes the stage only while the expand animation runs, then drops it once it completes', async () => {
    const picture = makeInlinePicture();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<PictureChip picture={picture} />);
    });

    // Measure the idle chip (onLayout never fires under react-test-renderer) so `load()` proceeds.
    act(() => {
      findChipPressable(tree!).props.onLayout({nativeEvent: {layout: {width: 300, height: 40, x: 0, y: 0}}});
    });

    // Tap to load: enters the expand animation.
    act(() => {
      findChipPressable(tree!).props.onPress();
    });

    // Mid-animation: the stage view should be rasterized to a hardware texture so Android can
    // cheaply re-draw the otherwise-static content while `height` is being animated.
    const stageMidAnim = tree!.root.findByProps({renderToHardwareTextureAndroid: true});
    expect(stageMidAnim).toBeTruthy();

    // Let the .38s stage-expand animation (and its completion callback) run to completion.
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Resolving the picture's bytes is now genuinely ASYNCHRONOUS (an inline source settles on the
    // microtask queue; a blob source would be a real REQ over Tor), so the load lands after the
    // synchronous animation work above. Flush it INSIDE act, or the `loaded` commit would land after
    // the test returns — against a torn-down module registry.
    await act(async () => {});

    // Once the resize settles, nothing in the tree should still be holding a hardware texture —
    // this is the exact regression: a stale rasterized layer left on after the animation, which on
    // a real Android device shows up as neighbouring feed cards staying blurry until a scroll.
    const stillRasterized = tree!.root.findAllByProps({renderToHardwareTextureAndroid: true});
    expect(stillRasterized).toHaveLength(0);
  });
});
