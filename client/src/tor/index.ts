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
export {TOR_MIN_SUPPORTED_VERSION, parseTorVersion, torVersionAtLeast} from './torVersion';
export {
  deriveOnionAuth,
  getActiveOnionAuth,
  setActiveOnionAuth,
  isValidAuthKeyBase32,
  onionHostOf,
  type OnionAuth,
} from './onionAuth';
export type {TorBackend} from './backend';

import {USE_ARTI_BACKEND} from '../config';
import {TorManager, type TorManagerOptions} from './TorManager';
import type {TorBackend} from './backend';
import {NativeTorBackend, getNativeTorModule} from './nativeBackend';
import {ArtiTorBackend, getArtiTorModule} from './artiBackend';
import {UnavailableTorBackend} from './backend.fake';

/**
 * Returns the real native Tor backend (StiqTor native module) when the module is linked,
 * otherwise an UnavailableTorBackend that immediately goes offline.  There is no clearnet
 * fallback — if the native module is absent the app surfaces an offline state.
 *
 * T17 spike: when USE_ARTI_BACKEND is on (dark, default false), route to the experimental Arti
 * (pure-Rust) backend via the StiqArti native module instead. This is the ONLY control-flow edit
 * above the TorBackend seam. If Arti is selected but its native module is absent (a build that
 * didn't package the Arti .so, or jest/host), degrade to UnavailableTorBackend — offline, NEVER a
 * clearnet path (ALLOW_CLEARNET_FALLBACK stays false). With the flag OFF this is byte-identical to
 * before: the incumbent NativeTorBackend/UnavailableTorBackend logic below.
 */
export function createTorBackend(): TorBackend {
  if (USE_ARTI_BACKEND) {
    const arti = getArtiTorModule();
    return arti ? new ArtiTorBackend(arti) : new UnavailableTorBackend();
  }
  const native = getNativeTorModule();
  return native ? new NativeTorBackend(native) : new UnavailableTorBackend();
}

export function createTorManager(options?: TorManagerOptions): TorManager {
  return new TorManager(createTorBackend(), options);
}
