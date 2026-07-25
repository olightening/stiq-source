/* eslint-env jest */
// Jest environment shims for React Native native modules that have no native
// backing under Jest and would otherwise throw at import time.

// reanimated (Phase 4.4): run the REAL module under jest via its official test support — no
// /mock mapping (see jest.config.js). setUpTests() installs the js-based fake worklet runtime +
// the toHaveAnimatedStyle matcher; animations advance on the jest fake-timer clock (see
// PictureChip.transition.test.tsx for the withReanimatedTimer/advanceAnimationByTime idiom).
require('react-native-reanimated').setUpTests();

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// react-native-webview and @react-native-clipboard/clipboard are stubbed
// deterministically via moduleNameMapper (see jest.config.js) — a jest.mock here
// can lose the module-registry race under parallel workers.

// @notifee/react-native: no native module in Jest; stub to a no-op.
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  EventType: {DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2, DELIVERED: 3},
  default: {
    createChannel: jest.fn(() => Promise.resolve()),
    displayNotification: jest.fn(() => Promise.resolve('')),
    requestPermission: jest.fn(() => Promise.resolve({authorizationStatus: 1})),
    // Tap-routing surface (App.tsx registers these when notifee is present).
    // onForegroundEvent returns an unsubscribe fn — the app pushes it to cleanups.
    onForegroundEvent: jest.fn(() => () => {}),
    onBackgroundEvent: jest.fn(),
    getInitialNotification: jest.fn(() => Promise.resolve(null)),
  },
}));

// react-native-camera-kit: stub out the native camera component (no native module in Jest).
jest.mock('react-native-camera-kit', () => {
  const React = require('react');
  const {View} = require('react-native');
  return {
    __esModule: true,
    Camera: props => React.createElement(View, props, props && props.children),
    CameraType: {Back: 'back', Front: 'front'},
  };
});

// react-native-svg: render every primitive as a plain View so layout-free tests pass.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const {View} = require('react-native');
  const make = name => props => React.createElement(View, props, props && props.children);
  const Svg = make('Svg');
  return new Proxy(
    {__esModule: true, default: Svg},
    {get: (target, key) => (key in target ? target[key] : make(String(key)))},
  );
});
