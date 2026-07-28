/**
 * ArtiTorBackend — the app's ONLY embedded-Tor backend (T17: Arti, pure-Rust Tor). The former
 * C-tor/IPtProxy backend (NativeTorBackend, StiqTorModule.kt) has been removed entirely, and the
 * USE_ARTI_BACKEND flag that used to gate this dark is gone — createTorBackend() (index.ts) always
 * selects Arti now.
 *
 * The native module (Android: StiqArtiModule.kt driving the arti-ffi cdylib) must:
 *   - expose async `startTor(config)` / `stopTor()` with the SAME TorStartConfig contract
 *   - emit `StiqTorStatus` events shaped like TorBackendEvent as Arti bootstraps
 *   - own its own onion client-auth (restricted discovery) + PT config internally
 * See client/arti-ffi/ for the Rust FFI and StiqArtiModule.kt for the RN bridge.
 *
 * When the StiqArti native module is absent (jest/host, or a build that didn't package the Arti
 * .so), createTorBackend() falls back to UnavailableTorBackend — offline, NEVER a clearnet path
 * (honoring ALLOW_CLEARNET_FALLBACK=false). See index.ts.
 */
import {NativeEventEmitter, NativeModules, type NativeModule} from 'react-native';
import type {TorBackend} from './backend';
import type {TorBackendEvent, TorReachConfig, TorStartConfig} from './types';

/**
 * The minimal native contract ArtiTorBackend depends on. newCircuit()/getHttpTunnelPort() are
 * deliberately NOT here: those are called directly off NativeModules.StiqArti by their callers
 * (App.tsx, dormancy.ts via daemonControl.ts), not through this backend.
 */
interface StiqArtiNativeModule {
  startTor(config: TorStartConfig): Promise<void>;
  stopTor(): Promise<void>;
  installReach(config: TorReachConfig): Promise<void>;
}

// The device-event name StiqArtiModule emits. Kept as its own named const (rather than inlined)
// since TorManager subscribes to this name without needing to know which backend is live.
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
    // config.transport is forwarded VERBATIM to the native layer — the accepted strings are the
    // native contract (see transportContract.test.ts). Do not remap here. A transport Arti can't
    // service surfaces as an FFI-level error, delivered as a 'StiqTorStatus' {kind:'error'} event,
    // not a TS concern.
    return this.native.startTor(config);
  }

  stop(): Promise<void> {
    return this.native.stopTor();
  }

  installReach(config: TorReachConfig): Promise<void> {
    return this.native.installReach(config);
  }

  subscribe(listener: (event: TorBackendEvent) => void): () => void {
    const sub = this.emitter.addListener(STATUS_EVENT, (event: TorBackendEvent) =>
      listener(event),
    );
    return () => sub.remove();
  }
}
