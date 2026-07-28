/**
 * Update trust-anchor policy — the fail-closed gate in front of the T9 updater's signature pins.
 *
 * The updater already pins two certificate SHA-256s (the repo index signer `uf` and the app signer
 * `af`, both carried in the join code) and verifies them natively. That machinery is sound. What it
 * did NOT do is ask whether a pin is *worth anything*, and there are three ways a structurally valid
 * pin can be worthless:
 *
 *   1. UNSET / PLACEHOLDER. A pin that is empty, the wrong length, non-hex, or a repeated single
 *      character ('00…0', 'ff…f', 'aa…a') is a stand-in someone left behind, not a key commitment.
 *      Verifying against it either always fails (confusing) or — worse — looks like it passed.
 *   2. PUBLICLY KNOWN PRIVATE KEY. Pinning a certificate whose private key anyone can download is
 *      cryptographically valid and semantically empty: the attacker just signs their APK with it and
 *      every check passes. See {@link UNSAFE_SIGNING_CERTS} — this is the fleet's situation TODAY.
 *   3. ATTACKER-CHOSEN. `af` arrives in the join code, so a hostile invite can pin the ATTACKER's own
 *      certificate and then serve APKs signed by it. Only a comparison against the RUNNING build's
 *      real signing certificate detects this; see `appSigningCertSha256` in {@link ../update/updater}.
 *
 * Everything here is pure (no native, no Tor, no RN) so the policy that decides whether an update may
 * be installed at all is fully testable off-device.
 */

/** A certificate fingerprint as the updater and the native module exchange it: lower-hex SHA-256. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * ⚠️ THE FLEET'S CURRENT SIGNING KEY IS PUBLIC — DENYLIST, NEVER AN ALLOWLIST. ⚠️
 *
 * `client/android/app/build.gradle` signs the **release** build with `signingConfigs.debug`, whose
 * `storeFile` is `client/android/app/debug.keystore` — a keystore that is **committed to the
 * repository** (and therefore present in the generated public source mirror) with the stock
 * credentials that are themselves written in build.gradle: store password `android`, alias
 * `androiddebugkey`, key password `android`.
 *
 * The consequence: the private key that signs every distributed STIQ APK can be downloaded by
 * anybody. Pinning `af` to this certificate is *cryptographically* correct and *practically* no
 * protection at all — an attacker clones the repo, signs a malicious APK with the same keystore, and
 * it satisfies every signature check the updater performs. Android's "same signer to upgrade" rule
 * does not help either, because the attacker's APK genuinely IS the same signer.
 *
 * So the updater REFUSES to run while a pin names this certificate. This entry can only ever cause a
 * rejection — it can never make an unverified build look verified, which is why hardcoding it is
 * safe (and why it must not be inverted into an "expected cert" constant).
 *
 * The fingerprint is not a secret: it is derived from a keystore that already ships publicly, and it
 * carries no operator identity. Verified with:
 *   keytool -list -v -keystore client/android/app/debug.keystore \
 *           -storepass android -alias androiddebugkey
 *   → SHA256: FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:
 *             9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C
 *
 * ── TO TURN UPDATES ON ────────────────────────────────────────────────────────────────────────
 * Create a real, offline-backed release keystore (audit 1.3 #1), sign releases with it, and publish
 * the NEW certificate's SHA-256 as the join code's `af`. Nothing here needs editing: the new
 * fingerprint simply is not on this list, and the gate opens. Do NOT delete this entry — old join
 * codes carrying the compromised pin must keep failing.
 */
export const UNSAFE_SIGNING_CERTS: ReadonlyMap<string, string> = new Map([
  [
    'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c',
    'the debug keystore committed at client/android/app/debug.keystore — its private key is public, ' +
      'so this certificate proves nothing about who built the APK',
  ],
]);

/** Why a pin was refused. `null` means the pin is structurally sound and not known-compromised. */
export type PinRejection = string | null;

/**
 * Validate ONE certificate pin. Returns null when usable, or a human-readable reason to refuse.
 *
 * A pin made of a single repeated hex digit is treated as a placeholder: a genuine SHA-256 has a
 * ~2^-250 chance of looking like that, so the false-positive risk is nil and it reliably catches the
 * '000…', 'fff…' and 'aaa…' fillers that get left in configs and fixtures.
 */
export function checkCertPin(pin: unknown, role: string): PinRejection {
  if (typeof pin !== 'string' || pin.length === 0) {
    return `${role} certificate pin is unset — refusing to verify an update against no anchor`;
  }
  if (!SHA256_HEX.test(pin)) {
    return `${role} certificate pin is not a lower-hex SHA-256 (got ${pin.length} chars) — refusing`;
  }
  if (/^(.)\1{63}$/.test(pin)) {
    return `${role} certificate pin '${pin.slice(0, 8)}…' is a placeholder, not a real fingerprint — refusing`;
  }
  const compromised = UNSAFE_SIGNING_CERTS.get(pin);
  if (compromised) {
    return `${role} certificate pin names a COMPROMISED signing key (${compromised}); refusing to install an update that this pin cannot vouch for`;
  }
  return null;
}

/** The subset of the repo config this policy inspects (kept structural to avoid an import cycle). */
export interface PinnedRepo {
  certSha256: string;
  appCertSha256: string;
}

/**
 * Gate BOTH pins before any update byte is fetched or installed. Returns the first reason to refuse,
 * or null when both anchors are usable. Callers must treat a non-null result as fatal — never as
 * "try anyway".
 */
export function checkRepoPins(cfg: PinnedRepo): PinRejection {
  return (
    checkCertPin(cfg.certSha256, 'repo index signing') ??
    checkCertPin(cfg.appCertSha256, 'app signing')
  );
}

/**
 * Is this a safe file name to append to the repo base URL?
 *
 * `apkName` comes out of the (signed) index, but the signer is not automatically trusted to stay
 * inside its own repo directory: `../../x.apk` would walk out of it server-side, and a name carrying
 * a scheme or query could retarget the fetch. Restrict to the flat `[A-Za-z0-9._-]+.apk` shape that
 * `relay/deploy/fdroid-publish.sh` actually emits (it publishes `basename "$APK_PATH"`).
 */
export function isSafeApkName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes('..') &&
    /^[A-Za-z0-9._-]+\.apk$/.test(name)
  );
}
