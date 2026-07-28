/**
 * The ONE place that answers "which native Tor daemon is live?" for calls that sit OFF the
 * {@link ./backend}.TorBackend seam.
 *
 * WHY THIS EXISTS: TorBackend covers start/stop/subscribe, but three things the app does to a
 * RUNNING daemon are not part of that contract — `newCircuit()` (NEWNYM, which the relay-retry path
 * depends on because onion rendezvous circuits are per-circuit flaky), and `setDormant()`/
 * `setActive()` (SIGNAL DORMANT/ACTIVE, so a backgrounded app idles the daemon instead of killing
 * and cold-restarting it). Routing every off-seam call through here (instead of every caller
 * reaching for `NativeModules.StiqArti` directly) keeps the engine choice single-sourced with
 * createTorBackend() — one place resolves "which native module", every off-seam caller agrees.
 *
 * Also the canonical home for {@link getNetworkClass} (coarse transport class of the device's
 * default network): a different off-seam call with the same shape (reads a native module directly,
 * historically NativeModules.StiqTor) that lived in the now-deleted nativeBackend.ts.
 */
import {NativeModules} from 'react-native';

/**
 * Direct controls on an already-running daemon. Every method is optional: a backend may implement
 * only some of them, and callers must tolerate absence (these are best-effort signals, never gates).
 */
export interface TorDaemonControl {
  /** NEWNYM — ask for fresh circuits. */
  newCircuit?: () => void;
  /** SIGNAL DORMANT — idle the daemon while backgrounded. */
  setDormant?: () => void;
  /** SIGNAL ACTIVE — wake it on resume. */
  setActive?: () => void;
  /** Local HTTP CONNECT tunnel port, for consumers that cannot speak SOCKS5. */
  getHttpTunnelPort?: () => Promise<number>;
}

/**
 * The active daemon's control surface, or undefined when it is not present.
 *
 * Read at CALL time (not module load) so it reflects whatever is linked into this binary, and so
 * tests can seed NativeModules per-case. Probes the same engine modules, in the same order, as
 * createTorBackend() (index.ts): StiqArti (arti flavor) first, then StiqTor (ctor flavor). Both
 * engines expose the same method names; C-tor's Kotlin methods declare a trailing Promise
 * parameter, which the RN bridge absorbs — the JS-side call shape is identical.
 */
export function getTorDaemonControl(): TorDaemonControl | undefined {
  const mods = NativeModules as {StiqArti?: TorDaemonControl; StiqTor?: TorDaemonControl};
  return mods.StiqArti ?? mods.StiqTor;
}

interface EngineNetworkModule {
  // Coarse transport class of the current default network. Implemented by BOTH engines
  // (@ReactMethod getNetworkClass in StiqArtiModule.kt and StiqTorModule.kt — same
  // ConnectivityManager classification, same strings). Absent only on older binaries/jest →
  // getNetworkClass() below returns 'unknown'.
  getNetworkClass?(): Promise<string>;
}

/**
 * Coarse transport class of the device's default network. Used to key the per-network-class bridge
 * cache (./bridgeCache). 'unknown' means the device could not classify (no native module in jest,
 * no active network, or a value the native layer didn't recognize).
 */
export type NetworkClass =
  | 'wifi'
  | 'cellular'
  | 'ethernet'
  | 'vpn'
  | 'other'
  | 'unknown';

/**
 * Resolve the current network class from the native module, normalizing any unexpected/absent
 * value to 'unknown'. Never rejects — a classification failure must never break Tor connect logic.
 */
export async function getNetworkClass(): Promise<NetworkClass> {
  const mods = NativeModules as {StiqArti?: EngineNetworkModule; StiqTor?: EngineNetworkModule};
  const m = mods.StiqArti ?? mods.StiqTor;
  if (!m?.getNetworkClass) return 'unknown';
  try {
    const s = await m.getNetworkClass();
    return (['wifi', 'cellular', 'ethernet', 'vpn', 'other'] as string[]).includes(s)
      ? (s as NetworkClass)
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
