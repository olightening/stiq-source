/**
 * NativeTorBackend bridges the TS manager to the native Tor daemon.
 *
 * The native module (iOS: Tor.framework; Android: tor-android) must:
 *   - expose async `startTor(config)` / `stopTor()`
 *   - emit `StiqTorStatus` events shaped like TorBackendEvent as Tor bootstraps
 *   - own the `ClientTransportPlugin` torrc line for the bundled obfs4/snowflake binary
 * See client/native/ for the scaffolding the platform teams complete.
 */
import {NativeEventEmitter, NativeModules, type NativeModule} from 'react-native';
import type {TorBackend} from './backend';
import type {TorBackendEvent, TorStartConfig} from './types';

interface StiqTorNativeModule {
  startTor(config: TorStartConfig): Promise<void>;
  stopTor(): Promise<void>;
  // Optional (added by T2-S2): coarse transport class of the current default network. Implemented
  // on BOTH platforms (Android: ConnectivityManager, StiqTorModule.kt; iOS: one-shot NWPathMonitor,
  // StiqTor.swift). Absent only on older binaries/jest → getNetworkClass() below returns 'unknown'.
  getNetworkClass?(): Promise<string>;
}

const STATUS_EVENT = 'StiqTorStatus';

/**
 * Coarse transport class of the device's default network. Mirrors the native
 * StiqTorModule.getNetworkClass() (and the StiqTorNetworkChange payload). Used to key the
 * per-network-class bridge cache. 'unknown' means the device could not classify (no native
 * module in jest, no active network, or a value the native layer didn't recognize).
 */
export type NetworkClass =
  | 'wifi'
  | 'cellular'
  | 'ethernet'
  | 'vpn'
  | 'other'
  | 'unknown';

/** The native module, or undefined when it has not been built into this binary. */
export function getNativeTorModule(): StiqTorNativeModule | undefined {
  return (NativeModules as {StiqTor?: StiqTorNativeModule}).StiqTor;
}

/**
 * Resolve the current network class from the native module, normalizing any unexpected/absent
 * value to 'unknown'. Never rejects — a classification failure must never break Tor connect logic.
 */
export async function getNetworkClass(): Promise<NetworkClass> {
  const m = getNativeTorModule();
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

export class NativeTorBackend implements TorBackend {
  private readonly emitter: NativeEventEmitter;

  constructor(private readonly native: StiqTorNativeModule) {
    this.emitter = new NativeEventEmitter(native as unknown as NativeModule);
  }

  start(config: TorStartConfig): Promise<void> {
    // config.transport is forwarded VERBATIM to the native layer; the accepted strings are a
    // native contract governed by client/src/tor/transportContract.test.ts (they must match the
    // Kotlin when()/ClientTransportPlugin arms in StiqTorModule.kt). Do not remap here.
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
