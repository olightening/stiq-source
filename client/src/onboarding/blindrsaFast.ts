/* eslint-disable no-bitwise -- EMSA-PSS-ENCODE (RFC 8017 §9.1.1) is inherently bit/byte ops */
/**
 * Native-accelerated blind-RSA client (RFC 9474 RSABSSA-SHA384-PSS-Deterministic) — a drop-in
 * BlindRsaClient whose 2048-bit modular math runs in the StiqRsaMath Kotlin module (BoringSSL
 * BIGNUM) instead of pure-JS bignums.
 *
 * WHY: a wallet refill blinds/unblinds DRAW_BATCH=100 tokens; with @cloudflare/blindrsa-ts the
 * per-token modexp/inverse runs in sjcl + BigInt on the Hermes JS thread. On a flagship that is
 * jank; on a mid-range phone it is seconds of JS-thread work per refill, felt as "insane actions
 * delay" (2026-07-23 field report). Same fix pattern as StiqKdf/StiqSchnorr/StiqPow: offload ONLY
 * the big-number math; hashing, PSS encode/verify and all byte plumbing stay in JS, shared with
 * the audited webcryptoShim primitives.
 *
 * INTEROP CONTRACT (covered by blindrsaFast.test.ts):
 *  - Signatures finalize()d here verify under a native WebCrypto RSA-PSS verifier with the same
 *    48-byte salt the issuer signs with and the relay's circl verifier enforces. ("Deterministic"
 *    is the prepare step — no random message prefix — NOT a zero salt; see webcryptoShim.test.ts.)
 *  - `blindingSecret` is RFC 9474's `inv` as I2OSP(r⁻¹ mod n, k) — byte-identical to what
 *    RealBlindRsa (blindrsa-ts) emits — so durable draw markers (F10) written by EITHER client
 *    resume under the OTHER: rebuildState here accepts a RealBlindRsa marker and vice versa. A
 *    fleet mixing old and new builds, or a build where the native module goes missing, never
 *    strands an in-flight draw.
 *
 * Production selection happens in {@link createBlindRsa}: native module present + flag on → this
 * client; anything else → RealBlindRsa unchanged. The pure-JS ops twin (jsRsaMathOps) exists for
 * jest, where the bridge is absent.
 */
import {NATIVE_BLIND_RSA} from '../config';
import {base64ToBytes} from '../util/base64';
import type {BlindResult, BlindRsaClient} from './blindrsa';
import {RealBlindRsa} from './blindrsaReal';
import {
  HASHES,
  bigIntToBytes,
  bytesToBigInt,
  emsaPssVerify,
  mgf1,
  parseSpkiRsa,
} from './webcryptoShim';
import {isNativeRsaMathAvailable, nativeRsaMathOps, type RsaMathOps} from './rsaMath';

/** RSABSSA-SHA384-PSS-Deterministic salt length — matches the issuer and the relay's verifier. */
const SALT_LEN = 48;

/** Sanity bound on drawing a blinding factor r ∈ [1, n). A uniform k-byte draw lands ≥ n with
 *  probability up to ~1/2 (an RSA modulus can sit just above 2^(bits-1)), so range rejections are
 *  ROUTINE — the bound exists only so broken key material can't loop forever. 128 straight
 *  rejections has probability ≤ 2⁻¹²⁸ with any real modulus; non-invertible r (gcd ≠ 1) is rarer
 *  still (≈ 2⁻¹⁰²⁴). */
const MAX_R_ATTEMPTS = 128;

interface ParsedKey {
  n: bigint;
  e: bigint;
  modBits: number;
}

interface FastState {
  inv: bigint;
  key: ParsedKey;
  preparedMsg: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) {
    size += p.length;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * EMSA-PSS-ENCODE (RFC 8017 §9.1.1) with SHA-384 — the encode-side twin of webcryptoShim's
 * emsaPssVerify, reusing the same MGF1/hash primitives so the two sides can never drift.
 */
function emsaPssEncode(msg: Uint8Array, emBits: number, salt: Uint8Array): Uint8Array {
  const h = HASHES['SHA-384'];
  const hLen = h.hLen;
  const sLen = salt.length;
  const emLen = Math.ceil(emBits / 8);
  if (emLen < hLen + sLen + 2) {
    throw new Error('emsaPssEncode: encoding error (modulus too small for hash + salt)');
  }
  const mHash = h.fn(msg);
  // M' = 0x00×8 || mHash || salt ; H = Hash(M')
  const hVal = h.fn(concat(new Uint8Array(8), mHash, salt));
  // DB = PS(zeros) || 0x01 || salt, masked by MGF1(H)
  const dbLen = emLen - hLen - 1;
  const db = new Uint8Array(dbLen);
  db[dbLen - sLen - 1] = 0x01;
  db.set(salt, dbLen - sLen);
  const dbMask = mgf1(hVal, dbLen, h);
  for (let i = 0; i < dbLen; i++) {
    db[i] = (db[i] ?? 0) ^ (dbMask[i] ?? 0);
  }
  // Clear the leftmost 8·emLen − emBits bits so EM < 2^emBits (and thus < n).
  const zeroBits = 8 * emLen - emBits;
  if (zeroBits > 0) {
    db[0] = (db[0] ?? 0) & (0xff >> zeroBits);
  }
  return concat(db, hVal, Uint8Array.of(0xbc));
}

function defaultRandomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

export class FastBlindRsa implements BlindRsaClient {
  /** Parsed issuer key per base64 DER — the same per-batch parse-once win RealBlindRsa has. */
  private readonly parsedKeys = new Map<string, ParsedKey>();

  constructor(
    private readonly ops: RsaMathOps,
    /** Test seam only — production uses crypto.getRandomValues (react-native-get-random-values). */
    private readonly randomBytes: (len: number) => Uint8Array = defaultRandomBytes,
  ) {}

  private key(issuerPublicKeyB64: string): ParsedKey {
    let parsed = this.parsedKeys.get(issuerPublicKeyB64);
    if (!parsed) {
      const {n, e} = parseSpkiRsa(base64ToBytes(issuerPublicKeyB64));
      parsed = {n, e, modBits: n.toString(2).length};
      this.parsedKeys.set(issuerPublicKeyB64, parsed);
    }
    return parsed;
  }

  async blind(issuerPublicKeyB64: string, token: Uint8Array): Promise<BlindResult> {
    const key = this.key(issuerPublicKeyB64);
    const {n, e, modBits} = key;
    const k = Math.ceil(modBits / 8);
    // Deterministic variant: prepare() is the identity — the prepared message IS the token.
    const preparedMsg = token;
    const em = emsaPssEncode(preparedMsg, modBits - 1, this.randomBytes(SALT_LEN));
    const m = bytesToBigInt(em);

    for (let attempt = 0; attempt < MAX_R_ATTEMPTS; attempt++) {
      // Uniform r ∈ [1, n) by rejection; a draw ≥ n (or 0) just resamples.
      const r = bytesToBigInt(this.randomBytes(k));
      if (r === 0n || r >= n) {
        continue;
      }
      let inv: bigint;
      let z: bigint;
      try {
        ({inv, z} = await this.ops.blindOps(r, e, m, n));
      } catch {
        continue; // gcd(r, n) ≠ 1 — astronomically rare with a real modulus; resample.
      }
      const state: FastState = {inv, key, preparedMsg};
      return {
        prepared: preparedMsg,
        blinded: bigIntToBytes(z, k),
        state,
        // RFC 9474's `inv` as I2OSP(r⁻¹, k) — byte-identical to blindrsa-ts, so durable draw
        // markers interop across FastBlindRsa and RealBlindRsa in both directions (F10).
        blindingSecret: bigIntToBytes(inv, k),
      };
    }
    throw new Error('blind: could not draw an invertible blinding factor — issuer key is malformed');
  }

  async finalize(state: unknown, blindSignature: Uint8Array): Promise<Uint8Array> {
    const {inv, key, preparedMsg} = state as FastState;
    const {n, e, modBits} = key;
    const k = Math.ceil(modBits / 8);
    if (blindSignature.length !== k) {
      throw new Error('finalize: blind signature length mismatch');
    }
    const zSig = bytesToBigInt(blindSignature);
    if (zSig >= n) {
      throw new Error('finalize: blind signature out of range');
    }
    const {s, em} = await this.ops.finalizeOps(zSig, inv, e, n);
    const emBits = modBits - 1;
    let emBytes: Uint8Array;
    try {
      emBytes = bigIntToBytes(em, Math.ceil(emBits / 8));
    } catch {
      throw new Error('finalize: invalid blind signature');
    }
    // The same accept-or-throw contract as suite.finalize: never hand back an unverified signature.
    if (!emsaPssVerify(preparedMsg, emBytes, emBits, 'SHA-384', SALT_LEN)) {
      throw new Error('finalize: unblinded signature failed PSS verification');
    }
    return bigIntToBytes(s, k);
  }

  /** Reconstruct state from a durable draw marker's `prepared` + `blindingSecret` (F10) — accepts
   *  markers written by RealBlindRsa too (same `inv` byte format, see class doc). */
  async rebuildState(
    issuerPublicKeyB64: string,
    prepared: Uint8Array,
    blindingSecret: Uint8Array,
  ): Promise<unknown> {
    const state: FastState = {
      inv: bytesToBigInt(blindingSecret),
      key: this.key(issuerPublicKeyB64),
      preparedMsg: prepared,
    };
    return state;
  }
}

/**
 * The production BlindRsaClient: native-accelerated when the StiqRsaMath module is present and the
 * flag is on; the battle-tested RealBlindRsa otherwise (older APKs, or any build where the module
 * is missing — behavior is then byte-identical to before this change).
 *
 * `opsOverride` / `enabledOverride` exist ONLY for tests (same seam pattern as
 * nostr/nativeVerify.ts); production callers pass nothing.
 */
export function createBlindRsa(opsOverride?: RsaMathOps | null, enabledOverride?: boolean): BlindRsaClient {
  const enabled = enabledOverride ?? NATIVE_BLIND_RSA;
  if (!enabled) {
    return new RealBlindRsa();
  }
  if (opsOverride) {
    return new FastBlindRsa(opsOverride);
  }
  if (opsOverride === undefined && isNativeRsaMathAvailable()) {
    return new FastBlindRsa(nativeRsaMathOps());
  }
  return new RealBlindRsa();
}
