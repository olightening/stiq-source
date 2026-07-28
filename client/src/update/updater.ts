/**
 * Updater core — fetch + verify the signed F-Droid index over Tor, enforce version monotonicity and
 * same-signer, then orchestrate the streamed APK download + user-confirmed install (T9-S4).
 *
 * SECURITY CHAIN (every link must pass or nothing is offered/installed):
 *   1. Tor-only transport. Both entry points call requireTorTransport(manager), which THROWS when Tor
 *      is offline — there is never a clearnet fallback for update bytes.
 *   2. Index signature. The index-v1.jar is streamed to disk natively and verified by
 *      native.readSignedIndex against the PINNED repo cert (`cfg.certSha256`): the JAR's signer cert
 *      SHA-256 must equal the pin, or it rejects INDEX_UNSIGNED. Only then is the JSON trusted enough
 *      to parse. A rejection is treated as "no update" (fail-safe: we never install off an
 *      unverifiable index).
 *   3. Monotonicity. pickUpdate returns only an entry whose versionCode is STRICTLY greater than the
 *      installed versionCode (read natively). A downgrade/reinstall is never a candidate.
 *   4. APK same-signer + version pin. Before install, the downloaded APK's OWN signing cert must equal
 *      the pinned APP cert (`cfg.appCertSha256` — a DISTINCT fingerprint from the repo index cert),
 *      its archive versionCode must equal the candidate's AND still be strictly newer than what is
 *      installed RIGHT NOW (re-read at install time — a stale offer cannot be replayed as a
 *      downgrade), its packageName must equal the pinned applicationId, and its SHA-256 must match
 *      the index hash (checked natively during download). Any mismatch throws; installApk is never
 *      called.
 *   5. Install is user-confirmed. native.installApk hands the APK to the OS PackageInstaller, which
 *      shows its own confirm dialog — never a silent install.
 *
 * TRUST-ANCHOR GATE (added closing audit 1.3 #2 — runs BEFORE any of the above):
 *   Both pins are pushed through {@link checkRepoPins} first. A pin that is unset, malformed, a
 *   placeholder, or names a signing key whose PRIVATE KEY IS PUBLIC is refused loudly (throws) rather
 *   than "verified" against. This matters because STIQ currently signs releases with a committed
 *   debug keystore — see UNSAFE_SIGNING_CERTS in ./pinPolicy for the full explanation and for what
 *   has to happen before in-app updates can be safely enabled.
 *
 *   Note what the `af` pin is and is NOT: it arrives in the JOIN CODE, so it commits to "the key this
 *   community says signs the app", not to "the key that signed the build you are running". A hostile
 *   invite can pin its own certificate. The only true same-signer check compares against the RUNNING
 *   build's real signing certificate, which needs a native accessor — implemented here against
 *   `appSigningCertSha256` and enforced whenever the native module provides it.
 *
 * Ship-dark: with APK_UPDATES off, or the native StiqUpdate module absent (jest / non-Android), every
 * entry point degrades to a no-op (checkForUpdate → null, downloadAndInstall → return) so nothing here
 * ever touches the network off a supported build.
 */
import {NativeModules} from 'react-native';
import {requireTorTransport, type TorManager} from '../tor';
import {base64ToBytes} from '../util/base64';
import {utf8Decode} from '../util/utf8';
import {log} from '../util/log';
import {APK_UPDATES} from '../config';
import {parseFdroidIndexJson, pickUpdate} from './fdroidIndex';
import {SHA256_HEX, checkRepoPins, isSafeApkName} from './pinPolicy';

/** Small bounded caps for the two Tor fetches. The index is tiny; the APK is the only large pull. */
const INDEX_MAX_BYTES = 2_000_000; // index-v1.jar — a signed JAR of a JSON manifest, always small
const APK_MAX_BYTES = 120_000_000; // hard ceiling on an APK download (native also enforces it)
const FETCH_TIMEOUT_MS = 120_000; // generous connect+read deadline for a multi-MB pull over Tor

/**
 * The native StiqUpdate contract (Android only). Mirrors StiqUpdateModule.kt exactly; duck-typed off
 * NativeModules so a build without the module (jest, iOS) simply has none and the updater no-ops.
 */
export interface StiqUpdateNative {
  appVersionName(): Promise<string>;
  appVersionCode(): Promise<number>;
  appPackageName(): Promise<string>;
  downloadToFile(opts: {
    url: string;
    socksHost: string;
    socksPort: number;
    socksUser: string;
    socksPass: string;
    timeoutMs: number;
    maxBytes: number;
    expectedSha256?: string;
  }): Promise<{path: string; sha256: string; size: number}>;
  /** Verifies EVERY signed entry's signer cert SHA-256 == certSha256; rejects INDEX_UNSIGNED else. */
  readSignedIndex(path: string, certSha256: string): Promise<{jsonBase64: string}>;
  verifyApkSigner(
    path: string,
    certSha256: string,
  ): Promise<{valid: boolean; versionCode: number; versionName: string; packageName: string}>;
  installApk(path: string): Promise<boolean>;
  /**
   * OPTIONAL (not yet implemented in StiqUpdateModule.kt — see NEEDED NATIVE METHOD below): the
   * lower-hex SHA-256 of the certificate that signed THE RUNNING BUILD.
   *
   * NEEDED NATIVE METHOD — the exact Kotlin to add to StiqUpdateModule:
   *
   *   @ReactMethod
   *   fun appSigningCertSha256(promise: Promise) {
   *     pool.execute {
   *       try {
   *         val ctx = reactApplicationContext
   *         val pm = ctx.packageManager
   *         val bytes: ByteArray = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
   *           val info = pm.getPackageInfo(ctx.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
   *           val si = info.signingInfo ?: throw Exception("no signingInfo")
   *           // Rotation-aware: the CURRENT signer is what an update must match.
   *           (si.apkContentsSigners?.firstOrNull() ?: throw Exception("no signer")).toByteArray()
   *         } else {
   *           @Suppress("DEPRECATION")
   *           val info = pm.getPackageInfo(ctx.packageName, PackageManager.GET_SIGNATURES)
   *           @Suppress("DEPRECATION")
   *           (info.signatures?.firstOrNull() ?: throw Exception("no signer")).toByteArray()
   *         }
   *         promise.resolve(toHex(sha256(bytes)))   // both helpers already exist in the module
   *       } catch (e: Exception) {
   *         promise.reject("SIGNER_ERROR", e.message ?: "signing cert read failed")
   *       }
   *     }
   *   }
   *
   * Note this reads the INSTALLED package, so it needs no APK parsing at all. (Deriving a signer from
   * an APK *file* would mean parsing the v2/v3 APK Signing Block, which is not viable in JS on
   * Hermes — that is why verifyApkSigner delegates to PackageManager.getPackageArchiveInfo with
   * GET_SIGNING_CERTIFICATES, letting the platform's own ApkSignatureVerifier do it.)
   */
  appSigningCertSha256?(): Promise<string>;
}

/**
 * The per-community update trust anchor, composed by the caller (AppRuntime) from the active
 * EnrolledCommunity's join-code update fields (T9-S6). All four are REQUIRED; the caller returns null
 * — and never calls into the updater — when any is missing, which is the data-driven half of the
 * ship-dark gate (a community that has not published a repo never checks for updates).
 */
export interface UpdateRepoConfig {
  /** Repo `repo` dir as an http onion URL, e.g. `http://<onion>/fdroid/repo` (no trailing slash). */
  baseUrl: string;
  /** PINNED SHA-256 (lower-hex) of the repo INDEX signing cert — verifies index-v1.jar (join `uf`). */
  certSha256: string;
  /** PINNED SHA-256 (lower-hex) of the APP signing cert — verifies the downloaded APK (join `af`). */
  appCertSha256: string;
  /** The applicationId this build is (and the only package we will install) — join `ua`. */
  applicationId: string;
}

/** The offer surfaced to the UI when a higher signed version exists. */
export interface UpdateInfo {
  versionName: string;
  versionCode: number;
  /** Absolute URL of the candidate APK under the repo. */
  apkUrl: string;
  /** Expected SHA-256 (lower-hex) of the APK, from the verified index. */
  apkSha256: string;
  /** Release changelog note ('' when the repo carried none). */
  whatChanged: string;
}

/** Duck-typed lookup of the native module, tolerant of a non-RN/absent environment (like torHttp). */
export function getNativeUpdate(): StiqUpdateNative | undefined {
  try {
    return (NativeModules as {StiqUpdate?: StiqUpdateNative}).StiqUpdate;
  } catch {
    return undefined;
  }
}

/** A per-call Tor stream-isolation tag (distinct SOCKS user/pass ⇒ distinct circuit), like torHttp. */
function randomCircuitTag(): string {
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Join a base URL and a path segment with exactly one slash. */
function joinUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

/**
 * Check the community's update repo for a higher signed version. Returns the update offer, or null
 * when: the flag is off, the native module is absent, the index signature does not match the pinned
 * repo cert, the app is not in the index, the candidate is unverifiable (non-sha256/malformed hash,
 * or an apkName that is not a plain repo-relative file), or the highest published version is not
 * newer than installed.
 *
 * THROWS when Tor is offline (Tor-only, no clearnet fallback) OR when a certificate pin is unusable
 * — unset, malformed, a placeholder, or naming a known-public signing key. The unusable-pin case is
 * deliberately a throw rather than a null: "we cannot establish trust" must be distinguishable from
 * "there is no update", or a broken anchor would look like a clean check forever.
 */
export async function checkForUpdate(
  manager: TorManager,
  cfg: UpdateRepoConfig,
  native: StiqUpdateNative | undefined = getNativeUpdate(),
): Promise<UpdateInfo | null> {
  if (!APK_UPDATES || !native) return null; // ship-dark: flag off or non-Android → no-op

  // (0) TRUST ANCHOR. Refuse before touching the network if either pin is unset, a placeholder, or a
  // known-public signing key. Thrown, not returned-null: a worthless anchor is an operator-visible
  // misconfiguration, not "no updates available", and it must never be mistaken for a clean check.
  const badPin = checkRepoPins(cfg);
  if (badPin) throw new Error(`update check refused: ${badPin}`);

  const socks = requireTorTransport(manager); // THROWS when offline — Tor-only
  const tag = randomCircuitTag();

  // (1) Stream the small signed index JAR to disk over Tor. Using downloadToFile (rather than the
  // base64 torFetch path) lets the native side verify the PKCS#7 JAR signature directly — no
  // re-parsing signed bytes in JS.
  const {path} = await native.downloadToFile({
    url: joinUrl(cfg.baseUrl, 'index-v1.jar'),
    socksHost: socks.host,
    socksPort: socks.port,
    socksUser: tag,
    socksPass: tag,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: INDEX_MAX_BYTES,
  });

  // (2) Native signature verify against the PINNED repo cert. A rejection (INDEX_UNSIGNED, or any
  // other verify failure) is fail-safe → no update offered. We deliberately do NOT rethrow: an
  // unverifiable index must look like "nothing to install", never crash the check.
  let jsonBase64: string;
  try {
    ({jsonBase64} = await native.readSignedIndex(path, cfg.certSha256));
  } catch (e) {
    log.warn('update', 'index signature verification failed; ignoring repo', e);
    return null;
  }

  const index = parseFdroidIndexJson(utf8Decode(base64ToBytes(jsonBase64)));

  // (4) Defence: the pinned applicationId MUST be what this build actually is, else a mis-issued
  // config could point us at a different package's APK. Mismatch → no update.
  // An EMPTY installed package name is not a pass — it means we could not establish what this build
  // is, so we cannot claim the repo is publishing updates for it. Fail closed.
  const installedPkg = await native.appPackageName();
  if (!installedPkg || installedPkg !== cfg.applicationId) {
    log.warn('update', `configured applicationId ${cfg.applicationId} != installed ${installedPkg || '<unknown>'}; ignoring`);
    return null;
  }

  // (3) Monotonicity: only a strictly-higher versionCode is a candidate.
  const installed = await native.appVersionCode();
  const entry = pickUpdate(index, cfg.applicationId, installed);
  if (!entry) return null;

  // The native streamed download verifies SHA-256; if the index doesn't carry a sha256 hash there is
  // nothing to pin the APK bytes to, so refuse rather than download an unverifiable file.
  if (entry.hashType !== 'sha256') {
    log.warn('update', `candidate hashType ${entry.hashType} != sha256; refusing unverifiable apk`);
    return null;
  }
  // …and it must actually LOOK like one. A truncated/garbage digest would be handed to the native
  // download as expectedSha256 and could never match, so refuse here where the reason is legible.
  if (!SHA256_HEX.test(entry.hash)) {
    log.warn('update', 'candidate hash is not a lower-hex SHA-256; refusing unverifiable apk');
    return null;
  }
  // The index signer does not get to steer the fetch out of its own repo directory (or at a
  // different host) via a crafted apkName.
  if (!isSafeApkName(entry.apkName)) {
    log.warn('update', `candidate apkName ${entry.apkName} is not a plain repo-relative .apk; refusing`);
    return null;
  }

  return {
    versionName: entry.versionName,
    versionCode: entry.versionCode,
    apkUrl: joinUrl(cfg.baseUrl, entry.apkName),
    apkSha256: entry.hash,
    whatChanged: entry.whatsNew ?? '',
  };
}

/**
 * Download the candidate APK over Tor and, only after it passes EVERY pinned check, hand it to the OS
 * installer. Throws (and never calls installApk) on: an unusable certificate pin (unset/placeholder/
 * known-public key), Tor offline, an offer that is no longer strictly newer than what is installed
 * right now (rollback), SHA-256 mismatch (native rejects during download), a signer cert that is not
 * the pinned APP cert, a signer that did not sign the RUNNING build (when the native accessor
 * exists), an archive versionCode that does not equal the offered version, or a packageName that is
 * missing or is not the pinned applicationId. No-ops with the flag off / module absent.
 */
export async function downloadAndInstall(
  manager: TorManager,
  info: UpdateInfo,
  cfg: UpdateRepoConfig,
  native: StiqUpdateNative | undefined = getNativeUpdate(),
): Promise<void> {
  if (!APK_UPDATES || !native) return; // ship-dark: flag off or non-Android → no-op

  // (0) TRUST ANCHOR, re-checked at the install boundary rather than inherited from whoever produced
  // `info`. This is the last place a worthless pin can be caught before the OS installer is invoked.
  const badPin = checkRepoPins(cfg);
  if (badPin) throw new Error(`update install refused: ${badPin}`);

  const socks = requireTorTransport(manager); // THROWS when offline — Tor-only
  const tag = randomCircuitTag();

  // (0b) ROLLBACK. `info` was produced by an earlier checkForUpdate and may be arbitrarily stale (the
  // user left the sheet open; the app already updated by another route). Re-read what is installed
  // RIGHT NOW and require the offer to still be strictly newer, so a replayed old-but-correctly-
  // signed offer can never be walked back onto the device. Checked before the download so a rollback
  // attempt costs no Tor bandwidth.
  const installedNow = await native.appVersionCode();
  if (!(info.versionCode > installedNow)) {
    throw new Error(
      `update APK versionCode ${info.versionCode} is not newer than installed ${installedNow}; refusing downgrade`,
    );
  }

  // Stream to a cache file; expectedSha256 makes the native side reject (SHA_MISMATCH) + delete the
  // file if the bytes don't match the index hash — so a swapped/corrupt APK never reaches verify.
  const {path} = await native.downloadToFile({
    url: info.apkUrl,
    socksHost: socks.host,
    socksPort: socks.port,
    socksUser: tag,
    socksPass: tag,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: APK_MAX_BYTES,
    expectedSha256: info.apkSha256,
  });

  // Same-signer pin: the APK must be signed by the SAME app key as the installed build (`af`),
  // which is a distinct fingerprint from the repo index cert (`uf`). This is what stops a validly
  // repo-signed-but-foreign APK from being installed over the running app.
  const verdict = await native.verifyApkSigner(path, cfg.appCertSha256);
  if (!verdict.valid) {
    throw new Error('update APK signer does not match the pinned app signing certificate');
  }
  // Belt-and-braces against a swapped-but-same-signer archive: the archive's own versionCode and
  // packageName must match what the verified index promised / this build is.
  if (verdict.versionCode !== info.versionCode) {
    throw new Error(
      `update APK versionCode ${verdict.versionCode} != offered ${info.versionCode}`,
    );
  }
  // An absent packageName is a failure to identify the archive, not a pass — fail closed.
  if (!verdict.packageName || verdict.packageName !== cfg.applicationId) {
    throw new Error(
      `update APK packageName ${verdict.packageName || '<unknown>'} != ${cfg.applicationId}`,
    );
  }

  // TRUE same-signer: `cfg.appCertSha256` only says what the COMMUNITY claims signs the app, and that
  // value came out of a join code. Comparing against the RUNNING build's own signing certificate is
  // the only check a hostile invite cannot satisfy by pinning its own key. Enforced whenever the
  // native module exposes the accessor; when it does not, we say so loudly rather than implying the
  // guarantee holds.
  if (typeof native.appSigningCertSha256 === 'function') {
    const runningSigner = (await native.appSigningCertSha256()).toLowerCase();
    if (!SHA256_HEX.test(runningSigner)) {
      throw new Error('could not read this build’s signing certificate; refusing to install');
    }
    if (runningSigner !== cfg.appCertSha256) {
      throw new Error(
        'update APK is pinned to a signing certificate that did not sign the running build; refusing to install',
      );
    }
  } else {
    log.warn(
      'update',
      'native appSigningCertSha256 is unavailable — the app-cert pin is being trusted as supplied by the join code, which cannot detect a hostile invite pinning its own key',
    );
  }

  // All pins passed — hand to the OS PackageInstaller (it shows the user's confirm dialog).
  await native.installApk(path);
}
