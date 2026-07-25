import type {TorBackendEvent, TorStartConfig} from './types';

/**
 * The contract the native Tor daemon implements (iOS Tor.framework, Android tor-android).
 * Keeping the manager behind this interface lets the state machine and the
 * no-clearnet-fallback guarantee be unit-tested without any native code.
 */
export interface TorBackend {
  /** Start the bundled Tor daemon with the given bridge config. */
  start(config: TorStartConfig): Promise<void>;
  /** Stop the daemon and tear down the circuit. */
  stop(): Promise<void>;
  /** Subscribe to bootstrap/status events. Returns an unsubscribe function. */
  subscribe(listener: (event: TorBackendEvent) => void): () => void;
}
