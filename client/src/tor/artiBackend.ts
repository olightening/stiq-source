/**
 * ArtiTorBackend — the T17 spike's SECOND embedded-Tor backend, gated dark behind
 * USE_ARTI_BACKEND (config.ts). It is a structural twin of {@link NativeTorBackend}
 * (nativeBackend.ts): same TorBackend contract, same 'StiqTorStatus' event name, same
 * TorBackendEvent wire shapes — so NOTHING above the TorBackend seam changes when the flag
 * selects it (TorManager.eventToState, connection.ts, the App.tsx cascade, torSocket.ts all
 * stay byte-identical). The ONLY difference is which native module it reads: the spike's
 * StiqArti (arti-client cdylib) instead of the shipping StiqTor (tor-android + IPtProxy).
 *
 * Spike-only. USE_ARTI_BACKEND defaults false, so this class is inert in a shipping build.
 * When the flag is on but the StiqArti native module is absent (jest/host, or a build that
 * didn't package the Arti .so), createTorBackend() falls back to UnavailableTorBackend —
 * offline, NEVER a clearnet path (honoring ALLOW_CLEARNET_FALLBACK=false). See index.ts.
 *
 * The native module (Android: StiqArtiModule.kt driving the arti-ffi cdylib) must:
 *   - expose async `startTor(config)` / `stopTor()` with the SAME TorStartConfig contract
 *   - emit `StiqTorStatus` events shaped like TorBackendEvent as Arti bootstraps
 *   - own its own onion client-auth (restricted discovery) + PT config internally
 * See client/arti-ffi/ for the Rust FFI and StiqArtiModule.kt for the RN bridge.
 */
import {NativeEventEmitter, NativeModules, type NativeModule} from 'react-native';
import type {TorBackend} from './backend';
import type {TorBackendEvent, TorStartConfig} from './types';

/**
 * The minimal native contract ArtiTorBackend depends on — intentionally identical to the
 * shipping StiqTor surface used by NativeTorBackend, so the TS layer needs zero wire changes.
 * newCircuit()/getHttpTunnelPort() are deliberately NOT here: exactly like the incumbent, those
 * are called directly off NativeModules.StiqArti by their callers, not through this backend.
 */
interface StiqArtiNativeModule {
  startTor(config: TorStartConfig): Promise<void>;
  stopTor(): Promise<void>;
}

// The SAME device-event name the shipping StiqTor module emits. Reusing it verbatim is what lets
// TorManager subscribe without knowing (or caring) which backend is live.
const STATUS_EVENT = 'StiqTorStatus';

/** The Arti native module, or undefined when it has not been built into this binary. */
export function getArtiTorModule(): StiqArtiNativeModule | undefined {
  return (NativeModules as {StiqArti?: StiqArtiNativeModule}).StiqArti;
}

export class ArtiTorBackend implements TorBackend {
  private readonly emitter: NativeEventEmitter;

  constructor(private readonly native: StiqArtiNativeModule) {
    this.emitter = new NativeEventEmitter(native as unknown as NativeModule);
  }

  start(config: TorStartConfig): Promise<void> {
    // config.transport is forwarded VERBATIM to the native layer, exactly like NativeTorBackend —
    // the accepted strings are the native contract (see transportContract.test.ts). Do not remap
    // here. (For the spike the Arti side may reject non-'direct' transports until PT lands; that is
    // an FFI-level error surfaced as a 'StiqTorStatus' {kind:'error'} event, not a TS concern.)
    return this.native.startTor(config);
  }

  stop(): Promise<void> {
    return this.native.stopTor();
  }

  subscribe(listener: (event: TorBackendEvent) => void): () => void {
    const sub = this.emitter.addListener(STATUS_EVENT, (event: TorBackendEvent) =>
      listener(event),
    );
    return () => sub.remove();
  }
}
