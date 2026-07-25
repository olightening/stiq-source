/* eslint-disable no-bitwise -- byte/bigint math mirrors the shim under test */
/**
 * Validates the pure-JS WebCrypto shim (webcryptoShim.ts) against Node's native WebCrypto as an
 * oracle. The shim backs @cloudflare/blindrsa-ts on Hermes (which ships no SubtleCrypto); these
 * tests prove the four operations the blind-RSA client relies on are byte-compatible with a real
 * WebCrypto, and that the full RFC 9474 round-trip produces a signature a native verifier accepts.
 *
 * Covered:
 *  - importKey('spki') + exportKey('jwk') parity against native, incl. the sample issuer key
 *  - digest('SHA-384') parity
 *  - verify(RSA-PSS) accepts native signatures and rejects tampered ones
 *  - the production RealBlindRsa.blind/finalize path, end-to-end, verified natively
 */
import {webCryptoShimSubtle} from './webcryptoShim';
import {RealBlindRsa} from './blindrsaReal';
import {base64ToBytes, bytesToBase64} from '../util/base64';

// The live issuer's RSA-2048 public key (SPKI DER, base64) — pulled from
// /opt/stiq-organizer/issuer/issuer_private.pem via `openssl rsa -pubout -outform DER`.
const SAMPLE_ISSUER_SPKI_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp+Wh3BIjhSHOxVS8RlEWMpC9bSceiqf5Es+nC/NcdVpE7RKDVdo/T1AmspFfiQ1Z8YUC9zG5lI7oNXk7sf5PdVODQPV/S+GBV/EzyZ+9jEMdM3Y5ttX3yOpouYfHguhs5p0ZEAOnGL3mSybsO380e7llrQDqKPbDUoY5GCeujgyn6DNnFA72QevxWsuz9BGtkONdoUlNkr/Qaw2jbvl+aoHzffmQdd+S1v/AIt0dVX/yxR4Xy1KKWKX4A0G8D+Qs+3hA77Ckl02nVxk4t6pe+ZKTdDlkLlzrt5AVSkDd95O6RRjGdkgYuz9IUAzUM3LmBjkXyLrwudU1Iz0NJhbQjQIDAQAB';

// Node's native WebCrypto — the reference oracle. Available in the Jest node environment.
const NODE: Crypto = require('crypto').webcrypto;

const RSA_PSS_384 = {name: 'RSA-PSS', hash: 'SHA-384'} as const;
// RSABSSA-SHA384-PSS-Deterministic uses a 48-byte PSS salt ("Deterministic" refers to the prepare
// step having no random message prefix, NOT a zero salt). This is the value the issuer signs with
// and the relay's circl verifier enforces.
const SALT_LEN = 48;

function b64urlToBigInt(b64url: string): bigint {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToBytes(b64);
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

function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) {
    x = (x << 8n) | BigInt(b);
  }
  return x;
}

/** Fresh ArrayBuffer copy — satisfies Node's strict BufferSource (ArrayBufferView<ArrayBuffer>). */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.length);
  new Uint8Array(out).set(u);
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

/**
 * Run `fn` with the shim installed as the global SubtleCrypto, restoring the real one after. The
 * fake global keeps native getRandomValues (the blinding factor needs it) but routes
 * digest/exportKey/verify to the shim — exactly the Hermes runtime configuration.
 */
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

/** Issuer-side blind signature: raw RSADP (s = m^d mod n) — exactly what suite.blindSign computes. */
async function rawBlindSign(privateKey: CryptoKey, blindedMsg: Uint8Array, kLen: number): Promise<Uint8Array> {
  const jwk = await NODE.subtle.exportKey('jwk', privateKey);
  const n = b64urlToBigInt(jwk.n!);
  const d = b64urlToBigInt(jwk.d!);
  const m = bytesToBigInt(blindedMsg);
  return bigIntToBytes(modPow(m, d, n), kLen);
}

describe('webcryptoShim', () => {
  let pubNative: CryptoKey;
  let privNative: CryptoKey;
  let spkiDer: Uint8Array;
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
    spkiDer = new Uint8Array(await NODE.subtle.exportKey('spki', pubNative));
    issuerPubB64 = bytesToBase64(spkiDer);
  });

  test('importKey + exportKey jwk matches native (generated key)', async () => {
    const shimKey = await webCryptoShimSubtle.importKey('spki', spkiDer, RSA_PSS_384, true, ['verify']);
    expect(shimKey.algorithm.modulusLength).toBe(2048);
    expect(shimKey.algorithm.hash.name).toBe('SHA-384');
    const jwkShim = await webCryptoShimSubtle.exportKey('jwk', shimKey);
    const jwkNative = await NODE.subtle.exportKey('jwk', pubNative);
    expect(jwkShim.n).toBe(jwkNative.n);
    expect(jwkShim.e).toBe(jwkNative.e);
  });

  test('importKey + exportKey jwk matches native (sample issuer key)', async () => {
    const der = base64ToBytes(SAMPLE_ISSUER_SPKI_B64);
    const shimKey = await webCryptoShimSubtle.importKey('spki', der, RSA_PSS_384, true, ['verify']);
    expect(shimKey.algorithm.modulusLength).toBe(2048);
    const jwkShim = await webCryptoShimSubtle.exportKey('jwk', shimKey);
    const nativeKey = await NODE.subtle.importKey('spki', ab(der), RSA_PSS_384, true, ['verify']);
    const jwkNative = await NODE.subtle.exportKey('jwk', nativeKey);
    expect(jwkShim.n).toBe(jwkNative.n);
    expect(jwkShim.e).toBe(jwkNative.e);
  });

  test('digest SHA-384 matches native', async () => {
    const msg = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
    const shimHash = new Uint8Array(await webCryptoShimSubtle.digest('SHA-384', msg));
    const nativeHash = new Uint8Array(await NODE.subtle.digest('SHA-384', msg));
    expect(Buffer.from(shimHash).toString('hex')).toBe(Buffer.from(nativeHash).toString('hex'));
  });

  test('verify accepts a native RSA-PSS signature and rejects tampering / salt mismatch', async () => {
    const msg = new TextEncoder().encode('enrollment token #42');
    const sig = new Uint8Array(
      await NODE.subtle.sign({name: 'RSA-PSS', saltLength: SALT_LEN}, privNative, msg),
    );
    const shimKey = await webCryptoShimSubtle.importKey('spki', spkiDer, RSA_PSS_384, true, ['verify']);

    expect(await webCryptoShimSubtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, shimKey, sig, msg)).toBe(true);

    const tampered = sig.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(await webCryptoShimSubtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, shimKey, tampered, msg)).toBe(false);

    const wrongMsg = new TextEncoder().encode('enrollment token #43');
    expect(await webCryptoShimSubtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, shimKey, sig, wrongMsg)).toBe(false);

    // A salt-0 signature must NOT verify when 48 bytes of salt are expected (salt-length sensitivity).
    const sig0 = new Uint8Array(await NODE.subtle.sign({name: 'RSA-PSS', saltLength: 0}, privNative, msg));
    expect(await webCryptoShimSubtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, shimKey, sig0, msg)).toBe(false);
  });

  test('RealBlindRsa.blind/finalize round-trips and verifies natively', async () => {
    const token = new Uint8Array(32);
    NODE.getRandomValues(token);

    const client = new RealBlindRsa();
    const {prepared, blinded, state} = await withShimGlobal(() => client.blind(issuerPubB64, token));
    // Deterministic variant: the prepared message is the token itself.
    expect(Buffer.from(prepared).toString('hex')).toBe(Buffer.from(token).toString('hex'));
    // Blinding actually changed the bytes shown to the issuer.
    expect(blinded.length).toBe(kLen);

    const blindSig = await rawBlindSign(privNative, blinded, kLen);
    const sig = await withShimGlobal(() => client.finalize(state, blindSig));

    expect(sig.length).toBe(kLen);
    // The unblinded signature must verify under the issuer's public key with a NATIVE verifier —
    // this is the exact check the Go relay's cloudflare/circl verifier performs.
    const ok = await NODE.subtle.verify({name: 'RSA-PSS', saltLength: SALT_LEN}, pubNative, ab(sig), ab(prepared));
    expect(ok).toBe(true);
  });

  test('finalize rejects a corrupted blind signature', async () => {
    const token = new Uint8Array(32);
    NODE.getRandomValues(token);
    const client = new RealBlindRsa();
    const {state} = await withShimGlobal(() => client.blind(issuerPubB64, token));
    const bogus = new Uint8Array(kLen); // all-zero "signature"
    await expect(withShimGlobal(() => client.finalize(state, bogus))).rejects.toThrow();
  });
});
