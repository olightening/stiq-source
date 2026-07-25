// Deterministic Jest stub for react-native-webview.
//
// The real package ships ESM that Jest doesn't transform, so any suite that
// transitively loads RichEditor would otherwise crash with "Cannot use import
// statement outside a module" whenever a setupFiles `jest.mock` lost the race
// (flaky under parallel workers, reliably broken under --runInBand). Wiring this
// stub through `moduleNameMapper` in jest.config.js resolves the module before any
// load/transform happens, so it is bulletproof in every run mode.
//
// The real WebView is typed as a plain FunctionComponent (no ref) but DOES forward one at
// runtime, exposing postMessage/injectJavaScript/requestFocus/reload/goBack. This
// stub does the same via forwardRef +
// useImperativeHandle, instead of forwarding nothing at all — a caller driving the WebView
// imperatively (RichEditor's send()) used to silently no-op against a null ref in every test.
// postMessage calls land in the module-level `__posted` array (shared because jest's
// moduleNameMapper resolves this ONE module for both the production import and a test's own
// import) so a suite can assert on RN→page bridge traffic without inventing a second mock.
const React = require('react');
const {View} = require('react-native');

const __posted = [];

const WebView = React.forwardRef(function WebView(props, ref) {
  React.useImperativeHandle(ref, () => ({
    postMessage: data => { __posted.push(data); },
    injectJavaScript: () => {},
    requestFocus: () => {},
    reload: () => {},
    goBack: () => {},
  }));
  return React.createElement(View, props, props && props.children);
});

module.exports = {
  __esModule: true,
  WebView,
  default: WebView,
  __posted,
  __resetPosted: () => { __posted.length = 0; },
};
