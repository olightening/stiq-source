//! STIQ T17 Arti spike — arti-mobile cdylib entry point.   ⚠ SCAFFOLD — NOT COMPILED HERE.
//!
//! =====================================================================================
//! BUILD STATUS: this crate has NOT been built. The spike host has no Rust cross-compile
//! toolchain and no Android NDK, so `cargo ndk` (build.sh) and the on-device eval (T17-S4/S5)
//! could not run. Every arti-client / tor-hsclient API name below is PROVISIONAL and marked
//! `TODO(arti-api)` where it must be verified against the resolved Cargo.lock. The FFI SHAPE
//! (function signatures, JSON contract, event kinds) is the real, load-bearing deliverable —
//! it is what StiqArtiModule.kt (T17-S2) and ArtiTorBackend.ts (T17-S3, DONE + jest-green) bind
//! to, and it must not drift.
//! =====================================================================================
//!
//! Lifecycle model (T17-S1 steps 2–4):
//!   * ONE tokio runtime for the whole process (Arti is tokio-native; there is no IPtProxy
//!     Controller-per-process restriction, so this is simpler than the C-tor path).
//!   * ONE global `Mutex<Option<Handle>>` holding the live TorClient + SOCKS task, to mirror the
//!     single-daemon lifecycle the app expects (start → connected → stop).
//!   * Bootstrap progress is bridged from Arti's status stream to on_event("bootstrapping", …).
//!   * `connected` fires ONLY after the local SOCKS listener is bound and accepting.

mod ffi;
mod onion_auth; // T17-S4: restricted-discovery client-auth key install
mod pt; // T17-S5: pluggable-transport wiring (obfs4/webtunnel/snowflake) — spike returns not-impl

use ffi::{parse_config, ArtiBootstrap, TorStartConfigJson};
use std::sync::{Mutex, OnceLock};

/// errno-style negative return codes for arti_start (the Kotlin side rejects the Promise on any).
pub mod codes {
    pub const ERR_BAD_CONFIG: i32 = -1; // JSON did not parse / missing required field
    pub const ERR_PT_UNSUPPORTED: i32 = -2; // non-'direct' transport requested in the spike (S5 gap)
    pub const ERR_BOOTSTRAP: i32 = -3; // TorClient failed to bootstrap
    pub const ERR_ONION_AUTH: i32 = -4; // restricted-discovery key could not be installed (S4)
    pub const ERR_SOCKS_BIND: i32 = -5; // could not bind/accept the local SOCKS listener
    pub const ERR_ALREADY_RUNNING: i32 = -6; // a client is already live; stop first
}

/// Everything the running daemon owns; dropped by arti_stop.
struct Handle {
    // TODO(arti-api): TorClient<TokioNativeTlsRuntime> (or the rustls runtime alias). Held so
    // arti_stop can drop it (Arti has no explicit shutdown call — dropping the client tears down
    // circuits and the background reactor).
    // client: arti_client::TorClient<...>,
    /// The bound SOCKS port we reported on `connected`.
    socks_port: u16,
    /// The HTTP CONNECT proxy port, or -1 when Arti exposes none (WebView-proxy gap — see decision doc).
    http_port: i32,
    /// Handle to the spawned SOCKS-listener task, aborted on stop.
    // socks_task: tokio::task::JoinHandle<()>,
    _priv: (),
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("arti-mobile")
            .build()
            .expect("arti-mobile: tokio runtime")
    })
}

fn handle_slot() -> &'static Mutex<Option<Handle>> {
    static SLOT: OnceLock<Mutex<Option<Handle>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Callback sink registered by StiqArtiModule before arti_start. `Box<dyn ArtiBootstrap>` under a
/// uniffi trait object, or a C function pointer in the plain-extern path (see README FFI section).
fn callback_slot() -> &'static Mutex<Option<Box<dyn ArtiBootstrap>>> {
    static CB: OnceLock<Mutex<Option<Box<dyn ArtiBootstrap>>>> = OnceLock::new();
    CB.get_or_init(|| Mutex::new(None))
}

fn emit(kind: &str, percent: i32, summary: &str, socks_port: i32, message: &str) {
    if let Some(cb) = callback_slot().lock().unwrap().as_ref() {
        cb.on_event(
            kind.to_string(),
            percent,
            summary.to_string(),
            socks_port,
            message.to_string(),
        );
    }
}

/// Register the bootstrap callback. Called once by StiqArtiModule during module init.
/// (uniffi generates the boxing; the plain-extern variant stores a raw fn ptr + ctx instead.)
pub fn arti_set_callback(cb: Box<dyn ArtiBootstrap>) {
    *callback_slot().lock().unwrap() = Some(cb);
}

/// Start the embedded Arti daemon. Returns the bound SOCKS port (>0) on success, or a negative
/// `codes::*` value on failure (also emitting on_event("error", …)). See ffi.rs for the JSON shape.
pub fn arti_start(config_json: String) -> i32 {
    let cfg: TorStartConfigJson = match parse_config(&config_json) {
        Ok(c) => c,
        Err(e) => {
            emit("error", 0, "", 0, &format!("bad config json: {e}"));
            return codes::ERR_BAD_CONFIG;
        }
    };

    // Refuse a concurrent start — a client is already live. (Kotlin stops before re-starting, so
    // this is defense-in-depth, not the primary guard.)
    if handle_slot().lock().unwrap().is_some() {
        emit("error", 0, "", 0, "arti already running; stop first");
        return codes::ERR_ALREADY_RUNNING;
    }

    // SPIKE SCOPE (S1 step 5): direct transport ONLY. PT arms are wired in S5; until then any
    // non-direct transport fails fast with the sentinel message the decision doc's PT matrix cites.
    if cfg.transport != "direct" {
        if let Err(msg) = pt::not_supported_in_spike(&cfg.transport) {
            emit("error", 0, "", 0, &msg);
            return codes::ERR_PT_UNSUPPORTED;
        }
    }

    runtime().block_on(async move { start_async(cfg).await })
}

async fn start_async(cfg: TorStartConfigJson) -> i32 {
    emit("bootstrapping", 1, "Configuring Arti", 0, "");

    // ── 1. Build TorClientConfig ────────────────────────────────────────────────────────────────
    // TODO(arti-api): TorClientConfigBuilder — set state_dir + cache_dir to cfg.data_dir. Arti keeps
    // its guard/consensus state here and REGENERATES it on first boot (no C-tor migration needed —
    // see KEY_MIGRATION in the decision doc). Example intended shape:
    //   let mut b = TorClientConfig::builder();
    //   if let Some(dir) = &cfg.data_dir {
    //       b.storage().state_dir(CfgPath::new(dir.into()));
    //       b.storage().cache_dir(CfgPath::new(format!("{dir}/cache").into()));
    //   }
    //   let config = b.build().map_err(…)?;
    let _ = &cfg.data_dir;

    // ── 2. Install restricted-discovery client-auth (lever 2) BEFORE bootstrap ────────────────────
    // For EACH of onion_auth + onion_auth_extra, decode the x25519 secret and register it with the
    // client's onion-service-client authorization store (KeyMgr), keyed by the .onion address, so
    // Arti can decrypt the members-only descriptor. Fail CLOSED: an install error must abort the
    // start (an unauthorized client must NOT connect — preserving npub-blind reach).
    let mut auth_entries = Vec::new();
    if let Some(a) = &cfg.onion_auth {
        auth_entries.push(a);
    }
    for a in &cfg.onion_auth_extra {
        auth_entries.push(a);
    }
    for a in &auth_entries {
        if let Err(msg) = onion_auth::validate_entry(&a.onion_host, &a.priv_key_base32) {
            emit("error", 0, "", 0, &format!("onion-auth: {msg}"));
            return codes::ERR_ONION_AUTH;
        }
        // TODO(arti-api): onion_auth::install_into_keymgr(&client_keymgr, host, secret) — see
        // onion_auth.rs and RESTRICTED_DISCOVERY.md for the exact KeyMgr/HsClientDescEncKey types.
    }

    // ── 3. Bootstrap ─────────────────────────────────────────────────────────────────────────────
    // TODO(arti-api): TorClient::with_runtime(rt).config(config).create_bootstrapped().await, OR
    // create_unbootstrapped() + subscribe to bootstrap_events() and drive emit("bootstrapping", …)
    // from each BootstrapStatus (frac 0.0–1.0 → percent 0–100, its blocked/subphase → summary).
    // Mirror StiqTorModule: emit percents as they arrive, do NOT emit `connected` here.
    emit("bootstrapping", 50, "Bootstrapping", 0, "");

    // ── 4. Bind the local SOCKS listener and START accepting BEFORE `connected` ────────────────────
    // TODO(arti-api): spawn arti's SOCKS proxy (the `arti-client` book's proxy example, or the
    // `snowflake`/`arti-socks` helper) on 127.0.0.1:cfg.socks_port (0 = OS-assigned). Capture the
    // actually-bound port. Only once accept() is live do we report connected.
    let socks_port: u16 = if cfg.socks_port != 0 { cfg.socks_port } else { 0 };
    if socks_port == 0 {
        // In the real impl this is the OS-assigned port read back from the bound listener; a 0 here
        // would be a bind failure.
        emit("error", 0, "", 0, "SOCKS listener did not bind");
        return codes::ERR_SOCKS_BIND;
    }

    // HTTP CONNECT proxy: Arti (as of the pinned version) exposes SOCKS but NOT an HTTP-CONNECT
    // tunnel like C-tor's HTTPTunnelPort. Report -1 so getHttpTunnelPort() surfaces the WebView-proxy
    // GAP to the decision doc rather than handing the WebView a bad port. TODO(arti-api): re-check
    // whether a later Arti adds an HTTP-CONNECT front, or bridge SOCKS→HTTP in-crate.
    let http_port: i32 = -1;

    *handle_slot().lock().unwrap() = Some(Handle {
        socks_port,
        http_port,
        _priv: (),
    });

    // ── 5. connected — SOCKS is accepting ──────────────────────────────────────────────────────────
    emit("connected", 100, "Connected", socks_port as i32, "");
    socks_port as i32
}

/// The HTTP CONNECT proxy port for the opt-in full-page WebView, or -1 when unsupported. The WebView
/// path (StiqWebProxy) must treat -1 as "no full-page proxy; reader-mode only" — see decision doc.
pub fn arti_http_port() -> i32 {
    handle_slot()
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.http_port)
        .unwrap_or(-1)
}

/// Stop the daemon: drop the TorClient + abort the SOCKS task, then emit `stopped`.
pub fn arti_stop() {
    let taken = handle_slot().lock().unwrap().take();
    if let Some(_h) = taken {
        // TODO(arti-api): _h.socks_task.abort(); dropping _h.client tears down circuits + reactor.
    }
    emit("stopped", 0, "", 0, "");
}

/// Rotate identity. Arti has NO single global NEWNYM: the analog is per-connection stream isolation
/// (each SOCKS stream can carry its own isolation token) plus retiring existing circuits so the next
/// streams build fresh. For the spike this is best-effort; if no true global-NEWNYM equivalent
/// exists it is a documented GAP (App.tsx requestNewTorCircuit → StiqTor.newCircuit is NOT rewired
/// for Arti in this spike — see decision doc §newCircuit).
pub fn arti_new_identity() {
    // TODO(arti-api): client.retire_all_circuits() (or isolated-client clone per stream). Document
    // the exact primitive + whether it matches C-tor NEWNYM semantics in the decision doc.
}

// ── C ABI exports ────────────────────────────────────────────────────────────────────────────────
// If using uniffi, delete this block and annotate the functions above with #[uniffi::export]
// instead (uniffi generates the JNI + the Kotlin ArtiBootstrap callback interface). This plain
// extern "C" surface is the fallback the README documents; it omits the callback registration,
// which under plain-extern takes a `extern "C" fn(*const c_char, i32, …)` + context pointer.

/// Initialize android logging so arti_* errors reach logcat during the on-device eval.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn arti_init_logging() {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("StiqArti"),
    );
}
