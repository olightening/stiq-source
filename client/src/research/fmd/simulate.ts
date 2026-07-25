/**
 * FMD vs decoy cover-set simulation harness (T18-S2) — EVAL-ONLY, spike-not-production.
 *
 * Models STIQ's DM/mention metadata-privacy economics as a function of community size N so the
 * decision report (T18-S3) can state a concrete ship-threshold. It compares the two mechanisms head
 * to head on the axes that actually decide the trade-off:
 *
 *   - decoy cover-set (TODAY, subscriptionPlan.ts buildCoverSet): a member downloads its own DM inbox
 *     plus `decoyCount` other members' inboxes, giving a FIXED (decoyCount+1)-inbox anonymity set that
 *     is INDEPENDENT of N. Bandwidth is flat in N; the anonymity set never grows.
 *   - FMD (Beck–Len–Miers–Green compact scheme, ./fmd.ts): every message carries a flag; a detection
 *     key at precision n yields a fuzzy set with false-positive rate p = 2^-n, so a member downloads
 *     its true inbox plus p·(community DM volume) decoys. The anonymity set is ≈ p·totalDms and GROWS
 *     linearly with N (the tunable win), but so does the bandwidth, and every wrap now pays the flag
 *     byte tax {@link flagByteLength}.
 *
 * All formulas are PURE and deterministic (no Date.now / Math.random), so a sweep is reproducible. The
 * FMD flag byte tax is sourced from the REAL serializer ({@link flagByteLength}), never a guessed
 * constant, so the bytes/anonymity figures are grounded in the actual scheme.
 *
 * Steady-state assumption (documented once here): received ≈ sent per member, so a member's own inbox
 * per day is `dmsPerMemberPerDay` and the whole community exchanges `communitySize · dmsPerMemberPerDay`
 * DMs/day.
 */
import {flagByteLength} from './fmd';

/** STIQ event-volume model for a community of `communitySize` members. */
export interface StiqVolume {
  communitySize: number;
  dmsPerMemberPerDay: number;
  postsPerMemberPerDay: number;
  /** Fraction of posts that mention a given member (the mention-carrier flag workload). */
  mentionFraction: number;
  /** Bytes on the wire for one kind-1059 sealed gift wrap over Tor (~900). */
  wrapBytes: number;
}

/** Tor link model: sustained downlink throughput + round-trip latency. */
export interface TorLink {
  downlinkBytesPerSec: number;
  rttMs: number;
}

export type Approach = 'decoy' | 'fmd';

/** One simulated data point. `param` is the decoy count (decoy) or precision n (fmd). */
export interface SimResult {
  approach: Approach;
  communitySize: number;
  param: number;
  /** Effective anonymity-set size: (decoyCount+1) for decoy (flat), ≈ p·totalDms for fmd (grows). */
  anonymitySet: number;
  wrapsDownloaded: number;
  bytesDownloaded: number;
  downloadSeconds: number;
  /** testFlag() calls the CLIENT runs (fmd). Decoy needs none — the relay `#p` filter does the work. */
  detectionOps: number;
}

/** Total DMs exchanged community-wide per day, under the received≈sent steady-state assumption. */
export function totalDmsPerDay(v: StiqVolume): number {
  return v.communitySize * v.dmsPerMemberPerDay;
}

/**
 * Decoy cover-set cost for one member. Downloads own inbox + `decoyCount` decoy inboxes ⇒
 * (decoyCount+1)·ownInbox wraps, a fixed (decoyCount+1) anonymity set that does NOT depend on N, and
 * zero client detection ops (the relay's `#p` cover filter selects the wraps).
 */
export function simulateDecoy(v: StiqVolume, tor: TorLink, decoyCount: number): SimResult {
  const ownInbox = v.dmsPerMemberPerDay; // received ≈ sent
  const wrapsDownloaded = (decoyCount + 1) * ownInbox;
  const bytesDownloaded = wrapsDownloaded * v.wrapBytes;
  return {
    approach: 'decoy',
    communitySize: v.communitySize,
    param: decoyCount,
    anonymitySet: decoyCount + 1,
    wrapsDownloaded,
    bytesDownloaded,
    downloadSeconds: bytesDownloaded / tor.downlinkBytesPerSec,
    detectionOps: 0,
  };
}

/**
 * FMD cost for one member at precision n (p = 2^-n). Downloads own inbox plus p·(community DM volume
 * minus own) false positives; every downloaded wrap pays the flag byte tax `flagBytes`. The anonymity
 * set is the fuzzy-set size ≈ p·totalDms and grows with N. `detectionOps` is the CLIENT figure — one
 * testFlag() per downloaded wrap (this spike detects client-side). NOTE: a relay-side evaluation would
 * instead run `totalDms` tests per REQ (it tests every message in the community), which is the figure
 * the Go projection (T18-S5) benchmarks — see the report's CPU section.
 */
export function simulateFmd(v: StiqVolume, tor: TorLink, n: number, flagBytes: number = flagByteLength()): SimResult {
  const p = Math.pow(2, -n);
  const ownInbox = v.dmsPerMemberPerDay;
  const totalDms = totalDmsPerDay(v);
  const wrapsDownloaded = ownInbox + p * (totalDms - ownInbox);
  const bytesDownloaded = wrapsDownloaded * (v.wrapBytes + flagBytes);
  return {
    approach: 'fmd',
    communitySize: v.communitySize,
    param: n,
    anonymitySet: p * totalDms,
    wrapsDownloaded,
    bytesDownloaded,
    downloadSeconds: bytesDownloaded / tor.downlinkBytesPerSec,
    detectionOps: wrapsDownloaded, // client-side; server-eval figure = totalDms (see doc comment)
  };
}

/** Options for a full {@link sweep}: the decoy count, the FMD precisions to try, and the flag tax. */
export interface SweepOpts {
  decoyCount: number;
  fmdBits: number[];
  flagBytes: number;
}

/**
 * Sweep across community sizes: for each N, one decoy row plus one FMD row per precision in
 * `opts.fmdBits`. Pure ⇒ the same inputs always yield the same rows.
 */
export function sweep(
  sizes: number[],
  base: Omit<StiqVolume, 'communitySize'>,
  tor: TorLink,
  opts: SweepOpts,
): SimResult[] {
  const out: SimResult[] = [];
  for (const communitySize of sizes) {
    const v: StiqVolume = {...base, communitySize};
    out.push(simulateDecoy(v, tor, opts.decoyCount));
    for (const n of opts.fmdBits) {
      out.push(simulateFmd(v, tor, n, opts.flagBytes));
    }
  }
  return out;
}

/**
 * Smallest community size N in [2, maxN] at which FMD (precision `n`) BEATS the decoy cover-set:
 * it reaches at least the decoy anonymity level (p·totalDms ≥ decoyCount+1) while downloading no more
 * bytes than the decoy approach. Returns null if no such N exists within maxN.
 *
 * Why a fixed anonymity level and not a fixed p: decoy bytes are flat in N while FMD bytes scale with
 * p·N, so FMD starts CHEAPER (it downloads ≈ own inbox) and grows more expensive as N rises. Below the
 * threshold FMD's fuzzy set is smaller than the decoy set (parity fails); above it FMD matches or
 * exceeds decoy anonymity, and there is a window where it does so for fewer bytes. The crossover is the
 * entry point of that window — the ship-threshold the report recommends.
 */
export function crossoverCommunitySize(
  base: Omit<StiqVolume, 'communitySize'>,
  tor: TorLink,
  decoyCount: number,
  n: number,
  flagBytes: number = flagByteLength(),
  maxN = 100000,
): number | null {
  const parity = decoyCount + 1;
  // Decoy bytes are N-independent (they depend only on decoyCount and ownInbox), so compute once.
  const decoyBytes = simulateDecoy({...base, communitySize: 2}, tor, decoyCount).bytesDownloaded;
  for (let communitySize = 2; communitySize <= maxN; communitySize++) {
    const fmd = simulateFmd({...base, communitySize}, tor, n, flagBytes);
    if (fmd.anonymitySet >= parity && fmd.bytesDownloaded <= decoyBytes) {
      return communitySize;
    }
  }
  return null;
}
