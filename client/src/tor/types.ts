/**
 * Tor transport types shared by the manager, the native backend, and the UI.
 */

/**
 * Transports we support. `direct` is plain Tor; the rest are pluggable transports launched by
 * Arti's tor-ptmgr as external processes (arti-ffi/src/pt.rs). All three PT names below have a
 * bundled binary — `libLyrebird.so` answers obfs4, and `libSnowflake.so`/`libWebtunnel.so` are
 * their own upstream programs. See build-pt.sh and pt.rs's `binary_for()` for exactly which
 * lib*.so serves which name.
 *
 * This union is deliberately a SUBSET of pt.rs's `KNOWN_TRANSPORTS`, not a mirror of it: the native
 * layer additionally accepts `meek_lite` (lyrebird registers it inside the same libLyrebird.so, so
 * it costs no extra binary), but no TypeScript surface can currently produce that string and this
 * union deliberately does not admit it. Widening it is not a one-line change — every
 * `Record<TransportType, …>` in the app must gain an arm, including `TRANSPORT_LABEL` in
 * app/screens/ConnectionSheet.tsx, which is outside this module. Do that as an owned, deliberate
 * piece of work when a real meek_lite bridge source exists (it needs an operator-run CDN front; the
 * historical public Azure-fronted "meek-azure" default was discontinued years ago, so there is
 * nothing to ship as a default today). transportContract.test.ts pins this subset relationship in
 * both directions so the gap stays visible rather than rotting into silent drift.
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
   * Rust FFI (arti-ffi/src/onion_auth.rs::install_into_keymgr) base32-decodes the secret and installs
   * it into Arti's persistent KeyMgr keystore, keyed by the .onion address, before bootstrapping —
   * NOT the C-tor `<onionHost>.auth_private` / ClientOnionAuthDir torrc mechanism, which Arti does
   * not read at all. Absent → a public onion (no auth). See ./onionAuth.
   */
  onionAuth?: {
    /** Relay onion host WITHOUT the `.onion` suffix (the 56-char v3 base32 address). */
    onionHost: string;
    /** Community shared x25519 client-auth PRIVATE key, unpadded uppercase base32 (52 chars). */
    privKeyBase32: string;
  };
  /**
   * The active community's relay onion host (56-char v3 base32, WITHOUT the `.onion` suffix),
   * INDEPENDENT of whether that relay requires client authorization.
   *
   * This is the target for the native post-bootstrap REACHABILITY PROBE (arti-ffi/src/lib.rs's
   * `probe_reachability`), which exists because Arti reports "connected, bootstrap 100%" off a
   * CACHED consensus milliseconds after logging "No usable guards" — a usable directory is not a
   * working channel, so bootstrap percentage alone is not evidence any circuit exists. The probe
   * opens one real stream to this onion before the daemon is allowed to report `connected`.
   *
   * Why this field exists at all rather than reusing `onionAuth.onionHost`: `onionAuth` being
   * absent means "a PUBLIC onion (no client auth)", NOT "no relay" — so keying the probe off it
   * silently excluded every public community from the protection, leaving those users to hit the
   * false-connected bug and park the connect ladder on a dead rung. See ffi.rs's `relay_onion`.
   *
   * Optional and backward-compatible on both sides: Rust declares it `#[serde(rename =
   * "relayOnion", default)]`, prefers it over `onionAuth.onion_host` when both are present, falls
   * back to the auth host when only that is set, and skips the probe only when NEITHER names a host.
   */
  relayOnion?: string;
  /**
   * Additional v3 onion client-auth credentials for SECONDARY mirrors (P2 multi-relay client
   * transport, §1.7). Installed into the SAME Arti KeyMgr keystore as `onionAuth` — one entry per
   * mirror, each keyed by its own .onion address (Arti resolves whichever descriptor a connection
   * needs; see onion_auth.rs::install_into_keymgr). Absent/empty → no secondary mirrors carry their
   * own auth-gated onion, unchanged from single-mirror behaviour.
   */
  onionAuthExtra?: Array<{onionHost: string; privKeyBase32: string}>;
  /**
   * When true, the native layer applies Arti's `DormantMode::Soft` to the TorClient at construction
   * (arti-ffi/src/lib.rs finish_start) instead of leaving it `Normal`, so the daemon can idle
   * battery-friendly in the background instead of being killed — toggled live thereafter via
   * `arti_set_dormant()`. This is Arti's own dormancy primitive, not a translation of C-tor's
   * `ConnectionPadding`/`DormantClientTimeout` torrc directives, which have no Arti equivalent (see
   * arti_set_dormant's doc comment). Absent/false → the client is built non-dormant, byte-identical
   * to today.
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
  /**
   * Deferred reachability verdict — the native probe that used to BLOCK `connected` for 6-16 s on
   * every launch (arti-ffi/src/lib.rs `spawn_verify`) now runs in the background and answers with
   * exactly one of these per daemon lifecycle, always AFTER `connected`:
   *   - `verified`: one real stream reached the relay onion (or failed at the service level, which
   *     can only be learned over a working circuit) — the TRANSPORT works; record the rung warm.
   *   - `transport-dead`: bootstrap completed off a cached consensus but no circuit exists (the
   *     "bootstrap 100%, no usable guards" lie). The manager treats it like a daemon loss; the
   *     ladder marks the rung dead for the session and walks on from the next one.
   */
  | { kind: 'verified' }
  | { kind: 'transport-dead'; message: string }
  | { kind: 'error'; message: string };

/**
 * The reach-credential subset of TorStartConfig, installed into a LIVE daemon after an early start
 * (a startTor made before the app runtime hydrated the active community — bootstrap needs no
 * credential; Arti reads its keystore at descriptor-fetch time, so no restart is needed). Same
 * field shapes as TorStartConfig so the native marshaling is shared.
 */
export interface TorReachConfig {
  onionAuth?: TorStartConfig['onionAuth'];
  onionAuthExtra?: TorStartConfig['onionAuthExtra'];
  relayOnion?: string;
}

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
