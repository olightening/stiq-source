/**
 * Connection state model for the Tor transport.
 *
 * The real Tor daemon, obfs4 bridges, and WebSocket wiring land in PLAN.md Steps 4–5.
 * This module only defines the state machine the UI renders against, so the offline-first
 * posture (no clearnet fallback) is encoded from the very first build.
 */
import type {ConnectionPhase} from './tor/ladder';

export type ConnectionState =
  | 'disconnected'
  | 'starting-tor'
  | 'connecting-bridge'
  | 'connected'
  | 'offline';

/** Human-readable label for each state. Used by the offline-gated shell. */
export function describeConnection(state: ConnectionState): string {
  switch (state) {
    case 'disconnected':
      return 'Disconnected';
    case 'starting-tor':
      return 'Starting Tor…';
    case 'connecting-bridge':
      return 'Connecting through bridge…';
    case 'connected':
      return 'Connected via Tor';
    case 'offline':
      return 'Offline — Tor unavailable';
  }
}

/**
 * Banner label that folds Tor's live bootstrap percentage into the two actively-connecting states,
 * so a returning user on a slow network sees forward progress ("Connecting through Tor · 45%") instead
 * of a static, alarming "Starting Tor…"/"Offline". The terminal states (offline/disconnected) keep the
 * honest flat wording — App.tsx clears the bootstrap percent when the daemon genuinely gives up, so a
 * dead circuit must NOT read as "connecting".
 */
export function connectionLabel(state: ConnectionState, percent?: number | null): string {
  if (
    (state === 'starting-tor' || state === 'connecting-bridge') &&
    typeof percent === 'number' &&
    percent > 0
  ) {
    return `Connecting through Tor · ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }
  return describeConnection(state);
}

/** Whether the main feed may render. Only a live Tor circuit unlocks the UI. */
export function isOnline(state: ConnectionState): boolean {
  return state === 'connected';
}

/**
 * Guided-ladder-aware banner label (T2). When the app is walking the auto-fallback ladder it hands
 * us a stiq-authored {@link ConnectionPhase}; while still connecting/offline we surface that plain-
 * language line verbatim (e.g. "Trying obfs4 bridges · 45%", "Connecting directly through Tor is
 * taking too long") instead of the generic state label — this is the "always a plain-language state"
 * requirement. With no phase (flag off, or once connected) it falls back to {@link connectionLabel},
 * so behaviour is byte-identical to today when the guided ladder is disabled. describeConnection /
 * connectionLabel / isOnline are intentionally untouched (the feed gate stays connected-only).
 */
export function phaseAwareLabel(
  state: ConnectionState,
  phase: ConnectionPhase | null | undefined,
  percent?: number | null,
): string {
  if (
    phase &&
    (state === 'starting-tor' || state === 'connecting-bridge' || state === 'offline')
  ) {
    return phase.plainLabel;
  }
  return connectionLabel(state, percent);
}
