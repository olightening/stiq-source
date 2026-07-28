/**
 * getTorDaemonControl() and getNetworkClass() resolve whichever engine module the product flavor
 * linked — NativeModules.StiqArti (arti) first, then NativeModules.StiqTor (ctor) — in the same
 * order as createTorBackend() (index.ts), so the off-seam callers and the backend seam always
 * agree on which daemon is live.
 *
 * getNetworkClass()'s normalization contract is unchanged from its nativeBackend.ts ancestry:
 * never throw, normalize whatever the native module hands back:
 *   - no native module at all (jest / older binary)         → 'unknown'
 *   - a module without the getNetworkClass method            → 'unknown'
 *   - a recognized class string                              → that class, verbatim
 *   - an unrecognized string                                 → 'unknown'
 *   - a rejected native promise                               → 'unknown'
 */
jest.mock('react-native', () => ({NativeModules: {}}));

import {NativeModules} from 'react-native';
import {getTorDaemonControl, getNetworkClass} from './daemonControl';

const nm = NativeModules as {
  StiqArti?: {newCircuit?: () => void; getNetworkClass?: () => Promise<string>};
  StiqTor?: {newCircuit?: () => void; getNetworkClass?: () => Promise<string>};
};

afterEach(() => {
  delete nm.StiqArti;
  delete nm.StiqTor;
});

describe('getTorDaemonControl', () => {
  it('returns the StiqArti module (arti flavor)', () => {
    const arti = {newCircuit: () => {}};
    nm.StiqArti = arti;
    expect(getTorDaemonControl()).toBe(arti);
  });

  it('falls back to the StiqTor module when StiqArti is absent (ctor flavor)', () => {
    const ctor = {newCircuit: () => {}};
    nm.StiqTor = ctor;
    expect(getTorDaemonControl()).toBe(ctor);
  });

  it('prefers StiqArti when both engine modules are present (same order as createTorBackend)', () => {
    const arti = {newCircuit: () => {}};
    nm.StiqArti = arti;
    nm.StiqTor = {newCircuit: () => {}};
    expect(getTorDaemonControl()).toBe(arti);
  });

  it('returns undefined when neither engine module is present', () => {
    expect(getTorDaemonControl()).toBeUndefined();
  });
});

describe('getNetworkClass via the ctor engine', () => {
  it("reads StiqTor's getNetworkClass when StiqArti is absent", async () => {
    nm.StiqTor = {getNetworkClass: () => Promise.resolve('cellular')};
    await expect(getNetworkClass()).resolves.toBe('cellular');
  });
});

describe('getNetworkClass', () => {
  it("resolves 'unknown' when the native module is absent", async () => {
    delete nm.StiqArti;
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("resolves 'unknown' when the module lacks getNetworkClass", async () => {
    nm.StiqArti = {};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("passes a recognized class ('wifi') through unchanged", async () => {
    nm.StiqArti = {getNetworkClass: () => Promise.resolve('wifi')};
    await expect(getNetworkClass()).resolves.toBe('wifi');
  });

  it('accepts every recognized transport class', async () => {
    for (const cls of ['wifi', 'cellular', 'ethernet', 'vpn', 'other']) {
      nm.StiqArti = {getNetworkClass: () => Promise.resolve(cls)};
      await expect(getNetworkClass()).resolves.toBe(cls);
    }
  });

  it("normalizes an unrecognized value ('garbage') to 'unknown'", async () => {
    nm.StiqArti = {getNetworkClass: () => Promise.resolve('garbage')};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("normalizes the native 'unknown' sentinel to 'unknown'", async () => {
    nm.StiqArti = {getNetworkClass: () => Promise.resolve('unknown')};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });

  it("resolves 'unknown' (never rejects) when the native call rejects", async () => {
    nm.StiqArti = {getNetworkClass: () => Promise.reject(new Error('boom'))};
    await expect(getNetworkClass()).resolves.toBe('unknown');
  });
});
