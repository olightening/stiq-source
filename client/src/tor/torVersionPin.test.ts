/**
 * Version-currency guard (A4) — pins the bundled Tor daemon's SHIPPED version to actual disk state,
 * not a copy-pasted string here. Reads `android/app/build.gradle`, `ios/Podfile` AND the RESOLVED
 * `ios/Podfile.lock` straight off disk and asserts each pinned version is >=
 * {@link TOR_MIN_SUPPORTED_VERSION} via the SAME comparator the runtime warn-only guard uses
 * (torVersion.ts) — so a future bump to ONE of "the shipped pin" / "the supported floor" without
 * the other fails this test instead of silently drifting back toward the 2026-07-10 tor-0.4.6.10
 * EOL outage (5 days of dark onions — see the stiq-tor-eol-consensus-outage handoff): both
 * build.gradle and the Podfile carry a "RE-VERIFY BY 2027-01-12" comment making the same point
 * next to each pin. The lock check matters because iOS has NO runtime version check (Android's is
 * itself warn-only): the Podfile pin is a `~>` CONSTRAINT, while Podfile.lock names the exact pod
 * version that actually ships in the binary.
 */
import * as fs from 'fs';
import * as path from 'path';
import {TOR_MIN_SUPPORTED_VERSION, torVersionAtLeast} from './torVersion';

const BUILD_GRADLE_PATH = path.join(__dirname, '../../android/app/build.gradle');
const PODFILE_PATH = path.join(__dirname, '../../ios/Podfile');
const PODFILE_LOCK_PATH = path.join(__dirname, '../../ios/Podfile.lock');

function readAndroidTorPin(): string {
  const gradle = fs.readFileSync(BUILD_GRADLE_PATH, 'utf8');
  const m = /info\.guardianproject:tor-android:([0-9]+(?:\.[0-9]+){2,3})/.exec(gradle);
  if (!m) {
    throw new Error(
      `torVersionPin: could not find the info.guardianproject:tor-android version pin in ${BUILD_GRADLE_PATH}`,
    );
  }
  return m[1]!;
}

function readIosTorPodPin(): string {
  const podfile = fs.readFileSync(PODFILE_PATH, 'utf8');
  const m = /pod\s+'Tor',\s*'~>\s*([0-9]+(?:\.[0-9]+)*)'/.exec(podfile);
  if (!m) {
    throw new Error(`torVersionPin: could not find the 'Tor' pod version pin in ${PODFILE_PATH}`);
  }
  return m[1]!;
}

/**
 * The RESOLVED Tor pod version from Podfile.lock's PODS list (`- Tor (409.10.1):`). This is what
 * the shipped binary actually bundles — the Podfile's `~>` is only a constraint on it.
 */
function readIosResolvedTorPodVersion(): string {
  const lock = fs.readFileSync(PODFILE_LOCK_PATH, 'utf8');
  const m = /^\s*- Tor \(([0-9]+(?:\.[0-9]+)*)\):/m.exec(lock);
  if (!m) {
    throw new Error(
      `torVersionPin: could not find the resolved 'Tor' pod version in ${PODFILE_LOCK_PATH}`,
    );
  }
  return m[1]!;
}

/**
 * iCepa's Tor.framework CocoaPod version ENCODES the upstream tor release as `4XX.Y[.Z]` → tor
 * `0.4.XX.Y` (Z is the pod's own patch level, not part of the tor version). Verified against the
 * pod's own README, which states pod 409.10.1 bundles tor 0.4.9.10 — matching the Podfile's
 * adjacent comment "tor 0.4.9.x". This is NOT a general CocoaPods convention, so it is asserted
 * NARROWLY: only the `4XX.Y[.Z]` shape of the documented encoding is mapped (a future tor 0.5.x
 * era pod would presumably be `5XX...` and must be re-verified); anything else returns null so
 * the caller can skip the check instead of asserting a guessed mapping. A correct, narrow,
 * non-flaky check beats a broader one that might silently mis-map a future pin format.
 */
function icepaPinToTorVersion(pin: string): string | null {
  const m = /^4([0-9]{2})\.([0-9]+)(?:\.[0-9]+)?$/.exec(pin);
  return m ? `0.4.${Number(m[1])}.${m[2]}` : null;
}

describe('torVersionPin (A4 version-currency guard)', () => {
  it('the Android bundled tor-android pin is >= TOR_MIN_SUPPORTED_VERSION', () => {
    const pin = readAndroidTorPin();
    expect(torVersionAtLeast(pin, TOR_MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it('the iOS Tor pod pin maps to a tor version >= TOR_MIN_SUPPORTED_VERSION (loose — see icepaPinToTorVersion)', () => {
    const pin = readIosTorPodPin();
    const mapped = icepaPinToTorVersion(pin);
    if (mapped === null) {
      // The pin no longer matches the one known-good iCepa encoding this test understands. Rather
      // than assert a guessed mapping (flaky/wrong), flag it for manual re-verification and let the
      // Android assertion above stay the strict enforcement point.
      console.warn(
        `torVersionPin: iOS pod pin "${pin}" doesn't match the known iCepa "4XX.Y" encoding — ` +
          're-verify the iOS Tor version manually; skipping the mapped version assertion.',
      );
      return;
    }
    expect(torVersionAtLeast(mapped, TOR_MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it('the RESOLVED iOS Tor pod (Podfile.lock) maps to a tor version >= TOR_MIN_SUPPORTED_VERSION', () => {
    const resolved = readIosResolvedTorPodVersion();
    const mapped = icepaPinToTorVersion(resolved);
    if (mapped === null) {
      // Same escape hatch as the Podfile check: never assert a guessed mapping.
      console.warn(
        `torVersionPin: resolved iOS pod version "${resolved}" doesn't match the known iCepa ` +
          '"4XX.Y[.Z]" encoding — re-verify the iOS Tor version manually; skipping.',
      );
      return;
    }
    expect(torVersionAtLeast(mapped, TOR_MIN_SUPPORTED_VERSION)).toBe(true);
  });

  // The guard's failure mode, kept as a durable in-memory proof (never mutates the real Podfile):
  // a hypothetical sub-floor pin MUST map and MUST be rejected by the same comparator the real
  // assertions above use. If either half breaks (mapping regressions, a fail-open comparator
  // change), the guard has silently stopped guarding — this is the test for the test.
  it('a sub-floor iCepa pin would FAIL the floor check (guard actually rejects)', () => {
    // tor 0.4.7.13 — a real pre-PoW release below the 0.4.8 floor (iCepa encoding "407.13").
    expect(icepaPinToTorVersion('407.13')).toBe('0.4.7.13');
    expect(icepaPinToTorVersion('407.13.1')).toBe('0.4.7.13');
    expect(torVersionAtLeast('0.4.7.13', TOR_MIN_SUPPORTED_VERSION)).toBe(false);
  });

  it('the documented encoding maps the shipped pin exactly (README: pod 409.10.1 = tor 0.4.9.10)', () => {
    expect(icepaPinToTorVersion('409.10.1')).toBe('0.4.9.10');
    expect(icepaPinToTorVersion('409.10')).toBe('0.4.9.10');
    // Out-of-family shapes must NOT be guessed at (null → the loose checks skip, never mis-map).
    expect(icepaPinToTorVersion('5.0.1')).toBeNull();
    expect(icepaPinToTorVersion('510.2')).toBeNull();
  });
});
