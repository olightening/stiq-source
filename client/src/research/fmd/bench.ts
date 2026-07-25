/**
 * On-device Hermes micro-benchmark of FMD flag()/testFlag() throughput (T18-S6) — EVAL-ONLY.
 *
 * A pure timing harness: it generates one keypair + detection key, then times `iterations` calls
 * each of {@link flag} and {@link testFlag}, reporting mean and p95 ms/op. Low-end-phone cost is
 * decision-relevant (T18) — flag() is γ variable-base scalar-mults and testFlag() is ~n+1, and
 * Hermes is ~28x slower than V8 (see dm.ts mineJs) — so the REAL numbers come from running this on
 * the target device via a dev-only, flag-gated log hook and reading logcat; this module only
 * measures and returns them.
 *
 * SHIP-DARK: this file touches no production state and is imported only by its test and by the
 * dev/diagnostic hook that fires solely under `FMD_EVAL_ENABLED && __DEV__` (wired in T18-S7). It is
 * inert in a normal member build.
 *
 * Cooperative yield: like dm.ts's mineJs, the loops `await` a macrotask every {@link YIELD_EVERY}
 * iterations so the single Hermes thread can service touches/renders — the bench must not jank the
 * UI while it runs on device.
 */
import {generateFmdKeypair, extractDetectionKey, flag, testFlag, FMD_GAMMA} from './fmd';
import type {FmdFlag} from './fmd';

/** Timing summary for one bench run. All times are milliseconds per single flag()/testFlag() call. */
export interface FmdBenchResult {
  iterations: number;
  gamma: number;
  n: number;
  flagMsMean: number;
  testMsMean: number;
  flagMsP95: number;
  testMsP95: number;
}

/** Yield to the event loop every this many iterations so the Hermes thread stays responsive. */
const YIELD_EVERY = 8;

/**
 * Monotonic-ish clock. Prefers `performance.now()` (fractional-ms; present in Node/Jest and in
 * RN/Hermes where polyfilled) for sub-ms resolution, falling back to `Date.now()` (Date.now is fine
 * at ms scale per the T18-S6 note). Read once at module load so the hot loop pays no lookup.
 */
const perf = (globalThis as {performance?: {now?: () => number}}).performance;
const now: () => number =
  perf && typeof perf.now === 'function' ? () => perf.now!() : () => Date.now();

/** Await a macrotask so the single JS thread can interleave other work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Nearest-rank p95 of a sample (sorted copy; small N so the sort cost is irrelevant). */
function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * Benchmark flag() then testFlag() over `iterations` calls at γ = `gamma`, precision `n`. Returns
 * mean + p95 ms/op for each. `iterations` defaults small so a dev tap is quick; the on-device
 * procedure (README/T18-S7) raises it for a stable reading.
 */
export async function benchFmd(
  iterations = 100,
  gamma: number = FMD_GAMMA,
  n = 4,
): Promise<FmdBenchResult> {
  const kp = generateFmdKeypair(gamma);
  const dk = extractDetectionKey(kp, Math.min(n, gamma));

  const flagMs: number[] = [];
  const flags: FmdFlag[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = now();
    const fl = flag(kp.pk);
    flagMs.push(now() - t0);
    flags.push(fl);
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const testMs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const fl = flags[i % flags.length]!;
    const t0 = now();
    testFlag(dk, fl);
    testMs.push(now() - t0);
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  return {
    iterations,
    gamma,
    n: dk.n,
    flagMsMean: mean(flagMs),
    testMsMean: mean(testMs),
    flagMsP95: p95(flagMs),
    testMsP95: p95(testMs),
  };
}
