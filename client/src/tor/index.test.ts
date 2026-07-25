/**
 * createTorBackend() flag-selection matrix (T17 spike, S3).
 *
 * The whole safety story of the dark Arti flag lives in this one factory:
 *   - flag OFF (the shipped default) → behavior is BYTE-IDENTICAL to before the spike:
 *       StiqTor present  → NativeTorBackend
 *       StiqTor absent   → UnavailableTorBackend (offline, never clearnet)
 *   - flag ON  → route to Arti:
 *       StiqArti present → ArtiTorBackend
 *       StiqArti absent  → UnavailableTorBackend (offline, never clearnet) — the safe-degrade that
 *         guarantees a spike build missing the Arti .so goes offline, NOT onto a clearnet path.
 *
 * USE_ARTI_BACKEND is a compile-time const, so we mock '../config' per-case (resetModules +
 * doMock) to exercise both flag states. ALLOW_CLEARNET_FALLBACK must stay false in the mock —
 * TorManager's constructor asserts it, and it encodes the no-clearnet invariant.
 */
jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: class {
    constructor(_m: unknown) {}
    addListener() {
      return {remove: () => {}};
    }
    removeAllListeners() {}
  },
}));

type Mods = {StiqTor?: unknown; StiqArti?: unknown};

/**
 * (Re)load ./index with USE_ARTI_BACKEND forced to `flag` and the given native modules present.
 * resetModules gives a fresh react-native mock each time, so NativeModules starts empty and we
 * seed only what the case needs.
 */
function loadIndex(flag: boolean, mods: Mods) {
  let api!: typeof import('./index');
  jest.isolateModules(() => {
    jest.doMock('../config', () => ({
      USE_ARTI_BACKEND: flag,
      ALLOW_CLEARNET_FALLBACK: false,
    }));
    const rn = require('react-native') as {NativeModules: Mods};
    Object.assign(rn.NativeModules, mods);
    api = require('./index');
  });
  return api;
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('../config');
});

describe('createTorBackend — flag OFF (shipped default, unchanged)', () => {
  it('returns NativeTorBackend when the StiqTor module is present', () => {
    const {createTorBackend} = loadIndex(false, {
      StiqTor: {startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()},
    });
    expect(createTorBackend().constructor.name).toBe('NativeTorBackend');
  });

  it('returns UnavailableTorBackend (offline, never clearnet) when StiqTor is absent', () => {
    const {createTorBackend} = loadIndex(false, {});
    expect(createTorBackend().constructor.name).toBe('UnavailableTorBackend');
  });

  it('ignores a present StiqArti module while the flag is off', () => {
    const {createTorBackend} = loadIndex(false, {
      StiqArti: {startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()},
    });
    // No StiqTor and flag off → Unavailable, NOT Arti. The flag is the only thing that selects Arti.
    expect(createTorBackend().constructor.name).toBe('UnavailableTorBackend');
  });
});

describe('createTorBackend — flag ON (spike build)', () => {
  it('returns ArtiTorBackend when the StiqArti module is present', () => {
    const {createTorBackend} = loadIndex(true, {
      StiqArti: {startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()},
    });
    expect(createTorBackend().constructor.name).toBe('ArtiTorBackend');
  });

  it('degrades to UnavailableTorBackend (offline, NEVER clearnet) when StiqArti is absent', () => {
    // A spike build with the flag on but no Arti .so packaged must go offline, not clearnet.
    const {createTorBackend} = loadIndex(true, {
      StiqTor: {startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()},
    });
    expect(createTorBackend().constructor.name).toBe('UnavailableTorBackend');
  });
});
