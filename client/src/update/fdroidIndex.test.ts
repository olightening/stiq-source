/**
 * fdroidIndex — the pure parse + monotonic version-pick half of the T9 updater.
 *
 * These pin the security-load-bearing decisions that must hold OFF-device: an index parses into the
 * normalized shape, `whatsNew` is sourced from either the localized `apps` block or an inlined entry
 * field, and `pickUpdate` NEVER returns an equal/older build (the "no downgrade" monotonicity rule).
 */
import {parseFdroidIndexJson, pickUpdate, type FdroidIndex} from './fdroidIndex';

const APP = 'com.stiq.client';

/** A realistic fdroidserver-shaped index-v1 with a localized whatsNew + two builds. */
const SAMPLE = JSON.stringify({
  repo: {name: 'stiq updates', address: 'http://abc.onion/fdroid/repo'},
  apps: [
    {
      packageName: APP,
      localized: {'en-US': {whatsNew: 'Fixes the sync bug and adds dark mode.'}},
    },
  ],
  packages: {
    [APP]: [
      {versionName: '1.0', versionCode: 1, apkName: `${APP}_1.apk`, hash: 'aa11', hashType: 'sha256', size: 100},
      {versionName: '1.1', versionCode: 2, apkName: `${APP}_2.apk`, hash: 'bb22', hashType: 'sha256', size: 200},
    ],
  },
});

describe('parseFdroidIndexJson', () => {
  it('normalizes repo name + package entries and attaches the localized whatsNew to the top build', () => {
    const idx = parseFdroidIndexJson(SAMPLE);
    expect(idx.repoName).toBe('stiq updates');
    const entries = idx.packages[APP]!;
    expect(entries).toHaveLength(2);
    const top = entries.find(e => e.versionCode === 2)!;
    expect(top.apkName).toBe(`${APP}_2.apk`);
    expect(top.hash).toBe('bb22');
    expect(top.hashType).toBe('sha256');
    expect(top.whatsNew).toBe('Fixes the sync bug and adds dark mode.');
    // The localized note attaches to the HIGHEST versionCode only.
    expect(entries.find(e => e.versionCode === 1)!.whatsNew).toBeUndefined();
  });

  it('reads an inlined per-entry whatsNew (the no-fdroidserver publish path)', () => {
    const json = JSON.stringify({
      packages: {
        [APP]: [
          {versionName: '2.0', versionCode: 3, apkName: 'x.apk', hash: 'cc', hashType: 'sha256', whatsNew: 'inline note'},
        ],
      },
    });
    const idx = parseFdroidIndexJson(json);
    expect(idx.packages[APP]![0]!.whatsNew).toBe('inline note');
  });

  it('lower-cases the hash + hashType and drops entries missing a numeric versionCode', () => {
    const json = JSON.stringify({
      packages: {
        [APP]: [
          {versionName: '1.0', versionCode: '9', apkName: 'bad.apk', hash: 'DD', hashType: 'SHA256'}, // versionCode not a number → dropped
          {versionName: '1.2', versionCode: 4, apkName: 'good.apk', hash: 'EEFF', hashType: 'SHA256'},
        ],
      },
    });
    const idx = parseFdroidIndexJson(json);
    const entries = idx.packages[APP]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe('eeff');
    expect(entries[0]!.hashType).toBe('sha256');
  });

  it('throws on a non-object top level but tolerates a missing packages map', () => {
    expect(() => parseFdroidIndexJson('[]')).toThrow();
    expect(parseFdroidIndexJson('{}')).toEqual({packages: {}});
  });
});

describe('pickUpdate (monotonicity)', () => {
  const idx: FdroidIndex = parseFdroidIndexJson(SAMPLE);

  it('returns the highest build when it is strictly newer than installed', () => {
    const pick = pickUpdate(idx, APP, 1);
    expect(pick?.versionCode).toBe(2);
    expect(pick?.versionName).toBe('1.1');
  });

  it('returns null when the installed version equals the repo max (no reinstall)', () => {
    expect(pickUpdate(idx, APP, 2)).toBeNull();
  });

  it('returns null when installed is newer than the repo max (no downgrade)', () => {
    expect(pickUpdate(idx, APP, 5)).toBeNull();
  });

  it('picks the maximum out of an unsorted multi-build array', () => {
    const multi = parseFdroidIndexJson(
      JSON.stringify({
        packages: {
          [APP]: [
            {versionName: '3', versionCode: 3, apkName: 'c.apk', hash: 'c', hashType: 'sha256'},
            {versionName: '7', versionCode: 7, apkName: 'g.apk', hash: 'g', hashType: 'sha256'},
            {versionName: '5', versionCode: 5, apkName: 'e.apk', hash: 'e', hashType: 'sha256'},
          ],
        },
      }),
    );
    expect(pickUpdate(multi, APP, 4)?.versionCode).toBe(7);
  });

  it('returns null for an application id absent from the repo', () => {
    expect(pickUpdate(idx, 'com.other.app', 0)).toBeNull();
  });
});
