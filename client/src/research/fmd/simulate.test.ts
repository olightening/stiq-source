/**
 * Tests for the FMD vs decoy simulation harness (T18-S2). Pure/deterministic model checks — the heavy
 * report sweep lives in fmd.sim.test.ts (gated by RUN_FMD_SWEEP). These lock in the qualitative shape
 * the decision report depends on: decoy anonymity is flat in N, FMD anonymity grows linearly, FMD
 * bytes climb with N and with (gamma−n), the crossover is finite for a realistic config, and the flag
 * byte tax is the REAL serialized size.
 */
import {flagByteLength} from './fmd';
import {
  simulateDecoy,
  simulateFmd,
  sweep,
  crossoverCommunitySize,
  type StiqVolume,
  type TorLink,
} from './simulate';

const BASE: Omit<StiqVolume, 'communitySize'> = {
  dmsPerMemberPerDay: 8,
  postsPerMemberPerDay: 5,
  mentionFraction: 0.1,
  wrapBytes: 900,
};
const TOR: TorLink = {downlinkBytesPerSec: 40000, rttMs: 1500};
const FLAG = flagByteLength(); // 68 at gamma=24

describe('simulateDecoy — fixed anonymity, flat in N', () => {
  it('anonymity set is decoyCount+1 and independent of community size', () => {
    const small = simulateDecoy({...BASE, communitySize: 10}, TOR, 4);
    const large = simulateDecoy({...BASE, communitySize: 50000}, TOR, 4);
    expect(small.anonymitySet).toBe(5);
    expect(large.anonymitySet).toBe(5);
    // Bytes/wraps depend only on decoyCount and ownInbox, so they are identical across N.
    expect(large.bytesDownloaded).toBe(small.bytesDownloaded);
    expect(small.wrapsDownloaded).toBe(5 * BASE.dmsPerMemberPerDay);
    expect(small.detectionOps).toBe(0);
  });
});

describe('simulateFmd — fuzzy set grows with N', () => {
  it('anonymity set scales linearly with N at fixed n', () => {
    const a = simulateFmd({...BASE, communitySize: 100}, TOR, 4, FLAG);
    const b = simulateFmd({...BASE, communitySize: 1000}, TOR, 4, FLAG);
    // p·totalDms = 2^-4 · N · dmsPerMemberPerDay ⇒ 10× the community ⇒ 10× the anonymity set.
    expect(b.anonymitySet / a.anonymitySet).toBeCloseTo(10, 6);
    expect(a.anonymitySet).toBeCloseTo(Math.pow(2, -4) * 100 * BASE.dmsPerMemberPerDay, 6);
  });

  it('bytesDownloaded is monotonic increasing in N', () => {
    const sizes = [10, 100, 1000, 10000];
    const bytes = sizes.map(N => simulateFmd({...BASE, communitySize: N}, TOR, 4, FLAG).bytesDownloaded);
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]!).toBeGreaterThan(bytes[i - 1]!);
  });

  it('bytesDownloaded is monotonic increasing in (gamma−n): lower n ⇒ higher p ⇒ more bytes', () => {
    const N = 5000;
    // n descending = (gamma−n) ascending; each lower n admits more false positives ⇒ more bytes.
    const nDesc = [8, 6, 4, 2];
    const bytes = nDesc.map(n => simulateFmd({...BASE, communitySize: N}, TOR, n, FLAG).bytesDownloaded);
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]!).toBeGreaterThan(bytes[i - 1]!);
  });

  it('detectionOps equals wrapsDownloaded (one client-side testFlag per wrap)', () => {
    const r = simulateFmd({...BASE, communitySize: 2500}, TOR, 4, FLAG);
    expect(r.detectionOps).toBe(r.wrapsDownloaded);
  });
});

describe('flag byte tax is the real serialized size', () => {
  it('simulateFmd bytes reflect flagByteLength() exactly', () => {
    const r = simulateFmd({...BASE, communitySize: 1000}, TOR, 4, FLAG);
    expect(r.bytesDownloaded).toBeCloseTo(r.wrapsDownloaded * (BASE.wrapBytes + FLAG), 6);
    // A larger assumed flag tax strictly raises the byte cost for the same wrap count.
    const heavier = simulateFmd({...BASE, communitySize: 1000}, TOR, 4, FLAG + 100);
    expect(heavier.bytesDownloaded).toBeGreaterThan(r.bytesDownloaded);
  });
});

describe('sweep', () => {
  it('emits one decoy row + one fmd row per precision for each size', () => {
    const results = sweep([10, 100], BASE, TOR, {decoyCount: 4, fmdBits: [2, 4, 6], flagBytes: FLAG});
    // 2 sizes × (1 decoy + 3 fmd) = 8 rows.
    expect(results).toHaveLength(8);
    expect(results.filter(r => r.approach === 'decoy')).toHaveLength(2);
    expect(results.filter(r => r.approach === 'fmd')).toHaveLength(6);
    expect(new Set(results.map(r => r.communitySize))).toEqual(new Set([10, 100]));
  });
});

describe('crossoverCommunitySize', () => {
  it('returns a finite threshold for a realistic config', () => {
    const N = crossoverCommunitySize(BASE, TOR, 4, 4, FLAG);
    expect(N).not.toBeNull();
    expect(Number.isFinite(N!)).toBe(true);
    expect(N!).toBeGreaterThanOrEqual(2);
    // At the returned N, FMD must actually meet parity anonymity AND cost ≤ decoy.
    const fmd = simulateFmd({...BASE, communitySize: N!}, TOR, 4, FLAG);
    const decoy = simulateDecoy({...BASE, communitySize: N!}, TOR, 4);
    expect(fmd.anonymitySet).toBeGreaterThanOrEqual(decoy.anonymitySet);
    expect(fmd.bytesDownloaded).toBeLessThanOrEqual(decoy.bytesDownloaded);
    // And N−1 must NOT qualify (it is the SMALLEST crossover).
    if (N! > 2) {
      const below = simulateFmd({...BASE, communitySize: N! - 1}, TOR, 4, FLAG);
      const belowQualifies = below.anonymitySet >= 5 && below.bytesDownloaded <= decoy.bytesDownloaded;
      expect(belowQualifies).toBe(false);
    }
  });

  it('returns null for a degenerate config (parity unreachable within maxN)', () => {
    // n=8 ⇒ p=2^-8; parity (decoyCount+1=5) needs p·8·N ≥ 5 ⇒ N ≥ 160, beyond maxN=100.
    expect(crossoverCommunitySize(BASE, TOR, 4, 8, FLAG, 100)).toBeNull();
  });
});
