/**
 * Wall-clock attribution for a single Tor bootstrap attempt (connect-clock instrumentation).
 *
 * WHY THIS EXISTS: `build.gradle` records the app's real-world connect time as "30-90s", but
 * nobody knows how that budget is *spent* — whether it goes to spawning the daemon, fetching the
 * consensus, pulling relay descriptors, or building the circuit. Optimising a 60-second number you
 * cannot attribute is guesswork, so this module turns the existing `bootstrapping` percent stream
 * (see {@link ./types}.TorBackendEvent) into a per-phase breakdown the connect work can be held to.
 *
 * A PURE, LEAF model module in the style of ladder.ts / bootstrapCoalescer.ts: it holds no timers,
 * calls no clock of its own, and touches nothing native. Every timestamp is passed IN, so the whole
 * thing is jest-testable with zero fake timers and zero native code.
 *
 * ATTRIBUTION RULE: elapsed time is charged to the phase the daemon was *in*, not the one a sample
 * announces it has reached. A `bootstrapping 40%` line means "descriptors are starting now", so the
 * time since the previous line belongs to the phase before it — the consensus fetch. Getting this
 * backwards would shift the entire blame one phase late and point the optimisation at the wrong
 * code.
 */

/** Coarse phases of a Tor bootstrap, in the order the daemon walks them. */
export type BootstrapPhaseId =
  | 'connect'
  | 'consensus'
  | 'certs'
  | 'descriptors'
  | 'finalize';

export interface BootstrapPhase {
  id: BootstrapPhaseId;
  /** INCLUSIVE upper bound of the Tor bootstrap percent belonging to this phase. */
  upTo: number;
  /** Plain-language label — STIQ-authored, never Tor's raw summary text. */
  label: string;
}

/**
 * The percent bands, mapped from ARTI's own bootstrap stream — MEASURED on a real device, and
 * replacing the old C-tor milestone mapping this table used to carry:
 *
 *   percent = conn_status*0.15 + dir_status*0.85
 *
 *   0-14   establishing the first connection ("connecting to the internet", "handshaking with
 *          Tor relays")                                                       → connect
 *   15-20  directory reachable, consensus downloading                        → consensus
 *          MEASURED: on a cold start this sits at a FLAT 15% for ~100s — Arti reports no
 *          intermediate progress while the consensus downloads, so anything watching for "no
 *          progress" must tolerate that whole plateau instead of treating it as a stall.
 *   21-30  fetching authority certificates (observed "0/9" climbing to "9/9")   → certs
 *   31-89  fetching relay descriptors/microdescriptors, through "directory is usable" →
 *          descriptors
 *   90-100 connected / finalizing                                             → finalize
 *
 * Unlike C-tor, this stream has NO separate circuit-building phase: once the directory is
 * usable the daemon is considered bootstrapped.
 *
 * Bands are contiguous and the last one ends at 100, so every percent resolves to exactly one
 * phase (bootstrapTiming.test.ts enforces both properties).
 */
const FINALIZE_PHASE: BootstrapPhase = {
  id: 'finalize',
  upTo: 100,
  label: 'Finishing up',
};

export const BOOTSTRAP_PHASES: readonly BootstrapPhase[] = [
  {id: 'connect', upTo: 14, label: 'Connecting to the Tor network'},
  {id: 'consensus', upTo: 20, label: 'Fetching the consensus'},
  {id: 'certs', upTo: 30, label: 'Fetching authority certificates'},
  {id: 'descriptors', upTo: 89, label: 'Fetching relay descriptors'},
  FINALIZE_PHASE,
];

/** The phase a given bootstrap percent belongs to. Out-of-range percents clamp to the ends. */
export function phaseForPercent(percent: number): BootstrapPhase {
  for (const phase of BOOTSTRAP_PHASES) {
    if (percent <= phase.upTo) {
      return phase;
    }
  }
  return FINALIZE_PHASE;
}

/**
 * The phase at a cursor index. Total (never undefined under `noUncheckedIndexedAccess`) so the
 * charging path below needs no non-null assertions: an out-of-range cursor can only mean we have
 * walked off the end, which is the terminal phase.
 */
function phaseAt(index: number): BootstrapPhase {
  return BOOTSTRAP_PHASES[index] ?? FINALIZE_PHASE;
}

/** Index of a percent's phase, used to keep the cursor monotonic. */
function phaseIndexForPercent(percent: number): number {
  const target = phaseForPercent(percent);
  return BOOTSTRAP_PHASES.findIndex(p => p.id === target.id);
}

export interface PhaseTiming {
  id: BootstrapPhaseId;
  label: string;
  /** Wall-clock milliseconds spent in this phase. Never negative. */
  ms: number;
  /** The last summary tor reported while in this phase, when it provided one. */
  lastSummary?: string;
}

/** A named instant within an attempt, measured from the moment the timeline started. */
export interface TimelineMark {
  name: string;
  atMs: number;
}

export interface BootstrapTimeline {
  /** Record a `bootstrapping` event. No-op once {@link finish} has been called. */
  sample(percent: number, nowMs: number, summary?: string): void;
  /**
   * Record a named instant that tor's percent stream cannot express.
   *
   * The `launch` phase is otherwise opaque: it lumps together the native teardown barrier, the
   * always-on PT warm-up, and the TorService bind, so a bare "launch 14.0s" says nothing about
   * WHICH of them to go fix. Marks split it without inventing fake bootstrap phases.
   *
   * First write wins for a given name, so a retry inside one attempt cannot overwrite the original
   * instant. No-op once {@link finish} has been called.
   */
  mark(name: string, nowMs: number): void;
  /** Named instants in the order they were recorded. */
  marks(): TimelineMark[];
  /** Freeze the timeline, charging the trailing gap to the current phase. Idempotent. */
  finish(nowMs: number): void;
  /** Phases that consumed time, in bootstrap order. Zero-cost phases are omitted. */
  breakdown(): PhaseTiming[];
  /** The phase that consumed the most time, or null when nothing has been recorded. */
  slowest(): PhaseTiming | null;
  /** Sum of all phase durations. */
  totalMs(): number;
  /** Compact single-line log form, with the dominant phase flagged. */
  format(): string;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Start a timeline. `startMs` should be the moment connect() was called — BEFORE the daemon is
 * spawned — so the `launch` phase honestly includes the native teardown barrier rather than hiding
 * it in an unmeasured gap.
 */
export function createBootstrapTimeline(startMs: number): BootstrapTimeline {
  const accum = new Map<BootstrapPhaseId, number>();
  const summaries = new Map<BootstrapPhaseId, string>();
  const marked = new Map<string, number>(); // name → ms since startMs; insertion-ordered
  let cursor = 0; // index into BOOTSTRAP_PHASES; only ever moves forward
  let lastTsMs = startMs;
  let done = false;

  /** Charge the gap since the previous event to whatever phase we were in. */
  const chargeElapsed = (nowMs: number): void => {
    // Clamp: a backwards clock (NTP step, device sleep accounting) must never mint negative time.
    const delta = Math.max(0, nowMs - lastTsMs);
    const phase = phaseAt(cursor);
    accum.set(phase.id, (accum.get(phase.id) ?? 0) + delta);
    lastTsMs = nowMs;
  };

  return {
    sample(percent, nowMs, summary) {
      if (done) {
        return;
      }
      chargeElapsed(nowMs);
      if (summary) {
        summaries.set(phaseAt(cursor).id, summary);
      }
      // Monotonic cursor: a stray late STATUS broadcast can report a LOWER percent than we have
      // already passed (TorManager documents exactly this). Advancing only forwards keeps that
      // stray from re-opening a finished phase and double-charging it.
      const next = phaseIndexForPercent(percent);
      if (next > cursor) {
        cursor = next;
      }
    },

    mark(name, nowMs) {
      if (done || marked.has(name)) {
        return; // first write wins; a settled attempt takes no more marks
      }
      marked.set(name, Math.max(0, nowMs - startMs));
    },

    marks() {
      return [...marked].map(([name, atMs]) => ({name, atMs}));
    },

    finish(nowMs) {
      if (done) {
        return;
      }
      chargeElapsed(nowMs);
      done = true;
    },

    breakdown() {
      const out: PhaseTiming[] = [];
      for (const phase of BOOTSTRAP_PHASES) {
        const ms = accum.get(phase.id) ?? 0;
        if (ms <= 0) {
          continue; // a phase tor blew straight through is noise in a breakdown
        }
        const lastSummary = summaries.get(phase.id);
        out.push({
          id: phase.id,
          label: phase.label,
          ms,
          ...(lastSummary ? {lastSummary} : {}),
        });
      }
      return out;
    },

    slowest() {
      let best: PhaseTiming | null = null;
      for (const timing of this.breakdown()) {
        if (!best || timing.ms > best.ms) {
          best = timing;
        }
      }
      return best;
    },

    totalMs() {
      let total = 0;
      for (const ms of accum.values()) {
        total += ms;
      }
      return total;
    },

    format() {
      const parts = this.breakdown();
      const worst = this.slowest();
      const body = parts.map(p => {
        const flag = worst && p.id === worst.id && parts.length > 1 ? ' ←' : '';
        return `${p.id} ${formatSeconds(p.ms)}${flag}`;
      });
      const line = [`${formatSeconds(this.totalMs())} total`, ...body].join(' · ');
      const instants = this.marks();
      if (instants.length === 0) {
        return line;
      }
      // Marks ride as a suffix so the phase breakdown stays scannable on its own.
      return `${line} | ${instants
        .map(m => `${m.name} @${formatSeconds(m.atMs)}`)
        .join(', ')}`;
    },
  };
}
