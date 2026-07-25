/**
 * Tests for nativeKeystore.multiGet — the batched secure-storage read.
 *
 * multiGet must take ONE of two paths depending on the installed native binary:
 *   1. native.multiGet present  → call it once, return its map verbatim (single bridge round-trip),
 *      and NOT fan out to per-key getItem.
 *   2. native.multiGet absent (stale binary / jest mock) → feature-detect and fall back to
 *      Promise.all of individual getItem calls, producing the IDENTICAL result shape (record of
 *      key -> value-or-null).
 *
 * We mock react-native so `NativeModules.StiqKeystore` reflects a per-test mock installed on a
 * global (jest.mock factories are hoisted above imports and may only close over globals). The
 * getter re-reads the global on every access, so getNativeKeystore() always sees the current mock.
 */

interface MockNative {
  setItem: jest.Mock;
  getItem: jest.Mock;
  removeItem: jest.Mock;
  multiGet?: jest.Mock;
}

const mockGlobal = globalThis as unknown as {__stiqKeystoreMock: {native?: MockNative}};
mockGlobal.__stiqKeystoreMock = {native: undefined};

jest.mock('react-native', () => ({
  NativeModules: {
    get StiqKeystore(): MockNative | undefined {
      return (globalThis as unknown as {__stiqKeystoreMock: {native?: MockNative}})
        .__stiqKeystoreMock.native;
    },
  },
}));

import {multiGet} from './nativeKeystore';

afterEach(() => {
  mockGlobal.__stiqKeystoreMock.native = undefined;
});

describe('nativeKeystore.multiGet', () => {
  it('uses native multiGet in a single call when present (no per-key getItem)', async () => {
    const nativeMultiGet = jest.fn().mockResolvedValue({a: '1', b: null, c: '3'});
    const getItem = jest.fn();
    mockGlobal.__stiqKeystoreMock.native = {
      setItem: jest.fn(),
      getItem,
      removeItem: jest.fn(),
      multiGet: nativeMultiGet,
    };

    const result = await multiGet(['a', 'b', 'c']);

    expect(result).toEqual({a: '1', b: null, c: '3'});
    expect(nativeMultiGet).toHaveBeenCalledTimes(1);
    expect(nativeMultiGet).toHaveBeenCalledWith(['a', 'b', 'c']);
    // Must NOT fall back to per-key reads when the batched native method exists.
    expect(getItem).not.toHaveBeenCalled();
  });

  it('falls back to per-key getItem with identical shape when native multiGet is absent', async () => {
    const store: Record<string, string> = {x: 'X', y: 'Y'};
    const getItem = jest.fn(async (key: string) =>
      Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
    );
    mockGlobal.__stiqKeystoreMock.native = {
      setItem: jest.fn(),
      getItem,
      removeItem: jest.fn(),
      // no multiGet — simulates a stale native binary / jest mock
    };

    const result = await multiGet(['x', 'y', 'z']);

    // Same shape as the native path: present keys mapped, absent key -> null.
    expect(result).toEqual({x: 'X', y: 'Y', z: null});
    expect(getItem).toHaveBeenCalledTimes(3);
    expect(getItem).toHaveBeenCalledWith('x');
    expect(getItem).toHaveBeenCalledWith('y');
    expect(getItem).toHaveBeenCalledWith('z');
  });

  it('returns an empty record for an empty key list (fallback path)', async () => {
    const getItem = jest.fn();
    mockGlobal.__stiqKeystoreMock.native = {
      setItem: jest.fn(),
      getItem,
      removeItem: jest.fn(),
    };

    const result = await multiGet([]);

    expect(result).toEqual({});
    expect(getItem).not.toHaveBeenCalled();
  });

  it('throws (fails closed) when no native keystore is installed', async () => {
    mockGlobal.__stiqKeystoreMock.native = undefined;
    await expect(multiGet(['a'])).rejects.toThrow(/secure storage unavailable/);
  });
});
