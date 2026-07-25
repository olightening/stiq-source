// Deterministic Jest stub for @react-native-clipboard/clipboard.
//
// The real package dereferences its native module (RNCClipboard) at import time,
// which throws under Jest. A setupFiles `jest.mock` can lose the module-registry
// race under parallel workers (same pathology as react-native-webview), so the
// stub is wired through `moduleNameMapper` in jest.config.js instead — resolved
// before any load happens, bulletproof in every run mode. Tests that assert on
// clipboard calls re-mock it locally with jest.fn (see GroupView.test.tsx).
const Clipboard = {
  getString: () => Promise.resolve(''),
  setString: () => {},
};

module.exports = {__esModule: true, default: Clipboard, useClipboard: () => ['', Clipboard.setString]};
