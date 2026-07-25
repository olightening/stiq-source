/**
 * In-memory fake socket for tests. NEVER touches the network.
 */
import type {RelaySocket} from './socket';
import type {Event} from 'nostr-tools/pure';

export class FakeRelaySocket implements RelaySocket {
  sent: string[] = [];
  closed = false;
  private msgCb?: (data: string) => void;
  private openCb?: () => void;
  private closeCb?: () => void;
  private isOpen = false;

  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
    if (this.isOpen) {
      cb();
    }
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
    if (this.closed) {
      cb();
    }
  }
  close(): void {
    this.closed = true;
    this.isOpen = false;
    this.closeCb?.();
  }

  // --- test drivers ---
  simulateOpen(): void {
    this.isOpen = true;
    this.openCb?.();
  }
  emit(raw: string): void {
    this.msgCb?.(raw);
  }
  emitEvent(subId: string, event: Event): void {
    this.emit(JSON.stringify(['EVENT', subId, event]));
  }
  emitEose(subId: string): void {
    this.emit(JSON.stringify(['EOSE', subId]));
  }
}
