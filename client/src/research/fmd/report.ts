/**
 * FMD decision-report generator (T18-S3) — EVAL-ONLY, spike-not-production.
 *
 * Turns a {@link SimResult} sweep (simulate.ts) plus measured CPU inputs (the on-device Hermes bench
 * T18-S6 and the relay Go projection T18-S5) into the markdown decision deliverable
 * docs/research/FMD_EVAL_2026-07-10.md. Pure string building — the gated sweep test (fmd.sim.test.ts,
 * RUN_FMD_SWEEP=1) is what actually writes the file; this module never touches the filesystem.
 *
 * The report answers one question: at what community size (if any) should STIQ replace the deterministic
 * decoy cover-set (subscriptionPlan.ts buildCoverSet) with FMD, and at what false-positive rate p = 2^-n.
 */
import {flagByteLength} from './fmd';
import type {SimResult, TorLink, StiqVolume} from './simulate';

/** Everything the report needs beyond the raw sweep rows. Optional CPU fields fold in S5/S6 numbers. */
export interface ReportMeta {
  generatedAt: string;
  torLink: TorLink;
  base: Omit<StiqVolume, 'communitySize'>;
  decoyCount: number;
  fmdBits: number[];
  sizes: number[];
  flagBytes: number;
  /** On-device Hermes flag() ms/op (T18-S6). Projected = Node reference × Hermes/V8 gap if no device. */
  hermesFlagMs?: number;
  /** On-device Hermes testFlag() ms/op (T18-S6). */
  hermesTestMs?: number;
  /** Relay Go Test() ms/op (T18-S5), for the server-side per-REQ projection. */
  relayTestMs?: number;
}

function round(x: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

/** Human byte size (KB/MB), so the trade-off table reads at a glance. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes)} B`;
}

/** All decoy rows share one anonymity level + byte cost (flat in N); read it off the first decoy row. */
function decoyBaseline(results: SimResult[]): SimResult | undefined {
  return results.find(r => r.approach === 'decoy');
}

/**
 * Find the smallest swept community size at which some FMD precision beats the decoy cover-set —
 * i.e. reaches at least the decoy anonymity set for no more bytes. Returns the winning {N, n, p} or
 * null if no swept size crosses over. This is the ship-threshold the executive line reports.
 */
export function findCrossover(results: SimResult[]): {communitySize: number; n: number; p: number} | null {
  const decoy = decoyBaseline(results);
  if (!decoy) return null;
  const sizes = [...new Set(results.map(r => r.communitySize))].sort((a, b) => a - b);
  for (const N of sizes) {
    const decoyAtN = results.find(r => r.approach === 'decoy' && r.communitySize === N) ?? decoy;
    // Prefer the SMALLEST-anonymity FMD row that still clears parity (largest n that qualifies),
    // so we recommend the strongest sender-side privacy (smallest fuzzy set) that beats decoy.
    const candidates = results
      .filter(
        r =>
          r.approach === 'fmd' &&
          r.communitySize === N &&
          r.anonymitySet >= decoyAtN.anonymitySet &&
          r.bytesDownloaded <= decoyAtN.bytesDownloaded,
      )
      .sort((a, b) => b.param - a.param); // largest n first
    const win = candidates[0];
    if (win) return {communitySize: N, n: win.param, p: Math.pow(2, -win.param)};
  }
  return null;
}

/** One-line crossover verdict, reusable in the exec summary and standalone (S3 signature). */
export function crossoverSummary(results: SimResult[]): string {
  const x = findCrossover(results);
  if (!x) {
    return 'No swept community size crosses over: the decoy cover-set remains cheaper-or-equal at the anonymity levels reached. Keep the decoy cover-set.';
  }
  return `FMD overtakes the decoy cover-set at community size N ≈ ${x.communitySize}, using p = 2^-${x.n} (${x.p.toExponential(2)}): at/above N it matches the decoy anonymity set for no more bandwidth, and its fuzzy set keeps growing with N while the decoy set stays fixed.`;
}

function tradeoffTable(results: SimResult[]): string {
  const header =
    '| N | approach | param | anonymity set | wraps/day | bytes/day | download s/day | detect ops/day |\n' +
    '|---:|:---|---:|---:|---:|---:|---:|---:|';
  const rows = results.map(r => {
    const param = r.approach === 'decoy' ? `k=${r.param}` : `n=${r.param}`;
    return `| ${r.communitySize} | ${r.approach} | ${param} | ${round(r.anonymitySet, 1)} | ${round(
      r.wrapsDownloaded,
      1,
    )} | ${fmtBytes(r.bytesDownloaded)} | ${round(r.downloadSeconds, 2)} | ${round(r.detectionOps, 1)} |`;
  });
  return [header, ...rows].join('\n');
}

function flagTaxSection(meta: ReportMeta, results: SimResult[]): string {
  const largest = meta.sizes[meta.sizes.length - 1] ?? 0;
  const worst = results
    .filter(r => r.approach === 'fmd' && r.communitySize === largest)
    .sort((a, b) => b.bytesDownloaded - a.bytesDownloaded)[0];
  const perFlag = meta.flagBytes;
  const lines = [
    '## Per-message flag tax',
    '',
    `Every message carries a serialized FMD flag of **${perFlag} bytes** (\`flagByteLength()\` at γ=24: u(33) + y(32) + ⌈γ/8⌉(3)). Unlike the decoy cover-set — where non-recipients cost a member NOTHING (the relay \`#p\` filter never ships them) — under FMD **every member downloads the flag on every false-positive wrap**. The tax is paid by the whole community, not just senders.`,
  ];
  if (worst) {
    const taxBytes = worst.wrapsDownloaded * perFlag;
    lines.push(
      '',
      `At the largest swept community (N=${largest}), the widest fuzzy set downloads ≈ ${round(
        worst.wrapsDownloaded,
        1,
      )} wraps/day, so the flag tax alone is ≈ ${fmtBytes(taxBytes)}/day/member on top of the wrap bodies.`,
    );
  }
  return lines.join('\n');
}

function linkabilitySection(): string {
  return [
    '## Linkability caveat (static detection keys)',
    '',
    'FMD detection keys are **static**, exactly like the decoy cover-set is a frozen per-identity set. But FMD is strictly WORSE on one axis: a relay handed a detection key gains a *matching capability*. Across reconnects it can intersect the fuzzy sets it returns and narrow toward the member\'s TRUE inbox — the decoy cover-set never hands the relay any such capability (it only ever sees a `#p` list it cannot distinguish from real interest).',
    '',
    'The expected intersection shrinks the candidate set geometrically: after `r` independent reconnects each returning a fuzzy set of expected size `p·totalDms`, a persistent decoy that survives all `r` sets does so with probability `p^r`, so the intersected non-recipient count trends to `p^r·totalDms`. Within a handful of reconnects the fuzzy set collapses toward the true set.',
    '',
    '**Mitigation:** per-epoch detection-key rotation — publish a fresh γ-subkey key each epoch and re-flag. This restores unlinkability across epochs but costs a re-flagging round (senders must fetch the new key) and breaks cross-epoch detection of older messages. This is a real cost the ship decision must weigh; the spike deliberately keeps detection **client-side** so NO matching capability is ever given to the relay.',
  ].join('\n');
}

function cpuSection(meta: ReportMeta, results: SimResult[]): string {
  const lines = ['## CPU cost (measured)', ''];
  if (meta.hermesFlagMs !== undefined || meta.hermesTestMs !== undefined) {
    lines.push(
      `**On-device (Hermes, T18-S6):** flag() ≈ ${meta.hermesFlagMs ?? '?'} ms/op, testFlag() ≈ ${
        meta.hermesTestMs ?? '?'
      } ms/op at n=4. Hermes runs pure-JS secp256k1 ~28× slower than V8 (the same gap that forces DM PoW onto the native StiqPow module). flag() is ≈ γ variable-base scalar-mults; testFlag() is ≈ n+1.`,
    );
    const largest = meta.sizes[meta.sizes.length - 1] ?? 0;
    const worst = results
      .filter(r => r.approach === 'fmd' && r.communitySize === largest)
      .sort((a, b) => b.detectionOps - a.detectionOps)[0];
    if (worst && meta.hermesTestMs !== undefined) {
      const detectSec = (worst.detectionOps * meta.hermesTestMs) / 1000;
      lines.push(
        '',
        `Client-side detection tests every downloaded wrap: at N=${largest} the widest fuzzy set is ≈ ${round(
          worst.detectionOps,
          1,
        )} testFlag()/day ⇒ ≈ ${round(
          detectSec,
          1,
        )} s/day of Hermes CPU just to detect — impractical without native flag/test acceleration.`,
      );
    }
  }
  if (meta.relayTestMs !== undefined) {
    const largest = meta.sizes[meta.sizes.length - 1] ?? 0;
    const totalDms = largest * meta.base.dmsPerMemberPerDay;
    const perReqSec = (totalDms * meta.relayTestMs) / 1000;
    lines.push(
      '',
      `**Relay-side projection (Go, T18-S5):** ≈ ${meta.relayTestMs} ms per Test() at n=4. A server-evaluated FMD REQ must test EVERY community message: at N=${largest} that is ≈ ${totalDms} tests ⇒ ≈ ${round(
        perReqSec,
        1,
      )} s per REQ. Server-side FMD is **infeasible on the request path** — this is the concrete basis for keeping detection client-side (T14 no-new-servers).`,
    );
  }
  if (lines.length === 2) lines.push('_No CPU measurements folded in (run T18-S5/S6 and pass them in ReportMeta)._');
  return lines.join('\n');
}

function decisionMatrix(results: SimResult[]): string {
  const x = findCrossover(results);
  const threshold = x ? `N ≈ ${x.communitySize}` : 'no crossover in the swept range';
  return [
    '## Decision matrix',
    '',
    '| Community size | Recommendation |',
    '|:---|:---|',
    `| Below ${x ? x.communitySize : 'threshold'} | **Keep the decoy cover-set** (subscriptionPlan.ts \`buildCoverSet\`). Its fixed anonymity set is cheaper and it hands the relay no matching capability. |`,
    `| At/above ${x ? x.communitySize : 'threshold'} AND native flag/test acceleration lands | **Consider FMD** at p = 2^-${
      x ? x.n : '?'
    }, with per-epoch key rotation to bound the linkability regression. Pure-JS Hermes cost rules it out until a native module exists. |`,
    '',
    `Crossover: ${threshold}.`,
  ].join('\n');
}

/**
 * Render the full markdown decision report. Sections: (1) executive recommendation, (2) trade-off
 * table per N, (3) per-message flag tax, (4) linkability caveat, (5) measured CPU, (6) decision matrix.
 */
export function renderReport(results: SimResult[], meta: ReportMeta): string {
  const x = findCrossover(results);
  const decoy = decoyBaseline(results);
  const recommendation = x
    ? `**Recommendation: keep the decoy cover-set today.** FMD only overtakes it at community size **N ≈ ${x.communitySize}** using **p = 2^-${x.n}** (${x.p.toExponential(
        2,
      )}), and even then only if native flag/test acceleration lands and per-epoch key rotation offsets the new linkability vector. Below that size the decoy set (currently ${
        decoy ? decoy.anonymitySet : 'k+1'
      } inboxes) is cheaper and leaks no matching capability.`
    : '**Recommendation: keep the decoy cover-set.** No swept community size makes FMD cheaper at equal anonymity.';

  return [
    '# FMD evaluation — decision report',
    '',
    '> EVAL-ONLY (T18, spike-not-production). Generated by `RUN_FMD_SWEEP=1 npx jest research/fmd/fmd.sim.test.ts`. FMD is **not** shipped: the decoy cover-set (subscriptionPlan.ts) remains the DM/mention metadata defense and `FMD_EVAL_ENABLED` defaults false.',
    '',
    `_Generated: ${meta.generatedAt}_`,
    '',
    '## Executive recommendation',
    '',
    recommendation,
    '',
    crossoverSummary(results),
    '',
    '### Model inputs',
    '',
    `- Community volume: ${meta.base.dmsPerMemberPerDay} DMs/member/day, ${meta.base.postsPerMemberPerDay} posts/member/day, mention fraction ${meta.base.mentionFraction}, wrap ${meta.base.wrapBytes} B.`,
    `- Tor link: ${meta.torLink.downlinkBytesPerSec} B/s downlink, ${meta.torLink.rttMs} ms RTT.`,
    `- Decoy count k=${meta.decoyCount} (anonymity ${meta.decoyCount + 1}); FMD precisions n∈{${meta.fmdBits.join(
      ', ',
    )}}; flag tax ${meta.flagBytes} B (\`flagByteLength()\` = ${flagByteLength()}).`,
    '',
    '## Trade-off table',
    '',
    tradeoffTable(results),
    '',
    flagTaxSection(meta, results),
    '',
    linkabilitySection(),
    '',
    cpuSection(meta, results),
    '',
    decisionMatrix(results),
    '',
  ].join('\n');
}
