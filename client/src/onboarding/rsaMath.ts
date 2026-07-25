/* eslint-disable no-bitwise -- square-and-multiply modexp is inherently bit ops */
/**
 * Modular-arithmetic ops behind the fast blind-RSA client (blindrsaFast.ts): a native
 * implementation (StiqRsaMath — Android BigInteger, i.e. BoringSSL BIGNUM) and a pure-JS BigInt
 * twin. The JS twin is the test oracle and the reference the native path must match byte-for-byte;
 * production only ever selects the native ops (see createBlindRsa in blindrsaFast.ts — when the
 * module is absent the whole client falls back to RealBlindRsa, not to these JS ops).
 *
 * Same precedent as StiqSchnorr / StiqKdf / StiqPow: only the big-number math is offloaded; all
 * protocol logic, hashing and byte plumbing stay in JS where they are cheap and jest-testable.
 *
 * Values cross the bridge as lowercase hex magnitudes (BigInt.toString(16) ↔ BigInteger(hex, 16));
 * leading zeros are insignificant on both sides. Only public-key material and per-token blinding
 * values ever cross — there is no private key on the client at all.
 */
import {NativeModules} from 'react-native';

export interface RsaMathOps {
  /**
   * Blind-side ops for one token: inv = r⁻¹ mod n (REJECTS when gcd(r, n) ≠ 1 — caller resamples
   * r); z = m·rᵉ mod n (the blinded message shown to the issuer).
   */
  blindOps(r: bigint, e: bigint, m: bigint, n: bigint): Promise<{inv: bigint; z: bigint}>;
  /**
   * Finalize-side ops for one token: s = zSig·inv mod n (unblind the issuer's blind signature);
   * em = sᵉ mod n (RSAVP1 — the PSS representative the caller must EMSA-PSS-VERIFY).
   */
  finalizeOps(zSig: bigint, inv: bigint, e: bigint, n: bigint): Promise<{s: bigint; em: bigint}>;
}

/** The StiqRsaMath Kotlin module's surface (hex-string twin of {@link RsaMathOps}). */
export interface RsaMathNativeModule {
  blindOps(rHex: string, eHex: string, mHex: string, nHex: string): Promise<{inv: string; z: string}>;
  finalizeOps(zSigHex: string, invHex: string, eHex: string, nHex: string): Promise<{s: string; em: string}>;
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

/** a⁻¹ mod n via the extended Euclidean algorithm. Throws when gcd(a, n) ≠ 1 — the exact contract
 *  of BigInteger.modInverse on the native side, so both ops implementations fail identically. */
function modInverse(a: bigint, n: bigint): bigint {
  let t = 0n;
  let newT = 1n;
  let r = n;
  let newR = ((a % n) + n) % n;
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r !== 1n) {
    throw new Error('modInverse: not invertible');
  }
  return ((t % n) + n) % n;
}

/** Pure-JS BigInt ops — the reference implementation and jest oracle. */
export const jsRsaMathOps: RsaMathOps = {
  async blindOps(r, e, m, n) {
    return {inv: modInverse(r, n), z: (m * modPow(r, e, n)) % n};
  },
  async finalizeOps(zSig, inv, e, n) {
    const s = (zSig * inv) % n;
    return {s, em: modPow(s, e, n)};
  },
};

const toHex = (x: bigint): string => x.toString(16);
const fromHex = (h: string): bigint => BigInt('0x' + h);

/**
 * Wrap the hex-string native surface into bigint-typed {@link RsaMathOps}. Exported so tests can
 * exercise the exact marshalling production uses against a fake module.
 */
export function wrapNativeRsaMath(native: RsaMathNativeModule): RsaMathOps {
  return {
    async blindOps(r, e, m, n) {
      const out = await native.blindOps(toHex(r), toHex(e), toHex(m), toHex(n));
      return {inv: fromHex(out.inv), z: fromHex(out.z)};
    },
    async finalizeOps(zSig, inv, e, n) {
      const out = await native.finalizeOps(toHex(zSig), toHex(inv), toHex(e), toHex(n));
      return {s: fromHex(out.s), em: fromHex(out.em)};
    },
  };
}

const nativeModule = (NativeModules as {StiqRsaMath?: RsaMathNativeModule}).StiqRsaMath;

export function isNativeRsaMathAvailable(): boolean {
  return !!nativeModule && typeof nativeModule.blindOps === 'function';
}

/** The production ops: the wrapped native module. ONLY valid when {@link isNativeRsaMathAvailable}. */
export function nativeRsaMathOps(): RsaMathOps {
  if (!nativeModule) {
    throw new Error('StiqRsaMath native module is not available');
  }
  return wrapNativeRsaMath(nativeModule);
}
