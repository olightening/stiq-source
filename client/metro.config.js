const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const fs = require('fs');
const path = require('path');

// When this client lives in a git worktree, node_modules is a junction to the main
// checkout. Metro rejects files resolved outside its project root, so add the junction's
// REAL target as a watch folder + module path. No-op for a normal (non-junction) checkout.
const localNodeModules = path.resolve(__dirname, 'node_modules');
const realNodeModules = fs.realpathSync(localNodeModules);
const isJunctioned = realNodeModules !== localNodeModules;

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 */
const config = {
  resolver: {
    unstable_enablePackageExports: true,
    ...(isJunctioned ? {nodeModulesPaths: [localNodeModules, realNodeModules]} : {}),
  },
  ...(isJunctioned ? {watchFolders: [realNodeModules]} : {}),
};

const merged = mergeConfig(getDefaultConfig(__dirname), config);

// Defense-in-depth (audit #54): strip every console.* call from the minified bundle so
// enrollment/DM debug logs never ship in a release build. Metro only runs the terser minifier on
// PRODUCTION bundles (release / `--dev false`), so dev logging and the bundled debug APK are
// unaffected. Merge into (not replace) the RN default terser minifierConfig so its
// mangle/output/compress defaults are preserved — mergeConfig replaces `minifierConfig` wholesale,
// so this is done by hand after the merge.
const defaultMinifier = merged.transformer.minifierConfig ?? {};
merged.transformer.minifierConfig = {
  ...defaultMinifier,
  compress: {
    ...(defaultMinifier.compress ?? {}),
    drop_console: true,
  },
};

// Never crawl or watch compiled native build outputs (android/build, .gradle, .cxx). Metro wires
// resolver.blockList into the file-map's ignore, so this keeps its crawler/watcher out of those
// volatile directories. It matters most when node_modules is a junction into a checkout that ALSO
// builds native libraries there during `assembleDebug` — otherwise Metro's Windows file watcher
// races on those dirs mid-build (fs.watch ENOENT) and crashes createBundleDebugJsAndAssets.
const ignoreNativeBuild = /[/\\](?:android[/\\]build|\.gradle|\.cxx)[/\\]/;
const existingBlockList = merged.resolver.blockList;
const blockSources = [];
if (existingBlockList instanceof RegExp) {
  blockSources.push(existingBlockList.source);
} else if (Array.isArray(existingBlockList)) {
  for (const r of existingBlockList) if (r instanceof RegExp) blockSources.push(r.source);
}
blockSources.push(ignoreNativeBuild.source);
merged.resolver.blockList = new RegExp(blockSources.join('|'));

module.exports = merged;
