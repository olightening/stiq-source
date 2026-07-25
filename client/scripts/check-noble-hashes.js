#!/usr/bin/env node
/**
 * Build guard: verify @noble/hashes resolves the v1 sub-paths the onboarding blind-RSA shim
 * needs (`onboarding/webcryptoShim.ts` imports `@noble/hashes/sha1` `/sha256` `/sha512`).
 *
 * WHY THIS EXISTS: nostr-tools (+ @noble/curves, @scure/bip32, @scure/bip39) depend on
 * @noble/hashes v2, which RELOCATED those sub-paths (sha256/sha512 → /sha2, sha1 → /legacy).
 * A plain `npm install` / `npm dedupe` can HOIST v2 to the top of node_modules, overriding the
 * root project's pinned v1.8.0. tsc/jest/Metro then can't resolve `@noble/hashes/sha256` and the
 * onboarding credential exchange dies at runtime (Hermes) — a broken APK that still "builds".
 *
 * The lockfile pins the correct tree (v1.8.0 at top, v2 nested under the transitive consumers).
 * `npm ci` always reproduces it; `npm install` can break it. This script catches the broken
 * state BEFORE a build ships.
 */
const REQUIRED = ['@noble/hashes/sha1', '@noble/hashes/sha256', '@noble/hashes/sha512'];

const missing = [];
for (const sub of REQUIRED) {
  try {
    require.resolve(sub);
  } catch {
    missing.push(sub);
  }
}

// Read the installed version from the package dir. `require('@noble/hashes/package.json')` fails
// on packages whose `exports` map doesn't expose ./package.json, so resolve via a known entry and
// read the manifest off disk instead.
let installed = 'unknown';
try {
  const path = require('path');
  const fs = require('fs');
  let dir;
  try {
    dir = path.dirname(require.resolve('@noble/hashes/sha256')); // v1 layout
  } catch {
    dir = path.dirname(require.resolve('@noble/hashes/sha2')); // v2 layout (the broken case)
  }
  installed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
} catch {
  /* not installed at all */
}

if (missing.length === 0) {
  console.log(`✓ @noble/hashes ${installed} resolves the blind-RSA sub-paths.`);
  process.exit(0);
}

console.error(
  '\n✗ @noble/hashes is the WRONG major for this project.\n' +
    `  Top-level @noble/hashes is ${installed}; it does not expose: ${missing.join(', ')}\n` +
    '  Onboarding (blind-RSA / webcryptoShim) will FAIL at runtime in the APK.\n\n' +
    '  CAUSE: a plain `npm install`/`npm dedupe` hoisted @noble/hashes v2 over the pinned v1.8.0.\n' +
    '  FIX (either one, run in client/):\n' +
    '      npm ci --legacy-peer-deps              # reproduce the lockfile exactly (preferred)\n' +
    '      npm install @noble/hashes@1.8.0 --legacy-peer-deps   # surgical reconcile\n' +
    '  Then re-run this check. Do NOT build the APK until it passes.\n',
);
// `--warn` (used by postinstall) surfaces the problem without failing the install itself, so a
// drift is visible the moment it happens. The build gate (`verify-deps`) omits it → hard failure.
process.exit(process.argv.includes('--warn') ? 0 : 1);
