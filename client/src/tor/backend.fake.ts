/**
 * Test/dev backends. These NEVER touch the network — they only drive the state machine.
 * Used by unit tests and by the app when the native Tor module is absent.
 */
import type {TorBackend} from './backend';
import type {TorBackendEvent, TorStartConfig} from './types';

/** Emits a scripted sequence of events on start. Good for exercising the manager. */
export class ScriptedTorBackend implements TorBackend {
  private listeners = new Set<(e: TorBackendEvent) => void>();
  lastConfig?: TorStartConfig;

  constructor(private readonly script: TorBackendEvent[]) {}

  async start(config: TorStartConfig): Promise<void> {
    this.lastConfig = config;
    for (const event of this.script) {
      this.emit(event);
    }
  }

  async stop(): Promise<void> {
    this.emit({kind: 'stopped'});
  }

  subscribe(listener: (e: TorBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: TorBackendEvent): void {
    for (const l of this.listeners) {
      l(event);
    }
  }
}

/**
 * Backend used when no native Tor module is installed (e.g. before the native build, or
 * on an unsupported platform). It reports an error so the app shows offline — and, by
 * design, NEVER a clearnet fallback.
 */
export class UnavailableTorBackend implements TorBackend {
  private listeners = new Set<(e: TorBackendEvent) => void>();

  async start(): Promise<void> {
    this.emit({kind: 'error', message: 'Tor native module not installed'});
  }

  async stop(): Promise<void> {
    this.emit({kind: 'stopped'});
  }

  subscribe(listener: (e: TorBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TorBackendEvent): void {
    for (const l of this.listeners) {
      l(event);
    }
  }
}
