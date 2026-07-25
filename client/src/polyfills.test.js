/* eslint-env jest, browser, node */
/**
 * Guards the two hot-path polyfills in polyfills.js:
 *  1. TextEncoder — the two-pass rewrite must produce byte-identical RFC 3629 UTF-8 output to a
 *     reference encoder (same fixtures as util/utf8.test.ts).
 *  2. crypto.subtle — must be installed as a LAZY getter that require()s the blind-RSA shim only on
 *     first access (enrollment-only), not eagerly at import.
 *
 * polyfills.js pulls in native-only side effects (react-native-get-random-values); that is stubbed
 * here. The webcrypto shim is stubbed with a sentinel so we can observe exactly when it is loaded.
 */
jest.mock('react-native-get-random-values', () => ({}), {virtual: true});

// Mock the blind-RSA shim with a sentinel + a per-module-instance load counter so we can assert the
// require() is deferred until first access. `mock`-prefixed names are the only out-of-scope vars a
// jest.mock factory may reference. isolateModules re-runs the factory, so the counter tracks loads
// within the current isolate; we read it back via require('./onboarding/webcryptoShim').
const mockSentinelSubtle = {__sentinel: 'blindrsa-shim'};
jest.mock('./onboarding/webcryptoShim', () => {
  const state = {loads: 0};
  return {
    get webCryptoShimSubtle() {
      state.loads++;
      return mockSentinelSubtle;
    },
    installWebCryptoShim: () => {},
    __state: state,
  };
});

const SENTINEL_SUBTLE = mockSentinelSubtle;
const shimState = () => require('./onboarding/webcryptoShim').__state;

/**
 * Install polyfills.js against a synthetic global that mimics Hermes: no TextEncoder/TextDecoder,
 * and a crypto object with getRandomValues but NO subtle. Returns the crypto object so the caller
 * can observe the lazy getter. Restores the real globals afterward.
 */
function installFreshPolyfills() {
  const realTE = global.TextEncoder;
  const realTD = global.TextDecoder;
  const realURL = global.URL;
  const realCrypto = global.crypto;

  global.TextEncoder = undefined;
  global.TextDecoder = undefined;
  // A Hermes-like crypto: getRandomValues present (from react-native-get-random-values), no subtle.
  const fakeCrypto = {getRandomValues: realCrypto ? realCrypto.getRandomValues : () => {}};
  Object.defineProperty(global, 'crypto', {value: fakeCrypto, configurable: true, writable: true});

  let PolyEnc;
  jest.isolateModules(() => {
    require('./polyfills');
    PolyEnc = global.TextEncoder;
  });

  // fakeCrypto stays installed as global.crypto so the lazy getter (which mutates globalThis.crypto)
  // observes the same object the caller inspects. The caller MUST call restore() when done.
  const restore = () => {
    global.TextEncoder = realTE;
    global.TextDecoder = realTD;
    global.URL = realURL;
    Object.defineProperty(global, 'crypto', {value: realCrypto, configurable: true, writable: true});
  };
  return {PolyEnc, fakeCrypto, restore};
}

describe('TextEncoder polyfill (polyfills.js)', () => {
  let PolyEnc;
  beforeAll(() => {
    const inst = installFreshPolyfills();
    PolyEnc = inst.PolyEnc;
    inst.restore();
  });

  const ref = s => Array.from(new TextEncoder().encode(s));
  const poly = s => Array.from(new PolyEnc().encode(s));

  it('installed a distinct polyfill class', () => {
    expect(typeof PolyEnc).toBe('function');
    expect(PolyEnc).not.toBe(TextEncoder);
  });

  it('matches util/utf8.test.ts fixtures exactly', () => {
    expect(poly('A')).toEqual([0x41]);
    expect(poly('é')).toEqual([0xc3, 0xa9]);
    expect(poly('€')).toEqual([0xe2, 0x82, 0xac]);
    expect(poly('😀')).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect(poly('')).toEqual([]);
  });

  it('agrees with the native encoder across mixed samples', () => {
    const samples = [
      '', 'a', 'ab', 'abc', 'abcd', 'é', 'aé', '€x', '😀😀', '🇬🇧flag',
      'Hello, мир! 世界 😀 café — ναι', '😀'.repeat(9000),
    ];
    for (const s of samples) {
      expect(poly(s)).toEqual(ref(s));
    }
  });
});

describe('crypto.subtle lazy getter (polyfills.js)', () => {
  it('does NOT load the blind-RSA shim at import time', () => {
    const before = shimState().loads;
    const {fakeCrypto, restore} = installFreshPolyfills();
    try {
      // Getter installed, but the shim's webCryptoShimSubtle must not have been read yet.
      expect(shimState().loads).toBe(before);
      expect(Object.getOwnPropertyDescriptor(fakeCrypto, 'subtle').get).toBeInstanceOf(Function);
    } finally {
      restore();
    }
  });

  it('loads the shim on first access and caches it thereafter', () => {
    const before = shimState().loads;
    const {fakeCrypto, restore} = installFreshPolyfills();
    try {
      const first = fakeCrypto.subtle; // triggers the lazy require() + read
      expect(first).toBe(SENTINEL_SUBTLE);
      expect(shimState().loads).toBe(before + 1);

      const second = fakeCrypto.subtle; // served from the collapsed value, no reload
      expect(second).toBe(SENTINEL_SUBTLE);
      expect(shimState().loads).toBe(before + 1);
      // The accessor should have collapsed to a plain data property.
      expect(Object.getOwnPropertyDescriptor(fakeCrypto, 'subtle').get).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('leaves an existing native crypto.subtle untouched (Node/Jest path)', () => {
    // Under real Jest, global.crypto.subtle already exists; importing polyfills must not replace it.
    const before = shimState().loads;
    const realTE = global.TextEncoder;
    const realTD = global.TextDecoder;
    const realURL = global.URL;
    global.TextEncoder = undefined;
    global.TextDecoder = undefined;
    const nativeSubtle = {native: true};
    const priorCrypto = global.crypto;
    Object.defineProperty(global, 'crypto', {
      value: {getRandomValues: () => {}, subtle: nativeSubtle},
      configurable: true,
      writable: true,
    });
    jest.isolateModules(() => {
      require('./polyfills');
    });
    expect(global.crypto.subtle).toBe(nativeSubtle);
    expect(shimState().loads).toBe(before);
    global.TextEncoder = realTE;
    global.TextDecoder = realTD;
    global.URL = realURL;
    Object.defineProperty(global, 'crypto', {value: priorCrypto, configurable: true, writable: true});
  });
});
