/**
 * CTorBackend — the `ctor` flavor's embedded-Tor backend: StiqTorModule.kt driving
 * info.guardianproject:tor-android (C-tor), with pluggable transports in-process via IPtProxy.
 *
 * Resurrected from the pre-flavor NativeTorBackend (deleted in c7047c05, restored for the
 * two-engine APK pair) and rewritten against the CURRENT TorBackend contract, whose far edge
 * ArtiTorBackend defines. The deliberate deltas from that far edge:
 *
 *   - Emits only the classic five TorBackendEvent kinds (stopped/starting/bootstrapping/
 *     connected/error) — never 'verified'/'transport-dead'. TorManager treats those two as pure
 *     add-ons: 'connected' alone still settles a connect attempt; onReach() subscribers simply
 *     never fire for a C-tor session (the engine has no in-daemon reachability probe to report).
 *   - NO installReach: TorManager.installReach() returns false and callers take the restart
 *     path C-tor always required — ClientOnionAuthDir is read at Tor start only.
 *   - startTor(config) ignores TorStartConfig fields the engine has no analogue for
 *     (relayOnion — no probe; dormancy — driven post-start via daemonControl's SIGNAL
 *     DORMANT/ACTIVE instead of at construction).
 *
 * The Kotlin side owns the ClientOnionAuthDir file grammar (`<host>.auth_private`) and the
 * ClientTransportPlugin torrc lines; config.onionAuth/onionAuthExtra are consumed there.
 */
import {NativeEventEmitter, NativeModules, type NativeModule} from 'react-native';
import type {TorBackend} from './backend';
import type {TorBackendEvent, TorStartConfig} from './types';

interface StiqTorNativeModule {
  startTor(config: TorStartConfig): Promise<void>;
  stopTor(): Promise<void>;
}

// Same device-event name as the arti module emits: the name is engine-agnostic on purpose so
// TorManager subscribes without knowing which backend is live.
const STATUS_EVENT = 'StiqTorStatus';

/** The C-tor native module, or undefined when this binary is not the ctor flavor. */
export function getCtorTorModule(): StiqTorNativeModule | undefined {
  return (NativeModules as {StiqTor?: StiqTorNativeModule}).StiqTor;
}

export class CTorBackend implements TorBackend {
  private readonly emitter: NativeEventEmitter;

  constructor(private readonly native: StiqTorNativeModule) {
    this.emitter = new NativeEventEmitter(native as unknown as NativeModule);
  }

  start(config: TorStartConfig): Promise<void> {
    // config.transport is forwarded VERBATIM — the accepted strings are a native contract
    // governed by transportContract.test.ts (they must match the Kotlin when()/
    // ClientTransportPlugin arms in StiqTorModule.kt). Do not remap here.
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
