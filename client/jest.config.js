module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // react-native-webview ships untransformed ESM; resolve it to a deterministic stub
  // before any load/transform so suites that transitively pull in RichEditor never hit
  // "Cannot use import statement outside a module" (was flaky under parallel workers and
  // reliably broken under --runInBand when the old setupFiles jest.mock lost the race).
  moduleNameMapper: {
    '^react-native-webview$': '<rootDir>/__mocks__/react-native-webview.js',
    // Same race: the clipboard package throws on its missing native module at import
    // time whenever the setupFiles jest.mock loses the registry race under parallel
    // workers (RichEditor imports it at module scope, so App/MainScreen chains hit it).
    '^@react-native-clipboard/clipboard$': '<rootDir>/__mocks__/react-native-clipboard.js',
    // reanimated deliberately has NO mapping here (Phase 4.4): tests run the REAL module with
    // its official jest support (`setUpTests()` in jest.setup.js), so animation-contract tests
    // (PictureChip.transition) can step real frames via withReanimatedTimer/advanceAnimationByTime
    // and read live values via getAnimatedStyle.
  },
  // nostr-tools and its @noble/@scure crypto deps ship ESM that Jest must transform.
  // (Verified: although nostr-tools/pure itself resolves to a prebuilt CJS bundle, it `require`s
  // its nested @noble/curves@2 / @noble/hashes@2, which are real ESM ("type":"module", `export`
  // syntax) that Node/Jest cannot parse natively — so nostr-tools must stay un-ignored to reach
  // and transform them. Dropping it from this list breaks 69 suites. Left as-is deliberately.)
  transformIgnorePatterns: [
    'node_modules/(?!(?:jest-)?(@react-native|react-native|react-native-camera-kit|@react-native-community|react-native-image-picker|react-native-reanimated|nostr-tools|@noble|@scure|@cloudflare)/)',
  ],
};
