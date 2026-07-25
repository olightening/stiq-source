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
const REPO_CERT = 'a'.repeat(64); // pinned repo INDEX cert (join `uf`)
const APP_CERT = 'b'.repeat(64); // pinned APP signing cert (join `af`)

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
      const json = script.indexJson ?? indexJson([{vc: 1, apk: 'a.apk', hash: 'aa'}]);
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
    const native = makeNative({indexJson: indexJson([{vc: 9, apk: 'x.apk', hash: 'xx'}])});
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
        {vc: 1, apk: 'stiq_1.apk', hash: 'aa'},
        {vc: 2, apk: 'stiq_2.apk', hash: 'bb22', whatsNew: 'adds dark mode'},
      ]),
    });
    const info = await checkForUpdate(onlineManager, CFG, native);
    expect(info).toEqual({
      versionName: '2',
      versionCode: 2,
      apkUrl: 'http://relayonion.onion/fdroid/repo/stiq_2.apk',
      apkSha256: 'bb22',
      whatChanged: 'adds dark mode',
    });
  });

  it('returns null when the repo max is not newer than installed (monotonicity)', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      installedVersionCode: 2,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: 'bb'}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });

  it('returns null when the candidate hash is not sha256 (unverifiable APK)', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      installedVersionCode: 1,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: 'bb', hashType: 'md5'}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });

  it('returns null when the pinned applicationId is not what this build is', async () => {
    const {checkForUpdate} = loadUpdater(true);
    const native = makeNative({
      packageName: 'com.evil.app',
      installedVersionCode: 1,
      indexJson: indexJson([{vc: 2, apk: 'stiq_2.apk', hash: 'bb'}]),
    });
    expect(await checkForUpdate(onlineManager, CFG, native)).toBeNull();
  });
});

describe('downloadAndInstall — same-signer + version pins', () => {
  const INFO = {
    versionName: '1.1',
    versionCode: 2,
    apkUrl: 'http://relayonion.onion/fdroid/repo/stiq_2.apk',
    apkSha256: 'bb22',
    whatChanged: 'adds dark mode',
  };

  it('installs only after the APK passes the pinned app-cert + versionCode checks', async () => {
    const {downloadAndInstall} = loadUpdater(true);
    const native = makeNative({verify: {valid: true, versionCode: 2, versionName: '1.1', packageName: APP}});
    await downloadAndInstall(onlineManager, INFO, CFG, native);
    // Downloaded with the index sha as expectedSha256, verified against the APP cert, then installed.
    const dl = native.calls.find(c => c.method === 'downloadToFile')!.args[0] as {expectedSha256?: string};
    expect(dl.expectedSha256).toBe('bb22');
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
