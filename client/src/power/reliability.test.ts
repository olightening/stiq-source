/**
 * reliability.ts — classifyOem (pure vendor→tier classification) + maybePromptReliability (the
 * one-time-nudge decision authority). AsyncStorage is mocked with the same shared in-memory
 * mockStore pattern as notifications/prefs.test.ts; NativeModules.StiqPower is mutated directly per
 * test the same way push/unifiedPush.test.ts mutates NativeModules.StiqUnifiedPush.
 */

// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  },
  removeItem: (k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  },
}));

import {NativeModules} from 'react-native';
import {
  classifyOem,
  getOemGuidance,
  hasAcknowledgedOemSteps,
  hasDismissedReliabilityPrompt,
  hasPowerModule,
  isIgnoringBatteryOptimizations,
  maybePromptReliability,
  oemGuidanceKey,
  reliabilityActionNeeded,
  requestIgnoreBatteryOptimizations,
  setOemStepsAcknowledged,
  setReliabilityPromptDismissed,
} from './reliability';

describe('classifyOem', () => {
  it('classifies each documented aggressive-tier vendor family', () => {
    expect(classifyOem('Xiaomi', 'Xiaomi')).toBe('aggressive');
    expect(classifyOem('Xiaomi', 'Redmi')).toBe('aggressive');
    expect(classifyOem('Xiaomi', 'POCO')).toBe('aggressive');
    expect(classifyOem('HUAWEI', 'HUAWEI')).toBe('aggressive');
    expect(classifyOem('HONOR', 'HONOR')).toBe('aggressive');
    expect(classifyOem('OPPO', 'OPPO')).toBe('aggressive');
    expect(classifyOem('realme', 'realme')).toBe('aggressive');
    expect(classifyOem('vivo', 'vivo')).toBe('aggressive');
    expect(classifyOem('vivo', 'iQOO')).toBe('aggressive');
    expect(classifyOem('OnePlus', 'OnePlus')).toBe('aggressive');
    expect(classifyOem('Meizu', 'Meizu')).toBe('aggressive');
    expect(classifyOem('asus', 'asus')).toBe('aggressive');
  });

  it('classifies Samsung as moderate', () => {
    expect(classifyOem('samsung', 'samsung')).toBe('moderate');
    expect(classifyOem('Samsung', 'SAMSUNG')).toBe('moderate');
  });

  it('is case-insensitive', () => {
    expect(classifyOem('XIAOMI', 'xiaomi')).toBe('aggressive');
    expect(classifyOem('xiaomi', 'XIAOMI')).toBe('aggressive');
    expect(classifyOem('SaMsUnG', 'sAmSuNg')).toBe('moderate');
  });

  it('defaults unrecognized vendors to clean', () => {
    expect(classifyOem('Google', 'Pixel')).toBe('clean');
    expect(classifyOem('Sony', 'Sony')).toBe('clean');
    expect(classifyOem('', '')).toBe('clean');
    expect(classifyOem('Motorola', 'motorola')).toBe('clean');
  });
});

describe('oemGuidanceKey / getOemGuidance', () => {
  it('resolves the matched vendor family key with a non-empty step list', () => {
    expect(oemGuidanceKey('Xiaomi', 'Redmi')).toBe('xiaomi');
    const g = getOemGuidance('Xiaomi', 'Redmi');
    expect(g.label).toMatch(/xiaomi/i);
    expect(g.steps.length).toBeGreaterThan(0);
  });

  it('falls back to generic guidance for an unrecognized vendor', () => {
    expect(oemGuidanceKey('Google', 'Pixel')).toBe('generic');
    const g = getOemGuidance('Google', 'Pixel');
    expect(g.steps.length).toBeGreaterThan(0);
  });
});

describe('native module wrapper (absent-safe)', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (NativeModules as any).StiqPower;
  });

  it('degrades to optimistic/empty fallbacks when the native module is absent', async () => {
    expect(hasPowerModule()).toBe(false);
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true);
    expect(() => requestIgnoreBatteryOptimizations()).not.toThrow();
  });

  it('delegates to the native module when present, and swallows a native throw', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => false),
      requestIgnoreBatteryOptimizations: jest.fn(),
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Xiaomi', brand: 'Redmi', model: 'X'})),
    };
    expect(hasPowerModule()).toBe(true);
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(false);
    requestIgnoreBatteryOptimizations();
    expect(NativeModules.StiqPower.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => {
        throw new Error('native boom');
      }),
      requestIgnoreBatteryOptimizations: jest.fn(() => {
        throw new Error('native boom');
      }),
    };
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true); // swallowed → optimistic fallback
    expect(() => requestIgnoreBatteryOptimizations()).not.toThrow();
  });
});

describe('maybePromptReliability', () => {
  beforeEach(() => {
    mockStore = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (NativeModules as any).StiqPower;
  });

  it('prompts on an aggressive OEM even when the exemption is already granted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => true), // already exempt
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Xiaomi', brand: 'Redmi', model: 'X'})),
    };
    await expect(maybePromptReliability()).resolves.toBe(true);
  });

  it('prompts on a clean OEM when the exemption is not granted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => false), // not exempt
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Google', brand: 'Pixel', model: 'P'})),
    };
    await expect(maybePromptReliability()).resolves.toBe(true);
  });

  it('does not prompt on a clean OEM that already has the exemption', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => true),
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Google', brand: 'Pixel', model: 'P'})),
    };
    await expect(maybePromptReliability()).resolves.toBe(false);
  });

  it('never prompts once the user has dismissed it, regardless of OEM/exemption state', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NativeModules as any).StiqPower = {
      isIgnoringBatteryOptimizations: jest.fn(async () => false),
      getDeviceVendorInfo: jest.fn(async () => ({manufacturer: 'Xiaomi', brand: 'Redmi', model: 'X'})),
    };
    await setReliabilityPromptDismissed(true);
    await expect(hasDismissedReliabilityPrompt()).resolves.toBe(true);
    await expect(maybePromptReliability()).resolves.toBe(false);
  });
});

describe('reliabilityActionNeeded', () => {
  it('is true whenever the exemption is not granted, regardless of OEM tier or acknowledgement', () => {
    expect(reliabilityActionNeeded(false, 'clean', false)).toBe(true);
    expect(reliabilityActionNeeded(false, 'clean', true)).toBe(true);
    expect(reliabilityActionNeeded(false, 'aggressive', true)).toBe(true);
    expect(reliabilityActionNeeded(false, 'moderate', true)).toBe(true);
  });

  it('is false once exempt on a clean or moderate OEM (acknowledgement irrelevant)', () => {
    expect(reliabilityActionNeeded(true, 'clean', false)).toBe(false);
    expect(reliabilityActionNeeded(true, 'moderate', false)).toBe(false);
  });

  it('is true once exempt on an aggressive OEM until the user acknowledges the manual steps', () => {
    expect(reliabilityActionNeeded(true, 'aggressive', false)).toBe(true);
  });

  it('is false once exempt on an aggressive OEM and the user has acknowledged the manual steps', () => {
    expect(reliabilityActionNeeded(true, 'aggressive', true)).toBe(false);
  });
});

describe('hasAcknowledgedOemSteps / setOemStepsAcknowledged', () => {
  beforeEach(() => {
    mockStore = {};
  });

  it('defaults to false (not acknowledged)', async () => {
    await expect(hasAcknowledgedOemSteps()).resolves.toBe(false);
  });

  it('round-trips true and false through AsyncStorage', async () => {
    await setOemStepsAcknowledged(true);
    await expect(hasAcknowledgedOemSteps()).resolves.toBe(true);

    await setOemStepsAcknowledged(false);
    await expect(hasAcknowledgedOemSteps()).resolves.toBe(false);
  });
});
