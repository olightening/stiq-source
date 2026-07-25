/**
 * Transport abstraction for the relay connection. The production socket routes through the
 * bundled Tor daemon's SOCKS proxy (see torSocket.ts); tests inject a fake. Keeping the
 * protocol layer behind this interface is what makes RelayClient testable without Tor.
 */
export interface RelaySocket {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  /** Register the open callback; invoke it immediately when the socket is already open. */
  onOpen(cb: () => void): void;
  /** Register the terminal callback; invoke it immediately when the socket already failed/closed. */
  onClose(cb: () => void): void;
  close(): void;
}
