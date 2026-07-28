/**
 * Guided auto-fallback transport ladder (T2 — auto-escalating transport ladder).
 *
 * A PURE, LEAF model module (like bridges.ts): it owns the ordered 4-rung auto ladder
 * direct → bundled-obfs4 → moat-fetched-webtunnel → bundled-snowflake, the per-rung no-progress /
 * hard-ceiling
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
export type AutoRungId =
  | 'direct'
  | 'obfs4-bundled'
  | 'fetched-bridges'
  | 'snowflake-bundled';

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
 * The walker in App.tsx connectGuided() and describePhase() are index/data-driven, so adding a
 * rung here is the whole change — a bundled rung's lines resolve through defaultBridgeLines() with
 * no App.tsx edit.
 *
 * Order is fastest/least-conspicuous first: direct Tor, then the bundled obfs4 pool (no network
 * round-trip to start), then freshly moat-fetched WebTunnel bridges, and finally bundled Snowflake
 * as the reaches-where-others-are-blocked last resort — the WebRTC transport that survives when
 * every IP-addressed bridge is blocked, which is exactly the network the auto ladder must not give
 * up on. Per-rung noProgressMs < hardCeilingMs is an invariant (inner no-progress guard fires
 * before the outer hard ceiling) — the walker relies on it so a slow-but-advancing rung is not
 * cut off.
 */
export const AUTO_LADDER: readonly AutoRung[] = [
  {
    id: 'direct',
    transport: 'direct',
    useFetchedBridges: false,
    // MEASURED (real device, cold start): the consensus download alone took ~100s, with Arti
    // sitting at a FLAT 15% the entire time — it reports no intermediate progress while the
    // consensus downloads, so a "no progress" timer must tolerate that whole plateau or it kills
    // a rung that was only seconds from succeeding. 20s/60s (the old C-tor-derived values) gave up
    // long before a cold consensus fetch could finish; these clear the measured ~100s with margin.
    noProgressMs: 120_000,
    hardCeilingMs: 180_000,
    label: 'Connecting directly through Tor',
  },
  {
    id: 'obfs4-bundled',
    transport: 'obfs4',
    useFetchedBridges: false,
    // If direct failed, the consensus almost certainly did NOT arrive, so this rung faces the same
    // cold fetch — over a bridge, which is slower. Hence the same 120s no-progress floor.
    //
    // The CEILING is deliberately not scaled in proportion. These two numbers answer different
    // questions: `noProgressMs` must clear the 15% plateau or it kills a healthy rung, whereas
    // `hardCeilingMs` only bounds how long a user stares at "connecting" before the ladder moves
    // on. Scaling both together would have put the last rung at a 12-minute ceiling and the whole
    // walk past 20 minutes — worse for the user than failing over sooner and retrying.
    noProgressMs: 120_000,
    hardCeilingMs: 240_000,
    label: 'Trying obfs4 bridges',
  },
  {
    id: 'fetched-bridges',
    transport: 'webtunnel',
    useFetchedBridges: true,
    // Same floor and ceiling as obfs4: it is the same work over a different transport.
    noProgressMs: 120_000,
    hardCeilingMs: 240_000,
    label: 'Fetching fresh bridges and connecting',
  },
  {
    id: 'snowflake-bundled',
    transport: 'snowflake',
    // Bundled: Snowflake needs no fetched bridge address at all — DEFAULT_SNOWFLAKE_BRIDGES carries
    // the broker/front/ICE config, so this rung dials with zero network round-trip to start.
    useFetchedBridges: false,
    // Snowflake reaches the network by WebRTC rendezvous through a volunteer proxy, not a direct
    // bridge dial, so it sits at a flat "conn_done" plateau (no percent gain) while the broker finds
    // a proxy — longer than obfs4/webtunnel's consensus plateau. The no-progress floor must clear
    // that rendezvous or it kills a rung that was only waiting on a proxy match, so it is raised to
    // 180s (matching the reach preset's long snowflake timeout). As the LAST rung there is nothing
    // to escalate to; the ceiling only bounds how long the user stares before the ladder restarts
    // from the top, so it is the widest of the four.
    noProgressMs: 180_000,
    hardCeilingMs: 300_000,
    label: 'Reaching through Snowflake',
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
