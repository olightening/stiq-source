import {PinVault, webcryptoSha256, scryptPinKdf, type HashFn} from './pin';
import {PinAttemptLimiter, FREE_ATTEMPTS} from './attemptLimiter';
import {InMemorySecureStorage} from '../keys/keystore';
import {bytesToHex} from '../util/hex';

// Deterministic identity "hash" keeps the vault-logic tests fast and independent of
// WebCrypto. A separate test exercises the real default hash.
const identityHash: HashFn = async data => data;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('PinVault', () => {
  it('classifies the standard, duress, and invalid PINs', async () => {
    const vault = new PinVault(new InMemorySecureStorage(), identityHash);
    await vault.setPins('1234', '9999');

    expect(await vault.isConfigured()).toBe(true);
    expect(await vault.verify('1234')).toBe('standard');
    expect(await vault.verify('9999')).toBe('duress');
    expect(await vault.verify('0000')).toBe('invalid');
  });

  it('refuses identical standard and duress PINs', async () => {
    const vault = new PinVault(new InMemorySecureStorage(), identityHash);
    await expect(vault.setPins('1234', '1234')).rejects.toThrow(/must differ/);
  });

  it('uses a per-PIN salt (stored values differ even for equal hashes)', async () => {
    const storage = new InMemorySecureStorage();
    await new PinVault(storage, identityHash).setPins('1111', '2222');
    const a = await storage.getItem('stiq.pin.standard');
    const b = await storage.getItem('stiq.pin.duress');
    expect(a).not.toBe(b);
    expect(a).toContain(':'); // salt:hash
  });

  it('clears both slots', async () => {
    const vault = new PinVault(new InMemorySecureStorage(), identityHash);
    await vault.setPins('1234', '9999');
    await vault.clear();
    expect(await vault.isConfigured()).toBe(false);
    expect(await vault.verify('1234')).toBe('invalid');
  });

  it('works with the real WebCrypto SHA-256 hash', async () => {
    const vault = new PinVault(new InMemorySecureStorage(), webcryptoSha256);
    await vault.setPins('4321', '8888');
    expect(await vault.verify('4321')).toBe('standard');
    expect(await vault.verify('8888')).toBe('duress');
    expect(await vault.verify('0000')).toBe('invalid');
  });

  it('the production default (no injected hash) seals + verifies with the native pbk1 KDF', async () => {
    const storage = new InMemorySecureStorage();
    const vault = new PinVault(storage); // real nativePinHash default (JS pbkdf2 fallback under jest)
    await vault.setPins('2468');
    expect(await vault.isConfigured()).toBe(true);
    expect((await storage.getItem('stiq.pin.standard'))!.startsWith('pbk1:')).toBe(true);
    expect(await vault.verify('2468')).toBe('standard');
    expect(await vault.verify('1357')).toBe('invalid');
  }, 20_000);

  // --- Slow-KDF migration (finding #20): an old single-SHA-256 blob is upgraded on first entry ---

  it('accepts a legacy single-SHA-256 blob and re-seals it to the scheme-tagged KDF format', async () => {
    const storage = new InMemorySecureStorage();
    // Reconstruct exactly what an OLD build stored: `saltHex:sha256(salt||pin)Hex` (2 parts, no tag).
    const salt = new Uint8Array(16).fill(7);
    const pin = '1234';
    const legacyDigest = await webcryptoSha256(concatBytes(salt, new TextEncoder().encode(pin)));
    await storage.setItem('stiq.pin.standard', `${bytesToHex(salt)}:${bytesToHex(legacyDigest)}`);

    // Inject the fast hash so the re-seal doesn't run real scrypt; legacy verification always uses SHA-256.
    const vault = new PinVault(storage, webcryptoSha256);
    expect(await vault.verify('1234')).toBe('standard');

    // The stored blob is now the current scheme-tagged format …
    const upgraded = await storage.getItem('stiq.pin.standard');
    expect(upgraded!.startsWith('pbk1:')).toBe(true);
    expect(upgraded!.split(':')).toHaveLength(3);

    // … and it still verifies after a fresh read from storage (cache dropped).
    vault.forgetCached();
    expect(await vault.verify('1234')).toBe('standard');
    expect(await vault.verify('0000')).toBe('invalid');
  });

  // --- Native-KDF migration: an old (slow) scrypt1 blob is upgraded to the fast native pbk1 on entry ---

  it('accepts a legacy scrypt1 blob and re-seals it to the current native pbk1 KDF', async () => {
    const storage = new InMemorySecureStorage();
    // Reconstruct what the previous build stored: `scrypt1:saltHex:scrypt(salt||pin)Hex` (real scrypt).
    const salt = new Uint8Array(16).fill(9);
    const scryptDigest = await scryptPinKdf(concatBytes(salt, new TextEncoder().encode('2468')));
    await storage.setItem('stiq.pin.standard', `scrypt1:${bytesToHex(salt)}:${bytesToHex(scryptDigest)}`);

    // A fast injected current-KDF keeps the re-seal instant; scrypt1 is always verified with real scrypt.
    const vault = new PinVault(storage, identityHash);
    expect(await vault.verify('2468')).toBe('standard');

    const upgraded = await storage.getItem('stiq.pin.standard');
    expect(upgraded!.startsWith('pbk1:')).toBe(true);
    expect(upgraded!.split(':')).toHaveLength(3);

    // Still verifies after a fresh keystore read, and a wrong PIN is still rejected.
    vault.forgetCached();
    expect(await vault.verify('2468')).toBe('standard');
    expect(await vault.verify('0000')).toBe('invalid');
  }, 20_000);

  // --- Attempt lockout (finding #21) enforced inside verify via the injected limiter ---

  it('locks out after too many wrong PINs and rejects even the correct PIN until the window lifts', async () => {
    let now = 0;
    const storage = new InMemorySecureStorage();
    const limiter = new PinAttemptLimiter(storage, () => now);
    const vault = new PinVault(storage, identityHash, limiter);
    await vault.setPins('1234', '9999');

    // Burn through the free allowance and trip the first lockout window.
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      expect(await vault.verify('0000')).toBe('invalid');
    }
    // The correct PIN is rejected WITHOUT being checked while locked out.
    expect(await vault.verify('1234')).toBe('invalid');

    // After the window elapses, the correct PIN works again and clears the counter.
    now += 60 * 60 * 1000;
    expect(await vault.verify('1234')).toBe('standard');
    expect(await vault.verify('1234')).toBe('standard'); // still fine (no residual lockout)
  });

  it('still fires the DURESS PIN while locked out — brute-force lockout must NOT disable the panic wipe (M2)', async () => {
    let now = 0;
    const storage = new InMemorySecureStorage();
    const limiter = new PinAttemptLimiter(storage, () => now);
    const vault = new PinVault(storage, identityHash, limiter);
    await vault.setPins('1234', '9999');

    // A seized device routinely accrues wrong guesses — burn the free allowance and trip the lockout.
    for (let i = 0; i <= FREE_ATTEMPTS; i++) {
      expect(await vault.verify('0000')).toBe('invalid');
    }
    expect(await limiter.isLockedOut()).toBe(true);

    // The STANDARD PIN stays gated by the lockout (rejected without unlocking) …
    expect(await vault.verify('1234')).toBe('invalid');
    // … but the DURESS PIN MUST still classify as 'duress' so LockController runs performDuressWipe.
    expect(await vault.verify('9999')).toBe('duress');

    // Evaluating duress did NOT advance/clear the limiter: the window is still active (no counter
    // reset, no accidental standard unlock as a side effect of the coercion path).
    expect(await limiter.isLockedOut()).toBe(true);
    expect(await vault.verify('1234')).toBe('invalid');
  });

  // --- Session cache (audit item 8): fewer keystore reads, no probing an absent duress slot ---

  /** Counts getItem calls per key so we can assert the cache short-circuits keystore reads. */
  class CountingStorage extends InMemorySecureStorage {
    readonly reads: Record<string, number> = {};
    override async getItem(key: string): Promise<string | null> {
      this.reads[key] = (this.reads[key] ?? 0) + 1;
      return super.getItem(key);
    }
  }

  it('does not re-read the keystore or re-probe the duress slot on repeated attempts', async () => {
    const storage = new CountingStorage();
    const vault = new PinVault(storage, identityHash);
    await vault.setPins('1234'); // standard only — NO duress slot configured
    const base = {...storage.reads};

    // Three wrong attempts + one correct: only the FIRST attempt should read each slot from the
    // keystore; the rest serve from the session cache. The absent duress slot is read at most once.
    await vault.verify('0000');
    await vault.verify('1111');
    await vault.verify('2222');
    expect(await vault.verify('1234')).toBe('standard');

    const stdReads = (storage.reads['stiq.pin.standard'] ?? 0) - (base['stiq.pin.standard'] ?? 0);
    const durReads = (storage.reads['stiq.pin.duress'] ?? 0) - (base['stiq.pin.duress'] ?? 0);
    expect(stdReads).toBe(1); // read once, then cached across all four attempts
    expect(durReads).toBe(1); // absent duress slot probed once, not once-per-attempt
  });

  it('still verifies correctly and does not verify a rotated-away PIN (cache invalidated on setPins)', async () => {
    const vault = new PinVault(new CountingStorage(), identityHash);
    await vault.setPins('1234', '9999');
    expect(await vault.verify('1234')).toBe('standard');

    await vault.setPins('5678'); // rotate: new standard, duress removed
    expect(await vault.verify('1234')).toBe('invalid'); // old PIN must no longer unlock
    expect(await vault.verify('9999')).toBe('invalid'); // removed duress must no longer classify
    expect(await vault.verify('5678')).toBe('standard'); // new PIN unlocks
  });

  it('forgetCached() forces a fresh keystore read on the next attempt', async () => {
    const storage = new CountingStorage();
    const vault = new PinVault(storage, identityHash);
    await vault.setPins('1234');
    await vault.verify('1234'); // populates the cache
    const afterFirst = storage.reads['stiq.pin.standard'] ?? 0;

    await vault.verify('1234'); // cached — no new read
    expect(storage.reads['stiq.pin.standard']).toBe(afterFirst);

    vault.forgetCached();
    await vault.verify('1234'); // cache dropped — one fresh read
    expect(storage.reads['stiq.pin.standard']).toBe(afterFirst + 1);
  });
});
