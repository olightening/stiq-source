/**
 * Guided auto-fallback transport ladder (T2 — auto-escalating transport ladder).
 *
 * A PURE, LEAF model module (like bridges.ts): it owns the ordered 3-rung auto ladder
 * direct → bundled-obfs4 → moat-fetched-bridges, the per-rung no-progress / hard-ceiling
 * timeouts, and a small plain-language ConnectionPhase model with a pure describePhase()
 * reducer. It performs NO side effects and makes NO native/App/bridgeCache calls, so it is
 * jest-testable with zero native code.
 *
 * The walker lives in App.tsx connectGuided() (a later subtask): it steps AUTO_LADDER,
 * races each rung's manager.connect() against the OUTER hardCeilingMs while TorManager's
 * existing no-progress timer stays as the INNER guard (noProgressMs), and renders the
 * ConnectionPhase this module produces. Gated by config.GUIDED_AUTO_LADDER (ship-dark).
 *
 * plainLabel strings are STIQ-authored: Tor's own raw bootstrap summary is NEVER threaded
 * through here — the whole point of the ladder is a self-narrating, plain-language state.
 */
import type {TransportType} from './types';

/** Stable identifier for each guided rung, in ladder order. */
export type AutoRungId = 'direct' | 'obfs4-bundled' | 'fetched-bridges';

/**
 * One rung of the guided auto ladder.
 *
 * INVARIANT: noProgressMs < hardCeilingMs on every rung. noProgressMs is the INNER
 * TorManager no-progress guard (re-armed on each percent gain); hardCeilingMs is the OUTER
 * wall-clock ceiling the walker races against. The inner guard must be able to fire and
 * escalate before the outer ceiling trips, so a slow-but-advancing rung is not cut off early.
 */
export interface AutoRung {
  id: AutoRungId;
  transport: TransportType;
  /** true → the rung dials moat-fetched bridges (bridgeFetch.ts) rather than a bundled set. */
  useFetchedBridges: boolean;
  /** Inner no-progress ceiling (ms): re-armed on every bootstrap percent increase. */
  noProgressMs: number;
  /** Outer hard wall-clock ceiling (ms): always fires, always surfaces a phase. */
  hardCeilingMs: number;
  /** STIQ-authored plain-language label for this rung's active state. */
  label: string;
}

/**
 * APPEND SEAM for T14 — add Snowflake/WebTunnel AutoRung entries here; the walker in
 * App.tsx connectGuided() and describePhase() are index/data-driven and need no change.
 *
 * Order is fastest/least-conspicuous first: direct Tor, then the bundled obfs4 pool (no
 * network round-trip to start), then freshly moat-fetched WebTunnel bridges. Per-rung
 * noProgressMs < hardCeilingMs is an invariant (inner no-progress guard fires before the
 * outer hard ceiling) — the walker relies on it so a slow-but-advancing rung is not cut off.
 */
export const AUTO_LADDER: readonly AutoRung[] = [
  {
    id: 'direct',
    transport: 'direct',
    useFetchedBridges: false,
    noProgressMs: 20_000,
    hardCeilingMs: 60_000,
    label: 'Connecting directly through Tor',
  },
  {
    id: 'obfs4-bundled',
    transport: 'obfs4',
    useFetchedBridges: false,
    noProgressMs: 45_000,
    hardCeilingMs: 90_000,
    label: 'Trying obfs4 bridges',
  },
  {
    id: 'fetched-bridges',
    transport: 'webtunnel',
    useFetchedBridges: true,
    noProgressMs: 60_000,
    hardCeilingMs: 120_000,
    label: 'Fetching fresh bridges and connecting',
  },
];

/**
 * The lifecycle states a rung passes through, as seen by the UI:
 * - starting: the rung's connect() has been kicked off, no percent yet.
 * - bootstrapping: Tor is advancing; percent is meaningful.
 * - ceiling-exceeded: the rung's outer hardCeilingMs fired before it connected.
 * - escalating: the walker is moving to the next rung.
 * - connected: a rung reached the network — terminal success.
 * - exhausted: every rung's ceiling fired without connecting — terminal (keeps retrying).
 */
export type PhaseKind =
  | 'starting'
  | 'bootstrapping'
  | 'ceiling-exceeded'
  | 'escalating'
  | 'connected'
  | 'exhausted';

/** A snapshot of the guided connect state, ready to render as a plain-language line. */
export interface ConnectionPhase {
  rungId: AutoRungId;
  /** Index of this rung within AUTO_LADDER. */
  rungIndex: number;
  /** AUTO_LADDER.length — lets the UI show "step N of M". */
  totalRungs: number;
  kind: PhaseKind;
  /** Bootstrap percent (0–100), when a bootstrapping percentage is known. */
  percent?: number;
  /** STIQ-authored, plain-language state string (never Tor's raw summary). */
  plainLabel: string;
}

/** Terminal exhaustion label — shown when every rung's ceiling fired without connecting. */
export const CEILING_EXHAUSTED_LABEL =
  'Still trying every path to reach your community over Tor…';

/**
 * Pure reducer: derive the renderable ConnectionPhase for a rung + lifecycle kind.
 *
 * plainLabel is a switch on kind and is ALWAYS stiq-authored — a caller-supplied Tor
 * bootstrap summary is intentionally NOT an input and can never leak into the output.
 */
export function describePhase(
  rung: AutoRung,
  kind: PhaseKind,
  percent?: number,
): ConnectionPhase {
  let plainLabel: string;
  switch (kind) {
    case 'starting':
    case 'bootstrapping':
      plainLabel =
        percent !== undefined && percent > 0
          ? `${rung.label} · ${Math.round(percent)}%`
          : rung.label;
      break;
    case 'ceiling-exceeded':
      plainLabel = `${rung.label} is taking too long`;
      break;
    case 'escalating':
      plainLabel = 'Switching to a harder-to-block path…';
      break;
    case 'connected':
      plainLabel = 'Connected via Tor';
      break;
    case 'exhausted':
      plainLabel = CEILING_EXHAUSTED_LABEL;
      break;
  }
  return {
    rungId: rung.id,
    rungIndex: AUTO_LADDER.findIndex(r => r.id === rung.id),
    totalRungs: AUTO_LADDER.length,
    kind,
    percent,
    plainLabel,
  };
}

/**
 * Index of the next rung after `current`, or -1 when the ladder is exhausted (past the last
 * rung). Never wraps around — exhaustion is a distinct terminal signal, not rung 0 again.
 */
export function nextRungIndex(current: number, total: number = AUTO_LADDER.length): number {
  return current + 1 < total ? current + 1 : -1;
}
