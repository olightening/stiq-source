module.exports = {
  presets: ['@react-native/babel-preset'],
  // react-native-reanimated/plugin MUST stay the last plugin (it rewrites worklets
  // after every other transform has run — reanimated hard-requires this ordering).
  plugins: ['react-native-reanimated/plugin'],
};
