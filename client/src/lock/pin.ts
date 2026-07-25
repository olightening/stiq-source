/**
 * Dual-PIN vault (PLAN.md §3.5 / Step 10).
 *
 * Two PIN slots are registered: a standard PIN and a duress PIN. `verify` classifies an
 * entered PIN as 'standard', 'duress', or 'invalid' — it performs NO destructive action.
 * Step 11 wires the duress classification to the wipe. PINs are stored salted-and-hashed in
 * the hardware-backed SecureStorage (defense in depth on top of at-rest encryption).
 *
 * KDF (security finding #20): PINs are low-entropy, so a single fast SHA-256 gives no
 * post-compromise resistance if the stored blob leaks. The default KDF is therefore a salted,
 * high-iteration **PBKDF2-HMAC-SHA256** over a per-PIN random salt, run in NATIVE code
 * (nativeKdf.ts → StiqKdfModule, hardware-accelerated). This replaced a pure-JS scrypt KDF that
 * measured ~11 SECONDS per unlock on-device in Hermes (cost is linear in the work factor, so no
 * JS-cheap parameter was both secure and instant); native PBKDF2 keeps a real iterated KDF while
 * unlocking in tens of ms. The blob carries a scheme tag so the KDF is self-described and upgradable
 * behind a new tag: the current tag is `pbk1`; an older `scrypt1` blob (pure-JS scrypt) OR a legacy
 * `salt:hash` (single-SHA-256) blob is still verified with its original KDF and transparently
 * re-sealed to `pbk1` on the next successful entry (migration — never locks an existing user out; the
 * one migrating unlock still pays the old KDF's cost once). Rate-limiting is enforced by an injected
 * {@link PinAttemptLimiter} (finding #21). The `HashFn` remains injectable so tests substitute a
 * fast hash.
 */
import {sha256} from '@noble/hashes/sha2.js';
import {scryptAsync} from '@noble/hashes/scrypt.js';
import type {SecureStorage} from '../keys/keystore';
import {bytesToHex, hexToBytes} from '../util/hex';
import {randomBytes} from '../util/random';
import {PinAttemptLimiter} from './attemptLimiter';
import {nativePinHash} from './nativeKdf';

export type PinVerifyResult = 'standard' | 'duress' | 'invalid';

export type HashFn = (data: Uint8Array) => Promise<Uint8Array>;

const STANDARD_ITEM = 'stiq.pin.standard';
const DURESS_ITEM = 'stiq.pin.duress';
const SALT_BYTES = 16;

/**
 * Scheme tags prefixing a 3-part sealed blob (`<scheme>:saltHex:digestHex`). An untagged 2-part blob
 * is the oldest single-SHA-256 format. `KDF_SCHEME` is the CURRENT scheme new blobs are sealed under;
 * older tags stay verifiable and auto-upgrade to it on the next successful entry.
 */
const KDF_SCHEME_PBKDF2 = 'pbk1'; // current: native PBKDF2-HMAC-SHA256 (nativeKdf.ts)
const KDF_SCHEME_SCRYPT1 = 'scrypt1'; // legacy: pure-JS scrypt N=16384 (verify + upgrade only)
const KDF_SCHEME = KDF_SCHEME_PBKDF2;

/**
 * scrypt cost parameters (finding #20). Tuned for a mobile-acceptable unlock latency in pure-JS
 * Hermes (scryptAsync yields, so it never freezes the UI) while being orders of magnitude slower
 * than a single hash and memory-hard (GPU-unfriendly). Self-described by the `scrypt1` scheme tag,
 * so raising them later is a matter of bumping the tag and letting verify re-seal on next entry.
 */
const SCRYPT_N = 16384; // 2^14 — legacy scrypt cost (verify-only; see scryptPinKdf)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
/** Domain-separation salt for the legacy scrypt KDF; per-PIN entropy is the salt prepended to `data`. */
const KDF_DOMAIN = 'stiq.pin.kdf.v1';

/** Legacy pre-#20 PIN hash: a single SHA-256. Retained to verify (then upgrade) old 2-part blobs. */
export const webcryptoSha256: HashFn = async data => sha256(data);

/**
 * Legacy `scrypt1` KDF: pure-JS scrypt over (per-PIN-salt ‖ pin). Retained ONLY to verify an existing
 * scrypt1 blob and re-seal it to the native `pbk1` KDF — NOT used to seal new blobs (it is the
 * ~11-seconds-per-unlock cost on-device that motivated the native KDF).
 */
export const scryptPinKdf: HashFn = async data =>
  scryptAsync(data, utf8(KDF_DOMAIN), {N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_DKLEN});

type KdfScheme = 'pbk1' | 'scrypt1' | 'sha256';

interface ParsedBlob {
  salt: Uint8Array;
  digest: Uint8Array;
  /** Which KDF sealed this blob — selects the verifier and whether an upgrade to KDF_SCHEME is due. */
  scheme: KdfScheme;
}

/** Parse a stored PIN blob into its salt/digest + KDF scheme. A 3-part blob is tagged (`pbk1`/
 *  `scrypt1`); an untagged 2-part blob is the oldest single-SHA-256 format. */
function parseBlob(stored: string): ParsedBlob | null {
  const parts = stored.split(':');
  if (parts.length === 3 && (parts[0] === KDF_SCHEME_PBKDF2 || parts[0] === KDF_SCHEME_SCRYPT1)) {
    return {salt: hexToBytes(parts[1]!), digest: hexToBytes(parts[2]!), scheme: parts[0] as KdfScheme};
  }
  if (parts.length === 2) {
    return {salt: hexToBytes(parts[0]!), digest: hexToBytes(parts[1]!), scheme: 'sha256'};
  }
  return null;
}

export class PinVault {
  /**
   * Session cache of the stored `salt:hash` blobs, keyed by slot item. This lets a lock-screen
   * session avoid a hardware-keystore read per PIN attempt AND stop probing a duress slot that was
   * never configured (a `null` is cached and short-circuits {@link matches}). The PinVault is a
   * long-lived singleton (one per AppRuntime), so the cache lives exactly for the lock session.
   *
   * SECURITY: this caches ONLY the already-at-hand verification blob (a salted KDF digest of the PIN,
   * NOT the PIN and NOT reversible), which the previous code already loaded into the JS heap on every
   * attempt — the change is residency (whole session vs. per-attempt), not exposure of new material.
   * No PIN, salt-less hash, or raw key is ever cached. The cache is invalidated whenever the stored
   * blobs change ({@link setPins}, {@link clear}) so a rotated/removed PIN never verifies from stale
   * state, and cleared on {@link forgetCached} for callers that want to drop it early.
   */
  private readonly storedCache = new Map<string, string | null>();

  constructor(
    private readonly storage: SecureStorage,
    private readonly hash: HashFn = nativePinHash,
    /**
     * Brute-force throttle (finding #21). Defaults to a persistent limiter over the same secure
     * storage so every production PIN surface is rate-limited; pass a limiter with an injected clock
     * to drive lockout deterministically in tests.
     */
    private readonly limiter: PinAttemptLimiter | null = new PinAttemptLimiter(storage),
  ) {}

  /** Read a slot's stored blob, serving from (and populating) the session cache. */
  private async readStored(item: string): Promise<string | null> {
    const cached = this.storedCache.get(item);
    if (cached !== undefined) {
      return cached;
    }
    const stored = await this.storage.getItem(item);
    this.storedCache.set(item, stored);
    return stored;
  }

  /** Drop the session cache (e.g. on lock, so the next unlock re-reads from the keystore). */
  forgetCached(): void {
    this.storedCache.clear();
  }

  /**
   * Register the standard (unlock) PIN, and OPTIONALLY a distinct duress PIN.
   *
   * Onboarding sets only the unlock PIN — the duress (panic-wipe) PIN is opt-in and configured
   * later from Settings. When a duress PIN is supplied it must differ from the standard one;
   * when it is omitted, any previously-stored duress slot is cleared so no stale value lingers.
   */
  async setPins(standardPin: string, duressPin?: string): Promise<void> {
    if (duressPin && standardPin === duressPin) {
      throw new Error('standard and duress PINs must differ');
    }
    await this.storage.setItem(STANDARD_ITEM, await this.seal(standardPin));
    if (duressPin) {
      await this.storage.setItem(DURESS_ITEM, await this.seal(duressPin));
    } else {
      await this.storage.removeItem(DURESS_ITEM);
    }
    // The stored blobs changed — drop any cached copies so verify() re-reads the new values.
    this.storedCache.clear();
    // A deliberate PIN (re)set clears any brute-force lockout so a legitimate rotation starts fresh.
    await this.limiter?.reset();
  }

  /** True once an unlock PIN exists. The duress slot is optional and not required here. */
  async isConfigured(): Promise<boolean> {
    return (await this.readStored(STANDARD_ITEM)) !== null;
  }

  /**
   * Classify an entered PIN. No destructive action, but it DOES advance the brute-force limiter
   * (finding #21): a wrong PIN increments the failure counter and, past the free allowance, arms an
   * escalating lockout during which even a correct STANDARD PIN is rejected without being checked; a
   * correct PIN clears the counter.
   *
   * ANTI-COERCION EXCEPTION (finding M2): the lockout gates ONLY the standard-unlock path. The DURESS
   * slot is ALWAYS evaluated — even mid-lockout — because a seized device routinely accrues wrong
   * guesses, and if the brute-force limiter also blocked the duress PIN the panic wipe could never
   * fire (it would silently disable the coercion defence). A duress match therefore returns 'duress'
   * (→ wipe) regardless of lockout, and is NOT counted against the limiter (it isn't a guess).
   */
  async verify(pin: string): Promise<PinVerifyResult> {
    const lockedOut = this.limiter ? await this.limiter.isLockedOut() : false;
    if (lockedOut) {
      // Locked out: the standard PIN is rejected unchecked, but the duress PIN must STILL trigger the
      // wipe. Evaluate only the duress slot; don't advance the limiter (neither success nor failure)
      // so the coercion path leaves no trace and doesn't further extend the window.
      if (await this.matchesAndUpgrade(DURESS_ITEM, pin)) {
        return 'duress';
      }
      return 'invalid';
    }
    if (await this.matchesAndUpgrade(STANDARD_ITEM, pin)) {
      await this.limiter?.recordSuccess();
      return 'standard';
    }
    if (await this.matchesAndUpgrade(DURESS_ITEM, pin)) {
      await this.limiter?.recordSuccess();
      return 'duress';
    }
    await this.limiter?.recordFailure();
    return 'invalid';
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(STANDARD_ITEM);
    await this.storage.removeItem(DURESS_ITEM);
    await this.limiter?.reset();
    this.storedCache.clear();
  }

  private async seal(pin: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const digest = await this.hash(concat(salt, utf8(pin)));
    return `${KDF_SCHEME}:${bytesToHex(salt)}:${bytesToHex(digest)}`;
  }

  /**
   * Constant-time match against a slot's stored blob. A pre-#20 legacy blob is verified with the old
   * SHA-256 and, on a match, transparently re-sealed to the slow KDF (so an existing user is upgraded
   * on their next unlock and never locked out).
   */
  private async matchesAndUpgrade(item: string, pin: string): Promise<boolean> {
    const stored = await this.readStored(item);
    if (!stored) {
      return false;
    }
    const parsed = parseBlob(stored);
    if (!parsed) {
      return false;
    }
    const verifier = this.verifierFor(parsed.scheme);
    const actual = await verifier(concat(parsed.salt, utf8(pin)));
    if (!timingSafeEqual(actual, parsed.digest)) {
      return false;
    }
    if (parsed.scheme !== KDF_SCHEME) {
      // Migrate the just-verified PIN from its old KDF (legacy single-SHA-256, or the ~11s pure-JS
      // scrypt1) to the current native `pbk1` KDF, so every later unlock is fast. Never locks anyone
      // out: this runs AFTER a successful verify, and is best-effort — a failed re-seal just retries.
      try {
        const upgraded = await this.seal(pin);
        await this.storage.setItem(item, upgraded);
        this.storedCache.set(item, upgraded);
      } catch {
        // Best effort — verification already succeeded; the upgrade simply retries next unlock.
      }
    }
    return true;
  }

  /** The KDF that sealed a blob of the given scheme: legacy schemes verify with their original KDF;
   *  the current scheme uses the injected `this.hash` (native PBKDF2 by default) for seal + verify. */
  private verifierFor(scheme: KdfScheme): HashFn {
    if (scheme === 'sha256') return webcryptoSha256;
    if (scheme === 'scrypt1') return scryptPinKdf;
    return this.hash; // 'pbk1' (current)
  }
}

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

function utf8(s: string): Uint8Array {
  const ctor = (globalThis as unknown as {TextEncoder: new () => TextEncoderLike}).TextEncoder;
  return new ctor().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// eslint-disable-next-line no-bitwise -- constant-time comparison needs bit ops
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
