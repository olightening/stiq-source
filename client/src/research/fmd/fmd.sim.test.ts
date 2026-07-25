/**
 * FMD sweep → decision-report writer (T18-S3) + report-renderer smoke test.
 *
 * The heavy sweep that WRITES docs/research/FMD_EVAL_2026-07-10.md is GATED behind RUN_FMD_SWEEP so a
 * normal `npm test` never runs it and never touches the filesystem. The renderer itself is covered by a
 * fast, non-gated smoke test so CI still guards the report shape.
 *
 * To (re)generate the report:  RUN_FMD_SWEEP=1 npx jest research/fmd/fmd.sim.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import {flagByteLength} from './fmd';
import {sweep, crossoverCommunitySize, type StiqVolume, type TorLink} from './simulate';
import {renderReport, findCrossover, type ReportMeta} from './report';

/** Baseline STIQ community model (documented in the report's "Model inputs"). */
const BASE: Omit<StiqVolume, 'communitySize'> = {
  dmsPerMemberPerDay: 8,
  postsPerMemberPerDay: 5,
  mentionFraction: 0.1,
  wrapBytes: 900,
};
const TOR: TorLink = {downlinkBytesPerSec: 40000, rttMs: 1500};
const SIZES = [10, 25, 50, 100, 250, 1000, 5000];
const FMD_BITS = [2, 4, 6, 8];
const DECOY_COUNT = 4;

/**
 * Measured CPU inputs folded into the report (T18-S7). Sourced from the sibling benchmarks:
 *  - RELAY_TEST_MS: relay Go micro-bench (T18-S5) — ≈ 1.47 ms per Test() at n=4 on the relay host,
 *    which projects to ≈ 1.17 s/REQ at 800 msgs, ≈ 12.0 s/REQ at 8000, ≈ 57.2 s/REQ at 40000 ⇒
 *    server-side FMD is infeasible on the request path.
 *  - HERMES_*_MS: on-device Hermes projection (T18-S6). No physical low-end device is available in this
 *    environment, so these are the Node reference (flag ≈ 33 ms, testFlag ≈ 16 ms at n=4) scaled by the
 *    measured ~28× Hermes/V8 gap ⇒ ≈ 924 ms / ≈ 448 ms. Replace with the real logcat `[FMD-bench]`
 *    numbers when a device run is available.
 */
const RELAY_TEST_MS = 1.47;
const HERMES_FLAG_MS = 924;
const HERMES_TEST_MS = 448;

describe('FMD report renderer (non-gated smoke)', () => {
  it('renderReport returns markdown with the recommendation header and a row for each N', () => {
    const sizes = [10, 100];
    const results = sweep(sizes, BASE, TOR, {decoyCount: DECOY_COUNT, fmdBits: FMD_BITS, flagBytes: flagByteLength()});
    const meta: ReportMeta = {
      generatedAt: '2026-07-10T00:00:00Z',
      torLink: TOR,
      base: BASE,
      decoyCount: DECOY_COUNT,
      fmdBits: FMD_BITS,
      sizes,
      flagBytes: flagByteLength(),
    };
    const md = renderReport(results, meta);
    expect(typeof md).toBe('string');
    expect(md).toContain('# FMD evaluation — decision report');
    expect(md).toContain('## Executive recommendation');
    expect(md).toContain('## Trade-off table');
    expect(md).toContain('## Per-message flag tax');
    expect(md).toContain('## Linkability caveat');
    expect(md).toContain('## Decision matrix');
    // A table row for every swept N.
    for (const N of sizes) expect(md).toContain(`| ${N} | decoy |`);
  });
});

describe('FMD sweep → report writer (gated by RUN_FMD_SWEEP)', () => {
  if (!process.env.RUN_FMD_SWEEP) {
    it.skip('writes docs/research/FMD_EVAL_2026-07-10.md — set RUN_FMD_SWEEP=1 to run', () => {});
    return;
  }

  it('runs the baseline sweep, asserts a finite crossover, and writes the report', () => {
    const results = sweep(SIZES, BASE, TOR, {
      decoyCount: DECOY_COUNT,
      fmdBits: FMD_BITS,
      flagBytes: flagByteLength(),
    });

    // A finite crossover must exist for the baseline at some swept precision (n=4 is the reference).
    expect(crossoverCommunitySize(BASE, TOR, DECOY_COUNT, 4, flagByteLength())).not.toBeNull();
    expect(findCrossover(results)).not.toBeNull();

    const meta: ReportMeta = {
      generatedAt: new Date().toISOString(),
      torLink: TOR,
      base: BASE,
      decoyCount: DECOY_COUNT,
      fmdBits: FMD_BITS,
      sizes: SIZES,
      flagBytes: flagByteLength(),
      hermesFlagMs: HERMES_FLAG_MS,
      hermesTestMs: HERMES_TEST_MS,
      relayTestMs: RELAY_TEST_MS,
    };
    const md = renderReport(results, meta);

    // repo root = up from client/src/research/fmd (4 levels).
    const outPath = path.resolve(__dirname, '../../../../docs/research/FMD_EVAL_2026-07-10.md');
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, md, 'utf8');

    expect(fs.existsSync(outPath)).toBe(true);
    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).toContain('Recommendation');
    expect(written).toContain('Per-message flag tax');
    expect(written).toContain('Linkability caveat');
    expect(written).toContain('CPU cost');
    // eslint-disable-next-line no-console
    console.log(`[FMD-sweep] wrote ${outPath} (${written.length} bytes)`);
  });
});
