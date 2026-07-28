/**
 * updater core — fetch+verify index, monotonicity, same-signer, orchestrate download/install (T9-S4).
 *
 * Driven by a FakeStiqUpdateNative (records calls, scriptable rejects) + a fake TorManager (online /
 * offline via getSocksProxy). The APK_UPDATES flag is flipped per-suite with jest.doMock('../config')
 * (the established ship-dark test pattern, cf. sqliteStore COMPACTION_V2) so we can exercise both the
 * flag-off no-op and the real verification chain.
 */
import type {TorManager} from '../tor';
import type {
  StiqUpdateNative,
  UpdateRepoConfig,
  checkForUpdate as CheckForUpdate,
  downloadAndInstall as DownloadAndInstall,
} from './updater';

// The first RN transform can exceed Jest's 5s default on a cold cache (the module pulls in RN).
jest.setTimeout(20000);

const onlineManager = {getSocksProxy: () => ({host: '127.0.0.1', port: 9050})} as unknown as TorManager;
const offlineManager = {getSocksProxy: () => null} as unknown as TorManager;

const APP = 'com.stiq.client';
// Realistic fingerprints. These deliberately are NOT 'aaa…'/'bbb…' any more: the trust-anchor gate
// now rejects a repeated-digit pin as a placeholder, which is the whole point of it.
const REPO_CERT = '3f9a1c07be24d85f0a7719c6b3e5d248fa0c91b6e7d34a25c8f10b9e6d2a4738';
const APP_CERT = 'c1d4e70b2a9f635817ce0d4ab8f2916075e3c8d1a460b9f27350ecab18d6f294';
/** The committed debug keystore's cert — publicly signable, therefore a worthless anchor. */
const PUBLIC_DEBUG_CERT = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
/** Full-length candidate digests (a short 'bb22' is no longer accepted as a sha256). */
const APK_SHA_V2 = '9b7d41e0c6a2358f10de74b9c3f6082a5d1e94c7b8236f5104ade7c9b61f302d';
const APK_SHA_V1 = '2e5c8a190fb37d64e0a951cc7b28d403f6194ae82c05db73f9a1e6470c8b52da';

const CFG: UpdateRepoConfig = {
  baseUrl: 'http://relayonion.onion/fdroid/repo',
  certSha256: REPO_CERT,
  appCertSha256: APP_CERT,
  applicationId: APP,
};

function indexJson(entries: Array<{vc: number; apk: string; hash: string; hashType?: string; whatsNew?: string}>): string {
  return JSON.stringify({
    repo: {name: 'stiq'},
    packages: {
      [APP]: entries.map(e => ({
        versionName: String(e.vc),
        versionCode: e.vc,
        apkName: e.apk,
        hash: e.hash,
        hashType: e.hashType ?? 'sha256',
        ...(e.whatsNew ? {whatsNew: e.whatsNew} : {}),
      })),
    },
  });
}

interface Script {
  installedVersionCode?: number;
  packageName?: string;
  indexJson?: string;
  readSignedIndexRejects?: boolean; // simulate a cert-pin mismatch → INDEX_UNSIGNED
  downloadRejectsWith?: string; // simulate SHA_MISMATCH on the APK download
  verify?: {valid: boolean; versionCode: number; versionName: string; packageName: string};
  /** When set, the fake native exposes appSigningCertSha256 returning this (the RUNNING build's key). */
  runningSignerCert?: string;
}

type Call = {method: string; args: unknown[]};

function makeNative(script: Script): StiqUpdateNative & {calls: Call[]} {
  const calls: Call[] = [];
  const rec = (method: string, ...args: unknown[]): void => {
    calls.push({method, args});
  };
  let downloads = 0;
  return {
    calls,
    // Only present when the script asks for it — mirrors the real module, where this accessor does
    // not exist yet and the updater must degrade rather than crash.
    ...(script.runningSignerCert !== undefined
      ? {
          appSigningCertSha256: async (): Promise<string> => {
            rec('appSigningCertSha256');
            return script.runningSignerCert!;
          },
        }
      : {}),
    async appVersionName() {
      return '1.0';
    },
    async appVersionCode() {
      rec('appVersionCode');
      return script.installedVersionCode ?? 1;
    },
    async appPackageName() {
      rec('appPackageName');
      return script.packageName ?? APP;
    },
    async downloadToFile(opts) {
      rec('downloadToFile', opts);
      downloads++;
      // First download is the index jar; a later one (with expectedSha256) is the APK.
      if (opts.expectedSha256 && script.downloadRejectsWith) {
        throw new Error(script.downloadRejectsWith);
      }
      return {path: `/cache/updates/dl_${downloads}`, sha256: opts.expectedSha256 ?? 'ff', size: 10};
    },
    async readSignedIndex(path, certSha256) {
      rec('readSignedIndex', path, certSha256);
      if (script.readSignedIndexRejects) throw new Error('INDEX_UNSIGNED');
      const json = script.indexJson ?? indexJson([{vc: 1, apk: 'a.apk', hash: APK_SHA_V1}]);
      return {jsonBase64: Buffer.from(json, 'utf8').toString('base64')};
    },
    async verifyApkSigner(path, certSha256) {
      rec('verifyApkSigner', path, certSha256);
      return script.verify ?? {valid: true, versionCode: 2, versionName: '1.1', packageName: APP};
    },
    async installApk(path) {
      rec('installApk', path);
      return true;
    },
  };
}

function loadUpdater(apkUpdates: boolean): {
  checkForUpdate: typeof CheckForUpdate;
  downloadAndInstall: typeof DownloadAndInstall;
} {
  jest.resetModules();
  jest.doMock('../config', () => ({...jest.requireActual('../config'), APK_UPDATES: apkUpdates}));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./updater') as typeof import('./updater');
}

afterEach(() => {
  jest.dontMock('../config');
  jest.resetModules();
});

describe('checkForUpdate — ship-dark gates', () => {
  it('no-ops (returns null, no network) when APK_UPDATES is off', async () => {
    const {checkForUpdate} = loadUpdater(false);
    const native = makeNative({indexJson: indexJson([{vc: 9, apk: 'x.apk', hash: APK_SHA_V2}])});
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
    expect(native.calls).toHaveLength(0); // never touched the index
  });

  it('no-ops when the native module is absent', async () => {
    const {checkForUpdate} = loadUpdater(true);
    expect(await checkForUpdate(onlineManager, CFG, undefined)).toBeNull();
  });

  it('throws when Tor is offline (Tor-only, no clearnet fallback)', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({});
    await expect(checkForUpdate(offlineManager, CFG, native)).rejects.toThrow(/offline/i);
    expect(native.calls).toHaveLength(0);
  });
});

describe('checkForUpdate — verification chain', () => {
  it('returns null when the index signer cert != the pinned repo cert', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({readSignedIndexRejects: true, installedVersionCode: 1});
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
    // It verified against the PINNED repo cert, then bailed before reading version info.
    expect(native.calls.find(c => c.method === 'readSignedIndex')?.args[1]).toBe(REPO_CERT);
    expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
  });

  it('returns a valid UpdateInfo for a strictly-newer signed version', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      installedVersionCode: 1,
      indexJson: indexJson([
        {vc: 1, apk: 'stiq_1.apk', hash: APK_SHA_V1},
        {vc: 2, apk: 'stiq_2.apk', hash: APK_SHA_V2, whatsNew: 'adds dark mode'},
      ]),
    });
    const info = await checkForUpdate(onlineManager, CFG, native);
    expect(info).toEqual({
      versionName: '2',
      versionCode: 2,
      apkUrl: 'http://relayonion.onion/fdroid/repo/stiq_2.apk',
      apkSha256: APK_SHA_V2,
      whatChanged: 'adds dark mode',
    });
  });

  it('returns null when the repo max is not newer than installed (monotonicity)', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      installedVersionCode: 2,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: APK_SHA_V2}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });

  it('returns null when the candidate hash is not sha256 (unverifiable APK)', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      installedVersionCode: 1,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: APK_SHA_V2, hashType: 'md5'}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });

  it('returns null when the pinned applicationId is not what this build is', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      packageName: 'com.evil.app',
      installedVersionCode: 1,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: APK_SHA_V2}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });
});

describe('downloadAndInstall — same-signer + version pins', () => {
  const INFO = {
    versionName: '1.1',
    versionCode: 2,
    apkUrl: 'http://relayonion.onion/fdroid/repo/stiq_2.apk',
    apkSha256: APK_SHA_V2,
    whatChanged: 'adds dark mode',
  };

  it('installs only after the APK passes the pinned app-cert + versionCode checks', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP}});
    await downloadAndInstall(onlineManager, INFO, CFG, native);
    // Downloaded with the index sha as expectedSha256, verified against the APP cert, then installed.
    const dl = native.calls.find(c => c.method === 'downloadToFile')!.args[0] as {expectedSha256?: string};
    expect(dl.expectedSha256).toBe(APK_SHA_V2);
    expect(native.calls.find(c => c.method === 'verifyApkSigner')?.args[1]).toBe(APP_CERT);
    expect(native.calls.some(c => c.method === 'installApk')).toBe(true);
  });

  it('throws and never installs when the APK signer != the pinned app cert', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({verify: {valid: false, versionCode: 2, versionName: '1.1', packageName: APP}});
    await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(/signer/i);
    expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
  });

  it('throws and never installs when the archive versionCode != the offered version', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({verify: {valid: true, versionCode: 99, versionName: '9', packageName: APP}});
    await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(/versionCode/i);
    expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
  });

  it('throws and never verifies/installs when the download SHA-256 mismatches', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({downloadRejectsWith: 'SHA_MISMATCH'});
    await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(/SHA_MISMATCH/);
    expect(native.calls.some(c => c.method === 'verifyApkSigner')).toBe(false);
    expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
  });

  it('throws when Tor is offline', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({});
    await expect(downloadAndInstall(offlineManager, INFO, CFG, native)).rejects.toThrow(/offline/i);
    expect(native.calls).toHaveLength(0);
  });

  it('no-ops (no download, no install) when APK_UPDATES is off', async () => {
    const {downloadAndInstall} = loadUpdater(false);
    const native = makeNative({});
    await downloadAndInstall(onlineManager, INFO, CFG, native);
    expect(native.calls).toHaveLength(0);
  });
});

/**
 * ATTACK SUITE (audit 1.3 #2). Each case is an adversary who has already won some ground — they
 * control the update host, or wrote the join code, or replayed an old-but-genuinely-signed release —
 * and each must still end with installApk never being called.
 */
describe('update pinning — attacks', () => {
  const INFO = {
    versionName: '1.1',
    versionCode: 2,
    apkUrl: 'http://relayonion.onion/fdroid/repo/stiq_2.apk',
    apkSha256: APK_SHA_V2,
    whatChanged: '',
  };

  describe('a correctly-hashed APK signed by the WRONG key', () => {
    it('is rejected at install and never reaches the OS installer', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      // The bytes match the index hash exactly (download resolves), but the signer is foreign.
      const native = makeNative({
        verify: {valid: false, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(
        /signer does not match the pinned app signing certificate/i,
      );
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });

    it('ATTACK: a hostile join code pinning the ATTACKER’s own key is caught by the running build’s signature', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      // The attacker wrote the invite, so `af` names THEIR cert and verifyApkSigner happily says
      // valid=true. The only thing that catches this is the cert that signed the running build.
      const attackerCfg: UpdateRepoConfig = {...CFG, appCertSha256: APP_CERT};
      const native = makeNative({
        runningSignerCert: '77aa11bb22cc33dd44ee55ff66009988776655443322110099aabbccddeeff00',
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await expect(downloadAndInstall(onlineManager, INFO, attackerCfg, native)).rejects.toThrow(
        /did not sign the running build/i,
      );
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });

    it('installs when the pin genuinely is the running build’s signing key', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      const native = makeNative({
        runningSignerCert: APP_CERT, // matches cfg.appCertSha256 → same-signer holds
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await downloadAndInstall(onlineManager, INFO, CFG, native);
      expect(native.calls.some(c => c.method === 'appSigningCertSha256')).toBe(true);
      expect(native.calls.some(c => c.method === 'installApk')).toBe(true);
    });
  });

  describe('a correct key serving an OLDER version (rollback)', () => {
    it('is rejected by checkForUpdate — an old signed index offers nothing', async () => {
      const {checkForUpdate} = loadUpdater(true);
      // Attacker replays a genuinely-signed but stale index while v7 is installed.
      const native = makeNative({
        installedVersionCode: 7,
        indexJson: indexJson([
          {vc: 5, apk: 'stiq_5.apk', hash: APK_SHA_V1},
          {vc: 6, apk: 'stiq_6.apk', hash: APK_SHA_V2},
        ]),
      });
      expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });

    it('is rejected at INSTALL time too, when a stale offer is replayed after the app moved on', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      // INFO offers v2 — valid when it was produced — but the device is already on v9. Without the
      // install-time re-read this would download and hand a downgrade to the installer.
      const native = makeNative({
        installedVersionCode: 9,
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(
        /refusing downgrade/i,
      );
      expect(native.calls.some(c => c.method === 'downloadToFile')).toBe(false);
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });

    it('rejects a same-version reinstall (strictly-newer, not merely not-older)', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      const native = makeNative({
        installedVersionCode: 2,
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(
        /refusing downgrade/i,
      );
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });
  });

  describe('an unset / placeholder / publicly-known pin must FAIL CLOSED', () => {
    const cases: Array<[string, string]> = [
      ['unset', ''],
      ['placeholder (all zeros)', '0'.repeat(64)],
      ['placeholder (all f)', 'f'.repeat(64)],
      ['malformed (too short)', 'deadbeef'],
      ['the PUBLIC debug keystore', PUBLIC_DEBUG_CERT],
    ];

    for (const [label, pin] of cases) {
      it(`checkForUpdate throws — never silently reports "no update" — for ${label}`, async () => {
        const {checkForUpdate} = loadUpdater(true);
        const native = makeNative({installedVersionCode: 1});
        const cfg: UpdateRepoConfig = {...CFG, appCertSha256: pin};
        await expect(checkForUpdate(onlineManager, cfg, native)).rejects.toThrow(/refused/i);
        expect(native.calls).toHaveLength(0); // refused before a single byte was fetched
      });

      it(`downloadAndInstall throws and never installs for ${label}`, async () => {
        const {downloadAndInstall} = loadUpdater(true);
        const native = makeNative({});
        const cfg: UpdateRepoConfig = {...CFG, appCertSha256: pin};
        await expect(downloadAndInstall(onlineManager, INFO, cfg, native)).rejects.toThrow(/refused/i);
        expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
      });

      it(`the same is true for the repo INDEX pin (${label})`, async () => {
        const {checkForUpdate} = loadUpdater(true);
        const native = makeNative({installedVersionCode: 1});
        const cfg: UpdateRepoConfig = {...CFG, certSha256: pin};
        await expect(checkForUpdate(onlineManager, cfg, native)).rejects.toThrow(/refused/i);
        expect(native.calls).toHaveLength(0);
      });
    }

    it('names the compromised keystore in the failure so the cause is diagnosable', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      const native = makeNative({});
      const cfg: UpdateRepoConfig = {...CFG, appCertSha256: PUBLIC_DEBUG_CERT};
      await expect(downloadAndInstall(onlineManager, INFO, cfg, native)).rejects.toThrow(
        /COMPROMISED signing key/,
      );
    });
  });

  describe('a hostile index entry may not steer the download', () => {
    it('refuses an apkName that walks out of the repo directory', async () => {
      const {checkForUpdate} = loadUpdater(true);
      const native = makeNative({
        installedVersionCode: 1,
        indexJson: indexJson([{vc: 2, apk: '../../../evil.apk', hash: APK_SHA_V2}]),
      });
      expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
    });

    it('refuses an apkName carrying an absolute URL', async () => {
      const {checkForUpdate} = loadUpdater(true);
      const native = makeNative({
        installedVersionCode: 1,
        indexJson: indexJson([{vc: 2, apk: 'http://elsewhere.example/evil.apk', hash: APK_SHA_V2}]),
      });
      expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
    });

    it('refuses a truncated/garbage sha256 rather than passing it to the downloader', async () => {
      const {checkForUpdate} = loadUpdater(true);
      const native = makeNative({
        installedVersionCode: 1,
        indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: 'bb22'}]),
      });
      expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });
  });

  describe('an unidentifiable archive is not a pass', () => {
    it('refuses an APK whose packageName could not be read (fail closed, not fail open)', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      const native = makeNative({
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: ''},
      });
      await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(
        /packageName <unknown>/,
      );
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });

    it('refuses when the running build’s own signing cert cannot be read', async () => {
      const {downloadAndInstall} = loadUpdater(true);
      const native = makeNative({
        runningSignerCert: '', // accessor present but returns nothing usable
        verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP},
      });
      await expect(downloadAndInstall(onlineManager, INFO, CFG, native)).rejects.toThrow(
        /could not read this build/i,
      );
      expect(native.calls.some(c => c.method === 'installApk')).toBe(false);
    });
  });
});
