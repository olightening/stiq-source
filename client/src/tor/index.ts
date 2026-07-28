/**
 * Public Tor transport API. The rest of the app obtains its only transport from here.
 */
export * from './types';
export {
  DEFAULT_TRANSPORT,
  defaultBridgeLines,
  buildTorrcBridgeLines,
  buildStartConfig,
} from './bridges';
export {TorManager, requireTorTransport, type TorManagerOptions} from './TorManager';
export {
  deriveOnionAuth,
  getActiveOnionAuth,
  setActiveOnionAuth,
  isValidAuthKeyBase32,
  onionHostOf,
  // The reachability-probe target (TorStartConfig.relayOnion). Published alongside
  // setActiveOnionAuth on community (re)activation — it must be set for PUBLIC communities too,
  // which carry no auth credential but do have a relay onion to probe.
  setActiveRelayOnion,
  getActiveRelayOnion,
  relayOnionHostOf,
  type OnionAuth,
} from './onionAuth';
export type {TorBackend} from './backend';
/**
 * Off-seam daemon controls (NEWNYM, dormancy). Exported from here so callers get the accessor
 * instead of reaching into `NativeModules.StiqArti` themselves — see ./daemonControl for why every
 * off-seam call is routed through that one chokepoint.
 */
export {getTorDaemonControl, type TorDaemonControl} from './daemonControl';

import {TorManager, type TorManagerOptions} from './TorManager';
import type {TorBackend} from './backend';
import {ArtiTorBackend, getArtiTorModule} from './artiBackend';
import {CTorBackend, getCtorTorModule} from './ctorBackend';
import {UnavailableTorBackend} from './backend.fake';

/**
 * Returns the Tor backend for whichever engine module this binary linked. The Android build
 * ships as two feature-identical product flavors that differ only here (the `tor` flavor
 * dimension in app/build.gradle):
 *
 *   arti — NativeModules.StiqArti → ArtiTorBackend (Rust arti-client)
 *   ctor — NativeModules.StiqTor  → CTorBackend (info.guardianproject:tor-android + IPtProxy)
 *
 * The JS bundle is identical in both flavors, so this probe — not a build flag — is the engine
 * selection. Arti wins if both modules were ever present (no shipped flavor links both). When
 * neither is linked (jest/host, or a build that didn't package its engine's native library) the
 * app surfaces an offline state via UnavailableTorBackend — NEVER a clearnet path
 * (ALLOW_CLEARNET_FALLBACK stays false).
 */
export function createTorBackend(): TorBackend {
  const arti = getArtiTorModule();
  if (arti) return new ArtiTorBackend(arti);
  const ctor = getCtorTorModule();
  if (ctor) return new CTorBackend(ctor);
  return new UnavailableTorBackend();
}

export function createTorManager(options?: TorManagerOptions): TorManager {
  return new TorManager(createTorBackend(), options);
}
