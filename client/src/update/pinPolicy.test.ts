/**
 * Update trust-anchor policy — the fail-closed gate (audit 1.3 #2).
 *
 * These tests are written against the ATTACKS, not the happy path: a placeholder pin, a pin naming a
 * signing key whose private key is public, and an apkName that tries to steer the fetch out of the
 * repo directory. The one "legitimate" case exists only to prove the gate is not vacuously closed.
 */
import {
  SHA256_HEX,
  UNSAFE_SIGNING_CERTS,
  checkCertPin,
  checkRepoPins,
  isSafeApkName,
} from './pinPolicy';

/** A plausible real fingerprint: 64 lower-hex chars that are not all the same digit. */
const GOOD_REPO_CERT = '3f9a1c07be24d85f0a7719c6b3e5d248fa0c91b6e7d34a25c8f10b9e6d2a4738';
const GOOD_APP_CERT = 'c1d4e70b2a9f635817ce0d4ab8f2916075e3c8d1a460b9f27350ecab18d6f294';

/** The committed debug keystore's certificate — the fleet's CURRENT, publicly-signable identity. */
const PUBLIC_DEBUG_CERT = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

describe('checkCertPin — an unusable anchor must fail CLOSED', () => {
  it('refuses an unset pin rather than verifying against nothing', () => {
    expect(checkCertPin('', 'app signing')).toMatch(/unset/i);
    expect(checkCertPin(undefined, 'app signing')).toMatch(/unset/i);
    expect(checkCertPin(null, 'app signing')).toMatch(/unset/i);
  });

  it('refuses a malformed pin (wrong length, uppercase, non-hex)', () => {
    expect(checkCertPin('abc123', 'app signing')).toMatch(/lower-hex/i);
    expect(checkCertPin(GOOD_APP_CERT.toUpperCase(), 'app signing')).toMatch(/lower-hex/i);
    expect(checkCertPin('z'.repeat(64), 'app signing')).toMatch(/lower-hex/i);
    expect(checkCertPin(`${GOOD_APP_CERT}0`, 'app signing')).toMatch(/lower-hex/i);
  });

  it('refuses placeholder fingerprints that are structurally valid hex', () => {
    // These are exactly the values that get left behind in a config or a fixture.
    for (const filler of ['0', 'f', 'a', '1']) {
      const pin = filler.repeat(64);
      expect(SHA256_HEX.test(pin)).toBe(true); // structurally a valid SHA-256…
      expect(checkCertPin(pin, 'app signing')).toMatch(/placeholder/i); // …but still refused
    }
  });

  it('ATTACK: refuses a pin naming a signing key whose private key is public', () => {
    // The debug keystore is committed to the repo with stock credentials, so anyone can produce an
    // APK that satisfies this pin. Cryptographically valid, practically worthless → must be refused.
    const reason = checkCertPin(PUBLIC_DEBUG_CERT, 'app signing');
    expect(reason).toMatch(/COMPROMISED/);
    expect(reason).toMatch(/debug\.keystore/);
  });

  it('accepts a well-formed fingerprint that is not on the denylist', () => {
    expect(checkCertPin(GOOD_APP_CERT, 'app signing')).toBeNull();
  });

  it('the denylist is a denylist — every entry carries a reason and is a valid fingerprint', () => {
    expect(UNSAFE_SIGNING_CERTS.size).toBeGreaterThan(0);
    for (const [pin, why] of UNSAFE_SIGNING_CERTS) {
      expect(SHA256_HEX.test(pin)).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});

describe('checkRepoPins — BOTH anchors are gated', () => {
  it('passes only when both pins are usable', () => {
    expect(checkRepoPins({certSha256: GOOD_REPO_CERT, appCertSha256: GOOD_APP_CERT})).toBeNull();
  });

  it('refuses when the INDEX pin is compromised (forged index ⇒ forged everything)', () => {
    const reason = checkRepoPins({certSha256: PUBLIC_DEBUG_CERT, appCertSha256: GOOD_APP_CERT});
    expect(reason).toMatch(/repo index signing/);
    expect(reason).toMatch(/COMPROMISED/);
  });

  it('refuses when the APP pin is compromised', () => {
    const reason = checkRepoPins({certSha256: GOOD_REPO_CERT, appCertSha256: PUBLIC_DEBUG_CERT});
    expect(reason).toMatch(/app signing/);
    expect(reason).toMatch(/COMPROMISED/);
  });

  it('refuses when either pin is unset', () => {
    expect(checkRepoPins({certSha256: '', appCertSha256: GOOD_APP_CERT})).toMatch(/unset/i);
    expect(checkRepoPins({certSha256: GOOD_REPO_CERT, appCertSha256: ''})).toMatch(/unset/i);
  });
});

describe('isSafeApkName — the signed index may not steer the fetch off-repo', () => {
  it('accepts the flat names the publish script actually emits', () => {
    expect(isSafeApkName('app-arm64-v8a-release.apk')).toBe(true);
    expect(isSafeApkName('com.stiq.client_7.apk')).toBe(true);
  });

  it('ATTACK: rejects traversal, absolute paths and embedded URLs', () => {
    expect(isSafeApkName('../../evil.apk')).toBe(false);
    expect(isSafeApkName('/etc/evil.apk')).toBe(false);
    expect(isSafeApkName('sub/dir/evil.apk')).toBe(false);
    expect(isSafeApkName('http://elsewhere.example/evil.apk')).toBe(false);
    expect(isSafeApkName('good.apk?x=../../evil.apk')).toBe(false);
    expect(isSafeApkName('good.apk#/../evil.apk')).toBe(false);
  });

  it('rejects non-apk, empty and absurdly long names', () => {
    expect(isSafeApkName('')).toBe(false);
    expect(isSafeApkName('index-v1.jar')).toBe(false);
    expect(isSafeApkName(undefined)).toBe(false);
    expect(isSafeApkName(`${'a'.repeat(200)}.apk`)).toBe(false);
  });
});
