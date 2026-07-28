import type {TorBackendEvent, TorReachConfig, TorStartConfig} from './types';

/**
 * The contract the native Tor daemon implements. On Android this is Arti, via StiqArtiModule.kt
 * driving the arti-ffi cdylib (see ./artiBackend.ts) — the former tor-android/IPtProxy C-tor backend
 * has been removed entirely. Keeping the manager behind this interface lets the state machine and
 * the no-clearnet-fallback guarantee be unit-tested without any native code.
 */
export interface TorBackend {
  /** Start the bundled Tor daemon with the given bridge config. */
  start(config: TorStartConfig): Promise<void>;
  /** Stop the daemon and tear down the circuit. */
  stop(): Promise<void>;
  /** Subscribe to bootstrap/status events. Returns an unsubscribe function. */
  subscribe(listener: (event: TorBackendEvent) => void): () => void;
  /**
   * Install reach credentials into the LIVE daemon (no restart) and kick the deferred
   * reachability verification. Optional: a backend without it (jest fakes, UnavailableTorBackend)
   * simply forces the caller down the restart path it always used. See TorReachConfig.
   */
  installReach?(config: TorReachConfig): Promise<void>;
}
