/**
 * Compact Fuzzy Message Detection (FMD) over secp256k1 — EVAL-ONLY research module (T18-S1).
 *
 * Implements the compact construction of Beck–Len–Miers–Green, "Fuzzy Message Detection"
 * (CCS 2021, §5): a receiver publishes a γ-subkey public key; a sender attaches a small "flag"
 * ciphertext to each message; a receiver hands a *detection key* revealing the first `n` of its γ
 * secret subkeys to an untrusted detector, which can then decide membership with a TUNABLE false
 * positive rate p = 2^-n. A true recipient always matches (zero false negatives); a non-recipient
 * matches with probability exactly 2^-n, yielding a fuzzy anonymity set (true positives buried in
 * decoys) whose size the receiver dials via `n`.
 *
 * This module is PURE and wired to nothing (T18 is spike-not-production): the DM/mention call-site
 * guard, simulation harness, and README arrive in later T18 subtasks. It reuses ONLY crypto deps
 * already pinned in the tree — secp256k1 group/scalar ops from @noble/curves and sha256 from
 * '@noble/hashes/sha2.js' (the v2 path, identical to client/src/dm/dm.ts:16 — NEVER the
 * '@noble/hashes/sha256' v1 subpath, per the "@noble/hashes trap" in BUILDING.md).
 *
 * Compact scheme recap (γ subkeys, one group element + one scalar + γ cipher-bits per flag):
 *   KeyGen:  x_i ← Z_q,  H_i = g^{x_i}          (i ∈ [0, γ))
 *   Flag(pk): r,z ← Z_q; u = g^r; w = g^z
 *             k_i = Hash(u, H_i^r, w) & 1;  c_i = k_i ⊕ 1     (encrypt the constant 1-bit)
 *             m = Hash(u, bits) mod q;  y = (z − m) · r^{-1} mod q
 *             flag = (u, y, bits)
 *   Test(dk): U = u;  m = Hash(u, bits) mod q;  W = g^m · U^y   (= g^{m + r·(z−m)/r} = g^z = w)
 *             for i<n: k_i' = Hash(u, U^{x_i}, W) & 1; require c_i ⊕ k_i' == 1  → else reject
 * The single (u, w = g^z, y) triple lets the detector reconstruct the SAME w the sender hashed
 * without learning z, so every subkey shares one Schnorr-style opening — that is what makes the
 * flag "compact" (γ-independent group elements).
 */
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToNumberBE, numberToBytesBE} from '@noble/curves/utils.js';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, concatBytes} from '@noble/hashes/utils.js';
import {randomBytes} from '../../util/random';

/** secp256k1 point group (v2 @noble/curves: `Point`, not the v1 `ProjectivePoint`). */
const Point = secp256k1.Point;
/** Generator g. */
const G = Point.BASE;
/** Scalar field Z_q (v2 exposes the group order + modular ops via `Point.Fn`: `create` reduces
 *  mod q, `inv` is the modular inverse, `mul` multiplies mod q). */
const Fn = Point.Fn;

/**
 * Number of subkeys γ. Detection precision `n` ranges over 1..γ, so γ bounds the smallest
 * achievable false-positive rate 2^-γ. 24 gives p as low as 2^-24 while keeping the flag tiny
 * (⌈24/8⌉ = 3 cipher-bytes ⇒ 68-byte flag; see {@link flagByteLength}).
 */
export const FMD_GAMMA = 24;

/** A receiver's FMD keypair. `pk[i]` is the 33-byte compressed g^{x_i}; `sk[i]` its scalar x_i. */
export interface FmdKeypair {
  sk: bigint[];
  pk: Uint8Array[];
  gamma: number;
}

/** A detection key: the first `n` secret subkeys, handed to a detector for p = 2^-n matching. */
export interface FmdDetectionKey {
  n: number;
  sk: bigint[];
}

/** A flag ciphertext. `u` = 33-byte compressed g^r; `y` scalar; `bits` = ⌈γ/8⌉ packed cipher-bits. */
export interface FmdFlag {
  u: Uint8Array;
  y: bigint;
  bits: Uint8Array;
}

/** Draw a uniform non-zero scalar in Z_q via the app CSPRNG (same source as dm.ts): 32 random
 *  bytes reduced mod q, rejecting 0. Reduction bias is negligible (q ≈ 2^256). */
function randScalarDefault(): bigint {
  for (;;) {
    const s = Fn.create(bytesToNumberBE(randomBytes(32)));
    if (s !== 0n) return s;
  }
}

/** 33-byte compressed encoding of a point. */
function encode(P: InstanceType<typeof Point>): Uint8Array {
  return P.toBytes(true);
}

/** Decode a 33-byte compressed point (v2: `fromBytes` for bytes; `fromHex` now expects a string). */
function decode(bytes: Uint8Array): InstanceType<typeof Point> {
  return Point.fromBytes(bytes);
}

/**
 * Decode + precompute-cache a recipient's public subkey H_i. Output is a pure function of the
 * bytes (deterministic), so caching changes nothing but speed. The real DM/mention workload flags
 * the SAME recipient set repeatedly, and each flag multiplies every H_i by a fresh `r`; caching the
 * decoded point with a primed wNAF table turns those from ~10ms variable-base mults into ~1ms
 * table lookups. Eval-only harness ⇒ the map is unbounded (recipient sets are tiny in practice).
 */
const recipientPointCache = new Map<string, InstanceType<typeof Point>>();
function decodeRecipientSubkey(bytes: Uint8Array): InstanceType<typeof Point> {
  const key = bytesToHex(bytes);
  let P = recipientPointCache.get(key);
  if (P === undefined) {
    P = Point.fromBytes(bytes);
    P.precompute(); // prime the wNAF table (lazy build on first multiply); amortized over many flags
    recipientPointCache.set(key, P);
  }
  return P;
}

/** Hash a tuple of byte-strings to a single bit: LSB of sha256(part_0 ‖ … ‖ part_k). */
function hashBit(...parts: Uint8Array[]): number {
  return sha256(concatBytes(...parts))[0]! & 1;
}

/** Set cipher-bit `i` (LSB-first within each byte). `bits` is assumed zero-initialised. */
function setBit(bits: Uint8Array, i: number): void {
  const j = i >> 3;
  bits[j] = (bits[j] ?? 0) | (1 << (i & 7));
}

/** Read cipher-bit `i` (LSB-first within each byte) → 0 or 1. */
function getBit(bits: Uint8Array, i: number): number {
  return ((bits[i >> 3] ?? 0) >> (i & 7)) & 1;
}

/**
 * Generate a fresh FMD keypair with `gamma` subkeys. Each subkey is an independent secp256k1
 * keypair (x_i, g^{x_i}); the compressed public subkeys are what a sender needs to build flags.
 */
export function generateFmdKeypair(gamma: number = FMD_GAMMA): FmdKeypair {
  if (!Number.isInteger(gamma) || gamma <= 0) {
    throw new Error(`FMD gamma must be a positive integer, got ${gamma}`);
  }
  const sk: bigint[] = [];
  const pk: Uint8Array[] = [];
  for (let i = 0; i < gamma; i++) {
    const x = randScalarDefault();
    sk.push(x);
    pk.push(encode(G.multiply(x)));
  }
  return {sk, pk, gamma};
}

/**
 * Extract a detection key at precision `n`: the first `n` secret subkeys. Revealing `n` subkeys
 * fixes the detector's false-positive rate at p = 2^-n (a non-recipient passes all `n` bit-checks
 * by chance with probability 2^-n). Larger `n` ⇒ smaller fuzzy set, weaker sender-side privacy.
 */
export function extractDetectionKey(kp: FmdKeypair, n: number): FmdDetectionKey {
  if (!Number.isInteger(n) || n <= 0 || n > kp.gamma) {
    throw new Error(`FMD detection precision n must satisfy 0 < n <= gamma(${kp.gamma}), got ${n}`);
  }
  return {n, sk: kp.sk.slice(0, n)};
}

/**
 * Build a flag for the receiver whose compressed public subkeys are `pk` (length = γ). Each
 * cipher-bit encrypts the constant 1 under subkey i's shared secret H_i^r, so a true recipient
 * recovers all-ones and matches, while anyone else recovers effectively-random bits.
 *
 * `randScalar` is injectable purely so tests can drive it deterministically (counter-based); it
 * defaults to the CSPRNG and MUST return a uniform non-zero scalar in Z_q in production.
 */
export function flag(pk: Uint8Array[], randScalar: () => bigint = randScalarDefault): FmdFlag {
  const gamma = pk.length;
  const r = randScalar();
  const z = randScalar();
  const u = G.multiply(r);
  const w = G.multiply(z);
  const uEnc = encode(u);
  const wEnc = encode(w);

  const bits = new Uint8Array(Math.ceil(gamma / 8));
  for (let i = 0; i < gamma; i++) {
    const Hi = decodeRecipientSubkey(pk[i]!);
    const ki = hashBit(uEnc, encode(Hi.multiply(r)), wEnc);
    if ((ki ^ 1) === 1) setBit(bits, i);
  }

  // m ties the Schnorr-style opening (u, y) to the cipher-bits so the detector cannot mix a flag's
  // opening with another's bits: m = H(u ‖ bits), y = (z − m)·r^{-1}, giving g^m·u^y = g^z = w.
  const m = Fn.create(bytesToNumberBE(sha256(concatBytes(uEnc, bits))));
  const y = Fn.mul(Fn.create(z - m), Fn.inv(r));
  return {u: uEnc, y, bits};
}

/**
 * Test a flag against a detection key. Returns true if all `dk.n` revealed subkeys decrypt to the
 * constant 1-bit. A genuine recipient returns true for every one of its own flags at any n ≤ γ
 * (zero false negatives); a non-recipient returns true with probability 2^-n.
 */
export function testFlag(dk: FmdDetectionKey, fl: FmdFlag): boolean {
  const U = decode(fl.u);
  // U is fresh per flag but multiplied n+1 times below (U^y and U^{x_i}); a small wNAF window
  // (built lazily on first multiply) amortizes those without an expensive full-window table.
  U.precompute(4);
  const m = Fn.create(bytesToNumberBE(sha256(concatBytes(fl.u, fl.bits))));
  // Reconstruct w = g^z without knowing z: W = g^m · U^y.
  const W = G.multiply(m).add(U.multiply(fl.y));
  const wEnc = encode(W);
  for (let i = 0; i < dk.n; i++) {
    const ki = hashBit(fl.u, encode(U.multiply(dk.sk[i]!)), wEnc);
    const ci = getBit(fl.bits, i);
    if ((ci ^ ki) !== 1) return false;
  }
  return true;
}

/** The false-positive rate p = 2^-n a detection key of precision `n` yields (reporting helper). */
export function falsePositiveRate(n: number): number {
  return Math.pow(2, -n);
}

/** Serialized flag size in bytes: u(33) + y(32) + ⌈γ/8⌉ cipher-bytes. flagByteLength(24) === 68. */
export function flagByteLength(gamma: number = FMD_GAMMA): number {
  return 33 + 32 + Math.ceil(gamma / 8);
}

/** Serialize a flag to the fixed layout [ u(33) | y(32, big-endian) | bits(⌈γ/8⌉) ]. */
export function serializeFlag(fl: FmdFlag): Uint8Array {
  const out = new Uint8Array(33 + 32 + fl.bits.length);
  out.set(fl.u, 0);
  out.set(numberToBytesBE(fl.y, 32), 33);
  out.set(fl.bits, 65);
  return out;
}

/** Inverse of {@link serializeFlag}; `gamma` fixes the cipher-bit length ⌈γ/8⌉ to slice. */
export function deserializeFlag(buf: Uint8Array, gamma: number): FmdFlag {
  const bitsLen = Math.ceil(gamma / 8);
  const expected = 33 + 32 + bitsLen;
  if (buf.length !== expected) {
    throw new Error(`FMD flag buffer length ${buf.length} != expected ${expected} for gamma ${gamma}`);
  }
  return {
    u: buf.slice(0, 33),
    y: bytesToNumberBE(buf.slice(33, 65)),
    bits: buf.slice(65, 65 + bitsLen),
  };
}
