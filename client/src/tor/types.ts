/**
 * Tor transport types shared by the manager, the native backend, and the UI.
 */

/**
 * Transports we support. `direct` is plain Tor; the rest are pluggable transports
 * implemented by the bundled IPtProxy 5.5.0 binary.
 * - direct: no pluggable transport, no bridges — a normal Tor circuit to public guard
 *   relays over clearnet. By far the most reliable and fastest path on an open (uncensored)
 *   network, where flaky bridges only get in the way. Tried FIRST; falls back to bridges
 *   when direct Tor is blocked.
 * - webtunnel: WebSocket-over-HTTPS to a real website on :443. Indistinguishable from
 *   ordinary HTTPS browsing — the strongest "hide that it's Tor" option, with obfs4-class
 *   speed.
 * - obfs4: fully-encrypted random bytes. Fast, but the high-entropy stream is itself a
 *   fingerprint that modern DPI flags; kept as a fallback.
 * - snowflake: WebRTC. Hard to block but high-latency/flaky; last-resort fallback.
 */
export type TransportType = 'direct' | 'webtunnel' | 'obfs4' | 'snowflake';

/** A local SOCKS5 proxy exposed by the bundled Tor daemon. */
export interface SocksProxy {
  host: string;
  port: number;
}

/** Everything the native Tor daemon needs to start a bridged circuit. */
export interface TorStartConfig {
  transport: TransportType;
  /** torrc `Bridge` lines for the chosen transport. */
  bridgeLines: string[];
  /** Requested local SOCKS port; 0 lets Tor pick a free one. */
  socksPort: number;
  /** App-private directory for Tor's state. */
  dataDir?: string;
  /**
   * v3 onion client authorization to REACH a members-only relay onion (lever 2). When present, the
   * native module writes `<onionHost>.auth_private` into a ClientOnionAuthDir and adds the torrc
   * line before boot, so Tor can resolve the auth-gated descriptor. Absent → a public onion (no
   * auth). See ./onionAuth.
   */
  onionAuth?: {
    /** Relay onion host WITHOUT the `.onion` suffix (the 56-char v3 base32 address). */
    onionHost: string;
    /** Community shared x25519 client-auth PRIVATE key, unpadded uppercase base32 (52 chars). */
    privKeyBase32: string;
  };
  /**
   * Additional v3 onion client-auth credentials for SECONDARY mirrors (P2 multi-relay client
   * transport, §1.7). The native module writes one `<onionHost>.auth_private` file per entry into
   * the SAME `ClientOnionAuthDir` as `onionAuth` (one dir holds every credential; Tor resolves
   * whichever descriptor a connection needs). Absent/empty → no secondary mirrors carry their own
   * auth-gated onion, unchanged from single-mirror behaviour.
   */
  onionAuthExtra?: Array<{onionHost: string; privKeyBase32: string}>;
  /**
   * When true the native torrc uses the battery-friendly mobile padding block
   * (ConnectionPadding auto / ReducedConnectionPadding 1) + DormantClientTimeout so the daemon
   * can idle dormant in background instead of being killed. Absent/false → the existing
   * active-session liveness block, byte-identical.
   */
  dormancy?: boolean;
}

/**
 * Status events emitted by the native backend as Tor boots and connects.
 * `connected` carries the SOCKS proxy the app must route ALL traffic through.
 *
 * The `connected` variant is the shared extension point for metadata the native daemon can
 * report about the live circuit. It already carries `torVersion` (below); a later subtask
 * (T2-S2) will add an optional `networkClass` field to this SAME variant — keep new circuit
 * metadata OPTIONAL and hang it here so the wire shape stays backward-compatible.
 */
export type TorBackendEvent =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'bootstrapping'; percent: number; summary?: string }
  /**
   * `torVersion`: version string from the daemon's GETINFO version (e.g. "0.4.8.22"). Used ONLY
   * for a warn-only `>=0.4.8` guard (so onion-service PoW is solved transparently); never to gate
   * or block connect. Optional — a backend that can't read it omits the field.
   */
  | { kind: 'connected'; socks: SocksProxy; torVersion?: string }
  | { kind: 'error'; message: string };

/**
 * Live bootstrap progress, surfaced to the UI so a connecting screen can show the REAL Tor
 * percentage + the daemon's own one-line summary (e.g. "Loading relay descriptors") instead of a
 * faked timer. Parsed by the native module from Tor's control-port PROGRESS=/SUMMARY= lines.
 */
export interface BootstrapProgress {
  /** 0–100, straight from Tor's bootstrap reporter. */
  percent: number;
  /** Tor's own human summary for the current phase, when it provided one. */
  summary?: string;
}
