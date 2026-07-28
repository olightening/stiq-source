//! FFI boundary types for the STIQ Arti backend.
//!
//! This module defines the wire contract between StiqArtiModule.kt and the Rust daemon:
//!   * `TorStartConfigJson` — the ONE JSON string the Kotlin side marshals from the RN
//!     ReadableMap. It mirrors `TorStartConfig` (client/src/tor/types.ts) field-for-field so the
//!     TS layer needs zero changes.
//!   * `ArtiBootstrap` — the bootstrap/status callback the Kotlin side implements. Its `on_event`
//!     kinds are deliberately the `TorBackendEvent` kinds (client/src/tor/types.ts):
//!     `starting | bootstrapping | connected | verified | transport-dead | error | stopped`.
//!     StiqArtiModule routes each call straight to its emit* helper, which builds the identical
//!     `WritableNativeMap` StiqTorModule built — so `RCTDeviceEventEmitter.emit("StiqTorStatus", …)`
//!     deserializes into `TorBackendEvent` unchanged.
//!
//! The exported C ABI (declared in lib.rs) is:
//!   fn arti_start(config_json) -> i32   // bound SOCKS port > 0, or a negative errno-style code
//!   fn arti_http_port() -> i32          // HTTP CONNECT proxy port, or -1 if unsupported (WebView gap)
//!   fn arti_stop()
//!   fn arti_new_identity()
//! plus registration of an `ArtiBootstrap` callback (uniffi trait object, or a C function pointer).

use serde::Deserialize;

/// v3 onion client-auth (restricted discovery) credential, mirroring TorStartConfig.onionAuth.
/// The Rust side base32-decodes `priv_key_base32` into the x25519 secret (see onion_auth.rs) — it
/// does NOT consume C-tor's `<host>.auth_private` file line; that format is dead for Arti.
#[derive(Debug, Clone, Deserialize)]
pub struct OnionAuthJson {
    /// Relay onion host WITHOUT the `.onion` suffix (56-char v3 base32). Matches onionAuth.onionHost.
    #[serde(rename = "onionHost")]
    pub onion_host: String,
    /// Community shared x25519 client-auth PRIVATE key, unpadded uppercase base32 (52 chars).
    #[serde(rename = "privKeyBase32")]
    pub priv_key_base32: String,
}

/// The full start config, deserialized from the single JSON string StiqArtiModule passes to
/// arti_start(). Field names use serde rename to match the TS camelCase wire shape EXACTLY.
///
/// Shape (from client/src/tor/types.ts TorStartConfig):
///   {"transport":"direct|webtunnel|obfs4|snowflake",
///    "bridgeLines":["…"],
///    "socksPort":0,
///    "dataDir":"/abs/path",
///    "onionAuth":{"onionHost":"…","privKeyBase32":"…"}|null,
///    "relayOnion":"…"|null,
///    "onionAuthExtra":[{"onionHost":"…","privKeyBase32":"…"}],
///    "dormancy":false}
#[derive(Debug, Clone, Deserialize)]
pub struct TorStartConfigJson {
    /// direct | webtunnel | obfs4 | snowflake. The spike implements ONLY `direct` (S1 step 5);
    /// the PT arms fire on_event("error","pt-unsupported-in-spike") until S5 wires tor-ptmgr.
    pub transport: String,
    /// torrc-style Bridge lines for the chosen PT. Empty for `direct`. Parsed by pt.rs (S5).
    #[serde(rename = "bridgeLines", default)]
    pub bridge_lines: Vec<String>,
    /// Requested local SOCKS port; 0 → let Arti/OS pick a free one (the daemon returns the real one).
    #[serde(rename = "socksPort", default)]
    pub socks_port: u16,
    /// App-private dir for Arti's state/cache (guards, consensus). Resolved by Kotlin to
    /// getDir("ArtiState", MODE_PRIVATE). Arti REGENERATES this on first boot (see KEY_MIGRATION).
    #[serde(rename = "dataDir", default)]
    pub data_dir: Option<String>,
    /// Primary community reach credential (lever 2). Absent → a public onion (no auth).
    #[serde(rename = "onionAuth", default)]
    pub onion_auth: Option<OnionAuthJson>,
    /// The primary community relay's onion host (56-char v3 base32, WITHOUT the `.onion` suffix),
    /// independent of whether that relay needs client authorization.
    ///
    /// `onion_auth` being absent does NOT mean "no relay" — its own doc above says so — so it
    /// cannot be used to infer a probe target for a PUBLIC community. This field exists so
    /// `lib.rs`'s post-bootstrap reachability probe (see `probe_reachability` and the "BOOTSTRAP
    /// REACHING 100% DOES NOT MEAN THE TRANSPORT WORKS" comment on it) has a host for a public
    /// community too, not only an auth-gated one.
    ///
    /// `#[serde(default)]` so a caller built before this field existed still parses (it just gets
    /// `None`). When both this and `onion_auth` are present, this field wins; `start_async` falls
    /// back to `onion_auth.onion_host` when only that is set, and skips the probe only when
    /// NEITHER names a host.
    #[serde(rename = "relayOnion", default)]
    pub relay_onion: Option<String>,
    /// Secondary-mirror reach credentials (P2 §1.7). Each installed into the SAME KeyMgr as
    /// `onion_auth`, keyed by its own .onion address.
    #[serde(rename = "onionAuthExtra", default)]
    pub onion_auth_extra: Vec<OnionAuthJson>,
    /// Battery-friendly idle mode hint. Arti has no torrc `DormantClientTimeout`; the analog is
    /// `DormantMode::Soft`, which `arti_set_dormant` also toggles at runtime.
    #[serde(default)]
    pub dormancy: bool,
    /// `applicationInfo.nativeLibraryDir`, injected by StiqArtiModule — NOT part of the TS
    /// `TorStartConfig`, and deliberately so: it is a native packaging detail that the JS layer has
    /// no business knowing. Required only for a pluggable transport, because it is the one
    /// directory on Android from which a PT binary can be executed (see pt.rs).
    #[serde(rename = "nativeLibDir", default)]
    pub native_lib_dir: Option<String>,
}

/// The bootstrap/status sink StiqArtiModule implements. `kind` is a `TorBackendEvent` kind.
///
/// Emission ORDER contract (mirrors StiqTorModule.startControlSocketMonitor):
///   1. `starting`  once, at arti_start entry (Kotlin already emits this before calling in).
///   2. `bootstrapping` repeatedly with 0<percent<100 as Arti's bootstrap status stream advances.
///   3. `connected` EXACTLY once, ONLY after the SOCKS listener is actually accepting — never
///      before (an early `connected` makes the relay WebSocket dial a not-yet-built circuit and
///      hit the 120 s timeout; this is the same trap StiqTorModule avoids by firing at PROGRESS=100).
///   4. AFTER `connected`, exactly one of `verified` | `transport-dead` per lifecycle once a relay
///      host is known (from the start config, or later via arti_install_auth): the deferred
///      reachability verdict. `verified` → the transport demonstrably carries a stream (record the
///      rung warm); `transport-dead` → bootstrap lied off a cached consensus and no circuit exists
///      (condemn the rung, stop, walk on). Neither ever precedes `connected`.
///   5. `error` on any failure (bootstrap timeout, auth-gated descriptor not found, PT unsupported).
///   6. `stopped` from arti_stop after the client + SOCKS task are dropped.
///
/// Unused fields per kind are passed as 0 / "" (e.g. `percent` is ignored for `connected`).
pub trait ArtiBootstrap: Send + Sync {
    fn on_event(&self, kind: String, percent: i32, summary: String, socks_port: i32, message: String);
}

/// Parse the JSON config string handed across the FFI. A parse failure is a caller/marshaling bug;
/// arti_start surfaces it as on_event("error", …) and returns a negative code rather than panicking
/// across the FFI boundary.
pub fn parse_config(config_json: &str) -> Result<TorStartConfigJson, serde_json::Error> {
    serde_json::from_str(config_json)
}

/// The `arti_install_auth` request — the reach-credential subset of `TorStartConfigJson`, installed
/// into the LIVE client after an early start (one made before the app's runtime had hydrated the
/// active community). Same wire field names as the start config so the Kotlin marshaling is the
/// same `authToJson` helper in both paths.
#[derive(Debug, Clone, Deserialize)]
pub struct InstallReachJson {
    /// Primary community reach credential. Absent → a public onion (nothing to install; the call
    /// may still carry `relayOnion` so the deferred reachability verification has a target).
    #[serde(rename = "onionAuth", default)]
    pub onion_auth: Option<OnionAuthJson>,
    /// Secondary-mirror reach credentials (P2 §1.7), same semantics as the start config's field.
    #[serde(rename = "onionAuthExtra", default)]
    pub onion_auth_extra: Vec<OnionAuthJson>,
    /// The verification target, independent of auth — see TorStartConfigJson.relay_onion.
    #[serde(rename = "relayOnion", default)]
    pub relay_onion: Option<String>,
}

/// Parse the `arti_install_auth` JSON. Kept beside `parse_config` so the FFI boundary's parsers
/// live in one place.
pub fn parse_install_reach(json: &str) -> Result<InstallReachJson, serde_json::Error> {
    serde_json::from_str(json)
}
