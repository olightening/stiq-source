/**
 * Contract coverage for getNetworkClass() (T2-S2).
 *
 * getNetworkClass() must NEVER throw and must normalize whatever the native module hands back:
 *   - no native module at all (jest / iOS / older binary) → 'unknown'
 *   - a module without the getNetworkClass method            → 'unknown'
 *   - a recognized class string                              → that class, verbatim
 *   - an unrecognized string                                 → 'unknown'
 *   - a rejected native promise                              → 'unknown'
 *
 * We mock 'react-native' minimally: nativeBackend.ts only needs `NativeModules` (read at call
 * time by getNativeTorModule) and a `NativeEventEmitter` symbol present at import. The RN preset's
 * own NativeModules is a static no-op, so we drive NativeModules.StiqTor directly here.
 */
jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return {remove: () => {}};
    }
    removeAllListeners() {}
  },
}));

import {NativeModules} from 'react-native';
import {getNetworkClass} from './nativeBackend';

const nm = NativeModules as {StiqTor?: {getNetworkClass?: () => Promise<string>}};

describe('getNetworkClass', () => {
  afterEach(() => {
    delete nm.StiqTor;
  });

  it("resolves 'unknown' when the native module is absent", async () => {
    delete nm.StiqTor;
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("resolves 'unknown' when the module lacks getNetworkClass", async () => {
    nm.StiqTor = {};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("passes a recognized class ('wifi') through unchanged", async () => {
    nm.StiqTor = {getNetworkClass: () => Promise.resolve('wifi')};
    await expect(getNetworkClass()).resolves.toBe('wifi');
  });

  it('accepts every recognized transport class', async () => {
    for (const cls of ['wifi', 'cellular', 'ethernet', 'vpn', 'other']) {
      nm.StiqTor = {getNetworkClass: () => Promise.resolve(cls)};
      await expect(getNetworkClass()).resolves.toBe(cls);
    }
  });

  it("normalizes an unrecognized value ('garbage') to 'unknown'", async () => {
    nm.StiqTor = {getNetworkClass: () => Promise.resolve('garbage')};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("normalizes the native 'unknown' sentinel to 'unknown'", async () => {
    nm.StiqTor = {getNetworkClass: () => Promise.resolve('unknown')};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("resolves 'unknown' (never rejects) when the native call rejects", async () => {
    nm.StiqTor = {getNetworkClass: () => Promise.reject(new Error('boom'))};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });
});
