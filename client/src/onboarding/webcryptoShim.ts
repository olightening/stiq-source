/// <reference lib="dom" />
/* eslint-disable no-bitwise -- RSA/PSS, MGF1, DER and I2OSP/OS2IP are inherently bit/byte ops */
/**
 * Minimal pure-JS WebCrypto SubtleCrypto for the blind-RSA enrollment client.
 *
 * `@cloudflare/blindrsa-ts` (RFC 9474 RSABSSA-SHA384-PSS-Deterministic — the suite the relay's
 * cloudflare/circl verifier enforces) calls exactly four SubtleCrypto operations on the client's
 * blind() + finalize() path:
 *
 *   - importKey('spki', der, {name:'RSA-PSS', hash:'SHA-384'}, true, ['verify'])  → RSA public key
 *       (called by blindrsaReal.ts; the lib then reads key.algorithm.modulusLength / hash.name)
 *   - exportKey('jwk', key) → {n, e}   (base64url, decoded by sjcl to get the modulus & exponent)
 *   - digest('SHA-384', bytes) → hash  (mHash, H, and MGF1 inside EMSA-PSS-ENCODE)
 *   - verify({name:'RSA-PSS', saltLength:0}, key, sig, msg) → boolean
 *       (RSASSA-PSS-VERIFY, RFC 8017 §8.1.2/§9.1.2 — the final check finalize() trusts to reject a
 *        malformed or forged blind signature before it becomes a credential)
 *
 * Why pure JS instead of react-native-quick-crypto: Hermes ships no SubtleCrypto, and quick-crypto
 * 0.7.9 leaves RSA-PSS *verify* commented out (subtle.js `signVerify`), so finalize() would throw
 * `NotSupportedError`. quick-crypto also vendors a native OpenSSL .so that collides with op-sqlite's.
 * This shim removes that native dependency entirely: it runs identically in Hermes and Node and is
 * deterministically testable (see webcryptoShim.test.ts — full blind→sign→finalize→verify round-trip
 * plus a cross-check that the finalized signature also verifies under Node's native WebCrypto).
 *
 * The unlinkable blinding math stays in the audited cloudflare library; this only supplies the host
 * primitives it calls. getRandomValues is left to react-native-get-random-values (loaded earlier in
 * polyfills.js); this shim never needs randomness.
 *
 * Several primitives (SPKI DER parse, I2OSP/OS2IP, MGF1, EMSA-PSS-VERIFY) are exported for reuse by
 * blindrsaFast.ts — the native-accelerated blind-RSA client — so both blind-RSA paths share this one
 * implementation of the byte-level RSA plumbing rather than growing a divergent copy.
 */
import {sha1} from '@noble/hashes/sha1';
import {sha256} from '@noble/hashes/sha256';
import {sha384, sha512} from '@noble/hashes/sha512';
import {bytesToBase64} from '../util/base64';

export type HashName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
type HashFn = (msg: Uint8Array) => Uint8Array;

export interface HashInfo {
  fn: HashFn;
  hLen: number;
}

export const HASHES: Record<HashName, HashInfo> = {
  'SHA-1': {fn: sha1, hLen: 20},
  'SHA-256': {fn: sha256, hLen: 32},
  'SHA-384': {fn: sha384, hLen: 48},
  'SHA-512': {fn: sha512, hLen: 64},
};

/** The RSA public key produced by importKey('spki'); shaped to satisfy blindrsa-ts. */
interface RsaPublicKey {
  type: 'public';
  extractable: boolean;
  algorithm: {name: 'RSA-PSS'; modulusLength: number; hash: {name: HashName}};
  usages: string[];
  /** Modulus and exponent (big integers) plus their minimal big-endian byte forms (for JWK). */
  _n: bigint;
  _e: bigint;
  _nBytes: Uint8Array;
  _eBytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// Byte / big-integer helpers
// ---------------------------------------------------------------------------

function toU8(data: ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/** Fresh ArrayBuffer copy of a byte array (so callers can't see backing-store slack). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) {
    x = (x << 8n) | BigInt(b);
  }
  return x;
}

/** Big-endian, fixed `len` bytes (I2OSP). Throws if the integer does not fit. */
export function bigIntToBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error('integer too large for the requested byte length');
  }
  return out;
}

/** Strip leading zero bytes (JWK n/e are minimal big-endian). Keeps at least one byte. */
function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) {
    i++;
  }
  return bytes.subarray(i);
}

function bitLength(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

/** modpow with a small public exponent (e = 65537) — square-and-multiply. */
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

function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Minimal DER reader for an RSA SubjectPublicKeyInfo (SPKI)
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  contentOffset: number;
  end: number;
}

/** In-bounds byte read; throws on a truncated/malformed buffer rather than yielding undefined. */
function byteAt(buf: Uint8Array, i: number): number {
  const v = buf[i];
  if (v === undefined) {
    throw new Error('truncated DER');
  }
  return v;
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
  const tag = byteAt(buf, offset);
  let p = offset + 1;
  let len = byteAt(buf, p++);
  if (len & 0x80) {
    const nBytes = len & 0x7f;
    if (nBytes === 0 || nBytes > 4) {
      throw new Error('unsupported DER length');
    }
    len = 0;
    for (let i = 0; i < nBytes; i++) {
      len = (len << 8) | byteAt(buf, p++);
    }
  }
  const end = p + len;
  if (end > buf.length) {
    throw new Error('DER length exceeds buffer');
  }
  return {tag, contentOffset: p, end};
}

/**
 * Parse an RSA SPKI DER into (n, e). OID-agnostic: it skips the AlgorithmIdentifier entirely, so it
 * accepts both `rsaEncryption` (1.2.840.113549.1.1.1, what the issuer's Node export uses) and the
 * `id-RSASSA-PSS` OID without caring which.
 *
 *   SEQUENCE { AlgorithmIdentifier, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
 */
export function parseSpkiRsa(der: Uint8Array): {n: bigint; e: bigint; nBytes: Uint8Array; eBytes: Uint8Array} {
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error('SPKI: expected outer SEQUENCE');
  }
  const algId = readTlv(der, outer.contentOffset);
  if (algId.tag !== 0x30) {
    throw new Error('SPKI: expected AlgorithmIdentifier SEQUENCE');
  }
  const bitStr = readTlv(der, algId.end);
  if (bitStr.tag !== 0x03) {
    throw new Error('SPKI: expected subjectPublicKey BIT STRING');
  }
  // BIT STRING content starts with an "unused bits" octet (0 for a byte-aligned key).
  const rsaSeq = readTlv(der, bitStr.contentOffset + 1);
  if (rsaSeq.tag !== 0x30) {
    throw new Error('SPKI: expected RSAPublicKey SEQUENCE');
  }
  const intN = readTlv(der, rsaSeq.contentOffset);
  if (intN.tag !== 0x02) {
    throw new Error('SPKI: expected modulus INTEGER');
  }
  const intE = readTlv(der, intN.end);
  if (intE.tag !== 0x02) {
    throw new Error('SPKI: expected exponent INTEGER');
  }
  const nBytes = stripLeadingZeros(der.subarray(intN.contentOffset, intN.end));
  const eBytes = stripLeadingZeros(der.subarray(intE.contentOffset, intE.end));
  return {
    n: bytesToBigInt(nBytes),
    e: bytesToBigInt(eBytes),
    nBytes: new Uint8Array(nBytes),
    eBytes: new Uint8Array(eBytes),
  };
}

// ---------------------------------------------------------------------------
// EMSA-PSS-VERIFY (RFC 8017 §9.1.2) + MGF1
// ---------------------------------------------------------------------------

export function mgf1(seed: Uint8Array, maskLen: number, h: HashInfo): Uint8Array {
  const out = new Uint8Array(maskLen);
  const counter = new Uint8Array(4);
  let written = 0;
  let c = 0;
  while (written < maskLen) {
    counter[0] = (c >>> 24) & 0xff;
    counter[1] = (c >>> 16) & 0xff;
    counter[2] = (c >>> 8) & 0xff;
    counter[3] = c & 0xff;
    const block = h.fn(concat(seed, counter));
    const take = Math.min(block.length, maskLen - written);
    out.set(block.subarray(0, take), written);
    written += take;
    c++;
  }
  return out;
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

export function emsaPssVerify(
  message: Uint8Array,
  em: Uint8Array,
  emBits: number,
  hashName: HashName,
  sLen: number,
): boolean {
  const h = HASHES[hashName];
  const hLen = h.hLen;
  const emLen = em.length; // = ceil(emBits/8)
  const mHash = h.fn(message);

  // 3. If emLen < hLen + sLen + 2, inconsistent.
  if (emLen < hLen + sLen + 2) {
    return false;
  }
  // 4. Rightmost octet of EM must be 0xbc.
  if (em[emLen - 1] !== 0xbc) {
    return false;
  }
  // 5. maskedDB = leftmost (emLen - hLen - 1) octets; H = next hLen octets.
  const maskedDB = em.subarray(0, emLen - hLen - 1);
  const hVal = em.subarray(emLen - hLen - 1, emLen - 1);
  // 6. The leftmost (8*emLen - emBits) bits of maskedDB must be zero.
  const zeroBits = 8 * emLen - emBits;
  if (zeroBits > 0 && ((maskedDB[0] ?? 0) & (0xff << (8 - zeroBits) & 0xff)) !== 0) {
    return false;
  }
  // 7-9. dbMask = MGF1(H, emLen - hLen - 1); DB = maskedDB XOR dbMask.
  const dbMask = mgf1(hVal, emLen - hLen - 1, h);
  const db = new Uint8Array(maskedDB.length);
  for (let i = 0; i < db.length; i++) {
    db[i] = (maskedDB[i] ?? 0) ^ (dbMask[i] ?? 0);
  }
  // 10. Clear the leftmost (8*emLen - emBits) bits of the leftmost octet of DB.
  if (zeroBits > 0) {
    db[0] = (db[0] ?? 0) & (0xff >> zeroBits);
  }
  // 11. The leftmost emLen - hLen - sLen - 2 octets of DB must be zero, and the octet at
  //     position emLen - hLen - sLen - 2 (0-indexed) must be 0x01.
  const psLen = emLen - hLen - sLen - 2;
  for (let i = 0; i < psLen; i++) {
    if (db[i] !== 0) {
      return false;
    }
  }
  if (db[psLen] !== 0x01) {
    return false;
  }
  // 12. salt = last sLen octets of DB.
  const salt = db.subarray(db.length - sLen);
  // 13-14. M' = 0x00*8 || mHash || salt; H' = Hash(M'); valid iff H' == H.
  const mPrime = concat(new Uint8Array(8), mHash, salt);
  const hPrime = h.fn(mPrime);
  return constantTimeEqual(hPrime, hVal);
}

// ---------------------------------------------------------------------------
// SubtleCrypto surface
// ---------------------------------------------------------------------------

function normalizeHashName(hash: unknown): HashName {
  const name = typeof hash === 'string' ? hash : (hash as {name?: string})?.name;
  if (name && name in HASHES) {
    return name as HashName;
  }
  throw new Error(`unsupported hash: ${String(name)}`);
}

const subtle = {
  async importKey(
    format: string,
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: {name: string; hash: unknown},
    extractable: boolean,
    keyUsages: string[],
  ): Promise<RsaPublicKey> {
    if (format !== 'spki') {
      throw new Error(`importKey: only 'spki' is supported, got '${format}'`);
    }
    if (algorithm.name !== 'RSA-PSS') {
      throw new Error(`importKey: only 'RSA-PSS' is supported, got '${algorithm.name}'`);
    }
    const der = toU8(keyData);
    const {n, e, nBytes, eBytes} = parseSpkiRsa(der);
    return {
      type: 'public',
      extractable,
      algorithm: {
        name: 'RSA-PSS',
        modulusLength: bitLength(n),
        hash: {name: normalizeHashName(algorithm.hash)},
      },
      usages: keyUsages,
      _n: n,
      _e: e,
      _nBytes: nBytes,
      _eBytes: eBytes,
    };
  },

  async exportKey(format: string, key: RsaPublicKey): Promise<{kty: string; n: string; e: string; alg: string; ext: boolean; key_ops: string[]}> {
    if (format !== 'jwk') {
      throw new Error(`exportKey: only 'jwk' is supported, got '${format}'`);
    }
    if (!key.extractable) {
      throw new Error('exportKey: key is not extractable');
    }
    return {
      kty: 'RSA',
      n: base64url(key._nBytes),
      e: base64url(key._eBytes),
      alg: 'PS384',
      ext: key.extractable,
      key_ops: key.usages,
    };
  },

  async digest(algorithm: string | {name: string}, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    const hashName = normalizeHashName(algorithm);
    return toArrayBuffer(HASHES[hashName].fn(toU8(data)));
  },

  async verify(
    algorithm: {name: string; saltLength: number},
    key: RsaPublicKey,
    signature: ArrayBuffer | ArrayBufferView,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<boolean> {
    if (algorithm.name !== 'RSA-PSS') {
      throw new Error(`verify: only 'RSA-PSS' is supported, got '${algorithm.name}'`);
    }
    const sig = toU8(signature);
    const msg = toU8(data);
    const modBits = key.algorithm.modulusLength;
    const k = Math.ceil(modBits / 8);
    // RFC 8017 §8.1.2: a signature must be exactly k octets.
    if (sig.length !== k) {
      return false;
    }
    // RSAVP1: s must be in [0, n-1].
    const s = bytesToBigInt(sig);
    if (s >= key._n) {
      return false;
    }
    const m = modPow(s, key._e, key._n);
    const emBits = modBits - 1;
    const emLen = Math.ceil(emBits / 8);
    let em: Uint8Array;
    try {
      em = bigIntToBytes(m, emLen);
    } catch {
      return false; // representative does not fit emLen octets
    }
    return emsaPssVerify(msg, em, emBits, key.algorithm.hash.name, algorithm.saltLength);
  },
};

/**
 * Install the shim as `global.crypto.subtle` if no SubtleCrypto is already present. Called from
 * polyfills.js after react-native-get-random-values has set up `global.crypto.getRandomValues`.
 * Idempotent and defensive: a host that already provides a real `crypto.subtle` (e.g. Node in
 * tests) is left untouched.
 */
export function installWebCryptoShim(): void {
  const g = globalThis as unknown as {crypto?: {subtle?: unknown}};
  if (!g.crypto) {
    g.crypto = {};
  }
  if (g.crypto.subtle) {
    return; // a real SubtleCrypto is already available
  }
  try {
    g.crypto.subtle = subtle;
  } catch {
    // crypto object is frozen — define the property directly.
    Object.defineProperty(g.crypto, 'subtle', {value: subtle, configurable: true, writable: true});
  }
}

/** Exposed for tests so they can exercise the shim without mutating the global. */
export const webCryptoShimSubtle = subtle;
