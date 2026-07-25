/**
 * Correctness + empirical false-positive tests for the compact FMD scheme (T18-S1).
 *
 * The empirical tests inject a deterministic counter-based `randScalar` into {@link flag} so the
 * synthetic flag stream is reproducible run-to-run (the keypairs still come from the real CSPRNG,
 * but the per-flag randomness is seeded). Tolerance bands are wide relative to the sampling error
 * at N = 4000, so the assertions are robust without pinning the keypairs.
 */
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToNumberBE, numberToBytesBE} from '@noble/curves/utils.js';
import {sha256} from '@noble/hashes/sha2.js';
import {
  FMD_GAMMA,
  generateFmdKeypair,
  extractDetectionKey,
  flag,
  testFlag,
  falsePositiveRate,
  serializeFlag,
  deserializeFlag,
  flagByteLength,
  type FmdFlag,
} from './fmd';

const Fn = secp256k1.Point.Fn;

/**
 * A deterministic, counter-based scalar source for reproducible flag generation. Each call hashes
 * an incrementing counter to a uniform non-zero scalar in Z_q; distinct counters ⇒ distinct,
 * well-spread scalars (so the derived flag randomness has no exploitable structure).
 */
function counterScalar(seed: number): () => bigint {
  let ctr = BigInt(seed);
  return () => {
    ctr += 1n;
    const s = Fn.create(bytesToNumberBE(sha256(numberToBytesBE(ctr, 32))));
    return s === 0n ? 1n : s;
  };
}

describe('FMD compact scheme — correctness', () => {
  it('a full-precision detection key detects every one of the holder\'s own flags (zero false negatives)', () => {
    const gamma = 8;
    const kp = generateFmdKeypair(gamma);
    // Own flags must pass at ANY precision n <= gamma.
    for (const n of [1, 4, gamma]) {
      const dk = extractDetectionKey(kp, n);
      for (let i = 0; i < 40; i++) {
        expect(testFlag(dk, flag(kp.pk))).toBe(true);
      }
    }
  });

  it('detects a holder flag that has been round-tripped through (de)serialization', () => {
    const kp = generateFmdKeypair(8);
    const dk = extractDetectionKey(kp, kp.gamma);
    const fl = flag(kp.pk);
    const restored = deserializeFlag(serializeFlag(fl), kp.gamma);
    expect(testFlag(dk, restored)).toBe(true);
  });

  it('serializeFlag / deserializeFlag are exact inverses at the fixed byte layout', () => {
    for (const gamma of [8, FMD_GAMMA]) {
      const kp = generateFmdKeypair(gamma);
      const fl = flag(kp.pk);
      const buf = serializeFlag(fl);
      expect(buf.length).toBe(flagByteLength(gamma));
      const back = deserializeFlag(buf, gamma);
      expect(back.u).toEqual(fl.u);
      expect(back.y).toBe(fl.y);
      expect(back.bits).toEqual(fl.bits);
      // and re-serializing the restored flag reproduces the identical bytes
      expect(serializeFlag(back)).toEqual(buf);
    }
  });

  it('flagByteLength and falsePositiveRate report the documented values', () => {
    expect(flagByteLength(24)).toBe(68); // 33 (u) + 32 (y) + ceil(24/8)=3
    expect(flagByteLength()).toBe(flagByteLength(FMD_GAMMA));
    expect(flagByteLength(8)).toBe(66); // 33 + 32 + 1
    expect(falsePositiveRate(4)).toBeCloseTo(0.0625, 12);
    expect(falsePositiveRate(6)).toBeCloseTo(1 / 64, 12);
  });

  it('deserializeFlag rejects a mis-sized buffer', () => {
    const kp = generateFmdKeypair(8);
    const buf = serializeFlag(flag(kp.pk));
    expect(() => deserializeFlag(buf, 24)).toThrow();
  });

  it('extractDetectionKey enforces 0 < n <= gamma', () => {
    const kp = generateFmdKeypair(8);
    expect(() => extractDetectionKey(kp, 0)).toThrow();
    expect(() => extractDetectionKey(kp, 9)).toThrow();
    expect(extractDetectionKey(kp, 8).sk).toHaveLength(8);
  });
});

describe('FMD compact scheme — empirical false-positive rate', () => {
  // gamma=8 supports detection precisions up to n=6 while keeping each flag cheap. A single
  // progressive-detection pass over N flags yields the match rate at every n at once: because the
  // detection keys nest (dk(n) reveals the first n subkeys), a flag that passes at n=6 also passes
  // at n=4 and n=2, so counting how far each flag survives gives r2 >= r4 >= r6 in one sweep.
  const GAMMA = 8;
  const N = 4000;
  const victim = generateFmdKeypair(GAMMA);
  // Several distinct non-recipient senders (each reused across a block of flags so the decoded
  // public-subkey cache stays warm) — the FP rate is averaged over more than one foreign keypair.
  const others = Array.from({length: 8}, () => generateFmdKeypair(GAMMA));

  let r2 = 0;
  let r4 = 0;
  let r6 = 0;

  beforeAll(() => {
    const rnd = counterScalar(0xc0ffee);
    const dk2 = extractDetectionKey(victim, 2);
    const dk4 = extractDetectionKey(victim, 4);
    const dk6 = extractDetectionKey(victim, 6);
    let c2 = 0;
    let c4 = 0;
    let c6 = 0;
    for (let i = 0; i < N; i++) {
      const fl: FmdFlag = flag(others[i % others.length]!.pk, rnd);
      if (!testFlag(dk2, fl)) continue;
      c2++;
      if (!testFlag(dk4, fl)) continue;
      c4++;
      if (!testFlag(dk6, fl)) continue;
      c6++;
    }
    r2 = c2 / N;
    r4 = c4 / N;
    r6 = c6 / N;
    // eslint-disable-next-line no-console
    console.log(
      `[FMD] N=${N} non-recipient match rates — n2=${r2.toFixed(4)} (target ${falsePositiveRate(2)}), ` +
        `n4=${r4.toFixed(4)} (target ${falsePositiveRate(4)}), n6=${r6.toFixed(4)} (target ${falsePositiveRate(6)})`,
    );
  }, 180000);

  it('non-recipient match rate at n=4 is within tolerance of 2^-4 (0.0625)', () => {
    // 3-sigma sampling error at p=0.0625, N=4000 is ~0.011, so [0.02, 0.15] is a comfortable band.
    expect(r4).toBeGreaterThan(0.02);
    expect(r4).toBeLessThan(0.15);
  });

  it('match rate decreases monotonically with precision (n=2 > n=4 > n=6)', () => {
    expect(r2).toBeGreaterThan(r4);
    expect(r4).toBeGreaterThan(r6);
  });

  it('every non-recipient rate stays in the right order-of-magnitude of its 2^-n target', () => {
    expect(r2).toBeGreaterThan(0.15);
    expect(r2).toBeLessThan(0.4); // ~0.25
    expect(r6).toBeLessThan(0.05); // ~0.0156
  });
});
