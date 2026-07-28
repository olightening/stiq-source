/**
 * createTorBackend() (index.ts) is the seam that selects the app's Tor backend — the ONE place
 * the two Android product flavors (arti / ctor, see the `tor` flavor dimension in
 * app/build.gradle) diverge on the JS side. Covered outcomes:
 *
 *   - StiqArti linked  → ArtiTorBackend   (arti flavor)
 *   - StiqTor linked   → CTorBackend      (ctor flavor)
 *   - both linked      → ArtiTorBackend   (arti wins; no shipped flavor links both, but the
 *                                          probe order must stay deterministic)
 *   - neither linked   → UnavailableTorBackend (offline, NEVER a clearnet path)
 *
 * getArtiTorModule()/getCtorTorModule() read NativeModules at CALL time, not module load time,
 * so tests just mutate NativeModules per case — no isolateModules/doMock needed.
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

import {NativeModules} from 'react-native';
import {createTorBackend} from './index';

const nm = NativeModules as {StiqArti?: unknown; StiqTor?: unknown};

const fakeModule = () => ({startTor: () => Promise.resolve(), stopTor: () => Promise.resolve()});

afterEach(() => {
  delete nm.StiqArti;
  delete nm.StiqTor;
});

describe('createTorBackend', () => {
  it('returns ArtiTorBackend when the StiqArti module is present (arti flavor)', () => {
    nm.StiqArti = fakeModule();
    expect(createTorBackend().constructor.name).toBe('ArtiTorBackend');
  });

  it('returns CTorBackend when only the StiqTor module is present (ctor flavor)', () => {
    nm.StiqTor = fakeModule();
    expect(createTorBackend().constructor.name).toBe('CTorBackend');
  });

  it('prefers Arti when both engine modules are present', () => {
    nm.StiqArti = fakeModule();
    nm.StiqTor = fakeModule();
    expect(createTorBackend().constructor.name).toBe('ArtiTorBackend');
  });

  it('degrades to UnavailableTorBackend (offline, NEVER clearnet) when neither engine is linked', () => {
    expect(createTorBackend().constructor.name).toBe('UnavailableTorBackend');
  });
});
