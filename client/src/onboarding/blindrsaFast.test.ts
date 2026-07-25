/* eslint-disable no-bitwise -- bigint helpers mirror the implementation under test */
/**
 * FastBlindRsa (native-accelerated RFC 9474 client) against two oracles:
 *  - Node's native WebCrypto RSA-PSS verifier (saltLength 48 — what the issuer signs with and the
 *    relay's circl verifier enforces): every signature finalize() hands back must verify there.
 *  - RealBlindRsa (@cloudflare/blindrsa-ts): durable-draw-marker interop in BOTH directions — a
 *    marker written by either client must finalize under the other into the SAME signature bytes
 *    (unblinding is deterministic given the same blind signature and the same `inv`).
 *
 * Also covered: the hex marshalling of the native-module wrapper (against a fake StiqRsaMath
 * implemented with BigInt), the blinding-factor resample loop (r ≥ n and non-invertible r), the
 * reject paths of finalize(), and createBlindRsa()'s selection rules.
 */
import {FastBlindRsa, createBlindRsa} from './blindrsaFast';
import {RealBlindRsa} from './blindrsaReal';
import {jsRsaMathOps, wrapNativeRsaMath, type RsaMathNativeModule} from './rsaMath';
import {webCryptoShimSubtle} from './webcryptoShim';
import {base64ToBytes, bytesToBase64} from '../util/base64';

const NODE: Crypto = require('crypto').webcrypto;

// RSABSSA-SHA384-PSS-Deterministic salt ("Deterministic" = no random message prefix, NOT zero salt).
const SALT_LEN = 48;

function b64urlToBytes(b64url: string): Uint8Array {
  return base64ToBytes(b64url.replace(/-/g, '+').replace(/_/g, '/'));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) {
    x = (x << 8n) | BigInt(b);
  }
  return x;
}

function bigIntToBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/** Fresh ArrayBuffer copy — satisfies Node's strict BufferSource. */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.length);
  new Uint8Array(out).set(u);
  return out;
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

/** Issuer-side blind signature: raw RSADP (s = m^d mod n) — exactly what suite.blindSign computes. */
async function rawBlindSign(privateKey: CryptoKey, blindedMsg: Uint8Array, kLen: number): Promise<Uint8Array> {
  const jwk = await NODE.subtle.exportKey('jwk', privateKey);
  const n = bytesToBigInt(b64urlToBytes(jwk.n!));
  const d = bytesToBigInt(b64urlToBytes(jwk.d!));
  return bigIntToBytes(modPow(bytesToBigInt(blindedMsg), d, n), kLen);
}

/** Run `fn` with the pure-JS shim as global SubtleCrypto (the Hermes runtime configuration) —
 *  required by RealBlindRsa, whose suite calls global crypto.subtle. */
async function withShimGlobal<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const fake = {getRandomValues: NODE.getRandomValues.bind(NODE), subtle: webCryptoShimSubtle};
  Object.defineProperty(globalThis, 'crypto', {value: fake, configurable: true, writable: true});
  try {
    return await fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'crypto', original);
    } else {
      delete (globalThis as {crypto?: unknown}).crypto;
    }
  }
}

const nodeRandom = (len: number): Uint8Array => {
  const out = new Uint8Array(len);
  NODE.getRandomValues(out);
  return out;
};

/** A fake StiqRsaMath module: the hex surface implemented with BigInt — exercises the exact
 *  marshalling production uses (toString(16) / BigInt('0x…')) without an Android bridge. */
const fakeNativeModule: RsaMathNativeModule = {
  async blindOps(rHex, eHex, mHex, nHex) {
    const [r, e, m, n] = [rHex, eHex, mHex, nHex].map(h => BigInt('0x' + h)) as [bigint, bigint, bigint, bigint];
    const {inv, z} = await jsRsaMathOps.blindOps(r, e, m, n);
    return {inv: inv.toString(16), z: z.toString(16)};
  },
  async finalizeOps(zSigHex, invHex, eHex, nHex) {
    const [zSig, inv, e, n] = [zSigHex, invHex, eHex, nHex].map(h => BigInt('0x' + h)) as [bigint, bigint, bigint, bigint];
    const {s, em} = await jsRsaMathOps.finalizeOps(zSig, inv, e, n);
    return {s: s.toString(16), em: em.toString(16)};
  },
};

describe('FastBlindRsa', () => {
  let pubNative: CryptoKey;
  let privNative: CryptoKey;
  let issuerPubB64: string;
  const kLen = 256; // RSA-2048

  beforeAll(async () => {
    const pair = (await NODE.subtle.generateKey(
      {name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384'},
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    pubNative = pair.publicKey;
    privNative = pair.privateKey;
    issuerPubB64 = bytesToBase64(new Uint8Array(await NODE.subtle.exportKey('spki', pubNative)));
  });

  test('blind/finalize round-trips and verifies under a native RSA-PSS verifier (JS ops)', async () => {
    const token = nodeRandom(32);
    const client = new FastBlindRsa(jsRsaMathOps);
    // Default randomBytes path — run under the fake global that provides getRandomValues, exactly
    // the Hermes configuration (react-native-get-random-values).
    const {prepared, blinded, state} = await withShimGlobal(() => client.blind(issuerPubB64, token));

    expect(hex(prepared)).toBe(hex(token)); // Deterministic variant: prepared IS the token
    expect(blinded.length).toBe(kLen);
    expect(hex(blinded)).not.toBe(hex(token));

    const blindSig = await rawBlindSign(privNative, blinded, kLen);
    const sig = await client.finalize(state, blindSig);

    expect(sig.length).toBe(kLen);
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sig), ab(prepared));
    expect(ok).toBe(true);
  });

  test('round-trips through the native-module wrapper (hex marshalling)', async () => {
    const token = nodeRandom(32);
    const client = new FastBlindRsa(wrapNativeRsaMath(fakeNativeModule), nodeRandom);
    const {prepared, blinded, state} = await client.blind(issuerPubB64, token);
    const blindSig = await rawBlindSign(privNative, blinded, kLen);
    const sig = await client.finalize(state, blindSig);
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sig), ab(prepared));
    expect(ok).toBe(true);
  });

  test('a RealBlindRsa draw marker finalizes under FastBlindRsa — identical signature bytes', async () => {
    const token = nodeRandom(32);
    const real = new RealBlindRsa();
    const {prepared, blinded, state, blindingSecret} = await withShimGlobal(() =>
      real.blind(issuerPubB64, token),
    );
    const blindSig = await rawBlindSign(privNative, blinded, kLen);

    // The durable marker (F10) persists only prepared + blindingSecret; resume on the fast client.
    const fast = new FastBlindRsa(jsRsaMathOps, nodeRandom);
    const rebuilt = await fast.rebuildState(issuerPubB64, prepared, blindingSecret);
    const sigFast = await fast.finalize(rebuilt, blindSig);
    const sigReal = await withShimGlobal(() => real.finalize(state, blindSig));

    expect(hex(sigFast)).toBe(hex(sigReal)); // unblinding is deterministic given the same inv
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sigFast), ab(prepared));
    expect(ok).toBe(true);
  });

  test('a FastBlindRsa draw marker finalizes under RealBlindRsa — identical signature bytes', async () => {
    const token = nodeRandom(32);
    const fast = new FastBlindRsa(jsRsaMathOps, nodeRandom);
    const {prepared, blinded, state, blindingSecret} = await fast.blind(issuerPubB64, token);
    const blindSig = await rawBlindSign(privNative, blinded, kLen);

    const real = new RealBlindRsa();
    const rebuilt = await withShimGlobal(() => real.rebuildState(issuerPubB64, prepared, blindingSecret));
    const sigReal = await withShimGlobal(() => real.finalize(rebuilt, blindSig));
    const sigFast = await fast.finalize(state, blindSig);

    expect(hex(sigReal)).toBe(hex(sigFast));
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sigReal), ab(prepared));
    expect(ok).toBe(true);
  });

  test('resamples r when the draw is ≥ n or not invertible', async () => {
    const jwk = await NODE.subtle.exportKey('jwk', privNative);
    const pBytes = b64urlToBytes(jwk.p!); // a prime factor of n → gcd(r, n) = p → not invertible
    const pPadded = new Uint8Array(kLen);
    pPadded.set(pBytes, kLen - pBytes.length);

    // Scripted draws: salt (48) → real; r#1 = 2²⁰⁴⁸−1 (≥ n, rejected before ops); r#2 = p (ops
    // reject: not invertible); r#3+ → real random (accepted).
    const rDraws: Uint8Array[] = [new Uint8Array(kLen).fill(0xff), pPadded];
    let rCalls = 0;
    const scripted = (len: number): Uint8Array => {
      if (len !== kLen) {
        return nodeRandom(len);
      }
      rCalls++;
      return rDraws.shift() ?? nodeRandom(len);
    };

    const client = new FastBlindRsa(jsRsaMathOps, scripted);
    const token = nodeRandom(32);
    const {prepared, blinded, state} = await client.blind(issuerPubB64, token);
    // Two scripted rejections + at least one accepted draw. NOT exactly 3: a random tail draw can
    // itself legitimately land ≥ n (probability up to ~1/2 per draw depending on the modulus).
    expect(rCalls).toBeGreaterThanOrEqual(3);

    const blindSig = await rawBlindSign(privNative, blinded, kLen);
    const sig = await client.finalize(state, blindSig);
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sig), ab(prepared));
    expect(ok).toBe(true);
  });

  test('finalize rejects a corrupted or mis-sized blind signature', async () => {
    const client = new FastBlindRsa(jsRsaMathOps, nodeRandom);
    const token = nodeRandom(32);
    const {state} = await client.blind(issuerPubB64, token);

    await expect(client.finalize(state, new Uint8Array(kLen))).rejects.toThrow(); // all-zero
    await expect(client.finalize(state, new Uint8Array(kLen - 1))).rejects.toThrow(); // wrong length

    const garbage = nodeRandom(kLen);
    garbage[0] = 0; // keep < n so it reaches the PSS check rather than the range check
    await expect(client.finalize(state, garbage)).rejects.toThrow();
  });

  test('createBlindRsa selects by flag and module availability', () => {
    // Flag off → always the battle-tested pure-JS client.
    expect(createBlindRsa(null, false)).toBeInstanceOf(RealBlindRsa);
    expect(createBlindRsa(jsRsaMathOps, false)).toBeInstanceOf(RealBlindRsa);
    // Flag on + ops present → the fast client.
    expect(createBlindRsa(jsRsaMathOps, true)).toBeInstanceOf(FastBlindRsa);
    // Flag on + no native module (jest has no bridge) → falls back to RealBlindRsa.
    expect(createBlindRsa(undefined, true)).toBeInstanceOf(RealBlindRsa);
    // Flag on + explicit "module absent" → RealBlindRsa.
    expect(createBlindRsa(null, true)).toBeInstanceOf(RealBlindRsa);
  });
});
